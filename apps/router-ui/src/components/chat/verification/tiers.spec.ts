import { describe, expect, it } from 'vitest';
import type { GateResult } from './evidence-gate';
import type { BridgeOutcome } from './extension-bridge';
import {
  badgeTier,
  bundleSourceNote,
  EXTENSION_TIER,
  extensionTierState,
  GATEKEEPER_TIER,
  gatekeeperDivergenceNote,
  HISTORY_COPY,
  PAGE_TIER,
  pageTierState,
} from './tiers';

describe('the tier labels', () => {
  it('never say “verified” without saying who verified', () => {
    // The whole feature turns on this. A badge reading "Verified" alone is the
    // single most misleading string the product could ship, because a page
    // served by the deployment it is checking cannot make that claim.
    const labels = [
      ...Object.values(PAGE_TIER).map((tier) => tier.label),
      ...Object.values(EXTENSION_TIER).map((tier) => tier.label),
      GATEKEEPER_TIER.label,
    ];

    for (const label of labels) {
      if (/verified/i.test(label)) {
        expect(label, `"${label}" must attribute the verification`).toMatch(/this page|extension/i);
      }
    }
  });

  it('gives every tier a caveat, so a label never travels alone', () => {
    for (const tier of [...Object.values(PAGE_TIER), ...Object.values(EXTENSION_TIER), GATEKEEPER_TIER]) {
      expect(tier.caveat.length, `${tier.id}/${tier.label}`).toBeGreaterThan(40);
    }
  });

  it('tells the reader, in tier 1’s own copy, that the check is self-reported', () => {
    expect(PAGE_TIER.pass.caveat).toMatch(/self-reported/i);
    expect(PAGE_TIER.pass.caveat).toMatch(/extension|gatekeeper/i);
  });

  it('claims independence only for the extension', () => {
    expect(EXTENSION_TIER.pass.label).toMatch(/independently/i);
    expect(PAGE_TIER.pass.label).not.toMatch(/independently/i);
  });
});

describe('badgeTier', () => {
  it('shows the extension’s pass over the page’s', () => {
    expect(badgeTier('pass', 'pass')).toBe(EXTENSION_TIER.pass);
  });

  it('lets a refusal outrank a pass, whichever tier refused', () => {
    // The extension is the less credulous of the two. If it says no while the
    // page says yes, the badge says no.
    expect(badgeTier('pass', 'fail')).toBe(EXTENSION_TIER.fail);
    expect(badgeTier('fail', 'unavailable')).toBe(PAGE_TIER.fail);
  });

  it('falls back to the page’s own result when no extension is present', () => {
    expect(badgeTier('pass', 'unavailable')).toBe(PAGE_TIER.pass);
  });

  it('stays pending while either tier is still working', () => {
    expect(badgeTier('pending', 'unavailable')).toBe(PAGE_TIER.pending);
    expect(badgeTier('pass', 'pending')).toBe(PAGE_TIER.pending);
  });
});

describe('tier states', () => {
  it('reads a missing gate result as pending, not as a failure', () => {
    expect(pageTierState(null)).toBe('pending');
    expect(pageTierState({ unlocked: true } as GateResult)).toBe('pass');
    expect(pageTierState({ unlocked: false } as GateResult)).toBe('fail');
  });

  it('reads an absent extension as unavailable, which is not a refusal', () => {
    expect(extensionTierState(null)).toBe('pending');
    expect(extensionTierState({ status: 'absent' })).toBe('unavailable');
    expect(extensionTierState({ status: 'verified', verdict: { ok: true } } as BridgeOutcome)).toBe('pass');
    expect(extensionTierState({ status: 'refused', verdict: { ok: false } } as BridgeOutcome)).toBe('fail');
  });
});

describe('the tier-1 badge caveat', () => {
  it('says a stronger check can refuse, not only that it is stronger (SUP-185)', () => {
    /*
     * The badge is what most readers see and all that some read. Saying the
     * extension or Gatekeeper gives "a check the deployment cannot influence"
     * implies a firmer yes; it does not prepare anyone for a no. On the live
     * platform the no is what they get, so the word has to be here.
     */
    expect(PAGE_TIER.pass.caveat).toMatch(/refuse an endpoint this page unlocked/i);
  });
});

describe('gatekeeperDivergenceNote', () => {
  function gateWithRoot(status: 'pass' | 'fail' | 'unavailable' | null): GateResult {
    return {
      unlocked: true,
      checks: status ? [{ id: 'root', status, detail: 'x' }] : [],
      registry: null,
      evidence: null,
    };
  }

  it('warns before the quick-start when tier 1 could not settle the root', () => {
    // The panel hands over four commands with the digest substituted. On the live
    // platform they return `exit 3`. A reader must not learn that from the shell.
    const note = gatekeeperDivergenceNote(gateWithRoot('unavailable'));

    expect(note).toMatch(/may end in a refusal/i);
    expect(note).toMatch(/authoritative/i);
  });

  it('is blunter when the page already saw the root check fail', () => {
    expect(gatekeeperDivergenceNote(gateWithRoot('fail'))).toMatch(/Expect Gatekeeper to refuse/i);
  });

  it('stays silent when the root passed, so the warning keeps its meaning', () => {
    expect(gatekeeperDivergenceNote(gateWithRoot('pass'))).toBeNull();
  });

  it('stays silent before tier 1 has run at all', () => {
    expect(gatekeeperDivergenceNote(null)).toBeNull();
    expect(gatekeeperDivergenceNote(gateWithRoot(null))).toBeNull();
  });
});

describe('bundleSourceNote', () => {
  it('warns that a relayed bundle may be older than what the endpoint serves', () => {
    expect(bundleSourceNote('router')).toMatch(/older/i);
    expect(bundleSourceNote('endpoint')).toMatch(/directly/i);
  });
});

describe('HISTORY_COPY', () => {
  it('names the boundary, the encryption and the maintenance risk together', () => {
    /*
     * The honesty rule at its sharpest. "Stored inside the attested boundary" is a
     * *confidentiality* claim, and a reader hears it as a durability claim unless
     * the sentence beside it says otherwise. Denis deferred the durability work
     * and accepted the risk, so all three have to appear — and the caveat has to
     * be in the summary, not buried at the end of the detail where it can be
     * skimmed past.
     */
    const stored = HISTORY_COPY.attested_server;

    expect(stored.summary).toMatch(/attested boundary/i);
    expect(stored.summary).toMatch(/may be lost during maintenance/i);
    expect(stored.detail).toMatch(/encrypted at rest/i);
    expect(stored.detail).toMatch(/ephemeral by design/i);
    expect(stored.detail).toMatch(/deleted outright/i);
  });

  it('promises no backup, retention window or recovery', () => {
    // Words that would each be a promise nobody has made.
    const stored = `${HISTORY_COPY.attested_server.summary} ${HISTORY_COPY.attested_server.detail}`;

    expect(stored).not.toMatch(/backed up|backup|restore|recover(ed|y)|guarantee/i);
  });

  it('still says the messages themselves reach the model, and are not stored there', () => {
    // Server-side history must not be allowed to blur into "the router keeps your
    // prompts": the metering path still records none.
    expect(HISTORY_COPY.attested_server.detail).toMatch(/v1\/chat\/completions/);
    expect(HISTORY_COPY.attested_server.detail).toMatch(/no content at all/i);
  });

  it('keeps the browser-local wording honest for a deployment that has no server storage', () => {
    // SUP-179 has not answered whether a tenant PVC survives a node reboot, so
    // the browser-local copy must not describe storage inside the boundary.
    const local = HISTORY_COPY.browser_local;

    expect(local.summary).toMatch(/this browser/i);
    expect(`${local.summary} ${local.detail}`).not.toMatch(/encrypted at rest|attested boundary|retention/i);
  });

  it('says plainly that the messages themselves still reach the model', () => {
    // Local history must not be allowed to read as "nothing leaves the browser".
    expect(HISTORY_COPY.browser_local.detail).toMatch(/do travel to the model/i);
    expect(HISTORY_COPY.browser_local.detail).toMatch(/no content/i);
  });
});
