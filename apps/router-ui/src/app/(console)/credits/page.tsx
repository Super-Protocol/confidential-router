import type { Metadata } from 'next';
import { CreditsScreen } from '../../../components/credits/credits-screen';

export const metadata: Metadata = { title: 'Credits' };

export default function CreditsPage() {
  return <CreditsScreen />;
}
