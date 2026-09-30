/**
 * P-006 — debate + recombine surviving critiques into Proposals (hive-creative-
 * ideation D-006). The surviving ideas (verdict ≠ reject) are grouped — topically
 * related survivors PAIRED so their mechanisms can fuse ("A's mechanism + B's
 * framing"; the best ideas are usually a fusion) — then each group is debated +
 * merged by the LLM into one Proposal. Every Proposal MUST carry a cheap,
 * falsifiable first experiment (D-006) — the anti-bullshit gate enforced by
 * `validateProposal`; a group whose LLM output fails the gate is DROPPED, never
 * smuggled through.
 *
 * Pairing + validation are pure + deterministic (unit-tested without a network);
 * the merge step takes an injected `ScoutLlmCall` (the gym:judge pattern). The
 * cycle (su-cb4b9) calls `recombineProposals`; P-007 routing (su-ce4bd) consumes
 * the Proposals; P-009 (su-e8630) reuses `validateProposal` for the bettable
 * invariant.
 */
import type { ScoredIdea, Proposal, ScoutExperiment, ScoutLlmCall } from './types';
import { titleSimilarity } from '../harness/improvements/digest';
import { parseLlmJson } from './llm-json';
import { DEFAULT_SCOUT_RECOMBINE_MODEL } from './models';
import { callScoutPhaseLlm, DEFAULT_SCOUT_RECOMBINE_TIMEOUT_MS } from './llm-deadline';

/** Default recombine model — a touch stronger than the critic (it writes the
 *  proposal narrative + experiment). Overridable via RecombineOptions.model. */
export const DEFAULT_RECOMBINE_MODEL = DEFAULT_SCOUT_RECOMBINE_MODEL;

/** A group of 1-2 surviving ideas to debate/merge into one proposal. */
export interface RecombinationGroup {
  members: ScoredIdea[];
}

export interface PlanRecombinationOptions {
  /** Two survivors at/above this title-signature overlap are PAIRED to merge
   *  (related-but-not-identical; default 0.25). */
  pairSimilarityFloor?: number;
  /** Max groups produced — the per-cycle cost bound (default 4). */
  maxGroups?: number;
}

/**
 * Decide which survivors to debate/merge. Most-novel survivors anchor first;
 * each anchor is paired with its most-similar unused partner above the floor (so
 * related ideas fuse), else it stands alone. Greedy, deterministic, capped.
 */
export function planRecombinations(
  survivors: readonly ScoredIdea[],
  opts: PlanRecombinationOptions = {},
): RecombinationGroup[] {
  const floor = opts.pairSimilarityFloor ?? 0.25;
  const maxGroups = opts.maxGroups ?? 4;
  const used = new Set<string>();
  const groups: RecombinationGroup[] = [];
  const ordered = [...survivors].sort((a, b) => b.novelty - a.novelty);

  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i];
    if (used.has(a.idea.id)) continue;
    used.add(a.idea.id);

    let partner: ScoredIdea | undefined;
    let best = floor;
    for (let j = i + 1; j < ordered.length; j++) {
      const b = ordered[j];
      if (used.has(b.idea.id)) continue;
      const sim = titleSimilarity(
        `${a.idea.title} ${a.idea.body}`,
        `${b.idea.title} ${b.idea.body}`,
      );
      if (sim >= best) {
        best = sim;
        partner = b;
      }
    }
    if (partner) {
      used.add(partner.idea.id);
      groups.push({ members: [a, partner] });
    } else {
      groups.push({ members: [a] });
    }
    if (groups.length >= maxGroups) break;
  }
  return groups;
}

export interface ProposalValidation {
  ok: boolean;
  errors: string[];
}

/**
 * The D-006 gate: a Proposal is valid only if it carries the core narrative
 * (framing / mechanism / whyNew / bet), ≥1 source idea, a present grounding array,
 * AND a complete cheap-falsifiable-experiment (hypothesis + method +
 * falsifiableSignal all non-empty). Reused by P-009's bettable invariant.
 */
export function validateProposal(p: Partial<Proposal>): ProposalValidation {
  const errors: string[] = [];
  const ne = (s: unknown): boolean => typeof s === 'string' && s.trim().length > 0;

  if (!ne(p.framing)) errors.push('missing framing');
  if (!ne(p.mechanism)) errors.push('missing mechanism');
  if (!ne(p.whyNew)) errors.push('missing whyNew');
  if (!ne(p.bet)) errors.push('missing bet');

  const e = p.cheapExperiment;
  if (!e || !ne(e.hypothesis) || !ne(e.method) || !ne(e.falsifiableSignal)) {
    errors.push(
      'missing/incomplete cheapExperiment (D-006: hypothesis + method + falsifiableSignal all required)',
    );
  }
  if (!Array.isArray(p.sourceIdeaIds) || p.sourceIdeaIds.length === 0) {
    errors.push('missing sourceIdeaIds (≥1)');
  }
  if (!Array.isArray(p.addressesPatternRefs)) {
    errors.push('missing addressesPatternRefs (grounding array — may be empty)');
  }
  return { ok: errors.length === 0, errors };
}

export interface RecombineOptions extends PlanRecombinationOptions {
  projectContext?: string;
  model?: string;
  thinkingBudgetTokens?: number;
  /** Per-call generation cap; <=0 disables the local cap. */
  timeoutMs?: number;
  /** Optional caller cancellation signal (the production runner composes its parent signal). */
  signal?: AbortSignal;
  /** Absolute deadline of the owning Scout cycle. */
  cycleDeadlineMs?: number;
  /** Test seam for the admission backstop grace. */
  admissionBackstopGraceMs?: number;
}

export interface RecombineResult {
  proposals: Proposal[];
  /** Groups whose LLM output failed the D-006 validation gate (dropped, with why). */
  dropped: { sourceIdeaIds: string[]; errors: string[] }[];
  /**
   * WI-39721 — route hints the model emitted that `parseProposal` did NOT accept,
   * tallied by value (count desc, then value asc). Each one was coerced to
   * `undefined` and therefore falls through to `DEFAULT_ROUTING_RAIL`.
   *
   * WI-39879 also carries the dropped value on each surviving Proposal so the
   * artifact-backed draft queue can reconstruct it after this batch result is
   * reduced to `.proposals`. This tally remains the batch-level count and powers
   * the live `[scout/recombine]` warning.
   */
  droppedRouteHints: { value: string; count: number }[];
}

export function buildRecombinePrompt(
  group: RecombinationGroup,
  opts: RecombineOptions,
): { system: string; user: string } {
  const merging = group.members.length > 1;
  const system = [
    'You are a Scout proposer for the Papercusp "Hive" (a multi-agent coding platform). You turn 1-2 surviving creative ideas into ONE concrete, bettable PROPOSAL.',
    merging
      ? "The ideas are related — DEBATE them and MERGE the best of each (one idea's mechanism + the other's framing); the strongest proposals are usually a fusion."
      : 'Sharpen this single idea into a concrete proposal.',
    'Every proposal MUST name a CHEAP, FALSIFIABLE first experiment (the anti-bullshit gate): a hypothesis, the cheap method to test it, and the observable signal that would prove it WRONG.',
    'Reason briefly, then output ONLY this JSON (no prose, no fences):',
    '{"framing": "...the problem this addresses...", "mechanism": "...the novel mechanism, how it works...", "whyNew": "...why this is new vs what already exists...", "bet": "...the upside if it works...", "experiment": {"hypothesis": "...", "method": "...the cheap first test...", "falsifiableSignal": "...the observable that would prove it WRONG..."}, "route": "plan|gym|improvement|goal", "targetGoalId": "...existing goal id for an amendment; omit for creation..."}',
    'route: "plan" for broad/architectural scope, "gym" for a small testable optimization, "improvement" for a concrete fix.',
    'Use route: "goal" for goal-scale work with a measurable end-state. Include a non-empty targetGoalId to amend a KNOWN existing goal; omit targetGoalId to create a new goal. Never invent a targetGoalId. Creation keeps the goal rail\'s kill criterion, spend ceiling, feature-flag kill switch, and per-cycle cap.',
  ].join('\n');

  const ideaBlock = group.members
    .map((m, i) =>
      [
        `### Idea ${i + 1} (lens: ${m.idea.lens}; novelty ${m.novelty}, feasibility ${m.feasibility})`,
        `Title: ${m.idea.title}`,
        m.idea.body,
        `Mechanism: ${m.idea.mechanism}`,
      ].join('\n'),
    )
    .join('\n\n');

  const user = [
    merging ? '## Surviving ideas to debate + merge' : '## Surviving idea to sharpen',
    ideaBlock,
    '',
    '## Architecture context',
    opts.projectContext ?? '(none provided)',
  ].join('\n');

  return { system, user };
}

/**
 * Route-hint names this parser can accept from the model. `goal` admits both shapes:
 * a non-empty targetGoalId means amendment; no target means autonomous creation.
 *
 * `instance` remains outside this list. Adding another name is still an explicit
 * intake decision guarded below (WI-39724).
 */
export const ACCEPTED_ROUTE_HINTS = ['plan', 'gym', 'improvement', 'goal'] as const;

/**
 * WI-39724 — every member of the `Proposal['routeHint']` union, as a RUNTIME value.
 *
 * ⚠ This is NOT a hand-maintained copy, and must never become one: the type below
 * makes a union member that is missing from this list a COMPILE ERROR. That matters
 * because the failure this guard exists to prevent is silent — types.ts and this file
 * drifted apart with nothing failing, and the goal rail's direct-hint path was dead
 * code in production for a day while looking armed (D-006). A hand-copied list would
 * reproduce exactly that: a guard that reads as passing because it never learned the
 * union grew.
 */
export const ALL_ROUTE_HINTS = [
  'plan',
  'gym',
  'improvement',
  'instance',
  'goal',
] as const satisfies readonly NonNullable<Proposal['routeHint']>[];

/** `AssertNever<T>` only compiles when T is `never`. */
type AssertNever<T extends never> = T;

/**
 * The compile-time half of the WI-39724 guard: if someone adds a member to
 * `Proposal['routeHint']` without adding it to `ALL_ROUTE_HINTS`, `Exclude` yields
 * that member instead of `never` and this alias fails to compile. Exported only so
 * it is never an unused local — it has no runtime representation.
 */
export type RouteHintsAreExhaustive = AssertNever<
  Exclude<NonNullable<Proposal['routeHint']>, (typeof ALL_ROUTE_HINTS)[number]>
>;

/**
 * WI-39724 — route hints that are wholly or conditionally held by
 * `parseProposal`, each with the reason for the hold.
 *
 * A string holds the whole hint. A structured entry is a conditional hold: the
 * hint must also appear in ACCEPTED_ROUTE_HINTS, but remains held unless its
 * named exception is satisfied. No production hint currently uses the conditional
 * shape; it remains part of the drift guard so a future split cannot be half-wired.
 *
 * ⚠ Removing or loosening an entry here is an intake decision. The guard in
 * recombine.test.ts requires a conditional hint to be named in
 * ACCEPTED_ROUTE_HINTS, so the two halves cannot silently drift.
 */
export type RouteHintHold =
  | string
  | Readonly<{
      reason: string;
      /** Admit only when the proposal names an existing goal to amend. */
      exceptWhen: 'targetGoalId';
    }>;

export const DELIBERATELY_UNACCEPTED_ROUTE_HINTS: Partial<
  Record<NonNullable<Proposal['routeHint']>, RouteHintHold>
> = {
  instance:
    'awaiting owner intake decision, D-006 — same ruling as goal; the instance rail is an eval-battery InstanceSubject and has never been reachable via a direct model hint.',
};

function acceptsRouteHint(
  route: string,
  targetGoalId: string,
): route is NonNullable<Proposal['routeHint']> {
  if (!(ACCEPTED_ROUTE_HINTS as readonly string[]).includes(route)) return false;
  const hold = DELIBERATELY_UNACCEPTED_ROUTE_HINTS[
    route as NonNullable<Proposal['routeHint']>
  ];
  if (!hold) return true;
  if (typeof hold === 'string') return false;
  return hold.exceptWhen === 'targetGoalId' && targetGoalId.length > 0;
}

type ParsedProposal = {
  framing: string;
  mechanism: string;
  whyNew: string;
  bet: string;
  cheapExperiment: ScoutExperiment;
  routeHint?: Proposal['routeHint'];
  /** Existing goal named by an amendment proposal (D-004). */
  targetGoalId?: string;
  /** WI-39721: a non-empty hint the model asked for that was NOT accepted above,
   *  recorded verbatim so the coercion is countable instead of silent. */
  droppedRouteHint?: string;
};

function parseProposal(raw: unknown): ParsedProposal | null {
  if (raw == null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const expSrc = (o.experiment ?? o.cheapExperiment) as Record<string, unknown> | undefined;
  const cheapExperiment: ScoutExperiment = {
    hypothesis: str(expSrc?.hypothesis),
    method: str(expSrc?.method),
    falsifiableSignal: str(expSrc?.falsifiableSignal ?? expSrc?.falsifiable_signal),
  };
  const route = str(o.route ?? o.routeHint);
  const targetGoalId = str(o.targetGoalId ?? o.target_goal_id);
  const accepted = acceptsRouteHint(route, targetGoalId);
  const routeHint = accepted ? (route as Proposal['routeHint']) : undefined;
  return {
    framing: str(o.framing),
    mechanism: str(o.mechanism),
    whyNew: str(o.whyNew ?? o.why_new),
    bet: str(o.bet),
    cheapExperiment,
    routeHint,
    ...(targetGoalId ? { targetGoalId } : {}),
    // Routing is UNCHANGED by this record: an unaccepted hint still coerces to
    // undefined (→ DEFAULT_ROUTING_RAIL). We only stop throwing away the fact
    // that the model asked for something else. An ABSENT hint is not a drop.
    ...(route && !accepted ? { droppedRouteHint: route } : {}),
  };
}

/**
 * Debate + recombine survivors → validated Proposals. Filters to survivors
 * (verdict ≠ reject) internally, so the cycle can hand the full ScoredIdea[]
 * straight in. Only proposals that pass the D-006 gate are returned; the rest
 * land in `dropped` (visible, never silently lost).
 */
export async function recombineProposals(
  scored: readonly ScoredIdea[],
  deps: { llmCall: ScoutLlmCall },
  opts: RecombineOptions = {},
): Promise<RecombineResult> {
  const survivors = scored.filter((s) => s.verdict !== 'reject');
  const groups = planRecombinations(survivors, opts);

  // WI-4475 (bug-drain-200k): this used to be a plain `for...of` loop with an
  // `await` per group — the same serialization defect as critiqueIdeas
  // (critics.ts): G groups meant G SEQUENTIAL LLM round-trips summed into the
  // same 600s scout-cycle deadline, which is what actually produced "Scout cycle
  // timed out after 600000ms during phase recombine" even on ticks whose
  // poolSnapshotAtFire (WI-5436) showed healthy accounts available — the account
  // failover was never broken, the phase just never gave it a chance to matter.
  // Fan the calls out concurrently instead (mirrors runIdeators' Promise.all
  // roster fan-out); a failed/rejected call is caught PER GROUP so it lands in
  // `dropped` like a validation failure instead of aborting every other group's
  // recombination.
  const results = await Promise.all(
    groups.map(
      async (
        group,
      ): Promise<
        | { ok: true; base: Partial<Proposal>; droppedRouteHint?: string }
        | { ok: false; sourceIdeaIds: string[]; errors: string[]; droppedRouteHint?: string }
      > => {
        const sourceIdeaIds = group.members.map((m) => m.idea.id);
        const addressesPatternRefs = [
          ...new Set(group.members.flatMap((m) => m.idea.addressesPatternRefs ?? [])),
        ];
        const seededByRefs = [
          ...new Set(group.members.flatMap((m) => m.idea.seededByRefs ?? [])),
        ];
        const { system, user } = buildRecombinePrompt(group, opts);
        const thinkingBudgetTokens = opts.thinkingBudgetTokens ?? 2048;
        let res: Awaited<ReturnType<typeof deps.llmCall>>;
        try {
          res = await callScoutPhaseLlm({
            llmCall: deps.llmCall,
            phase: 'recombine',
            timeoutMs: opts.timeoutMs ?? DEFAULT_SCOUT_RECOMBINE_TIMEOUT_MS,
            signal: opts.signal,
            cycleDeadlineMs: opts.cycleDeadlineMs,
            admissionBackstopGraceMs: opts.admissionBackstopGraceMs,
            input: {
              model: opts.model ?? DEFAULT_RECOMBINE_MODEL,
              system,
              messages: [{ role: 'user', content: user }],
              responseFormat: 'json',
              thinkingBudgetTokens,
              // Server-side thinking headroom (EI-13119 class — see ideators.ts).
              maxTokens: thinkingBudgetTokens + 8192,
            },
          });
        } catch (err) {
          return {
            ok: false,
            sourceIdeaIds,
            errors: [`recombine call failed: ${err instanceof Error ? err.message : String(err)}`],
          };
        }
        const parsed = parseProposal(parseLlmJson(res));
        const base: Partial<Proposal> = parsed
          ? {
              framing: parsed.framing,
              mechanism: parsed.mechanism,
              whyNew: parsed.whyNew,
              bet: parsed.bet,
              cheapExperiment: parsed.cheapExperiment,
              sourceIdeaIds,
              addressesPatternRefs,
              ...(seededByRefs.length ? { seededByRefs } : {}),
              ...(parsed.routeHint ? { routeHint: parsed.routeHint } : {}),
              ...(parsed.targetGoalId ? { targetGoalId: parsed.targetGoalId } : {}),
              // WI-39879: a rejected ask rides ON the proposal too, not only in
              // the batch tally below. For goal creation (no target), routeHint is
              // still undefined and routing stays unchanged; targeted amendments
              // are accepted and therefore carry no dropped hint.
              ...(parsed.droppedRouteHint ? { droppedRouteHint: parsed.droppedRouteHint } : {}),
            }
          : { sourceIdeaIds, addressesPatternRefs, ...(seededByRefs.length ? { seededByRefs } : {}) };

        // WI-39721: carry the dropped hint out on BOTH branches — a group can
        // ask for an unaccepted rail and still fail the D-006 gate, and that ask
        // is exactly as much evidence of a starved rail as a passing one.
        const hint = parsed?.droppedRouteHint ? { droppedRouteHint: parsed.droppedRouteHint } : {};
        const v = validateProposal(base);
        if (v.ok) return { ok: true, base, ...hint };
        return { ok: false, sourceIdeaIds, errors: v.errors, ...hint };
      },
    ),
  );

  const proposals: Proposal[] = [];
  const dropped: { sourceIdeaIds: string[]; errors: string[] }[] = [];
  // P-002 (blender-loop-repair-2026-08-16, EI-20597534704604481): the id is the
  // JOIN KEY for outcome attribution — routedRef `gym:<id>` matches change-feed
  // completions BY THIS STRING. A per-batch counter (`SP-001`…) recurs every
  // cycle, so every cycle's proposal #1 inherited the FIRST cycle's outcome:
  // 600 of 746 decided outcomes were copies of 4 frozen July verdicts. The
  // batch stamp makes the id unique across cycles while staying readable.
  const batchStamp = Date.now().toString(36);
  const hintTally = new Map<string, number>();
  let n = 0;
  for (const r of results) {
    if (r.droppedRouteHint) {
      hintTally.set(r.droppedRouteHint, (hintTally.get(r.droppedRouteHint) ?? 0) + 1);
    }
    if (r.ok) {
      proposals.push({ id: `SP-${batchStamp}-${String(++n).padStart(3, '0')}`, ...r.base } as Proposal);
    } else {
      dropped.push({ sourceIdeaIds: r.sourceIdeaIds, errors: r.errors });
    }
  }

  // WI-39721: make rejected hints LOUD. Every hint below already became
  // `undefined` in parseProposal and will take DEFAULT_ROUTING_RAIL. Goal is
  // accepted for both creation and amendment, so it never enters this tally.
  // Emitted per batch rather than per group so a starved rail reads as a rate.
  const droppedRouteHints = [...hintTally.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  if (droppedRouteHints.length > 0) {
    const total = droppedRouteHints.reduce((sum, d) => sum + d.count, 0);
    console.warn(
      `[scout/recombine] routeHint DROPPED in ${total}/${results.length} group(s): ` +
        `${droppedRouteHints.map((d) => `${d.value}×${d.count}`).join(', ')} — ` +
        `the admission policy rejected each (accepted names: ` +
        `${ACCEPTED_ROUTE_HINTS.join('|')}), so each ` +
        `coerces to undefined and takes DEFAULT_ROUTING_RAIL instead (WI-39721).`,
    );
  }

  return { proposals, dropped, droppedRouteHints };
}
