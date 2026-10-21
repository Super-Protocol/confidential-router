import { describe, expect, it } from 'vitest';
import { BUNDLE_COVERAGE, type BundleCoverage, type BundleSection, entityNames } from './bundle-coverage.js';
import { BUNDLE_SECTIONS, buildBundle, type ExportData } from './export-bundle.js';
import { type LocalState, planImport } from './import-plan.js';

/**
 * The guard the API keys needed (SUP-445).
 *
 * An entity that is in no list is dropped by every rebuild in silence, so these
 * tests refuse the "no list" state: every table in the schema is either carried
 * by a named bundle section or left behind with a written reason, and every
 * section of the bundle has a table that claims it.
 */

type Carried = Extract<BundleCoverage, { section: BundleSection }>;

const carried = (coverage: BundleCoverage): coverage is Carried => 'section' in coverage;

const HOW_TO_FIX =
  'Add it to BUNDLE_COVERAGE in bundle-coverage.ts: name the bundle section it travels in (and carry it in ' +
  'data-export.service.ts, import-plan.ts and data-import.service.ts), or write down why it stays behind.';

describe('BUNDLE_COVERAGE', () => {
  it('accounts for every entity in the schema', () => {
    const unaccounted = entityNames().filter((name) => !(name in BUNDLE_COVERAGE));

    expect(
      unaccounted,
      `${unaccounted.join(', ')} is not in the deployment export’s coverage list. ${HOW_TO_FIX}`,
    ).toEqual([]);
  });

  it('names no entity the schema no longer has', () => {
    const known = new Set(entityNames());
    const stale = Object.keys(BUNDLE_COVERAGE).filter((name) => !known.has(name));

    expect(stale, `${stale.join(', ')} is no longer an entity; drop the entry.`).toEqual([]);
  });

  it('carries each entity in a section the bundle really has', () => {
    const sections: readonly string[] = BUNDLE_SECTIONS;
    const wrong = Object.entries(BUNDLE_COVERAGE)
      .filter(([, coverage]) => carried(coverage) && !sections.includes(coverage.section))
      .map(([name]) => name);

    expect(wrong, `${wrong.join(', ')} names a section that is not in the bundle’s data.`).toEqual([]);
  });

  it('gives every section of the bundle an entity that travels in it', () => {
    const claimed = new Set(
      Object.values(BUNDLE_COVERAGE)
        .filter(carried)
        .map((coverage) => coverage.section),
    );
    const orphans = BUNDLE_SECTIONS.filter((section) => !claimed.has(section));

    expect(orphans, `${orphans.join(', ')} is exported from no entity; the section or the list is wrong.`).toEqual([]);
  });

  it('explains every table it leaves behind', () => {
    const silent = Object.entries(BUNDLE_COVERAGE)
      .filter(([, coverage]) => !carried(coverage) && coverage.notCarried.trim().length < 40)
      .map(([name]) => name);

    expect(silent, `${silent.join(', ')} is left behind without a reason a reader could disagree with.`).toEqual([]);
  });

  it('plans and reports a section for every section of the bundle', () => {
    // The export and the import are maintained by hand in three files; this is
    // the one place that asks whether they still agree. An empty bundle is
    // enough — what is being read is the shape of the plan, not its numbers.
    const empty: ExportData = {
      users: [],
      workspaces: [],
      workspaceMembers: [],
      creditLedger: [],
      inviteCodes: [],
      inviteRedemptions: [],
      apiKeys: [],
      externalEndpoints: [],
      trustedMeasurements: [],
    };
    const local: LocalState = {
      users: [],
      workspaces: [],
      members: [],
      ledger: [],
      inviteCodes: [],
      redemptions: [],
      apiKeys: [],
      externalEndpoints: [],
      models: [],
      trustedMeasurements: [],
    };
    const bundle = buildBundle({
      data: empty,
      source: { publicBaseUrl: 'https://old.router.test', routerVersion: '0.0.0', evidenceDigest: null },
      exportedAt: new Date('2026-10-20T00:00:00.000Z'),
    });

    const plan = planImport(bundle, local, { operatorEmails: [] });
    const planned = new Set<string>(plan.sections.map((section) => section.section));
    const unplanned = BUNDLE_SECTIONS.filter((section) => !planned.has(section));
    const uncounted = BUNDLE_SECTIONS.filter((section) => !(section in plan.writes));

    expect(unplanned, `${unplanned.join(', ')} is in the bundle but has no section in the import plan.`).toEqual([]);
    expect(uncounted, `${uncounted.join(', ')} is in the bundle but the import writes nothing for it.`).toEqual([]);
  });
});
