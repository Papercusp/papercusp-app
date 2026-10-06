/**
 * SPEC TRIAD auto-file sweep — okf-frontmatter-adoption workstream H(b).
 *
 * This is the half that makes the triad requirement a QUEUE rather than a WALL.
 *
 * `plans:items` holds an in-scope plan's items back from `actionable` when the
 * plan owes `## Requirements` / `## Design` (spec-triad-policy.ts). On its own
 * that is a gate with no exit — the work stops and waits for someone to notice.
 * This sweep is the exit: for every plan that owes the triad it files ONE work
 * item, unassigned, which any agent can claim through the ordinary claim path.
 * The gate then resolves itself.
 *
 * That structure is deliberate and non-negotiable per the standing design
 * mandate: a design that routes a decision to a person is a defect. Nothing here
 * escalates, notifies a human, or waits for approval — it files claimable work.
 *
 * ## Safety rails, in the order they matter
 *
 *  1. **Bounded filing.** At most {@link SPEC_TRIAD_MAX_FILINGS_PER_RUN} items per
 *     run. If the epoch is ever moved backwards by mistake, the blast radius is
 *     one batch and a loud log line — not several hundred work items.
 *  2. **Idempotent.** Each filing stamps `payload.specTriadPlan` with the plan's
 *     fully-qualified ref; a plan with a non-terminal filing already open is
 *     skipped. Re-running the sweep is a no-op, which is what lets it be daily.
 *  3. **Cheap candidate selection.** Phase 1 reads plan METADATA only (no
 *     `content`) so the common case costs one small scan; phase 2 fetches content
 *     for the handful of rows that survive the scope test. A naive
 *     `SELECT content FROM harness_plans` would move tens of MB per tick.
 *  4. **Never throws.** A thrown step makes DBOS mark the workflow permanently
 *     dead — i.e. a transient error would stop the sweep FOREVER, silently. Every
 *     leg degrades to a warn.
 *
 * Kill-switch: `PAPERCUSP_SPEC_TRIAD_SWEEP=0`, or turn the
 * `SPEC_TRIAD_REQUIRED` flag off (which also un-gates `plans:items`).
 */

import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { describeSpecTriadGap } from '@papercusp/plan-parser';
import {
  specTriadGate,
  specTriadEpoch,
  planInSpecTriadScope,
  isSpecTriadExcludedTemplate,
  SPEC_TRIAD_EXCLUDED_TEMPLATES,
} from './spec-triad-policy';
import { ensureSpecTriadFiling, SPEC_TRIAD_NON_TERMINAL_STATUSES } from './spec-triad-filing';
import { setWorkItemState } from '../../work-items';

/** Upper bound on work items filed in a single run. See the rails note above. */
export const SPEC_TRIAD_MAX_FILINGS_PER_RUN = 25;

/**
 * Plan statuses the SWEEP will file against.
 *
 * `draft` is deliberately EXCLUDED (EI-20607174902714110). It used to be here on
 * the reading that a draft "still has work ahead of it" — true, but that conflates
 * HAS WORK AHEAD with IS APPROVED TO BE WORKED, and for the backstop only the
 * second one licenses a filing.
 *
 * The triad is not paperwork; it is the interlock. `plans:items` holds a plan's
 * items out of `actionable` while a leg is missing, and does so WITHOUT marking
 * anything blocked — so for an unapproved draft that absence is the ONLY thing
 * keeping its work unclaimable. Filing "write the missing triad" against such a
 * plan therefore reads as ordinary work while actually being "make this un-ruled
 * plan's items pickable": an agent doing exactly what the item says, in good
 * faith, walks a steward's revision-hold or an owner's needs-human gate straight
 * open. Measured 2026-08-16: six such filings were open at once, one of them
 * against a plan gated on the owner for auth/security reasons.
 *
 * Excluding drafts costs at most one sweep interval of latency: the moment a plan
 * is approved (draft→ready) the next run files for it, and `promotePlanItems`
 * still files IMMEDIATELY on the promotion path, where the act of promoting is
 * itself the intent that a draft lacks. So "the gate always has an exit" survives
 * for every plan actually cleared to be worked.
 */
// `awaiting-acceptance` (P-004) is INCLUDED deliberately. "Live" here means
// "still headed for a ship gate", not "still being implemented": a drained plan
// has to satisfy the same spec-triad requirement before it can ship, so
// dropping it from the sweep would let it escape enforcement in the window
// between draining and shipping — and it would then meet that requirement for
// the first time AT the gate, which is the worst possible moment to discover it.
export const LIVE_PLAN_STATUSES = ['ready', 'active', 'awaiting-acceptance'];

export interface SpecTriadSweepResult {
  skipped: boolean;
  reason?: string;
  /** Plans whose metadata was examined. */
  scanned: number;
  /** Plans in scope for the requirement. */
  inScope: number;
  /** In-scope plans missing at least one leg. */
  owing: number;
  /** Work items filed this run. */
  filed: number;
  /** Owing plans that already had an open filing. */
  alreadyFiled: number;
  /** Owing plans left unfiled because the per-run cap was hit. */
  deferred: number;
  /** Open filings closed because their plan ref no longer resolves to a live plan. */
  reconciled: number;
  /** Reconciliation closes that failed (non-fatal; retried next run). */
  reconcileFailed: number;
  /** Reconcilable filings left unclosed past the per-run cap. */
  reconcileDeferred: number;
  filedIds: string[];
  summary: string;
}

interface PlanMetaRow {
  workspace_id: string;
  harness_slug: string;
  plan_slug: string;
  created: string | null;
  has_declaration: boolean;
}

export interface PlanContentRow {
  workspace_id: string;
  harness_slug: string;
  plan_slug: string;
  created: string | null;
  content: string;
  items: unknown;
}

export function planRef(r: { workspace_id: string; harness_slug: string; plan_slug: string }): string {
  return `${r.workspace_id}/${r.harness_slug}/${r.plan_slug}`;
}

function itemCountOf(items: unknown): number | undefined {
  return Array.isArray(items) ? items.length : undefined;
}

export interface SpecTriadOwing {
  row: PlanContentRow;
  missing: string[];
  gap: string;
}

export interface SpecTriadSelection {
  inScope: number;
  owing: SpecTriadOwing[];
  /** Owing AND not already filed — the filing candidates, pre-cap. */
  toFile: SpecTriadOwing[];
  /** The ≤`maxFilings` prefix of `toFile` this run will actually file. */
  batch: SpecTriadOwing[];
  deferred: number;
  alreadyFiled: number;
}

/**
 * The sweep's whole DECISION, as a pure function over rows it was handed.
 *
 * Extracted so the parts that can silently go wrong — the scope test, the
 * dedupe, and the per-run cap — are testable without a database. The I/O around
 * it (two SELECTs and N inserts) has no branching left to get wrong.
 */
export function selectSpecTriadFilings(input: {
  rows: PlanContentRow[];
  /** Plan refs with a non-terminal filing already open. */
  alreadyOpen: ReadonlySet<string>;
  /** Refs that passed the metadata-only candidate filter, when phase 1 ran. */
  candidateKeys?: ReadonlySet<string>;
  epoch: Date;
  maxFilings: number;
}): SpecTriadSelection {
  const { rows, alreadyOpen, candidateKeys, epoch, maxFilings } = input;
  const owing: SpecTriadOwing[] = [];
  let inScope = 0;

  for (const row of rows) {
    // The phase-2 `plan_slug = ANY(...)` can widen across tenants (the key is
    // workspace+harness+slug, the IN-list is slugs alone), so re-narrow here.
    if (candidateKeys && !candidateKeys.has(planRef(row))) continue;
    const verdict = specTriadGate(
      {
        planSlug: row.plan_slug,
        content: row.content,
        created: row.created,
        itemCount: itemCountOf(row.items),
      },
      { flagEnabled: true, epoch },
    );
    if (verdict.scope.inScope) inScope++;
    if (!verdict.gated || !verdict.triad) continue;
    owing.push({ row, missing: verdict.missing, gap: describeSpecTriadGap(verdict.triad) });
  }

  const toFile = owing.filter((o) => !alreadyOpen.has(planRef(o.row)));
  const batch = toFile.slice(0, Math.max(0, maxFilings));
  return {
    inScope,
    owing,
    toFile,
    batch,
    deferred: toFile.length - batch.length,
    alreadyFiled: owing.length - toFile.length,
  };
}

/** Lifecycle actor for reconciliation closes — matches the filings' `createdBy`. */
export const SPEC_TRIAD_ACTOR = 'system:spec-triad';

/** One open triad filing, as the reconciliation leg reads it. */
export interface SpecTriadOpenFiling {
  feature_id: string;
  workspace_id: string;
  harness_slug: string;
  /** `payload.specTriadPlan` — the `workspace/harness/slug` ref stamped at filing time. */
  ref: string;
}

/**
 * `harness_plans.template` values the sweep never files against (WI-10004229). The
 * list is owned by the shared scope verdict (spec-triad-policy.ts) since WI-10005441,
 * so the promotion runner applies the same exclusion; re-exported for existing importers.
 */
export { SPEC_TRIAD_EXCLUDED_TEMPLATES };

/** Where a plan row actually lives, plus the fields the liveness predicate reads. */
export interface SpecTriadPlanLocator {
  workspace_id: string;
  harness_slug: string;
  plan_slug: string;
  status: string | null;
  archived: boolean;
  is_legacy: boolean;
  /** `harness_plans.template` — a rubric row is never sweep-live. */
  template: string | null;
}

/**
 * EXACT mirror of the sweep's phase-1 candidate predicate (a NULL status counts
 * as live, matching `status IS NULL OR status = ANY(LIVE_PLAN_STATUSES)`; a
 * template in SPEC_TRIAD_EXCLUDED_TEMPLATES is never live). The
 * reconciliation leg must answer "would the sweep file for this row TODAY?"
 * with the sweep's own test, or the two legs fight each other.
 */
export function planRowIsSweepLive(
  p: Pick<SpecTriadPlanLocator, 'status' | 'archived' | 'is_legacy' | 'template'>,
): boolean {
  return (
    !p.archived &&
    !p.is_legacy &&
    !isSpecTriadExcludedTemplate(p.template) &&
    (p.status === null || LIVE_PLAN_STATUSES.includes(p.status))
  );
}

export type SpecTriadReconcileReason = 'plan-missing' | 'plan-not-live';

export interface SpecTriadReconciliation {
  filing: SpecTriadOpenFiling;
  reason: SpecTriadReconcileReason;
  /** The close's completionRef — states the resolved facts, not just a verdict. */
  detail: string;
}

export interface SpecTriadReconcileSelection {
  /** The ≤maxCloses filings this run will close. */
  toClose: SpecTriadReconciliation[];
  /** Filings whose ref resolves to a live plan — legitimate, untouched. */
  kept: number;
  /** Filings whose ref did not parse as workspace/harness/slug — NEVER closed. */
  unparseable: number;
  /** Reconcilable filings past the cap, reported rather than silently dropped. */
  deferred: number;
}

/**
 * RECONCILIATION decision, as a pure function over rows it was handed (the same
 * extraction rationale as `selectSpecTriadFilings` above).
 *
 * The defect this closes (WI-38838 / WI-39038): a filing can outlive its plan's
 * coordinates. The 2026-08-14 sb-devboard-hive→sidestage re-home raced the sweep
 * mid-run, so two filings landed with the PRE-move harness in their
 * `specTriadPlan` ref. The exact-ref dedupe then never matches them again — the
 * sweep correctly files a fresh item at the plan's live home (self-healing
 * FORWARD) — but the orphaned filing stays open and claimable forever, sending
 * its claimer on a cross-harness goose chase it cannot act on. The same shape
 * covers a plan deleted, archived, or moved to a terminal/unapproved status
 * (shipped / superseded / demoted to draft) while its filing was open: in every
 * case the sweep would not file for that row today, so the standing filing is
 * moot and closing it is safe — if the plan comes back live and still owes the
 * triad, the next run files afresh (dedupe checks only non-terminal filings).
 *
 * Deliberately NOT handled here: a LIVE plan that no longer owes the triad
 * (triad written / `exempt` declared while the filing was open). That close
 * belongs to whoever did the writing, with their evidence — auto-closing it
 * would erase the paper trail the filing body explicitly asks for.
 */
export function selectSpecTriadReconciliations(input: {
  openFilings: SpecTriadOpenFiling[];
  plans: SpecTriadPlanLocator[];
  maxCloses: number;
}): SpecTriadReconcileSelection {
  const { openFilings, plans, maxCloses } = input;
  const byRef = new Map<string, SpecTriadPlanLocator>();
  for (const p of plans) byRef.set(`${p.workspace_id}/${p.harness_slug}/${p.plan_slug}`, p);

  const candidates: SpecTriadReconciliation[] = [];
  let kept = 0;
  let unparseable = 0;

  for (const f of openFilings) {
    const parts = f.ref.split('/');
    if (parts.length !== 3 || parts.some((s) => s.length === 0)) {
      // A ref we cannot resolve is a ref we must not act on.
      unparseable++;
      continue;
    }
    const slug = parts[2];
    const row = byRef.get(f.ref);
    if (!row) {
      const homes = plans
        .filter((p) => p.plan_slug === slug)
        .map((p) => `${p.workspace_id}/${p.harness_slug}`);
      candidates.push({
        filing: f,
        reason: 'plan-missing',
        detail:
          `spec-triad reconciliation: ref '${f.ref}' resolves to no plan row — the plan was ` +
          `re-homed or deleted after filing` +
          (homes.length > 0 ? ` (slug '${slug}' now lives under: ${homes.join(', ')})` : '') +
          `. If it still owes the triad in a live home, the sweep files a correctly-scoped ` +
          `item there (exact-ref dedupe). Class: the 2026-08-14 harness re-home race ` +
          `(WI-38838/WI-39038).`,
      });
      continue;
    }
    if (!planRowIsSweepLive(row)) {
      const why = row.archived
        ? 'archived'
        : row.is_legacy
          ? 'legacy'
          : row.template !== null && SPEC_TRIAD_EXCLUDED_TEMPLATES.includes(row.template)
            ? `a '${row.template}' template (an acceptance BAR, which has no items to promote)`
            : `status '${row.status}'`;
      candidates.push({
        filing: f,
        reason: 'plan-not-live',
        detail:
          `spec-triad reconciliation: plan '${slug}' at '${f.ref}' is ${why} — the sweep ` +
          `only gates ready/active plans, so this filing's lane is settled or unapproved and ` +
          `the filing is moot. A plan re-approved while still owing the triad gets a fresh ` +
          `filing (exact-ref dedupe checks only non-terminal filings).`,
      });
      continue;
    }
    kept++;
  }

  const toClose = candidates.slice(0, Math.max(0, maxCloses));
  return { toClose, kept, unparseable, deferred: candidates.length - toClose.length };
}

interface SpecTriadReconcileOutcome {
  reconciled: number;
  reconcileFailed: number;
  reconcileDeferred: number;
  reconciledIds: string[];
}

/**
 * The reconciliation leg's I/O: read open filings + the plan rows their refs
 * name, decide via the pure selector, close via the canonical lifecycle writer.
 *
 * Closes go through `setWorkItemState` WITH `by` + `completionRef` (the
 * condition-upsert stand-down precedent) rather than `skipCompletionGate`, so
 * every reconciliation close carries a real evidence ref and lands in no
 * completion-audit bucket. Never throws — same rail as the rest of the sweep.
 */
async function reconcileDanglingSpecTriadFilings(
  maxCloses: number,
): Promise<SpecTriadReconcileOutcome> {
  const zero: SpecTriadReconcileOutcome = {
    reconciled: 0,
    reconcileFailed: 0,
    reconcileDeferred: 0,
    reconciledIds: [],
  };
  try {
    const { sql } = getOrgPg();
    const filings = (await sql`
      SELECT feature_id, workspace_id, harness_slug, payload->>'specTriadPlan' AS ref
        FROM harness_shared.work_items
       WHERE payload->>'specTriadPlan' IS NOT NULL
         AND status = ANY(${SPEC_TRIAD_NON_TERMINAL_STATUSES})
    `) as unknown as SpecTriadOpenFiling[];
    if (filings.length === 0) return zero;

    const slugs = [
      ...new Set(
        filings
          .map((f) => f.ref.split('/'))
          .filter((p) => p.length === 3 && p.every((s) => s.length > 0))
          .map((p) => p[2]),
      ),
    ];
    // The ANY(slugs) read deliberately crosses tenants: resolution is by FULL
    // ref in the selector, and the extra rows are what let a 'plan-missing'
    // close name the slug's real home in its evidence.
    const plans =
      slugs.length === 0
        ? []
        : ((await sql`
            SELECT workspace_id, harness_slug, plan_slug, status, archived, is_legacy, template
              FROM harness_shared.harness_plans
             WHERE plan_slug = ANY(${slugs})
          `) as unknown as SpecTriadPlanLocator[]);

    const sel = selectSpecTriadReconciliations({ openFilings: filings, plans, maxCloses });

    let failed = 0;
    const ids: string[] = [];
    for (const { filing, detail } of sel.toClose) {
      try {
        await setWorkItemState(filing.feature_id, 'dropped', {
          harness: filing.harness_slug,
          by: SPEC_TRIAD_ACTOR,
          completionRef: detail,
        });
        ids.push(filing.feature_id);
      } catch (err) {
        failed++;
        console.warn(
          `[spec-triad-sweep] reconciliation close of ${filing.feature_id} failed (non-fatal): ${(err as Error).message}`,
        );
      }
    }
    return {
      reconciled: ids.length,
      reconcileFailed: failed,
      reconcileDeferred: sel.deferred,
      reconciledIds: ids,
    };
  } catch (err) {
    console.warn(
      `[spec-triad-sweep] reconciliation skipped (non-fatal): ${(err as Error).message}`,
    );
    return zero;
  }
}

export interface SpecTriadSweepOptions {
  /** Override the per-run filing cap (tests). */
  maxFilings?: number;
  /** Skip the flag read (tests / a caller that already resolved it). */
  flagEnabled?: boolean;
}

export async function runSpecTriadSweepOnce(
  opts: SpecTriadSweepOptions = {},
): Promise<SpecTriadSweepResult> {
  const empty = (skipReason: string): SpecTriadSweepResult => ({
    skipped: true,
    reason: skipReason,
    scanned: 0,
    inScope: 0,
    owing: 0,
    filed: 0,
    alreadyFiled: 0,
    deferred: 0,
    reconciled: 0,
    reconcileFailed: 0,
    reconcileDeferred: 0,
    filedIds: [],
    summary: `skipped: ${skipReason}`,
  });

  if (process.env.PAPERCUSP_SPEC_TRIAD_SWEEP === '0') return empty('kill-switch');

  let flagEnabled = opts.flagEnabled;
  if (flagEnabled === undefined) {
    try {
      flagEnabled = await getFlag(FLAGS.SPEC_TRIAD_REQUIRED, 'system:spec-triad-sweep');
    } catch {
      // Fail CLOSED for the sweep (the opposite of plans:items, deliberately):
      // this side WRITES. An unreadable flag store must not be able to file work
      // items nobody asked for.
      return empty('flag unreadable');
    }
  }
  if (!flagEnabled) return empty('flag off');

  const epoch = specTriadEpoch();
  const maxFilings = opts.maxFilings ?? SPEC_TRIAD_MAX_FILINGS_PER_RUN;
  const { sql } = getOrgPg();

  // Reconciliation FIRST, and independent of the candidate pipeline: dangling
  // filings exist precisely when their plan is NOT among the live candidates,
  // so this must run even when the scan below finds nothing in scope. Running
  // before the dedupe read also means a filing closed here can be replaced by
  // a correctly-scoped one in this same run.
  const recon = await reconcileDanglingSpecTriadFilings(maxFilings);
  const reconNote =
    recon.reconciled + recon.reconcileFailed + recon.reconcileDeferred > 0
      ? ` · ${recon.reconciled} dangling filing(s) reconciled` +
        (recon.reconcileFailed > 0 ? ` (${recon.reconcileFailed} close(s) FAILED)` : '') +
        (recon.reconcileDeferred > 0 ? ` (${recon.reconcileDeferred} deferred past the cap)` : '')
      : '';

  // Phase 1 — metadata only. `content` is deliberately NOT selected here; the
  // `specTriad:` probe is pushed into SQL as a boolean so a pre-epoch plan that
  // OPTED IN is still a candidate without transferring every plan body.
  let metas: PlanMetaRow[] = [];
  try {
    metas = (await sql`
      SELECT workspace_id,
             harness_slug,
             plan_slug,
             created,
             (content LIKE '%specTriad:%') AS has_declaration
        FROM harness_shared.harness_plans
       WHERE archived = false
         AND is_legacy = false
         AND (status IS NULL OR status = ANY(${LIVE_PLAN_STATUSES}))
         AND (template IS NULL OR NOT (template = ANY(${SPEC_TRIAD_EXCLUDED_TEMPLATES as string[]})))
    `) as unknown as PlanMetaRow[];
  } catch (err) {
    return empty(`plan scan failed: ${(err as Error).message}`);
  }

  // Scope test on metadata alone. A plan carrying a `specTriad:` declaration
  // always needs its content read (the declaration decides scope in BOTH
  // directions, and phase 1 cannot tell `required` from `exempt`).
  const candidates = metas.filter((m) => {
    if (m.has_declaration) return true;
    return planInSpecTriadScope({ content: '', created: m.created }, { flagEnabled: true, epoch })
      .inScope;
  });

  if (candidates.length === 0) {
    return {
      skipped: false,
      scanned: metas.length,
      inScope: 0,
      owing: 0,
      filed: 0,
      alreadyFiled: 0,
      deferred: 0,
      reconciled: recon.reconciled,
      reconcileFailed: recon.reconcileFailed,
      reconcileDeferred: recon.reconcileDeferred,
      filedIds: [],
      summary: `${metas.length} live plan(s) scanned, none in scope for the spec triad${reconNote}`,
    };
  }

  // Phase 2 — content for the survivors only.
  const slugs = candidates.map((c) => c.plan_slug);
  let rows: PlanContentRow[] = [];
  try {
    rows = (await sql`
      SELECT workspace_id, harness_slug, plan_slug, created, content, items
        FROM harness_shared.harness_plans
       WHERE archived = false
         AND is_legacy = false
         AND plan_slug = ANY(${slugs})
    `) as unknown as PlanContentRow[];
  } catch (err) {
    return empty(`plan content read failed: ${(err as Error).message}`);
  }

  const candidateKeys = new Set(candidates.map(planRef));

  // Which plans already have an outstanding filing?
  let alreadyOpen = new Set<string>();
  try {
    const existing = (await sql`
      SELECT DISTINCT payload->>'specTriadPlan' AS ref
        FROM harness_shared.work_items
       WHERE payload->>'specTriadPlan' IS NOT NULL
         AND status = ANY(${SPEC_TRIAD_NON_TERMINAL_STATUSES})
    `) as unknown as Array<{ ref: string | null }>;
    alreadyOpen = new Set(existing.map((e) => e.ref).filter((r): r is string => !!r));
  } catch (err) {
    // Cannot prove absence ⇒ do not file. Filing duplicates every day is worse
    // than filing nothing today; the next run retries.
    return empty(`dedupe read failed: ${(err as Error).message}`);
  }

  const { inScope, owing, batch, deferred, alreadyFiled } = selectSpecTriadFilings({
    rows,
    alreadyOpen,
    candidateKeys,
    epoch,
    maxFilings,
  });

  const filedIds: string[] = [];
  for (const { row, missing, gap } of batch) {
    // Routed through the SHARED filer, not a local createWorkItem, so this and
    // the promotion-time gate cannot drift in body text or in dedupe semantics.
    // Its own single-row dedupe also closes the race against a promotion that
    // files between this run's bulk read and this insert.
    const r = await ensureSpecTriadFiling({
      workspaceId: row.workspace_id,
      harnessSlug: row.harness_slug,
      planSlug: row.plan_slug,
      missing,
      gap,
    });
    if (r.outcome === 'created' && r.id) filedIds.push(r.id);
    else if (r.outcome === 'error') {
      console.warn(`[spec-triad-sweep] filing for ${r.ref} failed (non-fatal): ${r.error}`);
    }
  }

  const summary =
    `${metas.length} live plan(s) scanned · ${inScope} in scope · ${owing.length} owing the triad · ` +
    `${filedIds.length} filed · ${alreadyFiled} already filed` +
    (deferred > 0 ? ` · ${deferred} DEFERRED past the ${maxFilings}/run cap` : '') +
    reconNote;

  return {
    skipped: false,
    scanned: metas.length,
    inScope,
    owing: owing.length,
    filed: filedIds.length,
    alreadyFiled,
    deferred,
    reconciled: recon.reconciled,
    reconcileFailed: recon.reconcileFailed,
    reconcileDeferred: recon.reconcileDeferred,
    filedIds,
    summary,
  };
}
