/**
 * Runs the evidence host as a process, with the deny-path controls exposed.
 *
 *   MOCK_EVIDENCE_UPSTREAM=http://127.0.0.1:3000 MOCK_EVIDENCE_PORT=8443 \
 *     node --experimental-strip-types tools/mock-evidence-host/src/main.ts
 *
 * It prints one JSON line on startup — the URL, the digest it publishes and the
 * path it wrote the trusted root to — so a script can read what it needs
 * without parsing prose. `tools/demo` runs it in-process instead.
 */
import { writeFileSync } from 'node:fs';
import { startMockEvidenceHost } from './server.js';

const host = await startMockEvidenceHost({
  upstream: process.env.MOCK_EVIDENCE_UPSTREAM,
  hostname: process.env.MOCK_EVIDENCE_HOSTNAME,
  port: process.env.MOCK_EVIDENCE_PORT ? Number(process.env.MOCK_EVIDENCE_PORT) : undefined,
  controlApi: true,
});

const rootFile = process.env.MOCK_EVIDENCE_ROOT_FILE;
if (rootFile) {
  writeFileSync(rootFile, host.trustedRootPem, 'utf8');
}

console.log(
  JSON.stringify({
    url: host.url,
    port: host.port,
    hostname: host.hostname,
    evidenceDigest: host.evidenceDigest(),
    trustedRootFile: rootFile ?? null,
    control: `${host.url}/__mock/state`,
  }),
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void host.close().then(() => process.exit(0));
  });
}
