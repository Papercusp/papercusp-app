/**
 * coordination-runtime — the RUNTIME that enacts a {@link CoordinationSpec} (benchmark-coordination-
 * topologies). A topology is NOT a separate orchestrator: in the su system, agents coordinate via their
 * coord/* tools, guided by a DIRECTIVE + a tool-scope + a team grouping. So the runtime is a pure
 * mapping `spec → spawn plan` (driver-level, per the loop's "map blueprint.coordination → bee spawn
 * directives, not an orchestrator rewrite"). The pool driver spawns each worker with this plan; the
 * agents then enact the topology themselves.
 *
 * Pure + unit-tested (no fleet/PG); the driver supplies the backlog + applies the plan.
 */
import type { CoordinationSpec } from './coordination-topology';
import type { BenchTask } from './types';

/** The org__repo identity of a task (for per-repo huddle grouping). Parsed from the SWE-bench-style
 *  `instance_<org>__<repo>-<sha>` instanceId; falls back to the whole instanceId. */
export function repoKey(task: BenchTask): string {
  const id = task.instanceId.replace(/^instance_/, '');
  // strip a trailing -<40hex>[-v<...>] commit/version suffix → the org__repo head
  const m = id.match(/^(.*?)-[0-9a-f]{6,}(?:-v.*)?$/);
  return (m ? m[1] : id) || id;
}

/**
 * Group the backlog into coordination TEAMS per `spec.team`:
 *  - per-backlog → ONE team over the whole backlog (the shared queue; broadcast/blackboard arms).
 *  - per-repo    → one team per repo (the huddle — agents on the same repo coordinate).
 *  - per-task    → one team per task (pair / ensemble — multiple agents collaborate on ONE task).
 * Order within a team preserves backlog (FIFO) order so self-claim-fifo claims arrival-order.
 */
export function groupTeams(spec: CoordinationSpec, backlog: readonly BenchTask[]): BenchTask[][] {
  if (spec.team === 'per-task') return backlog.map((t) => [t]);
  if (spec.team === 'per-repo') {
    const byRepo = new Map<string, BenchTask[]>();
    for (const t of backlog) {
      const k = repoKey(t);
      const arr = byRepo.get(k);
      if (arr) arr.push(t);
      else byRepo.set(k, [t]);
    }
    return [...byRepo.values()];
  }
  return [backlog.slice()]; // per-backlog: one shared team
}

/** coord/* tools a worker in this topology may NOT use (e.g. ['coord:send'] enforces blackboard-only). */
export function forbiddenCoordTools(spec: CoordinationSpec): string[] {
  return spec.disciplineForbid;
}

/** A topic name a flat-distributed team broadcasts findings to (per-arm, per-team). */
export function teamTopic(spec: CoordinationSpec, teamKey: string): string {
  return `bench:${spec.arm}:${teamKey}`;
}

/**
 * The coordination DIRECTIVE injected into each worker's prompt — the instructions that make the agent
 * ENACT the topology via its coord/* tools. Composed from the spec so every topology's worker behavior
 * is declared, not hand-written per arm. `central` arms return '' (the Queen orchestrates; workers are
 * plain bees).
 */
export function coordinationDirective(spec: CoordinationSpec, teamKey: string): string {
  if (spec.central) return ''; // central-Queen: the Queen coordinates; the worker is a plain bee.
  const lines: string[] = [
    `You are a PEER worker in a DISTRIBUTED team (no central coordinator) for benchmark arm "${spec.arm}".`,
  ];
  if (spec.claimModel.startsWith('self-claim')) {
    const order = spec.claimModel === 'self-claim-priority' ? 'priority' : 'arrival (FIFO)';
    lines.push(
      `CLAIM: pull the next ready work-item yourself (work_items:claim_next, ${order} order) — no one assigns it.` +
        ` Declare-intent on what you claim so peers see it and don't double-work it.`,
    );
  }
  if (spec.sharedState === 'blackboard') {
    lines.push(
      `COORDINATE VIA THE BLACKBOARD ONLY: read peers' notes from the shared work-item state before you start,` +
        ` write your findings/decisions back to it as you go. Do NOT message peers directly (coord:send is disabled).`,
    );
  } else {
    if (spec.broadcast === 'topic') {
      lines.push(
        `BROADCAST: publish findings/blockers to topic "${teamTopic(spec, teamKey)}" (and read it) so peers` +
          ` can correct you + avoid duplicating discovery.`,
      );
    }
    if (spec.sharedState !== 'messages') {
      lines.push(`Also record durable findings on the shared work-item state for peers.`);
    }
  }
  if (spec.review === 'peer') {
    lines.push(
      `PEER REVIEW: before you finalize, ask a peer to review/critique your solution; address their feedback.` +
        ` Likewise, review a peer's solution when asked.`,
    );
  }
  if (spec.team === 'per-repo') {
    lines.push(`HUDDLE: you and peers working repo "${teamKey}" share repo-understanding + coordinate edits to avoid conflicts.`);
  } else if (spec.team === 'per-task') {
    lines.push(`You and your teammate(s) collaborate on the SAME task — split/cross-check the work continuously.`);
  }
  if (spec.coordinator === 'elected-lead') {
    lines.push(
      `UNDER A LEAD: a team LEAD has run a coordination pass and recorded the plan/assignment + shared strategy` +
        ` in shared state (and topic "${teamTopic(spec, teamKey)}") — read it before you start, align your work with it,` +
        ` and report progress/blockers back so the lead can re-coordinate.`,
    );
  }
  return lines.join('\n');
}

/**
 * The directive for the elected LEAD of a hierarchical team ({@link CoordinationSpec.coordinator} =
 * 'elected-lead'). The lead runs ONE coordination pass over the team's backlog — plan/assign/strategize,
 * recording the plan in shared state for the workers — and does NOT solve tasks itself. A PEER coordinator
 * within the team, not the system Queen. Its calls are charged to the arm's iso-budget (coordination cost).
 */
export function leadDirective(spec: CoordinationSpec, teamKey: string, taskCount: number): string {
  return [
    `You are the elected LEAD of a DISTRIBUTED team (arm "${spec.arm}", ${taskCount} task(s)) — a PEER coordinator, NOT a central authority and NOT a solver.`,
    `Run ONE coordination pass: review the team's ${taskCount} task(s); decide a strategy + an assignment/ordering; surface shared context that helps every worker (repo structure, common pitfalls, ordering).`,
    `Record the plan in shared work-item state AND broadcast it to topic "${teamTopic(spec, teamKey)}" so the workers execute under it. You do NOT write the solutions — the workers do; your only value is coordination.`,
  ].join('\n');
}

/** The per-team spawn plan the pool driver applies: which tasks the team owns + its workers' directive
 *  + tool-scope. One plan per team; the driver spawns `min(team.length-or-policy, cap)` workers each. */
export interface TeamSpawnPlan {
  teamKey: string;
  tasks: BenchTask[];
  directive: string;
  forbidTools: string[];
}

/** Resolve a CoordinationSpec + backlog → the per-team spawn plans the driver executes. */
export function coordinationSpawnPlans(spec: CoordinationSpec, backlog: readonly BenchTask[]): TeamSpawnPlan[] {
  const teams = groupTeams(spec, backlog);
  const forbidTools = forbiddenCoordTools(spec);
  return teams.map((tasks, i) => {
    const teamKey = spec.team === 'per-repo' ? repoKey(tasks[0]) : spec.team === 'per-task' ? tasks[0].instanceId : `all-${i}`;
    return { teamKey, tasks, directive: coordinationDirective(spec, teamKey), forbidTools };
  });
}

// ── C4 measurement: which tool calls count as ACTIVE COORDINATION ──────────────────────────────────
// The C4 fairness check ("was the topology actually exercised?") needs every arm to count coordination
// the SAME way — otherwise the measurement itself is a fairness bug. A consumer's runAgent populates
// AgentRunOutput.coordCalls = countCoordinationCalls(<the agent's tool-call names>) using this ONE
// predicate, so a `dist-broadcast` arm and an `ensemble` arm are judged on an identical definition.

/**
 * The tool-name matchers that count as INTER-AGENT COORDINATION (not work-acquisition). Rationale: the C4
 * question is "did the agents coordinate vs work in isolation" — so we count direct peer messaging
 * (`coord:*`), broadcast (`topics:*`), and shared-state / blackboard reads+writes
 * (`work_items:comment|amend|observe`). We deliberately EXCLUDE `work_items:claim_next` /
 * `fleet:assignments` — self-claim is present even in the no-coordination arm, so it does not evidence
 * coordination. Peer-review rides `coord:ask`/`coord:send`, already covered by the `coord:` prefix.
 * (`messages:send` was retired 2026-07-26 — retire-work-item-mail-surface-2026-07-26 P-007 —
 * and dropped from this list; it had 0 calls/90d and coord:* subsumed the durable-hand-off case.)
 */
export const COORDINATION_TOOL_MATCHERS: readonly (string | RegExp)[] = [
  /^coord:/,
  /^topics:/,
  'work_items:comment',
  'work_items:amend',
  'work_items:observe',
];

/** PURE: is this tool-call name an active-coordination call (per {@link COORDINATION_TOOL_MATCHERS})? */
export function isCoordinationToolCall(toolName: string): boolean {
  return COORDINATION_TOOL_MATCHERS.some((m) => (typeof m === 'string' ? m === toolName : m.test(toolName)));
}

/** PURE: count active-coordination calls in a sequence of tool-call names — the standard C4 `coordCalls`
 *  computation every consumer's runAgent should use, so the measurement is identical across arms. */
export function countCoordinationCalls(toolNames: Iterable<string>): number {
  let n = 0;
  for (const name of toolNames) if (isCoordinationToolCall(name)) n += 1;
  return n;
}
