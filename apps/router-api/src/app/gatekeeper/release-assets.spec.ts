import { describe, expect, it } from 'vitest';
import { classifyAsset, compareAssets, isChecksums } from './release-assets.js';

describe('classifyAsset', () => {
  it('reads the platform out of GoReleaser’s default name', () => {
    expect(classifyAsset('gatekeeper_0.4.1_linux_amd64.tar.gz')).toEqual({ os: 'linux', arch: 'amd64' });
    expect(classifyAsset('gatekeeper_0.4.1_windows_arm64.zip')).toEqual({ os: 'windows', arch: 'arm64' });
  });

  it('accepts the title-cased and Go-toolchain spellings of the same platform', () => {
    // GoReleaser's `name_template` decides the casing and whether it writes
    // `Darwin`/`x86_64` or `darwin`/`amd64`; a release that changes the template
    // must not empty the download list.
    expect(classifyAsset('gatekeeper_Darwin_x86_64.tar.gz')).toEqual({ os: 'macos', arch: 'amd64' });
    expect(classifyAsset('gatekeeper_Linux_aarch64.tar.gz')).toEqual({ os: 'linux', arch: 'arm64' });
    expect(classifyAsset('gatekeeper-macos-arm64.zip')).toEqual({ os: 'macos', arch: 'arm64' });
  });

  it('is not confused by a version that ends in an archive extension’s letters', () => {
    expect(classifyAsset('gatekeeper_1.2.0-rc.1_linux_amd64.tar.gz')).toEqual({ os: 'linux', arch: 'amd64' });
  });

  it('drops an asset that names only one half of the platform', () => {
    expect(classifyAsset('gatekeeper_0.4.1_linux.tar.gz')).toBeNull();
    expect(classifyAsset('gatekeeper_0.4.1_amd64.tar.gz')).toBeNull();
  });

  it('drops the manifest and the signatures that describe the binaries', () => {
    // A download button that hands a user a `.sig` is worse than one that is
    // absent; the checksum manifest is offered separately, as a link.
    expect(classifyAsset('checksums.txt')).toBeNull();
    expect(classifyAsset('gatekeeper_0.4.1_linux_amd64.tar.gz.sig')).toBeNull();
    expect(classifyAsset('gatekeeper_0.4.1_linux_amd64.tar.gz.pem')).toBeNull();
    expect(classifyAsset('gatekeeper_0.4.1_linux_amd64.sbom.json')).toBeNull();
  });
});

describe('isChecksums', () => {
  it('recognises the spellings GoReleaser emits', () => {
    expect(isChecksums('checksums.txt')).toBe(true);
    expect(isChecksums('gatekeeper_0.4.1_checksums.txt')).toBe(true);
    expect(isChecksums('CHECKSUM')).toBe(true);
    expect(isChecksums('gatekeeper_0.4.1_linux_amd64.tar.gz')).toBe(false);
  });
});

describe('compareAssets', () => {
  it('orders the list the way the screen renders it', () => {
    const assets = [
      { os: 'windows', arch: 'arm64' },
      { os: 'linux', arch: 'arm64' },
      { os: 'macos', arch: 'amd64' },
      { os: 'linux', arch: 'amd64' },
    ] as const;

    expect([...assets].sort(compareAssets)).toEqual([
      { os: 'linux', arch: 'amd64' },
      { os: 'linux', arch: 'arm64' },
      { os: 'macos', arch: 'amd64' },
      { os: 'windows', arch: 'arm64' },
    ]);
  });
});
