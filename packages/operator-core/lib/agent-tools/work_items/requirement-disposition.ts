/**
 * P-021 (plan `design-to-code-coverage-seam-2026-09-02`), governed by D-014.
 *
 * Decide whether a completion's requirement-by-requirement disposition is FAITHFUL to
 * the ask it claims to answer — the layer-A check on under-delivery.
 *
 * ## What D-014 settled, and why this is self-performed
 *
 * D-011/D-012 claimed only an independent grader (layer B) can catch work narrower than
 * the request. The owner's correction splits that claim in two:
 *
 *   - JUDGEMENT ("is this good?") — self-assessment IS unreliable, which is why the
 *     acceptance rubric refuses a grader in the implementer's lineage. That stands.
 *   - ENUMERATION + CITATION ("what was asked, and where is each part implemented?") —
 *     self-service is fine, because the OUTPUT is mechanically checkable. A citation
 *     resolves against the tree or it does not; no judge is required.
 *
 * Under-delivery is mostly the second kind. This module is the checker for it.
 *
 * ## The design constraint that carries the value: VERBATIM, never paraphrase
 *
 * Each requirement must be quoted as a literal span of the originating item body.
 * Paraphrase is precisely where silent narrowing hides — "make the retry robust"
 * becomes "added a retry", and the summary reads as full delivery. A verbatim quote is
 * checkable as a substring; a paraphrase is a matter of opinion. So the substring test
 * is not a formality, it is the entire mechanism: it converts narrowing from something
 * a reviewer must notice into something a string comparison catches.
 *
 * Whitespace is normalised on BOTH sides before comparison (a body wraps lines, and an
 * honest quote spanning a wrap must not read as fabricated) but case and punctuation are
 * not — those are where meaning changes.
 *
 * ## Biased toward generosity, deliberately — same asymmetry as P-001
 *
 * A false shortfall lowers an honest agent's grade and teaches the fleet the signal is
 * noise; a false clean verdict merely leaves today's behaviour in place. The two errors
 * are not symmetric, so every ambiguity resolves toward "cannot judge":
 *
 *   - no source text, or a source too thin to state a requirement → nothing is judged;
 *   - no resolvable repo root → citations are not judged (an unjudgeable citation must
 *     never read as a fabricated one);
 *   - a citation naming a path outside every candidate root, or a glob → not judged;
 *   - any throw → silence, never a finding.
 *
 * ## Scope of the ABSENT check — a coherence check, not a policy change
 *
 * Demanding a disposition from EVERY code-shaped close would reclassify 2,053 closes a
 * week (measured 2026-09-02, 7-day window, workspace papercusp). This module's sibling
 * gate already draws that line explicitly: a rule that "would have reclassified 530/day
 * ... is a policy call with real burn-down blast radius, not a coherence check", and is
 * deliberately not applied unilaterally. That precedent binds here.
 *
 * So absence is judged only on the SELF-CONTRADICTORY population: a close that itself
 * declares deferred work — admitting it did not deliver everything — while saying
 * nothing about WHICH part of the ask was left. That is 550 closes a week on the same
 * measurement, it is exactly the case D-014 is about, and the remedy is one line: quote
 * the deferred requirement and mark it `deferred` with a follow-up ref. Widening the
 * demand to all code-shaped closes is a scope flip, not a code change — see D-019.
 */
import { detectBodyRefs } from '../coordination/ref-hydrate';
import type { CompletionVerificationEvidence } from '../../coord-lifecycle/records';
import { existsSync } from 'node:fs';
import nodePath from 'node:path';

/** Bounds the work: a pathological list must never turn one close into N fs probes. */
export const MAX_REQUIREMENT_ENTRIES = 40;

/**
 * Below this, a "quote" cannot be a distinct requirement — it is a word, and a word
 * matches almost any body, which would make the substring test trivially satisfiable.
 * Flagging a too-short entry closes that gaming vector without judging its content.
 */
export const MIN_REQUIREMENT_QUOTE_CHARS = 12;

/**
 * Below this, the originating body does not state requirements to quote. Demanding a
 * disposition against it would not produce evidence, it would produce FABRICATED
 * evidence — the same failure `filesChanged` already exhibits when a path is supplied
 * from memory (EI-20093150500083378: 8 of 12 declared paths did not exist).
 */
export const MIN_SOURCE_CHARS = 200;

export type RequirementDispositionKind = 'implemented' | 'not-applicable' | 'deferred' | 'rejected';

export interface RequirementDispositionEntry {
  requirement: string;
  disposition: RequirementDispositionKind;
  citations?: readonly string[];
  followUp?: string;
  note?: string;
}

export interface RequirementDispositionProbe {
  /**
   * Candidate checkout roots. An explicit empty list means "cannot judge", never "guess".
   * Nullish entries are tolerated and dropped so a caller can pass a resolver that returns
   * `string | null` (`detectPapercupRoot`) without collapsing "no root" into a guess.
   */
  repoRoots?: readonly (string | null | undefined)[];
  /** Does this absolute path exist on disk? */
  exists?: (abs: string) => boolean;
}

export interface RequirementDispositionShortfall {
  /**
   * `absent` — the close declares deferred work but supplies no disposition at all.
   * `unfaithful` — a disposition was supplied and at least one entry fails a check.
   */
  kind: 'absent' | 'unfaithful';
  /** Quotes that are not a literal span of the source (or too short to be a requirement). */
  notQuotedFromSource: string[];
  /** `implemented` entries with no citation that resolves against the tree. */
  implementedWithoutResolvingCitation: string[];
  /** `deferred` entries carrying no work-item-shaped follow-up ref. */
  deferredWithoutFollowUp: string[];
}

/** Collapse whitespace runs so an honest quote spanning a line wrap still matches. */
const normalise = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** A path we can actually ask about: bare, repo-relative, no glob. */
const isProbeablePath = (p: string): boolean =>
  p.trim().length > 0 && !/[*?[\]]/.test(p) && !nodePath.isAbsolute(p);

function citationResolves(
  citation: string,
  repoRoots: readonly string[],
  exists: (abs: string) => boolean,
): boolean | undefined {
  // A citation may carry a line anchor ("path/to/file.ts:120"); the path is the part
  // that can be checked, and a wrong line number is not a fabricated citation.
  const raw = citation.trim().split('#')[0].replace(/:\d+(?:-\d+)?$/, '');
  if (!isProbeablePath(raw)) return undefined; // glob / absolute / empty → cannot judge
  for (const root of repoRoots) {
    try {
      if (exists(nodePath.join(root, raw))) return true;
    } catch {
      return undefined; // an fs error must never read as a fabricated citation
    }
  }
  return false;
}

/**
 * The shortfall in a completion's requirement disposition, or `undefined` when there is
 * nothing confident to say.
 *
 * `undefined` must always mean "grade as before". A caller may treat a returned finding
 * as grade-bearing.
 */
export function requirementDispositionShortfall(
  evidence: CompletionVerificationEvidence | null | undefined,
  opts: {
    /** The originating item's body/title — the text a quote must be a span of. */
    sourceText?: string | null;
    /** Does this close itself admit it left work undone? Triggers the ABSENT check. */
    declaresDeferredWork?: boolean;
    probe?: RequirementDispositionProbe;
  } = {},
): RequirementDispositionShortfall | undefined {
  try {
    const entries = evidence?.requirementDisposition;
    const source = normalise(opts.sourceText ?? '');
    const sourceIsQuotable = source.length >= MIN_SOURCE_CHARS;

    if (!entries?.length) {
      // Code-shaped only: a close naming no files is not the population D-014 is about.
      if (!evidence?.filesChanged?.some((f) => f.trim())) return undefined;
      // Self-contradiction only — see the scope note in this file's header.
      if (!opts.declaresDeferredWork) return undefined;
      // Never demand a quote from a body that states no requirements.
      if (!sourceIsQuotable) return undefined;
      return {
        kind: 'absent',
        notQuotedFromSource: [],
        implementedWithoutResolvingCitation: [],
        deferredWithoutFollowUp: [],
      };
    }

    const rawRoots = 'repoRoots' in (opts.probe ?? {}) ? opts.probe?.repoRoots : undefined;
    const repoRoots = [
      ...new Set(
        (rawRoots ?? [])
          .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
          .map((r) => nodePath.resolve(r)),
      ),
    ];
    const exists = opts.probe?.exists ?? ((abs: string) => existsSync(abs));

    const notQuotedFromSource: string[] = [];
    const implementedWithoutResolvingCitation: string[] = [];
    const deferredWithoutFollowUp: string[] = [];

    for (const entry of entries.slice(0, MAX_REQUIREMENT_ENTRIES)) {
      const quote = typeof entry?.requirement === 'string' ? entry.requirement : '';
      const trimmed = normalise(quote);

      // The verbatim test, only where there is a source to test against.
      if (sourceIsQuotable) {
        if (trimmed.length < MIN_REQUIREMENT_QUOTE_CHARS || !source.includes(trimmed)) {
          notQuotedFromSource.push(quote);
        }
      }

      if (entry?.disposition === 'implemented') {
        // Only judge where a root exists to resolve against; otherwise stay silent.
        if (repoRoots.length > 0) {
          const verdicts = (entry.citations ?? []).map((c) => citationResolves(c, repoRoots, exists));
          const anyResolved = verdicts.some((v) => v === true);
          const anyUnjudgeable = verdicts.some((v) => v === undefined);
          // No citation at all is a finding; a citation we could not judge is not.
          if (!anyResolved && !anyUnjudgeable) implementedWithoutResolvingCitation.push(quote);
        }
      } else if (entry?.disposition === 'deferred') {
        const followUp = typeof entry.followUp === 'string' ? entry.followUp : '';
        // Shape only: whether the ref RESOLVES is already `unresolvedRefsInBody`'s job,
        // and duplicating it here would make this probe async for no added signal.
        if (!detectBodyRefs(followUp).some((r) => r.kind === 'work-item')) {
          deferredWithoutFollowUp.push(quote);
        }
      }
    }

    const total =
      notQuotedFromSource.length +
      implementedWithoutResolvingCitation.length +
      deferredWithoutFollowUp.length;
    if (total === 0) return undefined;
    return {
      kind: 'unfaithful',
      notQuotedFromSource,
      implementedWithoutResolvingCitation,
      deferredWithoutFollowUp,
    };
  } catch {
    return undefined; // any throw is silence, never a finding
  }
}
