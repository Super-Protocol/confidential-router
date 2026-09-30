/**
 * Tier 2: ask the Super Protocol browser extension to verify the endpoint, on its
 * own, and report what it concluded.
 *
 * Why a second opinion is worth anything: tier 1 runs inside a page the
 * deployment served. The code doing the checking arrived from the thing being
 * checked, so a compromised deployment could ship a verifier that always says
 * yes. The extension's code did not come from the deployment — it came from the
 * web store and is pinned by the browser — and it fetches the evidence itself.
 * That is the whole of the upgrade, and it is why the badge may only say
 * "independently verified" in this tier.
 *
 * The protocol is deliberately tiny and versioned, because the two halves ship
 * from different repositories on different clocks: the extension lives in
 * swarm-cloud (`apps/swarm-chrome-extension`) and its side of this handshake is a
 * separate change there. Everything here is feature-detected — a browser with no
 * extension gets a quiet invitation to install one, never an error, and never a
 * blocked composer.
 */

/** Bumped only for a breaking change; the extension answers the version it was asked. */
export const BRIDGE_VERSION = 1;

export const PAGE_SOURCE = 'swarm-router-console';
export const EXTENSION_SOURCE = 'swarm-extension';

/** How long to wait before concluding that nothing is listening. */
export const HANDSHAKE_TIMEOUT_MS = 2_500;

export interface VerifyRequest {
  source: typeof PAGE_SOURCE;
  version: number;
  type: 'verify-request';
  /** Correlates the answer; a tab may have several endpoints in flight. */
  id: string;
  hostname: string;
}

export interface ExtensionVerdict {
  ok: boolean;
  /** The verifier stage that failed, when it failed. */
  stage?: string;
  reason?: string;
  /** The trusted root the extension matched, from its own store. */
  rootName?: string;
  channelBinding?: 'observed' | 'producer-asserted';
  extensionVersion?: string;
}

export type BridgeOutcome =
  | { status: 'absent' }
  | { status: 'verified'; verdict: ExtensionVerdict }
  | { status: 'refused'; verdict: ExtensionVerdict };

export interface BridgeOptions {
  hostname: string;
  timeoutMs?: number;
  /** Injected in tests; defaults to the page's own window. */
  target?: Pick<Window, 'postMessage' | 'addEventListener' | 'removeEventListener'>;
}

/**
 * Sends one `verify-request` and resolves with whatever came back.
 *
 * Never rejects: "the extension is not installed" is the common case, not an
 * error, and the caller distinguishes it from a refusal because only one of the
 * two is a statement about the endpoint.
 */
export function requestExtensionVerification(options: BridgeOptions): Promise<BridgeOutcome> {
  const target = options.target ?? (typeof window === 'undefined' ? undefined : window);
  if (!target) {
    return Promise.resolve({ status: 'absent' });
  }

  const id = requestId();
  const request: VerifyRequest = {
    source: PAGE_SOURCE,
    version: BRIDGE_VERSION,
    type: 'verify-request',
    id,
    hostname: options.hostname,
  };

  return new Promise<BridgeOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: BridgeOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      target.removeEventListener('message', onMessage as EventListener);
      resolve(outcome);
    };

    const onMessage = (event: MessageEvent): void => {
      const verdict = verdictOf(event, id);
      if (!verdict) return;
      finish({ status: verdict.ok ? 'verified' : 'refused', verdict });
    };

    const timer = setTimeout(() => finish({ status: 'absent' }), options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS);
    target.addEventListener('message', onMessage as EventListener);
    // `postMessage` to our own window: a content script listens in the same
    // window, which is the only channel a page and an extension share without
    // the page having to know the extension's id.
    target.postMessage(request, '*');
  });
}

/**
 * Reads an answer, or returns null for anything that is not one.
 *
 * `event.source === target` is the check that matters: any page on the internet
 * can post into this window, so an answer is only accepted from this window
 * itself — which is where a content script posts from. The correlation id then
 * rejects a reply to somebody else's question.
 */
export function verdictOf(event: MessageEvent, expectedId: string): ExtensionVerdict | null {
  const data = event.data as Record<string, unknown> | null | undefined;
  if (!data || typeof data !== 'object') return null;
  if (data.source !== EXTENSION_SOURCE) return null;
  if (data.type !== 'verify-result') return null;
  if (data.version !== BRIDGE_VERSION) return null;
  if (data.id !== expectedId) return null;
  if (typeof data.ok !== 'boolean') return null;

  return {
    ok: data.ok,
    stage: typeof data.stage === 'string' ? data.stage : undefined,
    reason: typeof data.reason === 'string' ? data.reason : undefined,
    rootName: typeof data.rootName === 'string' ? data.rootName : undefined,
    channelBinding:
      data.channelBinding === 'observed' || data.channelBinding === 'producer-asserted'
        ? data.channelBinding
        : undefined,
    extensionVersion: typeof data.extensionVersion === 'string' ? data.extensionVersion : undefined,
  };
}

function requestId(): string {
  // `randomUUID` is unavailable on an insecure origin, which a developer's
  // `http://localhost` console is. The id only has to be unique within one tab.
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
