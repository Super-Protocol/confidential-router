import type { Metadata } from 'next';
import { ScreenPlaceholder } from '../../../components/screen-placeholder';

export const metadata: Metadata = { title: 'API Keys' };

export default function APIKeysPage() {
  return (
    <ScreenPlaceholder
      title="API Keys"
      description="Issue, scope and revoke keys, and copy the drop-in base-URL snippet."
      issue="SUP-79"
    />
  );
}
