// Re-derives everything an export bundle claims about itself, and prints the
// few fields the shell around it needs.
//
//   EXPORT_HEADER_SHA=<x-export-sha256> node verify-bundle.mjs <bundle.json.gz>
//
// Exits 0 and prints one JSON object on stdout when the file is a bundle whose
// manifest agrees with its contents; exits 1 and prints the refusal, in a
// sentence meant for an operator, when it is not.
//
// The canonical form is `JSON.stringify` over objects with their keys sorted at
// every level — the same `canonicalJson` the router hashes with. That is why
// this is node and not jq: a different serializer is a different hash, and a
// hash that disagrees for a reason of its own is worse than no check at all.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function countsOf(data) {
  return {
    users: data.users.length,
    workspaces: data.workspaces.length,
    workspaceMembers: data.workspaceMembers.length,
    creditEntries: data.creditLedger.length,
    inviteCampaigns: new Set(data.inviteCodes.map((code) => code.campaign)).size,
    inviteCodes: data.inviteCodes.length,
    inviteCodesUnredeemed: data.inviteCodes.filter((code) => code.status === 'unredeemed').length,
    inviteRedemptions: data.inviteRedemptions.length,
    externalEndpoints: data.externalEndpoints.length,
    externalModels: data.externalEndpoints.reduce((sum, endpoint) => sum + endpoint.models.length, 0),
    trustedMeasurements: data.trustedMeasurements.length,
  };
}

function refuse(message) {
  process.stdout.write(message);
  process.exit(1);
}

const [file] = process.argv.slice(2);
if (!file) {
  refuse('verify-bundle.mjs needs the path of an export bundle.');
}

let bundle;
try {
  bundle = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
} catch (error) {
  refuse(`the export file is not readable gzipped JSON (${error.message}). It was truncated in transit.`);
}

// `EXPORT_FORMAT` and `EXPORT_SCHEMA_VERSION` in
// apps/router-api/src/app/data-migration/export-bundle.ts.
if (bundle?.format !== 'router-export') {
  refuse(`the file declares format ${JSON.stringify(bundle?.format)}, which is not a router export.`);
}
if (bundle.schemaVersion !== 1) {
  refuse(
    `the file declares schema version ${JSON.stringify(bundle.schemaVersion)} and this checker knows version 1; update tools/scheduled-export alongside the export it reads.`,
  );
}
for (const section of [
  'users',
  'workspaces',
  'workspaceMembers',
  'creditLedger',
  'inviteCodes',
  'inviteRedemptions',
  'externalEndpoints',
  'trustedMeasurements',
]) {
  if (!Array.isArray(bundle.data?.[section])) {
    refuse(`the bundle has no ${section} section; it is not the document this build knows how to read.`);
  }
}

const recomputed = createHash('sha256').update(canonicalJson(bundle.data), 'utf8').digest('hex');
const declared = bundle.integrity?.contentSha256;
if (recomputed !== declared) {
  refuse(`the bundle's contents hash to ${recomputed} but it declares ${declared}; the file was edited or truncated.`);
}

const header = process.env.EXPORT_HEADER_SHA;
if (header && header !== declared) {
  refuse(
    `the response header declared sha256 ${header} and the file declares ${declared}; what arrived is not what was sent.`,
  );
}

const counts = countsOf(bundle.data);
for (const [key, value] of Object.entries(counts)) {
  if (bundle.counts?.[key] !== value) {
    refuse(
      `the bundle counts ${bundle.counts?.[key]} ${key} but carries ${value}; its manifest does not describe its contents.`,
    );
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      contentSha256: declared,
      exportedAt: bundle.exportedAt,
      routerVersion: bundle.source?.routerVersion ?? '',
      ...counts,
    },
    null,
    2,
  )}\n`,
);
