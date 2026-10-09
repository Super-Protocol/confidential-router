import '@confidential-router/ui/styles/globals.css';

import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { Providers } from '../components/providers';
import { publicConfigScript, readPublicConfig } from '../lib/public-config';

const fontSans = Geist({ subsets: ['latin'], variable: '--font-geist-sans', display: 'swap' });
const fontMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono', display: 'swap' });

export const metadata: Metadata = {
  title: {
    default: 'Confidential Router',
    template: '%s · Confidential Router',
  },
  description:
    'An OpenAI-compatible LLM router where every model runs inside a TEE and publishes signed attestation evidence.',
};

/**
 * The console's public configuration is read from the environment on every
 * request and written into the document below, so one image serves any API
 * origin (SUP-100). A prerendered layout would bake in whatever the *build*
 * host had, which is the binding this replaced.
 */
export const dynamic = 'force-dynamic';

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: 'oklch(0.145 0 0)' },
    { media: '(prefers-color-scheme: light)', color: 'oklch(1 0 0)' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const config = publicConfigScript(readPublicConfig());

  return (
    // `className="dark"` makes dark the pre-hydration default; next-themes then
    // takes over. `suppressHydrationWarning` is required because next-themes
    // rewrites this attribute before React hydrates.
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: the deployment's own configuration, escaped by publicConfigScript, and it has to run before anything reads it */}
        <script dangerouslySetInnerHTML={{ __html: config }} />
      </head>
      <body className={`${fontSans.variable} ${fontMono.variable} font-sans antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
