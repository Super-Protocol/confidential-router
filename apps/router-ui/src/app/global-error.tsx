'use client';

/**
 * Catches failures in the root layout itself, which is the one case the route
 * boundary cannot handle. It replaces <html>, so it can rely on neither the
 * providers nor the stylesheet — hence the inline styles.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ background: '#0a0a0a', color: '#fafafa', fontFamily: 'system-ui, sans-serif' }}>
        <main style={{ margin: '0 auto', maxWidth: '32rem', padding: '4rem 1.5rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.125rem', fontWeight: 600 }}>The console failed to start</h1>
          <p style={{ color: '#a1a1a1', fontSize: '0.875rem' }}>
            {error.digest ? `Reference: ${error.digest}` : 'Reloading usually helps.'}
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '1rem',
              padding: '0.5rem 1rem',
              borderRadius: '0.5rem',
              border: '1px solid #404040',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
