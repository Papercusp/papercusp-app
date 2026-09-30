/**
 * replication-stall-orphan-sweep — closes the "orphaned forever" hole in the
 * replication-stall EI escalator (replication-stall-ei.ts).
 *
 * Root cause (found triaging the papercusp open-bug backlog, 2026-07-20): a
 * filed replication-stall EI (P-004 / WI-1840, WI-183 class) is auto-resolved
 * ONLY when a live process later re-observes the SAME (workspace, harness,
 * log) recover (`sampleReplicationLiveness`'s onRecovery leg) or explicitly
 * drops that log's tracking state (`dropReplicationLogState` /
 * `dropReplicationLiveness` → `reportDropRecoveries`). Both paths require a
 * process to be ALIVE and running under the target harness's identity.
 *
 * When the target harness is renamed or deleted, no future process will EVER
 * again report that (workspace, harness) pair, so its open stall EIs can
 * never receive a recovery sample or a drop call — they sit open FOREVER as
 * `major`-severity noise. Confirmed live: the papercup→papercusp rename alone
 * orphaned 30 open EIs (title `harness=papercup`) out of 133 open
 * `[replication-liveness]` bugs in the papercusp backlog — a permanent,
 * unresolvable class that will recur on every future harness rename/delete
 * unless swept.
 *
 * This sweep is the durable fix: periodically (see the `replicationStallOrphanSweep`
 * DBOS scheduled workflow in dbos/periodic-workflows.ts) list every OPEN
 * replication-stall EI, parse its target `workspace=… harness=…` (the same
 * fields `buildReplicationStallBody` always stamps into the EI body), and
 * auto-resolve any whose target harness no longer exists in that workspace's
 * harness registry. A harness that doesn't exist can, by construction, never
 * again produce a recovery sample — resolving is unconditionally safe and
 * loses no signal (a harness re-created under the same slug that re-stalls
 * files a fresh EI normally).
 *
 * Deliberately conservative: a harness that still EXISTS (even if currently
 * idle/dormant) is left untouched here, even though many of the papercusp
 * backlog's other open replication-stall EIs target long-abandoned one-off
 * test/dev harnesses that still have a registry row. Auto-closing those would
 * risk silently hiding a genuinely still-open defect on a harness that could
 * boot again; that needs a human/agent to positively verify current liveness
 * per item (see the per-episode manual resolutions this sweep's discovery
 * prompted), not a blanket time-based sweep.
 *
 * ⚠⚠ THE SELECTOR WAS THE BUG, AND IT MADE THIS SWEEP A STRUCTURAL NO-OP FOR
 * WEEKS (WI-37499, fixed 2026-08-09). It listed its candidates by the
 * `replication-liveness` TOPIC TAG. That tag is an INDEX over the detector's
 * population, written alongside each row; the population's real identity is the
 * stable TITLE the detector mints. The two diverge whenever a tag write is
 * missing — measured 2026-08-09 on the live store: 60 of 105 open rows carried no
 * topic edge at all, and the missing-tag set contained **100% of this sweep's
 * genuine targets** (6 orphans, the oldest 34.8 days old) while the 45 rows it
 * COULD see contained **zero**. Verified by running the sweep read-only with a
 * no-op resolver: `checked 45, orphanedTargets [], resolved 0`.
 *
 * That anti-correlation is not a coincidence to be explained away — an untagged
 * row is exactly the row that also escapes dedup (`listOpenByTopic`) and the
 * duplicate-collapse pass, so the neglected population accumulates in the one
 * place none of the three consumers can see. All three read that single tag, so
 * they went blind TOGETHER while each reported a clean pass.
 *
 * Two transferable rules, both earned here:
 *   1. Select a population by the property that DEFINES membership (the title
 *      this detector owns), never by a derived index over it. Where the index is
 *      still useful, UNION the two — neither leg is a superset (measured: 60 rows
 *      match the prefix but carry no tag; 4 tagged rows do not match the prefix).
 *   2. A sweep that can under-select to ZERO must SAY so. The tick logged only
 *      when it resolved something, so a blind pass and a correct no-op were
 *      byte-identical — see `OrphanSweepResult.skipped`.
 */

const TARGET_RE = /workspace=(\S+)\s+harness=(\S+)/;

/** Parse the `workspace=… harness=…` target stamped by buildReplicationStallBody. */
export function parseStallEiTarget(
  body: string,
): { workspaceId: string; harnessSlug: string } | null {
  const m = TARGET_RE.exec(body);
  if (!m) return null;
  return { workspaceId: m[1], harnessSlug: m[2] };
}

/** Resolver identity stamped on orphan-swept EIs — distinct from the normal
 *  recovery-sample RECOVERY_OWNER so the two closure reasons stay attributable. */
export const ORPHAN_SWEEP_OWNER = 'system:replication-liveness-orphan-sweep';

/** Max open EIs inspected per sweep pass (listIssues has no offset/cursor —
 *  a single pass covers the whole current backlog; a future overflow just
 *  converges over the next few daily runs instead of in one). */
const SWEEP_LIMIT = 1000;

export interface OrphanSweepDeps {
  listOpenReplicationStallEis(): Promise<Array<{ id: string; body: string }>>;
  harnessExists(workspaceId: string, harnessSlug: string): Promise<boolean>;
  resolve(id: string, note: string): Promise<void>;
}

export interface OrphanSweepResult {
  /** Open replication-stall EIs inspected this pass. */
  checked: number;
  /**
   * WI-37499: per-reason census of everything inspected but NOT resolved, so a
   * pass that saw NOTHING is distinguishable from one that correctly found no
   * orphan. Without it the two were byte-identical from outside — the tick only
   * logged when `resolvedIds.length > 0` — which is how this sweep ran daily for
   * weeks while blind to 100% of its real targets. Same lesson its sibling
   * (replication-liveness-staleness-sweep) recorded for itself.
   */
  skipped: {
    /** No parseable `workspace=… harness=…` target in the body. */
    unparseableTarget: number;
    /** Target harness still exists (the deliberate conservative no-op). */
    targetExists: number;
  };
  /** Distinct "workspace::harness" targets confirmed no longer to exist. */
  orphanedTargets: string[];
  /** EI ids actually auto-resolved. */
  resolvedIds: string[];
  /** Per-item resolve failures (best-effort — one failure never strands the rest). */
  errors: number;
}

/** A pass that inspected nothing (a bail-out). Shaped like a real result so the
 *  tick's census logging never has to special-case the failure paths. */
const EMPTY_SWEEP_RESULT = (): OrphanSweepResult => ({
  checked: 0,
  orphanedTargets: [],
  resolvedIds: [],
  errors: 0,
  skipped: { unparseableTarget: 0, targetExists: 0 },
});

async function defaultDeps(): Promise<OrphanSweepDeps> {
  const [
    { listIssues, setIssueState },
    { harnessExistsInWorkspace },
    { REPLICATION_LIVENESS_TOPIC, REPLICATION_STALL_EI_TITLE_PREFIX },
  ] =
    await Promise.all([
      import('../../issues-engineer'),
      import('../../device-harnesses'),
      import('./replication-stall-ei'),
    ]);
  return {
    listOpenReplicationStallEis: async () => {
      // WI-37499: the topic tag is an INDEX over this detector's population, not
      // its definition — and it is missing on most rows (measured 2026-08-09: 60
      // of 105 open, holding ALL 6 genuine orphans this sweep exists to close,
      // the oldest 34.8 days old). Select on the stable title too, and dedupe by
      // id. `excludeObservationLane` on both legs: an agent-filed observation can
      // carry a detector title verbatim and must never be auto-resolved (D-005).
      const [tagged, byTitle] = await Promise.all([
        listIssues({
          state: 'open',
          topic: REPLICATION_LIVENESS_TOPIC,
          limit: SWEEP_LIMIT,
          excludeObservationLane: true,
        }),
        listIssues({
          state: 'open',
          titlePrefix: REPLICATION_STALL_EI_TITLE_PREFIX,
          limit: SWEEP_LIMIT,
          excludeObservationLane: true,
        }),
      ]);
      const seen = new Set(tagged.map((i) => i.id));
      return [...tagged, ...byTitle.filter((i) => !seen.has(i.id))].map((i) => ({
        id: i.id,
        body: i.body,
      }));
    },
    harnessExists: harnessExistsInWorkspace,
    // A distinct resolver identity (not replication-stall-ei.ts's RECOVERY_OWNER)
    // so "closed because the target no longer exists" stays attributable/greppable
    // separately from a real recovery sample.
    resolve: async (id, note) => {
      await setIssueState(id, 'resolved', ORPHAN_SWEEP_OWNER, note);
    },
  };
}

/**
 * One sweep pass: resolve every open replication-stall EI whose target
 * harness no longer exists. Never throws — best-effort, mirrors the rest of
 * the episodic-ei machinery (a sweep hiccup must never wedge its scheduled
 * caller). Same VITEST-without-deps safety gate as episodic-ei.ts: a unit
 * test exercising other logic that transitively imports this module must
 * never touch production PG.
 */
export async function runReplicationStallOrphanSweepOnce(
  deps?: OrphanSweepDeps,
): Promise<OrphanSweepResult> {
  if (process.env.VITEST && !deps) {
    return EMPTY_SWEEP_RESULT();
  }
  let d: OrphanSweepDeps;
  try {
    d = deps ?? (await defaultDeps());
  } catch {
    return EMPTY_SWEEP_RESULT();
  }

  let open: Array<{ id: string; body: string }>;
  try {
    open = await d.listOpenReplicationStallEis();
  } catch {
    return EMPTY_SWEEP_RESULT();
  }

  const existsCache = new Map<string, boolean>();
  const orphanedTargets = new Set<string>();
  const resolvedIds: string[] = [];
  let errors = 0;
  const skipped = { unparseableTarget: 0, targetExists: 0 };

  for (const issue of open) {
    const target = parseStallEiTarget(issue.body);
    if (!target) {
      skipped.unparseableTarget += 1; // malformed/foreign body — never touched
      continue;
    }

    const cacheKey = `${target.workspaceId}::${target.harnessSlug}`;
    let exists = existsCache.get(cacheKey);
    if (exists === undefined) {
      try {
        exists = await d.harnessExists(target.workspaceId, target.harnessSlug);
      } catch {
        exists = true; // fail CLOSED on an uncertain existence check — never resolve
      }
      existsCache.set(cacheKey, exists);
    }
    if (exists) {
      skipped.targetExists += 1;
      continue;
    }

    orphanedTargets.add(cacheKey);
    try {
      await d.resolve(
        issue.id,
        `auto-resolved (orphan sweep): target harness '${target.harnessSlug}' no longer exists in ` +
          `workspace '${target.workspaceId}' — this replication-liveness stall can never receive a ` +
          `recovery sample (the harness was renamed, deleted, or never re-created), so it would ` +
          `otherwise stay open forever as noise. If a harness with this slug is re-created and ` +
          `re-stalls, a fresh alert files normally.`,
      );
      resolvedIds.push(issue.id);
    } catch {
      errors += 1;
    }
  }

  return { checked: open.length, orphanedTargets: [...orphanedTargets], resolvedIds, errors, skipped };
}
