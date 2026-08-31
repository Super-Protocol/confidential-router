import type { Metadata } from 'next';
import { LogsScreen } from '../../../components/logs/logs-screen';

export const metadata: Metadata = { title: 'Logs' };

export default function LogsPage() {
  return <LogsScreen />;
}
