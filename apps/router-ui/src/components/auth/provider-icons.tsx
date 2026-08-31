import type * as React from 'react';

/**
 * GitHub and Google marks. Inlined rather than pulled from an icon pack: both
 * are trademarks with brand guidelines, and the official paths must not be
 * restyled or approximated.
 */
export function GitHubIcon(props: React.ComponentProps<'svg'>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 .5a11.5 11.5 0 0 0-3.63 22.42c.57.1.78-.25.78-.55v-2.13c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.64 1.59.24 2.76.12 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.7 5.4-5.27 5.69.41.36.78 1.07.78 2.15v3.19c0 .3.2.66.79.55A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

export function GoogleIcon(props: React.ComponentProps<'svg'>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path
        fill="#4285F4"
        d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.63h6.45a5.5 5.5 0 0 1-2.39 3.61v3h3.86c2.26-2.08 3.58-5.15 3.58-8.79Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.08 7.94-2.91l-3.86-3a7.2 7.2 0 0 1-4.08 1.16 7.14 7.14 0 0 1-6.71-4.94H1.3v3.1A12 12 0 0 0 12 24Z"
      />
      <path fill="#FBBC05" d="M5.29 14.31a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8l4-3.1Z" />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.6 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.3 6.6l4 3.11A7.14 7.14 0 0 1 12 4.75Z"
      />
    </svg>
  );
}
