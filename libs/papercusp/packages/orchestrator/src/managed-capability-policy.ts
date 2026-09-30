/**
 * ONE capability policy for every managed-agent launch surface (plan
 * managed-agent-capability-contract-and-native-cutover-2026-09-13, P-005).
 *
 * ## The defect this replaces
 *
 * Before this module the native-capability restrictions were a set of
 * INDEPENDENT deny lists, each hand-composed at each call site:
 *
 *   - `no-subagent-deny.ts`          (Task/Agent/Workflow)
 *   - `native-tool-search-deny.ts`   (ToolSearch)
 *   - `native-scheduler-deny.ts`     (Cron tools, ScheduleWakeup, Skill(...), Bash(crontab:...))
 *   - `owner-desktop-notify-deny.ts` (Bash(notify-send:*))
 *
 * and three surfaces each re-listed the subset they happened to know about:
 *
 *   - `invoke.ts`                    headless LAUNCH   — pushed all four
 *   - `events/await/wake-executor.ts` WAKE/resume      — pushed three
 *   - `apps/operator/scripts/psu-launcher.mjs` su LAUNCH — string literals,
 *                                     a hand-copied second copy of the names
 *
 * They had ALREADY drifted: the wake path re-armed the subagent, tool-search
 * and scheduler denies but NOT the owner-desktop-notify deny, so a woken agent
 * silently regained `notify-send` — a restriction that reads as enforced at
 * every launch and quietly lapses on the first wake. Nothing detected it,
 * because each site read healthy on its own. That is the exact failure mode the
 * repo's derived-truth ladder describes: a second copy of a truth the code
 * already owns WILL drift, and the drift is invisible per-site.
 *
 * ## What this module is
 *
 * The single authority answering "which native capabilities are restricted for
 * THIS client, on THIS surface, for THIS audience, and which are withheld and
 * why". It owns no names of its own: every alias list is IMPORTED from the
 * module that already owned it, so this is a unification, not a fifth copy.
 *
 * Three axes the plan item names explicitly are first-class here rather than
 * implicit in four separate files:
 *
 *   - ALIASES          every spelling of the same native surface (`Task` is
 *                      the pre-rename name of `Agent`; denying one leaves the
 *                      other reachable).
 *   - NESTED EXECUTION the same capability reached THROUGH another tool
 *                      (`Bash(crontab:*)` reaches the OS scheduler without
 *                      touching `CronCreate`). A restriction that denies the
 *                      direct tool and not its nested route is not a
 *                      restriction, it is a speed bump.
 *   - OVERRIDES        an owner opt-in (`--allow-subagents`) or an explicit
 *                      operator-supplied deny list (the D-004 carve-out).
 *
 * ## Replacement-quality gating (the P-005 clause that matters most)
 *
 * A restriction that REMOVES a native capability in favour of a managed one is
 * only safe once the managed replacement is actually proven. That judgement
 * already exists and is already evidence-backed: it is `cutoverReady` on the
 * capability family's entry in `managed-capability-contract.ts`. So a
 * `managed-cutover` restriction is emitted ONLY when its family's disposition
 * says the replacement is proven, and is otherwise withheld with the family's
 * open gaps named.
 *
 * Today every shipped disposition is `cutoverReady: false`, so every cutover
 * restriction is withheld. That is the CORRECT current answer, not a stub:
 * P-007 proves the replacements and P-008 enables the verified defaults. This
 * module's job is to make the gate exist and be honest, not to open it.
 *
 * ## Honest per-client coverage
 *
 * Only claude-code ships a composable `--disallowedTools` deny list. Codex has
 * no equivalent surface, and OMP's tool cut is an ALLOW-list (`fleetOmpToolsArgs`)
 * owned elsewhere. Rendering a claude flag for those clients would be false
 * equivalence, which D-003/D-004 forbid, so the resolver reports them as
 * withheld with the missing mechanism named. A withheld restriction is
 * reported, never silently dropped — that report is what P-007's teaching
 * denials and P-008's parity matrix consume.
 */

import {
  MANAGED_CAPABILITY_DISPOSITIONS,
  MANAGED_CAPABILITY_FAMILY_IDS,
  type ManagedCapabilityDispositionKind,
  type ManagedCapabilityFamilyId,
} from './managed-capability-contract';
import {
  NATIVE_SCHEDULER_SKILL_DENY,
  NATIVE_SCHEDULER_TOOL_DENY,
  OS_SCHEDULER_BASH_DENY,
} from './native-scheduler-deny';
import { NATIVE_TOOL_SEARCH_DENY } from './native-tool-search-deny';
import { NO_SUBAGENT_TOOLS_DENY } from './no-subagent-deny';
import { OWNER_DESKTOP_NOTIFY_BASH_DENY } from './owner-desktop-notify-deny';

/** The agent CLI families a managed launch can target. */
export type CapabilityClientFamily = 'claude' | 'codex' | 'omp';

/**
 * The three moments a policy must be applied.
 *
 * `launch` and `wake` are separate on purpose and NOT an implementation
 * detail: a claude spawn-time `--disallowedTools` does NOT persist into a
 * `--resume`, so a restriction applied only at launch lapses on the first
 * wake. Every surface therefore re-resolves the SAME policy rather than
 * re-listing a remembered subset.
 */
export type CapabilityPolicySurface = 'launch' | 'resume' | 'wake';

/**
 * Who is at the other end. Not cosmetic: the scheduling SKILLS (`/schedule`,
 * `/loop`) are an OWNER affordance the interactive `psu su` collaborator keeps
 * (D-003), while a headless agent loses them. Same restriction id, different
 * audience set — expressed once here instead of as a second deny constant.
 */
export type CapabilityAudience = 'headless-agent' | 'interactive-su';

/**
 * How (or whether) a client can enforce a restriction the policy resolves.
 *
 * `allow-list-cut` and `none` are deliberately distinguished from each other
 * and from a mere absence: "OMP cuts tools by allow-list, owned by
 * fleetOmpToolsArgs" and "codex has no tool-restriction surface at all" are
 * different facts, and a parity matrix that cannot tell them apart will report
 * both as the same gap.
 */
export type CapabilityEnforcementMode = 'deny-list' | 'allow-list-cut' | 'none';

export const CAPABILITY_CLIENT_ENFORCEMENT: Readonly<
  Record<CapabilityClientFamily, CapabilityEnforcementMode>
> = {
  // claude-code unions repeated `--disallowedTools=` occurrences (verified
  // live — see no-subagent-deny.ts), which is what lets independent
  // restrictions compose instead of overwriting each other.
  claude: 'deny-list',
  // OMP cuts the tool surface with an ALLOW list, composed by fleetOmpToolsArgs.
  // That is a different mechanism with different semantics; this policy reports
  // the restriction rather than pretending to render it.
  omp: 'allow-list-cut',
  // codex exposes no host-composable tool-restriction flag.
  codex: 'none',
};

/**
 * Why a restriction exists — and therefore whether replacement quality gates it.
 *
 * `owner-mandate` is a prohibition with no managed replacement to prove: the
 * owner has ruled the native capability out regardless of what we ship. It is
 * NOT gated on the contract, because there is nothing to be ready.
 *
 * `managed-cutover` removes a native capability BECAUSE a managed one replaces
 * it. That one is gated on the family's proven disposition.
 */
export type CapabilityRestrictionAuthority =
  | { readonly kind: 'owner-mandate'; readonly directive: string }
  | { readonly kind: 'managed-cutover' };

/**
 * WHICH native capability family this restriction's denied names belong to
 * (P-006, D-012).
 *
 * Required on EVERY restriction, both authority kinds. Before D-012 the family
 * lived only on the `managed-cutover` authority variant, so all six
 * owner-mandate restrictions named no family at all — and with six of seven
 * restrictions unmapped, "is family X disabled?" was unanswerable and the P-006
 * clause ("every native capability family lacking a semantically equivalent
 * managed adapter remains explicitly retained or unsupported instead of being
 * disabled") could not be checked at all.
 *
 * `outside-r1-taxonomy` is for a native surface the R-1 family list genuinely
 * does not cover. It is a CLAIM that must be stated and read, never a silent
 * omission — which is the whole difference from the unmapped state it replaces.
 */
export type CapabilityRestrictionFamilyScope =
  | { readonly kind: 'contract-family'; readonly family: ManagedCapabilityFamilyId }
  | { readonly kind: 'outside-r1-taxonomy'; readonly note: string };

export interface ManagedCapabilityRestriction {
  readonly id: string;
  /**
   * The family this restriction disables. A `managed-cutover` authority MUST
   * scope to a `contract-family`: there is no such thing as cutting over to a
   * managed replacement for a family the contract does not inventory.
   */
  readonly familyScope: CapabilityRestrictionFamilyScope;
  readonly title: string;
  readonly authority: CapabilityRestrictionAuthority;
  /**
   * Every DIRECT spelling of the native surface, including historical names.
   * All of them, or the restriction is bypassable by using the other one.
   */
  readonly aliases: readonly string[];
  /**
   * Routes reaching the SAME capability through a different tool. Denying
   * `CronCreate` while leaving `Bash(crontab:*)` open restricts nothing.
   */
  readonly nestedRoutes: readonly string[];
  readonly clients: readonly CapabilityClientFamily[];
  readonly surfaces: readonly CapabilityPolicySurface[];
  readonly audiences: readonly CapabilityAudience[];
  /**
   * True when an operator who supplied their own deny list owns the whole
   * posture for this restriction (the D-004 carve-out). False means the
   * restriction composes on top of the operator's list regardless.
   */
  readonly yieldsToExplicitDenyList: boolean;
  /** Owner opt-in that clears this restriction, when one exists. */
  readonly overrideKey?: string;
  readonly rationale: string;
}

const ALL_SURFACES: readonly CapabilityPolicySurface[] = ['launch', 'resume', 'wake'];
const ALL_AUDIENCES: readonly CapabilityAudience[] = ['headless-agent', 'interactive-su'];

/**
 * The restriction table.
 *
 * Every `aliases`/`nestedRoutes` entry is IMPORTED from the module that already
 * owned that list. Adding a name here instead of there would recreate the
 * duplication this module exists to remove.
 */
export const MANAGED_CAPABILITY_RESTRICTIONS: readonly ManagedCapabilityRestriction[] = [
  {
    id: 'no-subagent-fanout',
    familyScope: { kind: 'contract-family', family: 'delegation' },
    title: 'Native subagent/Task fan-out',
    authority: {
      kind: 'owner-mandate',
      directive: 'owner mandate 2026-07-02 — fan-out belongs to the orchestrator spawn graph',
    },
    // 'Task' is the pre-rename spelling of 'Agent'; 'Workflow' is the third
    // door onto the same fan-out. Denying a subset leaves the capability live.
    aliases: NO_SUBAGENT_TOOLS_DENY,
    nestedRoutes: [],
    clients: ['claude'],
    surfaces: ALL_SURFACES,
    audiences: ALL_AUDIENCES,
    // Composes with any operator deny list rather than deferring to it: a bee
    // that can spawn outside the spawn graph is invisible to fleet:assignments.
    yieldsToExplicitDenyList: false,
    overrideKey: 'allow-subagents',
    rationale:
      'A client-native subagent fans work out outside the orchestrator spawn graph: invisible to fleet:assignments, uncontrolled cost, no presence/locks/claims, and it dies with its parent session.',
  },
  {
    id: 'no-native-tool-search',
    familyScope: { kind: 'contract-family', family: 'images-artifacts-skills-discovery' },
    title: 'Native client tool-search / schema deferral',
    authority: {
      kind: 'owner-mandate',
      directive: 'owner directive 2026-09-11 — discovery routes through tools:find / tools:invoke',
    },
    aliases: NATIVE_TOOL_SEARCH_DENY,
    nestedRoutes: [],
    clients: ['claude'],
    surfaces: ALL_SURFACES,
    audiences: ALL_AUDIENCES,
    yieldsToExplicitDenyList: false,
    rationale:
      'Native tool-search loads tool schemas straight into context, bypassing the result door entirely: one measured call loaded six schemas for +67k tokens, 17% of a session budget.',
  },
  {
    id: 'no-owner-desktop-notify',
    // The R-1 taxonomy inventories 13 capability families; owner-facing desktop
    // notification is not one of them. Saying so explicitly is the point: an
    // unmapped restriction and a deliberately-out-of-taxonomy one look identical
    // until one of them says which it is.
    familyScope: {
      kind: 'outside-r1-taxonomy',
      note: 'Owner-facing desktop notification is not one of the 13 R-1 capability families; the owner ruled it out directly, not as a cutover.',
    },
    title: 'Owner desktop notifications from the shell',
    authority: {
      kind: 'owner-mandate',
      directive: 'owner directive 2026-07-14 — no unsolicited desktop notifications',
    },
    aliases: [],
    // Purely nested: there is no direct tool, the capability is only reachable
    // THROUGH Bash. A policy without a nested-route axis cannot express this
    // restriction at all, which is part of why it was the one that drifted.
    nestedRoutes: OWNER_DESKTOP_NOTIFY_BASH_DENY,
    clients: ['claude'],
    surfaces: ALL_SURFACES,
    audiences: ALL_AUDIENCES,
    yieldsToExplicitDenyList: false,
    rationale:
      'Desktop notification shells interrupt the owner directly and bypass the notification surfaces that respect their attention settings.',
  },
  {
    id: 'no-native-scheduler',
    familyScope: { kind: 'contract-family', family: 'schedules-monitors-wakes' },
    title: 'Native client scheduler tools',
    authority: {
      kind: 'owner-mandate',
      directive: 'native-scheduler-lockout-2026-06-09 D-001/D-005 — wakes live in the routines table',
    },
    aliases: NATIVE_SCHEDULER_TOOL_DENY,
    // Deliberately TOOLS-ONLY: the OS-shell routes are a separate restriction
    // below, because they are audience-split and these are not. See there.
    nestedRoutes: [],
    clients: ['claude'],
    surfaces: ALL_SURFACES,
    audiences: ALL_AUDIENCES,
    // D-004: an operator who supplied their own deny list owns the scheduling
    // posture too. This is the ONE restriction with that carve-out, and
    // recording it as data is what stopped it from being a stray `if` at one
    // call site and silently absent at the others.
    yieldsToExplicitDenyList: true,
    rationale:
      'A client-native schedule drifts, dies with the session, and is invisible to the operator; harness routines are tracked, observable and restart-durable.',
  },
  {
    id: 'no-os-scheduler-shell',
    // Scoped to SCHEDULING, not to the shell. The denied names are shell
    // spellings, but the capability removed is the OS scheduler reached through
    // them; scoping this to `shell-ssh-interpreters` would report the shell as
    // disabled while it remains fully available by every other route.
    familyScope: { kind: 'contract-family', family: 'schedules-monitors-wakes' },
    title: 'OS schedulers reached THROUGH the shell',
    authority: {
      kind: 'owner-mandate',
      directive: 'native-scheduler-lockout-2026-06-09 D-001/D-005 — wakes live in the routines table',
    },
    aliases: [],
    // Purely nested: `Bash(crontab:*)` reaches the OS scheduler without ever
    // touching CronCreate, so denying only the tools is a speed bump.
    nestedRoutes: OS_SCHEDULER_BASH_DENY,
    clients: ['claude'],
    surfaces: ALL_SURFACES,
    // SPLIT FROM THE TOOL DENY ON THE AUDIENCE AXIS, and this split is
    // load-bearing rather than cosmetic. `apps/operator/scripts/psu-launcher.mjs`
    // ships the interactive su session a STRICT SUBSET of the scheduler deny
    // (SU_SCHEDULER_TOOLS_DENY_FLAG — the four Cron/ScheduleWakeup TOOLS only)
    // precisely because D-003 keeps the owner-facing surfaces reachable for a
    // human at the keyboard. Folding these routes into the all-audience tool
    // deny would have had this policy hand the su launcher a WIDER restriction
    // than it ships today — and `Bash(systemd-run:*)` is not hypothetical
    // collateral: capability:bash and scripts/verify-tauri-headless.sh both
    // shell out to systemd-run, so su would lose working tooling.
    //
    // This was found by diffing the resolved set against the launcher's real
    // literals BEFORE pinning them together. Pinning first would have recorded
    // agreement with a policy that silently widened su's posture, which is the
    // failure a pin test is supposed to prevent rather than cause.
    audiences: ['headless-agent'],
    yieldsToExplicitDenyList: true,
    rationale:
      'The OS scheduler is reachable through the shell without touching any client scheduling tool; a headless agent has no owner at the keyboard who needs that route.',
  },
  {
    id: 'no-native-scheduler-skills',
    familyScope: { kind: 'contract-family', family: 'schedules-monitors-wakes' },
    title: 'Native scheduling SKILLS (/schedule, /loop)',
    authority: {
      kind: 'owner-mandate',
      directive: 'native-scheduler-lockout-2026-06-09 D-003 — the human keeps the slash-command surface',
    },
    aliases: NATIVE_SCHEDULER_SKILL_DENY,
    nestedRoutes: [],
    clients: ['claude'],
    surfaces: ALL_SURFACES,
    // Split from the tool deny for exactly one reason: these are what a HUMAN
    // types. Denying them to the interactive su collaborator would remove an
    // owner affordance (D-003), so the audience axis carries the distinction
    // that previously needed a separate `suSchedulerToolsDenyFlag` constant.
    audiences: ['headless-agent'],
    yieldsToExplicitDenyList: true,
    rationale:
      'The scheduling skills are the owner-facing form of the same capability; a headless agent has no owner at the keyboard to invoke them.',
  },
  {
    id: 'managed-shell-cutover',
    familyScope: { kind: 'contract-family', family: 'shell-ssh-interpreters' },
    title: 'Native shell in favour of managed capability:bash',
    authority: { kind: 'managed-cutover' },
    aliases: ['Bash'],
    nestedRoutes: [],
    clients: ['claude'],
    surfaces: ALL_SURFACES,
    audiences: ALL_AUDIENCES,
    yieldsToExplicitDenyList: true,
    rationale:
      'capability:bash replaces the native shell with a start-once managed job carrying a durable task envelope, separate response/execution deadlines and permitted full-log retention. Withheld until that replacement is proven at parity — removing the native shell before then strands the agent.',
  },
];

export type CapabilityWithheldReason =
  | 'client-not-covered'
  | 'surface-not-covered'
  | 'audience-not-covered'
  | 'no-client-enforcement-surface'
  | 'owner-override'
  | 'explicit-deny-list'
  | 'replacement-unproven'
  /**
   * The replacement is proven at parity, but THIS client/family pair has no
   * adoption evidence for both control arms (P-007,
   * CAP-CONTRACT-P007-CUTOVER-EVIDENCE@1). Parity is a property of the adapter;
   * acceptance is a property of the adapter AT a client, and the clause is
   * quantified over the second one.
   */
  | 'adoption-unproven'
  /**
   * Staged rollout withheld it: the family's cutover stage is `off`, or it is
   * `canary` and this audience is outside the canary population. This is the
   * ROLLBACK control — flipping the stage back to `off` withholds an already
   * enabled cutover on the next resolve, with no table edit.
   */
  | 'cutover-stage-withheld'
  /**
   * The client version moved since the acceptance evidence was taken, so the
   * native surface this restriction claims to cover may have been respelled.
   * Stale acceptance is not acceptance.
   */
  | 'client-version-drift'
  /**
   * The isolated real-client matrix has not passed every DECLARED scenario for
   * this family/client (P-008, CAP-CONTRACT-P008-REAL-CLIENT-MATRIX@1).
   *
   * Distinct from `adoption-unproven`, and deliberately checked after it:
   * adoption asks whether the two control arms were ever observed at this
   * client at all, while this asks whether the full declared scenario set —
   * launch, resume, wake, recovery, lifecycle, sandbox, native-disable — is
   * green, fresh, on THIS version, and still fingerprint-identical to what the
   * default was enabled against. Two proven arms on a launch are not evidence
   * about recovery or sandboxing.
   */
  | 'matrix-scenario-unproven';

export interface CapabilityWithheldRestriction {
  readonly id: string;
  readonly reason: CapabilityWithheldReason;
  /** Human-readable specifics — the teaching text P-007 surfaces on a denial. */
  readonly detail: string;
}

export interface CapabilityPolicyRequest {
  readonly client: CapabilityClientFamily;
  readonly surface: CapabilityPolicySurface;
  readonly audience?: CapabilityAudience;
  /** Owner opt-ins that clear a restriction carrying the matching `overrideKey`. */
  readonly overrides?: readonly string[];
  /** True when the caller's command already carries its own `--disallowedTools`. */
  readonly explicitDenyList?: boolean;
  /**
   * Replacement-readiness source. Defaults to the shipped contract; injectable
   * so a test can prove BOTH sides of the gate without waiting for a real
   * cutover, and so P-008 can drive it from measured evidence.
   */
  readonly readiness?: CapabilityReadinessSource;
  /**
   * Per-client/family acceptance telemetry. Defaults to EMPTY, which denies
   * every cutover on adoption grounds — the fail-safe reading, and the reason
   * this gate cannot be satisfied by forgetting to pass it.
   */
  readonly adoption?: CapabilityAdoptionGateSource;
  /**
   * Isolated real-client matrix verdicts (P-008). Defaults to EMPTY for the
   * same fail-safe reason as `adoption`: a caller who forgets to supply the
   * matrix must not thereby enable a managed default, because "missing" is the
   * FIRST word of this clause's falsifier.
   */
  readonly matrix?: CapabilityMatrixGateSource;
  /**
   * Per-family rollout stage. Defaults to `SHIPPED_CUTOVER_STAGING` (all off).
   */
  readonly cutoverStaging?: CapabilityCutoverStaging;
  /**
   * The client versions currently in play. When a version is supplied here and
   * the matching adoption entry names a DIFFERENT `atClientVersion`, the
   * acceptance is stale and the cutover is withheld. An UNKNOWN current version
   * does not invalidate acceptance — absence of a measurement is not evidence
   * of drift — so this narrows the gate only when the version is actually known.
   */
  readonly clientVersions?: Readonly<Partial<Record<CapabilityClientFamily, string>>>;
}

/** Minimal shape the gate needs from a disposition — family, readiness, gaps. */
export interface CapabilityReadinessEntry {
  readonly family: ManagedCapabilityFamilyId;
  readonly cutoverReady: boolean;
  readonly openGapIds: readonly string[];
}

export type CapabilityReadinessSource = readonly CapabilityReadinessEntry[];

/**
 * Readiness derived from the shipped contract. DERIVED, never hand-set: the
 * contract's `cutoverReady` is the evidence-backed judgement, and restating it
 * here would be the same duplication this module removes.
 */
export const CONTRACT_CAPABILITY_READINESS: CapabilityReadinessSource =
  MANAGED_CAPABILITY_DISPOSITIONS.map((entry) => ({
    family: entry.family,
    cutoverReady: entry.cutoverReady,
    openGapIds: entry.gaps.map((gap) => gap.id),
  }));

/**
 * Minimal shape the gate needs from adoption telemetry — the TWO control arms,
 * per client AND family.
 *
 * Same seam, and the same reason, as `CapabilityReadinessEntry` above: the
 * report that produces these entries lives in `managed-capability-adoption.ts`
 * and imports this module, so the gate accepts the shape rather than importing
 * the producer. That keeps the dependency one-directional and lets a test drive
 * both sides of the gate without a real client.
 *
 * WHY BOTH ARMS, never one: a managed-path success alone proves the replacement
 * works but says nothing about whether the native route is still open (a
 * restriction that denies nothing); a bypass refusal alone proves the native
 * route is shut but not that anything took its place (a stranded agent). Only
 * the conjunction is acceptance, which is exactly what
 * CAP-CONTRACT-P007-CUTOVER-EVIDENCE@1 quantifies over.
 */
export interface CapabilityAdoptionEntry {
  readonly client: CapabilityClientFamily;
  readonly family: ManagedCapabilityFamilyId;
  /** A managed-path invocation was observed SUCCEEDING at this client. */
  readonly managedPathProven: boolean;
  /** A native-bypass attempt was observed being REFUSED at this client. */
  readonly nativeBypassRefused: boolean;
  /**
   * The client version both observations were taken at. Compared against
   * `CapabilityPolicyRequest.clientVersions` so acceptance cannot outlive the
   * surface it was measured on.
   */
  readonly atClientVersion?: string;
}

export type CapabilityAdoptionGateSource = readonly CapabilityAdoptionEntry[];

/** One unmet cell, carried so a denial can name WHICH scenario and WHY. */
export interface CapabilityMatrixUnmetScenario {
  readonly scenarioId: string;
  /**
   * The four falsifier words, plus `enablement-drift` for a scenario that
   * passes but whose fingerprint no longer matches the record the default was
   * enabled against. Kept as a string rather than a union so the producer owns
   * the vocabulary and this module stays a consumer of the shape.
   */
  readonly status: string;
  readonly detail: string;
}

/**
 * Minimal shape the gate needs from the real-client matrix (P-008).
 *
 * Same seam and same rationale as `CapabilityReadinessEntry` and
 * `CapabilityAdoptionEntry` above: the producer
 * (`managed-capability-matrix.ts`) imports THIS module, so the gate accepts a
 * shape instead of importing the producer. That keeps the dependency
 * one-directional and lets a test drive both sides of the gate without booting
 * a real client.
 */
export interface CapabilityMatrixEntry {
  readonly client: CapabilityClientFamily;
  readonly family: ManagedCapabilityFamilyId;
  /**
   * Every declared scenario for this family/client passed, is fresh, ran on
   * this client version, and still matches the enablement record.
   *
   * The producer sets this FALSE for an empty declared set: "no scenario was
   * declared" is not "every scenario passed". A vacuous truth here would open
   * the gate for precisely the family whose matrix nobody wrote.
   */
  readonly allScenariosPassed: boolean;
  /** How many scenarios the manifest declared — 0 is itself a defect. */
  readonly declaredScenarioCount: number;
  readonly unmet: readonly CapabilityMatrixUnmetScenario[];
}

export type CapabilityMatrixGateSource = readonly CapabilityMatrixEntry[];

/**
 * How far a family's cutover has been rolled out.
 *
 * Reuses the EXISTING controls the item text requires rather than adding a
 * parallel rollout system: the population is expressed with the audience axis
 * the restriction table and resolver already carry, and rollback is this dial
 * returning to `off` (or the restriction's existing `overrideKey`). No flag, no
 * new config surface, no second deny path.
 */
export type CapabilityCutoverStage = 'off' | 'canary' | 'full';

export type CapabilityCutoverStaging = Readonly<
  Partial<Record<ManagedCapabilityFamilyId, CapabilityCutoverStage>>
>;

/**
 * The audiences a stage admits.
 *
 * `canary` is ATTENDED-ONLY on purpose. `interactive-su` has a human in the
 * loop who notices and reports a stranded capability within one turn; a
 * headless agent hits the same wall with nobody watching and burns its whole
 * budget routing around it. So the canary population is the one that can
 * actually report, not merely the smaller one.
 */
export function cutoverStageAudiences(
  stage: CapabilityCutoverStage,
): readonly CapabilityAudience[] {
  if (stage === 'off') return [];
  if (stage === 'canary') return ['interactive-su'];
  return ALL_AUDIENCES;
}

/**
 * The shipped staging position: every family `off`.
 *
 * Fail-SAFE and deliberately not derived from readiness — a family reaching
 * parity must not thereby enable its own restriction fleet-wide. Enabling is a
 * separate, stated act (P-008 supplies the measured evidence; this dial admits
 * it in stages).
 */
export const SHIPPED_CUTOVER_STAGING: CapabilityCutoverStaging = Object.freeze({});

export interface AppliedCapabilityRestriction {
  readonly id: string;
  readonly authorityKind: CapabilityRestrictionAuthority['kind'];
  /**
   * The family these names belong to, carried on the DECISION so a caller can
   * trace a denied native name back to a capability family without re-reading
   * the table (P-007's teaching text and the retention census both need this).
   */
  readonly familyScope: CapabilityRestrictionFamilyScope;
  /** Aliases + nested routes, in table order, deduped. */
  readonly deniedNames: readonly string[];
}

export interface CapabilityPolicyDecision {
  readonly client: CapabilityClientFamily;
  readonly surface: CapabilityPolicySurface;
  readonly audience: CapabilityAudience;
  readonly enforcement: CapabilityEnforcementMode;
  readonly applied: readonly AppliedCapabilityRestriction[];
  readonly withheld: readonly CapabilityWithheldRestriction[];
  /** The flat union of every applied restriction's names, deduped, stable order. */
  readonly deniedNames: readonly string[];
  /**
   * Ready-to-append argv tokens for this client. Empty for a client with no
   * deny-list surface — never a claude flag rendered at a client that cannot
   * consume it.
   */
  readonly flags: readonly string[];
}

function readinessFor(
  source: CapabilityReadinessSource,
  family: ManagedCapabilityFamilyId,
): CapabilityReadinessEntry | undefined {
  return source.find((entry) => entry.family === family);
}

/**
 * Resolve the single policy for one client/surface/audience.
 *
 * Pure and total: every restriction in the table lands in exactly one of
 * `applied` or `withheld`, so a caller can always account for the full set and
 * a silently-dropped restriction is not representable.
 */
export function resolveCapabilityPolicy(
  request: CapabilityPolicyRequest,
  restrictions: readonly ManagedCapabilityRestriction[] = MANAGED_CAPABILITY_RESTRICTIONS,
): CapabilityPolicyDecision {
  const audience: CapabilityAudience = request.audience ?? 'headless-agent';
  const overrides = new Set(request.overrides ?? []);
  const readiness = request.readiness ?? CONTRACT_CAPABILITY_READINESS;
  const adoption = request.adoption ?? [];
  // Fail-safe empty, exactly like `adoption`: "missing" is the first word of
  // this clause's falsifier, so a caller who omits the matrix must not thereby
  // enable a managed default.
  const matrix = request.matrix ?? [];
  const staging = request.cutoverStaging ?? SHIPPED_CUTOVER_STAGING;
  const currentClientVersion = request.clientVersions?.[request.client];
  const enforcement = CAPABILITY_CLIENT_ENFORCEMENT[request.client];

  const applied: AppliedCapabilityRestriction[] = [];
  const withheld: CapabilityWithheldRestriction[] = [];

  for (const restriction of restrictions) {
    if (!restriction.clients.includes(request.client)) {
      withheld.push({
        id: restriction.id,
        reason: 'client-not-covered',
        detail: `${restriction.id} is declared for ${restriction.clients.join(', ') || 'no client'}; this launch is ${request.client}.`,
      });
      continue;
    }
    if (!restriction.surfaces.includes(request.surface)) {
      withheld.push({
        id: restriction.id,
        reason: 'surface-not-covered',
        detail: `${restriction.id} does not apply on the ${request.surface} surface.`,
      });
      continue;
    }
    if (!restriction.audiences.includes(audience)) {
      withheld.push({
        id: restriction.id,
        reason: 'audience-not-covered',
        detail: `${restriction.id} is withheld for the ${audience} audience (${restriction.rationale}).`,
      });
      continue;
    }
    if (restriction.overrideKey && overrides.has(restriction.overrideKey)) {
      withheld.push({
        id: restriction.id,
        reason: 'owner-override',
        detail: `The owner opted in via '${restriction.overrideKey}', which clears ${restriction.id}.`,
      });
      continue;
    }
    if (restriction.yieldsToExplicitDenyList && request.explicitDenyList) {
      withheld.push({
        id: restriction.id,
        reason: 'explicit-deny-list',
        detail: `An operator-supplied deny list owns this posture, so ${restriction.id} defers to it (D-004).`,
      });
      continue;
    }
    if (restriction.authority.kind === 'managed-cutover') {
      const scope = restriction.familyScope;
      if (scope.kind !== 'contract-family') {
        // A cutover to a managed replacement for a family the contract does not
        // inventory is not expressible: there is no disposition to read a
        // readiness verdict from. Fail SAFE — withhold it, never apply a
        // restriction whose replacement claim cannot be checked (D-012).
        withheld.push({
          id: restriction.id,
          reason: 'replacement-unproven',
          detail:
            `${restriction.id} claims a managed cutover but is scoped outside the R-1 family taxonomy ` +
            `(${scope.note}), so no readiness verdict exists for it. A malformed cutover is withheld, never applied.`,
        });
        continue;
      }
      const entry = readinessFor(readiness, scope.family);
      if (!entry?.cutoverReady) {
        const gaps = entry?.openGapIds ?? [];
        withheld.push({
          id: restriction.id,
          reason: 'replacement-unproven',
          detail:
            `The managed replacement for '${scope.family}' is not proven at parity yet` +
            (gaps.length ? `; open gaps: ${gaps.join(', ')}.` : '.') +
            ' Restricting the native surface now would strand the agent.',
        });
        continue;
      }

      // Parity is proven. Everything below is P-007: parity is a property of
      // the ADAPTER, while enabling a restriction is a claim about the adapter
      // AT A CLIENT, on a KNOWN surface version, for a CHOSEN population. Each
      // of those is checked separately so a failure names which one it was.
      const stage = staging[scope.family] ?? 'off';
      const stageAudiences = cutoverStageAudiences(stage);
      if (!stageAudiences.includes(audience)) {
        withheld.push({
          id: restriction.id,
          reason: 'cutover-stage-withheld',
          detail:
            stage === 'off'
              ? `The '${scope.family}' cutover stage is 'off', so ${restriction.id} is not enabled. ` +
                'Parity alone never enables a restriction; staging it is a separate, stated act.'
              : `The '${scope.family}' cutover is at the '${stage}' stage, which admits ` +
                `${stageAudiences.join(', ')} only; this launch is ${audience}.`,
        });
        continue;
      }

      const adoptionEntry = adoption.find(
        (candidate) => candidate.client === request.client && candidate.family === scope.family,
      );
      if (
        !adoptionEntry ||
        !adoptionEntry.managedPathProven ||
        !adoptionEntry.nativeBypassRefused
      ) {
        const missing: string[] = [];
        if (!adoptionEntry?.managedPathProven) missing.push('a successful managed-path observation');
        if (!adoptionEntry?.nativeBypassRefused) missing.push('a refused native-bypass observation');
        withheld.push({
          id: restriction.id,
          reason: 'adoption-unproven',
          detail:
            `Cutover of '${scope.family}' at ${request.client} lacks ${missing.join(' and ')}` +
            `${adoptionEntry ? '' : ' (no adoption telemetry recorded for this client/family at all)'}. ` +
            'Both control arms are required before the native surface is restricted ' +
            '(CAP-CONTRACT-P007-CUTOVER-EVIDENCE).',
        });
        continue;
      }

      if (
        currentClientVersion !== undefined &&
        adoptionEntry.atClientVersion !== undefined &&
        adoptionEntry.atClientVersion !== currentClientVersion
      ) {
        withheld.push({
          id: restriction.id,
          reason: 'client-version-drift',
          detail:
            `Acceptance for '${scope.family}' at ${request.client} was measured on version ` +
            `'${adoptionEntry.atClientVersion}', but this launch is version '${currentClientVersion}'. ` +
            'A version change can respell the native surface, so the alias coverage this ' +
            'restriction claims is no longer evidenced. Re-measure both arms.',
        });
        continue;
      }

      // P-008, and the LAST gate before a managed default is enabled:
      // CAP-CONTRACT-P008-REAL-CLIENT-MATRIX@1 requires that the full declared
      // scenario set has actually been executed in isolated client profiles.
      // Placed last on purpose — every gate above names a cheaper, more
      // specific defect, so a reader gets the narrowest true reason rather
      // than "the matrix is red" when the real answer is "this family has no
      // parity yet".
      const matrixEntry = matrix.find(
        (candidate) => candidate.client === request.client && candidate.family === scope.family,
      );
      if (!matrixEntry || !matrixEntry.allScenariosPassed) {
        const unmet = matrixEntry?.unmet ?? [];
        withheld.push({
          id: restriction.id,
          reason: 'matrix-scenario-unproven',
          detail:
            `The isolated real-client matrix for '${scope.family}' at ${request.client} has not passed ` +
            `every declared scenario` +
            (matrixEntry
              ? matrixEntry.declaredScenarioCount === 0
                ? ': the manifest declares NO scenario for this family/client, which is itself unproven — ' +
                  'an empty matrix is never a passing one.'
                : `; unmet: ${
                    unmet.length
                      ? unmet.map((row) => `${row.scenarioId} (${row.status})`).join(', ')
                      : 'none reported, yet the matrix is not green — treat the producer as faulty'
                  }.`
              : ' (no matrix verdict was supplied for this client/family at all).') +
            ' A managed default may not be enabled until launch, resume, wake, recovery, lifecycle, ' +
            'sandbox and native-disable all pass on this client version ' +
            '(CAP-CONTRACT-P008-REAL-CLIENT-MATRIX).',
        });
        continue;
      }
    }
    if (enforcement !== 'deny-list') {
      withheld.push({
        id: restriction.id,
        reason: 'no-client-enforcement-surface',
        detail:
          enforcement === 'allow-list-cut'
            ? `${request.client} restricts tools by allow-list cut (owned by the OMP tools args), not by a composable deny list, so ${restriction.id} cannot be rendered as a deny flag here.`
            : `${request.client} exposes no host-composable tool-restriction surface, so ${restriction.id} cannot be enforced at launch.`,
      });
      continue;
    }

    const deniedNames = dedupe([...restriction.aliases, ...restriction.nestedRoutes]);
    applied.push({
      id: restriction.id,
      authorityKind: restriction.authority.kind,
      familyScope: restriction.familyScope,
      deniedNames,
    });
  }

  const deniedNames = dedupe(applied.flatMap((entry) => entry.deniedNames));

  return {
    client: request.client,
    surface: request.surface,
    audience,
    enforcement,
    applied,
    withheld,
    deniedNames,
    // One `--disallowedTools=` token PER restriction, not one merged token.
    // claude unions repeated occurrences, and keeping them separate means a
    // single restriction stays individually greppable in a captured command
    // line — which is how the wake/launch drift was finally visible at all.
    // Single `=` token: the space form is variadic and would swallow a
    // following positional (the wake path appends the wake text positionally).
    flags: applied.map((entry) => `--disallowedTools=${entry.deniedNames.join(',')}`),
  };
}

function dedupe(names: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * The argv tokens for one client/surface — the ergonomic form every call site
 * uses in place of its hand-listed sequence of `*DenyFlag()` pushes.
 */
export function capabilityPolicyFlags(request: CapabilityPolicyRequest): readonly string[] {
  return resolveCapabilityPolicy(request).flags;
}

/**
 * Is the native schema deferral reachable under the resolved policy?
 *
 * DERIVED from the decision rather than hand-set, preserving the invariant
 * `native-tool-search-deny.ts` established: denying `ToolSearch` while also
 * setting `ENABLE_TOOL_SEARCH=true` asks the client to engage a mechanism whose
 * only working part was removed. Both halves shipped independently and
 * contradicted each other in production for four days because each read healthy
 * alone; deriving one from the other makes that state unrepresentable.
 */
export function policyDeferralReachable(decision: CapabilityPolicyDecision): boolean {
  return !decision.deniedNames.includes('ToolSearch');
}

/**
 * The conditional claude env keys whose MEANING depends on deferral being
 * reachable. Returns `{}` when it is not, so a caller spreading this can never
 * emit the contradiction.
 */
export function policyDeferralEnv(
  decision: CapabilityPolicyDecision,
): { ENABLE_TOOL_SEARCH?: 'true' } {
  return policyDeferralReachable(decision) ? { ENABLE_TOOL_SEARCH: 'true' } : {};
}

/* -------------------------------------------------------------------------- *
 * Retention census — P-006 / D-012
 *
 * The clause this answers, verbatim: "Every native capability family lacking a
 * semantically equivalent managed adapter remains explicitly retained or
 * unsupported instead of being disabled."
 *
 * Two words make it a MEASUREMENT rather than a slogan, and both need this
 * module to supply them:
 *
 *  - "every family" — so the census iterates MANAGED_CAPABILITY_FAMILY_IDS, the
 *    declared id list, NOT the disposition array. A family added to the
 *    taxonomy and forgotten in the inventory is then a reported violation
 *    rather than a row that silently never existed. Iterating the inventory
 *    would make the census agree with whatever it happened to contain.
 *  - "instead of being disabled" — disablement is a property of the resolved
 *    DECISION, not of the table. A restriction that is withheld in every
 *    context disables nothing, so the census resolves the full
 *    client × surface × audience space and reads what actually applied.
 * -------------------------------------------------------------------------- */

export type NativeFamilyRetentionOutcome =
  /** A proven-equivalent managed adapter exists: a cutover may remove the native surface. */
  | 'managed-cutover-eligible'
  /** No proven equivalent: the native surface stays, with the contract's stated boundary. */
  | 'retained'
  /** Explicitly not offered at all — the honest disposition, not a silent absence. */
  | 'unsupported';

/**
 * The minimum the census needs from a disposition.
 *
 * Deliberately accepted as an INPUT rather than read only from the shipped
 * contract: `ManagedCapabilityDisposition.cutoverReady` is the literal type
 * `false`, so with the contract alone the proven-equivalent branch of the rule
 * would be unreachable and every test of it vacuous. This is the same seam, and
 * the same reason, as `CapabilityPolicyRequest.readiness`.
 */
export interface CapabilityRetentionDispositionInput {
  readonly family: ManagedCapabilityFamilyId;
  readonly disposition: ManagedCapabilityDispositionKind;
  readonly boundary: string;
  /**
   * The managed tools that actually back this family. Required by the census
   * because "semantically equivalent managed adapter" has to name SOMETHING: a
   * family declared ready with an empty authority list is a cutover to nothing,
   * which is the false equivalence the item text forbids — and it would
   * otherwise read as the most permissive outcome the census can assign.
   */
  readonly managedAuthorities: readonly string[];
  readonly cutoverReady: boolean;
  readonly gaps: readonly { readonly id: string }[];
}

export interface NativeFamilyDisablement {
  readonly restrictionId: string;
  readonly authorityKind: CapabilityRestrictionAuthority['kind'];
  /** `client/surface/audience` strings in which this restriction actually applied. */
  readonly contexts: readonly string[];
  readonly deniedNames: readonly string[];
}

export interface NativeFamilyRetention {
  readonly family: ManagedCapabilityFamilyId;
  readonly disposition: ManagedCapabilityDispositionKind | 'no-recorded-disposition';
  /** The contract's explicit managed/native line. An empty one is a violation. */
  readonly boundary: string;
  readonly cutoverReady: boolean;
  readonly openGapIds: readonly string[];
  readonly outcome: NativeFamilyRetentionOutcome;
  readonly disabledBy: readonly NativeFamilyDisablement[];
  readonly violations: readonly string[];
}

/**
 * Every (client, family) pair proven on both arms, over the DECLARED family
 * list rather than the supplied inventory.
 *
 * Totality matters here for the same reason it does in the census itself: a
 * saturation derived from a truncated `dispositions` input would leave the
 * omitted families ungated, and the census would then report them as "not
 * disabled" because the adoption gate withheld their restriction — an absence
 * indistinguishable from a genuine retention verdict.
 */
function saturatedAdoptionFor(
  clients: readonly CapabilityClientFamily[],
  _dispositions: readonly CapabilityRetentionDispositionInput[],
): CapabilityAdoptionGateSource {
  const out: CapabilityAdoptionEntry[] = [];
  for (const client of clients) {
    for (const family of MANAGED_CAPABILITY_FAMILY_IDS) {
      out.push({ client, family, managedPathProven: true, nativeBypassRefused: true });
    }
  }
  return out;
}

/** Every declared family staged `full`. Same totality argument as above. */
/**
 * A matrix source that holds the P-008 dimension at "not the blocker".
 *
 * WHY THIS IS EXPORTED AND SHARED. Two callers need it, for the same reason
 * and with the same hazard. The retention census asks "which native family is
 * still RETAINED", and the adoption report (P-007) asks "for every pair where
 * cutover is INTENDED, are both control arms proven". Both answer their
 * question by asking `resolveCapabilityPolicy` what it applied — so if the
 * P-008 matrix gate is left at its fail-safe empty default, it withholds
 * everything and both callers report an empty population instead of the
 * disposition they exist to report. That would silently make P-007's
 * already-accepted clause vacuous, which is the opposite of adding evidence.
 *
 * So each caller saturates every dimension it is NOT measuring, exactly as it
 * already does for `adoption`, and this is the single definition both use —
 * a second copy would be the hand-maintained duplication the derived-truth
 * ladder warns about.
 *
 * `declaredScenarioCount` is -1 on purpose: this source is an ASSUMPTION, not
 * a measurement, and a fabricated plausible count would be indistinguishable
 * from a real one. The gate reads `allScenariosPassed`, so the sentinel is
 * inert to it and loud to a reader.
 */
export function saturatedCapabilityMatrix(
  clients: readonly CapabilityClientFamily[],
  families: readonly ManagedCapabilityFamilyId[] = MANAGED_CAPABILITY_FAMILY_IDS,
): CapabilityMatrixGateSource {
  const out: CapabilityMatrixEntry[] = [];
  for (const client of clients) {
    for (const family of families) {
      out.push({
        client,
        family,
        allScenariosPassed: true,
        declaredScenarioCount: -1,
        unmet: [],
      });
    }
  }
  return out;
}

function fullStagingFor(
  _dispositions: readonly CapabilityRetentionDispositionInput[],
): CapabilityCutoverStaging {
  const out: Partial<Record<ManagedCapabilityFamilyId, CapabilityCutoverStage>> = {};
  for (const family of MANAGED_CAPABILITY_FAMILY_IDS) out[family] = 'full';
  return out;
}

export interface CapabilityRetentionCensusOptions {
  readonly dispositions?: readonly CapabilityRetentionDispositionInput[];
  readonly restrictions?: readonly ManagedCapabilityRestriction[];
  readonly readiness?: CapabilityReadinessSource;
  /**
   * The P-007 acceptance dimension. Defaults to SATURATED — see the call site
   * in `capabilityRetentionCensus` for why this census must not inherit the
   * gate's fail-safe default.
   */
  readonly adoption?: CapabilityAdoptionGateSource;
  /**
   * The P-008 acceptance dimension. Defaults to SATURATED for exactly the
   * reason `adoption` does: this census answers "which native family is still
   * RETAINED", and inheriting the gate's fail-safe empty default would report
   * every family as retained-because-its-matrix-is-missing, burying the
   * disposition the census exists to report. A caller measuring real matrix
   * state passes it explicitly.
   */
  readonly matrix?: CapabilityMatrixGateSource;
  /** The P-007 rollout dimension. Defaults to every declared family `full`. */
  readonly cutoverStaging?: CapabilityCutoverStaging;
  readonly clients?: readonly CapabilityClientFamily[];
  readonly surfaces?: readonly CapabilityPolicySurface[];
  readonly audiences?: readonly CapabilityAudience[];
  readonly overrides?: readonly string[];
  readonly explicitDenyList?: boolean;
}

export interface CapabilityRetentionCensus {
  /** One entry per declared family id, in declaration order. Always total. */
  readonly families: readonly NativeFamilyRetention[];
  /** Flat union of every family's violations. Empty is the shipped invariant. */
  readonly violations: readonly string[];
  /** Table-shape faults: a scope that cannot be honoured as written. */
  readonly malformedRestrictions: readonly string[];
  /** Restrictions claiming a native surface outside the R-1 taxonomy — a claim to review, not a fault. */
  readonly outsideTaxonomyRestrictionIds: readonly string[];
  /** How many client/surface/audience contexts were resolved. 0 would make the census vacuous. */
  readonly contextsMeasured: number;
}

function retentionOutcome(
  disposition: ManagedCapabilityDispositionKind | 'no-recorded-disposition',
  cutoverReady: boolean,
): NativeFamilyRetentionOutcome {
  if (disposition === 'unsupported-gap') return 'unsupported';
  if (
    cutoverReady &&
    (disposition === 'managed-execution' || disposition === 'managed-backed-native-interface')
  ) {
    return 'managed-cutover-eligible';
  }
  // Includes 'no-recorded-disposition': the fail-SAFE reading. An unrecorded
  // family is treated as retained, so nothing may disable it while the omission
  // is also reported — never the other way round.
  return 'retained';
}

/**
 * Resolve the retention position of every native capability family.
 *
 * Pure. Defaults to the shipped contract, policy table and the full decision
 * space; every input is injectable so both sides of the rule are provable.
 */
export function capabilityRetentionCensus(
  options: CapabilityRetentionCensusOptions = {},
): CapabilityRetentionCensus {
  const dispositions: readonly CapabilityRetentionDispositionInput[] =
    options.dispositions ?? MANAGED_CAPABILITY_DISPOSITIONS;
  const restrictions = options.restrictions ?? MANAGED_CAPABILITY_RESTRICTIONS;
  const readiness: CapabilityReadinessSource =
    options.readiness ??
    dispositions.map((entry) => ({
      family: entry.family,
      cutoverReady: entry.cutoverReady,
      openGapIds: entry.gaps.map((gap) => gap.id),
    }));
  // DERIVED from the enforcement map rather than a second hand-kept client list,
  // so a client added there is measured here without touching this function.
  const clients =
    options.clients ?? (Object.keys(CAPABILITY_CLIENT_ENFORCEMENT) as CapabilityClientFamily[]);
  const surfaces = options.surfaces ?? ALL_SURFACES;
  const audiences = options.audiences ?? ALL_AUDIENCES;

  const hits: { context: string; applied: AppliedCapabilityRestriction }[] = [];
  let contextsMeasured = 0;
  for (const client of clients) {
    for (const surface of surfaces) {
      for (const audience of audiences) {
        contextsMeasured += 1;
        const decision = resolveCapabilityPolicy(
          {
            client,
            surface,
            audience,
            readiness,
            overrides: options.overrides,
            explicitDenyList: options.explicitDenyList,
            // The P-007 dimensions are held at their PERMISSIVE end by default
            // so this census keeps measuring its OWN rule. The retention rule
            // asks "given readiness, which families end up disabled?"; if the
            // adoption gate and the staging dial defaulted to their fail-safe
            // (closed) end here, every decision would apply nothing, the census
            // would answer "no family is ever disabled" for any input, and its
            // falsifiability controls would pass vacuously — a green reading
            // produced by measuring nothing. Acceptance is measured by
            // `capabilityAdoptionReport` instead; both remain injectable.
            adoption: options.adoption ?? saturatedAdoptionFor(clients, dispositions),
            matrix: options.matrix ?? saturatedCapabilityMatrix(clients),
            cutoverStaging: options.cutoverStaging ?? fullStagingFor(dispositions),
          },
          restrictions,
        );
        for (const applied of decision.applied) {
          hits.push({ context: `${client}/${surface}/${audience}`, applied });
        }
      }
    }
  }

  const knownFamilies = new Set<string>(MANAGED_CAPABILITY_FAMILY_IDS);
  const malformedRestrictions: string[] = [];
  const outsideTaxonomyRestrictionIds: string[] = [];
  for (const restriction of restrictions) {
    const scope = restriction.familyScope;
    if (!scope) {
      malformedRestrictions.push(`${restriction.id}:missing-family-scope`);
      continue;
    }
    if (scope.kind === 'outside-r1-taxonomy') {
      outsideTaxonomyRestrictionIds.push(restriction.id);
      if (!scope.note?.trim()) {
        malformedRestrictions.push(`${restriction.id}:outside-taxonomy-without-note`);
      }
      if (restriction.authority.kind === 'managed-cutover') {
        // There is no disposition to read a readiness verdict from, so the
        // cutover claim is uncheckable. resolveCapabilityPolicy withholds it;
        // the census says why out loud instead of leaving it merely absent.
        malformedRestrictions.push(`${restriction.id}:managed-cutover-outside-taxonomy`);
      }
      continue;
    }
    if (!knownFamilies.has(scope.family)) {
      malformedRestrictions.push(`${restriction.id}:unknown-family:${scope.family}`);
    }
  }

  const violations: string[] = [];
  const families = MANAGED_CAPABILITY_FAMILY_IDS.map((family): NativeFamilyRetention => {
    const entry = dispositions.find((candidate) => candidate.family === family);
    const readinessEntry = readinessFor(readiness, family);
    const cutoverReady = readinessEntry?.cutoverReady ?? entry?.cutoverReady ?? false;
    const openGapIds = readinessEntry?.openGapIds ?? entry?.gaps.map((gap) => gap.id) ?? [];
    const disposition = entry?.disposition ?? 'no-recorded-disposition';
    const outcome = retentionOutcome(disposition, cutoverReady);
    const boundary = entry?.boundary ?? '';

    const familyViolations: string[] = [];
    if (!entry) {
      familyViolations.push(
        `${family}:no-recorded-disposition — declared in MANAGED_CAPABILITY_FAMILY_IDS with no inventory entry, so its retention position is unstated`,
      );
    } else if (!boundary.trim()) {
      familyViolations.push(
        `${family}:no-explicit-boundary — "explicitly retained" requires a stated managed/native line, not an empty string`,
      );
    }
    if (outcome === 'managed-cutover-eligible' && (entry?.managedAuthorities.length ?? 0) === 0) {
      familyViolations.push(
        `${family}:cutover-eligible-without-named-adapter — a "semantically equivalent managed adapter" has to name one`,
      );
    }

    const grouped = new Map<string, { authorityKind: CapabilityRestrictionAuthority['kind']; contexts: string[]; deniedNames: readonly string[] }>();
    for (const hit of hits) {
      const scope = hit.applied.familyScope;
      // A missing scope is unrepresentable in the published type but reachable
      // from an untyped source (P-008 drives this from measured evidence). It
      // is reported in `malformedRestrictions`, never attributed to a family it
      // does not name — an unmapped restriction is invisible here BY DESIGN,
      // which is precisely the pre-D-012 blindness the report makes loud.
      if (!scope || scope.kind !== 'contract-family' || scope.family !== family) continue;
      const existing = grouped.get(hit.applied.id);
      if (existing) existing.contexts.push(hit.context);
      else {
        grouped.set(hit.applied.id, {
          authorityKind: hit.applied.authorityKind,
          contexts: [hit.context],
          deniedNames: hit.applied.deniedNames,
        });
      }
    }
    const disabledBy: NativeFamilyDisablement[] = [...grouped.entries()].map(
      ([restrictionId, value]) => ({
        restrictionId,
        authorityKind: value.authorityKind,
        contexts: value.contexts,
        deniedNames: value.deniedNames,
      }),
    );

    if (outcome !== 'managed-cutover-eligible') {
      for (const disablement of disabledBy) {
        // An owner mandate is a prohibition with NO managed replacement to
        // prove — the owner ruled the native capability out regardless of what
        // we ship — so it is the one legitimate disabler of an unreplaced
        // surface. Anything else disabling a retained/unsupported family is
        // precisely the "disabled instead of retained" failure.
        if (disablement.authorityKind === 'owner-mandate') continue;
        familyViolations.push(
          `${family}:disabled-without-proven-equivalent:${disablement.restrictionId} — ` +
            `outcome '${outcome}' but applied under '${disablement.authorityKind}' in ${disablement.contexts.length} context(s)`,
        );
      }
    }

    violations.push(...familyViolations);
    return {
      family,
      disposition,
      boundary,
      cutoverReady,
      openGapIds,
      outcome,
      disabledBy,
      violations: familyViolations,
    };
  });

  return {
    families,
    violations,
    malformedRestrictions,
    outsideTaxonomyRestrictionIds,
    contextsMeasured,
  };
}
