import type { Metadata } from 'next';
import { ScreenPlaceholder } from '../../../components/screen-placeholder';

export const metadata: Metadata = { title: 'Models' };

export default function ModelsPage() {
  return (
    <ScreenPlaceholder
      title="Models"
      description="Every model this router serves, its endpoint, context window and price."
      issue="SUP-78"
    />
  );
}
