/**
 * useInboxBulkRun — the Inbox BULK RESOLVE run's client seam
 * (inbox-bulk-resolve-2026-08-23, P-006).
 *
 * ONE sync subscription (`plans.attentionBulkRun`) plus the four owner-side ops
 * the command strip fires. Split out of InboxPane so the pane keeps its single
 * responsibility — rendering the attention feed — and so the strip's behavior is
 * unit-testable without mounting a virtualized list.
 *
 * REUSE, not re-derivation. The run's state lives in Postgres and arrives on the
 * SAME SSE-invalidated sync transport every other pane query uses, so:
 *   - reopening the pane resumes into the run's current phase instead of losing
 *     it to unmounted component state (Requirement 7), and
 *   - the resolver agent's writes reach the strip by the same push the rest of
 *     the app uses — no polling loop of our own.
 *
 * ⚠ ACCEPTING A RECOMMENDATION DISPATCHES THE CLIENT PATH, NOT A SERVER RE-DERIVE.
 * `acceptRecommendation` calls `resolveAttentionAction` / `replyToAttentionItem`
 * from attention-card.ts — the exact helpers a hand resolve uses — and only THEN
 * records the acceptance on the run. That ordering is the point (D-003): the
 * asker wake, the provenance and the triage audit note are produced by one
 * implementation, so a bulk accept and a hand resolve can never drift apart. The
 * record write is deliberately second and best-effort: an accepted item whose
 * bookkeeping write failed is a stale counter, while a recorded acceptance whose
 * resolve failed is a LIE about something done on the owner's behalf.
 */
import { useCallback, useMemo, useState } from "react";
import { useSyncQuery } from "@papercusp/sync";
import type { AttentionItem } from "@/app/admin/plans/plans-api";
import {
  isNavigateAction,
  replyToAttentionItem,
  resolveAttentionAction,
} from "@/app/admin/plans/attention-card";
import type {
  BulkResolverLaunchProfile,
  EffectiveBulkResolverLaunch,
} from "@papercusp/operator-core/lib/agent-config-constants";
import type { RunLiveness } from "@papercusp/operator-core/lib/attention/bulk-run-store";
import type {
  BulkAutomationPolicy,
  BulkConfidence,
  BulkDispositionKind,
  BulkRecommendation,
  BulkRecommendationKind,
  BulkResponsibility,
} from "@papercusp/operator-core/lib/attention/bulk-dispositions";
import { canonicalDispositionForRow } from "@papercusp/operator-core/lib/attention/bulk-dispositions";
import { loadResolverLaunchProfile } from "../bulk-resolver/bulk-resolver-settings";

/** Mirrors `BulkRunPhase` in packages/operator-core/lib/attention/bulk-run-store.ts. */
export type BulkRunPhase =
  | "pending"
  | "running"
  | "review"
  | "complete"
  | "failed";

/** URL-owned run reference. It is the running-strip deep link first, then the
 * grouped report takeover key when the persisted phase reaches `review`. */
export const INBOX_BULK_RUN_PARAM = "opcbr";

/** Mirrors `BulkItemOutcome` in the same store. */
export type BulkItemOutcome =
  | "pending"
  | "auto_resolved"
  | "recommended"
  | "skipped"
  | "failed"
  | "dismissed";

/** The run row as the sync query returns it (`BulkRunRow` on the wire). */
export interface BulkRun {
  runId: string;
  /** Scope persisted with the run. Null for cross-harness Inbox snapshots. */
  harnessSlug?: string | null;
  phase: BulkRunPhase;
  totalItems: number;
  autoResolved: number;
  recommended: number;
  skipped: number;
  failed: number;
  error: string | null;
  /** Exact settings persisted at click time; empty only on legacy rows. */
  launchSnapshot?: Partial<EffectiveBulkResolverLaunch>;
  filterSnapshot?: {
    tier?: string | null;
    kinds?: string[];
    query?: string | null;
    shownCount?: number | null;
  };
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt?: string | null;
  resolverOwner?: string | null;
  liveness?: RunLiveness;
  automationPolicy?: BulkAutomationPolicy;
}

/** One item's outcome as the sync query returns it (`BulkRunItemRow`). */
export interface BulkRunItem {
  runId: string;
  itemId: string;
  position: number;
  kind: string | null;
  title: string | null;
  /** Click-time terminal-dispatch coordinates from `item_ref`. */
  ref: Record<string, unknown>;
  /** Click-time asker/owner identity used by drafted reply delivery. */
  ownerAgentId: string | null;
  outcome: BulkItemOutcome;
  actionId: string | null;
  rationale: string | null;
  draftAnswer: string | null;
  confidence: "low" | "high" | null;
  consulted: boolean;
  consultReply: string | null;
  error: string | null;
  decidedAt: string | null;
  disposition?: BulkDispositionKind;
  legacyDisposition?: string | null;
  recommendation?: BulkRecommendation | null;
  recommendationKind?: BulkRecommendationKind | null;
  recommendationLabel?: string | null;
  recommendationRationale?: string | null;
  evidenceBasis?: string[];
  responsibility?: BulkResponsibility | null;
  confidenceLevel?: BulkConfidence | null;
  retryCondition?: string | null;
  revertHandle?: Record<string, unknown> | null;
  reversalWindowUntil?: string | null;
  revertedAt?: string | null;
  revertNote?: string | null;
}

export interface BulkRunState {
  run: BulkRun | null;
  items: BulkRunItem[];
  /** Item-id → outcome row, for the per-row status badges. */
  byItemId: Map<string, BulkRunItem>;
  /** Items still awaiting the owner's call. */
  recommendations: BulkRunItem[];
  /**
   * Rows eligible for a continuation pass: pending, skipped, or failed.
   * Recommendations remain in the owner-review queue; auto-resolved and
   * dismissed rows are terminal and must not be requeued.
   */
  unreached: BulkRunItem[];
  /** The run is live: the resolver is still working. */
  isRunning: boolean;
  /** The run is waiting on the owner. */
  isReview: boolean;
  loading: boolean;
}

/** What a start POST hands back. */
export interface StartResult {
  ok: boolean;
  runId?: string;
  phase?: BulkRunPhase | null;
  launched?: boolean;
  launchError?: string;
  preservedOutcomes?: number;
  error?: string;
}

export interface BulkAcceptResult {
  ok: boolean;
  error?: string;
  phase?: BulkRunPhase | null;
}

/** The seed one item contributes to a run — the pane's own snapshot of it. */
export interface BulkSeedItem {
  itemId: string;
  kind: string;
  title: string | null;
  ref: unknown;
  ownerAgentId: string | null;
}

const ENDPOINT = "/api/admin/attention-bulk-resolve";

/** Phases in which the strip is showing a live run rather than its idle button. */
export function isActivePhase(phase: BulkRunPhase | null | undefined): boolean {
  return phase === "pending" || phase === "running" || phase === "review";
}

/**
 * Select the unresolved Inbox rows that the saved-run resume operation can
 * safely requeue. `resumeReviewRun` preserves owner decisions (`recommended`)
 * and terminal outcomes (`auto_resolved`/`dismissed`), so the client must use
 * the same boundary instead of treating only `pending` rows as continuable.
 */
export function isContinuableBulkRunItem(
  item: Pick<
    BulkRunItem,
    | "outcome"
    | "disposition"
    | "kind"
    | "title"
    | "error"
    | "rationale"
    | "itemId"
  >,
): boolean {
  if (item.outcome === "pending" || item.outcome === "failed") return true;
  if (item.outcome !== "skipped") return false;
  // Pre-1015/fixture rows carry no disposition metadata. Preserve the shipped
  // continuation behavior for those rows; once the migration/classifier has
  // supplied a disposition, only retry_needed is safe to bulk-requeue.
  if (item.disposition === undefined) return true;
  const disposition = canonicalDispositionForRow({
    outcome: item.outcome,
    disposition: item.disposition,
    itemKind: item.kind,
    title: item.title,
    error: item.error,
    rationale: item.rationale,
    itemId: item.itemId,
  }).disposition;
  return disposition === "retry_needed";
}

/** Resolve the canonical typed disposition for a wire row, including legacy
 * `skipped` rows that the migration has not yet explicitly reclassified. */
export function canonicalInboxDisposition(
  item: BulkRunItem,
): BulkDispositionKind {
  if (item.outcome === "recommended" && item.recommendation?.kind) {
    return item.recommendation.kind;
  }
  return canonicalDispositionForRow({
    outcome: item.outcome,
    disposition: item.disposition,
    itemKind: item.kind,
    title: item.title,
    error: item.error,
    rationale: item.rationale,
    itemId: item.itemId,
  }).disposition;
}

/**
 * The strip's headline counts. Derived from the ITEM ROWS, never from the run's
 * denormalized counters: the counters are recomputed asynchronously after each
 * report, so during a run they can trail the rows the same render is showing —
 * and a progress bar that disagrees with the list beneath it reads as a bug in
 * the resolver rather than in the arithmetic.
 */
export function deriveRunCounts(
  items: BulkRunItem[],
  run: BulkRun | null,
): {
  total: number;
  resolved: number;
  forReview: number;
  recommendationTotal: number;
  pending: number;
  skipped: number;
  failed: number;
  legacySkipped: number;
  ownerAction: number;
  cleanupCandidate: number;
  retryNeeded: number;
  routed: number;
  investigate: number;
  dismissed: number;
  unresolved: number;
  left: number;
  decided: number;
  percent: number;
} {
  let resolved = 0;
  let forReview = 0;
  let pending = 0;
  let skipped = 0;
  let failed = 0;
  let legacySkipped = 0;
  let ownerAction = 0;
  let cleanupCandidate = 0;
  let retryNeeded = 0;
  let routed = 0;
  let investigate = 0;
  let dismissed = 0;
  for (const i of items) {
    const disposition = canonicalInboxDisposition(i);
    if (i.outcome === "auto_resolved") resolved += 1;
    else if (i.outcome === "recommended") {
      if (disposition === "recommended") forReview += 1;
    } else if (i.outcome === "pending") pending += 1;
    else if (i.outcome === "skipped") {
      skipped += 1;
      if (
        i.disposition === undefined ||
        i.disposition === "legacy_skipped" ||
        i.legacyDisposition === "legacy_skipped"
      ) {
        legacySkipped += 1;
      }
    } else if (i.outcome === "dismissed") dismissed += 1;
    else if (i.outcome === "failed") failed += 1;
    if (i.outcome === "recommended") {
      // Typed recommendations are accounted for in their disposition bucket;
      // retain a total for the headline without double-counting unresolved work.
    }
    if (disposition === "owner_action") ownerAction += 1;
    else if (disposition === "cleanup_candidate") cleanupCandidate += 1;
    else if (disposition === "retry_needed") retryNeeded += 1;
    else if (disposition === "routed") routed += 1;
    else if (disposition === "investigate") investigate += 1;
  }
  // `totalItems` is authoritative for the DENOMINATOR even when rows are still
  // arriving: the run knows how many items it was handed, and dividing by the
  // rows received so far would show a bar that sits at 100% from the first
  // report and slides BACKWARD as more rows land.
  const total = run?.totalItems ?? items.length;
  const decided = items.filter((item) => item.outcome !== "pending").length;
  return {
    total,
    resolved,
    forReview,
    recommendationTotal: items.filter((i) => i.outcome === "recommended")
      .length,
    pending,
    skipped,
    failed,
    legacySkipped,
    ownerAction,
    cleanupCandidate,
    retryNeeded,
    routed,
    investigate,
    dismissed,
    unresolved:
      forReview +
      pending +
      ownerAction +
      cleanupCandidate +
      retryNeeded +
      routed +
      investigate +
      failed,
    decided,
    left: Math.max(0, total - decided),
    percent: total > 0 ? Math.min(100, Math.round((decided / total) * 100)) : 0,
  };
}

async function postOp(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = json?.error as { message?: string } | undefined;
    throw new Error(
      err?.message ??
        `bulk-resolve ${String(body.op ?? "start")} failed (${res.status})`,
    );
  }
  return json;
}

/**
 * Subscribe to the run the strip should be showing.
 *
 * `runId` is the `?opcbr=` deep link. Passing none reads the workspace's LATEST
 * run, which is the pane's real opening question ("is there a run I should be
 * showing?") — see the resolver's note in sync-resolver/index.ts.
 */
export function useInboxBulkRun(
  runId?: string | null,
  opts?: { enabled?: boolean },
): BulkRunState {
  // `enabled:false` holds NO subscription — a flag-off pane must not keep a
  // live query open for a surface it never renders. The hook is still called
  // unconditionally (hooks cannot be branched), so the gate belongs here rather
  // than at the call site.
  const enabled = opts?.enabled !== false;
  const { data, loading } = useSyncQuery<{
    run: BulkRun | null;
    items: BulkRunItem[];
  }>({
    queryName: "plans.attentionBulkRun",
    args: runId ? { runId } : {},
    enabled,
  });

  const row = Array.isArray(data)
    ? data[0]
    : (data as { run?: BulkRun | null } | undefined);
  const run = (row?.run ?? null) as BulkRun | null;
  const items = useMemo(
    () =>
      ((row as { items?: BulkRunItem[] } | undefined)?.items ??
        []) as BulkRunItem[],
    [row],
  );

  return useMemo(() => {
    const byItemId = new Map<string, BulkRunItem>();
    for (const i of items) byItemId.set(i.itemId, i);
    return {
      run,
      items,
      byItemId,
      recommendations: items.filter((i) => i.outcome === "recommended"),
      unreached: items.filter(isContinuableBulkRunItem),
      isRunning: run?.phase === "running" || run?.phase === "pending",
      isReview: run?.phase === "review",
      loading: Boolean(loading),
    };
  }, [run, items, loading]);
}

/** The owner-side ops, as stable callbacks. */
export function useBulkRunOps(): {
  start: (
    items: BulkSeedItem[],
    filter: Record<string, unknown>,
    harness?: string | null,
    launch?: BulkResolverLaunchProfile,
  ) => Promise<StartResult>;
  stop: (runId: string) => Promise<void>;
  restart: (runId: string) => Promise<StartResult>;
  resume: (runId: string, itemIds: readonly string[]) => Promise<StartResult>;
  reclassify: (
    runId: string,
    itemIds?: readonly string[],
  ) => Promise<StartResult>;
  dismiss: (runId: string) => Promise<void>;
  dismissItem: (
    runId: string,
    itemId: string,
    note?: string | null,
  ) => Promise<BulkAcceptResult>;
  reconcileItem: (runId: string, itemId: string) => Promise<BulkAcceptResult>;
  undoItem: (runId: string, itemId: string) => Promise<BulkAcceptResult>;
  acceptRecommendation: (
    runId: string,
    item: AttentionItem,
    rec: BulkRunItem,
  ) => Promise<BulkAcceptResult>;
} {
  const start = useCallback(
    async (
      seed: BulkSeedItem[],
      filter: Record<string, unknown>,
      harness?: string | null,
      launch?: BulkResolverLaunchProfile,
    ): Promise<StartResult> => {
      try {
        const clickTimeLaunch =
          launch ?? (await loadResolverLaunchProfile("inbox-resolve"));
        const json = await postOp({
          items: seed,
          filter,
          launch: clickTimeLaunch,
          ...(harness ? { harness } : {}),
        });
        return {
          ok: true,
          runId: typeof json.runId === "string" ? json.runId : undefined,
          launched: json.launched === true,
          launchError:
            typeof json.launchError === "string" ? json.launchError : undefined,
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    [],
  );

  const stop = useCallback(async (runId: string) => {
    await postOp({ op: "stop", runId });
  }, []);

  const restart = useCallback(async (runId: string): Promise<StartResult> => {
    try {
      const json = await postOp({ op: "restart", runId });
      return {
        ok: true,
        runId,
        launched: json.launched === true,
        launchError:
          typeof json.launchError === "string" ? json.launchError : undefined,
        preservedOutcomes:
          typeof json.preservedOutcomes === "number"
            ? json.preservedOutcomes
            : undefined,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, []);

  const dismiss = useCallback(async (runId: string) => {
    await postOp({ op: "dismiss", runId });
  }, []);

  const resume = useCallback(
    async (
      runId: string,
      rawItemIds: readonly string[],
    ): Promise<StartResult> => {
      const itemIds = [
        ...new Set(rawItemIds.map((id) => id.trim()).filter(Boolean)),
      ];
      try {
        const json = await postOp({ op: "resume", runId, itemIds });
        return {
          ok: true,
          runId,
          phase:
            typeof json.phase === "string"
              ? (json.phase as BulkRunPhase)
              : json.phase === null
                ? null
                : undefined,
          launched: json.launched === true,
          launchError:
            typeof json.launchError === "string" ? json.launchError : undefined,
          preservedOutcomes:
            typeof json.preservedOutcomes === "number"
              ? json.preservedOutcomes
              : undefined,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    [],
  );

  const reclassify = useCallback(
    async (
      runId: string,
      itemIds?: readonly string[],
    ): Promise<StartResult> => {
      try {
        const json = await postOp({
          op: "reclassify",
          runId,
          ...(itemIds && itemIds.length > 0 ? { itemIds } : {}),
        });
        return {
          ok: true,
          runId,
          phase: (json.phase as BulkRunPhase | null | undefined) ?? null,
          preservedOutcomes: Number(json.reclassified ?? 0),
          launched: false,
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    [],
  );

  const dismissItem = useCallback(
    async (
      runId: string,
      itemId: string,
      note?: string | null,
    ): Promise<BulkAcceptResult> => {
      try {
        const json = await postOp({
          op: "dismiss-item",
          runId,
          itemId,
          note: note ?? null,
        });
        return {
          ok: true,
          phase:
            typeof json.phase === "string"
              ? (json.phase as BulkRunPhase)
              : json.phase === null
                ? null
                : undefined,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    [],
  );

  const reconcileItem = useCallback(
    async (runId: string, itemId: string): Promise<BulkAcceptResult> => {
      try {
        const json = await postOp({ op: "reconcile-item", runId, itemId });
        return {
          ok: true,
          phase:
            typeof json.phase === "string"
              ? (json.phase as BulkRunPhase)
              : json.phase === null
                ? null
                : undefined,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    [],
  );

  const undoItem = useCallback(
    async (runId: string, itemId: string): Promise<BulkAcceptResult> => {
      try {
        await postOp({ op: "undo-item", runId, itemId });
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    [],
  );

  const acceptRecommendation = useCallback(
    async (runId: string, item: AttentionItem, rec: BulkRunItem) => {
      const actionId = rec.actionId;
      if (!actionId)
        return { ok: false, error: "recommendation names no action" };

      // A navigate-only option opens a sub-surface and resolves NOTHING. Accepting
      // one would record a resolution that never happened — the exact defect that
      // once let Discuss silently close real owner gates (EI-13037). `answer` has
      // one deliberately narrow bulk-review exception: when the resolver supplied
      // non-empty reply text, accepting it dispatches that text through the same
      // helper as a hand-authored Answer. The shared taxonomy stays unchanged.
      const draftedAnswer =
        actionId === "answer" ? rec.draftAnswer?.trim() : undefined;
      if (isNavigateAction(actionId) && !draftedAnswer) {
        return {
          ok: false,
          error: `"${actionId}" only opens a view — it resolves nothing`,
        };
      }

      try {
        // RESOLVE FIRST, RECORD SECOND (see the file header). Only the real
        // `answer` action may turn a draft into a reply; stray draft text on any
        // other recommendation must not change that action's dispatch semantics.
        const outcome = draftedAnswer
          ? await replyToAttentionItem(item, draftedAnswer)
          : await resolveAttentionAction(item, actionId);
        if (!outcome.resolved) {
          return { ok: false, error: "the item did not accept that action" };
        }

        const recorded = await postOp({
          op: "accept",
          runId,
          itemId: rec.itemId,
          actionId,
          note: rec.rationale ?? null,
        });
        const phase = recorded.phase;
        return {
          ok: true,
          phase:
            typeof phase === "string" &&
            ["pending", "running", "review", "complete", "failed"].includes(
              phase,
            )
              ? (phase as BulkRunPhase)
              : null,
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    [],
  );

  return {
    start,
    stop,
    restart,
    resume,
    reclassify,
    dismiss,
    dismissItem,
    reconcileItem,
    undoItem,
    acceptRecommendation,
  };
}

/**
 * The owner's GESTURES over one run — stop, restart, resume, reclassify — as
 * handlers that carry their own busy flag and report back through ONE notice
 * line. Extracted from InboxBulkStrip so the rail card and the aside's run
 * views (inbox-three-column-resolver-states-2026-09-06 P-006 / P-007, D-002)
 * fire the SAME ops with the SAME copy. Each mount keeps its own notice: a
 * surface reports the outcome of the gesture made ON it, not on its twin.
 */
export interface BulkRunActions {
  /** Passed through for the idle state's Start, which needs the pane's seed. */
  start: ReturnType<typeof useBulkRunOps>["start"];
  stop: () => void;
  /** Relaunches the resolver on the SAME run with its click-time settings;
   *  completed outcomes are never reset (`restartRun` in bulk-run-store). */
  restart: () => Promise<void>;
  /** Requeues only the `unreached` rows (pending / skipped / failed). */
  resume: () => Promise<void>;
  reclassify: () => Promise<void>;
  restarting: boolean;
  resuming: boolean;
  classifying: boolean;
  notice: string | null;
  setNotice: (notice: string | null) => void;
}

const NO_UNREACHED: readonly BulkRunItem[] = [];

export function useBulkRunActions(
  run: BulkRun | null,
  unreached: readonly BulkRunItem[] = NO_UNREACHED,
): BulkRunActions {
  // The individual ops are stable callbacks; the object that carries them is
  // not, so destructure rather than depend on it.
  const {
    start,
    stop: stopOp,
    restart: restartOp,
    resume: resumeOp,
    reclassify: reclassifyOp,
  } = useBulkRunOps();
  const [restarting, setRestarting] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const runId = run?.runId ?? null;

  const stop = useCallback(() => {
    if (runId) void stopOp(runId);
  }, [runId, stopOp]);

  const restart = useCallback(async () => {
    if (!runId || restarting) return;
    setRestarting(true);
    setNotice(null);
    try {
      const result = await restartOp(runId);
      if (!result.ok) {
        setNotice(result.error ?? "could not restart the resolver");
      } else if (!result.launched) {
        setNotice(
          `resolver could not restart${result.launchError ? `: ${result.launchError}` : ""}`,
        );
      } else {
        setNotice(
          `Resolver restarted · ${result.preservedOutcomes ?? 0} completed outcome${result.preservedOutcomes === 1 ? "" : "s"} preserved`,
        );
      }
    } finally {
      setRestarting(false);
    }
  }, [restartOp, restarting, runId]);

  const resume = useCallback(async () => {
    if (!runId || resuming || unreached.length === 0) return;
    const itemIds = unreached.map((item) => item.itemId);
    setResuming(true);
    setNotice(null);
    try {
      const result = await resumeOp(runId, itemIds);
      if (!result.ok) {
        setNotice(result.error ?? "could not continue the remaining items");
      } else if (!result.launched) {
        setNotice(
          `resolver could not continue${result.launchError ? `: ${result.launchError}` : ""}`,
        );
      } else {
        const preserved = result.preservedOutcomes ?? 0;
        setNotice(
          `Continuing ${itemIds.length} remaining · ${preserved} prior outcome${preserved === 1 ? "" : "s"} preserved`,
        );
      }
    } finally {
      setResuming(false);
    }
  }, [resumeOp, resuming, runId, unreached]);

  const reclassify = useCallback(async () => {
    if (!runId || classifying) return;
    setClassifying(true);
    setNotice(null);
    try {
      const result = await reclassifyOp(runId);
      if (!result.ok) {
        setNotice(result.error ?? "could not classify legacy skipped rows");
      } else {
        setNotice(
          `Classified ${result.preservedOutcomes ?? 0} legacy rows; no outcomes changed`,
        );
      }
    } finally {
      setClassifying(false);
    }
  }, [classifying, reclassifyOp, runId]);

  return {
    start,
    stop,
    restart,
    resume,
    reclassify,
    restarting,
    resuming,
    classifying,
    notice,
    setNotice,
  };
}
