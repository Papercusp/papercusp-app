import type { ParsedPlan, PlanDecision, PlanItem } from './parser';
import { splitPlanSections } from './plan-sections';
import { isTerminalItemStatus } from '../../fleet-drained-events';

export interface StagingFirstActivationProblem {
  itemId: string;
  code: 'non_final_deployed_main_wait';
  detail: string;
}

export interface StagingFirstBlockerInput {
  itemId: string;
  /** Work-item title + summary, used to classify final shipment/gate work. */
  itemText: string;
  /** The typed blocker ref plus its next action: the dependency semantics that get classified. */
  blockerText: string;
  /**
   * The caller's blocker `summary` + `evidence`. Read ONLY by the narrow deployed-only
   * exception, never by classification: evidence routinely names :3070/:3170 as
   * provenance, so classifying it would turn an unrelated blocker into a false
   * deployed-main wait. But the refusal's own remediation tells the caller to NAME the
   * deployed-only property and explain the staging limitation, and callers put that
   * prose in `summary`/`evidence`; ignoring those fields made the exception
   * unsatisfiable from exactly where it is written (EI-24018845641231261).
   */
  exceptionText?: string;
  kind: string;
}

export interface StagingFirstBlockerProblem {
  itemId: string;
  code: 'non_final_deployed_main_blocker';
  detail: string;
}

// `main` is overloaded: it can mean the release branch, or a browser build
// artifact (`main bundle`, `main chunk`, ...). Only the former belongs to the
// staging-first release guard. Keep this lexical fence close to the token so a
// later gate phrase in the same sentence cannot turn build prose into a wait.
const DEPLOYED_ENV_RE =
  /(?:\bmain\b(?!(?:\s+|-)\b(?:bundle|chunk|entry|thread)\b)|:3070\b|\bgreen[- ]checkpoint\b|\bdeploy(?:ed|ment|ing)?\b)/i;
const STRONG_GATE_RE =
  /(?:\bwait(?:ing)?\s+(?:for|on)\b|\bblock(?:ed|ing|s)?\b.{0,40}\b(?:on|until|before|by)\b|\bprerequisite\b|\bonly\s+after\b|\bbefore\s+(?:continu(?:e|ing)|implement(?:ation|ing)?|clos(?:e|ing)|mark(?:ing)?\s+(?:it\s+)?done)\b|\b(?:must|required?|requires?)\b.{0,80}\b(?:before|until|prior to)\b)/i;
// A bare `until` is ordinary ordering prose. It is a strong gate only when
// its object is itself a release-plane token. This prevents e.g. `main bundle
// ... cannot begin until: parse` from pairing unrelated words.
const RELEASE_PLANE_UNTIL_RE =
  /\buntil\b\s*:?[\s,-]*(?:(?:the\s+)?main\b(?!(?:\s+|-)\b(?:bundle|chunk|entry|thread)\b)|:3070\b|\bgreen[- ]checkpoint\b|\bdeploy(?:ed|ment|ing)?\b)/i;
const NEGATED_OR_META_GATE_RE =
  /(?:\b(?:reject|refus|forbid|prevent|detect|flag|exclud)\w*\b|\bguard(?:s|ed|ing)?\s+against\b|\bno\b.{0,80}\b(?:block|wait|required?|prerequisite)\w*\b|\bnot\s+(?:an?\s+)?(?:\w+[- ]){0,3}(?:prerequisite|wait|block(?:er|ing)?|gate)\b|\b(?:does|do|must|should|is|are)\s+not\b.{0,80}\b(?:block|wait|required?|prerequisite)\w*\b|\bnever\s+(?:an?\s+)?(?:block|wait|require|prerequisite)\w*\b|\bwithout\s+wait(?:ing)?\s+(?:for|on)\b|\binstead\s+of\s+wait(?:ing)?\s+(?:for|on)\b)/i;
const FINAL_LIFECYCLE_RE =
  /(?:\bfinal\s+(?:shipment|promotion|deploy(?:ment)?|release|rollout|verification|acceptance)\b|\bship(?:ment)?\s+verification\b|\brelease\s+packag(?:e|ing)\b|\brollback\b|\bmigration\s+order(?:ing)?\b)/i;
const FINAL_PHASE_RE = /(?:\brelease\b|\bshipment\b|\brollout\b|\bclosure\b|\bship\b)/i;
const EXPLICIT_DEPLOYED_ONLY_RE = /\bdeployed[- ]only\b/i;
const STAGING_LIMIT_RE =
  /(?:\b(?:staging|current[- ]build)\b.{0,140}\b(?:cannot|can't|unable|does not|doesn't|is not|isn't|unavailable)\b|\b(?:cannot|can't|unable)\b.{0,140}\b(?:staging|current[- ]build)\b)/i;
const CONCRETE_REASON_RE =
  /(?:\bbecause\b|\bdue to\b|\bsince\b|\breason\b|\brollback\b|\brelease\s+packag(?:e|ing)\b|\bmigration\s+order(?:ing)?\b|\bproduction[- ]only\b|\bdeployed[- ]host\b)/i;
const ACCEPTANCE_SECTION_RE = /^(?:acceptance|requirements?|validation|verification)\b/i;
const MAIN_RELEASE_BLOCKER_RE =
  /(?:\bmain\b|:3070\b|green[- ]checkpoint|greenCheckpoint|\bgreen[- ]pin\b|\bproduction\b)/i;
const GENERIC_DEPLOY_BLOCKER_RE = /(?:\brelease\b|\bdeploy(?:ed|ment|ing)?\b)/i;
const EXPLICIT_STAGING_ENV_RE = /(?:\bstaging\b|\bcurrent[- ]build\b)/i;
const LIVE_GATE_OPERATION_RE =
  /(?:green[- ]checkpoint|greenCheckpoint|gate[- ]red|re-?green|tested[/ -]deployed\s+parity|restore(?:d)?\s+(?:the\s+)?(?:tested[/ -]deployed|release)\s+parity)/i;
// A single blocked status cannot distinguish source work from final deployment
// verification. Require separate items when the title still promises source work.
// `build` is source work only as a verb: "whichever build", "the current build"
// and "a green build" name the artifact a final check runs on.
const NON_FINAL_TITLE_RE =
  /(?:\b(?:implement|add|write)\b|(?<!\b(?:a|an|the|this|that|which|whichever|each|every|any|same|new|latest|current|staging|green|release|released|deployed)[- ])\bbuild\b|\b(?:run|prove)\b.{0,140}\b(?:source|unit|integration|regression)\b)/i;

function hasNonFinalWorkInTitle(text: string): boolean {
  return NON_FINAL_TITLE_RE.test(text.split(/\n|\s+—\s+note:/i, 1)[0] ?? '');
}

// A plan slug is an IDENTIFIER, not dependency semantics. A ref such as
// `p2p-public-release-endgame-2026-09-01#D-047` names a plan decision; the word
// `release` inside the slug says nothing about waiting on main/:3070/deployment, yet
// GENERIC_DEPLOY_BLOCKER_RE matched it (hyphens are word boundaries) and a kind:'gate'
// blocker on ANY decision of that plan was refused as a deployed-main wait
// (EI-24018845641231261). Blank the slug of plan-anchored refs (`<slug>#D-NNN`,
// `<slug>#P-NNN`) and of `plan:`/`plan-lane:` refs before any semantic matching; a
// genuine release wait still carries its own words (main, :3070, deploy, ...) outside
// the identifier.
const PLAN_PREFIXED_SLUG_RE = /\b(plan(?:-lane)?:)[a-z0-9]+(?:-[a-z0-9]+)*/gi;
const PLAN_ANCHORED_SLUG_RE = /\b[a-z0-9]+(?:-[a-z0-9]+)*(?=#[DP]-\d{3,}\b)/gi;

export function neutralizePlanIdentifiers(text: string): string {
  return text.replace(PLAN_PREFIXED_SLUG_RE, '$1<plan>').replace(PLAN_ANCHORED_SLUG_RE, '<plan>');
}

function itemRefPattern(itemId: string): RegExp {
  return new RegExp(`\\b${itemId.replace('-', '\\-')}\\b`);
}

function decisionAppliesToItem(decision: PlanDecision, item: PlanItem): boolean {
  return (
    item.decisionRefs.includes(decision.id) ||
    decision.itemRefs.includes(item.id) ||
    itemRefPattern(item.id).test(`${decision.title}\n${decision.body}`)
  );
}

function applicableDecisions(item: PlanItem, decisions: PlanDecision[]): PlanDecision[] {
  return decisions.filter((decision) => decisionAppliesToItem(decision, item));
}

const ANY_ITEM_REF_RE = /\bP-\d{3,}\b/i;
const ANAPHORIC_ITEM_RE =
  /\b(?:it|this item|that item|the item|this work|that work|the work|this lane|that lane|the lane)\b/i;

/**
 * Keep prose that actually speaks about this item instead of admitting an entire
 * multi-item status/acceptance block after one incidental reference. The following
 * anaphoric sentence is retained when it clearly continues the same item and does
 * not introduce another P-NNN reference.
 */
function itemScopedText(text: string, itemId: string): string {
  const ref = itemRefPattern(itemId);
  const clauses = text
    .split(/\n+|(?<=[.!?;])\s+/)
    .map((clause) => clause.trim())
    .filter(Boolean);

  return clauses
    .filter((clause, index) => {
      if (ref.test(clause)) return true;
      if (index === 0 || ANY_ITEM_REF_RE.test(clause) || !ANAPHORIC_ITEM_RE.test(clause)) return false;
      return ref.test(clauses[index - 1] ?? '');
    })
    .join('\n');
}

function decisionTextForItem(decision: PlanDecision, item: PlanItem): string {
  const text = `${decision.title}\n${decision.body}`;
  const relatedLine = decision.body.split('\n').find((line) => /^\s*Related:/i.test(line));
  const explicitlyLinked =
    item.decisionRefs.includes(decision.id) || Boolean(relatedLine && itemRefPattern(item.id).test(relatedLine));
  return explicitlyLinked ? text : itemScopedText(text, item.id);
}

export function hasNarrowDeployedMainException(text: string): boolean {
  return EXPLICIT_DEPLOYED_ONLY_RE.test(text) && STAGING_LIMIT_RE.test(text) && CONCRETE_REASON_RE.test(text);
}

/** Gate repair itself operates the release plane; it is not ordinary plan implementation. */
export function isLiveGateOperationText(text: string): boolean {
  return LIVE_GATE_OPERATION_RE.test(text) &&
    /\b(?:repair|fix|triage|diagnos\w*|run|rerun|re-run|fire|restore|re-green)\b/i.test(text);
}

/**
 * The narrow exception is a three-predicate LEXICAL conjunction, and a caller can
 * supply the full substance of a legitimate deployed-only wait while missing one
 * magic token — then receive the same generic refusal on every retry with no way
 * to see which predicate failed (EI-22058383186105579: a correctly-evidenced
 * runtime-writer-vintage blocker was refused twice verbatim). Name each predicate's
 * status and the exact token contract, so one refusal is enough to self-repair.
 */
export function narrowExceptionDiagnosis(text: string, scope: string): string {
  const checks = [
    EXPLICIT_DEPLOYED_ONLY_RE.test(text)
      ? `'deployed-only' token: present`
      : `'deployed-only' token: MISSING — name the property using the literal phrase "deployed-only"`,
    STAGING_LIMIT_RE.test(text)
      ? `staging limitation: present`
      : `staging limitation: MISSING — state what staging/current-build cannot exercise (the words "staging" or "current-build" near "cannot"/"does not"/"unable")`,
    CONCRETE_REASON_RE.test(text)
      ? `concrete reason: present`
      : `concrete reason: MISSING — give it with "because"/"due to"/"since", or name rollback / migration ordering / release packaging / production-only / deployed-host`,
  ];
  return `Narrow-exception check over ${scope} (all three must hold): ${checks.join('; ')}.`;
}

function relatedExceptionText(item: PlanItem, decisions: PlanDecision[]): string {
  return [
    item.text,
    ...applicableDecisions(item, decisions).map((decision) => decisionTextForItem(decision, item)),
  ].join('\n');
}

function hasStrongDeployedGate(text: string): boolean {
  return neutralizePlanIdentifiers(text)
    .split(/\n+|(?<=[.!?])\s+/)
    .some(
      (clause) =>
        DEPLOYED_ENV_RE.test(clause) &&
        (STRONG_GATE_RE.test(clause) || RELEASE_PLANE_UNTIL_RE.test(clause)) &&
        !NEGATED_OR_META_GATE_RE.test(clause),
    );
}

function relatedGateText(plan: ParsedPlan, item: PlanItem): string {
  const ref = itemRefPattern(item.id);
  const now = plan.now?.raw && ref.test(plan.now.raw) ? [itemScopedText(plan.now.raw, item.id)] : [];
  const acceptanceClauses = splitPlanSections(plan.raw)
    .filter((section) => ACCEPTANCE_SECTION_RE.test(section.heading) && ref.test(section.body))
    .map((section) => `${section.heading}\n${itemScopedText(section.body, item.id)}`);
  return [
    item.text,
    ...applicableDecisions(item, plan.decisions).map((decision) => decisionTextForItem(decision, item)),
    ...now,
    ...acceptanceClauses,
  ].join('\n');
}

function isFinalLifecycleItem(item: PlanItem): boolean {
  return FINAL_LIFECYCLE_RE.test(item.text) || FINAL_PHASE_RE.test(item.phase ?? '');
}

/**
 * Admission guard for the direct blocker writer. Plan activation is not the only
 * way an agent can serialize work behind the release plane: `set_blocker` can park
 * an item without a plan. Keep the same narrow exception as the plan guard and
 * allow the actual gate-repair item itself to use a release blocker.
 */
export function stagingFirstBlockerProblem(input: StagingFirstBlockerInput): StagingFirstBlockerProblem | null {
  const blockerText = neutralizePlanIdentifiers(input.blockerText.trim());
  if (!blockerText) return null;
  const stagingOnly = EXPLICIT_STAGING_ENV_RE.test(blockerText) && !MAIN_RELEASE_BLOCKER_RE.test(blockerText);
  if (stagingOnly) return null;
  const releaseRef =
    MAIN_RELEASE_BLOCKER_RE.test(blockerText) ||
    (GENERIC_DEPLOY_BLOCKER_RE.test(blockerText) && !EXPLICIT_STAGING_ENV_RE.test(blockerText));
  const strongGate = hasStrongDeployedGate(blockerText) || (input.kind === 'gate' && releaseRef);
  if (!strongGate) return null;

  const itemText = input.itemText.trim();
  const exceptionText = [blockerText, neutralizePlanIdentifiers(input.exceptionText?.trim() ?? '')]
    .filter(Boolean)
    .join('\n');
  if (hasNonFinalWorkInTitle(itemText) && hasNarrowDeployedMainException(exceptionText)) {
    return {
      itemId: input.itemId,
      code: 'non_final_deployed_main_blocker',
      detail:
        `${input.itemId} still names source implementation or regression work in its title. ` +
        `A deployed-only exception cannot park the whole mixed item. Split the source work ` +
        `from final deployed verification and block only the final item; run source proof on staging/current-build.`,
    };
  }
  // A gate-repair item is itself operating the release plane, so it is not
  // ordinary implementation being serialized behind that plane.
  if (LIVE_GATE_OPERATION_RE.test(itemText)) return null;
  if (isFinalLifecycleText(itemText)) return null;
  // The narrow exception describes THIS blocker, so require all three predicates
  // in the submitted blocker fields (ref, nextVerb, summary, evidence). Do not let
  // the work item's title/summary (which may quote the contract or describe this
  // very defect) launder a generic wait.
  if (hasNarrowDeployedMainException(exceptionText)) return null;

  return {
    itemId: input.itemId,
    code: 'non_final_deployed_main_blocker',
    detail:
      `${input.itemId} is being blocked on main/:3070/green-checkpoint/deployment for non-final work. ` +
      `Continue implementation and non-final verification on staging/current-build. ` +
      `Only use this blocker for a narrow deployed-only property: name that property, explain concretely ` +
      `why staging/current-build cannot exercise it, and retain the deployed wait only for that property. ` +
      narrowExceptionDiagnosis(exceptionText, 'the submitted blocker fields (ref, nextVerb, summary, evidence)'),
  };
}

function isFinalLifecycleText(text: string): boolean {
  return FINAL_LIFECYCLE_RE.test(text) || LIVE_GATE_OPERATION_RE.test(text);
}

/**
 * Activation-time guard for plans that accidentally serialize ordinary implementation
 * behind the release plane. It is deliberately plan-local and conservative: only strong
 * wait/gate language is rejected, while final lifecycle work and a concrete deployed-only
 * exception remain valid.
 */
export function stagingFirstActivationProblems(plan: ParsedPlan): StagingFirstActivationProblem[] {
  const problems: StagingFirstActivationProblem[] = [];

  for (const item of plan.items) {
    if (isTerminalItemStatus(item.storedStatus)) continue;
    if (
      hasNonFinalWorkInTitle(item.text) &&
      item.blockedBy.some((ref) => {
        const blocker = plan.items.find((candidate) => candidate.id === ref);
        // A terminal blocker imposes no wait, even when its text names the release plane.
        if (!blocker || isTerminalItemStatus(blocker.storedStatus)) return false;
        return DEPLOYED_ENV_RE.test(blocker.text);
      })
    ) {
      problems.push({
        itemId: item.id,
        code: 'non_final_deployed_main_wait',
        detail:
          `${item.id} combines source work with final deployed verification behind a release-plane dependency. ` +
          `Split the obligations into separate plan items; block only the final deployed item.`,
      });
      continue;
    }
    if (!hasStrongDeployedGate(relatedGateText(plan, item))) continue;
    if (isFinalLifecycleItem(item)) continue;
    if (hasNarrowDeployedMainException(relatedExceptionText(item, plan.decisions))) continue;

    problems.push({
      itemId: item.id,
      code: 'non_final_deployed_main_wait',
      detail:
        `${item.id} makes main/:3070/green-checkpoint/deployment a prerequisite for non-final implementation. ` +
        `Use staging/current-build for implementation and non-final acceptance, or declare a narrow exception on ` +
        `${item.id} (or a decision linked to it): name the deployed-only property, explain concretely why ` +
        `staging/current-build cannot exercise it, and retain deployed-main verification only for that property. ` +
        narrowExceptionDiagnosis(
          relatedExceptionText(item, plan.decisions),
          `${item.id}'s own text and any decision linked to it`,
        ),
    });
  }

  return problems;
}
