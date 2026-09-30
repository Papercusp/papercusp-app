/**
 * portfolio-acts.ts — the ONE definition of "this holder PLACED something"
 * (goal-mode-drift-guards-2026-08-31 P-002).
 *
 * ── WHAT THIS ANSWERS THAT NOTHING ELSE DOES ────────────────────────────────
 *
 * `holder.ts` answers "is anybody there?". `activity.ts` folds that with the
 * goal's administrative status. `resolveGoalHolderWedge` (and its subject-
 * agnostic core in `agent-wedge.ts`) answers "has this holder EVER produced an
 * agent-origin tool call". All three read healthy for the failure that motivated
 * this module, and its own docblock says why in as many words: the wedge
 * predicate "only fires on holders that have NEVER produced an agent-origin
 * call, so this is not 'idle for 15 minutes' — it is 'has never once worked'".
 *
 * A steward that READS and REPORTS indefinitely while placing nothing passes
 * every one of them. It is alive, it is held, it has produced work, and it is
 * doing nothing that a portfolio manager exists to do. Measured: one such goal
 * ran 4+ hours and $109 before the ROLLING BUDGET CEILING — a money ceiling, the
 * last line of defence — became the first thing to notice.
 *
 * So the missing predicate is not about presence or effort. It is about the KIND
 * of call: did anything the holder did CHANGE THE PORTFOLIO?
 *
 * ── THE MEMBERSHIP RULE, STATED ONCE ────────────────────────────────────────
 *
 * A tool is a portfolio act iff a HOLDER invoking it changes WHAT WORK EXISTS or
 * WHO IS ON IT.
 *
 * Three consequences of that sentence, each of which decides real cases:
 *
 *  1. READS ARE NEVER PORTFOLIO ACTS — not `goals:list`, `plans:get`,
 *     `coord:orient`, `sessions:search`, `dev:pg_query`, `capability:read`. The
 *     condition being caught is a steward that reads and reports forever, so a
 *     definition that counted reads would be blind by construction.
 *  2. CONFIGURATION OF AN EXISTING SUBJECT IS NOT A PORTFOLIO ACT. A schema, a
 *     property, an unarmed schedule change how a thing is DESCRIBED, not what is
 *     being pursued or by whom. `goals:arm-schedule` is in, because arming is
 *     what makes future work exist; `goals:set-schedule` is out, because
 *     authoring an unarmed recurrence fires nothing.
 *  3. ENDING work counts. Killing a goal, detaching a pot and dropping an item
 *     are portfolio management. A steward whose honest judgement is "stop" has
 *     managed the portfolio; only a steward who does neither has not.
 *
 * ── ⚠ WHY THIS IS A CONSTANT AND NOT PROSE ──────────────────────────────────
 *
 * Because prose already drifted, on day one, in the direction that hurts.
 *
 * The predecessor of this list is the `portfolio-activity-floor` criterion on
 * the live `goal-mode-e2e` rubric (P-001, landed the same morning as this file).
 * It enumerates its verbs as PROSE inside a rubric criterion, and two of the
 * sixteen it names — `goals:amend` and `goals:kill` — HAVE NEVER EXISTED. There
 * is no tool by either name in the tree (verified 2026-08-31 by resolving all 16
 * against `name: '<verb>'` declarations; 14 resolved, those 2 did not). The real
 * verb for both intents is `goals:update`. So the criterion silently could not
 * see amendment or kill activity at all, and a steward whose whole contribution
 * was to amend and kill goals would have graded as measurably idle.
 *
 * That is the failure direction that matters, and it is worth naming precisely:
 * a portfolio verb MISSING from the set makes a BUSY steward read as IDLE. The
 * escalation is report-only, so the immediate cost is a false alarm rather than
 * a wrongly-killed goal — but a detector that cries wolf is a detector that gets
 * ignored, which returns us to the money ceiling.
 *
 * A hand-copied verb list cannot be pinned. This one can, and is:
 *
 *   • `portfolio-acts.test.ts` asserts every name here resolves to a REAL
 *     registered tool, so a phantom verb fails the build instead of quietly
 *     never matching.
 *   • The same test asserts GOAL_KICKOFF_GUARDED_TOOLS ⊆ PORTFOLIO_ACT_TOOLS.
 *     That containment is not a coincidence to be maintained by hand: a door so
 *     consequential that a goal holder MAY NOT CROSS IT before its kickoff reads
 *     are done is, by definition, an act of placing portfolio work. Adding a new
 *     guarded door without adding it here now fails a test — which is exactly the
 *     drift that produced `goals:amend`.
 *
 * ⚠ DEPENDENCY-FREE ON PURPOSE — this module imports NOTHING. `kickoff-evidence.ts`
 * (which owns the guarded set) statically imports `@papercusp/db-org` and the mode
 * store, and this constant is read by a pure fold and by a cell resolver. Importing
 * it here to express the containment would drag the store into every consumer at
 * load, the same cycle `activity.ts` documents avoiding. The containment lives in
 * the test, which may import both freely.
 */

/**
 * CREATE — a subject that did not exist now does.
 *
 * The portfolio grew. This is the most unambiguous facet: none of these can be
 * invoked without something new existing afterwards.
 */
export const PORTFOLIO_CREATE_TOOLS = [
  'goals:create',
  'goals:propose',
  'goals:attach-pot',
  'pot:create',
  'pot:create_from_repo',
  'templates:new-app',
  'harness:generate-from-repo',
  'plans:new',
  'plans:add-item',
  'work_items:create',
] as const;

/**
 * PLACE — work that existed is now somebody's.
 *
 * The facet a reading-and-reporting steward most conspicuously never reaches.
 * Starting, assigning, dispatching and launching are the acts that convert a
 * portfolio into motion.
 */
export const PORTFOLIO_PLACE_TOOLS = [
  'goals:start',
  'goals:start-from-package',
  'goals:arm-schedule',
  'plans:start',
  'plan_items:assign',
  'coord:dispatch',
  'fleet:create',
  'fleet:place_batch',
  'fleet:launch-on-plan',
  'capability:launch-agent',
] as const;

/**
 * STEER — the shape, priority or existence of work in flight changed.
 *
 * Includes ENDING. `goals:update` carries both the amendment and the kill (the
 * two verbs the rubric prose invented separate names for), and a judgement to
 * stop is portfolio management, not its absence.
 */
export const PORTFOLIO_STEER_TOOLS = [
  'goals:update',
  'goals:detach-pot',
  'goals:apply-package-update',
  'plans:add-decision',
  'plans:set-status',
  'blender:route-idea',
  'blender:grade-idea',
  'blender:ideate-pass-record',
  'scorecards:emit',
] as const;

/**
 * THE CANONICAL SET. Import this; never re-spell it.
 *
 * Sorted and de-duplicated at module load so callers may rely on the order (it
 * reaches SQL as an array parameter and appears in evidence output).
 */
export const PORTFOLIO_ACT_TOOLS: readonly string[] = Object.freeze(
  [
    ...new Set<string>([
      ...PORTFOLIO_CREATE_TOOLS,
      ...PORTFOLIO_PLACE_TOOLS,
      ...PORTFOLIO_STEER_TOOLS,
    ]),
  ].sort(),
);

/** The facet each act belongs to — for evidence that says WHICH kind of act landed. */
export type PortfolioActFacet = 'create' | 'place' | 'steer';

/**
 * ── CONDITIONAL ACTS — the name says nothing, the ARGUMENTS decide ──────────
 *
 * Every verb above is an act by NAME: there is no way to invoke `goals:start`
 * without starting a goal. A conditional act is a tool whose bare name is NOT a
 * portfolio act — most of its calls change how a thing is described (rule 2) —
 * but whose arguments can make ONE invocation change WHO IS ON the work.
 *
 * `work_items:update` is the case (WI-2140701, found grading card 4). Nearly all
 * of its calls retitle, re-rate or re-kind an item. But `work_items:update
 * { goal }` ADOPTS an already-filed item into a goal's drain lane — "work that
 * existed is now somebody's", the PLACE facet verbatim — and it is the ONE door a
 * goal steward has for placing existing backlog under its goal without re-filing
 * it through `work_items:create`. Measured 2026-09-01 over 7 days of the live
 * ledger: 323 `work_items:update` calls, of which 35 carried a goal key (29
 * top-level, 6 inside a batch `items[]`), from 10 distinct writers. A steward
 * whose whole contribution was adopting the backlog into its goal graded as
 * measurably idle — the false-IDLE direction the docblock above names as the one
 * that hurts.
 *
 * The rule: an invocation of `tool` is an act iff its args carry `argKey` at the
 * top level, or (batch form) any element of the `batchKey` array carries it. Key
 * PRESENCE is the test, not the value: `goal: null` RELEASES the item from its
 * goal, and releasing work changes who is on it exactly as adopting does (rule 3
 * — a judgement to stop is management, not its absence).
 *
 * ── ⚠ THE SECOND POLARITY: `default-act` — the DEFAULT is the act ───────────
 *
 * `improvements:capture` is the case (WI-2142888), and it forced this field
 * because PRESENCE cannot express it at any value of `argKey`.
 *
 * `provenance-stamp.ts` already calls that verb "the door a goal steward files
 * most of its findings through", and a non-observation capture mints a real
 * work-item through `captureImprovement → createIssue` — "a subject that did not
 * exist now does", the CREATE facet verbatim. It was never in either set, so a
 * steward whose real output was captures scored `actsInWindow: 0`. Measured
 * 2026-09-02: goal `work-on-everything-070565` created two real work-items in an
 * 80-minute window while the instrument scored the growth at zero and the
 * `goal-portfolio-idle` escalation fired 124 times. That is the false-IDLE
 * direction this module's own docblock names as the one that hurts — and it is
 * worse here than a noisy alarm, because idleness scores as FAIL (not `unknown`)
 * on the live `goal-mode-e2e` rubric (WI-1740139), so the steward FAILS a graded
 * criterion for work it actually did.
 *
 * The bare name still must NOT go in `PORTFOLIO_ACT_TOOLS`: most captures are
 * `lane: 'observation'` turn-end reflections, and counting those would credit
 * every reflection as portfolio growth — the false-BUSY direction that lets a
 * reading-and-reporting steward pass. So it is conditional. But the polarity is
 * INVERTED from the `work_items:update` case: a real filing OMITS `lane` (it
 * defaults to `'improvement'`), and an observation is the one value that opts
 * OUT. Presence of `lane` is therefore evidence of a NON-act exactly as often as
 * an act, and no `argKey` under the presence rule can separate them.
 *
 * `rule: 'default-act'` states that directly: the call is an act UNLESS one of
 * its named `optOut` clauses holds.
 *
 * ⚠ TWO clauses are required here, and the second was found by running the first
 * against the live ledger rather than by reading the schema. On the motivating
 * holder's 80-minute window the `lane` clause alone credited NINE acts where the
 * steward had filed FIVE items — because four of those calls carried
 * `checkDuplicatesOnly: true`, whose own tool contract says it returns
 * `created: false, reason: 'check-only'` and "creates nothing". A dedup probe is
 * a READ, and consequence 1 of the membership rule is that reads are NEVER
 * portfolio acts. Crediting it is the false-BUSY direction — the one that lets a
 * reading-and-reporting steward pass — so the fix for a false-IDLE bug would have
 * shipped a false-BUSY leak in the same entry.
 *
 * ⚠ A VALUE clause, not an `absent: true` one. The tool's schema defaults `lane`
 * to `'improvement'` and every call site in `capture.ts` tests
 * `lane === 'observation'` / `!== 'observation'` — never presence — so an
 * explicit `lane: 'improvement'` is a REAL filing that an absence rule would
 * silently score as idle, re-opening the same false-IDLE hole one value over.
 * (Live ledger, 12h to 2026-09-03T00:20Z: 158 calls with `lane` absent, 23 with
 * `'observation'`, 0 explicit `'improvement'` — so the hole is currently unhit,
 * which is exactly when it is cheapest to close and hardest to notice.)
 *
 * ⚠ `default-act` carries NO batch form, and that is a type-level refusal rather
 * than a convention. The batch leg is EXISTENTIAL ("any element carries the
 * key"); negating a predicate flips the correct quantifier to universal, and
 * silently keeping the existential one would score a batch as an act whenever ANY
 * element was not an observation. No case needs the combination, so the union
 * below makes it unrepresentable instead of guessing at it.
 *
 * ⚠ Deliberately NOT spelled into PORTFOLIO_ACT_TOOLS. Putting the bare name there
 * would count every retitle as placement — the false-BUSY direction, which is the
 * one that lets a reading-and-reporting steward pass. The test pins that no
 * conditional tool also appears in the unconditional set.
 *
 * The ledger stores every call's arguments as `tool_invocations.args_json`
 * (verified populated on 323/323 rows in the sample above), so the same rule is
 * expressible in SQL; `portfolio-throughput.ts` derives its predicate from THIS
 * list so a conditional act added here reaches the ledger scan without a second
 * hand-copy.
 */
/**
 * One opt-out clause on a `default-act`: the invocation is NOT an act when it
 * holds. Clauses are OR-ed — any one of them excludes the call.
 */
export interface PortfolioActOptOut {
  /** Argument key that can opt the call out. */
  readonly key: string;
  /**
   * Opt out when `key` is present and strictly equals this string. Omit to opt
   * out whenever `key` carries any TRUTHY value.
   *
   * The two forms exist because the two real clauses differ in kind: `lane` is an
   * enum whose ONE value `'observation'` opts out (every other value, and its
   * absence, is a real filing), while `checkDuplicatesOnly` is a boolean flag
   * where `false` and absent both mean "really file it". Comparison is on the raw
   * string value, so a non-string under a valued clause is a mismatch and
   * therefore still an act — an unexpected shape is not the documented opt-out.
   */
  readonly value?: string;
}

interface PortfolioConditionalActBase {
  /** Canonical tool name, exactly as the ledger stores it. */
  readonly tool: string;
  /** The facet such an invocation lands in. */
  readonly facet: PortfolioActFacet;
}

/**
 * Polarity 1 — the act is the EXCEPTION. Most calls to this tool are not acts;
 * a key's PRESENCE (any value, null included) is what makes one.
 */
export interface PortfolioKeyPresentAct extends PortfolioConditionalActBase {
  readonly rule: 'key-present';
  /** Top-level argument whose presence makes the call an act. */
  readonly argKey: string;
  /** Batch-form array argument whose elements may carry `argKey` instead; null when the tool has no batch form. */
  readonly batchKey: string | null;
}

/**
 * Polarity 2 — the act is the DEFAULT. Most calls to this tool ARE acts, and the
 * named `optOut` clauses are what exclude the rest.
 *
 * ⚠ Deliberately has no `batchKey`: negating an existential batch predicate needs
 * the opposite quantifier, so the combination is unrepresentable rather than
 * silently wrong (see the docblock above).
 */
export interface PortfolioDefaultAct extends PortfolioConditionalActBase {
  readonly rule: 'default-act';
  /** OR-ed exclusions; a call matching any one of them is not an act. Must be non-empty. */
  readonly optOut: readonly PortfolioActOptOut[];
}

export type PortfolioConditionalAct = PortfolioKeyPresentAct | PortfolioDefaultAct;

export const PORTFOLIO_CONDITIONAL_ACTS: readonly PortfolioConditionalAct[] = Object.freeze([
  { rule: 'key-present', tool: 'work_items:update', argKey: 'goal', batchKey: 'items', facet: 'place' },
  {
    rule: 'default-act',
    tool: 'improvements:capture',
    facet: 'create',
    optOut: [
      // A turn-end reflection: filed outside the work queue by design (D-005).
      { key: 'lane', value: 'observation' },
      // A dedup PROBE: `created:false, reason:'check-only'` — it creates nothing,
      // and a read is never a portfolio act.
      { key: 'checkDuplicatesOnly' },
    ],
  },
]);

const FACET_BY_TOOL: ReadonlyMap<string, PortfolioActFacet> = new Map<string, PortfolioActFacet>([
  ...PORTFOLIO_CREATE_TOOLS.map((t) => [t, 'create'] as const),
  ...PORTFOLIO_PLACE_TOOLS.map((t) => [t, 'place'] as const),
  ...PORTFOLIO_STEER_TOOLS.map((t) => [t, 'steer'] as const),
]);

const ACTS = new Set<string>(PORTFOLIO_ACT_TOOLS);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * PURE: do these arguments satisfy a conditional act's key rule?
 *
 * Mirrors the SQL form in `portfolio-throughput.ts` (`args_json ? key`, else any
 * element of `args_json -> batchKey` carries it). Presence, not truthiness — a
 * `null` value is a deliberate clear and still a placement decision.
 */
export function argsCarryConditionalKey(
  args: unknown,
  act: Pick<PortfolioKeyPresentAct, 'argKey' | 'batchKey'>,
): boolean {
  if (!isRecord(args)) return false;
  if (Object.prototype.hasOwnProperty.call(args, act.argKey)) return true;
  if (act.batchKey == null) return false;
  const batch = args[act.batchKey];
  return (
    Array.isArray(batch) &&
    batch.some((el) => isRecord(el) && Object.prototype.hasOwnProperty.call(el, act.argKey))
  );
}

/**
 * PURE: do these arguments make this invocation an act, under EITHER polarity?
 *
 * The polarity-aware entry point. `argsCarryConditionalKey` above stays the
 * presence primitive it is named for; this dispatches on `notValue`.
 *
 * ⚠ The conservative floor holds in BOTH polarities: args that are not an object
 * are a measured NON-act. Under `notValue` that is the load-bearing case rather
 * than a formality — "no `lane` key" is the ACT condition, and a missing/opaque
 * args payload is indistinguishable from it, so without this guard a caller
 * holding only a tool name would score a false BUSY on every capture. Same
 * reasoning as `isPortfolioAct`: the name alone never counts.
 */
export function argsSatisfyConditionalAct(args: unknown, act: PortfolioConditionalAct): boolean {
  if (!isRecord(args)) return false;
  if (act.rule === 'key-present') return argsCarryConditionalKey(args, act);
  return !act.optOut.some((clause) => optOutHolds(args, clause));
}

/**
 * Does one opt-out clause exclude this call?
 *
 * A VALUED clause is strict string equality on the raw argument. A VALUELESS one
 * is JS truthiness, which is the rule the SQL twin mirrors literally: absent,
 * `null`, `false`, `0` and `''` do not opt out; anything else does. Stated here
 * once so the two implementations cannot drift into disagreeing about what
 * "truthy" means.
 */
function optOutHolds(args: Record<string, unknown>, clause: PortfolioActOptOut): boolean {
  const v = args[clause.key];
  return clause.value == null ? Boolean(v) : v === clause.value;
}

function conditionalActFor(toolName: string, args: unknown): PortfolioConditionalAct | null {
  for (const act of PORTFOLIO_CONDITIONAL_ACTS) {
    if (act.tool === toolName && argsSatisfyConditionalAct(args, act)) return act;
  }
  return null;
}

/**
 * Is this invocation a portfolio act?
 *
 * By NAME for the canonical set (exact match — the ledger stores canonical
 * names); by ARGUMENTS for a conditional act. A conditional tool with no `args`
 * supplied is a measured non-act: the name alone never counts, so a caller that
 * only has the name gets the conservative answer rather than a false BUSY.
 */
export function isPortfolioAct(toolName: string | null | undefined, args?: unknown): boolean {
  if (toolName == null) return false;
  if (ACTS.has(toolName)) return true;
  return conditionalActFor(toolName, args) != null;
}

/**
 * Which facet, or null for a non-act.
 *
 * Returns null rather than throwing so a caller folding a ledger row never has
 * to pre-filter: an unrecognised name is a measured non-act, not an error. Pass
 * the row's `args_json` so a conditional act resolves to its facet.
 */
export function portfolioActFacet(
  toolName: string | null | undefined,
  args?: unknown,
): PortfolioActFacet | null {
  if (toolName == null) return null;
  return FACET_BY_TOOL.get(toolName) ?? conditionalActFor(toolName, args)?.facet ?? null;
}
