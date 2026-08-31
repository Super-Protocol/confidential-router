export { GatekeeperModule } from './gatekeeper.module.js';
export { type CachedRelease, GatekeeperReleaseService } from './gatekeeper-release.service.js';
export {
  type ClassifiedAsset,
  classifyAsset,
  compareAssets,
  type GatekeeperArch,
  type GatekeeperOs,
  isChecksums,
} from './release-assets.js';
export {
  fetchLatestRelease,
  type GatekeeperDownload,
  latestReleaseUrl,
  MAX_RELEASE_BYTES,
  type PublishedRelease,
  ReleaseFetchError,
  type ReleaseSource,
  shapeRelease,
} from './release-fetcher.js';
