/**
 * plans:evidence-measuring-paths — which LIVE repo-files proof measures these files
 * (P-040, review-system-rework-reduction-2026-09-23, R-9).
 *
 * WHY. A `repo-files` binding's freshness is a content hash of the source and test files
 * it measured. Editing any one of them stales the proof, but nothing said so at the
 * edit: the editor (often a PEER of the proof's holder) learned it only at the next gate
 * probe. Measured 2026-09-23 (Avi #302): su-9306f9c3 staled R-1, R-3 and R-4 by trimming
 * tool guidance and found out at the gate; on this plan peer edits staled P-001 once,
 * P-002 twice and P-004 four times (D-006; EI-24053039097767980).
 *
 * WHAT. Given repo-relative paths, return every clause on an UNSHIPPED plan whose
 * CURRENT-revision, un-retracted `repo-files` binding measured one of them, grouped by
 * clause, with the BAR flag, the holder to tell, and the one re-measure call. The
 * PostToolUse hook `posttooluse-proof-stale-nudge.mjs` calls this after every edit and
 * turns the answer into an advisory plus one coord notice per edit burst per peer holder.
 *
 * Read-only by construction. It never judges currentness itself: a binding measured
 * against content the edit happened to restore would still be listed. That is the right
 * bias for an advisory (a false "you may have staled X" costs one re-check; a missed one
 * costs a gate cycle), and plans:get-spec-evidence stays the authority on currentness.
 *
 * OUTPUT BUDGET. Tool results, hook-origin calls included, are capped (~6k chars) and
 * spilled past it (measured 2026-09-23: a 10k plans:items result came back through the
 * result door). A hot file is measured by up to 34 clauses and one binding by up to 52
 * paths, so the full re-measure call cannot ride along for every clause. `packMeasuringClauses`
 * always lists every returned clause's identity and inlines the call only while it fits
 * the budget; beyond that it names the read that returns the measurement.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveEffectiveHarnessSlug } from './_ctx-opts';
import { resolvePlanScope } from './source';
import { BAR_CLAUSE_SPEC_PREFIX } from './bind-vetting-advisory';

/** Evidence kinds whose proof is an EXECUTION: re-hashing files does not refresh it. */
export const EXECUTABLE_EVIDENCE_KINDS: ReadonlySet<string> = new Set(['test', 'mutation', 'counterexample']);

/** Work-item states in which the item no longer has a working holder. */
const TERMINAL_WORK_ITEM_STATES: ReadonlySet<string> = new Set(['done', 'dropped', 'resolved', 'closed']);

/**
 * Character budget for the packed clause list. The result cap is ~6k; the rest is left for
 * the envelope and the holders summary (≤ MAX_HOLDERS entries of ~120 chars).
 */
export const MEASURING_CLAUSES_CHAR_BUDGET = 3600;

/** Inline a binding's measurement only when its path lists serialize under this. */
export const INLINE_MEASUREMENT_MAX_CHARS = 700;

/** Binding ids listed per clause; the full count is always reported. */
const MAX_BINDING_IDS_PER_CLAUSE = 5;

export interface MeasuringBindingRow {
  id: number | string;
  work_item_id: string;
  plan_slug: string;
  spec_id: string;
  spec_revision: number | string;
  evidence_kind: string;
  evidence_ref: string;
  created_by: string;
  source_paths: unknown;
  test_paths: unknown;
  work_item_status: string | null;
  work_item_taken_by: string | null;
}

export interface RemeasureHint {
  bindingId: number;
  /** True for test/mutation/counterexample: re-run the proof, then bind the NEW result. */
  rerunFirst: boolean;
  /** The one call, complete, when it fit the budget. */
  call?: { tool: 'plans:bind-spec-evidence'; args: Record<string, unknown> };
  /** When the call did not fit: the read that returns this binding's measurement. */
  measurementFrom?: { tool: 'plans:get-spec-evidence'; args: Record<string, unknown> };
}

export interface MeasuringClause {
  plan: string;
  /** `<specId>@<revision>` — the clause identity every gate reports. */
  clause: string;
  bar: boolean;
  workItemId: string;
  /** Who to tell: the live assignee of the proof's work item, else whoever bound it. */
  holder: string;
  holderSource: 'assignee' | 'bound-by';
  kinds: string[];
  bindingIds: number[];
  bindingCount: number;
  /** The requested paths this clause's proof measured. */
  matched: string[];
  remeasure: RemeasureHint;
}

export interface PackedMeasuringClauses {
  clauses: MeasuringClause[];
  totalClauses: number;
  /** True when fewer clauses were returned than matched — by `limit` or by the budget. */
  truncatedByLimit: boolean;
  /** True when the character budget, not `limit`, stopped the list. */
  truncatedByBudget: boolean;
  /** Clauses whose call was replaced by `measurementFrom` to stay inside the budget. */
  callsElided: number;
  /**
   * Every holder across ALL matched clauses — never cut by `limit` or the budget, so the
   * hook can tell each peer even when a hot file's clause list is truncated (measured:
   * apps/tui/src/main.rs is measured by 34 clauses; the budget lists a handful).
   */
  holders: MeasuringHolder[];
  /** True when more than MAX_HOLDERS distinct holders matched. */
  holdersTruncated: boolean;
}

export interface MeasuringHolder {
  holder: string;
  clauses: number;
  bars: number;
  /** Up to three work items whose proof this holder holds (the notice cites the first). */
  workItems: string[];
  /** Up to two clause identities, for the notice text. */
  sample: string[];
}

/** Distinct holders reported; well above any observed fan-out, and bounded for the cap. */
const MAX_HOLDERS = 10;

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function normalizeRepoRelativePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/{2,}/g, '/');
}

function holderFor(row: MeasuringBindingRow): { holder: string; holderSource: 'assignee' | 'bound-by' } {
  const status = (row.work_item_status ?? '').toLowerCase();
  const taken = row.work_item_taken_by?.trim();
  if (taken && !TERMINAL_WORK_ITEM_STATES.has(status)) return { holder: taken, holderSource: 'assignee' };
  return { holder: row.created_by, holderSource: 'bound-by' };
}

function remeasureCall(row: MeasuringBindingRow, harnessSlug: string): { tool: 'plans:bind-spec-evidence'; args: Record<string, unknown> } {
  const rerunFirst = EXECUTABLE_EVIDENCE_KINDS.has(row.evidence_kind);
  return {
    tool: 'plans:bind-spec-evidence',
    args: {
      harness: harnessSlug,
      slug: row.plan_slug,
      supersedeAtRevision: true,
      binding: {
        workItemId: row.work_item_id,
        specId: row.spec_id,
        specRevision: Number(row.spec_revision),
        evidenceKind: row.evidence_kind,
        // A replay RE-MEASURES the files, but an execution proof also has to be re-RUN:
        // re-binding the old run against the new bytes would certify code it never ran.
        evidenceRef: rerunFirst ? '<the NEW run of this proof>' : row.evidence_ref,
        measurement: {
          kind: 'repo-files',
          sourcePaths: stringList(row.source_paths),
          testPaths: stringList(row.test_paths),
        },
      },
    },
  };
}

/**
 * Group newest-first binding rows by clause and pack them under the output budget.
 * Pure: the whole contract the hook relies on is testable without Postgres.
 */
export function packMeasuringClauses(
  rows: readonly MeasuringBindingRow[],
  opts: { paths: readonly string[]; harnessSlug: string; limit: number; charBudget?: number },
): PackedMeasuringClauses {
  const wanted = new Set(opts.paths.map(normalizeRepoRelativePath));
  const byClause = new Map<string, { latest: MeasuringBindingRow; rows: MeasuringBindingRow[]; matched: Set<string> }>();
  for (const row of rows) {
    const measured = [...stringList(row.source_paths), ...stringList(row.test_paths)].map(normalizeRepoRelativePath);
    const matched = measured.filter((p) => wanted.has(p));
    if (matched.length === 0) continue;
    const key = `${row.plan_slug}\u0000${row.spec_id}\u0000${row.spec_revision}`;
    const entry = byClause.get(key);
    if (entry) {
      entry.rows.push(row);
      for (const p of matched) entry.matched.add(p);
    } else {
      // Rows arrive newest-first, so the first row seen is the clause's latest proof.
      byClause.set(key, { latest: row, rows: [row], matched: new Set(matched) });
    }
  }
  const groups = [...byClause.values()].sort(
    // BAR clauses first: a staled BAR blocks the plan's ship gate, not just one item.
    (a, b) => Number(b.latest.spec_id.startsWith(BAR_CLAUSE_SPEC_PREFIX)) - Number(a.latest.spec_id.startsWith(BAR_CLAUSE_SPEC_PREFIX)),
  );
  const limit = Math.max(1, opts.limit);
  const budget = opts.charBudget ?? MEASURING_CLAUSES_CHAR_BUDGET;
  const candidates = groups.slice(0, limit).map((group) => {
    const row = group.latest;
    const bindingId = Number(row.id);
    const rerunFirst = EXECUTABLE_EVIDENCE_KINDS.has(row.evidence_kind);
    const base: Omit<MeasuringClause, 'remeasure'> = {
      plan: row.plan_slug,
      clause: `${row.spec_id}@${Number(row.spec_revision)}`,
      bar: row.spec_id.startsWith(BAR_CLAUSE_SPEC_PREFIX),
      workItemId: row.work_item_id,
      ...holderFor(row),
      kinds: [...new Set(group.rows.map((r) => r.evidence_kind))].sort(),
      bindingIds: group.rows.slice(0, MAX_BINDING_IDS_PER_CLAUSE).map((r) => Number(r.id)),
      bindingCount: group.rows.length,
      matched: [...group.matched].sort(),
    };
    const call = remeasureCall(row, opts.harnessSlug);
    const inlineable =
      JSON.stringify((call.args.binding as { measurement: unknown }).measurement).length <= INLINE_MEASUREMENT_MAX_CHARS;
    const withRef: MeasuringClause = {
      ...base,
      remeasure: {
        bindingId,
        rerunFirst,
        measurementFrom: {
          tool: 'plans:get-spec-evidence',
          args: { harness: opts.harnessSlug, slug: row.plan_slug, specIds: [row.spec_id], detail: 'full' },
        },
      },
    };
    const withCall: MeasuringClause = { ...base, remeasure: { bindingId, rerunFirst, call } };
    return { withRef, withCall, inlineable, refChars: JSON.stringify(withRef).length, callChars: JSON.stringify(withCall).length };
  });

  // Pass 1 — IDENTITY first: list as many clauses as the budget holds in their cheap form.
  // (Inlining calls first let four full calls exhaust the budget on a 34-clause hot file.)
  const chosen: Array<(typeof candidates)[number] & { inline: boolean }> = [];
  let used = 0;
  let truncatedByBudget = false;
  for (const candidate of candidates) {
    if (chosen.length > 0 && used + candidate.refChars > budget) {
      truncatedByBudget = true;
      break;
    }
    used += candidate.refChars;
    chosen.push({ ...candidate, inline: false });
  }
  // Pass 2 — upgrade listed clauses, in order, to the complete call while it still fits.
  for (const entry of chosen) {
    if (!entry.inlineable) continue;
    const next = used - entry.refChars + entry.callChars;
    if (next > budget) continue;
    used = next;
    entry.inline = true;
  }
  const clauses = chosen.map((entry) => (entry.inline ? entry.withCall : entry.withRef));

  // Holders over ALL matched clauses: the notice fan-out must not depend on the budget.
  const byHolder = new Map<string, MeasuringHolder>();
  for (const group of groups) {
    const { holder } = holderFor(group.latest);
    const entry = byHolder.get(holder) ?? { holder, clauses: 0, bars: 0, workItems: [], sample: [] };
    entry.clauses += 1;
    if (group.latest.spec_id.startsWith(BAR_CLAUSE_SPEC_PREFIX)) entry.bars += 1;
    if (entry.workItems.length < 3 && !entry.workItems.includes(group.latest.work_item_id)) entry.workItems.push(group.latest.work_item_id);
    if (entry.sample.length < 2) entry.sample.push(`${group.latest.spec_id}@${Number(group.latest.spec_revision)}`);
    byHolder.set(holder, entry);
  }
  const holders = [...byHolder.values()].sort((a, b) => b.clauses - a.clauses);
  return {
    clauses,
    totalClauses: groups.length,
    truncatedByLimit: groups.length > clauses.length,
    truncatedByBudget,
    callsElided: clauses.filter((c) => !c.remeasure.call).length,
    holders: holders.slice(0, MAX_HOLDERS),
    holdersTruncated: holders.length > MAX_HOLDERS,
  };
}

/** Newest-first live repo-files bindings that measured any of `paths`. */
export async function loadMeasuringBindings(input: {
  workspaceId: string;
  harnessSlug: string;
  paths: readonly string[];
}): Promise<MeasuringBindingRow[]> {
  const paths = [...new Set(input.paths.map(normalizeRepoRelativePath))];
  if (paths.length === 0) return [];
  return withWorkspace(input.workspaceId, async (tx) => {
    const rows = await tx<MeasuringBindingRow[]>`
      SELECT b.id, b.work_item_id, b.plan_slug, b.spec_id, b.spec_revision,
             b.evidence_kind, b.evidence_ref, b.created_by,
             b.details->'currentMeasurement'->'sourcePaths' AS source_paths,
             b.details->'currentMeasurement'->'testPaths' AS test_paths,
             w.status AS work_item_status, w.taken_by AS work_item_taken_by
        FROM harness_shared.spec_evidence_bindings b
        JOIN harness_shared.harness_plans p
          ON p.workspace_id = b.workspace_id AND p.harness_slug = b.harness_slug AND p.plan_slug = b.plan_slug
        JOIN harness_shared.plan_spec_clauses c
          ON c.workspace_id = b.workspace_id AND c.harness_slug = b.harness_slug
         AND c.plan_slug = b.plan_slug AND c.spec_id = b.spec_id
        JOIN harness_shared.plan_spec_clause_revisions r
          ON r.workspace_id = b.workspace_id AND r.harness_slug = b.harness_slug
         AND r.plan_slug = b.plan_slug AND r.spec_id = b.spec_id AND r.revision = b.spec_revision
        LEFT JOIN harness_shared.work_items w
          ON w.workspace_id = b.workspace_id AND w.harness_slug = b.harness_slug AND w.feature_id = b.work_item_id
       WHERE b.workspace_id = ${input.workspaceId}
         AND b.harness_slug = ${input.harnessSlug}
         AND b.retracted_at IS NULL
         AND b.details->'currentMeasurement'->>'kind' = 'repo-files'
         AND p.status IS DISTINCT FROM 'shipped'
         AND p.status IS DISTINCT FROM 'superseded'
         AND b.spec_revision = c.current_revision
         AND b.spec_fingerprint = r.content_hash
         AND (
           (b.details->'currentMeasurement'->'sourcePaths') ?| ${paths}::text[]
           OR (b.details->'currentMeasurement'->'testPaths') ?| ${paths}::text[]
         )
       ORDER BY b.observed_at DESC, b.id DESC
       LIMIT 2000`;
    return [...rows];
  });
}

const argsSchema = z.object({
  harness: harnessArg,
  paths: z
    .array(z.string().trim().min(1).max(1000))
    .min(1)
    .max(50)
    .describe('Repo-relative paths (superproject-relative for submodule files), as a binding measures them.'),
  limit: z.number().int().min(1).max(50).optional().describe('Clauses returned (default 12); totalClauses always reports the full count.'),
});

export default defineTool({
  name: 'plans:evidence-measuring-paths',
  description:
    'List the clauses on unshipped plans whose current-revision, un-retracted repo-files proof measured any of the given repo-relative paths: editing such a file stales that proof. Grouped by clause with the BAR flag, the holder to tell, and the one plans:bind-spec-evidence re-measure call (re-run first for test/mutation/counterexample proof). Read-only.',
  guidance: {
    when: 'Before or after editing a file, to learn which live proofs measure it, whose they are and how to re-measure.',
    notWhen: 'Judging whether a proof is current — plans:get-spec-evidence is the authority.',
    chaining: 'plans:evidence-measuring-paths → (re-run the proof) → plans:bind-spec-evidence { supersedeAtRevision:true }.',
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES, 'worker', 'cup', 'judge'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const scope = await resolvePlanScope({ harnessSlug: resolveEffectiveHarnessSlug(sctx) });
    const paths = [...new Set(args.paths.map(normalizeRepoRelativePath))];
    const rows = await loadMeasuringBindings({ workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug, paths });
    const packed = packMeasuringClauses(rows, { paths, harnessSlug: scope.harnessSlug, limit: args.limit ?? 12 });
    return {
      data: {
        ok: true,
        harnessSlug: scope.harnessSlug,
        paths,
        bindingRows: rows.length,
        ...packed,
      },
    };
  },
});
