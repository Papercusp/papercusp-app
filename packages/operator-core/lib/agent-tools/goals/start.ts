/**
 * goals:start — open a goal AND spawn the GOAL-mode agent that owns it, in one
 * call (goals-tab-improvement-2026-08-09 P-015, D-008).
 *
 * WHY THIS EXISTS AS ONE TOOL. The owner's "+ Start a goal" composer needs
 * three writes to land together: the goal row, a spawned agent, and the
 * `agent_modes` stamp that JOINS them. Done client-side that is three
 * independent calls with two failure gaps, and the gaps are not hypothetical —
 * the workspace this shipped into had TWO goals, ONE goal-mode session, and
 * ZERO rows joining any of them (EI-20015592992797890). A goal whose agent
 * never spawned is worse than no goal: it sits on the board as an outcome
 * somebody believes is being pursued.
 *
 * ORDER IS LOAD-BEARING — row, then mode, then spawn:
 *   1. INSERT the goal (cheap, rollback-able).
 *   2. Stamp `agent_modes` for the PRE-PINNED owner id (cheap, rollback-able).
 *   3. Spawn the agent (expensive, and the only irreversible step).
 * The stamp must precede the spawn because it is what the agent reads on its
 * very first orient; writing it afterwards is a race against the agent's own
 * boot, and losing that race yields a GOAL-mode session that does not know
 * which goal it owns. Pre-pinning the identity (`psu --owner-id=`) is what
 * makes writing-before-existing possible at all.
 *
 * If the spawn fails, both writes are compensated and the tool reports the
 * failure — never a goal with no agent.
 *
 * WHY NOT IN agent-mcp beside goals:create: the spawn needs operator-core's
 * console-launcher, and agent-mcp deliberately does not depend on
 * operator-core. The shared half (id minting + the row write) lives in
 * `@papercusp/agent-mcp/goals` so the two writers cannot drift.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { TripwireSchema, deleteGoalRow, goalId, insertGoalRow } from '@papercusp/agent-mcp/goals';
import { validatePropertySchemaDeclaration } from '../../typed-properties-db';
import { withCanonicalWorklistDeclaration } from '../../goals/package-property-datatypes';
import { applyGoalBlockedBy, readGoalReadiness, replaceGoalBlockedBy } from '@papercusp/agent-mcp/goal-deps';
import { STANDING_GOAL_KILL_POLARITY, killCriterionProblem } from '../../goals/kill-criterion';
import { evaluateGoalStartInputs } from '../../goals/goal-io-validation';
import { isCompilableSchema } from '../../json-schema-validation';
import { buildConsoleEnvelope } from '../../console-launcher';
import { spawnConsole, spawnHeadless } from '../../console-spawn';
import { activeWorkspaceId } from '../../workspace-registry';
import { assertGoalWriteAuthorityForCaller } from '../../goals/write-authority';
import { papercuspPathForWorkspace } from '../../papercusp-root';
import { resolveSpawnHostOperatorBaseUrl } from '../../mcp-base-url';
import { buildAgentLaunchCommand, injectFleetArg, injectLaunchedByArg } from '../../agent-launch-core';
import { drainFleetAutoMintEnabled, mintDrainFleetForGoal, registerGoalDrainFleetLeader, teardownDrainFleetMint } from '../../goals/drain-fleet-mint';
import {
  goalArmWithholdsBrief,
  resolveGoalBehaviorArm,
  type GoalBehaviorArm,
  goalLaunchSettingsSchema,
  goalHolderPolicyProblem,
  goalHolderPolicySchema,
  launchProfileSchema,
  renderGoalPortfolioBrief,
  goalHolderInputRefusal,
  resolveGoalLaunchForGoal,
  type GoalPortfolioBrief,
  type LaunchProfile,
} from '../../goal-launch-settings';
import { resolveAgentIdentity } from '../coordination/identity';
import { setMode } from '../../modes/store';
import type { GoalHistoryContext } from '../../prior-attempt-context';

/**
 * The agent's FIRST TURN.
 *
 * Deliberately NOT a restatement of GOAL mode's contract — that arrives
 * through the mode itself (`coord:orient` re-injects an active mode's contract
 * every wake, and the contract already carries the mandatory kickoff question:
 * read the existing portfolio before creating anything). Repeating it here
 * would be a second copy to drift.
 *
 * What this brief carries is the part the contract CANNOT know: which goal,
 * stated in the owner's own words, with the two constraints GOAL mode requires
 * and this form is now the only place that enforces.
 *
 * EI-20185528589678586 — TWO THINGS THIS BRIEF MUST NOT ASSERT ABOUT ITSELF.
 * Measured 2026-08-11: this brief was delivered ~26h after it was written, into
 * a session that was not the goal's agent, for a goal that had reached
 * `achieved` in between. Both of its standing claims were false on arrival:
 *
 *  1. FRESHNESS. It used to open "which the owner just started". A brief cannot
 *     know when it will be read, so it no longer claims to — it STAMPS the
 *     moment it was written and lets the reader do the subtraction. Any replay
 *     is then self-evident from the text alone, with no dependency on the nonce
 *     ledger or on the reader happening to be suspicious.
 *  2. DELIVERY OF THE CONTRACT. It used to say the contract was "delivered with
 *     your orient" — a statement of fact whose falsity is invisible, because an
 *     agent holding no `overlay:goal` row simply sees no contract and has no cue
 *     that one is missing. The pointer is now FALSIFIABLE: it names where to
 *     look and what to do when it is not there. The comment above still holds —
 *     do NOT paste the contract in here; a second copy is a second copy to
 *     drift. Point at it, checkably.
 *
 * A STATUS line was considered and deliberately NOT added: this door always
 * CREATES the goal it briefs (`goalId(args.title)` below), so status is
 * invariably 'active' at generation time and the field would be decorative
 * here. The stale-status problem belongs to whatever re-delivers a brief later,
 * which is a different surface.
 */
/**
 * Render a budget window as a duration a reader parses at a glance.
 *
 * Exact multiples only, largest unit first. A window like 500000s is NOT
 * rounded to "6 days" — a budget denominator that reads as a round number it
 * is not is precisely the kind of small lie that makes an agent mis-plan its
 * spend, so an inexact value falls back to raw seconds.
 */
function describeWindow(sec: number): string {
  for (const [unit, size] of [
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
  ] as const) {
    if (sec % size === 0) {
      const n = sec / size;
      return n === 1 ? unit : `${n} ${unit}s`;
    }
  }
  return `${sec}s`;
}

export function buildGoalKickoffBrief(opts: {
  goalId: string;
  title: string;
  killCriterion?: string | null;
  budgetCents?: number | null;
  body?: string | null;
  /**
   * TRUE for a STANDING goal (work-on-everything-goal-2026-08-23 P-001) — one
   * pursuing an ongoing duty rather than a checkable outcome.
   *
   * This changes the KILL THIS IF line and nothing else. The ordinary
   * absent-criterion wording below tells the agent to "propose a stopping
   * condition in your kickoff question", which for a standing goal is an
   * instruction to invent the very thing the goal is defined as not having —
   * the agent then spends its kickoff negotiating an outcome, or worse, adopts
   * one and later reports the standing duty COMPLETE. Same absent column, a
   * different true statement about why it is absent.
   */
  standing?: boolean;
  /**
   * Seconds; the denominator for `budgetCents` (P-004). Null/omitted ⇒ the
   * ceiling is for the goal's lifetime and the CEILING line reads as it always
   * has.
   */
  budgetWindowSec?: number | null;
  /** P-012: server-composed live portfolio projection; omitted for legacy/tests. */
  portfolio?: GoalPortfolioBrief | null;
  /** The producer output when the launch sink has already rendered the portfolio. */
  renderedPortfolio?: string | null;
  /** Fixed-budget goal-own + descendant continuity, newest authority first. */
  history?: GoalHistoryContext | null;
  /** Injectable for tests; defaults to the moment the brief is written. */
  writtenAt?: Date;
  /**
   * R-4 / D-032 experiment arm. 'baseline' withholds the portfolio worklist
   * and the long-horizon history block (the brief layers this plan built);
   * every other line is identical in every arm. Absent ⇒ 'full'.
   */
  behaviorArm?: GoalBehaviorArm | null;
}): string {
  if (opts.behaviorArm && goalArmWithholdsBrief(opts.behaviorArm)) {
    opts = { ...opts, portfolio: null, renderedPortfolio: null, history: null };
  }
  /* Both constraints are OPTIONAL at creation since 2026-08-09 (see the args
     schema). When one is absent the brief SAYS SO rather than omitting the
     line: a missing CEILING line reads to the agent as "no budget discipline
     was mentioned", whereas "none declared" plus the spend-visibility
     boundary keeps the discipline without inventing a number the owner
     never gave. Never render `$0.00` or an empty criterion here — a fabricated
     constraint is worse than an acknowledged absent one. */
  const kill = opts.killCriterion?.trim();
  /*
   * The ceiling's DENOMINATOR is part of the number (P-004). "$25.00 declared"
   * means two different budgets depending on whether a window is set, and the
   * agent cannot tell which from the figure alone — so an unqualified amount
   * on a windowed goal reads as far more restrictive than it is, and on a
   * standing goal reads as a total that will inevitably be reached.
   */
  const ceiling =
    opts.budgetCents == null
      ? null
      : `$${(opts.budgetCents / 100).toFixed(2)}${
          opts.budgetWindowSec == null ? '' : ` per ${describeWindow(opts.budgetWindowSec)}`
        }`;
  const spendVisibility =
    'SPEND VISIBILITY — use `goals:pots { goalId }` for measured child-fleet spend. No reliable interactive-session attribution source is exposed; do not invent per-session actuals.';
  const writtenAt = (opts.writtenAt ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const portfolioBlock = opts.renderedPortfolio === undefined
    ? opts.portfolio ? renderGoalPortfolioBrief(opts.portfolio) : null
    : opts.renderedPortfolio;
  return [
    `You are in GOAL mode on goal \`${opts.goalId}\`, started by the owner at ${writtenAt}`,
    '(the moment THIS brief was written — if that is not roughly now, it reached you late).',
    '',
    `OUTCOME — ${opts.title}`,
    opts.body?.trim() ? `\n${opts.body.trim()}\n` : '',
    kill
      ? `KILL THIS IF — ${kill}`
      : opts.standing
        ? `KILL THIS IF — ${STANDING_GOAL_KILL_POLARITY}`
        : 'KILL THIS IF — none declared. Propose a stopping condition in your kickoff question.',
    ceiling
      ? `CEILING — ${ceiling} declared. Do not quietly exceed it.`
      : 'CEILING — none declared. Flag before any large spend.',
    spendVisibility,
    ...(portfolioBlock ? ['', portfolioBlock] : []),
    ...(opts.history ? ['', renderGoalHistoryContext(opts.history)] : []),
    '',
    'Your mode contract governs how to run this, including the mandatory kickoff question.',
    'It arrives in your orient, under `modes[].contract`. If it is NOT there you are not',
    'holding GOAL mode — STOP: run `mode:get { contracts: true }` and `goals:get`, and do',
    'not act on this brief until you hold the contract. A brief can reach the wrong session,',
    'or reach the right one long after the goal it names has moved on. Then begin.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export interface GoalLaunchIdentityInput {
  goalId: string;
  ownerId: string;
  workspaceId: string;
  kickoff: string;
  portfolio: string | null;
  /** Omitted while a recovery holder launches before its GOAL mode attachment. */
  modeState?: unknown;
  /**
   * R-4 / D-032. The arm this launch ran under. An arm that withholds the brief
   * ('baseline') stamps `goal-kickoff` and `goal-portfolio` as omitted with
   * reason 'experiment-arm', so a grader can verify arm integrity from the
   * receipt instead of mistaking a withheld brief for a genuinely absent one.
   * Absent ⇒ 'full'.
   */
  behaviorArm?: GoalBehaviorArm | null;
}

/** Pin one successful launch's existing kickoff/portfolio bytes. Recovery
 * launches explicitly omit the GOAL state until the later holder attachment. */
export async function bindGoalLaunchIdentity(
  input: GoalLaunchIdentityInput,
  binder?: typeof import('../../agent-identities/source').bindSelectedIdentityOutputs,
){
  try {
    const bind = binder ?? (await import('../../agent-identities/source')).bindSelectedIdentityOutputs;
    const armWithheld = input.behaviorArm ? goalArmWithholdsBrief(input.behaviorArm) : false;
    return await bind({
      identityId: 'su.mode-goal',
      sourceTier: 'selected',
      outputs: [
        input.modeState === undefined
          ? { contributionId: 'current-mode-state', omission: { reason: 'not-requested' } }
          : { contributionId: 'current-mode-state', value: input.modeState },
        armWithheld
          ? { contributionId: 'goal-kickoff', omission: { reason: 'experiment-arm' } }
          : { contributionId: 'goal-kickoff', value: input.kickoff },
        armWithheld
          ? { contributionId: 'goal-portfolio', omission: { reason: 'experiment-arm' } }
          : input.portfolio
            ? { contributionId: 'goal-portfolio', value: input.portfolio }
            : { contributionId: 'goal-portfolio', omission: { reason: 'ineligible' } },
      ],
      scope: { workspace: input.workspaceId, goal: input.goalId, ownerId: input.ownerId, sink: 'launch' },
      observedAt: new Date().toISOString(),
    });
  } catch (error) {
    return {
      identityId: 'su.mode-goal', status: 'unavailable',
      errorRef: 'goal-launch:identity-binding-failed',
      detail: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    };
  }
}

/** Attach the launch receipt through the existing tool invocation metadata.
 * The kickoff environment variable remains the delivery sink. */
export async function recordGoalLaunchIdentityBinding(
  input: GoalLaunchIdentityInput,
  metadata?: (data: Record<string, unknown>) => void,
  binder?: typeof import('../../agent-identities/source').bindSelectedIdentityOutputs,
): Promise<void> {
  if (metadata) metadata({ identityContributions: await bindGoalLaunchIdentity(input, binder) });
}

export const GOAL_HISTORY_CONTEXT_HEADING = 'GOAL HISTORY — own and bounded descendant evidence';

export function renderGoalHistoryContext(history: GoalHistoryContext): string {
  return [GOAL_HISTORY_CONTEXT_HEADING, JSON.stringify(history)].join('\n');
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/**
 * A typed start contract can make the goal agent the SOLE actor. The goal
 * agent already exists by the time the drain lane would be minted, so adding
 * the usual headless drain member would violate that contract and create two
 * independent behavioral subjects. Require both the declaration and the
 * validated input value: an incidental `inputs.allowedMembers = 1` must not
 * disable the drain fleet when the goal never declared that constraint.
 */
function declaresSoleMemberContract(
  inputSchema: Record<string, unknown> | undefined,
  inputs: Record<string, unknown> | null,
): boolean {
  if (!inputSchema || !inputs || inputs.allowedMembers !== 1) return false;

  const required = inputSchema.required;
  if (!Array.isArray(required) || !required.includes('allowedMembers')) return false;

  const properties = inputSchema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return false;

  const allowedMembers = (properties as Record<string, unknown>).allowedMembers;
  return (
    !!allowedMembers &&
    typeof allowedMembers === 'object' &&
    !Array.isArray(allowedMembers) &&
    (allowedMembers as Record<string, unknown>).const === 1
  );
}

/** Build the durable launch policy from the start request before the row exists. */
function buildStartLaunchSettings(args: {
  launchSettings?: unknown;
  holder?: unknown;
  agent?: unknown;
  model?: unknown;
  effort?: unknown;
  account?: unknown;
  carry?: unknown;
  contextSize?: unknown;
  compactionLimit?: unknown;
  headless?: unknown;
  maxAgents?: unknown;
  maxPerFleet?: unknown;
  soleMember?: boolean;
}): { settings: Record<string, unknown> | null; requested: LaunchProfile; error?: string } {
  const baseResult = goalLaunchSettingsSchema.safeParse(args.launchSettings ?? {});
  if (!baseResult.success) {
    return { settings: null, requested: {}, error: 'launchSettings is invalid' };
  }

  const profileInput = Object.fromEntries(
    Object.entries({
      agent: args.agent,
      model: args.model,
      effort: args.effort,
      account: args.account,
      carry: args.carry,
      contextSize: args.contextSize,
      compactionLimit: args.compactionLimit,
      headless: args.headless,
    }).filter(([, value]) => value !== undefined),
  );
  const profileResult = launchProfileSchema.safeParse(profileInput);
  if (!profileResult.success) {
    return { settings: null, requested: {}, error: 'launch profile is invalid' };
  }

  const settings: Record<string, unknown> = { ...baseResult.data };
  const defaults = { ...(baseResult.data.defaults ?? {}), ...profileResult.data };
  if (Object.keys(defaults).length) settings.defaults = defaults;
  if (args.holder !== undefined) settings.holder = args.holder;
  if (args.maxAgents !== undefined) settings.maxAgents = args.maxAgents;
  if (args.maxPerFleet !== undefined) settings.maxPerFleet = args.maxPerFleet;
  if (args.soleMember) {
    // The typed allowedMembers=1 contract is a hard one-agent ceiling, not just
    // a hint for skipping the standing drain member.
    settings.maxAgents = 1;
    settings.maxPerFleet = 1;
  }

  const parsed = goalLaunchSettingsSchema.safeParse(settings);
  if (!parsed.success) {
    return { settings: null, requested: {}, error: 'computed launch settings are invalid' };
  }
  return {
    settings: Object.keys(parsed.data).length ? parsed.data : null,
    requested: profileResult.data,
  };
}

export default defineTool({
  name: 'goals:start',
  needsWorkspaceTx: true,
  description:
    'Open a GOAL and spawn the GOAL-mode agent that owns it, atomically — the goal row, the agent, and the agent_modes stamp joining them, or none of them. ' +
    "{ title, killCriterion, budgetCents, body?, tripwires?, parentId?, agent?, model?, account?, headless? }. Returns the goal id AND the new agent's ownerId. " +
    'Kill criterion and ceiling are REQUIRED: GOAL mode mandates both at creation, and this is the surface that enforces it.',
  guidance: {
    when: 'Starting a NEW outcome that needs an agent to own it end-to-end — the "+ Start a goal" path. One call: goal + its agent + the join between them.',
    notWhen:
      'Recording a goal with NO agent (a goal you or an existing session will own): goals:create. Proposing one for the owner to confirm: goals:propose. Launching an agent for a non-goal task: capability:launch-agent.',
    chaining:
      'goals:start → the spawned agent orients in GOAL mode with the goal as its subject and works the portfolio itself. Watch it on the Goals board, or coord:presence by the returned ownerId.',
    seeAlso: ['goals:create (the goal row alone, no agent)', 'capability:launch-agent (an agent alone, no goal)'],
  },
  // Same gate as goals:create, deliberately, and NOT capability:terminal. The
  // privileged thing capability:terminal guards is running an ARBITRARY
  // command; this spawns one fixed, fully-validated psu launch whose every
  // argument is schema-checked. Gating it harder than goals:create would also
  // lock out the owner's own HUD, which is the only caller this exists for.
  capability: 'goals:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    title: z
      .string()
      .min(1)
      .max(500)
      .describe('the outcome, stated so its achievement is checkable ("ship a paid app")'),
    /* OPTIONAL since 2026-08-09 [owner 2026-08-09, interactive, verbatim:
       "when creating a new goal the 'kill this if' and 'ceiling' should not be
       required properties"]. Both were `.min(1)` / required before, and the
       reasoning for that — an autonomous agent with no stopping condition and
       no declared ceiling is what GOAL mode's contract exists to prevent —
       still holds as ADVICE. It just is not the owner's to be blocked by at
       creation time: the surface that mandated it was the only way to record a
       goal at all, so the mandate became "you may not start a goal until you
       can phrase its kill criterion", which is a different and worse rule.

       Absent ⇒ stored NULL, never a placeholder string or a 0 ceiling. A `$0.00`
       ceiling would read as "declared zero budget" and a "" criterion would read
       as a criterion that was written and left blank; both are lies about what
       the owner said, and the UI already renders the missing case honestly
       (`killCriterionLine` shouts, `ceilingLine` says "no ceiling set"). */
    killCriterion: z
      .string()
      .max(2000)
      .optional()
      .describe(
        'OPTIONAL — the written condition under which this goal is abandoned. Strongly advised: a goal with no kill criterion runs until somebody notices. Omitted ⇒ stored NULL and the agent is told none was set.',
      ),
    budgetCents: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'OPTIONAL — the declared spend ceiling in cents, the number actuals are reported against. Omitted ⇒ stored NULL (no ceiling declared), NOT 0.',
      ),
    /* work-on-everything-goal-2026-08-23 P-004. Omitted ⇒ the ceiling is per
       goal LIFETIME (unchanged for every existing caller). Independent of
       `standing` on purpose: the window is a property of the CEILING. */
    budgetWindowSec: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "OPTIONAL — the denominator for budgetCents, in seconds (e.g. 604800 = weekly). Omitted ⇒ the ceiling is for the goal's LIFETIME. Strongly advised WITH standing:true: a standing goal's lifetime spend crosses any finite ceiling eventually, so a lifetime ceiling on one is really a scheduled auto-kill.",
      ),
    /* work-on-everything-goal-2026-08-23 P-001. Default false, and the DEFAULT
       is the honest one for every caller that has no opinion: a goal is an
       outcome unless somebody says otherwise. Only the goal-package start door
       (P-017) passes true. */
    standing: z
      .boolean()
      .optional()
      .describe(
        'OPTIONAL, default false — mark this a STANDING goal: an ongoing duty with no checkable outcome, which ends only on owner stop or a tripwire. Changes what the agent is told about stopping; does NOT relax the tripwire or spend rails.',
      ),
    holder: goalHolderPolicySchema
      .optional()
      .describe(
        'REQUIRED unless you opt out: does this goal need a LIVE holder to count as active, and what happens when it loses one. ' +
          "{ requireLive: true } for a goal a session owns — the case this tool creates, since it spawns that session — so it stops reading 'active' when nobody holds it. " +
          "{ requireLive: false } for a goal driven by routines rather than a held session. onLoss defaults to 'deactivate'; 'respawn' is opt-in per goal. " +
          'Omitting this entirely is refused: the goal would inherit the live-holder requirement without anyone having chosen it.',
      ),
    body: z.string().max(20000).optional().describe('the full statement: what winning looks like, scope, constraints'),
    tripwires: z
      .array(TripwireSchema)
      .max(12)
      .optional()
      .describe('structured form of the kill criterion — renders as live bars instead of prose nobody re-checks'),
    parentId: z.string().min(1).optional().describe('parent goal id, for a sub-goal'),
    blockedBy: z
      .array(z.string().min(1).max(200))
      .max(20)
      .optional()
      .describe(
        'Prerequisite refs (goal ids / bare WI-/EI- issue ids) this goal is blocked by. NOTE: goals:start spawns the owning agent NOW — a goal whose prerequisites are unsatisfied is usually better filed as a STUB via goals:create { blockedBy } and armed at activation (stub-then-arm, goal-dag-shared-substrate-2026-08-18 D-004). Refs must resolve; the goal graph must stay acyclic.',
      ),
    startBlocked: z
      .boolean()
      .optional()
      .describe(
        'Acknowledge starting DESPITE unsatisfied blockedBy prerequisites. The activation gate (goal-dag-shared-substrate-2026-08-18 P-004) warn-refuses ONCE without it; passing true overrides and records start_blocked_override on the result. Pair with startBlockedReason.',
      ),
    startBlockedReason: z
      .string()
      .max(2000)
      .optional()
      .describe(
        'Why starting despite unsatisfied blockers is right anyway — recorded verbatim as start_blocked_override.',
      ),
    harness: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Harness slug to file the goal under and bootstrap the agent in. Required when the caller context is wildcard/unset.',
      ),
    mcpTarget: z
      .enum(['stable', 'spawn-host'])
      .optional()
      .describe(
        "OPTIONAL, default stable — 'spawn-host' binds this goal holder's bootstrap and MCP to the operator handling this start (for a bounded current-build A/B check). The staging host may restart; ordinary long-lived holders use the stable proxy.",
      ),
    agent: z.string().max(40).optional().describe("Which backend to launch (default 'claude')."),
    model: z.string().max(80).optional().describe('Model override for the spawned agent.'),
    account: z
      .string()
      .max(80)
      .optional()
      .describe(
        "Account routing: 'default' (system credential, the default), 'auto' (gateway-routed with failover), or a pool account id.",
      ),
    effort: z.string().min(1).max(40).optional().describe('Reasoning effort for the spawned agent.'),
    carry: z.enum(['warm', 'cold']).optional().describe('Warm/cold auto-mode carry for the spawned agent.'),
    contextSize: z.enum(['trimmed', 'steward']).optional().describe('Initial tool-surface context size.'),
    compactionLimit: z
      .number()
      .int()
      .min(50_000)
      .max(2_000_000)
      .optional()
      .describe('Soft compaction limit in tokens for the spawned agent.'),
    maxAgents: z
      .union([z.number().int().positive().max(1000), z.literal('unlimited')])
      .nullable()
      .optional()
      .describe('Per-goal concurrent-agent ceiling persisted in launch_settings.'),
    maxPerFleet: z
      .union([z.number().int().positive().max(1000), z.literal('unlimited')])
      .nullable()
      .optional()
      .describe('Per-fleet concurrent-agent ceiling persisted in launch_settings.'),
    launchSettings: goalLaunchSettingsSchema
      .nullable()
      .optional()
      .describe('Validated launch profile and ceilings to persist before spawning.'),
    headless: z
      .boolean()
      .optional()
      .describe('Launch with NO desktop window (still registers presence and stays injectable).'),
    /* work-on-everything-goal-2026-08-23 P-021 (migration 927): a goal's typed
       argument list + declared product, mirroring plans' 714/908 pair. The
       start door is one of the two declared surfaces (the other is the P-006
       package format, which stamps these at install/start). */
    inputSchema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "OPTIONAL — the goal's own JSON Schema for its start-time inputs (P-021). `required: [...]` is what the start gate enforces; must ajv-compile (refused otherwise, so the gate is never left unable to check). Omitted ⇒ the goal declares no inputs.",
      ),
    outputSchema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "OPTIONAL — the goal's own JSON Schema for what it PRODUCES, reported at wind-down (P-021). Disposition 'achieved' requires every declared output filled; 'killed' tolerates absence. Must ajv-compile. Omitted ⇒ no declared outputs.",
      ),
    inputs: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'OPTIONAL — the values this goal is STARTED with, validated against inputSchema (a missing required field refuses the start). Allowed without a schema (carried unvalidated).',
      ),
    propertySchema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "OPTIONAL — typed property DECLARATIONS (P-023): name → { datatype, default?, editable_by: 'owner'|'agent'|'both' }. Each datatype must resolve in datatype_registry; defaults are validated against the datatype's payload_schema. VALUES are written later, only via goals:set-property.",
      ),
  }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : activeWorkspaceId();
    if (!workspaceId) {
      return err('No concrete workspace in scope — a goal cannot be filed workspace-less.');
    }
    const installSlug = args.harness?.trim() || (ctx.harnessSlug && ctx.harnessSlug !== '*' ? ctx.harnessSlug : null);
    if (!installSlug) {
      return err('No harness in scope — goals are filed against an install_slug. Pass `harness`.');
    }
    await assertGoalWriteAuthorityForCaller(ctx, workspaceId, ctx.tx as never);

    // EI-20049757392342975: the SAME refusal `goals:propose`, `goals:update` and
    // `goals:create` apply. This door was the one that mattered most and the one
    // the filing missed: it is what the owner's own HUD composer posts to
    // (GoalComposer → postGoalStart → here), and it lives in operator-core
    // rather than agent-mcp/tools/goals/, so an audit of "the goals tools"
    // does not list it. Nothing on that whole path enforced the rule — which is
    // also why GoalComposer.tsx renders an `errors.killCriterion` slot that
    // `validateGoalDraft` can never populate.
    //
    // Checked BEFORE the ownerId pre-pin and the row write, so a refusal costs
    // no minted identity and no rollback. Blank/absent still passes: a goal may
    // have no criterion at all (WI-37604, owner-directed 2026-08-09) — that
    // overrule is about PRESENCE, this rule is about quality GIVEN presence.
    const criterionArg = args.killCriterion?.trim();
    if (criterionArg) {
      const problem = killCriterionProblem(criterionArg);
      if (problem) return err(problem);
    }

    // ── The holder-policy write boundary (goal-live-holder-guarantee-2026-08-18
    // P-003, D-008) ──────────────────────────────────────────────────────────
    // Refused HERE and not only at `goals:create` because this tool writes its
    // row through the same `insertGoalRow` and would otherwise be the door that
    // installs what the other refuses — the second-copy drift `kill-criterion`'s
    // header describes, which this door has already been on the wrong side of
    // once (it reaches the shared insert directly).
    //
    // ── P-021: IO-schema compilability + typed-input readiness ─────────────
    // Same placement as the criterion + holder checks above: before the
    // ownerId pre-pin and the row write, so a refusal costs no minted identity
    // and no rollback. Compilability is a DECLARE-time gate (714's rule): a
    // schema that cannot compile could not be checked later, and "could not
    // check" must never render as "nothing was required/promised".
    if (args.inputSchema && !isCompilableSchema(args.inputSchema)) {
      return err(
        'inputSchema is not a compilable JSON Schema — refused at declare time so the start gate is never left unable to check it.',
      );
    }
    if (args.outputSchema && !isCompilableSchema(args.outputSchema)) {
      return err(
        'outputSchema is not a compilable JSON Schema — refused at declare time so the wind-down gate is never left unable to check it.',
      );
    }
    const inputsVerdict = evaluateGoalStartInputs(args.inputSchema ?? null, args.inputs ?? null);
    if (!inputsVerdict.ready) {
      return err(`inputs refused (${inputsVerdict.code}): ${inputsVerdict.hint}`);
    }
    const soleMemberGoal = declaresSoleMemberContract(args.inputSchema, inputsVerdict.inputs);
    const launchSettingsResult = buildStartLaunchSettings({
      launchSettings: args.launchSettings,
      holder: args.holder,
      agent: args.agent,
      model: args.model,
      effort: args.effort,
      account: args.account,
      carry: args.carry,
      contextSize: args.contextSize,
      compactionLimit: args.compactionLimit,
      headless: args.headless,
      maxAgents: args.maxAgents,
      maxPerFleet: args.maxPerFleet,
      soleMember: soleMemberGoal,
    });
    if (launchSettingsResult.error) return err(launchSettingsResult.error);
    const launchSettings = launchSettingsResult.settings;
    const holderProblem = goalHolderPolicyProblem(launchSettings);
    if (holderProblem) return err(holderProblem);
    // ── P-023: typed property DECLARATIONS — validated-on-declare (datatype
    // refs must resolve in datatype_registry; defaults must satisfy their
    // datatype's payload_schema), same placement as the IO-schema gates above.
    if (args.propertySchema) {
      const propCheck = await validatePropertySchemaDeclaration(ctx.tx as never, workspaceId, args.propertySchema);
      if (!propCheck.ok) return err(`propertySchema refused: ${propCheck.issues.join('; ')}`);
    }

    let callerOwnerId: string | null = null;
    try {
      callerOwnerId = resolveAgentIdentity(ctx).ownerId;
    } catch {
      callerOwnerId = null;
    }

    const id = goalId(args.title);
    // PRE-PIN the agent's coord identity so the mode stamp below can name it
    // before it exists. Same minting `/api/adv/launch-su` does.
    const ownerId = `su-${randomUUID()}`;

    // Seed the canonical `worklist` declaration so an ad-hoc goal is
    // indistinguishable from a packaged one to the placement gate, which reads
    // `properties->'worklist'->'value'` on EVERY goal. Without this the row
    // lands with property_schema '{}' and `goals:set-property` refuses
    // `unknown_property: worklist` forever (EI-23745110935212173).
    const seededPropertySchema = withCanonicalWorklistDeclaration(args.propertySchema ?? null);

    // ── 1. the goal row ───────────────────────────────────────────────────
    try {
      await insertGoalRow(ctx.tx, {
        id,
        installSlug,
        workspaceId,
        title: args.title,
        body: args.body ?? null,
        parentId: args.parentId ?? null,
        budgetCents: args.budgetCents,
        status: 'active',
        standing: args.standing ?? false,
        budgetWindowSec: args.budgetWindowSec ?? null,
        killCriterion: args.killCriterion,
        tripwires: args.tripwires ?? null,
        metadata: { startedBy: callerOwnerId ?? 'operator-ui', agentOwnerId: ownerId },
        launchSettings,
        inputSchema: args.inputSchema ?? null,
        inputs: inputsVerdict.inputs,
        outputSchema: args.outputSchema ?? null,
        propertySchema: args.propertySchema ?? null,
      });
    } catch (e) {
      return err(`Could not open the goal: ${(e as Error)?.message ?? e}`);
    }

    // ── 1.5 blocked-by edges (goal-dag-shared-substrate-2026-08-18 P-002) ──
    // Validate-and-write BEFORE the mode stamp: a refused set (unresolvable
    // ref, cycle) unwinds only the goal row — cheap, nothing spawned. This door
    // REFUSES rather than degrading (unlike goals:create) because it is about
    // to spawn an agent against exactly this record: silently dropping the
    // prerequisites the caller declared would start an agent on a premise the
    // caller did not state.
    if (args.blockedBy?.length) {
      const applied = await applyGoalBlockedBy(ctx.tx, {
        workspaceId,
        goalId: id,
        refs: args.blockedBy,
        createdBy: callerOwnerId ?? null,
      });
      if (!applied.ok) {
        await deleteGoalRow(ctx.tx, { id, workspaceId }).catch(() => {});
        return err(`blockedBy refused (nothing spawned, goal rolled back): ${applied.problem}`);
      }
    }

    // ── 1.75 the activation gate (P-004, D-003/D-004) ─────────────────────
    // Readiness is an ACTIVATION gate, never dispatch (D-003): this door is
    // about to spawn an agent to pursue the goal RIGHT NOW, so unsatisfied
    // prerequisites get a warn-refuse-ONCE — retry with startBlocked (+ a
    // reason) if starting blocked is deliberate, or file the goal as a STUB
    // and arm it at activation instead (goals:create { blockedBy },
    // stub-then-arm, D-004). Gated on args.blockedBy: the goal row was minted
    // moments ago, so the edges just applied are the only edges it can have.
    let startBlockedOverride: string | null = null;
    if (args.blockedBy?.length) {
      const readiness = await readGoalReadiness(ctx.tx, workspaceId, id);
      if (!readiness.actionable) {
        const unsatisfied = readiness.blockers
          .filter((b) => b.verdict !== 'satisfied')
          .map((b) => `${b.ref} (${b.kind}/${b.status ?? 'absent'}/${b.verdict})`)
          .join(', ');
        if (!args.startBlocked) {
          await replaceGoalBlockedBy(ctx.tx, { workspaceId, goalId: id, blockers: [] }).catch(() => {});
          await deleteGoalRow(ctx.tx, { id, workspaceId }).catch(() => {});
          return err(
            `Refusing to start: unsatisfied blocker(s) ${unsatisfied}. Nothing was spawned and the goal was rolled back. ` +
              'Either file it as a STUB and arm it when its prerequisites clear — goals:create { blockedBy } ' +
              '(stub-then-arm, goal-dag-shared-substrate-2026-08-18 D-004) — or, if starting NOW despite the ' +
              'prerequisites is deliberate, retry with startBlocked: true (+ startBlockedReason).',
          );
        }
        startBlockedOverride =
          args.startBlockedReason?.trim() || `started despite unsatisfied blocker(s): ${unsatisfied}`;
      }
    }

    // ── 2. the join: this agent, in GOAL mode, on THIS goal ───────────────
    // Written BEFORE the spawn on purpose — see the header. `subject` is the
    // marker the sessions pane filters on and the Goals board pairs by
    // (goals-tab-improvement-2026-08-09 D-007); without it the session is an
    // ordinary agent that happens to be in goal mode.
    const modeRes = await setMode({
      workspaceId,
      ownerId,
      modeId: 'goal',
      enabled: true,
      reason: `owns goal ${id} — ${args.title.slice(0, 120)}`,
      setBy: callerOwnerId ?? 'operator-ui',
      subject: id,
    });
    if (!modeRes.ok) {
      // Edges before the row — same rule as the main rollback below: a deleted
      // goal must not leave dangling blocked-by edges (P-004 closes the gap
      // P-002 left on this early-failure path).
      await replaceGoalBlockedBy(ctx.tx, { workspaceId, goalId: id, blockers: [] }).catch(() => {});
      await deleteGoalRow(ctx.tx, { id, workspaceId }).catch(() => {});
      return err(
        `Could not put the new agent in GOAL mode (${modeRes.error ?? 'unknown error'}), so nothing was spawned and the goal was rolled back. ` +
          'A GOAL-mode agent that does not know its goal is the failure this tool exists to prevent.',
      );
    }

    // ── 2.5 the standing drain fleet (P-001, goal-mode-design-intent-hardening D-005) ──
    // The GOAL contract requires ONE STANDING DRAIN FLEET PER GOAL. Minting it
    // HERE — with the goal, before the agent exists — makes "the agent cannot
    // forget it" structural instead of prose; the goal-drain-fleet watchdog
    // demotes to backstop. Fail-SOFT: a goal start must not die on fleet
    // plumbing, and a drainless goal is exactly what the watchdog reports.
    // (Rows only at this point — the lane's headless member is spawned after
    // the goal agent below, so the rollback never has to unwind a process.)
    let drainFleet: { slug: string; specRevision: number | null } | null = null;
    const drainWarnings: string[] = [];
    // The goal agent is already the one actor for an explicitly typed
    // `allowedMembers: 1` contract. Do not mint a second actor's lane for it.
    if (!soleMemberGoal && (await drainFleetAutoMintEnabled())) {
      try {
        const minted = await mintDrainFleetForGoal({
          workspaceId,
          goalId: id,
          goalTitle: args.title,
          agentOwnerId: ownerId,
          goalTx: ctx.tx,
        });
        drainFleet = { slug: minted.fleetSlug, specRevision: minted.specRevision };
      } catch (e) {
        drainWarnings.push(
          `drain-fleet auto-mint failed (goal started anyway; the goal-drain-fleet watchdog keeps reporting until a fleet exists): ${(e as Error)?.message ?? e}`,
        );
      }
    }

    // ── 3. the agent ──────────────────────────────────────────────────────
    const rollback = async () => {
      // P-001: the drain-fleet mint is compensable rows (registry + claim spec) —
      // tear them down with the goal, or the fleet strands as a registry row whose
      // goal no longer exists. The metadata.drainFleet stamp dies with the goal row.
      if (drainFleet) {
        await teardownDrainFleetMint({ workspaceId, fleetSlug: drainFleet.slug }).catch(() => {});
      }
      /* D-003: entering GOAL also wrote the modes it IMPLIES (auto, ideate), so
         a rollback that only clears 'goal' strands them on an ownerId that was
         never spawned. Clear exactly what the cascade SET — never a mode it
         merely found already there, which on a fresh ownerId is impossible but
         on a re-used one would revoke a posture this call did not create. */
      for (const modeId of ['goal', ...(modeRes.implied ?? []).filter((i) => i.status === 'set').map((i) => i.mode)]) {
        await setMode({
          workspaceId,
          ownerId,
          modeId,
          enabled: false,
          reason: 'launch failed — rolling back',
          setBy: callerOwnerId ?? 'operator-ui',
        }).catch(() => {});
      }
      // Edges before the row: a deleted goal must not leave dangling blocked-by
      // edges (they would be invisible absent-blocker no-ops, but they pollute
      // the workspace edge read every consumer folds).
      await replaceGoalBlockedBy(ctx.tx, { workspaceId, goalId: id, blockers: [] }).catch(() => {});
      await deleteGoalRow(ctx.tx, { id, workspaceId }).catch(() => {});
    };

    let base;
    try {
      const spawnHostOperatorBaseUrl = resolveSpawnHostOperatorBaseUrl();
      base = await buildConsoleEnvelope({
        workspaceId,
        slug: installSlug,
        operatorBaseUrl: spawnHostOperatorBaseUrl,
        ...(args.mcpTarget === 'spawn-host' ? { agentMcpBaseUrl: spawnHostOperatorBaseUrl } : {}),
        // A launched AGENT is an MCP-connected console — it needs the
        // superuser .mcp.json (same call capability:launch-agent makes).
        skipMcpJson: false,
      });
    } catch (e) {
      await rollback();
      return err(`Could not prepare the launch (nothing spawned, goal rolled back): ${(e as Error)?.message ?? e}`);
    }

    // P-004/D-009: the goal's own launch settings apply to the goal's own agent.
    // This door uses the EXPLICIT-goal resolver rather than the launcher-derived
    // one because at this moment the goal is the SUBJECT of the launch and not
    // yet anybody's inherited context — resolveGoalContext(caller) correctly
    // returns null here. Fresh goals normally carry no settings yet (this is
    // where they are born), so the fold is usually a no-op; it matters when an
    // owner has edited the settings and the goal agent is being relaunched.
    const goalLaunch = await resolveGoalLaunchForGoal({
      workspaceId,
      goalId: id,
      goalRole: 'goal',
      requested: launchSettingsResult.requested,
      sql: ctx.tx as never,
    });
    if (goalLaunch.refusal) {
      await rollback();
      return err(goalLaunch.refusal.message);
    }
    const inputRefusal = goalHolderInputRefusal(goalLaunch.holderReadiness);
    if (inputRefusal) {
      await rollback();
      return err(inputRefusal);
    }

    let command: string;
    try {
      command = buildAgentLaunchCommand({
        mode: 'fresh',
        agent: goalLaunch.effective.agent ?? args.agent ?? 'claude',
        harness: installSlug,
        ownerId,
        goalBootstrapSubject: id,
        account: goalLaunch.effective.account ?? args.account ?? null,
        model: goalLaunch.effective.model ?? args.model ?? null,
        effort: goalLaunch.effective.effort ?? null,
        carry: goalLaunch.effective.carry ?? null,
        contextSize: goalLaunch.effective.contextSize ?? null,
        compactionLimit: goalLaunch.effective.compactionLimit ?? null,
        headless: goalLaunch.effective.headless ?? !!args.headless,
      });
    } catch (e) {
      await rollback();
      return err(
        `Could not build the launch command (nothing spawned, goal rolled back): ${(e as Error)?.message ?? e}`,
      );
    }
    command = injectLaunchedByArg(command, callerOwnerId).command;

    // The brief rides the ENV, never a --kickoff= value: free-form text inside
    // the console greeting one-liner gets double-single-quoted and breaks the
    // shell. psu reads PAPERCUSP_KICKOFF_PROMPT as the fresh CLI's first turn.
    // The goal-history compiler owns the plan/source read graph. Loading it at
    // module evaluation makes every unrelated goal/tool bootstrap inherit that
    // graph and strands intentionally narrow plan-source mocks. Goal creation
    // consumes it only here, immediately before the holder brief is rendered.
    const { readGoalHistoryContext } = await import('../../prior-attempt-context');
    const history = await readGoalHistoryContext(id);
    // R-4 / D-032: the arm is applied inside buildGoalKickoffBrief; the
    // receipt's portfolio contribution must match what the kickoff carried.
    const behaviorArm = resolveGoalBehaviorArm(launchSettings);
    const portfolio = goalArmWithholdsBrief(behaviorArm) ? null : goalLaunch.goalBrief?.portfolio ?? null;
    const portfolioText = portfolio ? renderGoalPortfolioBrief(portfolio) : null;
    const kickoff = buildGoalKickoffBrief({
      behaviorArm,
      goalId: id,
      title: args.title,
      killCriterion: args.killCriterion,
      budgetCents: args.budgetCents,
      body: args.body ?? null,
      standing: args.standing ?? false,
      budgetWindowSec: args.budgetWindowSec ?? null,
      portfolio,
      renderedPortfolio: portfolioText,
      history,
    });
    const env = {
      ...base.env,
      PAPERCUSP_KICKOFF_PROMPT: kickoff,
    };
    const label = `goal · ${args.title.slice(0, 40)}`;

    const spawned = args.headless
      ? await spawnHeadless({
          envelope: { ...base, env, greetingCmd: command, cwd: base.cwd },
          label: `${label} (headless)`,
          logDir: join(papercuspPathForWorkspace(workspaceId), 'fleet-logs'),
          coordOwnerId: ownerId,
        })
      : await spawnConsole({
          envelope: { ...base, env, greetingCmd: command, cwd: base.cwd },
          label,
          writeMcpJson: false,
          allowDesktopBridge: true,
        });

    if (spawned.status !== 'ok') {
      await rollback();
      const detail = 'error' in spawned && spawned.error ? spawned.error : 'the spawn reported no detail';
      return err(
        `The goal's agent failed to launch (${detail}). The goal row and its mode stamp were ROLLED BACK — ` +
          'nothing was left behind, so retrying is safe.',
      );
    }

    await recordGoalLaunchIdentityBinding({
      goalId: id, ownerId, workspaceId, kickoff, portfolio: portfolioText, modeState: modeRes, behaviorArm,
    }, ctx.metadata);

    // ── 3.5 the drain lane's delegated leader and puller ────────────────
    // A lane needs a separate LEADER before any MEMBER. Spawned LAST on purpose: every
    // earlier side effect is compensable, a process is not — so it starts only
    // once the goal is definitely keeping its agent. `--fleet` is what makes
    // bootstrap-su stamp the membership fact getClaimSpec's fleet-inheritance
    // resolves through (and what triggers the launcher's fleet auto-kickoff, so
    // the member pulls instead of parking). Fail-soft: a memberless fleet reads
    // as 'drain-fleet-dead' to the watchdog, which is the designed backstop —
    // never a reason to unwind a successfully-started goal.
    let drainLeader: { ownerId: string; pid: number | null; coupled: boolean } | null = null;
    let drainMember: { pid: number | null; terminal: string } | null = null;
    if (drainFleet) {
      try {
        const leaderLaunch = await resolveGoalLaunchForGoal({
          workspaceId,
          goalId: id,
          goalRole: 'drain-fleet-leader',
          fleetSlug: drainFleet.slug,
          launcherOwnerId: ownerId,
          requested: {},
          sql: ctx.tx as never,
        });
        if (leaderLaunch.refusal) throw new Error(`leader launch policy refused: ${leaderLaunch.refusal.message}`);
        const leaderOwnerId = `su-${randomUUID()}`;
        const leaderMode = await setMode({
          workspaceId,
          ownerId: leaderOwnerId,
          modeId: 'auto',
          enabled: true,
          reason: `delegated leader of goal ${id} drain fleet ${drainFleet.slug}`,
          setBy: callerOwnerId ?? 'operator-ui',
        });
        if (!leaderMode.ok) throw new Error(`leader AUTO mode could not be stamped: ${leaderMode.error ?? 'unknown'}`);
        let leaderCmd = buildAgentLaunchCommand({
          mode: 'fresh',
          agent: leaderLaunch.effective.agent ?? args.agent ?? 'claude',
          harness: installSlug,
          ownerId: leaderOwnerId,
          account: leaderLaunch.effective.account ?? args.account ?? null,
          model: leaderLaunch.effective.model ?? args.model ?? null,
          effort: leaderLaunch.effective.effort ?? args.effort ?? null,
          carry: leaderLaunch.effective.carry ?? args.carry ?? null,
          contextSize: leaderLaunch.effective.contextSize ?? args.contextSize ?? null,
          compactionLimit: leaderLaunch.effective.compactionLimit ?? args.compactionLimit ?? null,
          headless: true,
        });
        leaderCmd = injectFleetArg(leaderCmd, drainFleet.slug).command;
        leaderCmd = injectLaunchedByArg(leaderCmd, ownerId).command;
        const leader = await spawnHeadless({
          envelope: {
            ...base,
            env: {
              ...base.env,
              PAPERCUSP_KICKOFF_PROMPT:
                `You are the delegated leader of drain fleet ${drainFleet.slug} for goal ${id}. ` +
                `The GOAL holder ${ownerId} owns portfolio decisions. Verify fleet:status names you ` +
                `as leader before steering this fleet; supervise its workers and keep their ` +
                `goal-scoped lane progressing. If a concurrent leader won, stand down.`,
            },
            greetingCmd: leaderCmd,
            cwd: base.cwd,
          },
          label: `goal-drain leader · ${args.title.slice(0, 34)}`,
          logDir: join(papercuspPathForWorkspace(workspaceId), 'fleet-logs'),
          coordOwnerId: leaderOwnerId,
        });
        if (leader.status !== 'ok') {
          await setMode({ workspaceId, ownerId: leaderOwnerId, modeId: 'auto', enabled: false,
            reason: 'delegated drain leader failed to open', setBy: callerOwnerId ?? 'operator-ui' }).catch(() => {});
          throw new Error(`leader failed to launch: ${'error' in leader ? leader.error : 'no detail'}`);
        }
        const registered = await registerGoalDrainFleetLeader({
          workspaceId, goalId: id, fleetSlug: drainFleet.slug, holderOwnerId: ownerId,
          leaderOwnerId, declaredBy: callerOwnerId ?? 'operator-ui', expectedLeaderOwnerId: null,
        });
        if (!registered.registered) throw new Error(`opened leader could not be registered: ${registered.warning}`);
        drainLeader = { ownerId: leaderOwnerId, pid: leader.pid ?? null, coupled: registered.coupled };
        if (registered.warning) drainWarnings.push(`drain-fleet leader partial setup: ${registered.warning}`);

        const memberLaunch = await resolveGoalLaunchForGoal({
          workspaceId, goalId: id, goalRole: 'drain-fleet-member', fleetSlug: drainFleet.slug,
          launcherOwnerId: ownerId, requested: {}, sql: ctx.tx as never,
        });
        if (memberLaunch.refusal) throw new Error(`member launch policy refused: ${memberLaunch.refusal.message}`);
        let memberCmd = buildAgentLaunchCommand({
          mode: 'fresh',
          agent: memberLaunch.effective.agent ?? args.agent ?? 'claude',
          harness: installSlug,
          account: memberLaunch.effective.account ?? args.account ?? null,
          model: memberLaunch.effective.model ?? args.model ?? null,
          effort: memberLaunch.effective.effort ?? args.effort ?? null,
          carry: memberLaunch.effective.carry ?? args.carry ?? null,
          contextSize: memberLaunch.effective.contextSize ?? args.contextSize ?? null,
          compactionLimit: memberLaunch.effective.compactionLimit ?? args.compactionLimit ?? null,
          headless: true,
        });
        memberCmd = injectFleetArg(memberCmd, drainFleet.slug).command;
        memberCmd = injectLaunchedByArg(memberCmd, ownerId).command;
        // Deliberately `base.env`, never the goal agent's `env`: the kickoff
        // brief names ONE owner of the goal, and a drain bee that also received
        // it would believe itself that owner.
        const member = await spawnHeadless({
          envelope: { ...base, greetingCmd: memberCmd, cwd: base.cwd },
          label: `goal-drain · ${args.title.slice(0, 40)}`,
          logDir: join(papercuspPathForWorkspace(workspaceId), 'fleet-logs'),
        });
        if (member.status === 'ok') {
          drainMember = { pid: member.pid ?? null, terminal: member.terminal };
        } else {
          const detail = 'error' in member && member.error ? member.error : 'no detail';
          drainWarnings.push(
            `drain-fleet member failed to launch (${detail}) — the fleet and its goal-scoped lane exist; ` +
              'the watchdog reports it dead until a member joins (fleet:join / capability:terminal with --fleet).',
          );
        }
      } catch (e) {
        drainWarnings.push(`drain-fleet member launch threw: ${(e as Error)?.message ?? e}`);
      }
    }

    return {
      data: {
        id,
        title: args.title,
        status: 'active',
        kill_criterion: args.killCriterion,
        budget_cents: args.budgetCents,
        parent_id: args.parentId ?? null,
        tripwires: args.tripwires ?? null,
        workspace_id: workspaceId,
        install_slug: installSlug,
        // The agent that owns it, and the handle to open its chat, poll
        // coord:presence, or pair it on the Goals board — it is pinned before
        // the spawn, so it is stable from launch onward.
        //
        // ⚠ NOT because "psu records the adv_sessions row asynchronously once it
        // boots" — that was the old rationale here and it is false since WI-6376:
        // launch-su records a STARTING row for every launch carrying an ownerId,
        // and WI-37743 moved that insert ABOVE the spawn. The reason to prefer the
        // owner id is that it needs no database round-trip, not that the row is
        // missing. See LaunchAgentResult.advSessionId in launch-agent.ts.
        agent_owner_id: ownerId,
        agent_terminal: spawned.terminal,
        agent_pid: spawned.pid ?? null,
        headless: !!args.headless,
        // P-001: the auto-minted standing drain fleet (also declared on the goal
        // row as metadata.drainFleet — the watchdog's surface). Null means the
        // mint was skipped (flag off) or failed; see `warning`.
        drain_fleet: drainFleet?.slug ?? null,
        drain_leader_owner_id: drainLeader?.ownerId ?? null,
        drain_leader_pid: drainLeader?.pid ?? null,
        drain_leader_coupled: drainLeader?.coupled ?? false,
        drain_member_pid: drainMember?.pid ?? null,
        // P-004: present ONLY when the caller overrode the activation gate —
        // the audit trail that this goal started with unsatisfied prerequisites.
        ...(startBlockedOverride ? { start_blocked_override: startBlockedOverride } : {}),
        ...(drainWarnings.length ? { warning: drainWarnings.join('\n') } : {}),
      },
    };
  },
});
