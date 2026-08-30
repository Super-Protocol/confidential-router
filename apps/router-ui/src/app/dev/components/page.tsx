import type { Metadata } from 'next';
import { ComponentGallery } from './gallery';

export const metadata: Metadata = {
  title: 'Components',
  // A design surface, not a product page.
  robots: { index: false, follow: false },
};

/**
 * Visual review surface for `@confidential-router/ui`: every primitive, every
 * variant, in one scroll, under whichever theme and accent are selected.
 *
 * A page rather than Storybook because Storybook is a second build, a second
 * dependency tree and a second place for the tokens to be configured — and this
 * renders the components in the app that actually consumes them.
 */
export default function DevComponentsPage() {
  return <ComponentGallery />;
}
