import { LOGO_HEIGHT, LOGO_IMAGE, LOGO_WIDTH } from './logo.js';
import type { InlineImage } from './mail-transport.js';

/** A message before it has a recipient: what every template produces. */
export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
  inlineImages: InlineImage[];
}

/**
 * The body of a message, as blocks rather than markup, so the HTML part and the
 * plain-text part are two renderings of one thing and cannot say different
 * things.
 */
type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'button'; label: string; url: string }
  | { kind: 'facts'; rows: Array<[label: string, value: string]> }
  /** The raw URL under a button, for a client that strips buttons or a reader who will not click one. */
  | { kind: 'fallback-link'; url: string }
  | { kind: 'note'; text: string };

interface Layout {
  subject: string;
  /** The inbox preview line. Hidden in the body. */
  preheader: string;
  heading: string;
  blocks: Block[];
  /** Origin of the console, named in the footer so the reader knows which deployment wrote. */
  consoleUrl: string;
}

/**
 * Colours, inline for the light rendering and in a `prefers-color-scheme`
 * block for the dark one. Inline because most clients drop `<style>` or parts
 * of it; the dark block is an enhancement for the clients that honour it
 * (Apple Mail, iOS, Outlook.com), and the rest either keep the light rendering
 * or invert it themselves — which the logo survives because its badge is
 * part of the image.
 *
 * The values are the console's own tokens (`libs/ui/src/styles/globals.css`)
 * resolved to hex, since email clients do not parse `oklch()`.
 */
const LIGHT = {
  page: '#f5f5f5',
  card: '#ffffff',
  border: '#e5e5e5',
  text: '#171717',
  muted: '#737373',
  button: '#1e49b7',
  buttonText: '#ffffff',
  link: '#1e49b7',
};

const DARK = {
  page: '#0a0a0a',
  card: '#171717',
  border: '#262626',
  text: '#fafafa',
  muted: '#a3a3a3',
  button: '#497ef7',
  buttonText: '#0a0a0a',
  link: '#9cc3ff',
};

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function blockHtml(block: Block): string {
  switch (block.kind) {
    case 'paragraph':
      return `<p class="cr-text" style="margin:0 0 16px;font-size:15px;line-height:24px;color:${LIGHT.text};">${escapeHtml(block.text)}</p>`;
    case 'note':
      return `<p class="cr-muted" style="margin:24px 0 0;font-size:13px;line-height:20px;color:${LIGHT.muted};">${escapeHtml(block.text)}</p>`;
    case 'button':
      // A table cell carries the colour, not the anchor: Outlook for Windows
      // ignores padding and background on `<a>`.
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;"><tr><td class="cr-button" bgcolor="${LIGHT.button}" style="border-radius:8px;background-color:${LIGHT.button};"><a class="cr-button-link" href="${escapeHtml(block.url)}" target="_blank" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:15px;font-weight:600;line-height:20px;color:${LIGHT.buttonText};text-decoration:none;border-radius:8px;">${escapeHtml(block.label)}</a></td></tr></table>`;
    case 'fallback-link':
      return `<p class="cr-muted" style="margin:0 0 16px;font-size:13px;line-height:20px;color:${LIGHT.muted};">Or paste this link into your browser:<br><a class="cr-link" href="${escapeHtml(block.url)}" target="_blank" style="color:${LIGHT.link};word-break:break-all;">${escapeHtml(block.url)}</a></p>`;
    case 'facts':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 24px;border-collapse:collapse;">${block.rows
        .map(
          ([label, value]) =>
            `<tr><td class="cr-muted cr-border" style="padding:10px 0;border-top:1px solid ${LIGHT.border};font-size:13px;color:${LIGHT.muted};width:40%;">${escapeHtml(label)}</td><td class="cr-text cr-border" style="padding:10px 0;border-top:1px solid ${LIGHT.border};font-size:14px;font-weight:600;color:${LIGHT.text};">${escapeHtml(value)}</td></tr>`,
        )
        .join('')}</table>`;
    default:
      return '';
  }
}

function blockText(block: Block): string {
  switch (block.kind) {
    case 'paragraph':
    case 'note':
      return block.text;
    case 'button':
      return `${block.label}: ${block.url}`;
    case 'fallback-link':
      // The button line already carries the URL in plain text.
      return '';
    case 'facts':
      return block.rows.map(([label, value]) => `${label}: ${value}`).join('\n');
    default:
      return '';
  }
}

const DARK_CSS = `
:root { color-scheme: light dark; supported-color-schemes: light dark; }
@media (prefers-color-scheme: dark) {
  .cr-page { background-color: ${DARK.page} !important; }
  .cr-card { background-color: ${DARK.card} !important; border-color: ${DARK.border} !important; }
  .cr-text, .cr-heading { color: ${DARK.text} !important; }
  .cr-muted { color: ${DARK.muted} !important; }
  .cr-border { border-color: ${DARK.border} !important; }
  .cr-button { background-color: ${DARK.button} !important; }
  .cr-button-link { color: ${DARK.buttonText} !important; }
  .cr-link { color: ${DARK.link} !important; }
}
/* Outlook.com's own dark mode */
[data-ogsc] .cr-text, [data-ogsc] .cr-heading { color: ${DARK.text} !important; }
[data-ogsc] .cr-muted { color: ${DARK.muted} !important; }
[data-ogsb] .cr-page { background-color: ${DARK.page} !important; }
[data-ogsb] .cr-card { background-color: ${DARK.card} !important; }
`;

function render(layout: Layout): RenderedMail {
  const host = hostOf(layout.consoleUrl);
  const footer = `Sent by Confidential Router at ${host}, a Super Protocol deployment.`;

  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(layout.subject)}</title>
<style>${DARK_CSS}</style>
</head>
<body class="cr-page" style="margin:0;padding:0;background-color:${LIGHT.page};font-family:${FONT};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(layout.preheader)}</div>
<table role="presentation" class="cr-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${LIGHT.page}" style="background-color:${LIGHT.page};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
<tr><td style="padding:0 0 24px;"><img src="cid:${LOGO_IMAGE.contentId}" width="${LOGO_WIDTH / 2}" height="${LOGO_HEIGHT / 2}" alt="Super Protocol" style="display:block;border:0;outline:none;width:${LOGO_WIDTH / 2}px;height:${LOGO_HEIGHT / 2}px;"></td></tr>
<tr><td class="cr-card" bgcolor="${LIGHT.card}" style="background-color:${LIGHT.card};border:1px solid ${LIGHT.border};border-radius:12px;padding:32px;font-family:${FONT};">
<h1 class="cr-heading" style="margin:0 0 16px;font-size:22px;line-height:30px;font-weight:700;color:${LIGHT.text};">${escapeHtml(layout.heading)}</h1>
${layout.blocks.map(blockHtml).join('\n')}
</td></tr>
<tr><td class="cr-muted" style="padding:24px 8px 0;font-size:12px;line-height:18px;color:${LIGHT.muted};text-align:center;">${escapeHtml(footer)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;

  const text = `${[layout.heading, ...layout.blocks.map(blockText)].filter((part) => part.length > 0).join('\n\n')}\n\n--\n${footer}\n`;

  return { subject: layout.subject, html, text, inlineImages: [LOGO_IMAGE] };
}

export interface MagicLinkMail {
  url: string;
  consoleUrl: string;
}

/** The one-time sign-in link (ADR-004), formerly a bare text mail. */
export function renderMagicLinkMail({ url, consoleUrl }: MagicLinkMail): RenderedMail {
  return render({
    subject: 'Sign in to Confidential Router',
    preheader: 'Your one-time sign-in link. It expires shortly.',
    heading: 'Sign in to Confidential Router',
    consoleUrl,
    blocks: [
      { kind: 'paragraph', text: 'Use the button below to sign in. The link works once and expires shortly.' },
      { kind: 'button', label: 'Sign in', url },
      { kind: 'fallback-link', url },
      {
        kind: 'note',
        text: 'If you did not ask to sign in, ignore this email — nobody can use it without this inbox.',
      },
    ],
  });
}

export interface PasswordResetMail {
  url: string;
  consoleUrl: string;
  /** Rendered as "expires in N minutes". */
  ttlMinutes: number;
}

export function renderPasswordResetMail({ url, consoleUrl, ttlMinutes }: PasswordResetMail): RenderedMail {
  const expiry =
    ttlMinutes % 60 === 0 && ttlMinutes >= 60 ? plural(ttlMinutes / 60, 'hour') : plural(ttlMinutes, 'minute');
  return render({
    subject: 'Reset your Confidential Router password',
    preheader: `Choose a new password. The link expires in ${expiry}.`,
    heading: 'Reset your password',
    consoleUrl,
    blocks: [
      {
        kind: 'paragraph',
        text: `Someone asked to reset the password for this address on ${hostOf(consoleUrl)}. Choose a new one with the button below. The link works once and expires in ${expiry}.`,
      },
      { kind: 'button', label: 'Choose a new password', url },
      { kind: 'fallback-link', url },
      {
        kind: 'note',
        text: 'Resetting signs you out everywhere else. If you did not ask for this, ignore this email — your password stays as it is.',
      },
    ],
  });
}

export interface WelcomeMail {
  name?: string | null;
  consoleUrl: string;
  /** Credit the account started with, in micro-USD; omitted from the mail when zero. */
  startingCreditMicros: number;
}

export function renderWelcomeMail({ name, consoleUrl, startingCreditMicros }: WelcomeMail): RenderedMail {
  const trimmed = name?.trim();
  const facts: Array<[string, string]> = [['Console', consoleUrl]];
  if (startingCreditMicros > 0) {
    facts.push(['Starting credit', formatUsd(startingCreditMicros)]);
  }
  return render({
    subject: 'Welcome to Confidential Router',
    preheader: 'Your account is ready.',
    heading: trimmed ? `Welcome, ${trimmed}` : 'Welcome to Confidential Router',
    consoleUrl,
    blocks: [
      {
        kind: 'paragraph',
        text: 'Your account is ready. Confidential Router is an OpenAI-compatible API whose models run inside attested confidential computing — every response can be traced back to the hardware and software that produced it.',
      },
      { kind: 'facts', rows: facts },
      {
        kind: 'paragraph',
        text: 'Create an API key in the console to start making requests, or try a model in the chat.',
      },
      { kind: 'button', label: 'Open the console', url: consoleUrl },
      {
        kind: 'note',
        text: 'You are receiving this because an account was created with this address. If that was not you, ignore this email.',
      },
    ],
  });
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/** `$20`, `$12.50` — whole dollars without cents, the way the console shows a grant. */
export function formatUsd(micros: number): string {
  const dollars = micros / 1_000_000;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}
