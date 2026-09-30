/**
 * Pure install-time capability-class grant resolution (identities-v1 P-017).
 * Registry and marketplace reads are injected so unavailable evidence stays
 * unknown instead of being mistaken for price zero or no adoption.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import {
  parseCapabilityClassRef,
  type CapabilityProviderKind,
  type PotCapabilityProviderBindingRow,
  type ProviderBindingRow,
  type ProviderExecutionContract,
} from '../capability-class-registry-store';

/** The execution kind is attested by the registry read, never inferred. A
 * recipe row carries its per-verb inspection evidence (P-013, D-019). */
export type ProviderKindEvidence = Pick<ProviderExecutionContract, 'providerKind' | 'recipeInspections'>;

export type CapabilityGrantState = 'satisfied' | 'choosable' | 'absent';
export type CapabilityGrantInstallMode = 'interactive' | 'agent';
export type CapabilityProviderSelectionReason =
  | 'explicit-selection'
  | 'publisher-suggestion'
  | 'evidence-policy';

export interface CapabilityProviderPriceEvidence {
  amount: number;
  currency: string;
  billingUnit: string;
  source: string;
}

/** Evidence shown by the picker. Unknown price/adoption facts are explicit nulls. */
export interface CapabilityProviderCandidate extends ProviderBindingRow, ProviderKindEvidence {
  price: CapabilityProviderPriceEvidence | null;
  activePotBindings: number | null;
  passingStructuralRuns: number;
  totalStructuralRuns: number;
}

/** One inspected recipe verb, as the administrator consents to it. */
export interface RecipeProviderPin {
  verb: string;
  recipeId: string;
  recipeRevision: string;
  /** sha256 of the canonical inspection pin the conformance run recorded. */
  inspectionPinSha256: string;
  toolNames: string[];
}

export interface CapabilityProviderSelection {
  classRef: string;
  providerPackage: string;
  providerVersion: string;
  providerKind: CapabilityProviderKind;
  /** Recipe selections only: the exact inspected verbs the binding would run. */
  recipePins?: RecipeProviderPin[];
  reason: CapabilityProviderSelectionReason;
  /** Agent-selected choices are disclosed; existing bindings are reused silently. */
  disclosureRequired: boolean;
}

export type CapabilityPotBinding = PotCapabilityProviderBindingRow & ProviderKindEvidence;

export interface ResolvedCapabilityGrant {
  classRef: string;
  optional: boolean;
  state: CapabilityGrantState;
  binding?: CapabilityPotBinding;
  candidates?: CapabilityProviderCandidate[];
  selection?: CapabilityProviderSelection;
  absentReason?: 'invalid-class-ref' | 'no-conformant-provider';
  selectionProblem?: string;
}

export interface CapabilityGrantSet {
  requires?: readonly string[];
  optional?: readonly string[];
  suggestedProviders?: Readonly<Record<string, string>>;
}

export interface CapabilityGrantResolverDeps {
  getPotBinding: (classRef: string) => Promise<CapabilityPotBinding | null>;
  listCandidates: (classRef: string) => Promise<readonly CapabilityProviderCandidate[]>;
}

export interface ResolveCapabilityGrantOptions {
  mode: CapabilityGrantInstallMode;
  /** Exact class ref to provider package or exact provider package@version. */
  selections?: Readonly<Record<string, string>>;
}

export interface CapabilityGrantResolutionVerdict {
  ok: boolean;
  requirements: ResolvedCapabilityGrant[];
  satisfied: string[];
  selected: CapabilityProviderSelection[];
  missingRequired: string[];
  requiresChoice: string[];
  missingOptional: string[];
  disclosures: string[];
}

export interface InstalledIdentityGrantView {
  identityRef: string;
  requires?: readonly string[];
  optional?: readonly string[];
}

export interface CapabilityProviderPin {
  classRef: string;
  providerPackage: string;
  providerVersion: string;
}

export interface CapabilityProviderIdentityDependent {
  identityRef: string;
  classRef: string;
  optional: boolean;
}

function exactClassRef(value: string): string | null {
  const parsed = parseCapabilityClassRef(value);
  return parsed ? parsed.id + '@' + parsed.version : null;
}

function providerRef(candidate: Pick<CapabilityProviderCandidate, 'providerPackage' | 'providerVersion'>): string {
  return candidate.providerPackage + '@' + candidate.providerVersion;
}

function hintMatches(candidate: CapabilityProviderCandidate, hint: string): boolean {
  return hint === candidate.providerPackage || hint === providerRef(candidate);
}

function behavioralRank(status: string): number {
  if (status === 'passed') return 3;
  if (status === 'not-required') return 2;
  if (status === 'not-run') return 1;
  return 0;
}

function passRate(candidate: CapabilityProviderCandidate): number {
  return candidate.totalStructuralRuns > 0
    ? candidate.passingStructuralRuns / candidate.totalStructuralRuns
    : -1;
}

/** Correctness evidence first, adoption next, deterministic identity last. */
export function compareCapabilityProviderCandidates(
  a: CapabilityProviderCandidate,
  b: CapabilityProviderCandidate,
): number {
  const behavioral = behavioralRank(b.behavioralStatus) - behavioralRank(a.behavioralStatus);
  if (behavioral !== 0) return behavioral;
  const rate = passRate(b) - passRate(a);
  if (rate !== 0) return rate;
  const runs = b.passingStructuralRuns - a.passingStructuralRuns;
  if (runs !== 0) return runs;
  const adoption = (b.activePotBindings ?? -1) - (a.activePotBindings ?? -1);
  if (adoption !== 0) return adoption;
  const packageOrder = a.providerPackage.localeCompare(b.providerPackage);
  return packageOrder !== 0
    ? packageOrder
    : b.providerVersion.localeCompare(a.providerVersion, undefined, { numeric: true });
}

/** Per-verb pins for a recipe provider, or null when any bound verb lacks
 * inspected evidence for exactly the recipe it binds (a kind-only row). */
export function recipeProviderPins(provider: Pick<ProviderBindingRow, 'verbBindings'> & ProviderKindEvidence): RecipeProviderPin[] | null {
  const verbs = Object.keys(provider.verbBindings).sort();
  if (provider.providerKind !== 'recipe' || !provider.recipeInspections || verbs.length === 0) return null;
  const pins: RecipeProviderPin[] = [];
  for (const verb of verbs) {
    const inspection = Object.hasOwn(provider.recipeInspections, verb) ? provider.recipeInspections[verb] : undefined;
    if (!inspection || inspection.recipe.id !== provider.verbBindings[verb]) return null;
    pins.push({
      verb,
      recipeId: inspection.recipe.id,
      recipeRevision: inspection.recipe.revision,
      inspectionPinSha256: createHash('sha256').update(canonicalJson(inspection.inspectionPin)).digest('hex'),
      toolNames: [...new Set(inspection.toolNames)].sort(),
    });
  }
  return pins;
}

function usableCandidates(
  classRef: string,
  candidates: readonly CapabilityProviderCandidate[],
): CapabilityProviderCandidate[] {
  const unique = new Map<string, CapabilityProviderCandidate>();
  for (const candidate of candidates) {
    if (
      exactClassRef(candidate.classRef) === classRef &&
      candidate.status === 'active' &&
      candidate.conformanceStatus === 'passed' &&
      // Execution admits a recipe only with inspected per-verb evidence
      // (D-019), so install never offers a kind-only recipe row either.
      (candidate.providerKind === 'tool' || recipeProviderPins(candidate) !== null)
    ) {
      unique.set(providerRef(candidate), candidate);
    }
  }
  return [...unique.values()].sort(compareCapabilityProviderCandidates);
}

function requirements(grants: CapabilityGrantSet): Array<{ classRef: string; optional: boolean }> {
  const required = new Set(grants.requires ?? []);
  const out = [...required].map((classRef) => ({ classRef, optional: false }));
  for (const classRef of grants.optional ?? []) {
    if (!required.has(classRef)) out.push({ classRef, optional: true });
  }
  return out;
}

function select(
  classRef: string,
  candidates: readonly CapabilityProviderCandidate[],
  hint: string,
  reason: CapabilityProviderSelectionReason,
  mode: CapabilityGrantInstallMode,
): CapabilityProviderSelection | null {
  const candidate = candidates.find((item) => hintMatches(item, hint));
  const pins = candidate ? recipeProviderPins(candidate) : null;
  return candidate
    ? {
        classRef,
        providerPackage: candidate.providerPackage,
        providerVersion: candidate.providerVersion,
        providerKind: candidate.providerKind,
        ...(pins ? { recipePins: pins } : {}),
        reason,
        disclosureRequired: mode === 'agent',
      }
    : null;
}

/** Resolve grants without installing packages or persisting pot bindings. */
export async function resolveCapabilityGrants(
  grants: CapabilityGrantSet,
  deps: CapabilityGrantResolverDeps,
  options: ResolveCapabilityGrantOptions,
): Promise<CapabilityGrantResolutionVerdict> {
  const resolved: ResolvedCapabilityGrant[] = [];

  for (const requirement of requirements(grants)) {
    const classRef = exactClassRef(requirement.classRef);
    if (!classRef) {
      resolved.push({
        classRef: requirement.classRef,
        optional: requirement.optional,
        state: 'absent',
        candidates: [],
        absentReason: 'invalid-class-ref',
      });
      continue;
    }

    const binding = await deps.getPotBinding(classRef);
    if (binding) {
      resolved.push({
        classRef,
        optional: requirement.optional,
        state: 'satisfied',
        binding,
        candidates: [],
      });
      continue;
    }

    const candidates = usableCandidates(classRef, await deps.listCandidates(classRef));
    if (candidates.length === 0) {
      resolved.push({
        classRef,
        optional: requirement.optional,
        state: 'absent',
        candidates,
        absentReason: 'no-conformant-provider',
      });
      continue;
    }

    const explicit = options.selections?.[classRef];
    const suggestion =
      grants.suggestedProviders?.[classRef] ??
      grants.suggestedProviders?.[requirement.classRef];
    let choice: CapabilityProviderSelection | null = null;
    let selectionProblem: string | undefined;

    if (explicit) {
      choice = select(classRef, candidates, explicit, 'explicit-selection', options.mode);
      if (!choice) selectionProblem = 'explicit provider ' + explicit + ' is not an active conformant candidate';
    } else if (suggestion) {
      choice = select(classRef, candidates, suggestion, 'publisher-suggestion', options.mode);
      if (!choice) selectionProblem = 'suggested provider ' + suggestion + ' is not an active conformant candidate';
    }
    // An explicit but invalid choice is never replaced behind the caller's
    // back. A stale publisher hint, however, may fall through to the documented
    // agent policy while the warning remains visible in selectionProblem.
    // The automatic policy prefers the best tool provider; it reaches a recipe
    // only when no tool provider exists, and that choice still needs consent.
    if (!choice && !explicit && options.mode === 'agent') {
      const best = candidates.find((item) => item.providerKind === 'tool') ?? candidates[0]!;
      choice = select(classRef, candidates, providerRef(best), 'evidence-policy', options.mode);
    }

    resolved.push({
      classRef,
      optional: requirement.optional,
      state: 'choosable',
      candidates,
      ...(choice ? { selection: choice } : {}),
      ...(selectionProblem ? { selectionProblem } : {}),
    });
  }

  const satisfied = resolved.filter((item) => item.state === 'satisfied').map((item) => item.classRef);
  const selected = resolved.flatMap((item) => (item.selection ? [item.selection] : []));
  const missingRequired = resolved
    .filter((item) => !item.optional && item.state === 'absent')
    .map((item) => item.classRef);
  const requiresChoice = resolved
    .filter((item) => !item.optional && item.state === 'choosable' && !item.selection)
    .map((item) => item.classRef);
  const missingOptional = resolved
    .filter((item) => item.optional && item.state !== 'satisfied' && !item.selection)
    .map((item) => item.classRef);
  const disclosures = selected
    .filter((item) => item.disclosureRequired)
    .map((item) =>
      'Selected ' + item.providerPackage + '@' + item.providerVersion +
      ' for ' + item.classRef + ' by ' + item.reason + '.',
    );

  return {
    ok: missingRequired.length === 0 && requiresChoice.length === 0,
    requirements: resolved,
    satisfied,
    selected,
    missingRequired,
    requiresChoice,
    missingOptional,
    disclosures,
  };
}

/** The exact subject an administrator approves before a recipe provider is
 * bound to a pot: the pot plus every selected recipe provider's per-verb pins. */
export interface RecipeProviderConsentSubject {
  workspaceId: string;
  potSlug: string;
  providers: Array<{
    classRef: string;
    providerPackage: string;
    providerVersion: string;
    recipes: RecipeProviderPin[];
  }>;
}

export type RecipeProviderConsent = RecipeProviderConsentSubject & { decision: 'approved' | 'rejected' };

export const recipeProviderConsentSchema = z
  .object({
    workspaceId: z.string().min(1).max(120),
    potSlug: z.string().min(1).max(120),
    providers: z
      .array(
        z.object({
          classRef: z.string().min(1).max(200),
          providerPackage: z.string().min(1).max(200),
          providerVersion: z.string().min(1).max(200),
          recipes: z
            .array(
              z.object({
                verb: z.string().min(1).max(200),
                recipeId: z.string().min(1).max(200),
                recipeRevision: z.string().min(1).max(200),
                inspectionPinSha256: z.string().regex(/^[0-9a-f]{64}$/),
                toolNames: z.array(z.string().min(1).max(200)).max(200),
              }).strict(),
            )
            .max(100),
        }).strict(),
      )
      .min(1)
      .max(100),
    decision: z.enum(['approved', 'rejected']),
  })
  .strict();
// Compile-time guard: the wire schema and the consent type cannot drift apart.
const _recipeConsentSchemaMatchesType: RecipeProviderConsent = {} as z.infer<typeof recipeProviderConsentSchema>;
void _recipeConsentSchemaMatchesType;

export interface RecipeProviderConsentRefusal {
  code: 'consent_required' | 'consent_rejected' | 'consent_mismatch';
  detail: string;
}

/** Null when the selection binds no recipe provider (existing bindings were
 * consented when they were made, so only NEW selections need a subject). */
export function recipeProviderConsentSubject(
  scope: { workspaceId: string; potSlug: string },
  selected: readonly CapabilityProviderSelection[],
): RecipeProviderConsentSubject | null {
  const providers = selected
    .filter((selection) => selection.providerKind === 'recipe')
    .map((selection) => ({
      classRef: selection.classRef,
      providerPackage: selection.providerPackage,
      providerVersion: selection.providerVersion,
      recipes: selection.recipePins ?? [],
    }))
    .sort((a, b) => a.classRef.localeCompare(b.classRef));
  return providers.length > 0
    ? { workspaceId: scope.workspaceId, potSlug: scope.potSlug, providers }
    : null;
}

export function recipeProviderConsentRefusal(
  consent: RecipeProviderConsent | null | undefined,
  subject: RecipeProviderConsentSubject,
): RecipeProviderConsentRefusal | null {
  if (!consent) {
    return { code: 'consent_required', detail: 'binding a recipe provider needs administrator consent for this exact pot and recipe pin set' };
  }
  if (consent.decision === 'rejected') {
    return { code: 'consent_rejected', detail: 'the administrator rejected these recipe providers' };
  }
  if (consent.decision !== 'approved') {
    return { code: 'consent_required', detail: `unknown consent decision ${JSON.stringify(consent.decision)}` };
  }
  const offered: RecipeProviderConsentSubject = {
    workspaceId: consent.workspaceId,
    potSlug: consent.potSlug,
    providers: consent.providers ?? [],
  };
  if (canonicalJson(offered) !== canonicalJson(subject)) {
    return {
      code: 'consent_mismatch',
      detail: 'consent was given for a different pot, provider set, or recipe pin than the one being bound',
    };
  }
  return null;
}

/**
 * Pure reverse edge for uninstall review. The DB store finds affected pots;
 * this helper names the installed identities inside one pot that would lose a
 * required or optional class when an exact provider version is removed.
 */
export function findCapabilityProviderIdentityDependents(input: {
  providerPackage: string;
  providerVersion: string;
  pins: readonly CapabilityProviderPin[];
  identities: readonly InstalledIdentityGrantView[];
}): CapabilityProviderIdentityDependent[] {
  const affectedClasses = new Set(
    input.pins
      .filter(
        (pin) =>
          pin.providerPackage === input.providerPackage &&
          pin.providerVersion === input.providerVersion,
      )
      .map((pin) => exactClassRef(pin.classRef))
      .filter((ref): ref is string => ref !== null),
  );
  const dependents: CapabilityProviderIdentityDependent[] = [];
  const seen = new Set<string>();

  for (const identity of input.identities) {
    for (const grant of requirements(identity)) {
      const classRef = exactClassRef(grant.classRef);
      if (!classRef || !affectedClasses.has(classRef)) continue;
      const key = identity.identityRef + '\u0000' + classRef;
      if (seen.has(key)) continue;
      seen.add(key);
      dependents.push({
        identityRef: identity.identityRef,
        classRef,
        optional: grant.optional,
      });
    }
  }

  return dependents.sort(
    (a, b) =>
      a.identityRef.localeCompare(b.identityRef) ||
      a.classRef.localeCompare(b.classRef),
  );
}
