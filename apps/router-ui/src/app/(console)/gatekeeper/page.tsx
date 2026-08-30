import type { Metadata } from 'next';
import { ScreenPlaceholder } from '../../../components/screen-placeholder';

export const metadata: Metadata = { title: 'Gatekeeper' };

export default function GatekeeperPage() {
  return (
    <ScreenPlaceholder
      title="Gatekeeper"
      description="Download the verifying proxy and pin the evidence digests you trust."
      issue="SUP-79"
    />
  );
}
