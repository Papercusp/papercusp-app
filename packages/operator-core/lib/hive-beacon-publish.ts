/**
 * hive-beacon-publish — sources the live signals for a Hive's status beacon and
 * builds it, consent-gated (hive-network-surface-2026-06-11 P-005 / brief B-06).
 *
 * The beacon piggybacks on the directory re-announce: the directory's
 * announce-build enrich seam (hive-descriptor-enrich) calls `maybeBuildHiveBeacon`
 * for each owned hive, and the result (when consented) rides the announce. So the
 * publish cadence is exactly the re-announce cadence — no separate timer.
 *
 * Signals (all per-hive, all cheap — two reads behind a short memo):
 *   - liveAgents     ← distinct live agents on the hive (fleet:assignments, the
 *                       same count pot:list shows).
 *   - queueDepth/    ← one listWorkItems({harness}) call, partitioned by terminal
 *     focus/           state: non-terminal items count toward the queue and the
 *     lastCompleted    newest non-terminal title is the "focus"; the newest
 *                       terminal title is "lastCompleted".
 *   - consent        ← getBeaconPublishConsent (brief B-07's beacon-consent.ts) —
 *                       absent = OFF; no consent ⇒ maybeBuildHiveBeacon returns
 *                       undefined and nothing goes on the wire.
 *
 * NOTE on the focus source: P-005/B-06 named `curation:state-of-pot`, but that
 * digest is a WORKSPACE-GLOBAL meta-pattern rollup (no per-hive scope) and runs
 * a multi-corpus synthesis — the wrong granularity AND too heavy for the
 * per-announce path. The work-item backlog gives a genuinely per-hive, cheap
 * "what is this hive working on" that matches the C-2 field semantics. The C-2
 * payload shape (the consumer contract) is unchanged; only the internal source
 * differs.
 *
 * The signal sources are injected (BeaconSignalSources) so the build unit-tests
 * without PG; production wires `defaultBeaconSignalSources` lazily.
 */

import { makeBeacon, type HiveStatusBeacon } from './hive-beacon';

/** The per-hive signals a beacon summarizes — injected so the build is testable. */
export interface BeaconSignalSources {
  /** Distinct live agents working the hive right now. */
  liveAgents(workspaceId: string, potSlug: string): Promise<number>;
  /** Queue depth + the focus/last-completed one-liners, from the hive's backlog. */
  workSignals(
    workspaceId: string,
    potSlug: string,
  ): Promise<{ queueDepth: number; focus: string; lastCompleted: string }>;
  /** PUBLISH consent gate (absent = OFF). */
  consented(workspaceId: string, potSlug: string): Promise<boolean>;
  /** Clock (ms). */
  now(): number;
}

/** Production signal sources — lazy imports keep this module light. */
export function defaultBeaconSignalSources(): BeaconSignalSources {
  return {
    now: () => Date.now(),

    liveAgents: async (workspaceId, potSlug) => {
      const { listFleetAssignments } = await import('./fleet/assignments');
      const { liveAgentCountByHarness } = await import('./agent-tools/pot/_resolve');
      const rows = await listFleetAssignments({ workspaceId });
      return liveAgentCountByHarness(rows).get(potSlug) ?? 0;
    },

    workSignals: async (_workspaceId, potSlug) => {
      const { listWorkItems, isSettledWorkItemState } = await import('./work-items');
      // newest updatedAt first (listWorkItems default order).
      const items = await listWorkItems({ harness: potSlug, limit: 200 });
      let queueDepth = 0;
      let focus = '';
      let lastCompleted = '';
      for (const wi of items) {
        if (isSettledWorkItemState(wi.state)) {
          if (!lastCompleted) lastCompleted = wi.title;
        } else {
          queueDepth += 1;
          if (!focus) focus = wi.title;
        }
      }
      return { queueDepth, focus, lastCompleted };
    },

    consented: async (workspaceId, potSlug) => {
      const { getBeaconPublishConsent } = await import('./beacon-consent');
      return getBeaconPublishConsent(workspaceId, potSlug);
    },
  };
}

/**
 * Build the beacon from the live signals (NO consent check — the caller gates).
 * Each source is independently best-effort: one failing signal degrades that
 * field, never the whole beacon.
 */
export async function buildHiveBeacon(
  workspaceId: string,
  potSlug: string,
  sources: BeaconSignalSources,
): Promise<HiveStatusBeacon> {
  const [liveAgents, work] = await Promise.all([
    sources.liveAgents(workspaceId, potSlug).catch(() => 0),
    sources
      .workSignals(workspaceId, potSlug)
      .catch(() => ({ queueDepth: 0, focus: '', lastCompleted: '' })),
  ]);
  return makeBeacon({
    liveAgents,
    queueDepth: work.queueDepth,
    focus: work.focus,
    lastCompleted: work.lastCompleted,
    ts: new Date(sources.now()).toISOString(),
  });
}

// ── Memo ──────────────────────────────────────────────────────────────────────
// The enrich seam runs on EVERY announce build — the 5-min re-announce timer AND
// every fresh-pair snapshot (one per new peer connection). Without a memo a burst
// of peer connections would refire the signal reads per connection. A short memo
// (default 60s, well under the re-announce cadence) collapses that to the intended
// "refreshed on the re-announce cadence" while keeping the beacon ts fresh enough
// for a 7-day discovered-hive TTL. Mirrors the throttle in hive-directory-boot's
// `ensureHiveDirectoryWired` — an ephemeral recomputation guard, not durable state.

interface BeaconMemoEntry {
  atMs: number;
  beacon: HiveStatusBeacon | undefined;
}
const memo = new Map<string, BeaconMemoEntry>();

/** Default memo TTL — refresh the beacon at most this often per hive. */
export const BEACON_MEMO_TTL_MS = 60_000;

export interface MaybeBuildBeaconOpts {
  /** Override the signal sources (tests). Default: defaultBeaconSignalSources(). */
  sources?: BeaconSignalSources;
  /** Memo TTL override (ms). Default BEACON_MEMO_TTL_MS; 0 disables the memo. */
  ttlMs?: number;
}

/**
 * The publish gate the enrich seam calls: returns the consent-gated beacon for a
 * hive, or undefined when the owner has NOT consented (so nothing goes on the
 * wire) — memoized on the re-announce cadence. Fully best-effort: any failure
 * (consent read, signal read) yields undefined, never a throw, so the directory
 * announce path is never broken by the beacon.
 */
export async function maybeBuildHiveBeacon(
  workspaceId: string,
  potSlug: string,
  opts: MaybeBuildBeaconOpts = {},
): Promise<HiveStatusBeacon | undefined> {
  const sources = opts.sources ?? defaultBeaconSignalSources();
  const ttlMs = opts.ttlMs ?? BEACON_MEMO_TTL_MS;
  const key = `${workspaceId}\x00${potSlug}`;
  const now = sources.now();

  if (ttlMs > 0) {
    const cached = memo.get(key);
    if (cached && now - cached.atMs < ttlMs) return cached.beacon;
  }

  let beacon: HiveStatusBeacon | undefined;
  try {
    const ok = await sources.consented(workspaceId, potSlug).catch(() => false);
    beacon = ok ? await buildHiveBeacon(workspaceId, potSlug, sources) : undefined;
  } catch {
    beacon = undefined;
  }

  if (ttlMs > 0) memo.set(key, { atMs: now, beacon });
  return beacon;
}

/** Test seam: clear the memo so the next maybeBuildHiveBeacon recomputes. */
export function __resetBeaconPublishMemoForTest(): void {
  memo.clear();
}
