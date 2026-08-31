import { Field, GraphQLISODateTime, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import type { CachedRelease, GatekeeperArch, GatekeeperOs } from '../../../gatekeeper/index.js';

/** Runtime twins of the `GatekeeperOs` / `GatekeeperArch` unions, for GraphQL. */
export const GatekeeperOsEnum = {
  LINUX: 'linux',
  MACOS: 'macos',
  WINDOWS: 'windows',
} as const satisfies Record<string, GatekeeperOs>;

registerEnumType(GatekeeperOsEnum, { name: 'GatekeeperOs' });

export const GatekeeperArchEnum = {
  AMD64: 'amd64',
  ARM64: 'arm64',
} as const satisfies Record<string, GatekeeperArch>;

registerEnumType(GatekeeperArchEnum, { name: 'GatekeeperArch' });

@ObjectType('GatekeeperDownload', { description: 'One published binary of the gatekeeper, for one platform.' })
export class GatekeeperDownloadModel {
  @Field(() => String, { description: 'The asset file name, e.g. gatekeeper_0.4.1_linux_amd64.tar.gz.' })
  name!: string;

  @Field(() => GatekeeperOsEnum)
  os!: GatekeeperOs;

  @Field(() => GatekeeperArchEnum)
  arch!: GatekeeperArch;

  @Field(() => Int, { description: 'Size of the asset in bytes; 0 when the release did not say.' })
  sizeBytes!: number;

  @Field(() => String)
  contentType!: string;

  @Field(() => String, { description: 'Direct download URL on GitHub.' })
  url!: string;
}

/**
 * What the Gatekeeper screen renders: which build to download, and where the
 * checksums are.
 *
 * A statement about a published artefact and nothing else. The gatekeeper
 * verifies endpoints on the user's own machine, so this router has no idea
 * whether anyone runs it, which version they run, or what it concluded
 * (ADR-002).
 */
@ObjectType('GatekeeperRelease', { description: 'The gatekeeper build the platform currently publishes.' })
export class GatekeeperReleaseModel {
  @Field(() => String, { description: 'The release tag, e.g. v0.4.1.' })
  version!: string;

  @Field(() => GraphQLISODateTime, { nullable: true })
  publishedAt!: Date | null;

  @Field(() => String, { description: 'The release page, for the changelog.' })
  notesUrl!: string;

  @Field(() => String, {
    nullable: true,
    description: 'The checksum manifest, so a download can be verified without trusting this API.',
  })
  checksumsUrl!: string | null;

  @Field(() => [GatekeeperDownloadModel], { description: 'One entry per platform, Linux first.' })
  downloads!: GatekeeperDownloadModel[];

  @Field(() => GraphQLISODateTime, { description: 'When this router last read the release from GitHub.' })
  fetchedAt!: Date;

  @Field(() => Boolean, {
    description: 'True when GitHub could not be reached and these are the last known links.',
  })
  stale!: boolean;

  static from(release: CachedRelease): GatekeeperReleaseModel {
    return {
      version: release.version,
      publishedAt: release.publishedAt,
      notesUrl: release.notesUrl,
      checksumsUrl: release.checksumsUrl,
      downloads: release.downloads.map((download) => ({
        name: download.name,
        os: download.os,
        arch: download.arch,
        sizeBytes: download.sizeBytes,
        contentType: download.contentType,
        url: download.url,
      })),
      fetchedAt: release.fetchedAt,
      stale: release.stale,
    };
  }
}
