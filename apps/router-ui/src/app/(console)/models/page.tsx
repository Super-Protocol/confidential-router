import type { Metadata } from 'next';
import { ModelsScreen } from '../../../components/models/models-screen';
import { PageHeader } from '../../../components/page-header';

export const metadata: Metadata = { title: 'Models' };

export default function ModelsPage() {
  return (
    <>
      <PageHeader
        title="Models"
        description="Open-weight models served from hardware-isolated enclaves. Prices are per 1M tokens, billed from credits."
      />
      <ModelsScreen />
    </>
  );
}
