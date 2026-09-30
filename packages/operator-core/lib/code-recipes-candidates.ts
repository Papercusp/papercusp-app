/**
 * code-recipes-candidates.ts — the DETERMINISTIC Phase-3 graduation signal layer
 * for code recipes (code-recipes-2026-06-21, P-013 / D-010 / D-013 / D-015 /
 * D-016 / D-017).
 *
 * `recipeCandidates(sql, opts)` reads `harness_shared.code_recipes` +
 * `harness_shared.code_recipe_runs` and, per ACTIVE recipe, computes the
 * raw usage signals (run_count, distinct agents, success-rate, tool-set) AND a
 * deterministic **promotionScore** (0..1) against the recipe rubric — NO LLM. It
 * returns ranked PROMOTE candidates (worth building into a defineTool) plus the
 * near-duplicate MERGE clusters the Queen reviews. The Queen CALLS this in her
 * cadence (PULL, D-017) and files a work-item to promote/merge; her plan/work-item
 * system is the gate (D-013). The rubric (P-012) is the matching scoring standard —
 * its method clause cites the weight block below verbatim.
 *
 * Why deterministic: counting is code's job; only the JUDGMENT (does this recipe
 * deserve a tool? should these two merge?) is the Queen's (D-010). This tool gives
 * her the numbers and the worklist; she decides.
 *
 * Transport-agnostic: takes the `sql` handle (the tool's workspace-resolved
 * getOrgPg() connection, or a testcontainer handle), mirroring code-recipes-store /
 * code-recipes-search.
 *
 * Server-only.
 */
import type postgres from 'postgres';
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import { searchSimilarRecipes } from './code-recipes-search';

// ────────────────────────────────────────────────────────────────────────────
// RECIPE RUBRIC (method)
//
// The promotionScore is a deterministic weighted sum of four usage criteria, each
// normalized to 0..1, then DAMPED for redundancy. The recipe rubric (P-012) cites
// this block verbatim as its "method" — change the weights HERE and the rubric
// reference stays the single source of truth.
//
//   promotionScore = redundancyDamp × (
//       W_FREQUENCY  × freqScore       // run-frequency: how proven the demand is
//     + W_BREADTH    × breadthScore    // distinct-agent reuse breadth
//     + W_SUCCESS    × successScore    // success-rate / stability
//     + W_COHESION   × cohesionScore   // tool-set cohesion (batches ≥2 tools)
//     )                                // [+ W_COOCCUR × cooccurScore when su-eaade's
//                                      //  dev:tool_cooccurrence telemetry is wired]
//
// Weights (sum to 1.0 so the un-damped score is a clean 0..1; the optional
// co-occurrence signal, when present, is folded in as a re-normalized extra leg):
//   • W_FREQUENCY = 0.30 — run-frequency is the genesis signal D-006 calls the
//     strongest ("the demand is proven, not guessed"); the heaviest single weight.
//     Method: log-saturating on run_count so a recipe run 20× isn't scored 20×
//     a recipe run 1× — freqScore = min(1, ln(1+runCount) / ln(1+FREQ_SATURATION)),
//     FREQ_SATURATION = 20 (run ~20× ⇒ saturated to 1.0).
//   • W_BREADTH = 0.30 — distinct-agent reuse breadth is the "is this MINE or
//     OURS?" signal: a recipe many agents reuse is a shared tool, a recipe one
//     agent runs repeatedly is a personal macro. Weighted equal to frequency so a
//     hot-but-solo recipe can't out-promote a broadly-reused one.
//     Method: breadthScore = min(1, distinctAgents / BREADTH_SATURATION),
//     BREADTH_SATURATION = 5 (≥5 distinct agents ⇒ saturated).
//   • W_SUCCESS = 0.20 — success-rate / stability: a flaky recipe shouldn't
//     graduate into a tool other agents depend on. successScore = successRate
//     (success_count / run_count); a recipe with 0 runs scores 0 (no evidence).
//   • W_COHESION = 0.20 — tool-set cohesion: a recipe that BATCHES ≥2 distinct
//     tools is the genuine "wrapper worth a tool" case (D-016: bundles); a 1-tool
//     recipe is a thin wrapper that adds little over calling the tool directly, so
//     it is ALSO flagged redundant (see below). cohesionScore ramps 0→1 across
//     toolCount 1→COHESION_SATURATION(=3): 1 tool ⇒ 0, 2 ⇒ 0.5, ≥3 ⇒ 1.0.
//
// Redundancy damp (multiplicative, applied AFTER the weighted sum):
//   • TRIVIAL  — toolCount ≤ 1: not batch-worthy. damp = 0 ⇒ EXCLUDED from
//     promote candidates entirely (a 1-tool wrapper never promotes).
//   • NAME COLLISION — an existing defineTool already projects a tool whose name
//     matches the recipe id/slug (listAllProjectedTools names): the tool already
//     exists, so promoting would regenerate it (D-007). damp = 0 ⇒ EXCLUDED.
//   • Otherwise damp = 1.0 (no redundancy).
//
// A recipe is a PROMOTE candidate iff: status='active', not already promoted/merged,
// not redundant, promotionScore ≥ PROMOTE_THRESHOLD (= 0.45), AND it clears the REUSE
// FLOOR — reused by ≥2 distinct agents OR run ≥3 times (MIN_PROMOTE_DISTINCT_AGENTS /
// MIN_PROMOTE_RUN_COUNT). The floor is load-bearing: success(0.20)+cohesion(0.20) are
// maxed by a SINGLE successful multi-tool run, so the weighted score alone can clear the
// threshold (a 3-tool one-off ⇒ 0.528) with zero reuse evidence — the floor requires
// reuse you can SEE in the run-log before a recipe graduates into a tool.
//
// MERGE clusters (D-015): for each active recipe, searchSimilarRecipes(excludeId=self)
// is run; any peer with blended similarity ≥ MERGE_SIMILARITY (= 0.8) is a
// near-duplicate. Connected near-duplicate pairs are unioned into clusters — the
// Queen's merge worklist. One mechanism (the write-time dedup hybrid), two uses.
// ────────────────────────────────────────────────────────────────────────────

const W_FREQUENCY = 0.3;
const W_BREADTH = 0.3;
const W_SUCCESS = 0.2;
const W_COHESION = 0.2;
/** Optional extra leg, folded in (re-normalized) only when co-occurrence telemetry is wired. */
const W_COOCCUR = 0.2;

const FREQ_SATURATION = 20;
const BREADTH_SATURATION = 5;
const COHESION_SATURATION = 3;

const PROMOTE_THRESHOLD = 0.45;
/**
 * Reuse FLOOR for a promote candidate — PROVEN reuse, not just a high intrinsic score.
 * A recipe run once by one agent maxes success(0.20)+cohesion(0.20) — 0.4 of the score —
 * with ZERO reuse evidence, so the weighted score ALONE can clear PROMOTE_THRESHOLD (a
 * single 3-tool run ⇒ 0.528). Gate on reuse you can SEE in the run-log: a candidate must
 * be reused by ≥2 distinct agents OR run ≥3 times ("proven demand, not guessed" — D-006).
 */
const MIN_PROMOTE_DISTINCT_AGENTS = 2;
const MIN_PROMOTE_RUN_COUNT = 3;
const MERGE_SIMILARITY = 0.8;
const DEFAULT_MIN_RUN_COUNT = 2;
const DEFAULT_LIMIT = 25;

/** Raw + computed signals for one active recipe (the per-recipe row the rubric reads). */
export interface RecipeSignal {
  id: string;
  title: string;
  description: string;
  status: string;
  runCount: number;
  /** COUNT(DISTINCT agent_owner) over code_recipe_runs (the reuse-breadth signal). */
  distinctAgents: number;
  /** success_count / run_count, 0 when never run. */
  successRate: number;
  lastRunAt: string | null;
  toolsUsed: string[];
  toolCount: number;
  /** Deterministic 0..1 rubric score (post-redundancy damp). */
  promotionScore: number;
  /** True ⇒ EXCLUDED from promote candidates (trivial 1-tool OR name-collides an existing tool). */
  redundant: boolean;
  /** Human-readable redundancy cause when redundant, else null. */
  redundancyReason: string | null;
}

export interface PromoteCandidate {
  id: string;
  title: string;
  description: string;
  runCount: number;
  distinctAgents: number;
  successRate: number;
  toolsUsed: string[];
  promotionScore: number;
}

export interface MergeCluster {
  recipeIds: string[];
  reason: string;
}

export interface RecipeCandidatesResult {
  promoteCandidates: PromoteCandidate[];
  mergeClusters: MergeCluster[];
  /** The per-recipe signals (for debugging / the rubric grader); not sent to the LLM by default. */
  signals: RecipeSignal[];
}

export interface RecipeCandidatesOpts {
  /** Only consider recipes run at least this many times (default 2 — a single run is no signal). */
  minRunCount?: number;
  /** Max promote candidates to return (default 25). */
  limit?: number;
}

export interface RecipeCandidatesDeps {
  /** Live embedder for the merge-cluster similarity legs (cosine). Absent ⇒ lexical + structural only. */
  embedder?: ((text: string) => Promise<number[]>) | null;
  /**
   * OPTIONAL: su-eaade's tool-call-batching telemetry (tool-call-batching-wrappers-2026-06-21,
   * D-016). When provided, its support/confidence for a recipe's tool-set is folded in as
   * an EXTRA promotion signal (re-normalized W_COOCCUR leg). Absent (the current state — the
   * miner may not exist yet) ⇒ gracefully skipped, the four base legs carry the score.
   * Returns a 0..1 strength for the given tool-set, or null when it has no datum.
   */
  toolCooccurrence?: ((toolsUsed: string[]) => Promise<number | null>) | null;
  log?: (msg: string) => void;
}

type RecipeRow = {
  id: string;
  title: string;
  description: string;
  status: string;
  tools_used: string[] | null;
  run_count: number | string;
  success_count: number | string;
  last_run_at: Date | string | null;
  promoted_tool: string | null;
  merged_into: string | null;
};

const asInt = (v: number | string): number => (typeof v === 'number' ? v : parseInt(v, 10));
const asIsoOrNull = (v: Date | string | null): string | null =>
  v == null ? null : typeof v === 'string' ? v : v.toISOString();

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Slugify a projected tool name to the SAME kebab shape recipe ids use (recipeSlug):
 *  lowercase, every non-alphanumeric run → "-", trimmed. So "plans:set-status" →
 *  "plans-set-status", letting a recipe id (which never contains the ":" a raw tool
 *  name does) be compared against existing tool names for the D-007 collision check. */
export const slugifyToolName = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Build the existing-tool lookups for the D-007 name-collision damp: the raw `ns:verb`
 * names AND their kebab SLUGS (slugifyToolName). A recipe id is a kebab slug, never
 * `ns:verb`, so the SLUG set is what actually catches a recipe that would regenerate an
 * existing tool — the raw-name set alone never matched a slug id (the bug this fixes).
 * Null/empty names are skipped. Exported so the collision fix is unit-testable without PG
 * or a populated tool registry.
 */
export function existingToolSlugSet(
  toolNames: Iterable<string | undefined | null>,
): { names: Set<string>; slugs: Set<string> } {
  const names = new Set<string>();
  const slugs = new Set<string>();
  for (const n of toolNames) {
    if (!n) continue;
    names.add(n);
    slugs.add(slugifyToolName(n));
  }
  return { names, slugs };
}

/** freqScore — log-saturating on run_count (run ~20× ⇒ ~1.0). See RECIPE RUBRIC. */
function freqScore(runCount: number): number {
  if (runCount <= 0) return 0;
  return clamp01(Math.log1p(runCount) / Math.log1p(FREQ_SATURATION));
}
/** breadthScore — linear-saturating on distinct agents (≥5 ⇒ 1.0). */
function breadthScore(distinctAgents: number): number {
  return clamp01(distinctAgents / BREADTH_SATURATION);
}
/** cohesionScore — 1 tool ⇒ 0, ramps to 1.0 at COHESION_SATURATION tools. */
function cohesionScore(toolCount: number): number {
  if (toolCount <= 1) return 0;
  return clamp01((toolCount - 1) / (COHESION_SATURATION - 1));
}

/**
 * Compute graduation candidates for the active recipes. Deterministic
 * end-to-end except for the optional embedder/co-occurrence deps (which only
 * reorder, never gate). Returns ranked promote candidates + merge clusters.
 */
export async function recipeCandidates(
  sql: postgres.Sql,
  opts: RecipeCandidatesOpts,
  deps: RecipeCandidatesDeps = {},
): Promise<RecipeCandidatesResult> {
  const minRunCount = opts.minRunCount ?? DEFAULT_MIN_RUN_COUNT;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const log = deps.log ?? (() => {});

  // ── 1. Per-recipe signals from code_recipes ⨝ code_recipe_runs ───────────────
  // run_count/success_count/last_run_at live denormalized on code_recipes (cheap);
  // distinct_agents is the only thing that NEEDS the side-table, so a single
  // LEFT JOIN + GROUP BY computes COUNT(DISTINCT agent_owner) alongside. We trust
  // the denormalized run_count for the frequency signal (it's the source of truth
  // for the counter; the side-table is the source for distinct-agent breadth).
  const rows = await sql<(RecipeRow & { distinct_agents: number | string })[]>`
      SELECT r.id, r.title, r.description, r.status, r.tools_used,
             r.run_count, r.success_count, r.last_run_at, r.promoted_tool, r.merged_into,
             COUNT(DISTINCT run.agent_owner) AS distinct_agents
        FROM harness_shared.code_recipes r
   LEFT JOIN harness_shared.code_recipe_runs run
          ON run.recipe_id = r.id
       WHERE r.status = 'active'
         AND r.run_count >= ${minRunCount}
    GROUP BY r.id`;

  // Existing-tool lookups for the D-007 name-collision damp (raw names + kebab slugs).
  // A recipe id is a kebab slug, never `ns:verb`, so comparing the id to the RAW tool
  // name never matched (the bug this replaces — the damp was dead); the SLUG set is what
  // catches a recipe whose id maps onto an existing tool.
  const { names: existingToolNames, slugs: existingToolSlugs } = existingToolSlugSet(
    listAllProjectedTools().map((t) => t.expose.mcp?.name),
  );

  const signals: RecipeSignal[] = [];
  for (const r of rows) {
    const runCount = asInt(r.run_count);
    const successCount = asInt(r.success_count);
    const distinctAgents = asInt(r.distinct_agents);
    const toolsUsed = r.tools_used ?? [];
    const toolCount = toolsUsed.length;
    const successRate = runCount > 0 ? clamp01(successCount / runCount) : 0;

    // Redundancy (excludes from promote candidates):
    //   • TRIVIAL — toolCount ≤ 1: a 1-tool wrapper isn't batch-worthy.
    //   • NAME COLLISION — an existing defineTool already owns this name/slug.
    let redundant = false;
    let redundancyReason: string | null = null;
    if (toolCount <= 1) {
      redundant = true;
      redundancyReason = 'trivial: batches ≤1 distinct tool (not worth a tool over the primitive)';
    } else if (existingToolNames.has(r.id) || existingToolSlugs.has(r.id)) {
      redundant = true;
      redundancyReason = `name_collision: recipe id "${r.id}" maps to an existing tool (D-007 — promoting would regenerate it)`;
    }

    // Weighted rubric sum (see RECIPE RUBRIC method block above).
    const fS = freqScore(runCount);
    const bS = breadthScore(distinctAgents);
    const sS = successRate;
    const cS = cohesionScore(toolCount);
    let base = W_FREQUENCY * fS + W_BREADTH * bS + W_SUCCESS * sS + W_COHESION * cS;

    // OPTIONAL co-occurrence leg (su-eaade, D-016) — fold in only when wired; the
    // extra weight is re-normalized into the sum so the score stays 0..1.
    if (deps.toolCooccurrence) {
      try {
        const co = await deps.toolCooccurrence(toolsUsed);
        if (co != null) {
          const total = W_FREQUENCY + W_BREADTH + W_SUCCESS + W_COHESION + W_COOCCUR;
          base =
            (W_FREQUENCY * fS + W_BREADTH * bS + W_SUCCESS * sS + W_COHESION * cS + W_COOCCUR * clamp01(co)) /
            total;
        }
      } catch (err) {
        log(`recipeCandidates: tool-cooccurrence leg skipped (${(err as Error)?.message ?? String(err)})`);
      }
    }

    // Redundancy damp: trivial / name-collision ⇒ 0 (excluded); else passthrough.
    const promotionScore = redundant ? 0 : clamp01(base);

    signals.push({
      id: r.id,
      title: r.title,
      description: r.description,
      status: r.status,
      runCount,
      distinctAgents,
      successRate,
      lastRunAt: asIsoOrNull(r.last_run_at),
      toolsUsed,
      toolCount,
      promotionScore,
      redundant,
      redundancyReason,
    });
  }

  // ── 2. Promote candidates: not-redundant, not-already-promoted, score ≥ threshold ──
  // (status='active' already filtered in SQL; promoted/merged recipes are not active.
  //  promoted_tool/merged_into are belt-and-suspenders for an active row mid-transition.)
  const alreadyPromoted = new Map(rows.map((r) => [r.id, !!r.promoted_tool || !!r.merged_into]));
  const promoteCandidates: PromoteCandidate[] = signals
    .filter(
      (s) =>
        !s.redundant &&
        !(alreadyPromoted.get(s.id) ?? false) &&
        s.promotionScore >= PROMOTE_THRESHOLD &&
        // Reuse FLOOR: proven reuse, not just a high intrinsic score — a single
        // multi-tool run can clear the threshold on success+cohesion alone.
        (s.distinctAgents >= MIN_PROMOTE_DISTINCT_AGENTS || s.runCount >= MIN_PROMOTE_RUN_COUNT),
    )
    .sort((a, b) => b.promotionScore - a.promotionScore || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      runCount: s.runCount,
      distinctAgents: s.distinctAgents,
      successRate: s.successRate,
      toolsUsed: s.toolsUsed,
      promotionScore: s.promotionScore,
    }));

  // ── 3. Merge clusters (D-015): near-duplicate active recipes, unioned ─────────
  // For each active recipe, find peers with blended similarity ≥ MERGE_SIMILARITY
  // via the SAME hybrid the write-time dedup uses (excludeId=self). Build an
  // undirected graph of near-duplicate edges, then connected components ≥2 are the
  // Queen's merge worklist. The embedder (if any) powers the cosine leg; absent ⇒
  // lexical + structural still find exact/near twins.
  const adjacency = new Map<string, Set<string>>();
  for (const s of signals) adjacency.set(s.id, new Set());

  for (const s of signals) {
    let similar;
    try {
      similar = await searchSimilarRecipes(
        sql,
        {
          title: s.title,
          description: s.description,
          toolsUsed: s.toolsUsed,
          embedding: null,
          excludeId: s.id,
          limit: 10,
        },
        { embedder: deps.embedder ?? null, log },
      );
    } catch (err) {
      log(`recipeCandidates: merge-cluster search skipped for ${s.id} (${(err as Error)?.message ?? String(err)})`);
      continue;
    }
    for (const peer of similar) {
      if (peer.similarity < MERGE_SIMILARITY) continue;
      // Only cluster peers that are themselves active candidates (a peer below
      // minRunCount won't be in `signals`).
      if (!adjacency.has(peer.id)) continue;
      adjacency.get(s.id)!.add(peer.id);
      adjacency.get(peer.id)!.add(s.id);
    }
  }

  const mergeClusters: MergeCluster[] = [];
  const seen = new Set<string>();
  for (const start of signals.map((s) => s.id)) {
    if (seen.has(start)) continue;
    // BFS the connected component.
    const component: string[] = [];
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const cur = queue.shift()!;
      component.push(cur);
      for (const nb of adjacency.get(cur) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          queue.push(nb);
        }
      }
    }
    if (component.length >= 2) {
      component.sort((a, b) => a.localeCompare(b));
      mergeClusters.push({
        recipeIds: component,
        reason: `near-duplicate cluster (similarity ≥ ${MERGE_SIMILARITY}) — review for merge into one recipe (D-015)`,
      });
    }
  }
  mergeClusters.sort((a, b) => a.recipeIds[0].localeCompare(b.recipeIds[0]));

  return { promoteCandidates, mergeClusters, signals };
}
