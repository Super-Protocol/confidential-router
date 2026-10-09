import type { Metadata } from 'next';
import { ResetPasswordForm } from '../../../components/auth/reset-password-form';

export const metadata: Metadata = {
  title: 'Choose a new password',
  // The URL carries a live token: keep it out of any Referer this page sends.
  referrer: 'no-referrer',
};

export default function ResetPasswordPage() {
  return <ResetPasswordForm />;
}
