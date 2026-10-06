/**
 * work_items:get payload-tier shapers (context-trimming-tiers-2026-07-01 D-004).
 *
 * EI-19447969329510166. `work_items:get` declared NO shaper, so a trimmed session
 * fell through to the framework's GENERIC bounded projection — which knows
 * nothing about which of this tool's fields matter and clips every string at a
 * flat `maxString` (800 chars at the trimmed tier). Measured: a ~13,000-char
 * checkpoint arrived as its first 800 chars.
 *
 * That is the worst possible field to pick. `work_items:checkpoint`'s own
 * description says "your transcript does NOT carry across a task boundary; the
 * checkpoint is your continuity" — so on a post-respawn re-orient the checkpoint
 * IS the session's memory, and `work_items:get` is the tool that exists to
 * deliver it. Clipping it to its head is not a smaller answer, it is a DIFFERENT
 * one: a checkpoint that opens with a superseded root cause and retracts it
 * further down reads, truncated, as confident endorsement of the retracted lead.
 *
 * The ordering principle here is therefore the inverse of the generic
 * projection's:
 *   1. `checkpoint` and the verdicts ABOUT it are the payload — degraded LAST.
 *   2. The conditional "read before acting" warnings (claim collisions, blocked
 *      plan lanes, prior-work, bg-job evidence) are what this tool's `returns`
 *      contract promises a caller must see — kept whole; they are small.
 *   3. `workItem.summary` / `workItem.payload` / `lifecycle` events are the bulk,
 *      and are what a trimmed tier should spend its budget on instead. Dropped or
 *      capped, ALWAYS with a `_shapeNote` saying so (D-004: no silent caps).
 *
 * EI-20743148487714069. Point 3 was originally implemented as a FLAT
 * `FIELD_CAPS.trimmed.summary = 0` — a hard drop at every rung. Measured, that
 * spent nothing to save nothing: a single-item trimmed read is ~890 chars against
 * a 6,000-char door, so the field was dropped from a payload using 15% of its
 * budget, and even the 13,000-char-checkpoint case above finishes ~2,000 chars
 * short of the door. The cost was real — `work_items:get` is how an agent reads a
 * backlog item before acting on it, and title-only is the one shape the standing
 * "a title is a LABEL, read the writer" discipline exists to prevent.
 *
 * A flat per-row cap is the wrong repair, though: `ids` accepts 100, so any fixed
 * summary spend is multiplied by the row count and pushes a bulk read down the
 * ladder into stubbing rows — trading 97 items' identity for 3 items' prose,
 * which is the worse answer for a read that asked about 100 things. So the
 * summary budget is LADDER-SHARED like `checkpointTotal`: a per-rung total,
 * divided across the rows actually carrying one. A 1-row read gets the whole
 * budget (enough for the 95th-percentile body outright); a 100-row read's share
 * falls below `SUMMARY_USEFUL_MIN_CHARS` and is dropped as it is today. Nothing is
 * hand-tuned per row count — the existing measured ladder resolves it.
 *   4. The `detail:true` coord substrate (`workItem.topics/posts/links`) is
 *      dropped, but its COUNTS are disclosed — see `noteDroppedDetail`. Content
 *      out, evidence-of-content in: a reader must never conclude "no comments"
 *      from a shaping decision.
 *
 * SELF-LIMITING, not hand-tuned. `ids` accepts up to 100, and hand-picked
 * per-field caps that look fine for one row silently blow the 30k
 * PAYLOAD_TIER_HARD_CEILING_CHARS at a hundred — which force-applies this same
 * shaper again and, on failing to shrink, falls back to the very generic
 * projection this file exists to avoid. The shaped result also goes through the
 * MCP result door, whose baked universal floor is only ~6k chars. So we walk a
 * DEGRADATION LADDER and emit the first rung that actually fits the stricter
 * result-door budget, measured rather than assumed. Rung 1 is still generous
 * enough that a normal single-item post-respawn read keeps its checkpoint whole.
 */

import { CHARS_PER_TOKEN_ESTIMATE } from "../../context-doors";
import { RESULT_DOOR_TOKENS } from "../../result-door";
import { ANY_FAMILY_TERMINAL_STATES } from "../../work-item-dispatch-states";
import { CARRY_NOTE_MAX_CHECKS } from "../../carry-note";

/**
 * The shaper has no caller identity, so it cannot resolve a per-session door
 * override. Use the baked universal floor: this keeps the default path below
 * the enforced door, while the result door itself remains the authoritative
 * enforcement point for any runtime override (including a stricter one).
 */
export const RESULT_DOOR_BUDGET_CHARS = RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE;

/** Both payload tiers must fit the same MCP per-result door. */
const TIER_TARGET_CHARS = { trimmed: RESULT_DOOR_BUDGET_CHARS, standard: RESULT_DOOR_BUDGET_CHARS } as const;

/**
 * Each rung: how many rows get the FULL projection (the rest degrade to an
 * id-preserving stub, so correlation NEVER breaks), the TOTAL checkpoint chars
 * shared across them, and the TOTAL summary chars shared across them. Ordered
 * most→least generous.
 *
 * `summaryTotal` sits BELOW `checkpointTotal` at every rung on purpose: the
 * checkpoint is this tool's payload and is degraded last (point 1 above), so when
 * a rung cannot fit both, the summary is what gives way.
 */
const DEGRADATION_LADDER = {
  trimmed: [
    { fullRows: 100, checkpointTotal: 6_000, summaryTotal: 2_400, lifecycleTotal: 2_400 },
    { fullRows: 25, checkpointTotal: 3_000, summaryTotal: 1_200, lifecycleTotal: 1_200 },
    { fullRows: 12, checkpointTotal: 1_200, summaryTotal: 600, lifecycleTotal: 600 },
    { fullRows: 6, checkpointTotal: 600, summaryTotal: 0, lifecycleTotal: 300 },
    { fullRows: 3, checkpointTotal: 0, summaryTotal: 0, lifecycleTotal: 0 },
    { fullRows: 0, checkpointTotal: 0, summaryTotal: 0, lifecycleTotal: 0 },
  ],
  standard: [
    { fullRows: 100, checkpointTotal: 16_000, summaryTotal: 4_000, lifecycleTotal: 4_000 },
    { fullRows: 50, checkpointTotal: 8_000, summaryTotal: 2_400, lifecycleTotal: 2_400 },
    { fullRows: 25, checkpointTotal: 3_000, summaryTotal: 1_200, lifecycleTotal: 1_200 },
    { fullRows: 12, checkpointTotal: 1_200, summaryTotal: 600, lifecycleTotal: 600 },
    { fullRows: 6, checkpointTotal: 600, summaryTotal: 0, lifecycleTotal: 300 },
    { fullRows: 0, checkpointTotal: 0, summaryTotal: 0, lifecycleTotal: 0 },
  ],
} as const;

/**
 * Below this, a summary's share of the rung budget buys nothing: the head of a
 * body is not a smaller answer to "what is this item about", and a 24-char
 * fragment costs the marker bytes that say it was clipped. So a share under this
 * floor DROPS the field (disclosed, exactly as today) instead of emitting a
 * useless stub. This is what makes the ladder-shared budget safe at 100 rows
 * without a per-row-count special case.
 */
const SUMMARY_USEFUL_MIN_CHARS = 200;

/**
 * EI-21349427754992019: below this, a lifecycle section's share of its rung
 * budget buys nothing — one verbose audit event is not a smaller answer to
 * "what happened to this item", and a fragment costs the marker bytes saying
 * it was cut. A share under this floor DROPS the events entirely (the always-
 * kept `coverage`/`flags` remain), disclosed exactly like a summary drop.
 * This is what makes the ladder CONVERGE: lifecycle events were previously the
 * one bulk field outside every budget (count-capped only), so three items with
 * chatty timelines kept every non-floor rung over the door and collapsed a
 * multi-id detail read to id-only stubs.
 */
const LIFECYCLE_USEFUL_MIN_CHARS = 200;

/**
 * Per-row caps for the fields whose size does NOT scale with the row count in a
 * way the ladder must arbitrate. `summary` is deliberately NOT here: it is the
 * one bulk field a caller can multiply by 100, so its budget is ladder-shared
 * (see DEGRADATION_LADDER) rather than fixed per row.
 */
const FIELD_CAPS = {
  trimmed: {
    title: 160,
    warning: 300,
    completionScalar: 800,
    completionVerifiedHow: 120,
    completionArray: 12,
    completionNestedArray: 8,
    completionObjectKeys: 20,
    lifecycleEvents: 4,
    checkpointMin: 400,
    citedFacts: 3,
    citedExcerpt: 120,
    priorAttemptRecords: 3,
    priorAttemptText: 300,
    priorAttemptRefs: 6,
    priorAttemptResolved: 2,
    priorAttemptResolvedText: 600,
  },
  standard: {
    title: 300,
    warning: 600,
    completionScalar: 1_600,
    completionVerifiedHow: 240,
    completionArray: 24,
    completionNestedArray: 16,
    completionObjectKeys: 32,
    lifecycleEvents: 10,
    checkpointMin: 800,
    citedFacts: 6,
    citedExcerpt: 240,
    priorAttemptRecords: 8,
    priorAttemptText: 700,
    priorAttemptRefs: 20,
    priorAttemptResolved: 5,
    priorAttemptResolvedText: 1_400,
  },
} as const;

/** `threadLimit` bounds rows at the query, and these caps keep individual post
 * bodies bounded too. A post can be large enough to overflow an otherwise small
 * recent window, so row-count-only bounding is not sufficient for MCP replies. */
const THREAD_CAPS = {
  trimmed: { posts: 5, topics: 12, body: 600 },
  standard: { posts: 10, topics: 24, body: 1200 },
} as const;

/**
 * A single exact read must retain enough identity to answer "who owns this and
 * what state is it in?" even when its diagnostic payload is too large for every
 * normal ladder rung. Bulk reads may use id-only stubs to preserve correlation;
 * an exact one-row read has no correlation trade to make, so keep a bounded
 * checkpoint fragment and the reduced work-item identity instead.
 */
const SINGLE_ROW_CHECKPOINT_CAPS = { trimmed: 400, standard: 800 } as const;

type WorkItemsGetTier = keyof typeof FIELD_CAPS;
type FieldCaps = (typeof FIELD_CAPS)[WorkItemsGetTier];
type Row = Record<string, unknown>;

/**
 * Clip with the SAME loud in-band marker the framework projection now uses
 * (payload-tier.ts `truncationMarker`). A bare `…` is indistinguishable from
 * content — the whole defect this file and that one were filed for.
 */
function clip(value: unknown, max: number): unknown {
  if (typeof value !== "string") return value ?? null;
  if (value.length <= max) return value;
  if (max <= 0) return null;
  return `${value.slice(0, max)}…[TRUNCATED +${value.length - max} chars — re-read with payloadTier:'full']`;
}

/**
 * Keep normal reads' checkpoint identities bounded just like checksOnly. The
 * handler preserves exact claims for callers that need to build `retireIds`,
 * while a shaped result must cap each claim so one verbose row cannot crowd the
 * checkpoint body out of the result door.
 */
function projectCheckpointChecks(raw: unknown, caps: FieldCaps, dropped: Set<string>): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const checks = raw as Row;
  if (!Array.isArray(checks.rows)) return raw;
  const sourceRows = checks.rows;
  const rows = sourceRows.slice(0, CARRY_NOTE_MAX_CHECKS).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const value = entry as Row;
    const claim = typeof value.claim === "string" ? value.claim.trim() : "";
    if (!claim) return [];
    if (claim.length > caps.checkpointMin) dropped.add("checkpointChecks.rows");
    return [{ ...(typeof value.id === "string" && value.id ? { id: value.id } : {}), claim: clip(claim, caps.checkpointMin) }];
  });
  if (rows.length < sourceRows.length) dropped.add("checkpointChecks.rows");
  return {
    ...checks,
    rows,
    ...(rows.length < sourceRows.length && checks.rowsTruncated === undefined
      ? { rowsTruncated: { shown: rows.length, total: sourceRows.length } }
      : {}),
  };
}

/**
 * EI-20106094931898818 / EI-20190481053365787. `detail:true` folds the coord
 * substrate ONTO the workItem — `getWorkItemDetail` returns
 * `{ ...wi, topics, posts, links }` (work-items.ts:1156) — and the allow-list
 * below drops all three, because they are simply absent from its literal.
 *
 * That drop was SILENT, which on this field is the worst-shaped lie available:
 * a caller who passed `detail:true` and sees no `posts` key reads it as "this
 * item has no comments" and acts on it. That misreading has already happened
 * here — a finding WAS on an item, as an unread comment, and got reported as
 * never filed. `_shapeNote` is emitted only when `dropped` is non-empty, so
 * before this a detail read whose ONLY loss was the thread produced no marker
 * at all, and absence of the marker is a positive claim of completeness.
 *
 * The COUNTS are therefore disclosed even though the content is not. The
 * recovery CALL stays once in `_shapeNote.next` instead of per row: repeating
 * it across 100 rows would spend the budget this shaper exists to protect
 * (D-012). A count is ~30 chars.
 *
 * Only a NON-EMPTY array is disclosed. An empty `posts: []` is a real answer
 * ("no comments"), and a defensively-emitted marker on it would destroy the one
 * property that makes the marker worth anything.
 *
 * The numbers are what was PRESENT ON THE ROW before shaping — deliberately not
 * described as the thread total, which this shaper cannot see.
 */
function noteDroppedDetail(w: Row, dropped: Set<string>): Record<string, number> | null {
  const omitted: Record<string, number> = {};
  for (const field of ["posts", "topics", "links"] as const) {
    const value = w[field];
    if (Array.isArray(value) && value.length > 0) {
      omitted[field] = value.length;
      // The LABEL carries no count, deliberately. `dropped` is a payload-level
      // Set shared by every row, so an interpolated count would emit up to one
      // distinct string PER ROW on a bulk read — noise, and budget spent on the
      // very thing this shaper protects. The count lives per row in
      // `detailOmitted`; the label matches the countless convention used by
      // `workItem.summary` / `lifecycle.events` / `citedFacts.cited`.
      dropped.add(`workItem.${field}`);
    }
  }
  return Object.keys(omitted).length > 0 ? omitted : null;
}

function hasCompletionEvidence(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as Row).length > 0
  );
}

/**
 * Keep the persisted completion record useful at every result tier without
 * replaying an unbounded jsonb payload. The scalar presence bit is intentionally
 * separate: a reader must still know that evidence exists when a large nested
 * field is clipped or a bulk row is reduced to a stub.
 */
function projectCompletionEvidence(
  raw: unknown,
  caps: FieldCaps,
  dropped: Set<string>,
  label: string,
): unknown {
  if (!hasCompletionEvidence(raw)) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    dropped.add(label);
    return null;
  }

  const evidence = raw as Row;
  const projectValue = (value: unknown, path: string, depth: number): unknown => {
    if (typeof value === "string") {
      const max = path.endsWith(".verifiedHow") ? caps.completionVerifiedHow : caps.completionScalar;
      if (value.length > max) dropped.add(`${label}.${path.slice("evidence.".length)}`);
      return clip(value, max);
    }
    if (Array.isArray(value)) {
      const max =
        path === "evidence.filesChanged" ||
        path === "evidence.whatLanded" ||
        path === "evidence.deferred" ||
        path === "evidence.checkpointChecksCarried"
          ? caps.completionArray
          : caps.completionNestedArray;
      if (value.length > max) dropped.add(`${label}.${path.slice("evidence.".length)}`);
      return value
        .slice(0, max)
        .map((entry, index) => projectValue(entry, `${path}[${index}]`, depth + 1));
    }
    if (value && typeof value === "object") {
      if (depth >= 4) {
        const serialized = jsonLen(value);
        if (serialized > caps.completionScalar) dropped.add(`${label}.${path.slice("evidence.".length)}`);
        return serialized > caps.completionScalar ? null : value;
      }
      const entries = Object.entries(value as Row);
      if (entries.length > caps.completionObjectKeys) dropped.add(`${label}.${path.slice("evidence.".length)}`);
      return Object.fromEntries(
        entries
          .slice(0, caps.completionObjectKeys)
          .map(([key, entry]) => [key, projectValue(entry, `${path}.${key}`, depth + 1)]),
      );
    }
    return value;
  };

  const projected = Object.fromEntries(
    Object.entries(evidence).map(([key, value]) => [key, projectValue(value, `evidence.${key}`, 0)]),
  );
  // A malformed/forward-added field can still make the record too large after
  // the per-value bounds. Retain the verification scalars before dropping the
  // non-authoritative tail, and disclose the loss through the same label.
  if (jsonLen(projected) > caps.completionScalar * 6) {
    dropped.add(label);
    const compact: Row = {};
    for (const key of ["summary", "verifiedHow", "workOutcome", "testsRun", "testResult", "addedTests", "filesChanged"]) {
      if (projected[key] !== undefined) compact[key] = projected[key];
    }
    return compact;
  }
  return projected;
}

/**
 * Identity + lifecycle facts about the item, plus as much of the summary as the
 * rung's shared budget affords (`summaryChars`; 0 ⇒ the field is omitted, which
 * `projectRow` discloses). Never the payload blob.
 */
function projectWorkItem(
  raw: unknown,
  caps: FieldCaps,
  summaryChars: number,
  dropped: Set<string>,
): unknown {
  if (!raw || typeof raw !== "object") return raw ?? null;
  const w = raw as Row;
  const detailOmitted = noteDroppedDetail(w, dropped);
  const state = typeof w.state === "string" ? w.state.toLowerCase() : "";
  const completionAuthority = w.completionAuthority;
  const terminal = ANY_FAMILY_TERMINAL_STATES.includes(state);
  const rawCompletionEvidence = w.terminalCompletionEvidence;
  const completionEvidencePresent = hasCompletionEvidence(rawCompletionEvidence);
  const completionEvidence = completionEvidencePresent
    ? projectCompletionEvidence(rawCompletionEvidence, caps, dropped, "workItem.terminalCompletionEvidence")
    : null;
  const shouldExposeCompletionAuthority =
    terminal || completionAuthority != null;
  const shouldExposeCompletionRecord =
    terminal || completionEvidencePresent || w.terminalOwner != null || w.terminalCompletionRef != null;
  return {
    id: w.id ?? null,
    kind: w.kind ?? null,
    family: w.family ?? null,
    harness: w.harness ?? null,
    state: w.state ?? null,
    title: clip(w.title, caps.title),
    severity: w.severity ?? null,
    // Provenance is part of the reduced identity: callers need to know whether a
    // locally impossible mutation will be refused before acting on this row.
    origin: w.origin ?? null,
    // P-004 / EI-21045022565500932: lifecycle terminality and completion authority are
    // orthogonal. Keep the authority verdict in the reduced identity projection so a
    // trimmed read cannot turn a verified terminal close into an apparent evidence gap.
    // Open rows owe no judgement yet, so omit their null to preserve the bulk budget;
    // terminal rows always carry the field, including legacy null-authority closes.
    ...(shouldExposeCompletionAuthority ? { completionAuthority: completionAuthority ?? null } : {}),
    ...(shouldExposeCompletionRecord
      ? {
          terminalOwner: w.terminalOwner ?? null,
          terminalCompletionRef: w.terminalCompletionRef ?? null,
          terminalCompletionEvidence: completionEvidence,
        }
      : {}),
    assignee: w.assignee ?? null,
    takenAt: w.takenAt ?? null,
    lastProgressAt: w.lastProgressAt ?? null,
    parent: w.parent ?? null,
    createdAt: w.createdAt ?? null,
    updatedAt: w.updatedAt ?? null,
    closedAt: w.closedAt ?? null,
    ...(summaryChars > 0 ? { summary: clip(w.summary, summaryChars) } : {}),
    // Per-row attribution: `dropped` is payload-level, so across 100 rows it
    // cannot say WHICH item has the 7 unread comments. Mirrors the existing
    // `citedTruncated` / `eventsTruncated` convention in this file.
    ...(detailOmitted ? { detailOmitted } : {}),
  };
}

/**
 * The floor row preserves only correlation plus a machine-readable degradation flag.
 *
 * WI-39844: this used to repeat `ok` / `state` / `title` / `hasCheckpoint` and the same
 * 66-character recovery sentence on every stub. At the supported maximum of 100 ids,
 * those rows alone exceeded the entire MCP result door. The human-readable explanation
 * now lives once in `_shapeNote.stubbed`; a row the caller must re-read needs only the id
 * that makes that recovery possible. Completion presence is hoisted alongside the
 * stub summary so the authoritative bit does not repeat 100 times on a floor read.
 */
function stubRow(r: Row, dropped: Set<string>, completionEvidenceIds: unknown[]): Row {
  const w = (r.workItem ?? {}) as Row;
  const id = r.id ?? w.id ?? null;
  const rawCompletion = r.completion !== undefined ? r.completion : w.terminalCompletionEvidence;
  const hasEvidence = hasCompletionEvidence(rawCompletion);
  if (hasEvidence) {
    completionEvidenceIds.push(id);
    dropped.add("completion");
    dropped.add("workItem.terminalCompletionEvidence");
  }
  return {
    // The keyed result contract requires every row to carry its own boolean
    // outcome. Bulk degradation may drop the work-item payload, but it must
    // not drop `ok` or turn a successful stub into an invalid result row.
    ok: r.ok === true,
    id,
    _stub: true,
  };
}

function compactHolder(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw ?? null;
  const h = raw as Row;
  return {
    ...(h.goalRef !== undefined ? { goalRef: h.goalRef } : {}),
    ...(h.stale !== undefined ? { stale: h.stale } : {}),
    ...(h.agreement !== undefined ? { agreement: h.agreement } : {}),
    ...(Array.isArray(h.competing) ? { competing: h.competing.slice(0, 8) } : {}),
  };
}

const DEPLOYMENT_PATH_CAPS = { trimmed: 4, standard: 8 } as const;

/** Keep the deployment join readable without re-emitting the full pipeline payload. */
function projectDeploymentPosition(
  raw: unknown,
  tier: WorkItemsGetTier,
  dropped: Set<string>,
): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw ?? null;
  const value = raw as Row;
  const paths = Array.isArray(value.paths) ? value.paths : [];
  const cap = DEPLOYMENT_PATH_CAPS[tier];
  if (paths.length > cap) dropped.add("deploymentPosition.paths");
  const compact = paths.slice(0, cap).map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const path = entry as Row;
    return {
      path: path.path ?? null,
      targetSha: path.targetSha ?? null,
      deployedSha: path.deployedSha ?? null,
      positions: path.positions ?? null,
      blockedOn: path.blockedOn ?? null,
      ...(Array.isArray(path.positionsUnknown) && path.positionsUnknown.length
        ? { positionsUnknown: path.positionsUnknown }
        : {}),
    };
  });
  const unknownPaths = Array.isArray(value.unknownPaths) ? value.unknownPaths : [];
  if (unknownPaths.length > cap) dropped.add("deploymentPosition.unknownPaths");
  return {
    paths: compact,
    unknownPaths: unknownPaths.slice(0, cap),
    totalPaths: value.totalPaths ?? paths.length,
    truncated: value.truncated === true,
    ...(value.unknownReason ? { unknownReason: value.unknownReason } : {}),
  };
}

/**
 * Preserve the safety-critical identity of a single exact read when the normal
 * ladder cannot fit its diagnostic fields. This is deliberately not used for
 * bulk reads: at 100 ids, repeating identity is what would destroy correlation.
 */
function compactSingleRow(
  r: Row,
  caps: FieldCaps,
  tier: WorkItemsGetTier,
  dropped: Set<string>,
): Row {
  if (r.ok === false) return r;

  const w = r.workItem as Row | undefined;
  const checkpoint = r.checkpoint;
  const checkpointCap = SINGLE_ROW_CHECKPOINT_CAPS[tier];
  const rawCompletion = r.completion !== undefined ? r.completion : w?.terminalCompletionEvidence;
  const completionPresent = hasCompletionEvidence(rawCompletion);
  const completion = completionPresent
    ? projectCompletionEvidence(rawCompletion, caps, dropped, "completion")
    : null;
  const state = typeof w?.state === "string" ? w.state.toLowerCase() : "";
  const completionRelevant =
    completionPresent || ANY_FAMILY_TERMINAL_STATES.includes(state);
  if (typeof checkpoint === "string" && checkpoint.length > checkpointCap) {
    dropped.add("checkpoint(clipped)");
  }
  if (typeof w?.summary === "string") dropped.add("workItem.summary");
  if (w?.payload !== undefined) dropped.add("workItem.payload");
  noteDroppedDetail(w ?? {}, dropped);

  for (const field of [
    "lifecycle",
    "priorAttempts",
    "priorAttemptRefResolution",
    "citedFacts",
  ]) {
    if (r[field] !== undefined) dropped.add(field);
  }

  return {
    ok: r.ok ?? true,
    id: r.id ?? w?.id ?? null,
    ...(r.availability !== undefined ? { availability: r.availability } : {}),
    workItem: projectWorkItem(r.workItem, caps, 0, dropped),
    ...(completionRelevant ? { completion, hasCompletionEvidence: completionPresent } : {}),
    // `threadLimit` is an explicit bounded diagnostic request, not incidental
    // detail. Keep it even at the exact-read floor: dropping it here turns the
    // caller's measured recent window into silence precisely on large items.
    ...(r.threadWindow !== undefined
      ? { threadWindow: projectThreadWindow(r.threadWindow, tier, dropped) }
      : {}),
    ...(r.threadWindowReadFailed ? { threadWindowReadFailed: true } : {}),
    // P-002 (WI-2145856): the clamp disclosure is a BOUNDEDNESS MARKER on the
    // window the caller is about to read, so it must survive every shape tier —
    // dropping it under budget would restore exactly the silent-short-window
    // reading the clamp was allowed to exist only because it avoids. It is a
    // two-number object, so it never meaningfully competes for that budget.
    ...(r.threadLimitClamped !== undefined ? { threadLimitClamped: r.threadLimitClamped } : {}),
    checkpoint: clip(checkpoint, checkpointCap),
    ...(r.checkpointChecks !== undefined
      ? { checkpointChecks: projectCheckpointChecks(r.checkpointChecks, caps, dropped) }
      : {}),
    // EI-22659954682164298: a BOUNDEDNESS MARKER on the stored note, so it survives
    // every tier for the same reason `threadLimitClamped` above does — and with extra
    // force here, because the line above CLIPS. A reader handed a clipped checkpoint
    // with no body headroom cannot tell a display budget from a storage cap, which is
    // precisely the confusion that let a note sit AT the cap silently evicting.
    ...(r.checkpointBody !== undefined ? { checkpointBody: r.checkpointBody } : {}),
    checkpointAgeMs: r.checkpointAgeMs ?? null,
    checkpointUpdatedAtMs: r.checkpointUpdatedAtMs ?? null,
    // EI-21379898054596220: 12 chars, and the ONLY field that stays true when the line
    // above clips — it digests the STORED note, so it is exactly what a successor needs
    // when the checkpoint it received is a prefix. Kept at every tier for that reason.
    // CONDITIONAL, like checkpointChecks above: emitting `null` on the rows that have no
    // checkpoint spends ~35 chars each against a budget whose whole job is to keep the
    // checkpoint whole, and measurably displaced it (it clipped a 5k checkpoint and
    // un-dropped a summary — the two guarantees EI-19447969329510166 added this shaper
    // to hold). Absence is unambiguous here: `checkpoint: null` already says nothing was
    // stored, and `checkpointReadFailed` already says the read broke.
    ...(r.checkpointContentHash ? { checkpointContentHash: r.checkpointContentHash } : {}),
    ...(r.checkpointSubjectFingerprint ? { checkpointSubjectFingerprint: r.checkpointSubjectFingerprint } : {}),
    ...(r.checkpointReadFailed ? { checkpointReadFailed: true } : {}),
    // EI-19454477695046958: like `checkpointContentHash` above, this stays true when the
    // checkpoint clips — and it is needed MOST exactly then. A trimmed reader receives the
    // summary nearly whole and the checkpoint as a short prefix, so a retraction living past
    // the clip is invisible while the claim it withdraws still reads as the item's definition.
    // That is the failure this item exists to fix, so dropping the advisory here defeated the
    // fix on precisely the tier that needed it. Measured on WI-39344: retractions at offsets
    // 1803/1965/2349 of a 24,597-char note the trimmed tier delivered as 849 chars — every
    // retraction cut, and the advisory (present at `full`) absent here. The COUNT is the
    // irreducible part (the documented failure is missing the SECOND retraction), so it is
    // kept at every tier; the excerpts ride the existing small-advisory budget.
    ...(r.checkpointRetractions
      ? { checkpointRetractions: projectCheckpointRetractions(r.checkpointRetractions, caps, dropped) }
      : {}),
    ...(r.completionFreshness ? { completionFreshness: r.completionFreshness } : {}),
    ...(r.deploymentPosition
      ? { deploymentPosition: projectDeploymentPosition(r.deploymentPosition, tier, dropped) }
      : {}),
    ...(r.checkpointFreshness ? { checkpointFreshness: r.checkpointFreshness } : {}),
    ...(r.checkpointStale ? { checkpointStale: r.checkpointStale } : {}),
    ...(r.checkpointBgJobWarning ? { checkpointBgJobWarning: clip(r.checkpointBgJobWarning, caps.warning) } : {}),
    ...(r.priorWorkWarning ? { priorWorkWarning: clip(r.priorWorkWarning, caps.warning) } : {}),
    ...(r.planItemBlocked ? { planItemBlocked: r.planItemBlocked } : {}),
    ...(r.planItemClaimCollision ? { planItemClaimCollision: r.planItemClaimCollision } : {}),
    ...(r.planItemTextDrift ? { planItemTextDrift: r.planItemTextDrift } : {}),
    ...(r.holder ? { holder: compactHolder(r.holder) } : {}),
  };
}

/**
 * EI-19465127338264010. The prose fact-citation warning. Its `note` + counts are
 * the finding and are KEPT WHOLE (small, and they are what a reader must act on);
 * the per-key `excerpt`s are the bulk — valuable (they hand back the body of a
 * decayed authority) but capped here, since ten 160-char excerpts across a
 * hundred rows is exactly the blow-up this file's ladder exists to prevent.
 *
 * Never silently: a capped list says so via `citedTruncated` in-band AND lands in
 * the shared `dropped` set, so `_shapeNote` names it too.
 */
/**
 * EI-19454477695046958: bound the retraction advisory to the tier's small-advisory
 * budget WITHOUT breaking its arithmetic. `scanCheckpointRetractions` guarantees
 * `excerpts.length + (more ?? 0) === count`; re-clipping the array here therefore has
 * to RE-DERIVE `more` from the kept length. Forwarding the original `more` beside a
 * shortened `excerpts` would understate the remainder — a wrong number from the one
 * field whose entire job is to be counted on.
 */
function projectCheckpointRetractions(raw: unknown, caps: FieldCaps, dropped: Set<string>): unknown {
  if (!raw || typeof raw !== "object") return raw ?? null;
  const cr = raw as Row;
  const count = typeof cr.count === "number" ? cr.count : 0;
  const all = Array.isArray(cr.excerpts) ? cr.excerpts : [];
  const kept = all.slice(0, caps.citedFacts).map((e) => (typeof e === "string" ? clip(e, caps.citedExcerpt) : e));
  if (all.length > kept.length) dropped.add("checkpointRetractions.excerpts");
  const more = Math.max(0, count - kept.length);
  return { count, excerpts: kept, ...(more > 0 ? { more } : {}) };
}

function projectCitedFacts(raw: unknown, caps: FieldCaps, dropped: Set<string>): unknown {
  if (!raw || typeof raw !== "object") return raw ?? null;
  const cf = raw as Row;
  const cited = Array.isArray(cf.cited) ? cf.cited : [];
  const kept = cited.slice(0, caps.citedFacts).map((c) => {
    if (!c || typeof c !== "object") return c;
    const e = c as Row;
    return {
      ...e,
      ...(typeof e.excerpt === "string" ? { excerpt: clip(e.excerpt, caps.citedExcerpt) } : {}),
    };
  });
  if (cited.length > caps.citedFacts) dropped.add("citedFacts.cited");
  return {
    dangling: cf.dangling ?? null,
    decayed: cf.decayed ?? null,
    ...(cf.truncated ? { truncated: cf.truncated } : {}),
    note: cf.note ?? null,
    cited: kept,
    ...(cited.length > caps.citedFacts
      ? { citedTruncated: { shown: kept.length, total: cited.length } }
      : {}),
  };
}

/** Project the explicit bounded diagnostic thread. The query already limits the
 * window, but the payload still needs a body cap because one post can be large.
 * `shown` and `total` stay in-band so a short window is never mistaken for the
 * whole conversation. */
function projectThreadWindow(raw: unknown, tier: WorkItemsGetTier, dropped: Set<string>): unknown {
  if (!raw || typeof raw !== "object") return raw ?? null;
  const w = raw as Row;
  const caps = THREAD_CAPS[tier];
  const posts = Array.isArray(w.posts) ? w.posts : [];
  const topics = Array.isArray(w.topics) ? w.topics : [];
  const keptPosts = posts.slice(-caps.posts).map((value) => {
    const post = value && typeof value === "object" ? (value as Row) : {};
    const body = typeof post.body === "string" ? post.body : "";
    const bodyTruncated = body.length > caps.body;
    if (bodyTruncated) dropped.add("threadWindow.postBodies");
    return {
      id: post.id ?? null,
      thread_id: post.thread_id ?? null,
      author_id: post.author_id ?? null,
      body: clip(body, caps.body),
      created_ts: post.created_ts ?? null,
      ...(bodyTruncated ? { bodyChars: body.length, bodyTruncated: true } : {}),
    };
  });
  if (posts.length > caps.posts) dropped.add("threadWindow.posts");
  if (topics.length > caps.topics) dropped.add("threadWindow.topics");
  return {
    posts: keptPosts,
    shown: keptPosts.length,
    total: typeof w.total === "number" ? w.total : null,
    topics: topics.slice(0, caps.topics),
    createdAt: w.createdAt ?? null,
  };
}

/**
 * P-017. The prior-attempt brief is ALREADY bounded by its own compiler, so this
 * is a second, tier-relative bound — a brief cut to fit a claim reply can still
 * be too large for a 100-row `trimmed` read.
 *
 * Two invariants, both inherited from the failures the fields above encode:
 *
 * 1. The OMISSION block is never dropped to make room for records. It is the
 *    same class of field as `lifecycle.coverage` — the qualifier that says what
 *    is NOT here — and a record list without it reads as the complete history.
 *    If anything gives way it is the records, whose refs survive regardless.
 * 2. A text this shaper clips is MARKED `textTruncated`, even when the compiler
 *    delivered it whole. An unmarked clip is the checkpoint failure in a new
 *    field: a prior attempt whose body says "tried X, X was wrong" reads,
 *    truncated at "tried X", as a recommendation to try X.
 */
function projectPriorAttempts(raw: unknown, caps: FieldCaps, dropped: Set<string>): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const b = raw as Row;
  const clipRecords = (value: unknown, label: string): unknown => {
    if (!Array.isArray(value)) return value;
    if (value.length > caps.priorAttemptRecords) dropped.add(`priorAttempts.${label}`);
    return value.slice(0, caps.priorAttemptRecords).map((rec) => {
      if (!rec || typeof rec !== "object") return rec;
      const record = rec as Row;
      const text = record.text;
      if (typeof text !== "string" || text.length <= caps.priorAttemptText) return record;
      dropped.add(`priorAttempts.${label}(text clipped)`);
      return {
        ...record,
        text: clip(text, caps.priorAttemptText),
        // Invariant 2. `fullTextChars` may already be set by the compiler; when it
        // is not, this shaper is the only thing that knows the pre-clip length.
        textTruncated: true,
        fullTextChars:
          typeof record.fullTextChars === "number" ? record.fullTextChars : text.length,
      };
    });
  };
  const omission = (b.omission ?? null) as Row | null;
  const omittedRefs = Array.isArray(omission?.omittedRefs) ? omission.omittedRefs : [];
  const refsCut = omittedRefs.length > caps.priorAttemptRefs;
  if (refsCut) dropped.add("priorAttempts.omission.omittedRefs");
  const rawRefs = Array.isArray(b.rawRefs) ? b.rawRefs : [];
  if (rawRefs.length > caps.priorAttemptRefs) dropped.add("priorAttempts.rawRefs");
  return {
    schemaVersion: b.schemaVersion ?? null,
    fingerprint: b.fingerprint ?? null,
    authority: clipRecords(b.authority, "authority"),
    residue: b.residue ?? [],
    attempts: clipRecords(b.attempts, "attempts"),
    rawRefs: rawRefs.slice(0, caps.priorAttemptRefs),
    protectedRefs: b.protectedRefs ?? null,
    // Invariant 1 — kept whole apart from the independently-bounded ref list,
    // whose own cut is disclosed IN BAND via `omittedRefsTruncated` so an
    // exhausted list never reads as a complete one.
    ...(omission
      ? {
          omission: {
            ...omission,
            omittedRefs: omittedRefs.slice(0, caps.priorAttemptRefs),
            omittedRefsTruncated: Boolean(omission.omittedRefsTruncated) || refsCut,
          },
        }
      : {}),
  };
}

/** The raw drill-down. `unresolved` is never dropped: it is the answer to "why
 * is the ref I asked for missing", and without it an absent record is
 * indistinguishable from one this shaper cut. */
function projectPriorAttemptRefResolution(
  raw: unknown,
  caps: FieldCaps,
  dropped: Set<string>,
): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const res = raw as Row;
  const records = Array.isArray(res.records) ? res.records : [];
  if (records.length > caps.priorAttemptResolved) dropped.add("priorAttemptRefResolution.records");
  return {
    ...res,
    records: records.slice(0, caps.priorAttemptResolved).map((rec) => {
      if (!rec || typeof rec !== "object") return rec;
      const record = rec as Row;
      const text = record.text;
      if (typeof text !== "string" || text.length <= caps.priorAttemptResolvedText) return record;
      dropped.add("priorAttemptRefResolution.records(text clipped)");
      return {
        ...record,
        text: clip(text, caps.priorAttemptResolvedText),
        textTruncated: true,
        fullTextChars: text.length,
      };
    }),
    ...(records.length > caps.priorAttemptResolved
      ? { recordsTruncated: { shown: caps.priorAttemptResolved, total: records.length } }
      : {}),
  };
}

function projectRow(
  r: Row,
  caps: FieldCaps,
  checkpointChars: number,
  summaryChars: number,
  lifecycleChars: number,
  dropped: Set<string>,
): Row {
  if (r.ok === false) return r; // an error row is already tiny and self-describing

  const checkpoint = r.checkpoint;
  if (typeof checkpoint === "string" && checkpoint.length > checkpointChars) {
    dropped.add("checkpoint(clipped)");
  }
  const w = r.workItem as Row | undefined;
  // Disclose the summary's fate in the SAME two shapes used for the checkpoint:
  // a full drop and a clip are different losses and a reader acts differently on
  // them (a clip is recoverable from what is in hand; a drop is not).
  if (typeof w?.summary === "string") {
    if (summaryChars === 0) dropped.add("workItem.summary");
    else if (w.summary.length > summaryChars) dropped.add("workItem.summary(clipped)");
  }
  if (w?.payload !== undefined) dropped.add("workItem.payload");
  const rawCompletion = r.completion !== undefined ? r.completion : w?.terminalCompletionEvidence;
  const completionPresent = hasCompletionEvidence(rawCompletion);
  const completion = completionPresent
    ? projectCompletionEvidence(rawCompletion, caps, dropped, "completion")
    : null;
  const state = typeof w?.state === "string" ? w.state.toLowerCase() : "";
  const completionRelevant =
    completionPresent || ANY_FAMILY_TERMINAL_STATES.includes(state);

  const lifecycle = r.lifecycle as Row | undefined;
  let shapedLifecycle: unknown;
  if (lifecycle && typeof lifecycle === "object") {
    const events = Array.isArray(lifecycle.events) ? lifecycle.events : [];
    if (events.length > caps.lifecycleEvents) dropped.add("lifecycle.events");
    // EI-21349427754992019: events are CHAR-budgeted per rung (ladder-shared,
    // like summary), not merely count-sliced — verbose audit entries used to be
    // the unbounded bulk that pushed every non-floor rung over the result door
    // and stubbed whole multi-id reads. `coverage`/`flags` are kept whole: they
    // qualify the timeline and an unqualified empty events array is precisely
    // the misreading they exist to prevent.
    const keptEvents: unknown[] = [];
    let lifecycleSpent = 0;
    let lifecycleClipped = false;
    if (lifecycleChars <= 0) {
      if (events.length > 0) dropped.add("lifecycle.events");
    } else {
      for (const ev of events.slice(0, caps.lifecycleEvents)) {
        const cost = jsonLen(ev) + 1;
        if (lifecycleSpent + cost > lifecycleChars) {
          lifecycleClipped = true;
          break;
        }
        keptEvents.push(ev);
        lifecycleSpent += cost;
      }
      if (keptEvents.length === 0) {
        // Not even one event fits the share — same verdict as a zero budget.
        dropped.add("lifecycle.events");
      } else if (lifecycleClipped || keptEvents.length < Math.min(events.length, caps.lifecycleEvents)) {
        dropped.add("lifecycle.events(clipped)");
      }
    }
    shapedLifecycle = {
      coverage: lifecycle.coverage ?? null,
      flags: lifecycle.flags ?? null,
      events: keptEvents,
      ...(events.length > keptEvents.length
        ? { eventsTruncated: { shown: keptEvents.length, total: events.length } }
        : {}),
    };
  }

  return {
    ok: r.ok ?? true,
    id: r.id ?? null,
    ...(r.availability !== undefined ? { availability: r.availability } : {}),
    workItem: projectWorkItem(r.workItem, caps, summaryChars, dropped),
    ...(r.threadWindow !== undefined
      ? {
          threadWindow: projectThreadWindow(
            r.threadWindow,
            caps === FIELD_CAPS.trimmed ? 'trimmed' : 'standard',
            dropped,
          ),
        }
      : {}),
    ...(r.threadWindowReadFailed ? { threadWindowReadFailed: true } : {}),
    // P-002 (WI-2145856): the clamp disclosure is a BOUNDEDNESS MARKER on the
    // window the caller is about to read, so it must survive every shape tier —
    // dropping it under budget would restore exactly the silent-short-window
    // reading the clamp was allowed to exist only because it avoids. It is a
    // two-number object, so it never meaningfully competes for that budget.
    ...(r.threadLimitClamped !== undefined ? { threadLimitClamped: r.threadLimitClamped } : {}),
    // THE payload of this tool. Degraded only after everything above was already
    // dropped, and never without the loud in-band marker.
    checkpoint: clip(checkpoint, checkpointChars),
    // `completion` is the read-side alias for the persisted completion record.
    // Keep `hasCompletionEvidence` even when the evidence body is clipped or
    // compacted, so a tier artifact cannot be read as a real absence.
    ...(completionRelevant ? { completion, hasCompletionEvidence: completionPresent } : {}),
    ...(r.checkpointChecks !== undefined
      ? { checkpointChecks: projectCheckpointChecks(r.checkpointChecks, caps, dropped) }
      : {}),
    // EI-22659954682164298 — see the sibling projection above. Kept at every tier for
    // the same reason, and conditional for the same reason.
    ...(r.checkpointBody !== undefined ? { checkpointBody: r.checkpointBody } : {}),
    checkpointAgeMs: r.checkpointAgeMs ?? null,
    checkpointUpdatedAtMs: r.checkpointUpdatedAtMs ?? null,
    // EI-21379898054596220 — see the sibling projection above. Kept at every tier for
    // the same reason (it is the verification that SURVIVES the clip on the line above),
    // and conditional for the same reason (a null costs budget the checkpoint needs).
    ...(r.checkpointContentHash ? { checkpointContentHash: r.checkpointContentHash } : {}),
    ...(r.checkpointSubjectFingerprint ? { checkpointSubjectFingerprint: r.checkpointSubjectFingerprint } : {}),
    ...(r.checkpointReadFailed ? { checkpointReadFailed: r.checkpointReadFailed } : {}),
    ...(r.completionFreshness ? { completionFreshness: r.completionFreshness } : {}),
    ...(r.deploymentPosition
      ? {
          deploymentPosition: projectDeploymentPosition(
            r.deploymentPosition,
            caps === FIELD_CAPS.trimmed ? 'trimmed' : 'standard',
            dropped,
          ),
        }
      : {}),
    // Verdicts ABOUT the checkpoint — small, and each one changes how the
    // checkpoint above should be read. Kept whole.
    ...(r.checkpointFreshness ? { checkpointFreshness: r.checkpointFreshness } : {}),
    ...(r.checkpointStale ? { checkpointStale: r.checkpointStale } : {}),
    ...(r.checkpointBgJobWarning ? { checkpointBgJobWarning: clip(r.checkpointBgJobWarning, caps.warning) } : {}),
    // EI-19454477695046958: the sharpest member of this group — it says the checkpoint
    // above WITHDRAWS something, and it stays true when that checkpoint clips. Needed
    // most exactly when the clip hides the retraction and the summary still reads as the
    // item's definition. See projectCheckpointRetractions for why `more` is re-derived.
    ...(r.checkpointRetractions
      ? { checkpointRetractions: projectCheckpointRetractions(r.checkpointRetractions, caps, dropped) }
      : {}),
    // Conditional "read before acting" warnings this tool's `returns` promises.
    ...(r.priorWorkWarning ? { priorWorkWarning: clip(r.priorWorkWarning, caps.warning) } : {}),
    ...(r.citedFacts ? { citedFacts: projectCitedFacts(r.citedFacts, caps, dropped) } : {}),
    ...(r.planItemBlocked ? { planItemBlocked: r.planItemBlocked } : {}),
    ...(r.planItemClaimCollision ? { planItemClaimCollision: r.planItemClaimCollision } : {}),
    ...(r.planItemTextDrift ? { planItemTextDrift: r.planItemTextDrift } : {}),
    ...(r.holder ? { holder: r.holder } : {}),
    ...(shapedLifecycle ? { lifecycle: shapedLifecycle } : {}),
    ...(r.priorAttempts ? { priorAttempts: projectPriorAttempts(r.priorAttempts, caps, dropped) } : {}),
    ...(r.priorAttemptRefResolution
      ? {
          priorAttemptRefResolution: projectPriorAttemptRefResolution(r.priorAttemptRefResolution, caps, dropped),
        }
      : {}),
  };
}

function jsonLen(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * The checks-only handler deliberately carries an internal marker so this
 * projection runs before the normal checkpoint ladder. The ledger rows are
 * already bounded and sanitized by the handler; retain only their identities
 * and checkpoint metadata, never the checkpoint narrative or work-item payload.
 */
function shapeChecksOnly(data: Row, tier: WorkItemsGetTier): unknown {
  const { __checksOnly: _marker, ...envelope } = data;
  const results = Array.isArray(data.results) ? data.results : [];
  return {
    ...envelope,
    results: results.map((raw) => {
      if (!raw || typeof raw !== 'object') return raw;
      const row = raw as Row;
      if (row.ok === false) return row;
      const checks = row.checkpointChecks;
      if (!checks || typeof checks !== 'object' || Array.isArray(checks)) {
        return {
          ok: row.ok ?? true,
          id: row.id ?? null,
          checkpointChecks: checks ?? null,
          ...(row.checkpointBody !== undefined ? { checkpointBody: row.checkpointBody } : {}),
          checkpointAgeMs: row.checkpointAgeMs ?? null,
          checkpointUpdatedAtMs: row.checkpointUpdatedAtMs ?? null,
          ...(row.checkpointContentHash !== undefined
            ? { checkpointContentHash: row.checkpointContentHash }
            : {}),
          ...(row.checkpointSubjectFingerprint !== undefined
            ? { checkpointSubjectFingerprint: row.checkpointSubjectFingerprint }
            : {}),
          ...(row.checkpointReadFailed ? { checkpointReadFailed: true } : {}),
        };
      }
      const checkEnvelope = checks as Row;
      const checkRows: unknown[] = Array.isArray(checkEnvelope.rows) ? checkEnvelope.rows : [];
      const claimCap = FIELD_CAPS[tier].checkpointMin;
      const rows = checkRows.slice(0, CARRY_NOTE_MAX_CHECKS).flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const value = entry as Row;
        const claim = typeof value.claim === 'string' ? value.claim.trim() : '';
        return claim ? [{ ...(value.id ? { id: value.id } : {}), claim: clip(claim, claimCap) }] : [];
      });
      return {
        ok: row.ok ?? true,
        id: row.id ?? null,
        checkpointChecks: { ...checkEnvelope, rows },
        ...(row.checkpointBody !== undefined ? { checkpointBody: row.checkpointBody } : {}),
        checkpointAgeMs: row.checkpointAgeMs ?? null,
        checkpointUpdatedAtMs: row.checkpointUpdatedAtMs ?? null,
        ...(row.checkpointContentHash !== undefined
          ? { checkpointContentHash: row.checkpointContentHash }
          : {}),
        ...(row.checkpointSubjectFingerprint !== undefined
          ? { checkpointSubjectFingerprint: row.checkpointSubjectFingerprint }
          : {}),
        ...(row.checkpointReadFailed ? { checkpointReadFailed: true } : {}),
      };
    }),
    _shapeNote: {
      tier,
      checksOnly: true,
      next: 'This is a checkpoint-ledger identity read; re-read without checksOnly for the checkpoint narrative.',
    },
  };
}

export function shapeWorkItemsGet(data: unknown, tier: WorkItemsGetTier): unknown {
  const d = data as ({ results?: unknown[] } & Row) | null | undefined;
  if (!d || !Array.isArray(d.results)) return data;
  if (d.__resumeOnly === true) {
    const { __resumeOnly: _marker, ...resume } = d;
    return resume; // The one-item producer budgets whole fields before the result door.
  }
  if (d.__checksOnly === true) return shapeChecksOnly(d, tier);
  const caps = FIELD_CAPS[tier];
  const rows = d.results.map((r) => (r && typeof r === "object" ? (r as Row) : ({} as Row)));
  const ladder = DEGRADATION_LADDER[tier];
  const target = TIER_TARGET_CHARS[tier];

  let out: unknown;
  // Two attempts per rung — this ordering is what makes "the checkpoint is
  // degraded LAST" true rather than aspirational. Descending a rung CUTS THE
  // CHECKPOINT, so before we do that we retry the SAME rung with the summary
  // budget withdrawn. A summary therefore only ever spends slack the rung already
  // had; it can never buy its bytes from the checkpoint. (Without this, adding any
  // summary spend at rung 1 pushed the 5,000-char-checkpoint single-item read down
  // to a rung that clipped it to 3,000 — reintroducing EI-19447969329510166's
  // exact defect from a new direction.)
  const attempts: Array<{ rung: number; withSummary: boolean }> = [];
  for (let rung = 0; rung < ladder.length; rung += 1) {
    if (ladder[rung].summaryTotal > 0) attempts.push({ rung, withSummary: true });
    attempts.push({ rung, withSummary: false });
  }

  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    const { rung, withSummary } = attempts[attempt];
    const { fullRows, checkpointTotal, summaryTotal, lifecycleTotal } = ladder[rung];
    const dropped = new Set<string>();
    const carrying = rows
      .slice(0, fullRows)
      .filter((r) => typeof r.checkpoint === "string" && r.checkpoint.length > 0).length;
    const checkpointChars =
      carrying === 0 ? 0 : Math.max(caps.checkpointMin, Math.floor(checkpointTotal / carrying));


    // Divided across the rows that actually HAVE a summary, so one row's read is
    // not rationed against 99 rows that would not have spent it. Deliberately NO
    // `Math.max(min, …)` floor: unlike the checkpoint — whose floor is what keeps
    // the tool's payload readable at all — a summary below the useful floor is
    // worth less than the bytes it costs, so the share is taken to zero and the
    // drop is disclosed instead.
    const carryingSummaries = rows
      .slice(0, fullRows)
      .filter((r) => {
        const s = (r.workItem as Row | undefined)?.summary;
        return typeof s === "string" && s.length > 0;
      }).length;
    const summaryShare =
      !withSummary || carryingSummaries === 0
        ? 0
        : Math.floor(summaryTotal / carryingSummaries);
    const summaryChars = summaryShare >= SUMMARY_USEFUL_MIN_CHARS ? summaryShare : 0;
    // Divided across the rows that actually HAVE a summary, so one row's read is
    // not rationed against 99 rows that would not have spent it. Deliberately NO
    // `Math.max(min, …)` floor: unlike the checkpoint — whose floor is what keeps
    // the tool's payload readable at all — a summary below the useful floor is
    // worth less than the bytes it costs, so the share is taken to zero and the
    // drop is disclosed instead.
    const carryingLifecycle = rows
      .slice(0, fullRows)
      .filter((r) => {
        const lc = (r.lifecycle as Row | undefined)?.events;
        return Array.isArray(lc) && lc.length > 0;
      }).length;
    const lifecycleShare =
      carryingLifecycle === 0 ? 0 : Math.floor(lifecycleTotal / carryingLifecycle);
    const lifecycleChars =
      lifecycleShare >= LIFECYCLE_USEFUL_MIN_CHARS ? lifecycleShare : 0;

    const singleItemFloor = rows.length === 1 && fullRows === 0;
    const stubCompletionEvidenceIds: unknown[] = [];
    const projected = rows.map((r, i) =>
      i < fullRows
        ? projectRow(r, caps, checkpointChars, summaryChars, lifecycleChars, dropped)
        : singleItemFloor
          ? compactSingleRow(r, caps, tier, dropped)
          : stubRow(r, dropped, stubCompletionEvidenceIds),
    );
    const stubbedCount = singleItemFloor ? 0 : Math.max(0, rows.length - fullRows);
    if (stubbedCount > 0) dropped.add(`rows(${stubbedCount} stubbed)`);
    const stubCompletionEvidence =
      stubCompletionEvidenceIds.length === 0
        ? undefined
        : stubCompletionEvidenceIds.length === stubbedCount
          ? { all: true as const }
          : { ids: stubCompletionEvidenceIds };

    // `read` is written by the source handler before this shaper runs. Preserve
    // its requested/availability counts, then add how many available rows this
    // tier leaves detailed versus id-only. Each id-only stub retains its own ID
    // as the reread handle; the later result-door must preserve those IDs ahead
    // of these aggregate counts.
    const readInfo =
      d.read && typeof d.read === "object" && !Array.isArray(d.read)
        ? (d.read as Row)
        : null;
    const availableRows = rows.flatMap((sourceRow, index) => {
      const shapedRow = projected[index];
      return sourceRow.ok === true && sourceRow.availability === "available" && shapedRow
        ? [{ sourceRow, shapedRow }]
        : [];
    });
    const detailRows = availableRows.filter(({ shapedRow }) => {
      const w = shapedRow.workItem;
      return shapedRow._stub !== true && w !== null && typeof w === "object";
    }).length;
    const existingStubRows = rows.filter((r) => r._stub === true).length;
    const availableCount =
      typeof readInfo?.available === "number"
        ? readInfo.available
        : availableRows.length + existingStubRows;
    const stubbedRows = Math.max(existingStubRows, availableCount - detailRows);

    // A clipped prior-attempt brief has a different recovery route from other
    // tier-relative clips. Its work_items:get contract exposes the full source
    // through priorAttemptRefs using the record's rawRef.
    const clippedPriorAttemptText = [...dropped].some(
      (field) => field.startsWith("priorAttempts.") && field.endsWith("(text clipped)"),
    );
    const otherDropsNeedFullTier = [...dropped].some(
      (field) => !(field.startsWith("priorAttempts.") && field.endsWith("(text clipped)")),
    );
    const tierRecoveryGuidance = otherDropsNeedFullTier
      ? `Fields were dropped or clipped for the '${tier}' tier. Re-read with payloadTier:'full' — it is FRAMEWORK-RESERVED and absent from this tool's published schema, so route it through your host's raw-args dispatch path (papercusp: tools:invoke { name:'work_items:get', args:{ …, payloadTier:'full' } }).`
      : "";

    out = {
      ...d,
      ...(readInfo
        ? {
            read: {
              ...readInfo,
              detailRows,
              stubbedRows,
            },
          }
        : {}),
      results: projected,
      ...(dropped.size > 0
        ? {
            _shapeNote: {
              tier,
              // Zero-budget fields are omitted, not emitted as 0: the dropped[]
              // names already carry the loss, and these bytes sit on a payload
              // graded against this very door (EI-21349427754992019 — three
              // zero-entries tipped borderline single-item reads over it).
              ...(checkpointChars > 0 ? { checkpointCharsPerRow: checkpointChars } : {}),
              ...(summaryChars > 0 ? { summaryCharsPerRow: summaryChars } : {}),
              ...(lifecycleChars > 0 ? { lifecycleCharsPerRow: lifecycleChars } : {}),
              dropped: [...dropped].sort(),
              ...(stubbedCount > 0
                ? {
                    stubbed: {
                      count: stubbedCount,
                      note: "stub rows preserve only id + _stub; re-read an id alone for detail",
                      ...(stubCompletionEvidence ? { completionEvidence: stubCompletionEvidence } : {}),
                    },
                  }
                : {}),
              ...(singleItemFloor
                ? {
                    singleItemFloor:
                      "Exact single-item reads preserve reduced identity; diagnostic fields were clipped or omitted. Re-read with payloadTier:'full' for the complete record.",
                  }
                : {}),
              // The generic sentence is not enough when the dropped field is the
              // item's PROSE: a reader who still has the title reads a size
              // advisory as "you got the item, just smaller" and acts on the
              // label. Name that specific loss, once per payload (never per row
              // — D-012).
              next: `${
                dropped.has("workItem.summary")
                  ? "⚠ The SUMMARY was dropped — you have this item's TITLE and no sentence of its body. A title is a LABEL: do not act on it. Re-read before deciding anything. "
                  : ""
              }${
                [...dropped].some(
                  (field) =>
                    field === "completion" ||
                    field.startsWith("completion.") ||
                    field === "workItem.terminalCompletionEvidence" ||
                    field.startsWith("workItem.terminalCompletionEvidence."),
                  )
                  ? "⚠ COMPLETION EVIDENCE EXISTS but its body was clipped or reduced at this tier; `hasCompletionEvidence` (or `_shapeNote.stubbed.completionEvidence` for stub rows) remains authoritative. Re-read with payloadTier:'full' before treating the item as evidence-free. "
                  : ""
              }${
                clippedPriorAttemptText
                  ? "Prior-attempt record text marked `textTruncated` has a field-specific drill-down. Re-read it with its `rawRef` in `priorAttemptRefs`; a `payloadTier:'full'` retry alone does not retrieve that record's full source text. "
                  : ""
              }${tierRecoveryGuidance}`,
            },
          }
        : {}),
    };
    // Measured, not assumed. The last attempt is the floor and ships regardless.
    if (jsonLen(out) <= target || attempt === attempts.length - 1) return out;
  }
  return out;
}
