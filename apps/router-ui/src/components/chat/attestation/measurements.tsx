'use client';

import { Badge } from '@confidential-router/ui/components/badge';
import type { EndpointKind, GateEvidence, GateResult } from '../verification/evidence-gate';
import type { BridgeOutcome } from '../verification/extension-bridge';
import { Field, FieldGroup } from './field';
import type { DeploymentGraph } from './graph-model';
import { abbreviate, prefixedHex } from './hex';
import { IMAGE_VERDICTS, ImageVerdictBadge } from './image-verdict';

export interface MeasurementsProps {
  hostname: string;
  /** Whose endpoint this is. Decides the first group's heading and the provenance row. */
  endpointKind?: EndpointKind;
  /** The operator's TEE label from the catalogue. Informational, never a claim. */
  teeLabel: string | null;
  gate: GateResult;
  evidence: GateEvidence;
  extension: BridgeOutcome | null;
  checkedAt: Date | null;
  graph: DeploymentGraph;
}

/**
 * Every measurement the evidence carries, in the spelling the rest of the
 * product uses.
 *
 * ## Parity with the extension, and then some
 *
 * The Chrome extension's `EvidenceDetails` is the floor: trusted root and its
 * fingerprint, the certificate fingerprint, the channel-binding mode, issued and
 * verified times, the evidence digest and the root CA quote format. Each of those
 * has a row here, and the rows the extension does not have — the TCB level, the
 * report policy bits, the whole certificate chain, the sp-vm registry verdict,
 * the per-image digests — are the ones this panel exists for.
 *
 * ## Why no row says "verified"
 *
 * Not one value below is a verdict. The verdicts live in the tier list the badge
 * already owns (`verification/tiers.ts`), each carrying the limit of the agent
 * that reached it; the rows here are *what the document says*, which is a
 * different kind of statement and must not borrow the other's tone. Where a field
 * is routinely misread as a verdict — the root's own TEE quote, the report
 * measurement, the operator's TEE label — the row says in words why it is not.
 */
export function Measurements({
  hostname,
  endpointKind = 'own',
  teeLabel,
  gate,
  evidence,
  extension,
  checkedAt,
  graph,
}: MeasurementsProps) {
  const external = endpointKind === 'external';
  const registry = gate.registry;
  const binding = gate.checks.find((check) => check.id === 'binding');
  const root = gate.checks.find((check) => check.id === 'root');
  const security = evidence.rootSecurity;

  return (
    <div className="space-y-6">
      <FieldGroup
        title={external ? 'This upstream' : 'This endpoint'}
        description={
          external
            ? 'Whose deployment this is, and which document the rest of this panel is reading.'
            : 'What the deployment is, and which document the rest of this panel is reading.'
        }
      >
        <Field label="Hostname" value={hostname} mono />
        {external ? (
          <Field
            label="TEE, as the operator declares it"
            value={null}
            note="Nobody declares one for another deployment's hardware, and this router does not invent one: an admitted measurement says which cloud answered, not which silicon or which software. The rows below are what that cloud itself signed."
          />
        ) : (
          <Field
            label="TEE, as the operator declares it"
            value={teeLabel}
            note="A label from the router's configuration. It is what the operator says the hardware is, and nothing on this page checks it — the rows below are what the hardware itself signed."
          />
        )}
        <Field
          label="Evidence kind"
          value={evidence.kind}
          note="A router endpoint publishes DeploymentEvidence; Gatekeeper refuses the other kinds for a hostname like this one."
        />
        <Field
          label="Signed at"
          value={new Date(evidence.issuedAt).toLocaleString()}
          note="The signed issuedAt — the clock Gatekeeper ages the bundle by."
          copyValue={evidence.issuedAt}
        />
        <Field
          label="Checked in this page"
          value={checkedAt ? checkedAt.toLocaleString() : null}
          note="When tier 1 ran, by this browser's clock. A tab left open overnight shows an old time here beside a bundle that was fresh when it was fetched."
          copyValue={checkedAt?.toISOString() ?? undefined}
        />
        {/*
          The provenance row, and for an external upstream it is the one row in
          this panel that must be read before any other: it names the relay and
          it names whose publication came through it. A reader who took this graph
          for a document fetched from the host itself would be crediting this page
          with a reach it does not have, and crediting the bundle with a freshness
          the relay does not promise (ADR-008 §7).
        */}
        <Field
          label="Bundle came from"
          value={
            external
              ? `this router’s relay of ${hostname}`
              : evidence.source === 'endpoint'
                ? 'the endpoint itself'
                : 'this router’s passthrough'
          }
          note={
            external
              ? `This router fetched ${hostname}’s /.well-known/swarm-evidence and stored it; what you see is those bytes, relayed unchanged — the publication this router’s own verdict named, which may be older than what ${hostname} serves now. The upstream’s platform sends no cross-origin header, so the relay is the only way this page could read the document at all. Its signature was checked here, by this page.`
              : evidence.source === 'endpoint'
                ? 'A direct fetch of the host’s own /.well-known/swarm-evidence — the same document Gatekeeper reads.'
                : 'The host would not serve this page a cross-origin request, so the bundle came from this router. Its signature was still checked here, but it may be older than what the host serves now.'
          }
        />
      </FieldGroup>

      <FieldGroup
        title="Measurements"
        description="The values a reader pins, and the two that look alike and are not interchangeable."
      >
        <Field
          label="Evidence digest"
          value={prefixedHex(evidence.evidenceDigest)}
          mono
          copyValue={prefixedHex(evidence.evidenceDigest) ?? undefined}
          note="SHA-256 of the canonical deployment snapshot — the value to pin in a gatekeeper, and the digest the graph below is covered by."
        />
        <Field
          label="Registry measurement"
          value={evidence.measurement ? `sha256:${evidence.measurement}` : null}
          mono
          note="The VM launch measurement the producer published for lookup in Super Protocol's signed registry — the mrEnclave-equivalent. Absent on the live platform today, which is why the root check below reports what it does."
        />
        <Field
          label="Root report measurement"
          value={evidence.rootReportMeasurement ? `sha256:${evidence.rootReportMeasurement}` : null}
          mono
          note="The MEASUREMENT field of the root certificate's own hardware report. Shown because it is the report's headline value — and deliberately never used as a registry key: the registry indexes a normalised launch digest rebuilt from the release's firmware, so looking this value up would answer “not one of ours” for a healthy VM."
        />
        {gate.evidence?.quoteFormat ? (
          <Field
            label="Root CA TEE quote format"
            value={gate.evidence.quoteFormat}
            note="Shown for reference. Nothing in this browser verifies the quote itself; that is Gatekeeper's work."
          />
        ) : (
          <Field
            label="Root CA TEE quote format"
            value={null}
            note="The platform publishes no usable rootCaTeeQuote for this endpoint. The hardware report is in the root certificate's own extension instead — see the rows below."
          />
        )}
      </FieldGroup>

      <FieldGroup
        title="Report policy and TCB"
        description={
          security
            ? 'How the VM behind the root certificate was allowed to run, read out of its SEV-SNP report. Reported, never judged: which combination is acceptable is an operator’s policy decision, and these are the bits it is made on.'
            : 'The root certificate carries no hardware report these fields could be read from, or carries one in a format this page does not parse. Gatekeeper reads them for every supported platform.'
        }
      >
        {security ? (
          <>
            <Field
              label="TCB level (SNP firmware)"
              value={String(security.launchTcb.snp)}
              note={`The SNP firmware security-version number the VM launched against. Full launch TCB ${security.launchTcb.raw}: bootloader ${security.launchTcb.bootLoader}, TEE ${security.launchTcb.tee}, microcode ${security.launchTcb.microcode}.`}
            />
            <Field
              label="Current / reported TCB"
              value={`${security.currentTcb.raw} / ${security.reportedTcb.raw}`}
              mono
              note="What the platform runs now, and what the report asks a verifier to hold it to. A current TCB above the launch TCB means the platform was updated after this VM booted."
            />
            <Field
              label="Guest policy"
              value={security.policy.raw}
              mono
              note={`ABI ${security.policy.abiMajor}.${security.policy.abiMinor}; SMT ${security.policy.smtAllowed ? 'allowed' : 'not allowed'}; migration agents ${security.policy.migrateMaAllowed ? 'allowed' : 'not allowed'}; single socket ${security.policy.singleSocketRequired ? 'required' : 'not required'}.`}
            />
            <Field
              label="Debug"
              value={security.policy.debugAllowed ? 'permitted by policy' : 'not permitted'}
              adornment={
                <Badge variant={security.policy.debugAllowed ? 'destructive' : 'success'}>
                  {security.policy.debugAllowed ? 'host may decrypt' : 'closed'}
                </Badge>
              }
              note="The one policy bit with no sensible good value: when debug is permitted, the host may decrypt the guest."
            />
            <Field
              label="Hardening"
              value={`ciphertext hiding ${security.policy.ciphertextHiding ? 'on' : 'off'}, page swap ${security.policy.pageSwapDisabled ? 'disabled' : 'permitted'}`}
              note="Optional guest-policy hardening. Whether their absence disqualifies a deployment is a policy question this page does not answer."
            />
            <Field
              label="VMPL / report version"
              value={`${security.vmpl} / v${security.reportVersion}`}
              note="The privilege level the report was produced at — 0 is highest — and the report format version."
            />
          </>
        ) : (
          <Field label="TCB level (SNP firmware)" value={null} />
        )}
      </FieldGroup>

      <FieldGroup
        title={external ? 'The TLS certificate this router pinned' : 'The TLS certificate this page is bound to'}
        description={
          external
            ? 'Which channel the signed evidence is about — the one this router’s egress opens to the upstream, not the one your browser opened to this router.'
            : 'Whether the signed evidence is about the connection you are actually using.'
        }
      >
        <Field
          label="Certificate fingerprint"
          value={prefixedHex(evidence.certFingerprint)}
          mono
          copyValue={prefixedHex(evidence.certFingerprint) ?? undefined}
          note="The TLS leaf the evidence signs."
        />
        <Field
          label="Channel binding"
          value="producer-asserted"
          adornment={<Badge variant="warning">weaker than observed</Badge>}
          note={
            binding?.detail ??
            'A page cannot read the live TLS certificate, so it checks the certificate the deployment publishes against the fingerprint the evidence signs.'
          }
        />
        {extension?.status === 'verified' && extension.verdict.channelBinding ? (
          <Field
            label="The extension’s binding"
            value={extension.verdict.channelBinding}
            note="What the browser extension reported independently. Chrome's MV3 cannot read the live leaf either, so it is producer-asserted there too — Gatekeeper is the tier that observes the channel."
          />
        ) : null}
      </FieldGroup>

      <FieldGroup
        title="Certificate chain, leaf to TEE-quoted root"
        description="Each certificate signs the next; the terminal one is the self-signed root whose own extensions carry the hardware report. The fingerprint to compare with your gatekeeper's trusted root is the last one."
      >
        {evidence.chain.map((certificate, index) => (
          <Field
            key={certificate.fingerprint}
            label={certificate.isRoot ? 'Root' : index === 0 ? 'Leaf' : `Intermediate ${index}`}
            value={prefixedHex(certificate.fingerprint) ?? certificate.fingerprint}
            mono
            copyValue={prefixedHex(certificate.fingerprint) ?? certificate.fingerprint}
            adornment={certificate.isRoot ? <Badge variant="brand">TEE-quoted root</Badge> : undefined}
            note={`${certificate.subject} — issued by ${certificate.issuer}, valid until ${new Date(certificate.notAfter).toLocaleString()}.`}
          />
        ))}
        <Field
          label="Super Protocol network"
          value={evidence.rootNetworkType}
          note="What the root certificate says about its own network. Reported, never enforced — the live demo cloud's root says “untrusted”, and Gatekeeper reports the same thing."
        />
        {evidence.rootAttestationError ? (
          <Field
            label="Could not read"
            value={evidence.rootAttestationError}
            note="An attestation extension on the root is present but unusable. That is a platform problem worth reporting, and a different thing from a root that carries nothing."
          />
        ) : null}
      </FieldGroup>

      <FieldGroup
        title="Does Super Protocol vouch for this VM?"
        description="The one question this page cannot answer out of the bundle alone, and the one the badge above does not cover."
      >
        <Field
          label="Hardware the root enrolled from"
          value={evidence.rootEvidenceLabel}
          note={
            evidence.rootChallengeType
              ? `The root certificate's enrolment challenge was "${evidence.rootChallengeType}".`
              : undefined
          }
        />
        <Field label="sp-vm release" value={evidence.rootBuild} />
        <Field
          label="Report binds this root’s key"
          value={
            evidence.rootKeyBinding === null
              ? null
              : evidence.rootKeyBinding
                ? 'yes'
                : 'no — the report attests another key'
          }
          adornment={
            evidence.rootKeyBinding === false ? (
              <Badge variant="destructive">do not trust this endpoint on this page</Badge>
            ) : evidence.rootKeyBinding === true ? (
              <Badge variant="success">bound</Badge>
            ) : undefined
          }
          note="Whether the report's REPORT_DATA commits to this root certificate's public key. Without it the report is about some Super Protocol VM, not about this certificate authority."
        />
        <Field
          label="sp-vm registry verdict"
          value={
            registry === null
              ? null
              : registry.status === 'vouched'
                ? `vouched — ${abbreviate(registry.measurement)}`
                : registry.status === 'not-in-registry'
                  ? `not in the registry — ${abbreviate(registry.measurement)}`
                  : 'could not be consulted'
          }
          adornment={
            registry?.status === 'vouched' ? (
              <Badge variant="success">signed by Super Protocol</Badge>
            ) : registry?.status === 'not-in-registry' ? (
              <Badge variant="destructive">not one of ours</Badge>
            ) : undefined
          }
          note={root?.detail ?? 'The registry lookup did not run.'}
          copyValue={registry && 'measurement' in registry ? registry.measurement : undefined}
        />
      </FieldGroup>

      <FieldGroup
        title={`Images the signed evidence carries (${graph.containers.length})`}
        description={
          <>
            Every container the attested snapshot declares, with its digest, matched against the images the operator
            declares this endpoint runs. The same digests appear on the graph; this is the list of them.
          </>
        }
      >
        {graph.containers.length === 0 ? (
          <Field
            label="Images"
            value={null}
            note="The signed snapshot carries no container this panel could read. The digest above is still the value the whole document is pinned by."
          />
        ) : (
          graph.containers.map((container) => (
            <Field
              key={container.id}
              label={container.name}
              value={container.image?.raw ?? null}
              mono
              adornment={container.verdict ? <ImageVerdictBadge verdict={container.verdict} /> : undefined}
              note={
                <>
                  {container.detail ? `${container.detail} · ` : null}
                  {container.verdict ? IMAGE_VERDICTS[container.verdict.status].sentence : null}
                  {container.verdict?.status === 'digest-mismatch'
                    ? ` Declared: ${container.verdict.declaredDigests.map((digest) => abbreviate(digest, 14)).join(', ')}.`
                    : null}
                </>
              }
            />
          ))
        )}
      </FieldGroup>
    </div>
  );
}
