/**
 * Competitor multi-agent orchestrators (impartial-benchmark-suite-2026-06-15 P-028 / BRIEF 11 v2, D-010).
 *
 * Phase 5 benchmarks the HIVE (Queen + bee fleet) against OTHER multi-agent systems, not just the
 * native single-agent harness. These are the "competitor" fleet arms — run over the SAME backlog +
 * the SAME external grader as the `hive` / `queen-ablated` / `native-serial` arms. Their headline use is
 * the **L4 coordination-quality** claim: each competitor's MAST failure rates (inter-agent duplication,
 * coordination-breakdown, misalignment, redundant work — vs the published 41–86% MAS baseline) measured
 * IDENTICALLY to the Hive's, so "our coordination is better than other orchestrators'" is evidenced, not asserted.
 *
 * This file is also the P-028 FEASIBILITY record (the P-001 analog for the fleet layer): for each
 * competitor — its multi-agent topology, how it yields a gradeable submission, its license, and the
 * honest integration cost. The LIVE driver bindings are DEFERRED to the pilot (P-032), exactly like
 * `instantiateBenchHarness` (run-loop.ts) and the native-harness arm — running real OpenHands/CrewAI/
 * LangGraph spends real model budget + needs those Python stacks + Docker, so the build ships the typed
 * seam + registry + tests, and the pilot wires the live drivers.
 *
 * ARM-ID vocabulary is the FLEET-arm set (parallel to hive/queen-ablated/native-serial), aligned with the
 * P-030 Evaluation surface (su-4c360) — NOT the 4 per-task `ArmId`s in @papercusp/bench-metrics (those stay
 * locked). A competitor emits per-task `ArmAttempt`s stamped with its fleet arm id (ArmAttempt.arm is an
 * open string) so the rows flow through the same grader + run_result table.
 */

/** The competitor fleet arm ids (aligned with P-030's fleet-arm vocab, su-4c360). */
export type CompetitorArmId = 'openhands-async' | 'crewai' | 'langgraph' | 'roma';

/** How a competitor yields something the official grader can score (the two D-008 modalities). */
export type CompetitorModality = 'diff' | 'in-container';

/** Honest integration cost for the pilot driver binding (the P-028 feasibility verdict). */
export type IntegrationCost = 'low' | 'medium' | 'high';

export interface CompetitorOrchestrator {
  /** Fleet arm id stamped on each emitted ArmAttempt.arm + the run_result row. */
  id: CompetitorArmId;
  title: string;
  /** Upstream project (for citation in the methodology doc, P-016). */
  project: string;
  homepage: string;
  /** SPDX-ish license + any commercial-use caveat (impartiality needs us to be able to run + publish). */
  license: string;
  /** How it is multi-agent — the thing whose coordination quality MAST measures. */
  topology: string;
  /** How it produces a gradeable submission (M1 diff is the pilot backbone, D-008). */
  modality: CompetitorModality;
  /** How the pilot driver invokes it (informs the deferred live binding). */
  invocation: string;
  /** Honest integration cost for the pilot + the one-line reason. */
  integrationCost: IntegrationCost;
  integrationNote: string;
  /** Whether it is in the default pilot set (core) or opt-in (the plan's "opt. ROMA/ORCH"). */
  tier: 'core' | 'optional';
}

/**
 * The competitor set. Core = OpenHands-async / CrewAI / LangGraph (the plan's named three); ROMA is the
 * optional fourth. Notes reflect the public state of these frameworks as eval targets (the P-028 spike).
 */
export const COMPETITOR_ORCHESTRATORS: readonly CompetitorOrchestrator[] = Object.freeze([
  {
    id: 'openhands-async',
    title: 'OpenHands (async multi-agent SWE harness)',
    project: 'OpenHands (All-Hands-AI)',
    homepage: 'https://github.com/All-Hands-AI/OpenHands',
    license: 'MIT — runnable + publishable',
    topology:
      'A delegating agent that spawns sub-agents/async tasks over a repo; the async-SWE harness drains a backlog of issues — the closest external analog to the Hive (fleet over a backlog).',
    modality: 'diff',
    invocation:
      'Python entrypoint / Docker runtime over a cloned repo @ base commit → emits a unified diff per instance (SWE-bench-native output). Pilot driver shells the harness, collects the diff + its agent-event log.',
    integrationCost: 'medium',
    integrationNote:
      'Mature SWE-bench integration → diff extraction is native; the work is parsing its agent/delegation event log into the shared CoordinationTrace for MAST.',
    tier: 'core',
  },
  {
    id: 'crewai',
    title: 'CrewAI (role-based agent crew)',
    project: 'CrewAI',
    homepage: 'https://github.com/crewAIInc/crewAI',
    license: 'MIT — runnable + publishable',
    topology:
      'Explicit role crew (e.g. planner / coder / reviewer) with sequential or hierarchical process + delegation between roles — a hand-authored multi-agent team, not an autonomous fleet.',
    modality: 'diff',
    invocation:
      'A thin CrewAI app (crew of coding roles) over the checkout, tool-equipped to edit files → diff base..HEAD. Pilot driver runs the crew, captures inter-role delegation/messages as the trace.',
    integrationCost: 'high',
    integrationNote:
      'No native SWE harness — we author the crew + file-edit tools + diff extraction ourselves; elicit-to-best (METR) so it is not a strawman. Higher build cost but it is a widely-cited MAS baseline.',
    tier: 'core',
  },
  {
    id: 'langgraph',
    title: 'LangGraph (stateful agent graph)',
    project: 'LangGraph (LangChain)',
    homepage: 'https://github.com/langchain-ai/langgraph',
    license: 'MIT — runnable + publishable',
    topology:
      'A graph/state-machine of agent nodes (supervisor + workers, or a planner→executor cycle) with explicit edges — coordination is the graph topology the author wires.',
    modality: 'diff',
    invocation:
      'A LangGraph supervisor/worker graph with file-edit + test tools over the checkout → diff. Pilot driver runs the graph, captures node transitions + supervisor routing as the trace.',
    integrationCost: 'high',
    integrationNote:
      'Like CrewAI, hand-authored (no native SWE harness); the graph node/edge transitions map cleanly to coordination events, which is good for MAST attribution.',
    tier: 'core',
  },
  {
    id: 'roma',
    title: 'ROMA (recursive orchestrator) — optional',
    project: 'ROMA / ORCH (recursive meta-agent)',
    homepage: 'https://github.com/sentient-agi/ROMA',
    license: 'check upstream before publishing a run',
    topology:
      'Recursive task decomposition — a meta-agent that splits a task into sub-tasks and recursively orchestrates sub-agents. Decomposition-heavy, the most directly comparable to the Queen-decomposes-backlog pattern.',
    modality: 'diff',
    invocation: 'Python recursive runner over the checkout → diff; pilot driver captures the recursion tree as the trace.',
    integrationCost: 'high',
    integrationNote:
      'Opt-in (the plan\'s "opt. ROMA/ORCH"): newer/less-stable than the core three; include only if the pilot has budget. Verify the license before any third-party publication.',
    tier: 'optional',
  },
]);

const BY_ID = new Map<CompetitorArmId, CompetitorOrchestrator>(COMPETITOR_ORCHESTRATORS.map((c) => [c.id, c]));

/** All competitor arm ids (for the fleet-arm vocab + the P-030 Coordination subtab). */
export const COMPETITOR_ARM_IDS: readonly CompetitorArmId[] = COMPETITOR_ORCHESTRATORS.map((c) => c.id);

/** The default pilot set (core tier) — the three named in the plan. */
export const CORE_COMPETITOR_ARM_IDS: readonly CompetitorArmId[] = COMPETITOR_ORCHESTRATORS.filter(
  (c) => c.tier === 'core',
).map((c) => c.id);

export function getCompetitor(id: CompetitorArmId): CompetitorOrchestrator | undefined {
  return BY_ID.get(id);
}

export function isCompetitorArmId(id: string): id is CompetitorArmId {
  return BY_ID.has(id as CompetitorArmId);
}
