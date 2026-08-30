import '@confidential-router/ui/styles/globals.css';

import { accentScript } from '@confidential-router/ui/components/theme-provider';
import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { Providers } from '../components/providers';

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

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: 'oklch(0.145 0 0)' },
    { media: '(prefers-color-scheme: light)', color: 'oklch(1 0 0)' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `className="dark"` makes dark the pre-hydration default; next-themes then
    // takes over. `suppressHydrationWarning` is required because next-themes
    // rewrites this attribute before React hydrates.
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a static, self-authored blocking script is the only way to set the accent before first paint */}
        <script dangerouslySetInnerHTML={{ __html: accentScript }} />
      </head>
      <body className={`${fontSans.variable} ${fontMono.variable} font-sans antialiased`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
