import type { Metadata } from 'next';
import { ScreenPlaceholder } from '../../../components/screen-placeholder';

export const metadata: Metadata = { title: 'Activity' };

export default function ActivityPage() {
  return (
    <ScreenPlaceholder title="Activity" description="Spend and usage over time, by model and by key." issue="SUP-80" />
  );
}
