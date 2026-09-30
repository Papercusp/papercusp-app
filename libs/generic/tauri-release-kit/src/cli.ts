/**
 * Argv parsing for the release-kit CLI's `publish` subcommand:
 *
 *   release-kit publish --platform <linux|darwin|windows> --incremental <version> <channel>
 *
 * Kept as a pure function (no process.argv / exit reads) so it's unit-testable
 * without a real CLI harness — mirrors tag.ts's assertValidChannel pattern.
 * A host's actual `bin/release-kit` entry point parses `process.argv.slice(2)`
 * with this, then wires `runIncrementalPublish` (incremental-publish.ts).
 */
import type { Channel, TargetKey } from './types.js';
import { CHANNELS, isValidChannel } from './tag.js';

/** The CLI's friendly platform vocabulary → the kit's TargetKey. */
export const PUBLISH_PLATFORMS = ['linux', 'darwin', 'windows'] as const;
export type PublishPlatform = (typeof PUBLISH_PLATFORMS)[number];

const PLATFORM_TO_TARGET: Record<PublishPlatform, TargetKey> = {
  linux: 'linux-x86_64',
  darwin: 'macos-universal',
  windows: 'windows-x86_64',
};

/** Map the CLI's `--platform` value to the TargetKey a driver is registered under. */
export function targetKeyForPlatform(platform: PublishPlatform): TargetKey {
  return PLATFORM_TO_TARGET[platform];
}

export interface PublishArgs {
  platform: PublishPlatform;
  targetKey: TargetKey;
  version: string;
  channel: Channel;
  /** Always true today — see the error below for why. */
  incremental: true;
}

function isPublishPlatform(v: string): v is PublishPlatform {
  return (PUBLISH_PLATFORMS as readonly string[]).includes(v);
}

/**
 * Parse `["publish", "--platform", "darwin", "--incremental", "0.0.13", "alpha"]`
 * (flag order after the subcommand is not significant) into a typed
 * `PublishArgs`, or throw a one-line, actionable Error.
 */
export function parsePublishArgs(argv: readonly string[]): PublishArgs {
  const args = [...argv];
  const sub = args.shift();
  if (sub !== 'publish') {
    throw new Error(`expected subcommand "publish", got ${JSON.stringify(sub ?? '')}`);
  }

  let platform: string | undefined;
  let incremental = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--platform') {
      platform = args[++i];
    } else if (a === '--incremental') {
      incremental = true;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown flag ${JSON.stringify(a)}`);
    } else {
      positional.push(a);
    }
  }

  if (!platform) {
    throw new Error(`--platform <${PUBLISH_PLATFORMS.join('|')}> is required`);
  }
  if (!isPublishPlatform(platform)) {
    throw new Error(`--platform must be ${PUBLISH_PLATFORMS.join('|')} (got ${JSON.stringify(platform)})`);
  }
  if (!incremental) {
    // A full (non-incremental) multi-target `publish` subcommand isn't wired
    // yet — runRelease() already covers that case directly. Say so rather
    // than silently doing something else.
    throw new Error(
      '"publish" without --incremental is not implemented — call runRelease() directly for a full multi-target cut',
    );
  }

  const [version, channel] = positional;
  if (!version) throw new Error('missing <version>');
  if (!channel) throw new Error('missing <channel>');
  if (!isValidChannel(channel)) {
    // Derived from CHANNELS, not spelled out: a hardcoded list here silently
    // goes stale the moment a channel is added, and it is the message a caller
    // reads to learn what the valid channels ARE.
    throw new Error(
      `channel must be ${CHANNELS.join('|')} (got ${JSON.stringify(channel)})`,
    );
  }

  return {
    platform,
    targetKey: targetKeyForPlatform(platform),
    version,
    channel,
    incremental: true,
  };
}
