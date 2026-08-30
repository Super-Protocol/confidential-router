import type { Metadata } from 'next';
import { ScreenPlaceholder } from '../../../components/screen-placeholder';

export const metadata: Metadata = { title: 'Profile' };

export default function ProfilePage() {
  return (
    <ScreenPlaceholder
      title="Profile"
      description="Your account, and the days your responses came with signed evidence."
      issue="SUP-81"
    />
  );
}
