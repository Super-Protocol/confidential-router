import type { Metadata } from 'next';
import { ExternalEndpointsScreen } from '../../../../components/admin/external-endpoints-screen';

export const metadata: Metadata = { title: 'External endpoints' };

export default function ExternalEndpointsPage() {
  return <ExternalEndpointsScreen />;
}
