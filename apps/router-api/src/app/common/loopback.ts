/**
 * Whether a URL names an address only the machine running this process can reach.
 *
 * It exists for one decision: the manual payment provider mints credit from a
 * signed link, so it may bind on a developer's laptop and nowhere else (SUP-167).
 * `NODE_ENV` used to be that test, and a deployment chart can set `NODE_ENV` —
 * `server.publicBaseUrl` is the address the service actually publishes, so a
 * deployment cannot claim to be local while answering the internet.
 *
 * Anything unparseable is treated as public: a value nobody can make sense of is
 * not evidence that only a laptop can reach it.
 */
export function isLoopbackUrl(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return isLoopbackHostname(hostname);
}

/** `localhost`, anything under it, the whole of `127.0.0.0/8`, and `::1`. */
export function isLoopbackHostname(hostname: string): boolean {
  // `new URL('http://[::1]:3000').hostname` keeps the brackets.
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/]$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') {
    return true;
  }
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
