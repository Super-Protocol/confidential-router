import type { Metadata } from 'next';
import { InvitationsScreen } from '../../../../components/admin/invitations/invitations-screen';

export const metadata: Metadata = { title: 'Invitations' };

export default function InvitationsPage() {
  return <InvitationsScreen />;
}
