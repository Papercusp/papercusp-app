/**
 * Cited work-item refs — extract (WI|EI)-NNN tokens from plan-item prose and
 * batch-resolve their CURRENT state, so a stale citation (e.g. "...refuses it
 * (WI-7135)") surfaces its resolved state instead of rotting silently in text.
 *
 * Filed as EI-22173576329267385: a work-item's `title` restates the original
 * report and is never rewritten when the item closes — `state` moves to
 * `done`, the title still reads as a live defect. A plan item (or doc, or
 * checkpoint) authored by quoting a title inherits a RESOLVED defect as
 * though it were current, and reads as unusually well-evidenced precisely
 * because it carries a genuine, resolvable work-item citation. The citation
 * is real; the tense is wrong. Verified instance: plan
 * `silent-wrong-answers-2026-08-01` item P-024 (dropped 2026-09-02, D-112)
 * was authored, planned, prioritized and queued against WI-7135, which had
 * been `done` for 11 days — caught only because the picking agent re-probed
 * the premise before implementing.
 *
 * This is the DERIVE rung of the derived-truth ladder
 * (/internal/docs/agent-insights/derived-truth-ladder) applied to that
 * citation: surface the cited work-item's state where the item is read,
 * never adjudicate staleness. Whether a citation is load-bearing (the item's
 * premise) or merely background (a "see also") stays a reading task for the
 * picking agent or a human — most citations of a terminal work-item are
 * legitimate history, not a live premise, so a detector that flagged every
 * one as "this item is stale" would reproduce the exact error it exists to
 * catch (measured on one plan: 6 of 24 non-terminal items cite a terminal
 * work-item; only one was verified load-bearing).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';
import { activeWorkspaceId } from '../../workspace-registry';

/** Matches WI-123 / EI-456 tokens, word-bounded so it never clips a longer id. */
const WORK_ITEM_REF_RE = /\b(?:WI|EI)-\d+\b/g;

/** Extract the distinct WI-/EI- refs cited in one item's prose, first-seen order. */
export function extractWorkItemRefs(text: string): string[] {
  if (!text) return [];
  return Array.from(new Set(text.match(WORK_ITEM_REF_RE) ?? []));
}

export interface CitedWorkItemRefState {
  ref: string;
  /** null when the ref does not resolve to any work-item in the active
   *  workspace (a typo'd id, or one from another workspace). Surfaced as-is —
   *  an unresolved ref is itself a signal (the citation may be wrong), not
   *  something to hide. */
  state: string | null;
  terminal: boolean;
}

/**
 * Batch-resolve refs → their current work-item state, scoped to the active
 * workspace (matches every other cross-plan overlay in this file family —
 * see getAllBlockedPlanItems in issue-blocks-merge.ts). `feature_id` is not
 * guaranteed globally unique across harnesses within a workspace
 * (work_items:get disambiguates a repeated id with `harness`); an ambiguous
 * ref here resolves to its most recently updated match, a reasonable default
 * for a diagnostic overlay and never worse than surfacing nothing.
 *
 * Non-fatal by contract at the call site: this queries a DIFFERENT table
 * (harness_shared.work_items) than the plan read it's overlaid onto, so a
 * failure here must never fail a plans:items call — callers should degrade
 * to no overlay on error, exactly like getAllBlockedPlanItems.
 */
export async function getWorkItemRefStates(
  refs: string[],
  /**
   * WI-2142684: a background sweep (no per-window request context) must never
   * resolve `activeWorkspaceId()` — that reads request-scoped/process-pinned
   * ambient state, which is simply the WRONG workspace for a routine iterating
   * many workspaces. `sql`/`workspaceId` let such a caller pass its own
   * already-scoped connection + explicit target instead of relying on ambient
   * state; both default to the prior (request-scoped) behavior, so the one
   * existing caller (items.ts, itself request-scoped) is unaffected.
   */
  opts: { sql?: Sql; workspaceId?: string } = {},
): Promise<Map<string, CitedWorkItemRefState>> {
  const out = new Map<string, CitedWorkItemRefState>();
  if (refs.length === 0) return out;
  const sql = opts.sql ?? getOrgPg().sql;
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const rows = await sql<{ feature_id: string; status: string | null }[]>`
    SELECT DISTINCT ON (feature_id) feature_id, status
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND feature_id = ANY(${refs}::text[])
     ORDER BY feature_id, updated_ts DESC`;
  for (const r of rows) {
    const state = r.status ?? null;
    out.set(r.feature_id, {
      ref: r.feature_id,
      state,
      terminal: state != null && (ANY_FAMILY_TERMINAL_STATES as readonly string[]).includes(state),
    });
  }
  // A ref with no matching row (typo'd id, or one from another workspace) does
  // not resolve — per the interface doc above, that is surfaced AS a null-state
  // entry, not silently dropped: the caller's null-check already renders it
  // "unknown" (see items-shape.ts), and hiding it would suppress exactly the
  // "this citation may be wrong" signal the field exists to carry.
  for (const ref of refs) {
    if (!out.has(ref)) out.set(ref, { ref, state: null, terminal: false });
  }
  return out;
}
