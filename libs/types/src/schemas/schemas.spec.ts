/**
 * Contract test: every JSON Schema under /schemas compiles in strict mode and validates its example.
 * Negative cases pin the rules implementations rely on (no empty pins, digest encodings, fail-closed).
 *
 * Runs under vitest (`pnpm nx test @confidential-router/types`). Schemas and examples are read from the
 * repository root so the docs, the Go gatekeeper (go:embed of the same files) and this test cannot drift.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCaseBody, loadConformanceManifest } from '@confidential-router/attestation-fixtures';
import Ajv2020Module, { type ValidateFunction } from 'ajv/dist/2020.js';
import ajvFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

// ajv and ajv-formats are CommonJS; under `nodenext` the default import is `module.exports`, and the
// constructor / plugin live on `.default`.
const Ajv2020 = Ajv2020Module.default;
const addFormats = ajvFormats.default;

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = join(here, '..', '..', '..', '..', 'schemas');
const EXAMPLES_DIR = join(SCHEMAS_DIR, 'examples');

const CASES = [
  { schema: 'gatekeeper-config.schema.json', example: 'gatekeeper-config.example.yaml' },
  { schema: 'rego-input.schema.json', example: 'rego-input.example.json' },
  { schema: 'swarm-evidence-bundle.schema.json', example: 'swarm-evidence-bundle.example.json' },
  { schema: 'router-config.schema.json', example: 'router-config.example.yaml' },
] as const;

function loadDoc(file: string): unknown {
  const raw = readFileSync(join(EXAMPLES_DIR, file), 'utf8');
  // `${ENV}` placeholders are expanded by the config loaders before validation; mimic with a fixed value.
  const expanded = raw.replace(/\$\{[A-Z0-9_]+\}/g, 'x'.repeat(40));
  return file.endsWith('.json') ? JSON.parse(expanded) : parseYaml(expanded);
}

function compile(schemaFile: string): ValidateFunction {
  const ajv = new Ajv2020({ strict: true, allErrors: true, useDefaults: false });
  addFormats(ajv);
  const schema = JSON.parse(readFileSync(join(SCHEMAS_DIR, schemaFile), 'utf8'));
  return ajv.compile(schema);
}

function errorsOf(validate: ValidateFunction): string {
  return (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`).join('; ');
}

describe('schemas', () => {
  for (const { schema, example } of CASES) {
    describe(schema, () => {
      const validate = compile(schema);

      it('compiles in strict mode', () => {
        expect(validate).toBeTypeOf('function');
      });

      it(`validates ${example}`, () => {
        const doc = loadDoc(example);
        expect(validate(doc), errorsOf(validate)).toBe(true);
      });
    });
  }
});

describe('gatekeeper-config rules', () => {
  const validate = compile('gatekeeper-config.schema.json');
  const base = () => structuredClone(loadDoc('gatekeeper-config.example.yaml')) as Record<string, any>;

  it('rejects an endpoint without pinned evidence (no trust-on-first-use)', () => {
    const cfg = base();
    cfg.endpoints[0].trustedEvidence = [];
    expect(validate(cfg)).toBe(false);
    expect(errorsOf(validate)).toContain('/endpoints/0/trustedEvidence');
  });

  it('accepts canonical, sha256/hex, sha256:hex and bare-hex digest encodings', () => {
    const cfg = base();
    cfg.endpoints[0].trustedEvidence = [
      'sha256/axNB3kHhDGtF3v2P8lY6pWbBqzX0cR9kT1uJm4sN7dE',
      `sha256/${'a'.repeat(64)}`,
      `sha256:${'a'.repeat(64)}`,
      'b'.repeat(64),
    ];
    expect(validate(cfg), errorsOf(validate)).toBe(true);
  });

  it('rejects malformed digests', () => {
    const bads = [
      'sha256/short',
      'md5/abc',
      'a'.repeat(63),
      `sha256/${'a'.repeat(43)}=`,
      // A final character with non-zero trailing bits is a second spelling of the same 32 bytes;
      // pins are exact string matches, so it would be a pin that never fires.
      `sha256/${'a'.repeat(42)}B`,
      // Hex needs no scheme to be unambiguous; a bare base64url token does.
      'weMdyCn3VNUosV0Mxf6P1D8iWGXVyTZ_d-5vEW4Q9qs',
    ];
    for (const bad of bads) {
      const cfg = base();
      cfg.endpoints[0].trustedEvidence = [bad];
      expect(validate(cfg), bad).toBe(false);
    }
  });

  it('only allows failMode closed|open', () => {
    const cfg = base();
    cfg.endpoints[0].failMode = 'ignore';
    expect(validate(cfg)).toBe(false);
  });

  it('requires https upstreams', () => {
    const cfg = base();
    cfg.endpoints[0].upstream = 'http://llama-33-70b.tee.swarm.cloud';
    expect(validate(cfg)).toBe(false);
  });

  it('allows an empty trusted-root list, because attestedRoots is the other anchor', () => {
    const cfg = base();
    cfg.trustedRoots = [];
    expect(validate(cfg), errorsOf(validate)).toBe(true);
  });

  it('requires exactly one of pem|pemFile on a trusted root', () => {
    const cfg = base();
    cfg.trustedRoots = [{ name: 'both', pem: base().trustedRoots[0].pem, pemFile: './x.pem' }];
    expect(validate(cfg)).toBe(false);
  });

  it('constrains attestedRoots to the knobs it defines', () => {
    const cfg = base();
    cfg.attestedRoots = { enabled: true, requireNetworkType: 'trusted', cacheTtl: '10m', checkRevocations: true };
    expect(validate(cfg), errorsOf(validate)).toBe(true);

    for (const bad of [
      { requireNetworkType: 'sometimes' },
      { registryBaseUrl: 'mirror.local/signatures' },
      { cacheTtl: '10 minutes' },
      { unknownKnob: true },
    ]) {
      const broken = base();
      broken.attestedRoots = bad;
      expect(validate(broken), JSON.stringify(bad)).toBe(false);
    }
  });

  it('keeps the admin API local: unix sockets and loopback only', () => {
    for (const listen of ['unix:/run/user/1000/gatekeeper.sock', '127.0.0.1:9465', 'localhost:9465', '[::1]:9465']) {
      const cfg = base();
      cfg.admin = { listen };
      expect(validate(cfg), listen).toBe(true);
    }
    // The admin API answers with verdicts, digests and hostnames. Binding it to
    // a routable address would publish the user's trust decisions to the network.
    for (const listen of ['0.0.0.0:9465', '10.0.0.4:9465', 'gatekeeper.internal:9465', ':9465']) {
      const cfg = base();
      cfg.admin = { listen };
      expect(validate(cfg), listen).toBe(false);
    }
  });

  it('requires a file when an audit log is configured', () => {
    const cfg = base();
    cfg.audit = {};
    expect(validate(cfg)).toBe(false);
    const cfg2 = base();
    cfg2.audit = { file: './audit.jsonl' };
    expect(validate(cfg2), errorsOf(validate)).toBe(true);
  });

  it('rejects unknown keys (typos never silently pass)', () => {
    const cfg = base();
    cfg.endpoints[0].trustedEvidenceDigests = cfg.endpoints[0].trustedEvidence;
    expect(validate(cfg)).toBe(false);
  });
});

describe('rego-input rules', () => {
  const validate = compile('rego-input.schema.json');
  const base = () => structuredClone(loadDoc('rego-input.example.json')) as Record<string, any>;

  it('never carries an unverified attestation', () => {
    const doc = base();
    doc.attestation.verified = false;
    expect(validate(doc)).toBe(false);
  });

  it('only accepts DeploymentEvidence with a canonical evidenceDigest', () => {
    const doc = base();
    doc.evidence.kind = 'ControlPlaneEvidence';
    expect(validate(doc)).toBe(false);
    const doc2 = base();
    doc2.evidence.evidenceDigest = 'a'.repeat(64); // hex must be normalised before evaluation
    expect(validate(doc2)).toBe(false);
  });

  it('accepts an attested root, and rejects a malformed one', () => {
    const doc = base();
    doc.attestation.rootAttestation = {
      attested: true,
      evidenceType: 'AMD SEV-SNP (QEMU)',
      networkType: 'untrusted',
      measurement: 'a'.repeat(64),
      inRegistry: true,
      reportIntegrity: true,
      revocationChecked: false,
      keyBinding: true,
      cpuGeneration: 'Genoa',
      teeFlags: {
        vmpl: 0,
        debugAllowed: false,
        ciphertextHiding: false,
        pageSwapDisabled: false,
        snpFirmwareTcb: 27,
        reportVersion: 5,
      },
    };
    expect(validate(doc), errorsOf(validate)).toBe(true);

    // The measurement is what a policy compares against a reference value, so a
    // non-hex spelling of it has to be a schema error rather than a rule that
    // silently never matches.
    const bad = base();
    bad.attestation.rootAttestation = {
      attested: true,
      inRegistry: true,
      reportIntegrity: true,
      keyBinding: true,
      teeFlags: {},
      measurement: 'not-hex',
    };
    expect(validate(bad)).toBe(false);
  });

  it('passes unknown payload fields through', () => {
    const doc = base();
    doc.evidence.futureField = { anything: true };
    expect(validate(doc), errorsOf(validate)).toBe(true);
  });
});

describe('swarm-evidence-bundle rules', () => {
  const validate = compile('swarm-evidence-bundle.schema.json');
  const base = () => structuredClone(loadDoc('swarm-evidence-bundle.example.json')) as Record<string, any>;

  it('requires a compact JWS and a non-empty PEM chain', () => {
    const doc = base();
    doc.jws = 'not-a-jws';
    expect(validate(doc)).toBe(false);
    const doc2 = base();
    doc2.certChain = [];
    expect(validate(doc2)).toBe(false);
  });

  it('requires certFingerprint in sha256/<base64url> form', () => {
    const doc = base();
    doc.certFingerprint = 'a'.repeat(64);
    expect(validate(doc)).toBe(false);
  });
});

describe('router-config rules', () => {
  const validate = compile('router-config.schema.json');
  const base = () => structuredClone(loadDoc('router-config.example.yaml')) as Record<string, any>;

  it('requires a database url for postgres and a file for sqlite', () => {
    const cfg = base();
    cfg.database = { type: 'postgres' };
    expect(validate(cfg)).toBe(false);
    const cfg2 = base();
    cfg2.database = { type: 'sqlite', file: './dev.sqlite' };
    expect(validate(cfg2), errorsOf(validate)).toBe(true);
  });

  it('prices are integer micro-USD', () => {
    const cfg = base();
    cfg.models[0].pricing.promptPer1mMicros = 0.28;
    expect(validate(cfg)).toBe(false);
  });
});

/**
 * The conformance vectors and the bundle schema describe the same wire document from
 * two sides. If they disagree, either the schema is wrong or a fixture is not a bundle
 * a producer could ever have published — and the Go gatekeeper, which validates shape
 * against this schema before verifying, would reject a case it is expected to accept.
 */
describe('swarm-evidence-bundle schema vs. conformance vectors', () => {
  const validate = compile('swarm-evidence-bundle.schema.json');
  const manifest = loadConformanceManifest();
  const acceptedCases = manifest.cases.filter((c) => c.expect.ok && c.response.bodyFile !== undefined);

  it('has cases to check', () => {
    expect(acceptedCases.length).toBeGreaterThan(0);
  });

  it.each(acceptedCases.map((c) => [c.id, c] as const))('%s validates against the schema', (_id, testCase) => {
    expect(validate(loadCaseBody(testCase)), errorsOf(validate)).toBe(true);
  });
});
