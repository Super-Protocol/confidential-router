import type { Metadata } from 'next';
import { APIKeysScreen } from '../../../components/keys/api-keys-screen';

export const metadata: Metadata = { title: 'API Keys' };

export default function APIKeysPage() {
  return <APIKeysScreen />;
}
