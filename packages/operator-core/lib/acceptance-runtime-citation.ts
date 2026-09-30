/**
 * acceptance-runtime-citation.ts — graders and rubric review must NAME the runtime
 * (acceptance-runtime-plane-not-main-2026-09-23 P-004).
 *
 * 2026-09-23: the independent grader rated a live BAR `generation-mismatch` with "wait for
 * deployed:true" — measured on :3070 by default, without saying so — and the implementer
 * deferred to it. The code ran in bg-host; the mismatch was an artifact of measuring the
 * wrong runtime. Two backstops:
 *
 *  1. GRADING — an unknown / mismatch / not-deployed rating on a live or deployed acceptance
 *     BAR must cite the serving runtime it measured AND that runtime's build sha. Such a
 *     rating is a claim about a specific process; without both, nobody can tell whether it
 *     measured the runtime the BAR is about.
 *  2. VETTING — a live/deployed criterion that declares no `evidenceRuntime` gets a finding,
 *     so the gap is fixed when the rubric is written, not discovered at grading.
 */
import { resolveBarEvidenceRuntime, type BarEvidenceRuntime } from './acceptance-bar-evidence-runtime';
import { servingRuntimesMentioned, type ServingRuntimeId } from './serving-runtimes';

/** Ratings that assert the change is not (yet) observable on some runtime. */
export function ratingNeedsRuntimeCitation(rating: string | null | undefined): boolean {
  if (!rating) return false;
  const r = rating.trim().toLowerCase();
  return (
    r === 'unknown' ||
    r.includes('mismatch') ||
    /\bnot[- ]?(yet[- ]?)?(deployed|live)\b/.test(r) ||
    /\b(pending|awaiting)[- ]?(deploy|deployment|main)\b/.test(r)
  );
}

/** A commit/build sha: 7–40 hex chars containing at least one digit (so "deadbeef"-words and prose don't count). */
const SHA_RE = /\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/i;

export interface RuntimeCitationGap {
  missing: Array<'runtime' | 'sha'>;
  runtimesCited: ServingRuntimeId[];
}

export function validateRuntimeCitation(input: {
  rating: string | null | undefined;
  evidence: string | null | undefined;
  evidencePlane: 'tree' | 'deployed' | 'live' | null | undefined;
}): RuntimeCitationGap | null {
  if (input.evidencePlane !== 'live' && input.evidencePlane !== 'deployed') return null;
  if (!ratingNeedsRuntimeCitation(input.rating)) return null;
  const evidence = input.evidence ?? '';
  const runtimesCited = servingRuntimesMentioned(evidence);
  const missing: Array<'runtime' | 'sha'> = [];
  if (runtimesCited.length === 0) missing.push('runtime');
  if (!SHA_RE.test(evidence)) missing.push('sha');
  return missing.length ? { missing, runtimesCited } : null;
}

type CitationCriterion = {
  key: string;
  barKey?: string;
  evidencePlane?: 'tree' | 'deployed' | 'live';
  evidenceRuntime?: ServingRuntimeId;
  model?: string;
  method?: string;
  driftMarkers?: string;
  replication?: string;
};

/** scorecards:emit refusal for an acceptance card, or null when every rating is citable. */
export function runtimeCitationRefusal(
  criteria: ReadonlyArray<CitationCriterion>,
  ratings: Record<string, { rating?: string | null; evidence?: string | null } | undefined> | null | undefined,
): { code: 'acceptance_runtime_citation_missing'; error: string } | null {
  if (!ratings) return null;
  const byKey = new Map(criteria.map((c) => [c.key, c]));
  const gaps: string[] = [];
  for (const [key, entry] of Object.entries(ratings)) {
    const criterion = byKey.get(key);
    if (!criterion || !entry) continue;
    const gap = validateRuntimeCitation({
      rating: entry.rating,
      evidence: entry.evidence,
      evidencePlane: criterion.evidencePlane,
    });
    if (!gap) continue;
    const expected = resolveBarEvidenceRuntime(criterion).runtime;
    gaps.push(
      `'${criterion.barKey ?? key}' rated '${entry.rating}' without ${gap.missing.join(' and ')}` +
        (expected ? ` (this BAR is measured on ${expected})` : ''),
    );
  }
  if (gaps.length === 0) return null;
  return {
    code: 'acceptance_runtime_citation_missing',
    error:
      `acceptance_runtime_citation_missing: an unknown/mismatch/not-deployed rating on a live or deployed BAR is a claim about ONE ` +
      `runtime, so its evidence must name that runtime (release-operator/:3070, staging-operator/:3170, bg-host, gateway, ` +
      `embed-sidecar, psu-pty-host, desktop-shell) AND the build sha you measured there. ${gaps.join('; ')}. ` +
      `Read dev:pipeline_position { path } → servingRuntimes for each runtime's build and containsChange — the change may ` +
      `already be live on the runtime the BAR is about, in which case grade it there instead of waiting on main.`,
  };
}

export interface RuntimeVettingFinding {
  key: string;
  barKey: string;
  evidencePlane: 'deployed' | 'live';
  resolution: BarEvidenceRuntime;
  finding: string;
}

/** One finding per live/deployed criterion that declares no evidenceRuntime. */
export function runtimeVettingFindings(criteria: ReadonlyArray<CitationCriterion>): RuntimeVettingFinding[] {
  const out: RuntimeVettingFinding[] = [];
  for (const c of criteria) {
    if (c.evidencePlane !== 'live' && c.evidencePlane !== 'deployed') continue;
    if (c.evidenceRuntime) continue;
    const resolution = resolveBarEvidenceRuntime(c);
    out.push({
      key: c.key,
      barKey: c.barKey ?? c.key,
      evidencePlane: c.evidencePlane,
      resolution,
      finding:
        `${c.barKey ?? c.key} is a ${c.evidencePlane} BAR with no evidenceRuntime — ` +
        (resolution.runtime
          ? `inferred ${resolution.runtime} from ${resolution.inferredFrom.join(', ')}; declare it (acceptance.evidenceRuntime) so graders measure there and not on :3070.`
          : `nothing to infer it from; declare acceptance.evidenceRuntime, or a grader will default to :3070 and wait on main.`),
    });
  }
  return out;
}
