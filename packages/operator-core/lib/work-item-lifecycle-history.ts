/**
 * work-item-lifecycle-history — the unified READ over a work-item's lifecycle record
 * (EI-19397599078921465).
 *
 * ## Why this exists: the defect was DISCOVERABILITY, not instrumentation
 *
 * The filing that produced this module claimed work-item lifecycle history was not
 * recorded at all — "zero state transitions are audited", "a force:true reopen leaves
 * no trace". A premise audit falsified both:
 *
 *   - 71 of 176 `work_items:claim_hold:set` audit rows ARE blocked-transitions (an
 *     issue-family `→ blocked` auto-parks, and the park audits — see work-items.ts).
 *   - 838 items carry 842 `payload.reopenHistory` entries, force:true included. The
 *     NEWEST such entry had been written by the filer themselves ~1h before they filed.
 *
 * The history existed. It was simply spread across THREE unrelated stores with nothing
 * tying them together, so a competent agent queried one, found nothing relevant, and
 * correctly concluded "unanswerable". Adding a fourth store would have made that worse.
 * This module adds a READ instead:
 *
 *   1. `harness_shared.audit_log`      — holds/releases, force-releases, and (post-fix)
 *                                        feature-family `→ blocked` transitions
 *   2. `work_items.payload.reopenHistory` — reopens of a terminal state, incl. force
 *   3. `work_items.payload` flags      — needsHuman / _claimHold / held_open_* (current
 *                                        STATE, not a transition — reported separately)
 *
 * ## The `coverage` field is the point, not a courtesy
 *
 * The original bug was an ABSENCE misread as an ANSWER: an empty query result read as
 * "this never happened" when it actually meant "this is not the store that would know".
 * A unified timeline that returns `events: []` would reproduce that failure exactly, one
 * layer up. So every result carries `coverage`, which states what IS and is NOT recorded
 * for this item's family — making "nothing was recorded" and "nothing happened"
 * distinguishable at the point of reading, which is the only place it matters.
 *
 * Read-only and fail-soft throughout: this decorates a work-item read and must never be
 * able to fail one.
 */
import { getOrgPg } from '@papercusp/db-org';

/** A single thing that happened to a work-item, normalized across the three stores. */
export interface WorkItemLifecycleEvent {
  /** ISO-8601 UTC. */
  at: string;
  /** Epoch ms — the sort key, exposed so callers can range-filter without re-parsing. */
  atMs: number;
  /**
   * What happened. `other` is deliberate rather than a catch-all bug: audit actions are
   * added over time, and an unrecognized one must still appear in the timeline (with its
   * raw `action`) instead of being silently dropped — dropping is the failure mode this
   * whole module exists to correct.
   */
  kind: 'blocked' | 'held' | 'released' | 'reopened' | 'force-released' | 'other';
  /** The actor, when the source recorded one. `null` means unrecorded, not "system". */
  by: string | null;
  /** Which store this came from — so a reader can tell how much to trust it. */
  source: 'audit_log' | 'reopenHistory';
  /** The raw audit action, present for `source: 'audit_log'`. */
  action?: string;
  /** Source-specific extras (reason, prevState, terminalOwner, force, …). */
  detail?: Record<string, unknown>;
}

/** Current lifecycle FLAGS — state, not transitions. Kept separate on purpose. */
export interface WorkItemLifecycleFlags {
  needsHuman: boolean;
  claimHold: boolean;
  heldOpenBy: string | null;
  heldOpenReason: string | null;
}

export interface WorkItemLifecycleCoverage {
  /** Rows read from audit_log for this subject. */
  auditRows: number;
  /** Entries found in payload.reopenHistory (bounded to the newest 5 by the writer). */
  reopenEntries: number;
  /**
   * What is NOT recorded for this item, in plain words. ALWAYS populated — an empty
   * timeline plus an empty caveat list is what let the original misreading happen.
   */
  notRecorded: string[];
  /** True when a source could not be read (as opposed to being genuinely empty). */
  degraded: boolean;
}

export interface WorkItemLifecycleHistory {
  events: WorkItemLifecycleEvent[];
  flags: WorkItemLifecycleFlags;
  coverage: WorkItemLifecycleCoverage;
}

/**
 * Transitions that leave NO record anywhere, stated per family so the caveat is true
 * rather than merely cautious. Kept next to the reader (not the writer) because this is
 * what a READER needs in order not to over-read an empty timeline.
 */
function notRecordedFor(family: string | null | undefined): string[] {
  const caveats = [
    "non-terminal transitions (→ wip, → open) are not recorded in any store — an empty timeline never means 'this item never moved'",
  ];
  if (family === 'issue') {
    caveats.push(
      '→ needs-human sets payload.needsHuman but records no dated transition — see flags.needsHuman for the current value, which carries no timestamp',
    );
  } else {
    caveats.push(
      'this item is feature-family: → needs-human is not flagged or dated, and → blocked was not recorded at all before EI-19397599078921465 — entries here begin at that fix',
    );
  }
  return caveats;
}

/** Map an audit action onto a timeline `kind`, preserving the raw action either way. */
function classify(action: string, details: Record<string, unknown> | null): WorkItemLifecycleEvent['kind'] {
  if (action === 'work_items:state:blocked') return 'blocked';
  if (action === 'work_items:release:force' || action === 'work_items:claim:force_claim_hold') {
    return 'force-released';
  }
  if (action === 'work_items:claim_hold:set') {
    // An issue-family `→ blocked` reaches audit_log ONLY as a claim-hold side effect,
    // tagged reason='blocked' by the auto-park. Surfacing it as `held` would hide the
    // very transition this module was built to answer — it is a block, recorded obliquely.
    return details?.reason === 'blocked' ? 'blocked' : 'held';
  }
  if (action === 'work_items:claim_hold:clear') return 'released';
  return 'other';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Read the unified lifecycle history for one work-item.
 *
 * Fail-soft by contract: any source that cannot be read is reported via
 * `coverage.degraded` rather than throwing, because this decorates a work-item read.
 * A caller that gets `degraded: true` knows the timeline is INCOMPLETE — which is a
 * different fact from an empty one, and the distinction the original bug turned on.
 */
export async function getWorkItemLifecycleHistory(params: {
  id: string;
  workspaceId: string;
  payload?: unknown;
  family?: string | null;
  limit?: number;
}): Promise<WorkItemLifecycleHistory> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const payload = asRecord(params.payload);
  const events: WorkItemLifecycleEvent[] = [];
  let degraded = false;
  let auditRows = 0;

  // ---- source 1: audit_log -------------------------------------------------
  try {
    const { sql } = getOrgPg();
    const rows = (await sql.unsafe(
      `SELECT ts, actor, action, details
         FROM harness_shared.audit_log
        WHERE workspace_id = $1 AND subject = $2 AND action LIKE 'work_items:%'
        ORDER BY ts DESC
        LIMIT $3`,
      [params.workspaceId, params.id, limit],
    )) as Array<{ ts: number | string; actor: string | null; action: string; details: unknown }>;
    auditRows = rows.length;
    for (const row of rows) {
      const atMs = Number(row.ts);
      if (!Number.isFinite(atMs)) continue;
      const details = asRecord(row.details);
      // `actor` is NOT NULL in schema with a 'user' default, and the claim-hold writer
      // substitutes the literal 'system' when it has no actor. Neither is a real identity,
      // so both normalize to null — reporting "system blocked this" would be a fabricated
      // attribution, and a wrong name is worse than an admitted absence.
      const rawActor = typeof row.actor === 'string' ? row.actor : null;
      const by = rawActor && rawActor !== 'system' && rawActor !== 'user' ? rawActor : null;
      events.push({
        at: new Date(atMs).toISOString(),
        atMs,
        kind: classify(row.action, details),
        by,
        source: 'audit_log',
        action: row.action,
        ...(details ? { detail: details } : {}),
      });
    }
  } catch {
    degraded = true;
  }

  // ---- source 2: payload.reopenHistory ------------------------------------
  const reopenRaw = payload?.reopenHistory;
  const reopenList = Array.isArray(reopenRaw) ? reopenRaw : [];
  for (const entry of reopenList) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const at = typeof rec.at === 'string' ? rec.at : null;
    const atMs = at ? Date.parse(at) : NaN;
    if (!Number.isFinite(atMs)) continue;
    // Pass the entry through WHOLE rather than picking known keys. `reopenHistory` is an
    // actively-growing record — EI-19393880133572803 is archiving `_completionEvidence` into
    // these same entries as this is written — and a hardcoded key list would silently drop
    // each new field as it lands, reproducing one layer down the exact "the data exists but
    // nothing surfaces it" defect this module exists to end. `at`/`by` are lifted to the
    // event's own typed fields, so they are dropped from `detail` to avoid restating them;
    // `force` is normalized to a strict boolean because it is the field readers branch on.
    const { at: _at, by: _by, ...rest } = rec;
    events.push({
      at: new Date(atMs).toISOString(),
      atMs,
      kind: 'reopened',
      by: typeof rec.by === 'string' ? rec.by : null,
      source: 'reopenHistory',
      detail: { ...rest, force: rec.force === true },
    });
  }

  // Newest first, matching every other agent-facing history read.
  events.sort((a, b) => b.atMs - a.atMs);

  const heldOpenBy = typeof payload?.held_open_by === 'string' ? payload.held_open_by : null;
  const heldOpenReason =
    typeof payload?.held_open_reason === 'string'
      ? payload.held_open_reason
      : typeof payload?.claim_hold_reason === 'string'
        ? payload.claim_hold_reason
        : null;

  return {
    events: events.slice(0, limit),
    flags: {
      needsHuman: payload?.needsHuman === true,
      // Written as the STRING 'true' by the claim-hold path's jsonb merge; accept both
      // so a shape change upstream degrades to a missed flag, never a crash.
      claimHold: payload?._claimHold === true || payload?._claimHold === 'true',
      heldOpenBy,
      heldOpenReason,
    },
    coverage: {
      auditRows,
      reopenEntries: reopenList.length,
      notRecorded: notRecordedFor(params.family),
      degraded,
    },
  };
}
