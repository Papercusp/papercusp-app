/**
 * source-citation-claim-port — "does the tree already CITE this item's own id?",
 * answered at claim time.
 *
 * EI-19418245218824265. The eleventh claim-time trap guard, and the first that
 * reads the TREE rather than the ROW.
 *
 * ## The hole the other ten cannot see
 *
 * Every leg registered in `claim-time-enrichment.ts` before this one answers
 * "has this item been worked?" from the work-item row or its plan: a checkpoint
 * (EI-529), a terminal state (WI-5826), release/attempt history
 * (`work-item-prior-work`), a settled sibling, a plan contradiction, an ended
 * author. All ten are silent for the case that actually recurs — an item
 * implemented by an agent who **never claimed the row**. That leaves no
 * checkpoint, no release, no attempt count, no assignee: the row is
 * byte-indistinguishable from never-started, and the next claimant is told
 * nothing.
 *
 * The measured instance is WI-6007 ("wire the claim_audit detector … ZERO
 * writers"), served as fresh work 8 days after it was fully implemented, tested
 * and running. Establishing there was nothing to build cost a ~6-minute
 * investigation. The evidence was in the tree the whole time —
 * `claim-spec-store.ts` opens a docblock with the item's own id — and no claim
 * surface looked.
 *
 * ## Why this reuses the Scout probe rather than adding a grep
 *
 * `scout/code-existence-probe` already implements exactly this detector: its
 * `selfId` option is documented as "the cheapest retrieval, highest precision"
 * leg, greps the tree for the id, and reports `selfIdHits`. It was wired into
 * three Scout (ideation-screening) surfaces and never into the claim path, so
 * the capability existed and the population that needed it could not reach it.
 * This module is the missing caller, not a second implementation — which also
 * keeps ONE definition of the verdict wording (`summariseCodeExistence`) and
 * ONE definition of what counts as evidence (`NON_EVIDENCE_PATTERNS`, which
 * already drops docs, markdown and the screening module's own citations).
 *
 * `maxTerms: 0` is what makes it affordable on a claim: it empties the
 * distinctive-term candidate list so the probe's expensive lexical loop never
 * runs, leaving exactly one `git grep` (~300ms measured on this tree). The
 * probe's empty-terms early return deliberately still carries `selfIdHits`, and
 * the semantic and plan-slug legs are opt-in via `deps`, so omitting them skips
 * them entirely. The empty `text` argument is therefore intentional and not a
 * missing input — the only signal this leg wants is the id.
 *
 * ## Advisory, fail-open, never blocking
 *
 * A citation can legitimately be a REFERENCE to related work rather than an
 * implementation, so this informs the agent and never gates or reorders a claim
 * — the same report-only posture as the Scout leg it reuses, and as every other
 * member of the enrichment set.
 *
 * Fail-open matters in one specific direction: `probeCodeExistence` converts a
 * search backend throw into `selfIdHits: undefined`, and this module renders
 * that as *no hint at all* rather than "nothing cites this item". A probe
 * outage must never be read as evidence of absence — the WI-6737 lesson, and
 * the exact false negative the module it reuses was built to prevent.
 */
import {
  probeCodeExistence,
  summariseCodeExistence,
  type CodeSearchDeps,
} from './scout/code-existence-probe';
import { createGitGrepDeps } from './scout/code-search-deps';
import { PgLinkStore, type LinkRow, type ObjectRef } from '@papercusp/coordination/capabilities';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';

export type ClaimTimeSourceCitationFamily = 'issue' | 'feature';

/** Identity context required to traverse canonical duplicate relations safely. */
export interface ClaimTimeSourceCitationRef {
  workItemId: string;
  workspaceId?: string | null;
  harness?: string | null;
  family?: ClaimTimeSourceCitationFamily | null;
}

/** Injectable duplicate-equivalence seam; production uses the workspace-scoped coord store. */
export type DuplicateEquivalentIdResolver = (
  ref: ClaimTimeSourceCitationRef,
) => Promise<readonly string[]>;

const MAX_DUPLICATE_EQUIVALENTS = 8;
const MAX_CITATIONS = 12;

function objectRefFor(ref: ClaimTimeSourceCitationRef): ObjectRef | null {
  const id = ref.workItemId.trim();
  if (!id || !ref.family) return null;
  if (ref.family === 'issue') return { kind: 'issue', ref: id };
  const harness = ref.harness?.trim();
  return harness ? { kind: 'feature', ref: `${harness}#${id}` } : null;
}

function idFromEquivalentRef(candidate: ObjectRef, source: ObjectRef, harness: string | null): string | null {
  if (candidate.kind !== source.kind) return null;
  if (source.kind === 'issue') return candidate.ref;
  const prefix = harness ? `${harness}#` : null;
  if (!prefix || !candidate.ref.startsWith(prefix)) return null;
  return candidate.ref.slice(prefix.length) || null;
}

/**
 * Read one bounded, bidirectional hop of the canonical `duplicates` relation.
 * Admission writes loser→canonical, so both directions are required: a claimant
 * may be looking at either endpoint. Missing family/harness context intentionally
 * yields no equivalents; the direct-id citation probe still runs.
 */
export async function resolveDuplicateEquivalentIds(ref: ClaimTimeSourceCitationRef): Promise<string[]> {
  const source = objectRefFor(ref);
  if (!source) return [];
  const store = new PgLinkStore({
    getSql: () => getOrgPg().sql,
    ensureSchema: async () => {},
    getWorkspaceId: () => ref.workspaceId?.trim() || activeWorkspaceId(),
  });
  const [outgoing, incoming] = await Promise.all([
    store.listOut(source, { rel: 'duplicates' }),
    store.listIn(source, { rel: 'duplicates' }),
  ]);
  const equivalents = [
    ...outgoing.map((row: LinkRow) => idFromEquivalentRef(row.dst, source, ref.harness?.trim() ?? null)),
    ...incoming.map((row: LinkRow) => idFromEquivalentRef(row.src, source, ref.harness?.trim() ?? null)),
  ]
    .filter((id): id is string => Boolean(id) && id !== ref.workItemId.trim());
  return [...new Set(equivalents)].slice(0, MAX_DUPLICATE_EQUIVALENTS - 1);
}

/** Evidence that the tree already names this work-item's id. */
export interface ClaimTimeSourceCitationHint {
  /** The id that was probed. */
  workItemId: string;
  /** IDs whose canonical duplicate relation was also probed and matched. */
  matchedWorkItemIds?: string[];
  /** Evidence paths citing it, capped by the probe's own `maxExamples`. */
  citations: string[];
  /**
   * The verdict line, produced by `summariseCodeExistence` so the wording has a
   * single definition shared with the Scout screen rather than a second copy
   * that can drift from it.
   */
  summary: string;
}

/**
 * Resolve the repo to grep. `PAPERCUSP_INTEGRATION_ROOT` is the operator's own
 * export for "the tree this process serves"; `cwd` is the fallback, which is
 * correct for the release checkout too (it is itself a git repo).
 */
function defaultCwd(): string {
  return process.env.PAPERCUSP_INTEGRATION_ROOT ?? process.cwd();
}

/**
 * Probe the tree for the claimed item's own id.
 *
 * Returns `null` for BOTH "nothing cites it" and "the probe could not run" — the
 * caller renders nothing either way, so an unavailable probe cannot become an
 * assertion about the tree. Callers that need to tell those apart must ask the
 * probe directly; no claim surface does, because both cases mean the same thing
 * to an agent: this guard has nothing to tell you.
 */
export async function getClaimTimeSourceCitation(ref: {
  workItemId: string;
  /** Repo root to grep. Defaults to the tree this operator serves. */
  cwd?: string;
  /** Injected searcher (tests). Defaults to a `git grep`-backed one. */
  deps?: CodeSearchDeps;
  workspaceId?: string | null;
  harness?: string | null;
  family?: ClaimTimeSourceCitationFamily | null;
  /** Injected relation reader (tests); production defaults to coord_links. */
  resolveEquivalentIds?: DuplicateEquivalentIdResolver;
}): Promise<ClaimTimeSourceCitationHint | null> {
  const workItemId = ref.workItemId?.trim();
  if (!workItemId) return null;

  try {
    const deps = ref.deps ?? createGitGrepDeps({ cwd: ref.cwd ?? defaultCwd() });
    const identity: ClaimTimeSourceCitationRef = {
      workItemId,
      workspaceId: ref.workspaceId,
      harness: ref.harness,
      family: ref.family,
    };
    let equivalentIds: string[] = [workItemId];
    try {
      const resolved = await (ref.resolveEquivalentIds ?? resolveDuplicateEquivalentIds)(identity);
      equivalentIds = [...new Set([workItemId, ...resolved.map((id) => id.trim()).filter(Boolean)])].slice(
        0,
        MAX_DUPLICATE_EQUIVALENTS,
      );
    } catch {
      // Relation reads are advisory. Preserve the direct-id probe when the coord
      // store is unavailable or the caller lacks family-specific identity context.
    }
    // Empty text + maxTerms:0 => the selfId leg ONLY. See the module docblock.
    const reports = await Promise.all(
      equivalentIds.map((id) => probeCodeExistence('', deps, { selfId: id, maxTerms: 0 })),
    );
    const matches = reports.flatMap((report, index) =>
      report.selfIdHits && report.selfIdHits.length > 0
        ? [{ id: equivalentIds[index]!, report }]
        : [],
    );
    const citations = [...new Set(matches.flatMap(({ report }) => report.selfIdHits ?? []))].slice(0, MAX_CITATIONS);
    if (citations.length === 0) return null;
    const matchedWorkItemIds = matches.map(({ id }) => id);
    const summary =
      matchedWorkItemIds.length === 1 && matchedWorkItemIds[0] === workItemId
        ? summariseCodeExistence(matches[0]!.report)
        : `LIKELY ALREADY IMPLEMENTED — source cites this item or a canonical equivalent ` +
          `(${matchedWorkItemIds.join(', ')}): ${citations.join(', ')}`;
    return { workItemId, citations, matchedWorkItemIds, summary };
  } catch {
    // Belt-and-braces: the probe is already fail-open internally, but this leg
    // must never be the reason a claim fails.
    return null;
  }
}

/**
 * Render the hint, or `null` when there is nothing to say.
 *
 * The VERIFY clause is not decoration: the whole reason this leg is advisory is
 * that a citation can be a reference rather than an implementation, and an agent
 * told only "already implemented" would be as wrong in the other direction.
 */
export function sourceCitationWarning(
  hint: ClaimTimeSourceCitationHint | null,
  workItemId: string,
): string | null {
  if (!hint || hint.citations.length === 0) return null;
  return (
    `${hint.summary}. VERIFY BEFORE BUILDING ${workItemId}: read the cited path(s) first. ` +
    `This is advisory — a citation can be a reference to related work rather than an ` +
    `implementation, so it never blocks or reorders the claim.`
  );
}
