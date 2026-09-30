/**
 * work-item-checkpoint — the bee's work-item-scoped in-flight CHECKPOINT
 * (bee-context-efficiency-2026-06-14 Phase 3 / P-010; D-002, D-003).
 *
 * As of su-cold-auto-mode-2026-07-03 P-001 this is a thin ADAPTER over the ONE
 * shared carry-note substrate ({@link ./carry-note}, mig 472): the bee checkpoint,
 * the Queen carry-journal, and the su loop carry-note are now the SAME store +
 * shape, keyed by scope. The bee's scope is {@link workItemScope} — WORK-ITEM
 * scoped (D-002), so an evicted bee's successor inherits the checkpoint. The
 * public signatures are UNCHANGED, so the spawn-hydration + bee-wake-dossier
 * re-injection seams and the work_items:checkpoint tool need no change.
 *
 * A bee writes a compressed snapshot of its in-flight state at a task boundary /
 * on graceful eviction; the next invocation on the SAME work-item re-injects it
 * (P-011) so a re-woken bee — OR a successor after eviction/death — resumes from
 * the checkpoint instead of a cold start. This is what lets the Phase-1
 * fresh-context warm-inject (D-001) drop the grown transcript without losing
 * continuity.
 *
 * Semantics are the shared carry-note contract (setCarryNote): any length,
 * replace-on-write, blank/omitted/null ⇒ cleared. LOCAL working state, never
 * federated.
 */
import { getOrgPg } from '@papercusp/db-org';
import { resolveConcreteWorkspaceId } from './workspace-registry';
import {
  setCarryNote,
  setCarryNoteWithPrior,
  getCarryNote,
  getCarryJournal,
  readCarryLatestUpdate,
  normalizeWorkItemSubjectFingerprint,
  splitCarryNoteChecks,
  splitCarryNoteWalls,
  workItemScope,
  attestCarryNoteUnchanged,
  type WorkItemSubject,
  type CarryJournalEntry,
  type CarryNoteAttestationResult,
  type CarryNoteAttestationRefusal,
} from './carry-note';
import {
  computeFreshness,
  parseDeclaredDeps,
  type DeclaredDeps,
  type FreshnessResult,
} from './freshness';
import { resolveCurrentTokens } from './freshness/resolvers';
import { stampDeclaredDeps } from './freshness/stamp';

export interface WorkItemCheckpointRef {
  /**
   * The harness the item lives under. May be `null` for a harness-null item — an
   * issue-family EI filed from an unscoped su session (EI-8805). Both write and read
   * MUST resolve to the same canonical key: null / '' / the unscoped-session wildcard
   * '*' collapse onto one namespace via {@link checkpointScopeHarness}, so a
   * harness-null item's checkpoint is keyed identically on every write/read seam.
   */
  harness: string | null;
  workItemId: string;
  /** Defaults to the active workspace (the owner install). */
  workspaceId?: string;
}

/**
 * The sentinel namespace for a harness-null item's checkpoint. A harness-null item
 * (issue-family EI from an unscoped session) has no harness, and the unscoped su
 * session that writes it resolves its own harness to this wildcard — so null, empty,
 * and '*' must ALL key under one namespace or a write silently orphans its checkpoint
 * (EI-8805: the write keyed under the session harness while the read looked it up
 * under the item's own null harness). The work-item id is unique within the workspace,
 * so collapsing the harness component onto a single sentinel never collides.
 */
const CHECKPOINT_WILDCARD_HARNESS = '*';

/** Canonicalize the scope harness: null / '' / the '*' wildcard ⇒ the shared sentinel. */
function checkpointScopeHarness(harness: string | null | undefined): string {
  return harness && harness !== CHECKPOINT_WILDCARD_HARNESS ? harness : CHECKPOINT_WILDCARD_HARNESS;
}

/**
 * The canonical carry-note scope for a work-item checkpoint. Exported (EI-15232) so
 * OTHER readers — e.g. the pot placement watchdog, which batch-reads candidate
 * checkpoints to reconcile a stale-open unit against the cup's own declaration —
 * address the SAME key (with the same null-harness canonicalization) on every seam,
 * instead of re-deriving the scope string and risking a write/read namespace drift
 * (the EI-8805 class this canonicalization exists to prevent).
 */
export function workItemCheckpointScope(harness: string | null | undefined, workItemId: string): string {
  return workItemScope(checkpointScopeHarness(harness), workItemId);
}

/** P-008 (autonomous-loop-prod-audit-2026-07-02): a checkpoint IS progress — bump
 *  the work item's progress anchor so the stale-claims STALLED leg (holder alive,
 *  last_progress_at > window) never frees a claim from a bee that is checkpointing.
 *  Best-effort: the checkpoint write must not fail on a progress-bump hiccup. Shared
 *  by {@link setWorkItemCheckpoint} and {@link setWorkItemCheckpointWithPrior}.
 *
 *  EI-21498578211680100: progress and claim acquisition are distinct clocks. Migration
 *  509 added issue-family `last_progress_at` to the unified base table, so checkpointing
 *  must update that column directly and must NEVER refresh `taken_at` through the
 *  `engineer_issues.assigned_at` compatibility view. The latter made every checkpoint
 *  look like a fresh re-claim and destroyed the meaning of `takenAt`. */
async function bumpCheckpointProgressAnchor(ref: WorkItemCheckpointRef, ws: string): Promise<void> {
  try {
    const { sql } = getOrgPg();
    // Issue ids are workspace-unique, while feature ids are harness-scoped. One
    // base-table write therefore handles both families without touching the
    // `engineer_issues` view (whose assigned_at aliases the claim-time taken_at).
    // Credit only a currently-held row, matching markFeatureProgress/
    // markIssueProgress and keeping holderless historical checkpoints out of the
    // live progress signal.
    await sql`
      UPDATE harness_shared.work_items
         SET last_progress_at = now()
       WHERE workspace_id = ${ws}
         AND feature_id = ${ref.workItemId}
         AND taken_by IS NOT NULL
         AND taken_by <> ''
         AND (
           item_kind IN ('bug', 'change', 'task')
           OR (
             ${ref.harness !== null && ref.harness !== undefined && ref.harness !== CHECKPOINT_WILDCARD_HARNESS}
             AND harness_slug = ${ref.harness}
           )
         )`;
  } catch {
    /* best-effort */
  }
}

/**
 * Write (or clear) a work-item's checkpoint. Delegates to the shared carry-note
 * store under {@link workItemScope}. Returns the stored checkpoint (trimmed) or
 * `null` when cleared. Workspace-scoped.
 */
export async function setWorkItemCheckpoint(
  ref: WorkItemCheckpointRef,
  checkpoint: string | null | undefined,
  opts?: { workItem?: WorkItemSubject },
): Promise<string | null> {
  return (await setWorkItemCheckpointWithPrior(ref, checkpoint, opts)).stored;
}

/** A checkpoint write's result plus the PRIOR checkpoint's length (EI-9325) — free,
 *  since the row is already SELECTed FOR UPDATE inside {@link setCarryNoteWithPrior}'s
 *  transaction. Lets a caller (work_items:checkpoint) warn — never block — on a
 *  suspicious shrink: a plain replace-on-write dramatically shorter than what was
 *  stored before usually means an accidental placeholder/truncated paste rather than
 *  an intentional rewrite. */
export interface WorkItemCheckpointWithPriorResult {
  stored: string | null;
  /** chars in the PRIOR checkpoint before this write replaced it (0 if none existed). */
  priorLength: number;
  /** EI-18140632570924965: present when `guard` blocked this write — nothing was
   *  written; `stored` echoes the UNCHANGED prior checkpoint. */
  blockedReason?: string;
  /** P-007/D-013: declared dependencies this write could not resolve, so they were
   *  NOT stamped. Surfaced (never fatal) because a dep that can never resolve is
   *  worse than no dep — it looks declared but can never invalidate. */
  depsWarnings?: string[];
  /** P-007/D-013: how many declared dependencies were stamped on this write. */
  depsStamped?: number;
  /** P-007/D-013: true when the note this write REPLACED had already gone stale —
   *  the new note is marked `recomputed` for its readers. */
  recomputed?: boolean;
}

/** Same semantics + same progress-anchor bump as {@link setWorkItemCheckpoint}, plus
 *  the prior checkpoint's length. `guard` (EI-18140632570924965) runs inside the
 *  same locked transaction as the read — see {@link setCarryNoteWithPrior}. */
export async function setWorkItemCheckpointWithPrior(
  ref: WorkItemCheckpointRef,
  checkpoint: string | null | undefined,
  opts?: {
    /** Latest authored update before history/check-row preservation transforms. */
    latestUpdate?: string;
    /** Authoritative work-item subject bound to any newly appended journal entry. */
    workItem?: WorkItemSubject;
    guard?: (priorNote: string | null, priorLength: number) => string | null;
    /**
     * P-007/D-013 declared dependencies as `kind:ref` tags (see
     * {@link SUPPORTED_DEP_KINDS}). Tri-state, matching the substrate:
     * `undefined` ⇒ preserve the existing declaration, `[]`/`null` ⇒ clear it,
     * a non-empty list ⇒ resolve each to a version token and stamp it.
     */
    dependsOn?: readonly string[] | null;
    /**
     * EI-19298690705878336: merge the incoming checkpoint against the prior one
     * INSIDE the store's locked transaction — how `## Checks` rows survive a plain
     * replace without a racy read-then-write in the caller. Forwarded verbatim to
     * {@link setCarryNoteWithPrior}; see its `transform` doc for the contract.
     */
    transform?: (priorNote: string | null, note: string | null | undefined) => string | null | undefined;
  },
): Promise<WorkItemCheckpointWithPriorResult> {
  // EI-9013: canonicalize the workspace AT THE SUBSTRATE — a caller that passes
  // the unscoped-session wildcard '*' (or nothing) must never key a row under a
  // literal '*' workspace (the EI-8824 class) or read from one. Fixing this here
  // (not per-caller) means NO write/read seam — the tool, the orient recovery
  // fold, carry-brief, park — can strand or miss a checkpoint via the wildcard.
  const ws = resolveConcreteWorkspaceId(ref.workspaceId);
  if (!ws || !ref.workItemId) {
    throw new Error('setWorkItemCheckpoint — workspaceId and workItemId are required');
  }
  // P-007/D-013: resolve + stamp the declared dependencies BEFORE the write, so the
  // stamp records the world as it was when the note was authored.
  const depsSpecified = opts !== undefined && 'dependsOn' in opts;
  let depsPayload: DeclaredDeps | null | undefined;
  let depsWarnings: string[] | undefined;
  let recomputed = false;

  if (depsSpecified) {
    // EI-19470389781357111: the stamping contract lives in `freshness/stamp` because
    // the loop carry-note declares dependencies against the SAME substrate. Its
    // subtleties (drop-don't-stamp an unresolvable dep, clear-don't-preserve when
    // nothing stamps, decide `recomputed` against the dep UNION) all fail in the
    // trusting direction, so they get one implementation, not two.
    // `priorDeps` is passed as a thunk: an explicit `[]` clear must not pay for a read.
    const stamped = await stampDeclaredDeps({
      declared: opts?.dependsOn ?? [],
      priorDeps: () => getWorkItemCheckpointDeps(ref),
      workspaceId: ws,
      harness: ref.harness,
    });
    depsPayload = stamped.payload;
    recomputed = stamped.recomputed;
    if (stamped.warnings.length > 0) depsWarnings = stamped.warnings;
  }

  // journal:TRUE since effort-scoped-continuity-2026-09-02 P-003 (was `false`).
  //
  // WHAT THIS FIXES. A work-item checkpoint was a pure replace-on-write slot, so
  // week 3's agent silently DESTROYED week 1's reasoning. Measured 2026-09-02:
  // 10,326 `workitem`-scoped rows in harness_shared.carry_notes, ZERO carrying a
  // journal entry — while the `loop` scope, on the SAME substrate, had already
  // accumulated 29,377 entries. The ring was never missing; it was switched off
  // here. It is the destruction failure mode of that plan's Background section, and
  // it is the only item touching 100% of work-items rather than the ~6% that carry
  // a plan.
  //
  // WHY IT IS SAFE TO TURN ON. `appendCarryJournal` is PURE and already bounded on
  // all three axes (CARRY_JOURNAL_MAX_ENTRIES 15, 600 chars/entry, 6_000 total), so
  // the ring cannot grow without limit and adds no query — it rides the row this
  // transaction has already SELECTed FOR UPDATE. The `bounded: true` fail-fast
  // contract below is therefore UNCHANGED: no extra lock, no extra round-trip, and
  // the same single INSERT ... ON CONFLICT (its payload grows by at most the ring's
  // 6KB bound).
  //
  // WHAT IT COSTS A READER: nothing. Claim-time delivery reads
  // `ClaimTimeCheckpointHint`, which is exactly { checkpoint, checkpointAgeMs }, and
  // NOTHING at claim time reads the ring — so this changes what is STORED, not what
  // is delivered. The ring's reader is the briefing (prior-attempt-context), which
  // spends it against an explicit budget.
  //
  // THE ONE BEHAVIOUR CHANGE, stated because it is easy to miss: with journaling on,
  // CLEARING a checkpoint no longer DELETES the row when the ring is non-empty (see
  // setCarryNoteWithPrior). `note` still reads back null, so every existing reader is
  // unaffected — but a surviving row would otherwise carry the CLEARED note's
  // freshness `deps` forward, which is why getWorkItemCheckpointDeps now refuses to
  // report a declaration for a blank note (a verdict about a checkpoint that no
  // longer exists is worse than no verdict).
  //
  // The scope harness is CANONICALIZED (EI-8805) so a harness-null item keys under
  // one namespace on every write/read seam.
  //
  // EI-21864672058763701 / EI-21864782390076614: `bounded: true` was ADDED here.
  // Before this fix, a work-item checkpoint used setCarryNoteWithPrior's UNBOUNDED
  // `sql.begin(write)` branch (the same `SELECT ... FOR UPDATE` on
  // harness_shared.carry_notes that loop:checkpoint hits, but WITHOUT
  // loop:checkpoint's `bounded: true`) — so under admin-pool/row-lock contention it
  // waited indefinitely for the client-side MCP transport to give up, surfacing an
  // AMBIGUOUS "commit status unknown" timeout instead of a clear, retryable error —
  // even though facts:assert / work_items:get / loop:checkpoint on the SAME item
  // returned instantly, because they either don't compete for this lock or already
  // use the bounded fast-fail path. `loop:checkpoint`'s own comment (below, in
  // setCarryNoteWithPrior) already states the correct policy for exactly this
  // scope's lock ("must fail fast... so the MCP transport does not time out"); a
  // work-item checkpoint is the SAME kind of durable-continuity write a successor
  // inherits, so it deserves the SAME fail-fast + typed-error contract, not the
  // strictly worse "hang until the client times out with an unknown outcome" one.
  const { stored, priorLength, blockedReason } = await setCarryNoteWithPrior(
    { scope: workItemScope(checkpointScopeHarness(ref.harness), ref.workItemId), workspaceId: ws },
    checkpoint,
    // Only pass `deps` when the caller spoke — otherwise the substrate preserves
    // the existing declaration (see setCarryNoteWithPrior's `deps` tri-state).
    {
      journal: true,
      latestUpdate: typeof (opts?.latestUpdate ?? checkpoint) === 'string'
        ? splitCarryNoteWalls(splitCarryNoteChecks(opts?.latestUpdate ?? checkpoint!).body).body.trim()
        : undefined,
      guard: opts?.guard,
      ...(opts?.transform ? { transform: opts.transform } : {}),
      ...(depsSpecified ? { deps: depsPayload } : {}),
      ...(opts?.workItem ? { workItem: opts.workItem } : {}),
      bounded: true,
    },
  );
  // A blocked write is a no-op — never bump the progress anchor for it.
  if (stored !== null && !blockedReason) await bumpCheckpointProgressAnchor(ref, ws);
  return {
    stored,
    priorLength,
    blockedReason,
    ...(depsWarnings ? { depsWarnings } : {}),
    ...(depsSpecified ? { depsStamped: depsPayload?.stamps.length ?? 0 } : {}),
    ...(recomputed ? { recomputed: true } : {}),
  };
}

/** Read a work-item checkpoint's declared dependencies, or `null` when it declared
 *  none (or the payload is malformed — which always means undeclared, never stale).
 *
 *  P-003: a BLANK note is treated as undeclared even when the row survives. With the
 *  journal ring on, clearing a checkpoint keeps its row (the ring outlives the note),
 *  and the surviving row still carries the cleared note's `deps`. Reporting those
 *  would hand a freshness verdict for a checkpoint that no longer exists — a
 *  confident answer about nothing, which is strictly worse than the `undeclared`
 *  fallback to the time heuristics. */
export async function getWorkItemCheckpointDeps(ref: WorkItemCheckpointRef): Promise<DeclaredDeps | null> {
  const ws = resolveConcreteWorkspaceId(ref.workspaceId);
  if (!ws || !ref.workItemId) return null;
  const scope = workItemScope(checkpointScopeHarness(ref.harness), ref.workItemId);
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ deps: unknown; note: string | null }[]>`
      SELECT deps, note FROM harness_shared.carry_notes
       WHERE workspace_id = ${ws} AND scope = ${scope} LIMIT 1`;
    if (!((rows[0]?.note ?? '').trim())) return null;
    return parseDeclaredDeps(rows[0]?.deps);
  } catch {
    return null;
  }
}

/**
 * P-003: the work-item checkpoint's TRAJECTORY RING, newest first.
 *
 * This is the reader that makes the ring worth writing. Before P-003 a work-item
 * checkpoint was replace-on-write, so the only thing a later agent could see was the
 * LAST snapshot — every earlier one had been destroyed in place. The ring keeps up to
 * {@link CARRY_JOURNAL_MAX_ENTRIES} prior snapshots on the row the checkpoint already
 * occupies, and this returns them so the briefing (prior-attempt-context) can spend
 * them against its own budget.
 *
 * ⚠ NOT a claim-time read. `getClaimTimeCheckpointHint` deliberately stays
 * { checkpoint, checkpointAgeMs }: the ring is bounded storage, not delivered payload,
 * which is exactly why turning it on cost a fleet member zero tokens. Anything that
 * calls this is spending budget and must say so.
 *
 * Fails soft to `[]` — a missing ring is the normal state for the 10,326 rows written
 * before P-003, and it must never be distinguishable from a read error at a call site
 * that is enriching rather than deciding.
 */
export async function getWorkItemCheckpointJournal(ref: WorkItemCheckpointRef): Promise<CarryJournalEntry[]> {
  const ws = resolveConcreteWorkspaceId(ref.workspaceId);
  if (!ws || !ref.workItemId) return [];
  try {
    return await getCarryJournal({
      scope: workItemScope(checkpointScopeHarness(ref.harness), ref.workItemId),
      workspaceId: ws,
    });
  } catch {
    return [];
  }
}

/**
 * The READ side of the freshness axis: resolve a checkpoint's declared dependencies
 * against the world NOW and return the verdict.
 *
 * Returns `undefined` when the checkpoint declared nothing — the caller then falls
 * back to the existing time heuristics (D-013's precedence rule: a declared verdict
 * OVERRIDES them; they remain the fallback for undeclared notes).
 */
export async function getWorkItemCheckpointFreshness(ref: WorkItemCheckpointRef): Promise<FreshnessResult | undefined> {
  const deps = await getWorkItemCheckpointDeps(ref);
  if (!deps) return undefined;
  const ws = resolveConcreteWorkspaceId(ref.workspaceId);
  if (!ws) return undefined;
  const tokens = await resolveCurrentTokens(
    deps.stamps.map((s) => s.dep),
    { workspaceId: ws, harness: ref.harness },
  );
  return computeFreshness({ deps, currentTokens: tokens });
}

/**
 * Read a work-item's checkpoint — the P-011 re-injection / successor-handoff
 * source. Returns the trimmed checkpoint, or `null` when none is stored.
 * Workspace-scoped.
 */
export async function getWorkItemCheckpoint(ref: WorkItemCheckpointRef): Promise<string | null> {
  // EI-9013: same wildcard canonicalization as the write side — a read scoped by
  // the session's '*' must resolve to the concrete active workspace or it can
  // never see a row the (fixed) write path stored concretely.
  const ws = resolveConcreteWorkspaceId(ref.workspaceId);
  if (!ws || !ref.workItemId) return null;
  // EI-8805: canonicalize the scope harness so a harness-null item reads back the
  // checkpoint it was written under (previously a null harness short-circuited to null).
  return getCarryNote({ scope: workItemScope(checkpointScopeHarness(ref.harness), ref.workItemId), workspaceId: ws });
}

/** A work-item checkpoint plus its write instant — the staleness signal a reader
 *  needs (EI-8885): a checkpoint is only trustworthy relative to WHEN it was
 *  written (a stale carry-note read across a compaction or a multi-wake gap has
 *  bitten agents twice — WI-3578), so callers that need to judge "is this still
 *  current" get both in one query instead of the bare string alone. Mirrors
 *  {@link getLoopCarryNoteWithMeta}'s shape for the work-item scope. */
export interface WorkItemCheckpointWithMeta {
  checkpoint: string | null;
  /** Epoch ms of the checkpoint's last write (carry_notes.updated_ts), null when none. */
  updatedAtMs: number | null;
  /** A failed store read is UNKNOWN, not evidence that no checkpoint was written.
   * Optional for compatibility with injected/older readers. */
  readFailed?: boolean;
  latestUpdate?: ReturnType<typeof readCarryLatestUpdate>;
  /** Subject identity captured on the newest journal entry, when available. */
  subjectFingerprint?: import('./carry-note').WorkItemSubjectFingerprint;
}

/** Read a work-item's checkpoint WITH its write instant. Same scope-canonicalization
 *  as {@link getWorkItemCheckpoint}; one query. */
export async function getWorkItemCheckpointWithMeta(ref: WorkItemCheckpointRef): Promise<WorkItemCheckpointWithMeta> {
  const ws = resolveConcreteWorkspaceId(ref.workspaceId); // EI-9013 — see getWorkItemCheckpoint
  if (!ws || !ref.workItemId) return { checkpoint: null, updatedAtMs: null };
  const scope = workItemScope(checkpointScopeHarness(ref.harness), ref.workItemId);
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{
      note: string | null;
      updated_ts: string | number | null;
      latest_update?: unknown;
      subject_fingerprint?: unknown;
    }[]>`
      SELECT note, updated_ts,
             journal -> -1 -> 'latestUpdate' AS latest_update,
             journal -> -1 -> 'subjectFingerprint' AS subject_fingerprint
        FROM harness_shared.carry_notes
       WHERE workspace_id = ${ws} AND scope = ${scope} LIMIT 1`;
    const note = (rows[0]?.note ?? '').trim();
    const subjectFingerprint = normalizeWorkItemSubjectFingerprint(rows[0]?.subject_fingerprint);
    const subjectMetadata = subjectFingerprint ? { subjectFingerprint } : {};
    if (note.length === 0) return { checkpoint: null, updatedAtMs: null, ...subjectMetadata };
    const ts = rows[0]?.updated_ts == null ? NaN : Number(rows[0].updated_ts);
    const latestUpdate = readCarryLatestUpdate(note, rows[0]?.latest_update);
    return { checkpoint: note, updatedAtMs: Number.isFinite(ts) ? ts : null,
      ...(latestUpdate ? { latestUpdate } : {}),
      ...subjectMetadata };
  } catch {
    return { checkpoint: null, updatedAtMs: null, readFailed: true };
  }
}

/** Refusal reasons for a work-item unchanged attestation: the generic carry-note ones
 *  (content binding, chain bound) plus the work-item-specific evidence guard below. */
export type WorkItemAttestationRefusal = CarryNoteAttestationRefusal | 'attestation_state_changed';

export interface WorkItemAttestationResult extends Omit<CarryNoteAttestationResult, 'refusedReason'> {
  refusedReason?: WorkItemAttestationRefusal;
  /** On 'attestation_state_changed': when the item row actually moved, so the caller
   *  can say WHAT changed rather than only that something did. */
  itemUpdatedAtMs?: number | null;
}

/**
 * Attest that a work-item's stored checkpoint is still current (P-007/R-06).
 *
 * Wraps {@link attestCarryNoteUnchanged} for the work-item scope and adds the third
 * anti-concealment guard, which is the only one that can be expressed here rather than
 * in the generic store:
 *
 *   G2 SUBJECT MOVEMENT. If the work-item ROW changed after the checkpoint body was
 *      written, the attestation is refused. This is POSITIVE evidence that state moved
 *      — a state flip, a comment, a link, a reassignment — so "unchanged" is a false
 *      claim regardless of what the agent believes, and the honest answer is a real
 *      checkpoint. The common stale case (a parked or blocked agent whose item has not
 *      moved) passes cheaply, which is exactly the population the churn measurement
 *      showed paying for rewrites it did not need.
 *
 * The guard is deliberately ordered BEFORE the store write: a refusal must not consume
 * a slot from the chain budget, or a rejected attestation would silently shrink the
 * allowance left for a legitimate one.
 */
export async function attestWorkItemCheckpointUnchanged(
  ref: WorkItemCheckpointRef,
  opts: { contentHash: string; nowMs?: number; maxChain?: number; maxBodyAgeMs?: number },
): Promise<WorkItemAttestationResult> {
  const ws = resolveConcreteWorkspaceId(ref.workspaceId);
  if (!ws || !ref.workItemId) {
    return {
      ok: false,
      refusedReason: 'attestation_no_checkpoint',
      currentHash: null,
      attestedCount: 0,
      bodyAgeMs: null,
      remainingAttestations: 0,
    };
  }
  const scope = workItemScope(checkpointScopeHarness(ref.harness), ref.workItemId);
  const { sql } = getOrgPg();

  // G2. Read the item's own movement against the stored body's write instant. A read
  // failure here must NOT manufacture a refusal (the same fail-open discipline the
  // flush gate itself uses for every best-effort signal): an unreadable row leaves the
  // guard unapplied, and G1/G3 still bound the attestation.
  let itemUpdatedAtMs: number | null = null;
  try {
    // MAX, not a joined LIMIT 1: `feature_id` is unique only WITH `harness_slug`
    // (that is the real PK), and the checkpoint scope may legitimately carry the
    // WILDCARD harness — so the same id can match rows in several harnesses and a
    // LIMIT 1 join would pick one arbitrarily. Picking arbitrarily can answer in the
    // PASS direction, concealing a real move, which is the one direction this guard
    // exists to close; the aggregate reads as "did ANY row for this id move", which
    // is both deterministic and refuse-biased.
    const rows = await sql<Array<{ item_updated: string | number | null; body_ts: string | number | null; updated_ts: string | number | null }>>`
      SELECT (SELECT MAX(w.updated_ts)
                FROM harness_shared.work_items w
               WHERE w.workspace_id = n.workspace_id AND w.feature_id = ${ref.workItemId}) AS item_updated,
             n.body_ts, n.updated_ts
        FROM harness_shared.carry_notes n
       WHERE n.workspace_id = ${ws} AND n.scope = ${scope}
       LIMIT 1`;
    const row = rows[0];
    if (row) {
      const itemTs = row.item_updated == null ? NaN : Number(row.item_updated);
      // NULL body_ts is a pre-1118 row: its last touch was its last body write.
      const bodyTs = row.body_ts == null ? Number(row.updated_ts) : Number(row.body_ts);
      if (Number.isFinite(itemTs) && Number.isFinite(bodyTs)) {
        itemUpdatedAtMs = itemTs;
        if (itemTs > bodyTs) {
          return {
            ok: false,
            refusedReason: 'attestation_state_changed',
            currentHash: null,
            attestedCount: 0,
            bodyAgeMs: null,
            remainingAttestations: 0,
            itemUpdatedAtMs,
          };
        }
      }
    }
  } catch {
    /* fail-open: G1 and G3 still apply */
  }

  const result = await attestCarryNoteUnchanged(
    // `ws` is already canonical; resolveRef re-canonicalizes idempotently.
    { scope, workspaceId: ws },
    {
      contentHash: opts.contentHash,
      nowMs: opts.nowMs,
      maxChain: opts.maxChain,
      maxBodyAgeMs: opts.maxBodyAgeMs,
      bounded: true,
      sql,
    },
  );
  return { ...result, itemUpdatedAtMs };
}

/** A claim-time checkpoint hint: only present when a PRIOR holder actually left one. */
export interface ClaimTimeCheckpointHint {
  checkpoint: string;
  checkpointAgeMs: number | null;
}

/**
 * EI-529: surface a claimed item's in-flight checkpoint AT CLAIM TIME, not only on
 * a separate work_items:get lookup. A dispatcher/reaper re-assigning a work-item
 * whose prior holder went quiet (dead session, host restart, session recycle) has
 * no signal that the prior holder may have already FINISHED the work — the fresh
 * claimant silently re-implements a shipped deliverable (the EI-529 pattern, hit 4×
 * in one session: WI-58, and three unnamed briefs, each cost a "verify it's not
 * already done" detour the claim response itself could have prompted). Mirrors the
 * EI-7252 fix that did the same for work_items:get. Fails soft — never throws, and
 * returns null (not an empty-string checkpoint object) when nothing was ever
 * written, so a normal fresh claim's response is unaffected.
 */
export async function getClaimTimeCheckpointHint(ref: WorkItemCheckpointRef): Promise<ClaimTimeCheckpointHint | null> {
  const { checkpoint, updatedAtMs } = await getWorkItemCheckpointWithMeta(ref).catch(
    () => ({ checkpoint: null, updatedAtMs: null }) as WorkItemCheckpointWithMeta,
  );
  if (!checkpoint) return null;
  return { checkpoint, checkpointAgeMs: updatedAtMs != null ? Math.max(0, Date.now() - updatedAtMs) : null };
}
