/**
 * rubric-requirements — resolve a listing's `requires_rubrics` declaration BEFORE the
 * install lands (cupboard-plan-rubric-recipe-sharing-2026-08-21 P-011).
 *
 * The consumer half of the rubric axis, mirroring the events axis's install gate
 * (worker migrations 012/013): the storefront stores a DECLARATION, and only the
 * installing operator can answer whether this workspace actually has the rubric. A
 * plan template whose acceptance class nothing can grade against installs "fine" and
 * then fails at the ship gate — hours later, in a place that does not mention the
 * install. Resolving up front turns that into a refusal at the moment of choice, with
 * the co-install that would fix it named.
 *
 * RESOLUTION ORDER (P-011), most-authoritative first:
 *
 *   1. workspace — a LIVE rubric row (`rubrics.getRubric`). The rubric is usable
 *      right now by scorecards:emit; nothing further is needed.
 *   2. bundled/installed — a self-describing dir in the layered rubric store. The
 *      BUNDLED first-party set counts as PROVIDED, which is the whole reason the
 *      plan-class rubrics a template derives do not trigger a co-install on a normal
 *      box: they ship with the app. A user-layer dir that has not been seeded yet
 *      also counts — the seed is idempotent and any later rubrics read runs it.
 *   3. installable — a `kind='rubric'` Cupboard listing exists for the ref, so the
 *      requirement is satisfiable by a co-install the caller can accept.
 *   4. unresolvable — nothing provides it. A REQUIRED entry here HARD-FAILS the
 *      install; an `optional: true` entry is reported and waved through.
 *
 * Dependency-injected so the ordering is unit-testable without a DB, a filesystem, or
 * the network — the three sources are exactly the three seams.
 */
import { parseRequiredRubrics, type RubricRequirement } from './types';
// Statically imported on purpose: the rubric store is a synchronous, side-effect-free
// filesystem reader, and its BUNDLED layer is what satisfies the plan-class rubrics a
// derived declaration names on a normal box. Routed through a lazy/optional import it
// would answer `null` on any resolution hiccup, and a false "not present" here is
// precisely the failure this resolver exists to prevent — it downgrades a satisfied
// requirement into a co-install offer, or a refusal.
import { resolveLocalRubric } from './rubric-store';

/** Where a satisfied requirement came from. */
export type RubricProvider = 'workspace' | 'bundled' | 'installed';

export type RubricRequirementState =
  /** Already present (see `providedBy`). */
  | 'satisfied'
  /** Not present, but a Cupboard rubric listing provides it (see `listing`). */
  | 'installable'
  /** Nothing provides it. Fatal unless the entry is optional. */
  | 'unresolvable';

export interface ResolvedRubricRequirement {
  rubricRef: string;
  optional: boolean;
  state: RubricRequirementState;
  providedBy?: RubricProvider;
  /** The co-installable listing, when `state === 'installable'`. */
  listing?: { listingId?: string; githubUrl: string; ref: string };
}

export interface RubricRequirementsVerdict {
  /** False ⇒ at least one REQUIRED entry is unresolvable; the install must refuse. */
  ok: boolean;
  requirements: ResolvedRubricRequirement[];
  /** Refs already provided — no action needed. */
  satisfied: string[];
  /** REQUIRED refs a co-install would satisfy. The offer. */
  coInstall: string[];
  /** REQUIRED refs nothing provides. The refusal reason. */
  unresolvable: string[];
  /** Optional refs that are missing — reported, never blocking. */
  missingOptional: string[];
}

export interface RubricRequirementDeps {
  /** True when the ref resolves to a LIVE workspace rubric row. */
  hasWorkspaceRubric: (ref: string) => Promise<boolean>;
  /** The layer a local self-describing rubric dir was found in, or null. */
  localRubricLayer: (ref: string) => 'bundled' | 'user' | null;
  /** A `kind='rubric'` Cupboard listing for the ref, or null when none exists. */
  findRubricListing: (
    ref: string,
  ) => Promise<{ listingId?: string; githubUrl: string; ref: string } | null>;
}

/**
 * The real wiring: live rubric rows, the layered on-disk store, and the Cupboard's
 * kind-filtered listing resolution. Imports are lazy so the pure resolver above stays
 * importable (and testable) without dragging in the DB or the network stack.
 */
export function defaultRubricRequirementDeps(): RubricRequirementDeps {
  return {
    async hasWorkspaceRubric(ref) {
      try {
        const { getRubric } = await import('../rubrics');
        return (await getRubric(ref)) !== null;
      } catch {
        // A DB that cannot answer must NOT read as "the rubric is absent" — that
        // would turn a transient outage into a spurious co-install offer, or worse a
        // spurious hard refusal. Fall through to the disk + listing legs instead.
        return false;
      }
    },
    localRubricLayer(ref) {
      try {
        return resolveLocalRubric(ref)?.layer ?? null;
      } catch {
        return null;
      }
    },
    async findRubricListing(ref) {
      try {
        const { resolveListingByKind } = await import('./resolve-listing-by-kind');
        const r = await resolveListingByKind(ref, 'rubric');
        if ('error' in r) return null;
        return {
          ...(r.listingId ? { listingId: r.listingId } : {}),
          githubUrl: r.githubUrl,
          ref: r.ref,
        };
      } catch {
        return null;
      }
    },
  };
}

/**
 * Resolve every entry of a `requires_rubrics` declaration against this workspace.
 *
 * Never throws: a dependency that cannot answer degrades that ONE entry (it falls
 * through to the next source), because a resolver that throws turns a soft
 * "we could not check" into a hard install failure.
 */
export async function resolveRubricRequirements(
  requirements: readonly RubricRequirement[],
  deps: RubricRequirementDeps,
): Promise<RubricRequirementsVerdict> {
  const out: ResolvedRubricRequirement[] = [];

  for (const req of requirements) {
    const rubricRef = req.rubricRef;
    const optional = req.optional === true;

    if (await deps.hasWorkspaceRubric(rubricRef)) {
      out.push({ rubricRef, optional, state: 'satisfied', providedBy: 'workspace' });
      continue;
    }

    const layer = deps.localRubricLayer(rubricRef);
    if (layer) {
      out.push({
        rubricRef,
        optional,
        state: 'satisfied',
        providedBy: layer === 'bundled' ? 'bundled' : 'installed',
      });
      continue;
    }

    const listing = await deps.findRubricListing(rubricRef);
    if (listing) {
      out.push({ rubricRef, optional, state: 'installable', listing });
      continue;
    }

    out.push({ rubricRef, optional, state: 'unresolvable' });
  }

  const satisfied = out.filter((r) => r.state === 'satisfied').map((r) => r.rubricRef);
  const coInstall = out
    .filter((r) => r.state === 'installable' && !r.optional)
    .map((r) => r.rubricRef);
  const unresolvable = out
    .filter((r) => r.state === 'unresolvable' && !r.optional)
    .map((r) => r.rubricRef);
  const missingOptional = out
    .filter((r) => r.state !== 'satisfied' && r.optional)
    .map((r) => r.rubricRef);

  return { ok: unresolvable.length === 0, requirements: out, satisfied, coInstall, unresolvable, missingOptional };
}

/** Convenience: resolve straight from the listing row's JSON-encoded column. */
export async function resolveRubricRequirementsFromJson(
  raw: string | null | undefined,
  deps: RubricRequirementDeps = defaultRubricRequirementDeps(),
): Promise<RubricRequirementsVerdict> {
  return resolveRubricRequirements(parseRequiredRubrics(raw), deps);
}

export interface RubricGateRefusal {
  status: number;
  error: string;
  detail: string;
  verdict: RubricRequirementsVerdict;
}

/**
 * The install GATE. Returns null when the install may proceed, or a structured
 * refusal naming exactly what is missing and what would fix it.
 *
 * Two distinct blocking shapes, deliberately separated in the message:
 *   - unresolvable → nothing provides it; installing this unit would leave it
 *     permanently un-gradeable. 409, no remedy to offer.
 *   - installable but not accepted → the caller did not opt into the co-install.
 *     Also 409, but the remedy is one flag away, so the message names it.
 */
export function rubricGateRefusal(
  verdict: RubricRequirementsVerdict,
  opts: { acceptCoInstall: boolean },
): RubricGateRefusal | null {
  if (verdict.unresolvable.length > 0) {
    return {
      status: 409,
      error: 'required_rubrics_unresolvable',
      detail:
        `this listing requires rubric(s) nothing in this workspace provides and no Cupboard rubric listing supplies: ` +
        `${verdict.unresolvable.join(', ')}. Install would leave the plan un-gradeable at its acceptance gate.`,
      verdict,
    };
  }
  if (!opts.acceptCoInstall && verdict.coInstall.length > 0) {
    return {
      status: 409,
      error: 'required_rubrics_need_co_install',
      detail:
        `this listing requires rubric(s) this workspace does not have yet: ${verdict.coInstall.join(', ')}. ` +
        `A Cupboard rubric listing provides each one — re-run with installRequiredRubrics: true to co-install them.`,
      verdict,
    };
  }
  return null;
}
