/** Channel + version + tag resolution. Pure. */
import type { Channel } from './types.js';

export const CHANNELS: readonly Channel[] = ['alpha', 'beta', 'stable', 'nightly'];

/** semver-ish: X.Y.Z with optional -prerelease (matches bin/release-local.sh). */
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]+)?$/;

export function isValidVersion(version: string): boolean {
  return VERSION_RE.test(version);
}

export function assertValidVersion(version: string): void {
  if (!isValidVersion(version)) {
    throw new Error(
      `invalid version "${version}": must look like X.Y.Z or X.Y.Z-foo`,
    );
  }
}

export function isValidChannel(channel: string): channel is Channel {
  return (CHANNELS as readonly string[]).includes(channel);
}

export function assertValidChannel(channel: string): asserts channel is Channel {
  if (!isValidChannel(channel)) {
    throw new Error(
      `invalid channel "${channel}": must be one of ${CHANNELS.join('|')}`,
    );
  }
}

/**
 * Default tag scheme — matches the operator's manifest classifier
 * (packages/operator-core/lib/endpoint-route/routes/misc/updates-manifest.ts
 * `classifyChannel`, which reads the channel back OFF the tag):
 *   alpha   → desktop-vX.Y.Z-alpha
 *   beta    → desktop-vX.Y.Z-beta
 *   nightly → desktop-vX.Y.Z-nightly
 *   stable  → desktop-vX.Y.Z
 *
 * ⚠ Adding a channel here is only half the change. The classifier recovers the
 * channel from the tag SUFFIX and its fall-through is `stable`, so a channel
 * this function can emit but the classifier does not recognise is not rejected
 * — it is silently classified stable and served to stable users.
 */
export function defaultTagFor(version: string, channel: Channel): string {
  return channel === 'stable'
    ? `desktop-v${version}`
    : `desktop-v${version}-${channel}`;
}

/** A GitHub release is a prerelease for any non-stable channel. */
export function isPrerelease(channel: Channel): boolean {
  return channel !== 'stable';
}
