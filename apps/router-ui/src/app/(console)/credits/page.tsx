import type { Metadata } from 'next';
import { ScreenPlaceholder } from '../../../components/screen-placeholder';

export const metadata: Metadata = { title: 'Credits' };

export default function CreditsPage() {
  return (
    <ScreenPlaceholder title="Credits" description="Balance, transactions, top-ups and auto top-up." issue="SUP-81" />
  );
}
