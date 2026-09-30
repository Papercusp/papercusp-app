import {
  capPreservingOperativeDetailed,
  type CapPreservingOperativeTruncation,
} from '../../operative-clause';
import { workItemFetchHint } from '../../work-item-fetch-hint';
import {
  assessHeldItemOwnership,
  renderHeldItemOwnershipWarning,
  type CarryBriefHeldItem,
} from '../../carry-brief';
import { controlStateHash } from './control-anchor';

export const AUTOMATIC_COMPACTION_RECOVERY_SCHEMA = 'post-compaction-recovery-v1' as const;
export const AUTOMATIC_COMPACTION_RECOVERY_MARKER = '⟦post-compaction-recovery⟧' as const;

const MAX_PLAN_AUTHORITY_DECISIONS = 6;
const MAX_PLAN_AUTHORITY_SPECS = 24;
const PLAN_AUTHORITY_DECISION_BODY_CAP = 600;

export interface CompactionPlanAuthorityCurrent {
  resolution: 'current';
  controlGeneration: number;
  workspaceId: string;
  harness: string;
  planSlug: string;
  version: number;
  contentHash: string;
  planStatus: string | null;
  decisions: Array<{ id: string; title: string; body: string; truncated: boolean }>;
  decisionsMore?: number;
  items: Array<{ id: string; status: string | null; text: string | null; missing: boolean }>;
  specs: Array<{
    specId: string;
    revision: number;
    contentHash: string;
    planItemId: string | null;
  }>;
  specsMore?: number;
}

export interface CompactionPlanAuthorityUnavailable {
  resolution: 'unavailable';
  controlGeneration: number;
  workspaceId: string;
  harness: string | null;
  planSlug: string;
  reason:
    | 'missing-control-harness'
    | 'not-found-in-control-harness'
    | 'plan-parse-failed'
    | 'spec-read-failed'
    | 'plan-read-failed';
  detail?: string;
}

export type CompactionPlanAuthority =
  | CompactionPlanAuthorityCurrent
  | CompactionPlanAuthorityUnavailable;

/** D-017/P-018: one canonical successor instruction for every deterministic
 * context-wipe producer. Keeping this beside the marker schema prevents the
 * carry-respawn, watchdog, loop-overflow, drill, and tool-guidance paths from
 * drifting back to an unconditional recovery-orient round-trip. */
export const MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION =
  `Inspect the ${AUTOMATIC_COMPACTION_RECOVERY_MARKER} marker already delivered in the carry context. ` +
  'If it is complete and its controlStateHash matches the latest ⟦CTRL:…⟧ stateHash, recovery ' +
  'already arrived: do not call coord:orient; declare your actual lane with ' +
  'coord:declare-intent { intent, current_plan_slug, items }. Call ' +
  'coord:orient { afterCompaction: true } exactly once only when the marker is absent, incomplete, ' +
  'content-mismatched, or a legacy marker/CTRL pair has no stateHash and its generation mismatches, ' +
  'or you deliberately need live data excluded from the injected block.';

/**
 * Post-compaction recovery fold for coord:orient
 * (compaction-context-loss-2026-07-05 P-002 / D-002).
 *
 * The first orient after a compaction re-delivers, structurally, what prose
 * summaries lose: (a) the caller's HELD work-items' checkpoints (the carry
 * notes a successor is normally re-injected with only on item pickup),
 * (b) the armed engine-loop status, and (c) the self-recall pointer — the
 * pre-compaction transcript survives on disk and is searchable via
 * sessions:search { session:'self' }. Resolving here ALSO force-tails the
 * caller's own transcript (ingestFileNow) so that pointer is FRESH the
 * moment it's handed out — client-neutral (claude/omp/codex), no hook
 * required.
 *
 * Handler-side IO (like ownerPresent/modes): composeOrient stays pure.
 * Every leg is best-effort — recovery must never break orientation.
 */

export interface CompactionRecovery {
  /** The one-line pointer back to the pre-compaction verbatim record. */
  selfRecall: string;
  /** The caller's live transcript, when resolvable (already force-tailed). */
  selfSession?: { sourceKind: string; sessionId: string } | null;
  /** Armed engine loop, if any — the loop's carry-note is re-injected on its own wake. */
  loop?: { active: boolean; intervalSec?: number | null } | null;
  /** P-013: compact, generation-stamped control projection. This is the
   *  authoritative full-resync payload for AUTO/IDEATE/DRAIN, loop/carry,
   *  route, and active scope after compaction. */
  control?: import('./control-anchor').ControlAnchor | null;
  /** P-006: current authority for the ONE plan named by the compact control
   *  scope. Rendered before carried summaries so an older checkpoint cannot
   *  silently outrank the plan revision, decisions, item state, or specs. */
  planAuthority?: CompactionPlanAuthority | null;
  /** WI-7302 part 2: fires when this session is registered in an autonomy mode
   *  (modeImpliesAutonomy — the registry's derived set) while NOTHING will wake
   *  it unprompted — no
   *  armed loop and no standing wake-await. Present ONLY when it fires, so it
   *  costs nothing on the healthy path.
   *
   *  Delivered here specifically because a just-compacted successor is the
   *  agent most exposed to it and least able to notice: it inherits a mode
   *  registration from a predecessor whose loop may have died, and a respawn
   *  restores CONTEXT, not a TURN. This path already reads loop status LIVE, so
   *  the check reflects the world now rather than the last persisted anchor. */
  wakeSourceLostWarning?: string;
  /** Held (assigned, non-terminal) work-items + their checkpoints. `body` is the
   *  item's description (capped) so the post-compaction agent doesn't re-fetch it
   *  via work_items:get — measured at 43% of post-compaction orients
   *  (compaction-fold-audit-2026-07-06). */
  checkpoints?: Array<{
    id: string;
    /** EI-20451119672468393: the item's CANONICAL harness — may DIFFER from the
     *  harness your session is scoped to (this fold re-delivers held items
     *  ACROSS harnesses). A same-scope `work_items:*` / `plans:*` read can then
     *  report the item or its plan missing; pass THIS value explicitly when
     *  re-fetching. Absent ⇒ an operator/global-scoped item (no harness —
     *  never a guessed slug, per EI-8813). */
    harness?: string;
    /** Present ONLY when `harness` contradicts the session harness this
     *  recovery was built under — the exact shape where a cold successor
     *  concludes a carried item is gone (EI-20451119672468393: a
     *  sb-devboard-hive session holding papercusp-harness WI-3496). */
    crossHarnessNote?: string;
    title?: string;
    body?: string;
    checkpoint: string | null;
    /** What the `checkpoint` excerpt withheld + how to fetch it. Present ONLY
     *  when the checkpoint was actually truncated, so its absence means "you
     *  are reading the whole thing". Without this the excerpt's bare `…` is
     *  indistinguishable from a complete checkpoint to the one reader who can
     *  least afford the confusion: a just-compacted successor whose entire
     *  resume state is this field. */
    checkpointTruncated?: CapPreservingOperativeTruncation;
    /** Same disclosure for the item description excerpt (capped at BODY_CAP). */
    bodyTruncated?: CapPreservingOperativeTruncation;
    /** Read-time ownership evidence carried with the held-item snapshot. */
    holderProof?: CarryBriefHeldItem['holderProof'];
    /** Present when the snapshot cannot be safely treated as this successor's lane. */
    ownershipWarning?: string;
  }>;
  /** compaction-continuity-hardening P-004: presence/fleet/claims that changed
   *  AFTER the summary was written (the transcript's compact_boundary time) —
   *  the summary's view of anything listed here is guaranteed stale. Present
   *  only when the boundary timestamp is derivable. */
  staleness_warnings?: {
    /** When the compaction summary was written (ISO). */
    summaryAt: string;
    /** Semantics of the list, for the reading agent. */
    note: string;
    /** Concrete detected changes, most-actionable first (bounded). Empty =
     *  nothing detectably changed since the summary. */
    warnings: string[];
  };
  /** Which live recovery legs actually resolved. Empty data is still a
   *  successful read; false means the leg threw and the automatic boundary
   *  marker must remain incomplete so the successor falls back exactly once. */
  coverage: {
    selfSession: boolean;
    control: boolean;
    heldItems: boolean;
    /** null means the compact control scope names no active plan. False makes
     *  the boundary marker incomplete and preserves the one-shot orient fallback. */
    planAuthority?: boolean | null;
    /** null means no compact-boundary timestamp was available, not a failure. */
    staleness: boolean | null;
  };
}

/** Structured marker carried by the deterministic boundary document. The
 *  recovery payload itself remains the existing CompactionRecovery shape; this
 *  wrapper only says whether it is safe to skip the old orient round-trip. */
export interface AutomaticCompactionRecovery {
  marker: {
    schemaVersion: typeof AUTOMATIC_COMPACTION_RECOVERY_SCHEMA;
    complete: boolean;
    memoryEpoch: number;
    controlGeneration: number | null;
    /** Hash of normalized control state; generation alone can advance on activation churn. */
    controlStateHash: string | null;
    fallback: {
      verb: 'coord:orient';
      args: { afterCompaction: true };
      when: readonly [
        'marker-absent',
        'marker-incomplete',
        'control-state-mismatch',
        'legacy-control-generation-mismatch',
      ];
    };
  };
  recovery: CompactionRecovery;
}

const MAX_HELD_ITEMS = 6;
const CHECKPOINT_CAP = 1200;
/** Held-item body cap (fold #3) — enough of the description to resume without a
 *  work_items:get, small enough to stay compact across up to MAX_HELD_ITEMS. */
const BODY_CAP = 600;

export async function buildCompactionRecovery(
  ownerId: string,
  workspaceId: string,
  /** EI-20451119672468393: `sessionHarness` is the harness the CALLER's session
   *  is scoped to (null/omitted ⇒ unscoped). Used ONLY to flag held items whose
   *  canonical harness contradicts it — never to filter them out. */
  opts: {
    sessionHarness?: string | null;
    /** CarryDoc already paid this authoritative read. Reuse it so automatic
     *  delivery does not query held items twice at the boundary. */
    heldItems?: CarryBriefHeldItem[];
  } = {},
): Promise<CompactionRecovery> {
  const recovery: CompactionRecovery = {
    selfRecall:
      "Your pre-compaction turns survive on disk and are INDEXED — recover any lost detail with " +
      "sessions:search { session:'self', mode:'verbatim', query:'<what you remember>' } " +
      "(or sessions:read { session:'self', tail: 40 } for the last 40 turns — pass tail:N, " +
      "an integer; sessions:read has NO mode argument, that belongs to sessions:search only).",
    coverage: {
      selfSession: false,
      control: false,
      heldItems: false,
      planAuthority: null,
      staleness: null,
    },
  };

  // (c) self live-tail + pointer — freshness at the moment of hand-out.
  let selfFilePath: string | null = null;
  try {
    const { resolveSelfSession } = await import('../../search/self-session');
    const self = await resolveSelfSession(ownerId);
    if (self) {
      selfFilePath = self.filePath;
      recovery.selfSession = { sourceKind: self.sourceKind, sessionId: self.sessionId };
      try {
        const { ingestFileNow } = await import('../../search/session-ingest');
        await ingestFileNow(self.filePath);
      } catch { /* the 2-min tick covers it */ }
    } else {
      recovery.selfSession = null;
    }
    recovery.coverage.selfSession = true;
  } catch {
    recovery.selfSession = null;
  }

  // (b) armed engine loop + the compact CTRL anchor (P-013). Reconcile once
  // from the canonical stores; derive the legacy loop fold from that result so
  // post-compaction recovery does not pay two loop reads. If the new projection
  // is unavailable during a rolling deploy, retain the old loop-only fallback.
  try {
    const { getLoopStatus } = await import('../../harness/routines/loop');
    const loop = await getLoopStatus(ownerId);
    try {
      const { buildAndPersistControlAnchor } = await import('./control-anchor');
      recovery.control = await buildAndPersistControlAnchor(ownerId, workspaceId, { loop });
      recovery.loop = {
        active: recovery.control.state.loop.active,
        intervalSec: recovery.control.state.loop.intervalSec,
      };
      recovery.coverage.control = true;
      // WI-7302 part 2: the anchor was just rebuilt from the canonical stores
      // (including a LIVE wake-source read), so this reflects the world now —
      // not the last persisted transition. Attached only when it fires.
      const { wakeSourceLostWarning } = await import('../mode/set');
      const warning = wakeSourceLostWarning({
        modes: recovery.control.state.modes,
        wakeSource: recovery.control.state.wakeSource,
      });
      if (warning) recovery.wakeSourceLostWarning = warning;
    } catch {
      recovery.control = null;
      recovery.loop = loop
        ? { active: Boolean(loop.active), intervalSec: loop.intervalSec ?? null }
        : null;
    }
  } catch {
    recovery.loop = null;
    recovery.control = null;
  }

  // P-006 — the compact CTRL anchor tells us exactly which ONE plan matters.
  // Read its canonical current row/spec revisions once, at the boundary, and
  // carry that authority ahead of every older checkpoint/summary. Absence and
  // wrong scope are explicit failures, never an empty snapshot that looks safe.
  const control = recovery.control;
  const scopedPlan = control?.state.scope.plan ?? null;
  if (control && scopedPlan) {
    const scopedHarness = control.state.scope.harness;
    const unavailable = (
      reason: CompactionPlanAuthorityUnavailable['reason'],
      detail?: string,
    ): void => {
      recovery.planAuthority = {
        resolution: 'unavailable',
        controlGeneration: control.generation,
        workspaceId,
        harness: scopedHarness,
        planSlug: scopedPlan,
        reason,
        ...(detail ? { detail: detail.slice(0, 240) } : {}),
      };
      recovery.coverage.planAuthority = false;
    };
    if (!scopedHarness) {
      unavailable('missing-control-harness');
    } else {
      try {
        const { getPlanRow } = await import('../plans/source');
        const row = await getPlanRow(scopedPlan, { workspaceId, harnessSlug: scopedHarness });
        if (!row) {
          unavailable('not-found-in-control-harness');
        } else {
          let parsed: ReturnType<(typeof import('../plans/parser'))['parsePlan']> | null = null;
          try {
            const { parsePlan } = await import('../plans/parser');
            parsed = parsePlan(row.content, { filePath: `${scopedPlan}.md` });
          } catch (err: unknown) {
            unavailable('plan-parse-failed', err instanceof Error ? err.message : String(err));
          }
          if (parsed) {
            let specRows: Awaited<ReturnType<(typeof import('../plans/spec-clauses-store'))['listSpecClauses']>> | null = null;
            try {
              const { listSpecClauses } = await import('../plans/spec-clauses-store');
              specRows = control.state.scope.items.length > 0
                ? await listSpecClauses({
                    harnessSlug: scopedHarness,
                    planSlug: scopedPlan,
                    planItemIds: control.state.scope.items,
                    limit: MAX_PLAN_AUTHORITY_SPECS + 1,
                  })
                : [];
            } catch (err: unknown) {
              unavailable('spec-read-failed', err instanceof Error ? err.message : String(err));
            }
            if (specRows) {
              const allDecisions = parsed.decisions;
              const decisions = allDecisions.slice(-MAX_PLAN_AUTHORITY_DECISIONS).map((decision) => ({
                id: decision.id,
                title: decision.title,
                body: decision.body.slice(0, PLAN_AUTHORITY_DECISION_BODY_CAP),
                truncated: decision.body.length > PLAN_AUTHORITY_DECISION_BODY_CAP,
              }));
              const itemById = new Map(parsed.items.map((item) => [item.id, item]));
              const specs = specRows.slice(0, MAX_PLAN_AUTHORITY_SPECS);
              recovery.planAuthority = {
                resolution: 'current',
                controlGeneration: control.generation,
                workspaceId,
                harness: scopedHarness,
                planSlug: scopedPlan,
                version: row.version,
                contentHash: row.contentHash,
                planStatus: row.status,
                decisions,
                ...(allDecisions.length > decisions.length
                  ? { decisionsMore: allDecisions.length - decisions.length }
                  : {}),
                items: control.state.scope.items.map((id) => {
                  const item = itemById.get(id);
                  return item
                    ? { id, status: item.storedStatus, text: item.text, missing: false }
                    : { id, status: null, text: null, missing: true };
                }),
                specs: specs.map((spec) => ({
                  specId: spec.specId,
                  revision: spec.revision,
                  contentHash: spec.contentHash,
                  planItemId: spec.planItemId,
                })),
                ...(specRows.length > specs.length ? { specsMore: specRows.length - specs.length } : {}),
              };
              recovery.coverage.planAuthority = true;
            }
          }
        }
      } catch (err: unknown) {
        unavailable('plan-read-failed', err instanceof Error ? err.message : String(err));
      }
    }
  } else {
    recovery.planAuthority = null;
    recovery.coverage.planAuthority = null;
  }

  // (a) held work-items' checkpoints — normally re-injected only on pickup;
  // after a compaction the agent may not know it still HOLDS them. Shares the
  // carry-brief held-items read (compaction-continuity-hardening P-003) so this
  // fold and the compaction/cold-anchor briefs can never drift.
  try {
    const held = opts.heldItems
      ? opts.heldItems.slice(0, MAX_HELD_ITEMS)
      : await (async () => {
          const { readHeldWorkItems } = await import('../../carry-brief');
          return readHeldWorkItems(ownerId, workspaceId, { limit: MAX_HELD_ITEMS });
        })();
    recovery.coverage.heldItems = true;
    if (held.length) {
      recovery.checkpoints = held.map((h) => {
        // EI-19952485326105760: a plain head-only slice here reproduces the SAME
        // defect the carry-brief held-item render already fixed — append-style
        // checkpoints write the newest, most-operative content LAST, so a bare
        // cut discards a superseding owner directive first. This IS that surface
        // (payload.paths named this file's directory) and was left unpatched when
        // the carry-brief fix landed. Share the same preservation helper so the
        // post-compaction recovery fold and the cold carry-brief render can never
        // diverge on this again.
        //
        // ...and preserving the operative clause is only HALF the fix: the
        // excerpt still has to SAY it is an excerpt. Every sibling fold in this
        // same orient payload already discloses its own trim with a count and a
        // fetch verb (factsTruncated / claimableTruncated / recentTruncated /
        // bodiesTruncated); these two fields were the holdout, on the one path
        // where the reader is a cold successor whose whole resume state is what
        // it can see here. Hence the `*Truncated` siblings below.
        // EI-20451119672468393: the re-fetch hint names the item's CANONICAL
        // harness — readHeldWorkItems spans harnesses, and WI-<n> ids are not
        // globally unique (work-items-harness-scope.ts), so an unqualified
        // re-read from a differently-scoped session can miss or mis-resolve.
        // workItemFetchHint is the shared builder so every carry surface emits
        // the same qualified form.
        const fetch = workItemFetchHint(h.id, h.harness);
        const ownership = assessHeldItemOwnership(ownerId, workspaceId, h);
        const crossHarness =
          h.harness && opts.sessionHarness && h.harness !== opts.sessionHarness
            ? `⚠ this item's canonical harness is '${h.harness}', NOT your session's ` +
              `'${opts.sessionHarness}' — pass harness explicitly on work_items:* / plans:* ` +
              `reads for it, or they can report it missing (it is NOT gone)`
            : null;
        if (!ownership.verified) {
          return {
            id: h.id,
            ...(h.harness ? { harness: h.harness } : {}),
            ...(crossHarness ? { crossHarnessNote: crossHarness } : {}),
            ...(h.holderProof ? { holderProof: h.holderProof } : {}),
            checkpoint: null,
            ownershipWarning: renderHeldItemOwnershipWarning(ownerId, workspaceId, h, ownership),
          };
        }
        const ckpt = h.checkpoint
          ? capPreservingOperativeDetailed(h.checkpoint, CHECKPOINT_CAP, { more: fetch })
          : null;
        const body = h.body
          ? capPreservingOperativeDetailed(h.body, BODY_CAP, { more: fetch })
          : null;
        return {
          id: h.id,
          ...(h.harness ? { harness: h.harness } : {}),
          ...(crossHarness ? { crossHarnessNote: crossHarness } : {}),
          ...(h.holderProof ? { holderProof: h.holderProof } : {}),
          ...(h.title ? { title: h.title.slice(0, 120) } : {}),
          ...(body ? { body: body.text } : {}),
          ...(body?.truncation ? { bodyTruncated: body.truncation } : {}),
          checkpoint: ckpt ? ckpt.text : null,
          ...(ckpt?.truncation ? { checkpointTruncated: ckpt.truncation } : {}),
        };
      });
    }
  } catch { /* best-effort */ }

  // (d) staleness warnings (compaction-continuity-hardening P-004): recover the
  // summary's timestamp from the transcript's compact_boundary entry, then flag
  // the presence/fleet/claims that changed AFTER it — the changes the summary
  // cannot know about but the successor will treat as fact.
  try {
    if (selfFilePath) {
      const { readLastCompactBoundaryTs, buildStalenessWarnings } = await import(
        './compaction-staleness'
      );
      const summaryAtMs = await readLastCompactBoundaryTs(selfFilePath);
      if (summaryAtMs != null) {
        recovery.staleness_warnings = {
          summaryAt: new Date(summaryAtMs).toISOString(),
          note:
            'Everything below CHANGED after your compaction summary was written — the ' +
            "summary's view of it is stale. Liveness/fleet counts, service states, and " +
            'quantities in the summary are hypotheses to re-verify, never facts.',
          warnings: await buildStalenessWarnings(ownerId, workspaceId, { summaryAtMs }),
        };
        recovery.coverage.staleness = true;
      }
    }
  } catch { /* best-effort */ }

  return recovery;
}

/** Build the one automatic boundary payload shared by Claude/Codex
 * carry-respawn and OMP deterministic maintenance compaction. Fail-soft like
 * every underlying leg: an incomplete marker is still delivered, but it tells
 * the successor to use the retained orient fallback exactly once. */
export async function buildAutomaticCompactionRecovery(
  ownerId: string,
  workspaceId: string,
  opts: { sessionHarness?: string | null; heldItems?: CarryBriefHeldItem[] } = {},
): Promise<AutomaticCompactionRecovery> {
  const [recovery, memoryEpoch] = await Promise.all([
    buildCompactionRecovery(ownerId, workspaceId, opts),
    (async () => {
      try {
        const [{ currentSessionEpoch }, { getOrgPg }] = await Promise.all([
          import('../../memory/session-epoch-ledger'),
          import('@papercusp/db-org'),
        ]);
        return await currentSessionEpoch(getOrgPg().sql, ownerId);
      } catch {
        return 0;
      }
    })(),
  ]);
  return {
    marker: {
      schemaVersion: AUTOMATIC_COMPACTION_RECOVERY_SCHEMA,
      complete:
        recovery.coverage.control &&
        recovery.coverage.heldItems &&
        recovery.coverage.planAuthority !== false,
      memoryEpoch,
      controlGeneration: recovery.control?.generation ?? null,
      controlStateHash: recovery.control ? controlStateHash(recovery.control.state) : null,
      fallback: {
        verb: 'coord:orient',
        args: { afterCompaction: true },
        when: [
          'marker-absent',
          'marker-incomplete',
          'control-state-mismatch',
          'legacy-control-generation-mismatch',
        ],
      },
    },
    recovery,
  };
}
