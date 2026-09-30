/**
 * federation-join-stall-watchdog — WI-757 durable-fix part (b).
 *
 * THE GAP (fed-a/fed-b rig, 2026-06-24): a federation VM that loses its gh auth across a
 * restart throws inside `resolveLocalAnnounceIdentity` (local-announce-identity.ts);
 * boot.ts's `joinForBinding` catch records a `swarm_join_failed` boot-history event + a
 * `console.warn`, and the WI-752 retry loop keeps retrying on backoff — but nothing
 * ESCALATES a join that keeps failing. The harness silently stays local-only: it
 * announces nothing and receives no federated updates, with no loud signal anywhere
 * short of an operator manually reading stderr or the boot-history admin panel.
 *
 * Part (a) of WI-757's durable fix (persist/restore identity across a transient gh-auth
 * loss) was ALREADY implemented before this file: `resolveLocalAnnounceIdentity` falls
 * back to the cached `~/.papercusp/local-announce-identity.json` when re-resolving the gh
 * user fails (see local-announce-identity.ts's `identityFromCache` fallback), so a peer
 * that authenticated at least once keeps announcing across a later gh-auth blip with no
 * restart needed. That fallback can't help a device that has NEVER authenticated (nothing
 * to cache) — that case needs gh auth seeded at VM-provision time, an ops concern outside
 * this repo. This file is part (b): once a join has been failing for a SUSTAINED window
 * with no successful join since, say so loudly instead of staying silent.
 *
 * Process-level (NOT a DBOS routine) — mirrors green-stall-watchdog / git-sync-stall-
 * watchdog: a routine-based watchdog queues on the very engine that could be wedged.
 * Cheap here regardless: boot-history is an in-process ring (boot-history.ts), so a sweep
 * is a pure in-memory scan, no DB round-trip.
 *
 * State (which harnesses are currently alerted) is module-memory, not PG-persisted like
 * the sibling watchdogs' `watchdog_alerted` flag — boot-history itself is process-memory
 * and resets on restart, and a restart is also the one event that gives the join a fresh,
 * un-stalled attempt, so losing the alert flag across a restart is not a real gap (worst
 * case: one redundant alarm right after a restart if the new attempt also fails and stays
 * failed past the stale window again).
 *
 * Kill-switch: PAPERCUSP_FEDERATION_JOIN_STALL_WATCHDOG='0'.
 */
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { broadcastSevereEvent, broadcastSevereEventResolvedMany } from '../../severe-event-broadcast';
import { listBootHistory, type BootHistoryEntry } from './boot-history';

/** A `swarm_join_failed` sustained this long with no join_succeeded since is a real
 *  stall, not a one-shot boot blip — the WI-752 retry loop's exponential backoff will
 *  have already made several attempts well inside this window. */
export const DEFAULT_FEDERATION_JOIN_STALL_MS = 30 * 60 * 1000; // 30m
/** Sweep cadence — matches the sibling watchdogs (green/git-sync stall). */
export const DEFAULT_FEDERATION_JOIN_STALL_INTERVAL_MS = 15 * 60 * 1000; // 15m

export interface FederationJoinStallVerdict {
  stalled: boolean;
  /** ms since the latest swarm_join_failed, or null when not applicable (healthy / never
   *  attempted a join this process lifetime). */
  failedForMs: number | null;
  reason: string | null;
}

/**
 * Pure: decide whether ONE harness's latest join-outcome is a stall. `latest` is the most
 * recent of {join_succeeded, swarm_join_failed} boot-history entries for the harness
 * (join_started alone is not a verdict here — a stuck-on-first-await wedge is a distinct
 * class already covered by the WI-1910 witnesses). `null` = no join outcome recorded yet
 * this process lifetime — nothing to alarm on (a harness with no hive binding never
 * attempts a join at all, and correctly never appears here).
 *
 * Exported for unit testing; the boot-history read + module-memory de-dup live in
 * `checkFederationJoinStall`.
 */
export function evaluateFederationJoinStall(
  latest: Pick<BootHistoryEntry, 'kind' | 'ts' | 'message'> | null,
  now: number,
  staleMs: number = DEFAULT_FEDERATION_JOIN_STALL_MS,
): FederationJoinStallVerdict {
  if (!latest || latest.kind !== 'swarm_join_failed') {
    return { stalled: false, failedForMs: null, reason: null };
  }
  const failedForMs = now - latest.ts;
  if (failedForMs <= staleMs) {
    return { stalled: false, failedForMs, reason: null };
  }
  const mins = Math.round(failedForMs / 60_000);
  return {
    stalled: true,
    failedForMs,
    reason:
      `swarm join has been failing for ~${mins}m with no successful join since ` +
      `(last error: "${(latest.message ?? 'unknown').slice(0, 200)}") — this peer is ` +
      `silently LOCAL-ONLY: it announces nothing and receives no federated updates.`,
  };
}

/** Per-harness latest of {join_succeeded, swarm_join_failed} across the in-process
 *  boot-history ring. `listBootHistory` returns newest-first, so the first entry seen
 *  per `workspaceId:harnessSlug` key is already the latest for that harness. */
function latestJoinOutcomesByHarness(): Map<string, BootHistoryEntry> {
  const out = new Map<string, BootHistoryEntry>();
  for (const entry of listBootHistory({ kinds: ['join_succeeded', 'swarm_join_failed'], limit: 500 })) {
    const key = `${entry.workspaceId}:${entry.harnessSlug}`;
    if (!out.has(key)) out.set(key, entry);
  }
  return out;
}

/** `workspaceId:harnessSlug` keys currently alarmed by US (one-shot until recovery). */
const alerted = new Set<string>();

/** test-only: clear the module-memory alert de-dup set between test cases. */
export function _resetFederationJoinStallAlertsForTests(): void {
  alerted.clear();
}

export interface FederationJoinStallCheckResult {
  alarmed: string[];
  recovered: string[];
}

/** One watchdog pass over the whole boot-history ring. Never throws. */
export async function checkFederationJoinStall(
  staleMs: number = DEFAULT_FEDERATION_JOIN_STALL_MS,
): Promise<FederationJoinStallCheckResult> {
  const out: FederationJoinStallCheckResult = { alarmed: [], recovered: [] };
  try {
    const now = Date.now();
    const latestByHarness = latestJoinOutcomesByHarness();
    const recoveredKeys: string[] = [];
    for (const [key, entry] of latestByHarness) {
      const verdict = evaluateFederationJoinStall(entry, now, staleMs);
      const wasAlerted = alerted.has(key);
      if (verdict.stalled) {
        if (wasAlerted) continue; // one-shot until recovery
        alerted.add(key);
        const summary = `federation join STALLED on ${entry.harnessSlug} — ${verdict.reason}`;
        try {
          const { notifyAttention } = await import('../../attention-notify');
          await notifyAttention({
            kind: 'intervention',
            title: 'Federation join stalled — peer is silently local-only',
            body: summary,
            importance: 'urgent',
            workspaceId: entry.workspaceId,
            harnessSlug: entry.harnessSlug,
            data: { failedForMs: verdict.failedForMs },
          });
        } catch (e) {
          console.warn(`[federation-join-stall-watchdog] notify failed: ${e instanceof Error ? e.message : e}`);
        }
        await broadcastSevereEvent({
          summary,
          body:
            `${verdict.reason}\n\nCommon cause: gh auth was lost across a restart (see ` +
            `local-announce-identity.ts) and no cached identity was available to fall back on. ` +
            `Fix: re-authenticate gh on this box (\`gh auth login\`) — the WI-752 retry loop picks ` +
            `up the next successful join automatically, no operator restart needed.`,
          category: 'severe-event',
          conditionKey: `federation-join-stall:${key}`,
          // WI-6228: one-shot until recovery (`wasAlerted` below) — our silence is
          // deliberate, never evidence the join succeeded.
          oneShot: true,
        });
        out.alarmed.push(key);
        console.warn(`[federation-join-stall-watchdog] ALARM ${key}: ${verdict.reason}`);
      } else if (wasAlerted) {
        alerted.delete(key);
        recoveredKeys.push(key);
        out.recovered.push(key);
      }
    }
    if (recoveredKeys.length > 0) {
      await broadcastSevereEventResolvedMany({
        conditionKeys: recoveredKeys.map((key) => `federation-join-stall:${key}`),
        summary:
          recoveredKeys.length === 1
            ? `federation join RECOVERED on ${recoveredKeys[0]} — the earlier stall alarm is stale.`
            : `federation join RECOVERED on ${recoveredKeys.length} harnesses (${recoveredKeys.join(', ')}) — the earlier stall alarms are stale.`,
      });
    }
    return out;
  } catch (e) {
    console.warn(`[federation-join-stall-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Start the watchdog: an immediate boot check + a recurring process-level sweep. Idempotent.
 * Kill-switch: PAPERCUSP_FEDERATION_JOIN_STALL_WATCHDOG='0'.
 */
export function startFederationJoinStallWatchdog(
  opts: { staleMs?: number; intervalMs?: number } = {},
): void {
  if (process.env.PAPERCUSP_FEDERATION_JOIN_STALL_WATCHDOG === '0') return;
  const staleMs = opts.staleMs ?? DEFAULT_FEDERATION_JOIN_STALL_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_FEDERATION_JOIN_STALL_INTERVAL_MS;

  const run = (): void => {
    void checkFederationJoinStall(staleMs).then((r) => {
      if (r.alarmed.length > 0) {
        console.warn(`[federation-join-stall-watchdog] alarmed on: ${r.alarmed.join(', ')}`);
      }
    });
  };

  run(); // boot check
  if (watchdogTimer) watchdogTimer.stop();
  watchdogTimer = managedSetInterval('federation-join-stall-watchdog', intervalMs, run, { category: 'watchdog' });
}
