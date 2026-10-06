/**
 * reflect-orphaned-plan-items.ts — the PERIODIC data-heal for the *reflect*
 * direction (work_item terminal → plan item still `todo`).
 *
 * ─ THE ASYMMETRY THIS CLOSES ─────────────────────────────────────────────────
 * The plan-item ⇄ work-item lifecycle has two mirror directions, and until now
 * only ONE of them had a periodic backstop:
 *
 *   A. plan item goes `done`  → heal its linked work-items
 *      reaction: plan-items/reconcile-rule.ts
 *      SWEEP:    system:plan-item-orphan-reconcile  (reconcileOrphanedPlanItemWorkItems)
 *
 *   B. work_item goes terminal → heal its linked plan item
 *      reaction: plan-items/reflect-rules.ts
 *      SWEEP:    *** none — this file ***
 *
 * Direction B was reaction-ONLY, so any event the reaction missed became
 * PERMANENT residue: the rule fires off the live `work_items:*` tool event, so a
 * close that happened while the rule was broken (EI-6960's "silently NEVER
 * fired" window), during an operator restart, or through a path that never
 * emitted the event, leaves the plan item reading `todo` forever with nothing
 * to re-heal it. Measured on this install 2026-08-13: **30 plan items** sat
 * `todo` while every work-item linked to them was already terminal — the exact
 * phantom-todo that makes agents re-investigate (and nearly re-implement)
 * finished work (EI-18713141708830049; four such items cost ~1h of a single
 * wake on shared-hive-cross-machine-scale-10k-2026-06-29 alone).
 *
 * Note this sweep is NOT a substitute for the reaction and does not overlap it:
 * the same measurement showed 349 stamped work-items closed in the 7 days to
 * 2026-08-13 with ZERO new phantoms, i.e. the reaction works when it fires. This
 * is purely the backstop for when it does not.
 *
 * ─ SAFETY RAILS (the reason this is narrower than it looks) ──────────────────
 * A mis-flipped plan item silently marks a live defect fixed, so the predicate
 * is deliberately strict — `decideReflectFlip` below flips ONLY when:
 *   - the plan item is currently `todo` (never wip/blocked/needs-human, each of
 *     which carries an active agent/human signal this must not overwrite);
 *   - it has at least one linked work-item, and at least one is done-like;
 *   - EVERY linked work-item is terminal — one non-terminal sibling means the
 *     item is legitimately still open;
 *   - NO linked work-item carries independent in-flight progress
 *     (`last_progress_at`), the same rail the direction-A sweep uses.
 * On the live population that predicate discriminates rather than rubber-stamps:
 * of 112 `todo` items carrying links, it selects 30 and leaves 82 alone.
 *
 * The flip is fired through the REAL `plans:set-status` tool (exactly as
 * reflect-rules.ts does) so it inherits the plan lock, revision capture,
 * plan-event emit and needs-human push gating — never a raw UPDATE. The target
 * status comes from reflect-rules' own exported `reflectedStatus`, so the sweep
 * and the reaction can never drift apart on the mapping.
 *
 * Fail-closed and idempotent: a candidate whose flip errors is recorded and
 * skipped (never throws — a routine tick must not die on one bad row), and a
 * re-sweep of already-healed data selects nothing.
 *
 * Homed on the `system:plan-item-reflect-orphan-reconcile` routine (a bounded
 * periodic sweep — NOT a bare setInterval), mirroring its direction-A twin.
 */
import { getOrgPg } from '@papercusp/db-org';
import { handleHttpToolRequest } from '@papercusp/agent-mcp';
import { PROJECTED_DEPS } from '../projected-tool-deps';
import { reflectedStatus } from './reflect-rules';

/** Default per-tick candidate cap, mirroring DEFAULT_ORPHAN_SWEEP_CAP. */
export const DEFAULT_REFLECT_SWEEP_CAP = 500;

/** The per-plan-item tally of its linked work-items that the decision reads. */
export interface LinkedTally {
  /** total work-items linked to this plan item via the `payload.plan_item` stamp */
  linked: number;
  /** how many are done-like (done | resolved | passed) */
  doneLike: number;
  /** how many are terminal in EITHER family (done-like + closed | deprecated | dropped) */
  terminal: number;
  /** how many are NON-terminal AND carry independent in-flight progress */
  liveProgress: number;
}

export type ReflectDecision =
  | { flip: true; to: 'done' }
  | {
      flip: false;
      reason: 'no-links' | 'in-flight-progress' | 'live-sibling' | 'no-done-link';
    };

/**
 * PURE decision: may this `todo` plan item be reflected to `done`?
 *
 * Kept free of I/O so both directions of the rail are unit-testable — the
 * positive case AND every refusal — without a database. Order is most-specific
 * first: `liveProgress > 0` implies a non-terminal sibling, so it is checked
 * before the coarser `live-sibling`, giving the more actionable reason.
 */
export function decideReflectFlip(t: LinkedTally): ReflectDecision {
  if (t.linked <= 0) return { flip: false, reason: 'no-links' };
  if (t.liveProgress > 0) return { flip: false, reason: 'in-flight-progress' };
  if (t.terminal < t.linked) return { flip: false, reason: 'live-sibling' };
  if (t.doneLike <= 0) return { flip: false, reason: 'no-done-link' };
  return { flip: true, to: 'done' };
}

export interface ReflectSweepResult {
  /** distinct `todo` plan items carrying at least one stamped link, this tick */
  candidatePlanItems: number;
  /** `${planSlug}#${itemId}` actually flipped to done */
  flipped: string[];
  /** refused, grouped by the decision's reason (`no-links`, `live-sibling`, …) */
  skipped: Record<string, string[]>;
  /** `${planSlug}#${itemId}: <message>` — a flip that errored (recorded, never thrown) */
  failed: string[];
}

interface CandidateRow {
  plan_slug: string;
  item_id: string;
  harness_slug: string | null;
  linked: string;
  done_like: string;
  terminal: string;
  live_progress: string;
}

const HOST_EXTRAS = {
  deps: PROJECTED_DEPS,
  log: () => {},
  validateSuperuser: () => true,
};

/** Fire the real `plans:set-status` tool for one item. Throws on failure. */
async function firePlanSetStatus(
  planSlug: string,
  itemId: string,
  status: string,
  harnessSlug: string | null,
): Promise<void> {
  const sp = new URLSearchParams({ superuser: '1', client: 'plan-item-reflect-sweep' });
  if (harnessSlug && harnessSlug.trim()) sp.set('harness', harnessSlug.trim());
  const res = await handleHttpToolRequest(
    {
      method: 'POST',
      pathname: '/api/agent-tools/plans/set-status',
      searchParams: sp,
      headers: {},
      body: { slug: planSlug, item: itemId, status },
    },
    HOST_EXTRAS,
  );
  if (res.status !== 200) {
    const b = res.body as Record<string, unknown> | undefined;
    throw new Error((b?.error as string | undefined) ?? `plans:set-status returned ${res.status}`);
  }
  const b = res.body as { content?: Array<{ type: string; text?: string }> };
  const parsed = JSON.parse(b.content?.find((c) => c.type === 'text')?.text ?? '{}') as Record<
    string,
    unknown
  >;
  if (parsed && parsed.ok === false) {
    throw new Error(typeof parsed.error === 'string' ? parsed.error : 'plans:set-status reported ok:false');
  }
}

/**
 * The sweep. Enumerates `todo` plan items whose linked work-items are all
 * terminal, and reflects them to `done` through the real tool.
 */
export async function reflectOrphanedPlanItems(
  opts: { candidateCap?: number } = {},
): Promise<ReflectSweepResult> {
  const cap = opts.candidateCap && opts.candidateCap > 0 ? opts.candidateCap : DEFAULT_REFLECT_SWEEP_CAP;
  const out: ReflectSweepResult = {
    candidatePlanItems: 0,
    flipped: [],
    skipped: {},
    failed: [],
  };
  const note = (reason: string, ref: string) => {
    (out.skipped[reason] ??= []).push(ref);
  };

  const { sql } = getOrgPg();

  // ONE aggregate query: tally each `todo` plan item's stamped work-items.
  // Workspace-agnostic on the stamp exactly like findAllLinkedWorkItems; the
  // join is keyed on (workspace, harness, plan, item) so a same-named plan in a
  // different install can never cross-contaminate the tally.
  const rows = await sql<CandidateRow[]>`
    SELECT p.plan_slug,
           p.item_id,
           p.harness_slug,
           count(*)                                                        AS linked,
           count(*) FILTER (WHERE w.status IN ('done','resolved','passed')) AS done_like,
           count(*) FILTER (WHERE w.status IN ('done','resolved','passed',
                                               'closed','deprecated','dropped')) AS terminal,
           count(*) FILTER (WHERE w.last_progress_at IS NOT NULL
                              AND w.status NOT IN ('done','resolved','passed',
                                                   'closed','deprecated','dropped')) AS live_progress
      FROM harness_shared.plan_items p
      JOIN harness_shared.work_items w
        ON w.payload->'plan_item'->>'plan_slug' = p.plan_slug
       AND w.payload->'plan_item'->>'item_id'   = p.item_id
       AND w.harness_slug                        = p.harness_slug
       AND w.workspace_id                        = p.workspace_id
     WHERE p.status = 'todo'
       AND w.payload->'plan_item' IS NOT NULL
     GROUP BY p.workspace_id, p.plan_slug, p.item_id, p.harness_slug
     -- WI-10004586 (same class as the orphan-reconcile sweep): rotate the window so a
     -- saturated population is eventually fully visited instead of the planner
     -- returning the same arbitrary first cap groups every tick. Latent here —
     -- measured 291 groups vs the 500 cap on 2026-10-01.
     ORDER BY random()
     LIMIT ${cap}`;

  out.candidatePlanItems = rows.length;

  for (const r of rows) {
    const ref = `${r.plan_slug}#${r.item_id}`;
    const decision = decideReflectFlip({
      linked: Number(r.linked),
      doneLike: Number(r.done_like),
      terminal: Number(r.terminal),
      liveProgress: Number(r.live_progress),
    });
    if (!decision.flip) {
      note(decision.reason, ref);
      continue;
    }
    // Route the target through reflect-rules' own mapping so the sweep can never
    // disagree with the reaction about what a done-like work-item reflects to.
    const target = reflectedStatus('done');
    if (target !== 'done') {
      note('mapping-refused', ref);
      continue;
    }
    try {
      await firePlanSetStatus(r.plan_slug, r.item_id, target, r.harness_slug);
      out.flipped.push(ref);
    } catch (e) {
      out.failed.push(`${ref}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return out;
}
