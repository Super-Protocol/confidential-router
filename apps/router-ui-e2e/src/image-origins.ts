/**
 * The two deployments `playwright.image.config.ts` boots and
 * `image-origins.spec.ts` drives — one image, two API origins.
 *
 * Nothing listens on the API origins: the assertion is about where the browser
 * *sends* its requests, and the spec fulfils them itself. They only have to be
 * addressable from the host running the browser, and different from each other.
 */
export interface ImageDeployment {
  /** Host port the container's console is published on. */
  readonly consolePort: number;
  /** What the container is told router-api's origin is. */
  readonly apiOrigin: string;
}

export const DEPLOYMENTS: Record<'alpha' | 'beta', ImageDeployment> = {
  alpha: { consolePort: 4310, apiOrigin: 'http://127.0.0.1:4390' },
  beta: { consolePort: 4311, apiOrigin: 'http://127.0.0.1:4391' },
};

export function consoleUrl(deployment: ImageDeployment, path = '/'): string {
  return `http://127.0.0.1:${deployment.consolePort}${path}`;
}

/** The image under test. `make images` is what tags the local one. */
export const IMAGE = process.env.ROUTER_UI_IMAGE ?? 'confidential-router/router-ui:local';
