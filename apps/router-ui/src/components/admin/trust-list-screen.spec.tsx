import type { MockLink } from '@apollo/client/testing';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { isAdminMock, renderWithSession, sessionMock } from '../../test-utils';
import { MEASUREMENT_TRUSTED, measurementsMock, TRUSTED, TRUSTED_UNUSED } from './admin-mocks';
import { ADD_TRUSTED_MEASUREMENT, REMOVE_TRUSTED_MEASUREMENT } from './operations';
import { CLOUD_GRANULARITY_WARNING } from './trust-copy';
import { measurementError, normaliseMeasurement, TrustListScreen } from './trust-list-screen';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/trust',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

/**
 * The register form has ten fields to fill through `userEvent`, and three of
 * these tests await a mutation that awaits its own refetch. Raised only because
 * a loaded CI box is slower than the one-second default assumes; nothing here
 * depends on the extra time to pass.
 */
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 5_000 });

const FIELD = 'Cloud launch measurement (64 hex)';

function renderScreen({
  admin = true,
  mocks = [measurementsMock()],
}: {
  admin?: boolean;
  mocks?: MockLink.MockedResponse[];
} = {}) {
  return renderWithSession(<TrustListScreen />, {
    mocks: [sessionMock(), isAdminMock(admin), ...mocks],
  });
}

describe('normaliseMeasurement', () => {
  it('accepts what an operator actually pastes', () => {
    expect(normaliseMeasurement(`  0x${'A'.repeat(64)}\n`)).toBe('a'.repeat(64));
    expect(measurementError(`0X${'a'.repeat(64)}`)).toBeNull();
  });

  it('folds the `sha256:` spelling onto the bare hex the list stores, as router-api does', () => {
    // 71 characters in, 64 out — the gatekeeper and the verification report print this form.
    expect(normaliseMeasurement(`sha256:${'B'.repeat(64)}`)).toBe('b'.repeat(64));
    expect(measurementError(`SHA256:${'b'.repeat(64)}`)).toBeNull();
    expect(measurementError('c'.repeat(64))).toBeNull();
  });

  it('refuses anything that is not a 64-character hex value', () => {
    expect(measurementError('')).toBe('A launch measurement is required.');
    expect(measurementError('deadbeef')).toBe('A launch measurement is exactly 64 hex characters; this is 8.');
    expect(measurementError('a'.repeat(63))).toBe('A launch measurement is exactly 64 hex characters; this is 63.');
    expect(measurementError('z'.repeat(64))).toBe('A launch measurement is 64 hexadecimal characters (0–9, a–f).');
  });

  it('names an evidence digest or fingerprint in its canonical sha256/<base64url> form (SUP-251)', () => {
    expect(measurementError('sha256/BvG0Yy3Ir0QKPtC1TrSPuyZZD1sdKq7Gq_a1Mv1Hs0A')).toBe(
      'That is an evidence digest or certificate fingerprint (sha256/…), not a launch measurement.',
    );
  });

  it('names a raw SHA-384 TEE register rather than calling it the wrong length', () => {
    expect(measurementError('f'.repeat(96))).toMatch(/SHA-384 TEE register/);
  });
});

describe('TrustListScreen', () => {
  it('lists every measurement with its note, author and how many endpoints it admits', async () => {
    renderScreen();

    expect(await screen.findByText('Super Protocol production cloud')).toBeInTheDocument();
    expect(screen.getByText('admin@example.com')).toBeInTheDocument();
    expect(screen.getByText('2 endpoints')).toBeInTheDocument();
    expect(screen.getByText('0 endpoints')).toBeInTheDocument();
  });

  /**
   * The warning is a condition of decision 1, not decoration: threat T13 was
   * accepted on the basis that the UI says so wherever the list is edited.
   */
  describe('the cloud-granularity warning', () => {
    it('stands on the screen itself', async () => {
      renderScreen();

      const note = await screen.findByRole('note', { name: 'How measurement trust works' });
      expect(note).toHaveTextContent(CLOUD_GRANULARITY_WARNING);
      expect(note).toHaveTextContent(/admits a cloud, never a deployment/);
      expect(note).toHaveTextContent(/including one someone else deployed there/);
      expect(note).toHaveTextContent(/registry signature does not admit on its own/);
    });

    it('spells out that a removal is live and fail-closed, not a tidy-up', async () => {
      renderScreen();

      const note = await screen.findByRole('note', { name: 'How measurement trust works' });
      expect(note).toHaveTextContent(/takes effect on the next check/);
      expect(note).toHaveTextContent(/in-flight connections close/);
    });

    it('is repeated in the add dialog, so it is read at the moment of the decision', async () => {
      renderScreen();

      await userEvent.click(await screen.findByRole('button', { name: 'Trust a measurement' }));
      const dialog = await screen.findByRole('dialog');

      expect(within(dialog).getByRole('note', { name: 'How measurement trust works' })).toBeInTheDocument();
      expect(dialog).toHaveTextContent(CLOUD_GRANULARITY_WARNING);
    });
  });

  describe('admin gating', () => {
    it('gives a signed-in member the list and no way to change it', async () => {
      renderScreen({ admin: false });

      expect(await screen.findByText('Super Protocol production cloud')).toBeInTheDocument();
      expect(screen.getByTestId('admin-read-only-notice')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Trust a measurement' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Remove measurement/ })).not.toBeInTheDocument();
    });

    it('shows an administrator both controls', async () => {
      renderScreen({ admin: true });

      // The header button needs only the admin flag; the per-row one needs the
      // rows too, and the two queries land in no fixed order.
      await screen.findByText('Super Protocol production cloud');
      expect(await screen.findByRole('button', { name: 'Trust a measurement' })).toBeInTheDocument();
      expect(await screen.findAllByRole('button', { name: /^Remove measurement/ })).toHaveLength(2);
      expect(screen.queryByTestId('admin-read-only-notice')).not.toBeInTheDocument();
    });
  });

  describe('adding a measurement', () => {
    it('normalises the paste before sending it', async () => {
      renderScreen({
        mocks: [
          measurementsMock(),
          {
            request: {
              query: ADD_TRUSTED_MEASUREMENT,
              variables: { input: { measurement: MEASUREMENT_TRUSTED, note: 'Second cloud' } },
            },
            result: { data: { addTrustedMeasurement: { ...TRUSTED, id: 'tm-3', note: 'Second cloud' } } },
          } satisfies MockLink.MockedResponse,
        ],
      });

      await userEvent.click(await screen.findByRole('button', { name: 'Trust a measurement' }));
      // Upper case with a `0x` prefix is the form a verification report prints.
      await userEvent.type(await screen.findByLabelText(FIELD), `0x${'A'.repeat(64)}`);
      await userEvent.type(screen.getByLabelText('Note'), 'Second cloud');
      await userEvent.click(screen.getByRole('button', { name: 'Trust this measurement' }));

      // The dialog closes only on a mutation the mock matched — which is the
      // assertion that the normalised value was what went out.
      await waitFor(() => expect(screen.queryByLabelText(FIELD)).not.toBeInTheDocument());
    });

    it('sends no note rather than an empty one', async () => {
      renderScreen({
        mocks: [
          measurementsMock(),
          {
            request: {
              query: ADD_TRUSTED_MEASUREMENT,
              variables: { input: { measurement: 'd'.repeat(64), note: null } },
            },
            result: { data: { addTrustedMeasurement: { ...TRUSTED_UNUSED, id: 'tm-4' } } },
          } satisfies MockLink.MockedResponse,
        ],
      });

      await userEvent.click(await screen.findByRole('button', { name: 'Trust a measurement' }));
      await userEvent.type(await screen.findByLabelText(FIELD), 'd'.repeat(64));
      await userEvent.click(screen.getByRole('button', { name: 'Trust this measurement' }));

      await waitFor(() => expect(screen.queryByLabelText(FIELD)).not.toBeInTheDocument());
    });

    it('refuses a value that is not a measurement, next to the field', async () => {
      renderScreen();

      await userEvent.click(await screen.findByRole('button', { name: 'Trust a measurement' }));
      await userEvent.type(await screen.findByLabelText(FIELD), 'deadbeef');
      await userEvent.click(screen.getByRole('button', { name: 'Trust this measurement' }));

      expect(screen.getByRole('alert')).toHaveTextContent(
        'A launch measurement is exactly 64 hex characters; this is 8.',
      );
      expect(screen.getByLabelText(FIELD)).toHaveAttribute('aria-invalid', 'true');
    });

    it('says what the field wants and where to copy it from', async () => {
      renderScreen();

      await userEvent.click(await screen.findByRole('button', { name: 'Trust a measurement' }));
      const field = await screen.findByLabelText(FIELD);

      expect(field).toHaveAccessibleDescription(/copy it from an endpoint's “Measurement seen”/);
      expect(field).toHaveAccessibleDescription(/Not an evidence digest or a certificate fingerprint/);
    });

    it('names a pasted evidence digest when the field is left, and sends nothing', async () => {
      // No ADD mock: a mutation that went out would fail the test with an unmatched request.
      renderScreen();

      await userEvent.click(await screen.findByRole('button', { name: 'Trust a measurement' }));
      await userEvent.type(await screen.findByLabelText(FIELD), 'sha256/BvG0Yy3Ir0QKPtC1TrSPuyZZD1sdKq7Gq_a1Mv1Hs0A');
      await userEvent.tab();

      expect(screen.getByRole('alert')).toHaveTextContent(/evidence digest or certificate fingerprint/);
      await userEvent.click(screen.getByRole('button', { name: 'Trust this measurement' }));
      expect(screen.getByLabelText(FIELD)).toHaveAttribute('aria-invalid', 'true');
    });

    it('sends the bare hex for a `sha256:`-prefixed paste', async () => {
      renderScreen({
        mocks: [
          measurementsMock(),
          {
            request: {
              query: ADD_TRUSTED_MEASUREMENT,
              variables: { input: { measurement: 'd'.repeat(64), note: null } },
            },
            result: { data: { addTrustedMeasurement: { ...TRUSTED_UNUSED, id: 'tm-5' } } },
          } satisfies MockLink.MockedResponse,
        ],
      });

      await userEvent.click(await screen.findByRole('button', { name: 'Trust a measurement' }));
      await userEvent.type(await screen.findByLabelText(FIELD), `sha256:${'D'.repeat(64)}`);
      await userEvent.click(screen.getByRole('button', { name: 'Trust this measurement' }));

      await waitFor(() => expect(screen.queryByLabelText(FIELD)).not.toBeInTheDocument());
    });

    it('shows the server’s refusal rather than closing as though it worked', async () => {
      renderScreen({
        mocks: [
          measurementsMock(),
          {
            request: {
              query: ADD_TRUSTED_MEASUREMENT,
              variables: { input: { measurement: 'e'.repeat(64), note: null } },
            },
            result: { errors: [{ message: 'That measurement is already trusted.' }] },
          } satisfies MockLink.MockedResponse,
        ],
      });

      await userEvent.click(await screen.findByRole('button', { name: 'Trust a measurement' }));
      await userEvent.type(await screen.findByLabelText(FIELD), 'e'.repeat(64));
      await userEvent.click(screen.getByRole('button', { name: 'Trust this measurement' }));

      expect(await screen.findByText('That measurement is already trusted.')).toBeInTheDocument();
      expect(screen.getByLabelText(FIELD)).toBeInTheDocument();
    });
  });

  describe('removing a measurement', () => {
    it('names what the removal will drop before asking to confirm', async () => {
      renderScreen();

      await userEvent.click((await screen.findAllByRole('button', { name: /^Remove measurement/ }))[0]);
      const dialog = await screen.findByRole('dialog');

      expect(dialog).toHaveTextContent(/2 registered endpoints were admitted by this measurement/);
      expect(dialog).toHaveTextContent(/denied on the next one/);
      expect(within(dialog).getByText(MEASUREMENT_TRUSTED)).toBeInTheDocument();
    });

    it('says plainly when a removal drops nothing', async () => {
      renderScreen({ mocks: [measurementsMock([TRUSTED_UNUSED])] });

      await userEvent.click(await screen.findByRole('button', { name: /^Remove measurement/ }));

      expect(await screen.findByRole('dialog')).toHaveTextContent(
        'No registered endpoint was admitted by this measurement at its last check.',
      );
    });

    it('removes it on confirmation', async () => {
      renderScreen({
        mocks: [
          measurementsMock(),
          {
            request: { query: REMOVE_TRUSTED_MEASUREMENT, variables: { id: 'tm-1' } },
            result: { data: { removeTrustedMeasurement: true } },
          } satisfies MockLink.MockedResponse,
        ],
      });

      await userEvent.click((await screen.findAllByRole('button', { name: /^Remove measurement/ }))[0]);
      await userEvent.click(await screen.findByRole('button', { name: 'Remove measurement' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });
  });

  it('explains that an empty list is the fail-closed default', async () => {
    renderScreen({ mocks: [measurementsMock([])] });

    expect(await screen.findByText('No measurements trusted')).toBeInTheDocument();
    expect(screen.getByText(/That is the fail-closed default/)).toBeInTheDocument();
  });

  it('offers a retry rather than an empty table when the query fails', async () => {
    renderScreen({ mocks: [{ request: { query: measurementsMock().request.query }, error: new Error('boom') }] });

    expect(await screen.findByText('The trust list could not be loaded')).toBeInTheDocument();
  });
});
