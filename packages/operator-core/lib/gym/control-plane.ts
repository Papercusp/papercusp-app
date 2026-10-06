/**
 * Gym CONTROL PLANE (gym-ui-handoff backend, D-020) — the persistent, user-facing
 * state behind the generalized harness-gym UI, in the LIVE operator DB.
 *
 * D-020 refines D-018: the gym's heavy EXECUTION data (the real pipeline run,
 * transcripts, DBOS, per-task score vectors) stays in the dedicated ephemeral gym PG.
 * But the small control plane the UI reads + the user acts on persists here in
 * harness_shared, scoped by (workspace_id, harness_slug):
 *   - prompt overrides    → harness_shared.harness_prompt_overrides (000-baseline);
 *                           the judge rubric is stored under role = 'judge'.
 *   - proposer suggestions → harness_shared.gym_proposals (migration 110); accept
 *                           promotes proposed_md into harness_prompt_overrides.
 *   - autoloop config      → harness_shared.gym_autoloop_config (migration 110).
 *
 * Helpers take an injected `Sql` (the live operator admin pool) so the gym:* routes
 * and the gym loop's recorder share one tested core. Domain-free logic
 * (key validation, status summary) is split out + unit-tested in control-plane.test.ts;
 * the SQL is covered by control-plane.integration.test.ts.
 */
import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { AGENT_ROLES } from '@papercusp/agent-mcp';
import { recordBehaviorChange } from '../change-ledger/change-ledger';
import type { CandidateVersionVerdict, LoopProposalRecord } from './loop';
import { recordChampionAcceptance } from './post-acceptance-outcomes';
import { realAnchorHeld } from './promotion-gate';
import { recordProducerObservation, withProducerLifecycleWrite } from '../experiment/producer-lifecycle-store';
import type { GymJudgedCorpus } from './task-corpus';
import { trackDetached } from '../detached-imports';

/** The judge rubric is edited like a role prompt but isn't an AGENT_ROLES role. */
export const JUDGE_PROMPT_KEY = 'judge';

/** Every prompt key the gym UI may edit: the judge rubric + each harness role. */
export const GYM_PROMPT_KEYS: readonly string[] = [JUDGE_PROMPT_KEY, ...AGENT_ROLES];

const ROLE_SET: ReadonlySet<string> = new Set(AGENT_ROLES as readonly string[]);

export function isGymEditablePromptKey(key: string): boolean {
  return key === JUDGE_PROMPT_KEY || ROLE_SET.has(key);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GymProposalRow {
  id: string;
  workspaceId: string;
  harnessSlug: string;
  cycle: number;
  variantId: string | null;
  role: string;
  originalMd: string | null;
  proposedMd: string;
  rationale: string | null;
  devAnchorDelta: number | null;
  costDelta: number | null;
  probeStatus: string | null;
  /** pending | accepted | rejected | superseded */
  status: string;
  createdAt: number;
  decidedAt: number | null;
  /**
   * The corpus this challenger was judged on — 'synthetic' | 'real' | 'mixed'
   * (P-003). Surfaced on the Gym card so a champion earned on the generated 4-line
   * stub can never be misread as one earned on real work.
   */
  taskCorpus: GymJudgedCorpus;
  /** Hash-pinned candidate/version/gate record; null for historical proposals. */
  candidateVersion: CandidateVersionVerdict | null;
}

export interface GymAutoloopConfig {
  workspaceId: string;
  harnessSlug: string;
  enabled: boolean;
  budgetUsd: number | null;
  spentUsd: number;
  /** idle | running | paused | exhausted */
  status: string;
  lastCycle: number | null;
  lastCycleAt: number | null;
  updatedAt: number;
}

export interface GymStatusSummary {
  pendingCount: number;
  lastCycle: number | null;
  autoloop: { enabled: boolean; status: string; budgetUsd: number | null; spentUsd: number } | null;
}

/** Pure: roll pending proposals + autoloop config into a per-harness status. */
export function summarizeGymStatus(
  pending: readonly Pick<GymProposalRow, 'cycle'>[],
  autoloop: GymAutoloopConfig | null,
): GymStatusSummary {
  const lastCycle = pending.length
    ? Math.max(...pending.map((p) => p.cycle))
    : autoloop?.lastCycle ?? null;
  return {
    pendingCount: pending.length,
    lastCycle,
    autoloop: autoloop
      ? { enabled: autoloop.enabled, status: autoloop.status, budgetUsd: autoloop.budgetUsd, spentUsd: autoloop.spentUsd }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Row mappers (postgres-js returns bigint as string; null-safe numeric coercion)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

async function proposalColumns(sql: Sql): Promise<Set<string>> {
  const rows = (await sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'harness_shared' AND table_name = 'gym_proposals'`) as Array<{ column_name: string }>;
  return new Set(rows.map((row) => row.column_name));
}

function mapProposal(r: Row): GymProposalRow {
  const candidateVersion = r.candidate_verdict;
  return {
    id: str(r.id),
    workspaceId: str(r.workspace_id),
    harnessSlug: str(r.harness_slug),
    cycle: Number(r.cycle),
    variantId: strOrNull(r.variant_id),
    role: str(r.role),
    originalMd: strOrNull(r.original_md),
    proposedMd: str(r.proposed_md),
    rationale: strOrNull(r.rationale),
    devAnchorDelta: numOrNull(r.dev_anchor_delta),
    costDelta: numOrNull(r.cost_delta),
    probeStatus: strOrNull(r.probe_status),
    status: str(r.status),
    createdAt: Number(r.created_at),
    decidedAt: numOrNull(r.decided_at),
    // Unknown/absent provenance reads as 'synthetic', never 'real' (P-003) — the
    // same one-way default the DB column and the TS coercer use.
    taskCorpus:
      r.task_corpus === 'real' || r.task_corpus === 'mixed'
        ? (r.task_corpus as GymJudgedCorpus)
        : 'synthetic',
    candidateVersion:
      candidateVersion && typeof candidateVersion === 'object'
        ? (candidateVersion as CandidateVersionVerdict)
        : typeof candidateVersion === 'string'
          ? (() => {
              try {
                const parsed = JSON.parse(candidateVersion);
                return parsed && typeof parsed === 'object' ? (parsed as CandidateVersionVerdict) : null;
              } catch {
                return null;
              }
            })()
          : null,
  };
}

function mapAutoloop(r: Row): GymAutoloopConfig {
  return {
    workspaceId: str(r.workspace_id),
    harnessSlug: str(r.harness_slug),
    enabled: r.enabled === true || r.enabled === 't',
    budgetUsd: numOrNull(r.budget_usd),
    spentUsd: Number(r.spent_usd ?? 0),
    status: str(r.status),
    lastCycle: numOrNull(r.last_cycle),
    lastCycleAt: numOrNull(r.last_cycle_at),
    updatedAt: Number(r.updated_at),
  };
}

// ---------------------------------------------------------------------------
// Prompts (harness_prompt_overrides; judge rubric under role='judge')
// ---------------------------------------------------------------------------

export async function getPrompts(
  sql: Sql,
  q: { workspaceId: string; harnessSlug: string },
): Promise<{ judgeRubric: string | null; roles: Record<string, string> }> {
  const rows = (await sql`
    SELECT role, prompt_md FROM harness_shared.harness_prompt_overrides
     WHERE workspace_id = ${q.workspaceId} AND harness_slug = ${q.harnessSlug}`) as Row[];
  let judgeRubric: string | null = null;
  const roles: Record<string, string> = {};
  for (const r of rows) {
    const role = str(r.role);
    if (role === JUDGE_PROMPT_KEY) judgeRubric = str(r.prompt_md);
    else roles[role] = str(r.prompt_md);
  }
  return { judgeRubric, roles };
}

export async function setPrompt(
  sql: Sql,
  q: { workspaceId: string; harnessSlug: string; role: string; md: string; now?: number },
): Promise<void> {
  if (!isGymEditablePromptKey(q.role)) {
    throw new Error(`gym: "${q.role}" is not an editable prompt key (expected 'judge' or an AGENT_ROLES role)`);
  }
  const now = q.now ?? Date.now();
  await sql`
    INSERT INTO harness_shared.harness_prompt_overrides (workspace_id, harness_slug, role, prompt_md, updated_at)
    VALUES (${q.workspaceId}, ${q.harnessSlug}, ${q.role}, ${q.md}, ${now})
    ON CONFLICT (workspace_id, harness_slug, role) DO UPDATE
      SET prompt_md = EXCLUDED.prompt_md, updated_at = EXCLUDED.updated_at`;
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export interface RecordProposalInput {
  workspaceId: string;
  harnessSlug: string;
  cycle: number;
  variantId?: string | null;
  role: string;
  originalMd?: string | null;
  proposedMd: string;
  rationale?: string | null;
  devAnchorDelta?: number | null;
  costDelta?: number | null;
  probeStatus?: string | null;
  /** Override the generated id (defaults to a deterministic variant+role key). */
  id?: string;
  now?: number;
  /**
   * The corpus this challenger was JUDGED on (gym-real-fitness-signal-2026-07-27
   * P-003) — 'synthetic' | 'real' | 'mixed', from judgedCorpusFromTasks over the
   * cycle's actual task set. OMITTED ⇒ persisted as 'synthetic', because every
   * champion crowned before P-001 was earned on a generated 4-line stub and must
   * never read as though it were earned on real work.
   */
  taskCorpus?: GymJudgedCorpus;
  /** Immutable candidate/version/gate evidence produced by runOptimizationLoop. */
  candidateVersion?: CandidateVersionVerdict | null;
}

/**
 * Upsert a proposal. The id is deterministic per (variant, role) so a retried
 * cycle is idempotent; the conflict-update only touches a still-PENDING row
 * (a decided proposal is never resurrected). Returns the proposal id.
 */
export async function recordProposal(sql: Sql, input: RecordProposalInput): Promise<string> {
  const id = input.id ?? (input.variantId ? `${input.variantId}__${input.role}` : randomUUID());
  const now = input.now ?? Date.now();
  const columns = await proposalColumns(sql);
  await withProducerLifecycleWrite(sql, async (sql) => {
  if (columns.has('task_corpus') && columns.has('candidate_verdict')) {
    await sql`
      INSERT INTO harness_shared.gym_proposals
        (id, workspace_id, harness_slug, cycle, variant_id, role, original_md, proposed_md, rationale,
         dev_anchor_delta, cost_delta, probe_status, status, task_corpus, candidate_verdict, created_at)
      VALUES (${id}, ${input.workspaceId}, ${input.harnessSlug}, ${input.cycle}, ${input.variantId ?? null}, ${input.role},
         ${input.originalMd ?? null}, ${input.proposedMd}, ${input.rationale ?? null},
         ${input.devAnchorDelta ?? null}, ${input.costDelta ?? null}, ${input.probeStatus ?? null}, 'pending',
         ${input.taskCorpus ?? 'synthetic'}, ${input.candidateVersion == null ? null : JSON.stringify(input.candidateVersion)}::text::jsonb, ${now})
      ON CONFLICT (id) DO UPDATE SET
         proposed_md = EXCLUDED.proposed_md, original_md = EXCLUDED.original_md, rationale = EXCLUDED.rationale,
         dev_anchor_delta = EXCLUDED.dev_anchor_delta, cost_delta = EXCLUDED.cost_delta,
         probe_status = EXCLUDED.probe_status, cycle = EXCLUDED.cycle,
         task_corpus = EXCLUDED.task_corpus, candidate_verdict = EXCLUDED.candidate_verdict
       WHERE gym_proposals.status = 'pending'`;
  } else if (columns.has('task_corpus')) {
    await sql`
      INSERT INTO harness_shared.gym_proposals
        (id, workspace_id, harness_slug, cycle, variant_id, role, original_md, proposed_md, rationale,
         dev_anchor_delta, cost_delta, probe_status, status, task_corpus, created_at)
      VALUES (${id}, ${input.workspaceId}, ${input.harnessSlug}, ${input.cycle}, ${input.variantId ?? null}, ${input.role},
         ${input.originalMd ?? null}, ${input.proposedMd}, ${input.rationale ?? null},
         ${input.devAnchorDelta ?? null}, ${input.costDelta ?? null}, ${input.probeStatus ?? null}, 'pending',
         ${input.taskCorpus ?? 'synthetic'}, ${now})
      ON CONFLICT (id) DO UPDATE SET
         proposed_md = EXCLUDED.proposed_md, original_md = EXCLUDED.original_md, rationale = EXCLUDED.rationale,
         dev_anchor_delta = EXCLUDED.dev_anchor_delta, cost_delta = EXCLUDED.cost_delta,
         probe_status = EXCLUDED.probe_status, cycle = EXCLUDED.cycle, task_corpus = EXCLUDED.task_corpus
       WHERE gym_proposals.status = 'pending'`;
  } else {
    // Compatibility with dedicated gym databases provisioned before the shared
    // task-corpus migration. The live schema path takes the branch above.
    await sql`
      INSERT INTO harness_shared.gym_proposals
        (id, workspace_id, harness_slug, cycle, variant_id, role, original_md, proposed_md, rationale,
         dev_anchor_delta, cost_delta, probe_status, status, created_at)
      VALUES (${id}, ${input.workspaceId}, ${input.harnessSlug}, ${input.cycle}, ${input.variantId ?? null}, ${input.role},
         ${input.originalMd ?? null}, ${input.proposedMd}, ${input.rationale ?? null},
         ${input.devAnchorDelta ?? null}, ${input.costDelta ?? null}, ${input.probeStatus ?? null}, 'pending', ${now})
      ON CONFLICT (id) DO UPDATE SET
         proposed_md = EXCLUDED.proposed_md, original_md = EXCLUDED.original_md, rationale = EXCLUDED.rationale,
         dev_anchor_delta = EXCLUDED.dev_anchor_delta, cost_delta = EXCLUDED.cost_delta,
         probe_status = EXCLUDED.probe_status, cycle = EXCLUDED.cycle
       WHERE gym_proposals.status = 'pending'`;
  }
  await recordProducerObservation(sql, { producer: 'gym', workspaceId: input.workspaceId, sourceId: id });
  });
  // Push-on-write for the Learning tab's Gym view (owner report 2026-07-26 —
  // learning.gym had no producer; pg_notify fans out cross-process).
  void trackDetached(import('../sync-sse'))
    .then((m) => m.notifySyncInvalidate('learning.gym'))
    .catch(() => {});
  return id;
}

export async function listProposals(
  sql: Sql,
  q: { workspaceId: string; harnessSlug: string; status?: string; variantId?: string },
): Promise<GymProposalRow[]> {
  const rows = (await sql`
    SELECT * FROM harness_shared.gym_proposals
     WHERE workspace_id = ${q.workspaceId} AND harness_slug = ${q.harnessSlug}
       ${q.status ? sql`AND status = ${q.status}` : sql``}
       ${q.variantId ? sql`AND variant_id = ${q.variantId}` : sql``}
     ORDER BY cycle DESC, created_at DESC`) as Row[];
  return rows.map(mapProposal);
}

/**
 * Workspace-wide recent proposals across EVERY gym harness — the read behind the
 * Learning tab's Gym view (operator-learning-tab-2026-06-09). Newest-first, capped.
 * (The per-harness `listProposals` is the control surface; this is the cross-harness
 * "what has the gym been doing lately" rollup.)
 */
export async function listRecentProposalsForWorkspace(
  sql: Sql,
  q: { workspaceId: string; limit?: number; harnessSlug?: string },
): Promise<GymProposalRow[]> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  // (per-hive-learning-loops P-041) the per-Hive lens narrows to one gym
  // harness's proposals when `harnessSlug` is set; omitted ⇒ the whole workspace.
  const rows = (await sql`
    SELECT * FROM harness_shared.gym_proposals
     WHERE workspace_id = ${q.workspaceId}
       ${q.harnessSlug ? sql`AND harness_slug = ${q.harnessSlug}` : sql``}
     ORDER BY created_at DESC
     LIMIT ${limit}`) as Row[];
  return rows.map(mapProposal);
}

/** Every autoloop config in the workspace (one per gym harness), freshest first.
 *  (P-041) `harnessSlug` narrows to a single Hive's gym for the per-Hive lens. */
export async function listAutoloopsForWorkspace(
  sql: Sql,
  q: { workspaceId: string; harnessSlug?: string },
): Promise<GymAutoloopConfig[]> {
  const rows = (await sql`
    SELECT * FROM harness_shared.gym_autoloop_config
     WHERE workspace_id = ${q.workspaceId}
       ${q.harnessSlug ? sql`AND harness_slug = ${q.harnessSlug}` : sql``}
     ORDER BY updated_at DESC`) as Row[];
  return rows.map(mapAutoloop);
}

/** One Scout-seeded MAP-Elites archive niche (source='scout') — the landing
 *  place of a gym-rail routed idea (`gym:SP-…`), which never becomes a
 *  gym_proposals row (WI-5412 item 4: the Ideas-view gym pill referenced these
 *  while the Gym view listed only prompt-optimization challengers). */
export interface GymArchiveSeedRow {
  candidateId: string;
  nicheKey: string;
  fitness: number;
  rationale: string | null;
  /** epoch ms. */
  updatedAt: number;
  harnessSlug: string;
}

/** Scout-seeded archive niches, freshest first. A seed absent here was either
 *  never admitted or has been superseded by a stronger candidate — its niche
 *  row now carries the winner's candidate_id. */
export async function listScoutArchiveSeeds(
  sql: Sql,
  q: { workspaceId: string; harnessSlug?: string; limit?: number },
): Promise<GymArchiveSeedRow[]> {
  const limit = Math.min(Math.max(q.limit ?? 30, 1), 200);
  const rows = (await sql`
    SELECT candidate_id, niche_key, fitness, rationale, updated_at, harness_slug
      FROM harness_shared.gym_qd_archive
     WHERE workspace_id = ${q.workspaceId}
       AND source = 'scout'
       ${q.harnessSlug ? sql`AND harness_slug = ${q.harnessSlug}` : sql``}
     ORDER BY updated_at DESC
     LIMIT ${limit}`) as Row[];
  return rows.map((r) => ({
    candidateId: String(r.candidate_id ?? ''),
    nicheKey: String(r.niche_key ?? ''),
    fitness: Number(r.fitness ?? 0),
    rationale: typeof r.rationale === 'string' && r.rationale ? r.rationale : null,
    updatedAt: Number(r.updated_at ?? 0),
    harnessSlug: String(r.harness_slug ?? ''),
  }));
}

/** One completed gym cycle from the durable run-analytics (harness_gym_durable),
 *  with timing derived from its runs — `gym_cycles` itself carries no timestamp
 *  column, so recency comes from min(started_at)/max(finished_at) over the
 *  cycle's gym_runs (WI-5685: a cycle whose candidate LOSES mints no proposal,
 *  so without this read a completed run is invisible to the Learning tab). */
export interface GymRecentCycleRow {
  /** Run-scoped cycle identity (`cyc-<runToken>-c<cycle>`) — the stable row key.
   *  WI-5799: `cycle` alone is NOT unique (autoloop runs are maxCycles=1, so
   *  every run's cycle number is 1); only this discriminates one run from the next. */
  cycleId: string;
  harnessSlug: string;
  cycle: number;
  parentId: string | null;
  candidateId: string | null;
  /** 'accept' | 'reject' | null (null = no recorded decision). */
  decision: string | null;
  runCount: number;
  /** epoch ms of the earliest run start in the cycle; null when the cycle has no runs. */
  startedAt: number | null;
  /** epoch ms of the latest run finish in the cycle; null when the cycle has no runs. */
  finishedAt: number | null;
}

/** Recent completed cycles across the workspace's gym harnesses, freshest first.
 *  (P-041) `harnessSlug` narrows to a single Hive's gym for the per-Hive lens. */
export async function listRecentCyclesForWorkspace(
  sql: Sql,
  q: { workspaceId: string; harnessSlug?: string; limit?: number },
): Promise<GymRecentCycleRow[]> {
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
  const toMs = (v: unknown): number | null =>
    v == null ? null : v instanceof Date ? v.getTime() : new Date(String(v)).getTime();
  // WI-5799: join runs by the cycle's CANDIDATE (gym_runs.variant_id), NOT by
  // `cycle`. Cycle numbers repeat across runs (maxCycles=1 ⇒ always 1), so a
  // join on `cycle` cross-products every run of every past run onto every cycle
  // row — inflating runCount and smearing timings. `candidate_id` is run-unique
  // (WI-5697's `cand-<runToken>-c<cycle>`), so it selects exactly this cycle's
  // challenger runs. Baseline/champion runs (variant_id='baseline') belong to no
  // challenger cycle and are correctly excluded.
  const rows = (await sql`
    SELECT c.cycle_id, c.harness_slug, c.cycle, c.parent_id, c.candidate_id, c.decision,
           count(r.run_id)::int AS run_count,
           min(r.started_at) AS started_at,
           max(r.finished_at) AS finished_at,
           c.created_at
      FROM harness_gym_durable.gym_cycles c
      LEFT JOIN harness_gym_durable.gym_runs r
        ON r.workspace_id = c.workspace_id AND r.harness_slug = c.harness_slug
       AND r.variant_id = c.candidate_id
     WHERE c.workspace_id = ${q.workspaceId}
       ${q.harnessSlug ? sql`AND c.harness_slug = ${q.harnessSlug}` : sql``}
     GROUP BY c.cycle_id, c.harness_slug, c.cycle, c.parent_id, c.candidate_id, c.decision, c.created_at
     ORDER BY coalesce(max(r.finished_at), c.created_at) DESC NULLS LAST
     LIMIT ${limit}`) as Row[];
  return rows.map((r) => ({
    cycleId: String(r.cycle_id ?? ''),
    harnessSlug: String(r.harness_slug ?? ''),
    cycle: Number(r.cycle ?? 0),
    parentId: r.parent_id == null ? null : String(r.parent_id),
    candidateId: r.candidate_id == null ? null : String(r.candidate_id),
    decision: r.decision == null ? null : String(r.decision),
    runCount: Number(r.run_count ?? 0),
    startedAt: toMs(r.started_at),
    // Fall back to the cycle's own recorded time so a cycle whose runs were
    // pruned (or which errored before any run finished) still carries a "when".
    finishedAt: toMs(r.finished_at) ?? toMs(r.created_at),
  }));
}

/** One variant's evaluation within a cycle, derived from the RUNS themselves. */
export interface GymRecentRunGroupRow {
  harnessSlug: string;
  variantId: string;
  cycle: number;
  runCount: number;
  /** Terminal states seen, most common first (e.g. 'escalated', 'completed'). */
  states: string[];
  startedAt: number | null;
  finishedAt: number | null;
  /** 'accept' | 'reject' | null — from the cycle row when one names this variant. */
  decision: string | null;
  /** True when this variant is the champion/baseline rather than a challenger. */
  isBaseline: boolean;
}

/**
 * Recent gym RUN activity, read from `gym_runs` — the table that actually
 * accumulates (owner report, repeatedly: "I still see no recent runs").
 *
 * Why not `gym_cycles`: a cycle row is written ONCE PER COMPLETED CYCLE and, until
 * WI-5799, was overwritten in place — so the durable cycles table can hold a single
 * stale row while the gym is demonstrably running (9 runs, newest today, against one
 * cycle row created five days earlier). Runs are keyed per (variant, task, repeat) and
 * are written as they finish, so they show in-flight and baseline work too. THIS is the
 * honest answer to "is the gym doing anything lately".
 */
export async function listRecentGymRunsForWorkspace(
  sql: Sql,
  q: { workspaceId: string; harnessSlug?: string; limit?: number },
): Promise<GymRecentRunGroupRow[]> {
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
  const toMs = (v: unknown): number | null =>
    v == null ? null : v instanceof Date ? v.getTime() : new Date(String(v)).getTime();
  const rows = (await sql`
    SELECT r.harness_slug, r.variant_id, r.cycle,
           count(*)::int AS run_count,
           array_remove(array_agg(DISTINCT r.terminal_state), NULL) AS states,
           min(r.started_at) AS started_at,
           max(r.finished_at) AS finished_at,
           max(c.decision) AS decision
      FROM harness_gym_durable.gym_runs r
      LEFT JOIN harness_gym_durable.gym_cycles c
        ON c.workspace_id = r.workspace_id AND c.harness_slug = r.harness_slug
       AND c.candidate_id = r.variant_id
     WHERE r.workspace_id = ${q.workspaceId}
       ${q.harnessSlug ? sql`AND r.harness_slug = ${q.harnessSlug}` : sql``}
     GROUP BY r.harness_slug, r.variant_id, r.cycle
     ORDER BY max(r.finished_at) DESC NULLS LAST, min(r.started_at) DESC
     LIMIT ${limit}`) as Row[];
  return rows.map((r) => ({
    harnessSlug: String(r.harness_slug ?? ''),
    variantId: String(r.variant_id ?? ''),
    cycle: Number(r.cycle ?? 0),
    runCount: Number(r.run_count ?? 0),
    states: Array.isArray(r.states) ? r.states.map((s) => String(s)) : [],
    startedAt: toMs(r.started_at),
    finishedAt: toMs(r.finished_at),
    decision: r.decision == null ? null : String(r.decision),
    isBaseline: String(r.variant_id ?? '') === 'baseline',
  }));
}

export interface DecideResult {
  ok: boolean;
  reason?: string;
  promoted?: boolean;
  proposal?: GymProposalRow;
}

/**
 * Accept or reject a pending proposal. Accept atomically promotes proposed_md into
 * harness_prompt_overrides (the role's prompt) AND marks the row accepted; reject
 * just marks it. Re-deciding a non-pending / missing row is a no-op (ok:false).
 */
/**
 * Auto-decide a run's freshly-recorded proposals (owner mandate 2026-07-19:
 * "there should be no human in the loop"): every still-pending proposal this
 * run recorded is decided by its immutable candidate-version verdict. A positive
 * dev-anchor delta is only a ranking signal; it can promote a candidate only when
 * the complete hash-pinned gate verdict says accept. Anything else auto-REJECTS so
 * nothing lingers pending. The ledger keeps every decision auditable, and a
 * promoted champion can still be reverted by accepting a later counter-proposal
 * (or editing the role's prompt override).
 */
export async function autoDecideRunProposals(
  sql: Sql,
  q: { workspaceId: string; harnessSlug: string; sinceMs: number; now?: number },
): Promise<{ accepted: number; rejected: number }> {
  const hasVerdictColumn = (await proposalColumns(sql)).has('candidate_verdict');
  const rows = hasVerdictColumn
    ? ((await sql`
        SELECT id, variant_id, candidate_verdict, dev_anchor_delta FROM harness_shared.gym_proposals
         WHERE workspace_id = ${q.workspaceId}
           AND harness_slug = ${q.harnessSlug}
           AND status = 'pending'
           AND created_at >= ${q.sinceMs}
         ORDER BY created_at ASC`) as Array<{ id: string; variant_id: unknown; candidate_verdict: unknown; dev_anchor_delta: unknown }>)
    : ((await sql`
        SELECT id, variant_id, dev_anchor_delta FROM harness_shared.gym_proposals
         WHERE workspace_id = ${q.workspaceId}
           AND harness_slug = ${q.harnessSlug}
           AND status = 'pending'
           AND created_at >= ${q.sinceMs}
         ORDER BY created_at ASC`) as Array<{ id: string; variant_id: unknown; dev_anchor_delta: unknown }>).map((row) => ({ ...row, candidate_verdict: null }));
  let accepted = 0;
  let rejected = 0;
  for (const row of rows) {
    const candidate = parseCandidateVersion(row.candidate_verdict);
    const delta = row.dev_anchor_delta == null ? null : Number(row.dev_anchor_delta);
    // P-002: positive dev-anchor movement is only a proposal signal. Promotion
    // requires the same complete, hash-pinned gate verdict produced by the loop.
    //
    // The real-anchor check is folded in HERE as well as in decideProposal, and the
    // duplication is deliberate: decideProposal REFUSES (leaving the row pending, so a
    // human can still run the pool and come back), but the auto sweep has no human to
    // come back — its contract is that every row this run recorded ends decided. So the
    // auto path must reach a REJECT verdict itself rather than bounce off the writer's
    // refusal and silently leave the row pending until it ages out of the window.
    //
    // A legacy database with no candidate-verdict column can no longer prove the
    // real-anchor holds, so it is fail-closed too (D-004(3)): un-migrated is not
    // grounds to install a prompt on evidence nobody has.
    const wins =
      hasVerdictColumn &&
      isPromotableCandidate(candidate, row.variant_id) &&
      realAnchorHeld(candidate).held &&
      delta != null &&
      Number.isFinite(delta) &&
      delta > 0;
    const res = await decideProposal(sql, {
      id: row.id,
      workspaceId: q.workspaceId,
      harnessSlug: q.harnessSlug,
      decision: wins ? 'accepted' : 'rejected',
      ...(q.now != null ? { now: q.now } : {}),
    });
    if (res.ok) {
      if (wins) accepted += 1;
      else rejected += 1;
    }
  }
  return { accepted, rejected };
}

function parseCandidateVersion(value: unknown): CandidateVersionVerdict | null {
  if (value && typeof value === 'object') return value as CandidateVersionVerdict;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as CandidateVersionVerdict) : null;
  } catch {
    return null;
  }
}

function isPromotableCandidate(candidate: CandidateVersionVerdict | null, variantId: unknown): boolean {
  if (!candidate || candidate.schemaVersion !== 1) return false;
  if (!candidate.candidateId || String(variantId ?? '') !== candidate.candidateId || !candidate.parentId) return false;
  const hashes = candidate.hashes;
  if (!hashes || Object.values(hashes).some((value) => typeof value !== 'string' || value.trim().length === 0 || value === 'unresolved')) return false;
  // P-003: every gate must be an affirmative PASS. Checking `status` rather than the
  // derived `pass` makes the intent explicit — an unmeasured guardrail is not a
  // promotion basis — while the `pass` fallback keeps pre-P-003 persisted rows
  // (which carry no `status`) judged exactly as they were written.
  return (
    candidate.verdict === 'accept' &&
    candidate.gateResults.length > 0 &&
    candidate.gateResults.every((gate) => ((gate as { status?: string }).status ?? (gate.pass ? 'pass' : 'fail')) === 'pass')
  );
}

export async function decideProposal(
  sql: Sql,
  q: {
    id: string;
    workspaceId: string;
    harnessSlug: string;
    decision: 'accepted' | 'rejected';
    now?: number;
    /**
     * P-002 / D-004(3): deliberately install a challenger that has NOT been shown to
     * hold the real-anchor pool. The reason is not decoration — it is stamped into the
     * behaviour-change ledger, because this is the one way a prompt reaches real agents
     * without the evidence D-004 requires, and an unattributable one would be exactly
     * the ungated install the ruling was about.
     */
    override?: { reason: string },
  },
): Promise<DecideResult> {
  const now = q.now ?? Date.now();
  const run = async (tx: Sql): Promise<DecideResult> => {
    const rows = (await tx`
      SELECT * FROM harness_shared.gym_proposals
       WHERE id = ${q.id} AND workspace_id = ${q.workspaceId} AND harness_slug = ${q.harnessSlug}
       FOR UPDATE`) as Row[];
    if (!rows.length) return { ok: false, reason: 'not_found' };
    const row = mapProposal(rows[0]);
    if (row.status !== 'pending') return { ok: false, reason: 'already_decided', proposal: row };

    const promoted = q.decision === 'accepted';
    // P-002 / D-004(3) — the last check before this accept becomes a live prompt every
    // real agent spawn reads. Placed HERE, not in the callers, because both the
    // auto-decide loop and the human gym:accept route end up on this write and the
    // human one carried no gate at all. Refusing leaves the row PENDING (not rejected):
    // "not shown to hold the real-anchor" is a gap in evidence, not a verdict on the
    // candidate, and a run of the pool can still settle it.
    if (promoted && !q.override) {
      const hold = realAnchorHeld(row.candidateVersion);
      if (!hold.held) return { ok: false, reason: hold.reason!, proposal: row };
    }
    if (promoted) {
      await tx`
        INSERT INTO harness_shared.harness_prompt_overrides (workspace_id, harness_slug, role, prompt_md, updated_at)
        VALUES (${q.workspaceId}, ${q.harnessSlug}, ${row.role}, ${row.proposedMd}, ${now})
        ON CONFLICT (workspace_id, harness_slug, role) DO UPDATE
          SET prompt_md = EXCLUDED.prompt_md, updated_at = EXCLUDED.updated_at`;
    }
    await tx`UPDATE harness_shared.gym_proposals SET status = ${q.decision}, decided_at = ${now} WHERE id = ${q.id}`;
    await recordProducerObservation(tx, { producer: 'gym', workspaceId: q.workspaceId, sourceId: q.id });
    // P-030 (consume-edges B-09): acceptance opens the post-acceptance outcome
    // window — the baseline is captured ATOMICALLY with the accept, so an
    // accepted champion without a tracking row cannot exist. The gym tick
    // finalizes the row once the window elapses (finalizePendingChampionOutcomes).
    if (promoted) {
      await recordChampionAcceptance(tx, {
        proposal: {
          id: row.id,
          workspaceId: row.workspaceId,
          harnessSlug: row.harnessSlug,
          role: row.role,
          variantId: row.variantId,
          cycle: row.cycle,
          devAnchorDelta: row.devAnchorDelta,
          costDelta: row.costDelta,
          probeStatus: row.probeStatus,
        },
        acceptedAt: now,
      });
    }
    return { ok: true, promoted, proposal: { ...row, status: q.decision, decidedAt: now } };
  };
  // Accept's promote + status-update must be atomic. Open our own transaction when handed a
  // top-level client; when the caller already runs us inside one (routeWithWorkspace passes a
  // TransactionSql, which has no `.begin`), run directly — it's already atomic in the outer tx.
  const begin = (sql as unknown as { begin?: unknown }).begin;
  // postgres.js types Sql and TransactionSql as non-overlapping even though the
  // runtime objects are template-call compatible — hence the through-unknown cast.
  const result =
    typeof begin === 'function'
      ? ((await sql.begin(run as unknown as (tx: TransactionSql<Record<string, unknown>>) => Promise<DecideResult>)) as DecideResult)
      : await run(sql);
  // The gym committer's behavior-change-ledger hook (self-learning-frontier
  // P-004 / D-003): an accepted proposal IS a live prompt mutation. Best-effort
  // AFTER the decide — a ledger failure must never roll back the promotion.
  if (result.ok && result.promoted && result.proposal) {
    await recordBehaviorChange({
      workspaceId: q.workspaceId,
      source: 'gym:accept',
      action: 'set',
      targetKind: 'prompt-override',
      target: `${q.harnessSlug}/${result.proposal.role}`,
      harnessSlug: q.harnessSlug,
      role: result.proposal.role,
      diffRef: q.id,
      actor: 'gym:accept',
      // P-002 / D-004(3): an override installed a prompt WITHOUT the real-anchor
      // evidence the ruling requires. That is legitimate but exceptional, so it is
      // named in the ledger line itself rather than left to be inferred from its
      // absence — the ledger is where "why is the live prompt this?" gets answered.
      summary: q.override
        ? `gym proposal accepted → ${result.proposal.role}@${q.harnessSlug} [REAL-ANCHOR GATE OVERRIDDEN: ${q.override.reason}]`
        : `gym proposal accepted → ${result.proposal.role}@${q.harnessSlug}`,
    });
    // NOV-4 champion escalation (autonomous-loop-prod-audit-2026-07-02 P-016 /
    // WI-4636): "gym champions auto-file improvement work items into the queen
    // frontier" — an accepted champion is exactly the kind of "does this pattern
    // generalize?" judgment call the Queen's ordinary triage backlog exists for.
    // Best-effort, strictly AFTER the accept has already committed: a capture
    // failure here must never roll back or fail the promotion.
    try {
      const { escalateChampionToQueenFrontier } = await import('./champion-escalation');
      await escalateChampionToQueenFrontier({
        proposalId: result.proposal.id,
        harnessSlug: q.harnessSlug,
        role: result.proposal.role,
        cycle: result.proposal.cycle,
        variantId: result.proposal.variantId,
        devAnchorDelta: result.proposal.devAnchorDelta,
        costDelta: result.proposal.costDelta,
        probeStatus: result.proposal.probeStatus,
      });
    } catch (err) {
       
      console.warn(
        '[gym/control-plane] champion-escalation capture failed (accept unaffected):',
        err instanceof Error ? err.message : err,
      );
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Autoloop config
// ---------------------------------------------------------------------------

export async function getAutoloop(
  sql: Sql,
  q: { workspaceId: string; harnessSlug: string },
): Promise<GymAutoloopConfig | null> {
  const rows = (await sql`
    SELECT * FROM harness_shared.gym_autoloop_config
     WHERE workspace_id = ${q.workspaceId} AND harness_slug = ${q.harnessSlug} LIMIT 1`) as Row[];
  return rows.length ? mapAutoloop(rows[0]) : null;
}

export interface SetAutoloopInput {
  workspaceId: string;
  harnessSlug: string;
  enabled?: boolean;
  /** number sets a cap; null clears it; undefined leaves it unchanged. */
  budgetUsd?: number | null;
  spentUsd?: number;
  status?: string;
  lastCycle?: number | null;
  lastCycleAt?: number | null;
  now?: number;
}

/** Upsert the per-harness autoloop config; omitted fields are preserved. */
export async function setAutoloop(sql: Sql, q: SetAutoloopInput): Promise<GymAutoloopConfig> {
  const now = q.now ?? Date.now();
  const existing = await getAutoloop(sql, { workspaceId: q.workspaceId, harnessSlug: q.harnessSlug });
  const merged: GymAutoloopConfig = {
    workspaceId: q.workspaceId,
    harnessSlug: q.harnessSlug,
    enabled: q.enabled ?? existing?.enabled ?? false,
    budgetUsd: q.budgetUsd !== undefined ? q.budgetUsd : existing?.budgetUsd ?? null,
    spentUsd: q.spentUsd ?? existing?.spentUsd ?? 0,
    status: q.status ?? existing?.status ?? 'idle',
    lastCycle: q.lastCycle !== undefined ? q.lastCycle : existing?.lastCycle ?? null,
    lastCycleAt: q.lastCycleAt !== undefined ? q.lastCycleAt : existing?.lastCycleAt ?? null,
    updatedAt: now,
  };
  await sql`
    INSERT INTO harness_shared.gym_autoloop_config
      (workspace_id, harness_slug, enabled, budget_usd, spent_usd, status, last_cycle, last_cycle_at, updated_at)
    VALUES (${merged.workspaceId}, ${merged.harnessSlug}, ${merged.enabled}, ${merged.budgetUsd}, ${merged.spentUsd},
       ${merged.status}, ${merged.lastCycle}, ${merged.lastCycleAt}, ${merged.updatedAt})
    ON CONFLICT (workspace_id, harness_slug) DO UPDATE SET
       enabled = EXCLUDED.enabled, budget_usd = EXCLUDED.budget_usd, spent_usd = EXCLUDED.spent_usd,
       status = EXCLUDED.status, last_cycle = EXCLUDED.last_cycle, last_cycle_at = EXCLUDED.last_cycle_at,
       updated_at = EXCLUDED.updated_at`;
  // Push-on-write: the Gym view's autoloop pill (RUNNING/spend) reads this row.
  void trackDetached(import('../sync-sse'))
    .then((m) => m.notifySyncInvalidate('learning.gym'))
    .catch(() => {});
  return merged;
}

// ---------------------------------------------------------------------------
// Gym loop → control plane bridge
// ---------------------------------------------------------------------------

/**
 * Build a `deps.recordProposal` for runOptimizationLoop that writes each candidate's
 * CHANGED-role prompts into harness_shared.gym_proposals (pending) for human review.
 * Only roles whose merged prompt differs from the parent's are recorded (the diff);
 * inherited/unchanged roles are skipped. Bind this in the human-gated autoloop runner
 * (with autoPromote:false) so the gym surfaces scored suggestions the user accepts via
 * gym:accept. Also bumps the autoloop config's last_cycle each cycle.
 */
export function makeLoopProposalRecorder(
  sql: Sql,
  ctx: { workspaceId: string; harnessSlug: string; now?: () => number },
): (rec: LoopProposalRecord) => Promise<void> {
  const now = ctx.now ?? (() => Date.now());
  return async (rec: LoopProposalRecord) => {
    const parent = rec.parentOverlay.promptOverrides;
    const ts = now();
    for (const [role, proposedMd] of Object.entries(rec.overlay.promptOverrides)) {
      const originalMd = parent[role] ?? null;
      if (originalMd === proposedMd) continue; // unchanged inherited role — not a diff
      await recordProposal(sql, {
        workspaceId: ctx.workspaceId,
        harnessSlug: ctx.harnessSlug,
        cycle: rec.cycle,
        variantId: rec.candidateId,
        role,
        originalMd,
        proposedMd,
        rationale: rec.rationale,
        devAnchorDelta: rec.devAnchorDelta,
        costDelta: rec.costDelta,
        probeStatus: rec.probeStatus,
        candidateVersion: rec.candidateVersion,
        now: ts,
      });
    }
    await setAutoloop(sql, {
      workspaceId: ctx.workspaceId,
      harnessSlug: ctx.harnessSlug,
      lastCycle: rec.cycle,
      lastCycleAt: ts,
      now: ts,
    });
  };
}
