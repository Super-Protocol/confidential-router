import type { Metadata } from 'next';
import { PreferencesScreen } from '../../../components/preferences/preferences-screen';

export const metadata: Metadata = { title: 'Preferences' };

export default function PreferencesPage() {
  return <PreferencesScreen />;
}
