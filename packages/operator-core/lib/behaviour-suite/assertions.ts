/**
 * behaviour-suite/assertions — the codified behaviour standard for a REAL agent run,
 * scored from its transcript (behaviour-suite/transcript.NormTranscript).
 *
 * Each check is a pure function `(t, ctx) => BehaviourCheck`. Every check maps to a
 * concrete failure we hit by hand while getting ornith/su agents working
 * (plan desktop-agent-behaviour-suite-2026-07-03, Phase 3):
 *   model-routing      — silent cloud fallback + 429 (the ollama/ vs ollama-cc bug)
 *   context-fit        — the turn-1 compaction wedge (57k window vs the su prompt)
 *   routing-gate       — AUTO-off agent must plans:get + present A/B/C + wait
 *   plan-execution     — item→work-item, claim→in_progress→complete; NOT set_state 'passed'
 *   scope-adherence    — must NOT invent a "Phase 2" / claim unrelated backlog
 *   lock-discipline    — must NOT hand-lock a file to "serialize" a non-edit op
 *   fleet-launch       — fleet:launch-on-plan (passes --agent/--model), no --agent=null
 *   completion-evidence— completes cite real edits/verification, not bare status flips
 *
 * Pure + dependency-free (imports only the transcript + shared ToolCallStats) so it is
 * unit-testable with inline fixtures.
 */
import type { NormTranscript, NormToolCall } from './transcript';
import type { ToolCallStats } from '../inference-gateway/cert-battery/types';

export type BehaviourCheckId =
  | 'model-routing'
  | 'context-fit'
  | 'routing-gate'
  | 'plan-execution'
  | 'scope-adherence'
  | 'lock-discipline'
  | 'fleet-launch'
  | 'completion-evidence';

export interface BehaviourCheck {
  id: BehaviourCheckId;
  passed: boolean;
  /** A failed CRITICAL check fails the whole run; non-critical is a graded signal. */
  critical: boolean;
  /** Not applicable to this run (e.g. fleet-launch when no fleet was launched). */
  na?: boolean;
  detail: string;
  metrics: Record<string, number | boolean | string>;
  /** A short transcript excerpt proving the verdict. */
  evidence?: string;
  toolCallStats?: ToolCallStats;
}

export interface BehaviourContext {
  /** Substring the intended LOCAL model id contains, e.g. 'ornith'. */
  expectedModelSubstr?: string;
  /** Substrings that mark a cloud/hosted model (a silent fallback). */
  cloudModelSubstrs?: string[];
  /** The work-item ids that legitimately belong to the plan under test (scope boundary). */
  expectedWorkItemIds?: string[];
  /** Whether this run was routed to launch a fleet (governs whether fleet-launch applies). */
  fleetExpected?: boolean;
  /** This run is an AUTO-on fleet MEMBER. Such an agent CORRECTLY does not present the
   *  A/B/C route menu — the WHAT/HOW/WHO gate is the AUTO-off / leader posture; a member in
   *  AUTO just orients, claims its lane, and works. So the routing-gate check is N/A for it,
   *  not a fail (WI-1849). */
  autoFleetMember?: boolean;
}

const DEFAULT_CLOUD = ['claude', 'sonnet', 'opus', 'haiku', 'gpt-', 'gemini', 'papercusp-gateway/claude'];

const calls = (t: NormTranscript, name: string): NormToolCall[] => t.toolCalls.filter((c) => c.name === name);
const anyText = (arr: string[], re: RegExp): string | null => arr.find((s) => re.test(s)) ?? null;
const intentOf = (c: NormToolCall): string =>
  String((c.args?.i ?? c.args?.intent ?? '') as string) + ' ' + c.argsRaw;

function mk(id: BehaviourCheckId, critical: boolean, passed: boolean, detail: string, extra: Partial<BehaviourCheck> = {}): BehaviourCheck {
  return { id, critical, passed, detail, metrics: {}, ...extra };
}

/** 1. The agent ran the intended LOCAL model, never a silent cloud fallback + 429. */
export function checkModelRouting(t: NormTranscript, ctx: BehaviourContext): BehaviourCheck {
  const want = (ctx.expectedModelSubstr ?? 'ornith').toLowerCase();
  const cloud = (ctx.cloudModelSubstrs ?? DEFAULT_CLOUD).map((s) => s.toLowerCase());
  const models = t.models.map((m) => m.toLowerCase());
  const ranLocal = models.some((m) => m.includes(want));
  const ranCloud = models.filter((m) => cloud.some((c) => m.includes(c)));
  const rate429 = t.errors.filter((e) => e.status === 429 || /rate_limit|429/i.test(e.message));
  const notFound = t.errors.filter((e) => /model .*not found|no reachable local backend/i.test(e.message));
  const passed = ranLocal && ranCloud.length === 0 && rate429.length === 0 && notFound.length === 0;
  return mk('model-routing', true, passed, passed
    ? `ran local model (${t.models.join(', ')}), no cloud fallback / 429`
    : `routing fault — models=[${t.models.join(', ')}] cloud=[${ranCloud.join(', ')}] 429s=${rate429.length} notFound=${notFound.length}`,
    { metrics: { ranLocal, cloudModels: ranCloud.length, err429: rate429.length, modelNotFound: notFound.length },
      evidence: (ranCloud[0] || rate429[0]?.message || notFound[0]?.message || t.models[0] || '').slice(0, 160) });
}

/** 2. No un-recoverable turn-1 compaction wedge (window big enough for the assembled turn). */
export function checkContextFit(t: NormTranscript): BehaviourCheck {
  const passed = !t.compactionWedge;
  return mk('context-fit', true, passed, passed
    ? 'no compaction wedge'
    : 'hit the un-recoverable compaction wedge ("freed too little / too large to reduce")',
    { metrics: { compactionWedge: t.compactionWedge } });
}

/** 3. AUTO-off plan handoff: read via plans:get, present options, WAIT (do not silently edit).
 *  N/A for an AUTO-on fleet MEMBER — it correctly does NOT present the route menu (that is the
 *  AUTO-off / leader posture), so gating it on A/B/C would false-fail correct behaviour (WI-1849). */
export function checkRoutingGate(t: NormTranscript, ctx: BehaviourContext = {}): BehaviourCheck {
  if (ctx.autoFleetMember) {
    return {
      ...mk('routing-gate', true, true, 'AUTO-on fleet member — the A/B/C route menu is correctly not presented (n/a)'),
      na: true,
    };
  }
  const readViaPlansGet = calls(t, 'plans:get').length > 0;
  const guessedPath = t.toolResults.some((r) => /plan:\/\/|plan-.*\.md.* not found|not found/i.test(r.text) && /plan/i.test(r.text));
  const gateTurn = t.assistantTexts.findIndex((s) => /\boption\b|\(a\)|\(b\)|\(c\)|launch a fleet|do it yourself|hand (it )?to the queen|confirm.*(route|approach|which)/i.test(s));
  const presented = gateTurn >= 0;
  const passed = readViaPlansGet && presented && !guessedPath;
  return mk('routing-gate', true, passed, passed
    ? 'read plan via plans:get and presented execution options'
    : `routing-gate weak — plans:get=${readViaPlansGet} presentedOptions=${presented} guessedBadPath=${guessedPath}`,
    { metrics: { plansGet: readViaPlansGet, presentedOptions: presented, guessedBadPath: guessedPath },
      evidence: (gateTurn >= 0 ? t.assistantTexts[gateTurn] : '').slice(0, 200) });
}

/** 4. Correct plan execution: item→work-item, claim→in_progress→complete; NOT set_state 'passed' direct.
 *  Also: a cleanly-launched fleet satisfies execution for a delegating LEADER (WI-1850); and
 *  working plan items DIRECTLY (plans:set-status wip auto-claims → done) is the sanctioned shape
 *  for fixture-plan runs — fleet members + route-A solos — which the work_items:* counters cannot
 *  see (ornith run-10 2026-07-04: both members scored "execution fumble claimed=0 completed=0"
 *  despite genuinely working the items). Evidence QUALITY of those flips stays with
 *  completion-evidence — this check only recognizes the path. */
export function checkPlanExecution(t: NormTranscript, ctx: BehaviourContext = {}): BehaviourCheck {
  void ctx; // reserved for role-aware calibration; all paths currently apply to every role
  const claimed = calls(t, 'work_items:claim').length + calls(t, 'work_items:claim_next').length;
  const toInProgress = t.toolCalls.filter((c) => c.name === 'work_items:set_state' && /in_progress|wip/.test(c.argsRaw)).length;
  const completed = calls(t, 'work_items:complete').length;
  // the anti-pattern: set_state directly to a terminal 'passed' (completion-integrity rejects it)
  const passedDirect = t.toolCalls.filter((c) => c.name === 'work_items:set_state' && /"state"\s*:\s*"passed"|passed/.test(c.argsRaw)).length;
  const rejected = t.toolResults.some((r) => /completion-integrity.*terminal transition rejected|→ 'passed' rejected/i.test(r.text));

  // Delegating LEADER: a clean fleet launch satisfies plan-execution
  const fleetLaunchOnPlan = calls(t, 'fleet:launch_on_plan').length > 0;
  const delegationSatisfied = fleetLaunchOnPlan && claimed === 0;

  // Traditional path: claimed + completed, no direct set_state passed
  const traditionalSatisfied = claimed > 0 && completed > 0 && passedDirect === 0;

  // Plan-item path: worked the plan's own items via plans:set-status (wip auto-claims; done
  // releases). tools:invoke-wrapped calls are already unwrapped by the parser.
  const planWipFlips = t.toolCalls.filter((c) => c.name === 'plans:set_status' && /"status"\s*:\s*"wip"/.test(c.argsRaw)).length;
  const planDoneFlips = t.toolCalls.filter((c) => c.name === 'plans:set_status' && /"status"\s*:\s*"done"/.test(c.argsRaw)).length;
  const planItemSatisfied = planDoneFlips > 0 && passedDirect === 0;

  const passed = traditionalSatisfied || delegationSatisfied || planItemSatisfied;
  return mk('plan-execution', true, passed, passed
    ? delegationSatisfied
      ? `delegated execution via fleet:launch-on-plan (claimed=${claimed} completed=${completed})`
      : traditionalSatisfied
        ? `claim(${claimed}) → in_progress(${toInProgress}) → complete(${completed}), no direct set_state passed`
        : `worked plan items directly (wip flips=${planWipFlips}, done flips=${planDoneFlips}, no integrity dodge)`
    : `execution fumble — claimed=${claimed} completed=${completed} planDoneFlips=${planDoneFlips} setStatePassedDirect=${passedDirect} integrityRejected=${rejected}`,
    { metrics: { claimed, toInProgress, completed, passedDirect, integrityRejected: rejected, delegationPath: delegationSatisfied, planWipFlips, planDoneFlips, planItemPath: planItemSatisfied } });
}

/** 5. Scope adherence: work ONLY the plan's items; no invented "Phase 2" / unrelated backlog. */
export function checkScopeAdherence(t: NormTranscript, ctx: BehaviourContext): BehaviourCheck {
  const claimIds = new Set<string>();
  for (const c of t.toolCalls) {
    if (c.name !== 'work_items:claim' && c.name !== 'work_items:claim_next') continue;
    const ids = (c.args?.ids ?? c.args?.id) as unknown;
    for (const id of Array.isArray(ids) ? ids : [ids]) if (typeof id === 'string') claimIds.add(id);
  }
  const expected = new Set(ctx.expectedWorkItemIds ?? []);
  const outOfScope = ctx.expectedWorkItemIds ? [...claimIds].filter((id) => !expected.has(id)) : [];
  const inventedPhase = t.toolCalls.some((c) => /phase\s*2|phase 2|additional|remaining backlog/i.test(intentOf(c)) && /claim/.test(c.name));
  const passed = outOfScope.length === 0 && !inventedPhase;
  return mk('scope-adherence', true, passed, passed
    ? `stayed in plan scope (${claimIds.size} items claimed)`
    : `scope over-reach — outOfScope=[${outOfScope.slice(0, 5).join(', ')}] inventedPhase=${inventedPhase}`,
    { metrics: { claimedCount: claimIds.size, outOfScope: outOfScope.length, inventedPhase } });
}

/** 6. Lock discipline: never hand-lock a file to "serialize" a non-edit operation. */
export function checkLockDiscipline(t: NormTranscript): BehaviourCheck {
  const lockCalls = t.toolCalls.filter((c) => c.name === 'locks:acquire_granular' || c.name === 'locks:acquire');
  const misuse = lockCalls.filter((c) => /serialize|fleet|coordinat|setup|assign|claim/i.test(intentOf(c)));
  const passed = misuse.length === 0;
  return mk('lock-discipline', false, passed, passed
    ? `no lock misuse (${lockCalls.length} lock calls, none for non-edit ops)`
    : `lock misuse — ${misuse.length}/${lockCalls.length} lock calls used to "serialize" a non-edit operation`,
    { metrics: { lockCalls: lockCalls.length, misuse: misuse.length },
      evidence: (misuse[0] ? intentOf(misuse[0]) : '').slice(0, 160) });
}

/** 7. Fleet launch: use fleet:launch-on-plan (passes --agent/--model); never a psu missing --agent. */
export function checkFleetLaunch(t: NormTranscript, ctx: BehaviourContext): BehaviourCheck {
  const usedLaunchOnPlan = calls(t, 'fleet:launch_on_plan').length > 0;
  const termCalls = t.toolCalls.filter((c) => c.name === 'capability:terminal');
  const psuCmds: string[] = [];
  for (const c of termCalls) {
    const raw = c.argsRaw;
    for (const m of raw.matchAll(/psu[^"\\]*/g)) psuCmds.push(m[0]);
  }
  const missingAgent = psuCmds.filter((cmd) => /psu\b/.test(cmd) && !/--agent[= ]/.test(cmd));
  const missingModel = psuCmds.filter((cmd) => /--agent[= ]omp/.test(cmd) && !/--model[= ]/.test(cmd));
  const launchedAFleet = usedLaunchOnPlan || psuCmds.length > 0 || calls(t, 'fleet:create').length > 0;
  if (!launchedAFleet && !ctx.fleetExpected) {
    return { ...mk('fleet-launch', false, true, 'no fleet launch in this run (n/a)'), na: true };
  }
  const passed = missingAgent.length === 0 && missingModel.length === 0 && (usedLaunchOnPlan || psuCmds.length === 0);
  return mk('fleet-launch', true, passed, passed
    ? `fleet launched cleanly (launch-on-plan=${usedLaunchOnPlan}, hand-rolled psu=${psuCmds.length})`
    : `fleet-launch fault — psuMissingAgent=${missingAgent.length} psuMissingModel=${missingModel.length} handRolled=${psuCmds.length}`,
    { metrics: { usedLaunchOnPlan, handRolledPsu: psuCmds.length, missingAgent: missingAgent.length, missingModel: missingModel.length },
      evidence: (missingAgent[0] || missingModel[0] || '').slice(0, 160) });
}

/** 8. Completion evidence: completes cite real edits/verification, not bare status flips.
 *  A `plans:set-status → done` flip IS a completion for this check (run-7 2026-07-03:
 *  a leader flipped 6 fixture items done via tools:invoke with zero edits and zero
 *  evidence — bare plan-status flips must fail here, not score n/a). */
export function checkCompletionEvidence(t: NormTranscript): BehaviourCheck {
  const doneFlips = t.toolCalls.filter(
    (c) => c.name === 'plans:set_status' && /"status"\s*:\s*"done"/.test(c.argsRaw),
  );
  const completes = [...calls(t, 'work_items:complete'), ...doneFlips];
  if (completes.length === 0) return { ...mk('completion-evidence', false, true, 'no completions in this run (n/a)'), na: true };
  const didEdits = t.toolCalls.some((c) => /^capability:(write|edit)$|^bash$/.test(c.name) && /edit|write|>|tee|sed -i|apply/i.test(c.argsRaw)) ;
  const notesWithEvidence = completes.filter((c) => /verified in sync|verified|\.mdx|\.md\b|\.ts\b|no drift|updated the doc|edited/i.test(c.argsRaw)).length;
  const bare = completes.length - notesWithEvidence;
  const passed = notesWithEvidence >= completes.length && (didEdits || /verified in sync|no drift/i.test(completes.map((c) => c.argsRaw).join(' ')));
  return mk('completion-evidence', false, passed, passed
    ? `completions cite evidence (${notesWithEvidence}/${completes.length}); edits=${didEdits}`
    : `weak evidence — ${bare}/${completes.length} completions are bare status flips, edits=${didEdits}`,
    { metrics: { completes: completes.length, withEvidence: notesWithEvidence, bare, didEdits, planDoneFlips: doneFlips.length } });
}

export const ALL_CHECKS = [
  checkModelRouting,
  checkContextFit,
  checkRoutingGate,
  checkPlanExecution,
  checkScopeAdherence,
  checkLockDiscipline,
  checkFleetLaunch,
  checkCompletionEvidence,
] as const;

/** Run every check against a transcript. Order-stable. */
export function runChecks(t: NormTranscript, ctx: BehaviourContext = {}): BehaviourCheck[] {
  return [
    checkModelRouting(t, ctx),
    checkContextFit(t),
    checkRoutingGate(t, ctx),
    checkPlanExecution(t, ctx),
    checkScopeAdherence(t, ctx),
    checkLockDiscipline(t),
    checkFleetLaunch(t, ctx),
    checkCompletionEvidence(t),
  ];
}
