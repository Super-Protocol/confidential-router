import type { BundleSource, GateResult } from './evidence-gate';
import type { BridgeOutcome } from './extension-bridge';

/**
 * Every claim the chat screen makes about verification, in one file.
 *
 * The rule the whole feature turns on: a stronger word may only appear when a
 * stronger thing actually happened. Three tiers, three different things, and the
 * labels must never blur —
 *
 *  1. **this page** checked the evidence with code the deployment served it. Real
 *     cryptography, honestly weak provenance: a compromised deployment could have
 *     shipped a verifier that lies. Hence "verified by this page" and never
 *     "verified".
 *  2. **the extension** checked it with code the browser pinned from the web
 *     store, fetching the evidence itself. Independent of the deployment, so
 *     "independently verified by the extension".
 *  3. **your gatekeeper** checks it on your own machine, sees the live TLS
 *     certificate rather than a published copy of it, and rebuilds the VM launch
 *     measurement from Super Protocol's signed artefacts. It is the only tier
 *     that is complete, which is why it is offered on every screen and is what
 *     production traffic is told to use.
 *
 * ADR-002 forbids the *router* from asserting a verdict, and nothing here breaks
 * that: each of these is the viewer's own agent reporting what it did, and the
 * router never learns the answer.
 */

export type TierId = 'page' | 'extension' | 'gatekeeper';

export type TierState = 'pending' | 'pass' | 'fail' | 'unavailable';

export interface TierPresentation {
  id: TierId;
  /** Short badge text. */
  label: string;
  /** The one-line caveat that must sit beside the label wherever it appears. */
  caveat: string;
  /** `Badge` variant carrying the tone. */
  variant: 'success' | 'warning' | 'secondary' | 'destructive';
}

/** Tier 1, by outcome. */
export const PAGE_TIER: Record<Exclude<TierState, 'unavailable'>, TierPresentation> = {
  pending: {
    id: 'page',
    label: 'Checking this endpoint',
    caveat: 'Fetching the endpoint’s signed evidence and checking it here in your browser.',
    variant: 'secondary',
  },
  pass: {
    id: 'page',
    label: 'Verified by this page',
    /*
     * "…for a stronger answer" is not enough here, and saying only that was the
     * defect: a reader is entitled to know that the stronger answer can be *no*.
     * Tier 1 does not include the root check, so an endpoint this badge unlocks is
     * an endpoint Gatekeeper may refuse — which is exactly what the live platform
     * did (SUP-185). The badge has to carry that, not just the panel.
     */
    caveat:
      'This page checked the endpoint’s signed evidence itself — but the page came from the same deployment, so this is self-reported, and it does not include the check that decides whether Super Protocol vouches for the VM behind this endpoint. Gatekeeper makes that one, and can refuse an endpoint this page unlocked.',
    variant: 'warning',
  },
  fail: {
    id: 'page',
    label: 'Evidence did not check out',
    caveat:
      'The endpoint’s evidence failed a check this page can make, so the composer stays locked. Nothing is sent to a deployment whose evidence does not verify.',
    variant: 'destructive',
  },
};

/** Tier 2, by outcome. `unavailable` is "no extension", which is not a failure. */
export const EXTENSION_TIER: Record<TierState, TierPresentation> = {
  pending: {
    id: 'extension',
    label: 'Asking the extension',
    caveat: 'Waiting for the Super Protocol extension to verify this endpoint independently.',
    variant: 'secondary',
  },
  pass: {
    id: 'extension',
    label: 'Independently verified by the extension',
    caveat:
      'The Super Protocol extension fetched and verified this endpoint’s evidence itself, with code this deployment did not serve.',
    variant: 'success',
  },
  fail: {
    id: 'extension',
    label: 'The extension refused this endpoint',
    caveat:
      'The extension verified independently and did not accept this endpoint. Trust its answer over this page’s: it is the one the deployment cannot influence.',
    variant: 'destructive',
  },
  unavailable: {
    id: 'extension',
    label: 'No extension detected',
    caveat: 'Install the Super Protocol extension for a verification this deployment cannot influence.',
    variant: 'secondary',
  },
};

export const GATEKEEPER_TIER: TierPresentation = {
  id: 'gatekeeper',
  label: 'Verify it yourself',
  caveat:
    'Gatekeeper runs on your machine, compares the live TLS certificate it observes with the one the evidence signs, and rebuilds the VM measurement from Super Protocol’s signed artefacts. It is the only complete check, and the one production traffic should go through.',
  variant: 'secondary',
};

/**
 * Which tier the badge shows.
 *
 * The strongest tier that actually concluded something wins, and a refusal
 * outranks a pass: if the extension says no while the page says yes, the badge
 * says no, because the extension is the less credulous of the two.
 */
export function badgeTier(page: TierState, extension: TierState): TierPresentation {
  if (extension === 'fail') return EXTENSION_TIER.fail;
  if (page === 'fail') return PAGE_TIER.fail;
  if (extension === 'pass') return EXTENSION_TIER.pass;
  if (page === 'pending' || extension === 'pending') return PAGE_TIER.pending;
  if (page === 'pass') return PAGE_TIER.pass;
  return PAGE_TIER.pending;
}

export function pageTierState(gate: GateResult | null): TierState {
  if (!gate) return 'pending';
  return gate.unlocked ? 'pass' : 'fail';
}

export function extensionTierState(outcome: BridgeOutcome | null): TierState {
  if (!outcome) return 'pending';
  if (outcome.status === 'absent') return 'unavailable';
  return outcome.status === 'verified' ? 'pass' : 'fail';
}

/** How each check reads in the verification panel's list. */
export const CHECK_LABELS = {
  webcrypto: 'Web Crypto available in this page',
  bundle: 'Signed evidence retrieved',
  chain: 'Certificate chain',
  signature: 'Evidence signature',
  freshness: 'Freshness',
  binding: 'TLS certificate binding',
  root: 'Root vouched for by Super Protocol',
} as const;

/**
 * Why the composer is shut, in the words of the check that shut it.
 *
 * The first failing check's own `detail` rather than one generic sentence: "the
 * evidence did not check out" is true of an expired certificate and misleading
 * of a page that has no Web Crypto to check with. The user is about to press
 * send, so this is the moment the distinction is worth most.
 */
export function lockedReasonOf(gate: GateResult | null): string {
  if (!gate) return PAGE_TIER.pending.caveat;
  const failed = gate.checks.find((check) => check.status === 'fail');
  return failed ? failed.detail : PAGE_TIER.pending.caveat;
}

/**
 * The warning that belongs beside tier 3's quick-start when tier 1 left the root
 * question open.
 *
 * The panel hands over four commands with the digest already substituted, so a
 * reader runs them expecting to confirm what the screen just said. When the root
 * row is anything but a pass, Gatekeeper is applying a check this page could not,
 * and `exit 3` is a live possibility — on the demo cloud today it is the actual
 * outcome. A quick-start that can end in a refusal has to say so before it is
 * copied, or the screen is letting the reader discover a contradiction it already
 * knew about.
 *
 * Null when the root row passed, or before tier 1 has finished: there is nothing
 * to warn about, and a warning that is always on is one nobody reads.
 */
export function gatekeeperDivergenceNote(gate: GateResult | null): string | null {
  const root = gate?.checks.find((check) => check.id === 'root');
  if (!root || root.status === 'pass') return null;
  return root.status === 'fail'
    ? 'Expect Gatekeeper to refuse this endpoint. This page already found the root check failing, and Gatekeeper enforces it — its answer is the authoritative one.'
    : 'These commands may end in a refusal rather than a confirmation. Gatekeeper rebuilds the VM measurement and checks it against Super Protocol’s registry — the one check above that this page could not complete — so it can deny an endpoint this page unlocked. Its answer is the authoritative one either way.';
}

/** Where the bundle came from, said plainly. */
export function bundleSourceNote(source: BundleSource): string {
  return source === 'endpoint'
    ? 'Fetched directly from the endpoint, the same document Gatekeeper reads.'
    : 'The endpoint would not serve this page a cross-origin request, so the bundle came from this router’s public passthrough. The signature was still checked here — but it may be older than what the endpoint serves right now.';
}

/**
 * Where the conversation is kept, in the words the deployment's own answer
 * justifies.
 *
 * The console asks the API (`chatSettings.historyStorage`) rather than deciding
 * for itself, so the screen cannot promise storage the deployment does not have.
 *
 * Three things are true of `attested_server` and each is still said: the
 * transcript is inside the boundary, it is encrypted at rest, and it may be lost
 * during infrastructure maintenance. What changed in SUP-189 is *where* each is
 * said. `summary` is the affirmative half and the only part rendered inline
 * under the composer; everything that qualifies it — including
 * `maintenanceCaveat` — lives in the popover behind it. The caveat was inline,
 * which turned the product's main demo surface into a warning banner; it is no
 * less honest one click away, and it is the reader who asks "what does that
 * mean?" who needs it.
 */
export interface HistoryCopy {
  /** The affirmative half. Inline under the composer, and nothing else is. */
  summary: string;
  /** Popover: where a thread actually lives, and what deleting one does. */
  detail: string;
  /** Popover: the message still reaches the model, metered and billed as ever. */
  transport: string;
  /**
   * Popover: the durability caveat, or `null` when the storage has none worth
   * one. Quoted verbatim from the privacy policy's §5a ("What we cannot promise:
   * that it survives") so the console and the published policy say the same
   * sentence rather than two paraphrases a reader has to reconcile.
   */
  maintenanceCaveat: string | null;
}

export const HISTORY_COPY: Record<string, HistoryCopy> = {
  attested_server: {
    summary: 'Stored inside the attested boundary',
    detail:
      'Threads are stored on the deployment’s own state, which sits inside the enclave and is encrypted at rest: the host sees ciphertext and the key never leaves the boundary. Only you can read your conversations, and a thread you delete is deleted outright — no archive, no copy to ask us for.',
    transport:
      'The messages themselves travel to the model over the same /v1/chat/completions path an API client uses, which records tokens and cost and no content at all.',
    /*
     * TODO(SUP-183): delete this sentence when replicated PostgreSQL ships.
     *
     * It is true only because the state disk is ephemeral by design and the
     * durability work was deferred with the risk accepted (Denis, 2026-09-30).
     * SUP-183 removes the reason for it, and the release train that ships it
     * deletes the sentence in two places at once: here, and the landing repo's
     * `src/content/legal.ts` (`consoleChat.maintenanceRisk`), which is what
     * /privacy §5a renders. One of the two surviving the other is how a policy
     * and a product start contradicting each other.
     */
    maintenanceCaveat: 'Your conversations may be lost during infrastructure maintenance.',
  },
  browser_local: {
    summary: 'This conversation is stored in this browser only.',
    detail:
      'Threads live in this browser’s local storage and are never sent to the router. Deleting a thread removes it here and there is nothing to delete anywhere else. Clearing site data, or opening the console in another browser, loses the history.',
    transport:
      'The messages themselves do travel to the model — over the same /v1/chat/completions path an API client uses, which records tokens and cost and no content at all.',
    /* Nothing maintenance can take: the history was never on the deployment. */
    maintenanceCaveat: null,
  },
};
