import { describe, expect, it } from 'vitest';
import { LOGO_IMAGE } from './logo.js';
import { formatUsd, renderMagicLinkMail, renderPasswordResetMail, renderWelcomeMail } from './templates.js';

const CONSOLE = 'https://console.example.com';
const RESET_URL = `${CONSOLE}/reset-password?token=abc123`;

/**
 * The rendered HTML is pinned as files, so a change to the layout is a reviewed
 * diff of the markup every mail client receives — and the same files are what
 * the PR's light and dark screenshots are taken from.
 */
describe('mail templates', () => {
  it('renders the welcome mail', async () => {
    const mail = renderWelcomeMail({ name: 'Ada', consoleUrl: CONSOLE, startingCreditMicros: 20_000_000 });

    expect(mail.subject).toBe('Welcome to Confidential Router');
    await expect(mail.html).toMatchFileSnapshot('__snapshots__/welcome.html');
    await expect(mail.text).toMatchFileSnapshot('__snapshots__/welcome.txt');
  });

  it('renders the password reset mail', async () => {
    const mail = renderPasswordResetMail({ url: RESET_URL, consoleUrl: CONSOLE, ttlMinutes: 60 });

    expect(mail.subject).toBe('Reset your Confidential Router password');
    await expect(mail.html).toMatchFileSnapshot('__snapshots__/password-reset.html');
    await expect(mail.text).toMatchFileSnapshot('__snapshots__/password-reset.txt');
  });

  it('renders the magic link mail', async () => {
    const mail = renderMagicLinkMail({
      url: 'https://api.example.com/auth/magic-link/verify?token=t',
      consoleUrl: CONSOLE,
    });

    await expect(mail.html).toMatchFileSnapshot('__snapshots__/magic-link.html');
  });

  it('embeds the logo by cid and attaches it, so it shows without remote images', () => {
    const mail = renderWelcomeMail({ consoleUrl: CONSOLE, startingCreditMicros: 0 });

    expect(mail.html).toContain(`src="cid:${LOGO_IMAGE.contentId}"`);
    expect(mail.inlineImages).toEqual([LOGO_IMAGE]);
    expect(Buffer.from(LOGO_IMAGE.content, 'base64').subarray(1, 4).toString()).toBe('PNG');
  });

  it('is dark-mode aware and keeps every style the light rendering needs inline', () => {
    const { html } = renderPasswordResetMail({ url: RESET_URL, consoleUrl: CONSOLE, ttlMinutes: 30 });

    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    // The button's colour sits on the table cell as both an attribute and an
    // inline style: Outlook for Windows reads the one, everything else the other.
    expect(html).toContain('bgcolor="#1e49b7" style="border-radius:8px;background-color:#1e49b7;"');
  });

  it('always has a plain-text part carrying the link', () => {
    const { text } = renderPasswordResetMail({ url: RESET_URL, consoleUrl: CONSOLE, ttlMinutes: 30 });

    expect(text).toContain(RESET_URL);
    expect(text).toContain('expires in 30 minutes');
    expect(text).not.toMatch(/<[a-z]/i);
  });

  it('names the starting credit only when there is some', () => {
    expect(renderWelcomeMail({ consoleUrl: CONSOLE, startingCreditMicros: 120_000_000 }).text).toContain(
      'Starting credit: $120',
    );
    expect(renderWelcomeMail({ consoleUrl: CONSOLE, startingCreditMicros: 0 }).text).not.toContain('Starting credit');
  });

  it('escapes everything it interpolates', () => {
    const { html } = renderWelcomeMail({
      name: '<script>alert(1)</script>',
      consoleUrl: CONSOLE,
      startingCreditMicros: 0,
    });

    expect(html).not.toContain('<script>');
    expect(html).toContain('Welcome, &lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('formatUsd', () => {
  it('drops cents from whole dollars', () => {
    expect(formatUsd(20_000_000)).toBe('$20');
    expect(formatUsd(12_500_000)).toBe('$12.50');
  });
});
