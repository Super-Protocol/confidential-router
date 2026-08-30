import type { Metadata } from 'next';
import { ScreenPlaceholder } from '../../../components/screen-placeholder';

export const metadata: Metadata = { title: 'Logs' };

export default function LogsPage() {
  return (
    <ScreenPlaceholder
      title="Logs"
      description="Per-generation metering: tokens, cost, latency and the evidence in force."
      issue="SUP-80"
    />
  );
}
