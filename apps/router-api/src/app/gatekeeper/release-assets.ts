/**
 * Classification of GoReleaser's asset names.
 *
 * The console's Gatekeeper screen offers one download per platform, so an asset
 * is only useful once its OS and CPU are known. GoReleaser writes them into the
 * file name (`gatekeeper_0.4.1_linux_amd64.tar.gz`, `gatekeeper_Darwin_arm64.zip`),
 * and the spellings it can emit are a short, closed list — small enough to match
 * exactly rather than with a regular expression that would also match a token
 * inside the version.
 */

export type GatekeeperOs = 'linux' | 'macos' | 'windows';
export type GatekeeperArch = 'amd64' | 'arm64';

/**
 * Every spelling GoReleaser and the Go toolchain use for the platforms we ship.
 * Keys are lower case; the lookup lower-cases the token, because GoReleaser's
 * `title` casing (`Darwin`, `Linux`) is a template choice a release can change.
 */
const OS_TOKENS: Record<string, GatekeeperOs> = {
  linux: 'linux',
  darwin: 'macos',
  macos: 'macos',
  windows: 'windows',
};

/** `x86_64` is absent because `tokensOf` folds it into `amd64` before splitting. */
const ARCH_TOKENS: Record<string, GatekeeperArch> = {
  amd64: 'amd64',
  arm64: 'arm64',
  aarch64: 'arm64',
};

/** Checksums and signatures describe the binaries; they are not one of them. */
const SIDECAR_SUFFIXES = ['.sig', '.pem', '.sbom.json', '.sbom', '.asc'];

export interface ClassifiedAsset {
  os: GatekeeperOs;
  arch: GatekeeperArch;
}

/**
 * Splits an asset name into the tokens GoReleaser joins with `_` or `-`, having
 * first dropped the archive extension — otherwise `linux_amd64.tar.gz` yields a
 * final token of `amd64.tar.gz` that no table can match.
 */
function tokensOf(name: string): string[] {
  return (
    name
      .replace(/\.(tar\.gz|tar\.xz|tgz|zip|gz|exe)$/i, '')
      // `x86_64` is the one spelling that contains a separator, so it has to be
      // folded before the split rather than matched after it.
      .replace(/x86[_-]64/gi, 'amd64')
      .split(/[_\-.]/)
  );
}

/**
 * The OS and CPU an asset is for, or null when it is not a platform binary.
 *
 * Unclassifiable assets are dropped rather than guessed at: a download button
 * that hands a user the wrong architecture is worse than one that is absent,
 * and the release notes link is always there as the fallback.
 */
export function classifyAsset(name: string): ClassifiedAsset | null {
  if (isChecksums(name) || SIDECAR_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix))) {
    return null;
  }

  let os: GatekeeperOs | undefined;
  let arch: GatekeeperArch | undefined;
  for (const token of tokensOf(name).map((token) => token.toLowerCase())) {
    os ??= OS_TOKENS[token];
    arch ??= ARCH_TOKENS[token];
  }

  return os && arch ? { os, arch } : null;
}

/** GoReleaser's checksum manifest, whatever the release names it. */
export function isChecksums(name: string): boolean {
  return /checksums?(\.txt)?$/i.test(name);
}

/** Stable order for the download list: the platforms most users are on, first. */
const OS_ORDER: GatekeeperOs[] = ['linux', 'macos', 'windows'];
const ARCH_ORDER: GatekeeperArch[] = ['amd64', 'arm64'];

export function compareAssets(a: ClassifiedAsset, b: ClassifiedAsset): number {
  return OS_ORDER.indexOf(a.os) - OS_ORDER.indexOf(b.os) || ARCH_ORDER.indexOf(a.arch) - ARCH_ORDER.indexOf(b.arch);
}
