/**
 * git-sync-events — the git-sync commit/egress signals through the await-event primitive
 * (event-await-discoverability-and-coverage-2026-07-03 P-102).
 *
 * When git-sync actually commits the shared tree (`status: 'synced'`), two LOCAL
 * commit keys fire:
 *
 *   `git-sync:committed` — the GLOBAL "a commit just landed" signal: any agent that
 *   left an edit in the tree and wants to know "is my edit a local git commit yet"
 *   awaits this and is WOKEN on the next successful local sync. The waiter checks
 *   `payload.sha`, `payload.installSlug`, `payload.workspaceId`, and the
 *   producer-time `payload.committedAtMs` freshness boundary to see which
 *   commit and harness produced it.
 *
 *   `git-sync:committed:<sha>` — the PRECISE per-sha key: an agent that already knows
 *   the head sha it cares about (e.g. handed one by a peer) awaits exactly it and wakes
 *   only for that local commit — no payload-filtering the global stream.
 *
 * A BRIDGED hive has a distinct, later proof point. After the GitHub bridge confirms
 * that canonical staging was pushed (or was already at the same sha), these fire:
 *
 *   `git-sync:egressed` and `git-sync:egressed:<sha>` — truthful origin/staging
 *   egress signals. A local commit must never imply these; p2p-only hives do not have
 *   a GitHub egress leg at all. Both global keys carry the same harness/workspace
 *   scope so a waiter in one harness cannot wake on another harness's tick.
 *
 * Called fire-and-forget from the git-sync action's per-tick funnel; an emit failure
 * can never break a sync. A duplicate emit (a resumed DBOS fire replaying past the
 * record checkpoint) is benign: await keys are one-shot WAKE subscriptions, so a
 * second fire with no live waiter is a no-op and a re-fire just re-wakes.
 */

import { emitAwaitedEvent } from '../../events/await/engine';
import type { ResourceHolder } from '@papercusp/locks';

/**
 * JSON-safe lock-holder detail carried by git-sync's retry signal and on-demand
 * outcome. ResourceHolder uses Date objects for the lease timestamps, but these
 * values cross the tool/event boundary and must remain serializable.
 */
export interface GitSyncLockHolderSnapshot {
  owner: string;
  owner_label: string | null;
  mode: ResourceHolder['mode'];
  status: ResourceHolder['status'];
  lock_id: string;
  reason: string;
  acquired_ts: string;
  expires_ts: string;
  fence_seq: number;
}

function isoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Convert the lock store's Date-bearing refusal detail into tool-safe JSON. */
export function snapshotGitSyncLockHolders(holders: readonly ResourceHolder[]): GitSyncLockHolderSnapshot[] {
  return holders.map((holder) => ({
    owner: holder.owner,
    owner_label: holder.owner_label,
    mode: holder.mode,
    status: holder.status,
    lock_id: holder.lock_id,
    reason: holder.reason,
    acquired_ts: isoTimestamp(holder.acquired_ts),
    expires_ts: isoTimestamp(holder.expires_ts),
    fence_seq: holder.fence_seq,
  }));
}

/**
 * Identify a holder created by the git-sync action for this install.
 *
 * Git-sync fires use unique owners so scheduled and manual invocations really
 * contend, but they deliberately share the same label/reason. That metadata is
 * the stable distinction between an in-flight git-sync run and an unrelated
 * peer's lock; do not classify on the `system:git-sync` prefix alone because
 * the lock can be held for a different install.
 */
export function isSystemGitSyncHolder(
  holder: Pick<GitSyncLockHolderSnapshot, 'owner' | 'owner_label' | 'reason'>,
  installSlug: string,
): boolean {
  return (
    holder.owner.startsWith('system:git-sync:') &&
    holder.owner_label === `git-sync:${installSlug}` &&
    holder.reason === `auto-commit ${installSlug}`
  );
}

/** Global signal for a git-sync fire that must retry after a resource is freed. */
export const GIT_SYNC_LOCK_RETRY_EVENT = 'git-sync:lock-retry';

/** Exact release-boundary signal for a named resource. */
export const RESOURCE_RELEASED_EVENT_PREFIX = 'resource:released:';

export function resourceReleasedEventKey(resource: string): string {
  return `${RESOURCE_RELEASED_EVENT_PREFIX}${resource}`;
}

/**
 * Errors that are EXPECTED for a best-effort, fire-and-forget notification and so must
 * never warn (vitest-fail-on-console would then flake any rig test): a partial test
 * schema (a projection table the emit touches is absent → "… does not exist"), or the
 * emit's async query outliving the Postgres pool it ran on (a rig tearing down mid-emit
 * → postgres.js CONNECTION_ENDED/CONNECTION_DESTROYED). Anything else is a real surprise.
 */
function failSoft(scope: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  if (/does not exist/.test(msg)) return;
  const code = (e as { code?: unknown } | null)?.code;
  if (
    code === 'CONNECTION_ENDED' ||
    code === 'CONNECTION_DESTROYED' ||
    /CONNECTION_ENDED|CONNECTION_DESTROYED|Connection ended/i.test(msg)
  ) {
    return;
  }
  console.warn(`[git-sync-events] ${scope} emit failed: ${msg}`);
}

/**
 * Fire-and-forget proof that an exclusive named-resource row was actually
 * released. This is deliberately emitted by the release path, never at the
 * refusal boundary, so a waiter cannot wake into the same held_exclusive state.
 */
export function emitResourceReleasedEvent(
  resource: string,
  workspaceId: string | null | undefined,
  emit: typeof emitAwaitedEvent = emitAwaitedEvent,
): void {
  void Promise.resolve()
    .then(() =>
      emit({
        key: resourceReleasedEventKey(resource),
        summary: `named resource ${resource} was released`,
        payload: {
          resource,
          ...(workspaceId ? { workspaceId } : {}),
          releasedAtMs: Date.now(),
        },
        source: 'resource-locks',
        ...(workspaceId ? { workspaceId } : {}),
      }),
    )
    .catch((e: unknown) => failSoft(`resource-release-event for ${resource}`, e));
}

export interface GitSyncEventScope {
  /** The local harness/install slug that owns the git-sync routine. */
  installSlug: string;
  /** The workspace that owns the harness/install. */
  workspaceId: string;
}

/** Injectable seam for tests. */
export interface GitSyncEventsDeps {
  emit?: typeof emitAwaitedEvent;
  /** Production callers must provide the concrete harness/workspace scope. */
  scope: GitSyncEventScope;
}

/**
 * Additional commits that became covered by the remote staging head in this
 * bridge tick. The head itself is always emitted; these entries add precise
 * keys for commits carried by that head (normally the newly egressed range).
 */
export interface GitSyncEgressEventOptions {
  includedShas?: readonly string[];
}

/**
 * Fire-and-forget lock back-pressure detail. The event is global for
 * discoverability; install/workspace/resource fields in the payload let a
 * waiter narrow it to the tick it is judging.
 */
export function emitGitSyncLockRetryEvent(
  resource: string,
  reason: string,
  holders: readonly GitSyncLockHolderSnapshot[],
  deps: GitSyncEventsDeps,
): void {
  const emit = deps.emit ?? emitAwaitedEvent;
  void Promise.resolve()
    .then(() =>
      emit({
        key: GIT_SYNC_LOCK_RETRY_EVENT,
        summary: `git-sync retry pending on ${resource} (${reason})`,
        payload: {
          ...deps.scope,
          resource,
          reason,
          holders,
        },
        source: 'git-sync',
      }),
    )
    .catch((e: unknown) => failSoft(`lock-retry-event for ${resource}`, e));
}

function emitGitSyncEventPair(
  kind: 'committed' | 'egressed',
  sha: string,
  summary: string,
  deps: GitSyncEventsDeps,
  payloadExtra?: Record<string, unknown>,
): void {
  const emit = deps.emit ?? emitAwaitedEvent;
  const shortSha = sha.slice(0, 12);
  void Promise.resolve()
    .then(async () => {
      const payload = { sha, ...deps.scope, ...payloadExtra };
      await emit({ key: `git-sync:${kind}`, summary, payload, source: 'git-sync' });
      await emit({ key: `git-sync:${kind}:${sha}`, summary, payload, source: 'git-sync' });
    })
    .catch((e: unknown) => failSoft(`${kind}-event for ${shortSha}`, e));
}

/**
 * Fire the git-sync commit events for a landed head `sha`. Emits BOTH the global
 * `git-sync:committed` (payload-filtered) and the precise `git-sync:committed:<sha>`.
 * Fire-and-forget; never throws.
 */
export function emitGitSyncCommittedEvent(sha: string, deps: GitSyncEventsDeps): void {
  const shortSha = sha.slice(0, 12);
  // Capture this synchronously at the producer boundary. Capturing inside the
  // Promise below would timestamp the eventual dispatch instead, allowing a
  // delayed event from a prior sync cycle to look newer than a wait registered
  // after that cycle.
  const committedAtMs = Date.now();
  emitGitSyncEventPair(
    'committed',
    sha,
    `git-sync committed ${shortSha} in the local harness checkout`,
    deps,
    { committedAtMs },
  );
}

function emitGitSyncEgressEventPair(
  headSha: string,
  deps: GitSyncEventsDeps,
  options?: GitSyncEgressEventOptions,
): void {
  const emit = deps.emit ?? emitAwaitedEvent;
  const shortHeadSha = headSha.slice(0, 12);
  const exactShas = [...new Set([headSha, ...(options?.includedShas ?? [])].filter((sha) => sha.length > 0))];
  void Promise.resolve()
    .then(async () => {
      // The global key retains the actual remote staging head. Exact keys use
      // the SHA they name so a payload_filter on an ancestor also matches;
      // egressHead preserves the proof's actual remote tip for diagnostics.
      await emit({
        key: 'git-sync:egressed',
        summary: `git-sync egressed ${shortHeadSha} to origin/staging`,
        payload: { sha: headSha, egressHead: headSha, ...deps.scope },
        source: 'git-sync',
      });
      for (const sha of exactShas) {
        const shortSha = sha.slice(0, 12);
        await emit({
          key: `git-sync:egressed:${sha}`,
          summary:
            sha === headSha
              ? `git-sync egressed ${shortSha} to origin/staging`
              : `git-sync egressed ${shortHeadSha} to origin/staging (includes ancestor ${shortSha})`,
          payload: { sha, egressHead: headSha, ...deps.scope },
          source: 'git-sync',
        });
      }
    })
    .catch((e: unknown) => failSoft(`egressed-event for ${shortHeadSha}`, e));
}

/**
 * Fire only after the GitHub bridge proves `sha` is the remote staging head by a
 * successful push or an up-to-date comparison. Emits the global
 * `git-sync:egressed` key, the precise head key, and (when supplied) precise
 * keys for commits included as ancestors by that remote head. Fire-and-forget;
 * never throws.
 */
export function emitGitSyncEgressedEvent(
  sha: string,
  deps: GitSyncEventsDeps,
  options?: GitSyncEgressEventOptions,
): void {
  emitGitSyncEgressEventPair(sha, deps, options);
}
