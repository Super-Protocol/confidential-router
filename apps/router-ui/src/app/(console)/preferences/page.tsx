import type { Metadata } from 'next';
import { ScreenPlaceholder } from '../../../components/screen-placeholder';

export const metadata: Metadata = { title: 'Preferences' };

export default function PreferencesPage() {
  return (
    <ScreenPlaceholder
      title="Preferences"
      description="Evidence archiving and retention, notifications and receipts."
      issue="SUP-81"
    />
  );
}
