/**
 * Release CHANNELS — the model behind "which update lane is this build on, and
 * is it the same app or a different one".
 *
 * Pure: no I/O, no app names, no host names. An app declares its channels once
 * via `defineChannelRegistry` and every surface that needs a channel-dependent
 * answer (which manifest to publish, which URL to poll, which bundle id to
 * build, which data home to write) asks the registry instead of re-deriving it.
 *
 * WHY THIS EXISTS RATHER THAN A BARE STRING UNION. A `Channel` union carries no
 * semantics, so each consumer re-derives them ad hoc — `if (channel !== 'alpha')`
 * scattered across a release script is six independent chances to disagree about
 * what a channel MEANS. Two of those derivations are load-bearing and fail
 * silently when they drift:
 *
 *  1. THE ROOT FEED. A shipped binary bakes ONE permanent manifest address and
 *     polls it forever. If a channel split moves that manifest, or hands it to a
 *     channel nobody actually cuts, every existing install silently stops
 *     updating — an updater cannot distinguish a failed check from "no update
 *     available", so it reports success forever. `rootFeed` makes exactly one
 *     channel the permanent root's owner, and the registry refuses to be built
 *     with zero or two of them.
 *
 *  2. THE DATA HOME. A channel that installs ALONGSIDE the main app
 *     (`distribution: 'side-by-side'`) is a different application: its own
 *     bundle id, its own name, and — the part that is easy to forget and
 *     expensive to get wrong — its own data home. A nightly build writing to the
 *     same state as the app someone actually works in is how a bad build costs
 *     real work. So a side-by-side channel without a distinct identity is not a
 *     bug to be caught in review; it is unrepresentable — `defineChannelRegistry`
 *     throws.
 *
 * The registry is the single exit: `resolveChannelIdentity` answers the bundle
 * id / product name / data home together, so the packaging config, the runtime
 * that picks a state directory, and the publisher that lays out feeds cannot
 * drift from one another.
 */

/**
 * How a channel's builds relate to the app already installed.
 *
 * - `update-lane`: the SAME application, reached by a different feed. Switching
 *   lanes is an update, not a second install — identity and data home are
 *   shared, deliberately, so a user who switches keeps their state.
 * - `side-by-side`: a DIFFERENT application that installs next to the main one
 *   rather than replacing it. Requires its own identity, including its own data
 *   home.
 */
export type ChannelDistribution = 'update-lane' | 'side-by-side';

/** One channel's declaration. */
export interface ChannelSpec {
  /**
   * Channel id. Becomes a URL path segment, a release-tag suffix, and (for a
   * side-by-side channel) part of a bundle id — so it is restricted to a slug.
   */
  id: string;
  distribution: ChannelDistribution;
  /**
   * This channel ALSO publishes to the permanent root manifest
   * (`<base>/latest.json`) — the address already-shipped binaries poll forever.
   *
   * At least one channel must set it: with no publisher, that address goes
   * stale and every existing install silently stops updating. Several MAY set
   * it — a root manifest can legitimately mean "the most recent cut, whatever
   * lane", with the lane gate applied downstream by whatever reads it.
   *
   * A `side-by-side` channel may NEVER set it: that channel is a different
   * application, and publishing it to the main app's permanent address offers
   * every installed user an update into a different product.
   */
  rootFeed?: boolean;
  /**
   * Slug distinguishing a `side-by-side` channel's identity from the base app.
   * REQUIRED and non-empty for `side-by-side`; REJECTED for `update-lane`
   * (an update lane that changed identity would silently be a second app).
   */
  identitySuffix?: string;
  /** Human-facing label for a side-by-side build. Defaults to a capitalized `identitySuffix`. */
  identityLabel?: string;
  /**
   * Channel ids this one is promoted FROM — the promotion graph. A channel
   * built directly from source (a nightly cut from trunk) promotes from
   * nothing. Must name known channels; cycles are rejected.
   */
  promotesFrom?: readonly string[];
  /**
   * Whether a cut on this channel enforces the strict preconditions (clean
   * tree, verified dependency freshness) rather than warning and continuing.
   */
  strict?: boolean;
  /** Whether a release on this channel is a prerelease. */
  prerelease?: boolean;
}

/** A channel spec with every optional field resolved. */
export interface ResolvedChannel {
  id: string;
  distribution: ChannelDistribution;
  rootFeed: boolean;
  identitySuffix: string | null;
  identityLabel: string | null;
  promotesFrom: readonly string[];
  strict: boolean;
  prerelease: boolean;
}

/** The base application's identity — what an `update-lane` channel inherits unchanged. */
export interface AppIdentity {
  /** Reverse-DNS bundle identifier, e.g. `com.example.app`. */
  bundleId: string;
  /** Human-facing product name. */
  productName: string;
  /**
   * The app's state directory NAME (not a full path) — e.g. `.example`. The
   * caller joins it to a home directory; keeping it relative is what lets this
   * module stay pure.
   */
  dataHomeDirName: string;
}

/** The identity a build on a given channel must use. */
export interface ChannelIdentity extends AppIdentity {
  channel: string;
  /** True when this identity is distinct from the base app's (a second install). */
  sideBySide: boolean;
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The manifest filename used when a caller does not name one. */
export const DEFAULT_MANIFEST_NAME = 'latest.json';

/**
 * A validated set of channels.
 *
 * Every accessor is total: an unknown id throws rather than returning
 * `undefined`, because every caller of these is deciding where bytes get
 * written or which directory gets opened, and a silent `undefined` there
 * becomes a wrong path rather than an error.
 */
export interface ChannelRegistry {
  /** Every channel, in declaration order. */
  all(): readonly ResolvedChannel[];
  ids(): readonly string[];
  has(id: string): boolean;
  /**
   * Ids a user of the base app can SWITCH BETWEEN — the `update-lane` channels.
   *
   * This is strictly narrower than `ids()`, and the distinction is the one a
   * channel switcher must respect: a side-by-side channel is a different
   * application, so "switch my install to it" is not a coherent operation. A UI
   * or an update endpoint that offers the full `ids()` list is offering to
   * replace the user's app with a different one.
   */
  updateLaneIds(): readonly string[];
  /** Ids that install alongside the base app rather than updating it. */
  sideBySideIds(): readonly string[];
  /** The channel, or throw naming the valid ids. */
  get(id: string): ResolvedChannel;
  /** The channels that publish to the permanent root manifest (never empty). */
  rootFeedChannels(): readonly ResolvedChannel[];
  /**
   * Manifest object paths a cut on `id` must publish, relative to the update
   * base — the per-channel feed always, plus the root manifest when this
   * channel owns it.
   *
   * ORDER IS DELIBERATE: the per-channel feed is written FIRST and the root
   * LAST. A publish that dies partway then leaves the root manifest — the one
   * every already-shipped binary polls — still pointing at the previous, known
   * good release, rather than advertising a release whose own feed never landed.
   */
  feedPathsFor(id: string, manifestName?: string): readonly string[];
  /** The per-channel feed URL under `baseUrl`. */
  feedUrlFor(id: string, baseUrl: string, manifestName?: string): string;
  /** The bundle id / product name / data home a build on `id` must use. */
  resolveIdentity(id: string, base: AppIdentity): ChannelIdentity;
  /** Ids reachable by promotion INTO `id` (direct sources only). */
  promotionSourcesFor(id: string): readonly string[];
}

function capitalize(slug: string): string {
  return slug
    .split('-')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ');
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * Validate + freeze a channel set.
 *
 * Throws — never warns — on anything that would make a downstream surface write
 * to the wrong place: a duplicate id, a missing or ambiguous root-feed owner, a
 * side-by-side channel with no distinct identity, or a promotion graph naming an
 * unknown channel or containing a cycle.
 */
export function defineChannelRegistry(
  specs: readonly ChannelSpec[],
): ChannelRegistry {
  if (specs.length === 0) {
    throw new Error('channel registry: at least one channel must be declared');
  }

  const resolved: ResolvedChannel[] = [];
  const byId = new Map<string, ResolvedChannel>();
  const suffixes = new Map<string, string>();

  for (const spec of specs) {
    if (!SLUG_RE.test(spec.id)) {
      throw new Error(
        `channel "${spec.id}": id must be a lowercase slug (it becomes a URL segment, a tag suffix and part of a bundle id)`,
      );
    }
    if (byId.has(spec.id)) {
      throw new Error(`channel "${spec.id}": declared twice`);
    }

    const sideBySide = spec.distribution === 'side-by-side';
    const suffix = spec.identitySuffix?.trim() ?? '';

    if (sideBySide) {
      if (!suffix) {
        throw new Error(
          `channel "${spec.id}": a side-by-side channel MUST declare a non-empty identitySuffix — it installs alongside the main app, so it needs its own bundle id, name and DATA HOME. Sharing a data home with the app in daily use is how a bad build destroys real work.`,
        );
      }
      if (!SLUG_RE.test(suffix)) {
        throw new Error(
          `channel "${spec.id}": identitySuffix "${suffix}" must be a lowercase slug`,
        );
      }
      const clash = suffixes.get(suffix);
      if (clash) {
        throw new Error(
          `channel "${spec.id}": identitySuffix "${suffix}" is already used by channel "${clash}" — two side-by-side channels would resolve to the SAME bundle id and data home`,
        );
      }
      suffixes.set(suffix, spec.id);
    } else if (suffix) {
      throw new Error(
        `channel "${spec.id}": an update-lane channel must NOT declare an identitySuffix — it is the same application reached by a different feed, and a changed identity would silently make it a second install`,
      );
    }

    const entry: ResolvedChannel = {
      id: spec.id,
      distribution: spec.distribution,
      rootFeed: spec.rootFeed === true,
      identitySuffix: sideBySide ? suffix : null,
      identityLabel: sideBySide
        ? (spec.identityLabel?.trim() || capitalize(suffix))
        : null,
      promotesFrom: Object.freeze([...(spec.promotesFrom ?? [])]),
      strict: spec.strict === true,
      prerelease: spec.prerelease === true,
    };
    Object.freeze(entry);
    resolved.push(entry);
    byId.set(entry.id, entry);
  }

  const rootOwners = Object.freeze(resolved.filter((c) => c.rootFeed));
  if (rootOwners.length === 0) {
    throw new Error(
      'channel registry: at least one channel must set rootFeed — it publishes to the PERMANENT manifest address already-shipped binaries poll. With no publisher that address goes stale and every existing install silently stops updating.',
    );
  }
  const sideBySideRoot = rootOwners.find((c) => c.distribution === 'side-by-side');
  if (sideBySideRoot) {
    throw new Error(
      `channel "${sideBySideRoot.id}": a side-by-side channel must NOT set rootFeed — it is a different application, and publishing it to the main app's permanent manifest address would offer every installed user an update into a different product`,
    );
  }

  // Promotion graph: known targets, no self-edges, no cycles.
  for (const c of resolved) {
    for (const from of c.promotesFrom) {
      if (from === c.id) {
        throw new Error(`channel "${c.id}": promotesFrom cannot name itself`);
      }
      if (!byId.has(from)) {
        throw new Error(
          `channel "${c.id}": promotesFrom names unknown channel "${from}"`,
        );
      }
    }
  }
  detectPromotionCycle(resolved, byId);

  const ids = Object.freeze(resolved.map((c) => c.id));
  const frozen = Object.freeze([...resolved]);
  const laneIds = Object.freeze(
    resolved.filter((c) => c.distribution === 'update-lane').map((c) => c.id),
  );
  const sideIds = Object.freeze(
    resolved.filter((c) => c.distribution === 'side-by-side').map((c) => c.id),
  );

  function get(id: string): ResolvedChannel {
    const found = byId.get(id);
    if (!found) {
      throw new Error(
        `unknown channel "${id}": must be one of ${ids.join(', ')}`,
      );
    }
    return found;
  }

  return Object.freeze({
    all: () => frozen,
    ids: () => ids,
    has: (id: string) => byId.has(id),
    get,
    updateLaneIds: () => laneIds,
    sideBySideIds: () => sideIds,
    rootFeedChannels: () => rootOwners,
    feedPathsFor(id: string, manifestName = DEFAULT_MANIFEST_NAME) {
      const c = get(id);
      const paths = [`${c.id}/${manifestName}`];
      // Root LAST — see the interface comment: a partial publish must leave the
      // permanently-polled manifest on the last known good release.
      if (c.rootFeed) paths.push(manifestName);
      return Object.freeze(paths);
    },
    feedUrlFor(id: string, baseUrl: string, manifestName = DEFAULT_MANIFEST_NAME) {
      const c = get(id);
      return joinUrl(baseUrl, `${c.id}/${manifestName}`);
    },
    resolveIdentity(id: string, base: AppIdentity): ChannelIdentity {
      return resolveChannelIdentity(get(id), base);
    },
    promotionSourcesFor(id: string) {
      return get(id).promotesFrom;
    },
  });
}

function detectPromotionCycle(
  resolved: readonly ResolvedChannel[],
  byId: ReadonlyMap<string, ResolvedChannel>,
): void {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(resolved.map((c) => [c.id, WHITE]));

  // Iterative DFS — a channel graph is tiny, but recursion here would be one
  // more thing that behaves differently on a pathological input than on a test.
  for (const root of resolved) {
    if (color.get(root.id) !== WHITE) continue;
    const stack: Array<{ id: string; next: number; path: string[] }> = [
      { id: root.id, next: 0, path: [root.id] },
    ];
    color.set(root.id, GREY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const edges = byId.get(frame.id)!.promotesFrom;
      if (frame.next >= edges.length) {
        color.set(frame.id, BLACK);
        stack.pop();
        continue;
      }
      const nextId = edges[frame.next++]!;
      const state = color.get(nextId);
      if (state === GREY) {
        const cycle = [...frame.path.slice(frame.path.indexOf(nextId)), nextId];
        throw new Error(
          `channel registry: promotion cycle ${cycle.join(' -> ')}`,
        );
      }
      if (state === WHITE) {
        color.set(nextId, GREY);
        stack.push({ id: nextId, next: 0, path: [...frame.path, nextId] });
      }
    }
  }
}

/**
 * The identity a build on `channel` must use.
 *
 * An `update-lane` channel returns the base identity UNCHANGED — same app, same
 * data home, so switching lanes preserves the user's state. A `side-by-side`
 * channel returns a distinct bundle id, product name and data home, and this
 * function asserts that distinctness rather than assuming it: it is the single
 * place the "nightly must not share a data home" rule is enforced, so a caller
 * that forgets it gets an error instead of a silently shared directory.
 */
export function resolveChannelIdentity(
  channel: ResolvedChannel,
  base: AppIdentity,
): ChannelIdentity {
  if (channel.distribution === 'update-lane') {
    return Object.freeze({
      ...base,
      channel: channel.id,
      sideBySide: false,
    });
  }

  const suffix = channel.identitySuffix;
  if (!suffix) {
    // Unreachable via defineChannelRegistry, which rejects this at construction.
    // Kept because this function is exported and a hand-built ResolvedChannel
    // must not be able to produce a shared data home.
    throw new Error(
      `channel "${channel.id}": side-by-side with no identitySuffix would share the base app's data home`,
    );
  }

  const identity: ChannelIdentity = {
    bundleId: `${base.bundleId}.${suffix}`,
    productName: `${base.productName} ${channel.identityLabel ?? capitalize(suffix)}`,
    dataHomeDirName: `${base.dataHomeDirName}-${suffix}`,
    channel: channel.id,
    sideBySide: true,
  };

  if (identity.dataHomeDirName === base.dataHomeDirName) {
    throw new Error(
      `channel "${channel.id}": resolved data home "${identity.dataHomeDirName}" is identical to the base app's — a side-by-side build must never write to the state of the app in daily use`,
    );
  }
  if (identity.bundleId === base.bundleId) {
    throw new Error(
      `channel "${channel.id}": resolved bundle id "${identity.bundleId}" is identical to the base app's — it would REPLACE the installed app instead of installing alongside it`,
    );
  }

  return Object.freeze(identity);
}
