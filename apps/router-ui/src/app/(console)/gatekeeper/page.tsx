import type { Metadata } from 'next';
import { GatekeeperScreen } from '../../../components/gatekeeper/gatekeeper-screen';

export const metadata: Metadata = { title: 'Gatekeeper' };

export default function GatekeeperPage() {
  return <GatekeeperScreen />;
}
