import type { Metadata } from 'next';
import { DataMigrationScreen } from '../../../../components/admin/data-migration/data-migration-screen';

export const metadata: Metadata = { title: 'Export & import' };

export default function DataMigrationPage() {
  return <DataMigrationScreen />;
}
