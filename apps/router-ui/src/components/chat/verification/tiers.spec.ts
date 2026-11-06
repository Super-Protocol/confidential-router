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
  UPSTREAM_TIER,
} from './tiers';

describe('the tier labels', () => {
  it('never say “verified” without saying who verified', () => {
    // The whole feature turns on this. A badge reading "Verified" alone is the
    // single most misleading string the product could ship, because a page
    // served by the deployment it is checking cannot make that claim.
    const labels = [
      ...Object.values(PAGE_TIER).map((tier) => tier.label),
      ...Object.values(UPSTREAM_TIER).map((tier) => tier.label),
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
    for (const tier of [
      ...Object.values(PAGE_TIER),
      ...Object.values(UPSTREAM_TIER),
      ...Object.values(EXTENSION_TIER),
      GATEKEEPER_TIER,
    ]) {
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

describe('the external upstream tier (SUP-618)', () => {
  it('never claims the composer is locked, because it locks nothing', () => {
    /*
     * The defect, as one assertion. The external panel runs its own
     * `useVerification` because "it unlocks nothing"; borrowing tier 1's failure
     * copy had it announce "the composer stays locked" on a page whose composer
     * was answering turns. Production 0.19.8 printed exactly that and routed an
     * urgent issue at the wrong deployment.
     */
    for (const tier of Object.values(UPSTREAM_TIER)) {
      // Not "a weaker claim about the composer" — no claim. This panel cannot
      // observe that lock in either direction, so it has nothing to say about it.
      expect(tier.caveat, tier.label).not.toMatch(/composer/i);
      expect(tier.caveat, tier.label).not.toMatch(/nothing is sent to a deployment/i);
    }
  });

  it('says of a failure what is true of it: that it gates nothing', () => {
    // Not merely silent about the composer — a reader who opened this panel
    // because they are worried needs the positive statement too.
    expect(UPSTREAM_TIER.fail.caveat).toMatch(/unlocks nothing and locks nothing/i);
    expect(UPSTREAM_TIER.fail.caveat).toMatch(/not by itself a verdict on the channel/i);
  });

  it('names what failed: the relayed copy, not the upstream itself', () => {
    expect(UPSTREAM_TIER.fail.caveat).toMatch(/relayed/i);
    expect(UPSTREAM_TIER.fail.label).toMatch(/upstream evidence/i);
  });

  it('warns on a pass that the relayed copy may be stale', () => {
    // The relay serves the publication this router's own verdict named, which is
    // the whole reason SUP-615 existed.
    expect(UPSTREAM_TIER.pass.caveat).toMatch(/older than what its own host serves/i);
  });

  it('keeps tier 1’s own failure copy talking about the composer, because there it is true', () => {
    // The fix is a second presentation, not a weaker first one: the chat's own
    // endpoint failing really does shut the composer, and that sentence must
    // survive.
    expect(PAGE_TIER.fail.caveat).toMatch(/composer stays locked/i);
  });
});

describe('badgeTier over an external upstream', () => {
  it('reads the upstream tier rather than tier 1’s', () => {
    expect(badgeTier('fail', 'unavailable', 'external')).toBe(UPSTREAM_TIER.fail);
    expect(badgeTier('pass', 'unavailable', 'external')).toBe(UPSTREAM_TIER.pass);
    expect(badgeTier('pending', 'unavailable', 'external')).toBe(UPSTREAM_TIER.pending);
  });

  it('ignores the extension, which is never asked about an upstream', () => {
    /*
     * `useVerification` sets the outcome to `absent` for an external upstream and
     * asks no extension at all — the extension speaks to a channel this browser
     * never opened. A ranking against that borrowed value would be an opinion
     * nobody gave.
     */
    expect(badgeTier('pass', 'fail', 'external')).toBe(UPSTREAM_TIER.pass);
    expect(badgeTier('pass', 'pass', 'external')).toBe(UPSTREAM_TIER.pass);
    expect(badgeTier('pending', 'pass', 'external')).toBe(UPSTREAM_TIER.pending);
  });

  it('still defaults to the endpoint’s own tiers when no kind is given', () => {
    expect(badgeTier('fail', 'unavailable')).toBe(PAGE_TIER.fail);
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
  it('keeps the inline line affirmative, and nothing but', () => {
    /*
     * Denis's complaint about 0.8.0, in one assertion. The caveat inline turned
     * the composer's footer into a warning banner on the product's main demo
     * surface, so `summary` is the confidentiality claim and only that: no
     * durability word, no "but", nothing a reader has to be reassured about
     * before they have typed anything.
     */
    const stored = HISTORY_COPY.attested_server;

    expect(stored.summary).toBe('Stored inside the attested boundary');
    expect(stored.summary).not.toMatch(/lost|maintenance|ephemeral|cannot|not durable/i);
  });

  it('still names the boundary, the encryption and the deletion, one click away', () => {
    /*
     * The honesty requirement from the CTO's SUP-180 review is unchanged — only
     * its placement moved. Every claim the inline line used to carry is still
     * published; it is published in the popover.
     */
    const stored = HISTORY_COPY.attested_server;

    expect(stored.detail).toMatch(/encrypted at rest/i);
    expect(stored.detail).toMatch(/deleted outright/i);
    expect(stored.maintenanceCaveat).toMatch(/may be lost during infrastructure maintenance/i);
  });

  it('quotes the durability caveat as the privacy policy’s one sentence', () => {
    /*
     * The UI and /privacy §5a say the same sentence, not two paraphrases of it:
     * the landing repo's `consoleChat.maintenanceRisk` is the phrase, and §5a
     * renders it as "Your conversations …". A product that hedges the policy, or
     * a policy that hedges the product, is the contradiction a reader finds.
     *
     * One sentence, deliberately: SUP-183 deletes it from both surfaces in the
     * release train that ships replicated PostgreSQL, and a single sentence is a
     * deletion rather than an edit.
     */
    expect(HISTORY_COPY.attested_server.maintenanceCaveat).toBe(
      'Your conversations may be lost during infrastructure maintenance.',
    );
  });

  it('promises no backup, retention window or recovery', () => {
    // Words that would each be a promise nobody has made.
    const stored = HISTORY_COPY.attested_server;
    const published = `${stored.summary} ${stored.detail} ${stored.transport} ${stored.maintenanceCaveat}`;

    expect(published).not.toMatch(/backed up|backup|restore|recover(ed|y)|guarantee/i);
  });

  it('still says the messages themselves reach the model, and are not stored there', () => {
    // Server-side history must not be allowed to blur into "the router keeps your
    // prompts": the metering path still records none.
    expect(HISTORY_COPY.attested_server.transport).toMatch(/v1\/chat\/completions/);
    expect(HISTORY_COPY.attested_server.transport).toMatch(/no content at all/i);
  });

  it('keeps the browser-local wording honest for a deployment that has no server storage', () => {
    // SUP-179 has not answered whether a tenant PVC survives a node reboot, so
    // the browser-local copy must not describe storage inside the boundary.
    const local = HISTORY_COPY.browser_local;

    expect(local.summary).toMatch(/this browser/i);
    expect(`${local.summary} ${local.detail}`).not.toMatch(/encrypted at rest|attested boundary|retention/i);
  });

  it('carries no maintenance caveat where maintenance cannot take anything', () => {
    // Browser-local history was never on the deployment, so the sentence would be
    // a borrowed worry — and a caveat that is always on is one nobody reads.
    expect(HISTORY_COPY.browser_local.maintenanceCaveat).toBeNull();
  });

  it('says plainly that the messages themselves still reach the model', () => {
    // Local history must not be allowed to read as "nothing leaves the browser".
    expect(HISTORY_COPY.browser_local.transport).toMatch(/do travel to the model/i);
    expect(HISTORY_COPY.browser_local.transport).toMatch(/no content/i);
  });
});
