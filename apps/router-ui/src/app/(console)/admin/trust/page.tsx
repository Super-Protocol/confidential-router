import type { Metadata } from 'next';
import { TrustListScreen } from '../../../../components/admin/trust-list-screen';

export const metadata: Metadata = { title: 'Trust list' };

export default function TrustListPage() {
  return <TrustListScreen />;
}
