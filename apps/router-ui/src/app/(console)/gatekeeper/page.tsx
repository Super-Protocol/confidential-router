import { permanentRedirect } from 'next/navigation';

/**
 * The Gatekeeper screen folded into "How to connect" on the API Keys page
 * (SUP-255). The route stays as a redirect so a bookmark, an old landing-page
 * link or a support answer that names it still lands somewhere useful.
 */
export default function GatekeeperPage() {
  permanentRedirect('/keys#how-to-connect');
}
