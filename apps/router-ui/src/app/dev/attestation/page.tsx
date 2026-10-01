import type { Metadata } from 'next';
import { AttestationReviewPanel } from './panel';

export const metadata: Metadata = {
  title: 'Attestation inspector',
  // A review surface, not a product page.
  robots: { index: false, follow: false },
};

export default function DevAttestationPage() {
  return <AttestationReviewPanel />;
}
