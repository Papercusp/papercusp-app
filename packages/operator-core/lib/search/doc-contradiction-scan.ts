/**
 * P-004 composition: the deterministic leg's findings -> kinds -> the judged leg.
 *
 * Plan: guidance-overlap-contradiction-scan-2026-08-08 (P-004).
 *
 * This module is the only place that knows about all three of Postgres, the
 * inference gateway, and the feature flag. The two modules it composes
 * (`doc-section-pair-kind`, `doc-contradiction-judge`) are pure and take their
 * world by injection, which is what makes the contract in
 * `doc-contradiction-judge` testable at all.
 *
 * ## Why kinds are ATTRIBUTED here rather than added to `DocOverlapFinding`
 *
 * Adding a required `kind` to that exported interface would strand every site
 * that constructs one — the documented trigger for `lint:required-field-strands`
 * — in files this change never touches, for no gain: the deterministic scan
 * (P-003, shipped and calibrated) has no use for a kind. So P-004 composes on
 * top of that report instead of reaching into it.
 */

import { getOrgPg } from '@papercusp/db-org';
import {
  decodeSectionId,
  encodeSectionId,
  type DocOverlapFinding,
  type DocSectionRef,
} from './doc-section-overlap';
import { classifyOverlapPair, type PairKindVerdict } from './doc-section-pair-kind';
import {
  judgeContradictions,
  buildContradictionPrompt,
  type ContradictionJudgeFn,
  type ContradictionReport,
  type JudgeCandidate,
  type JudgeSection,
} from './doc-contradiction-judge';
import { ANTHROPIC_JUDGE_MODEL } from '../memory/anthropic-judge';
import { ensureJevDecisionClient, readJevApiKey } from '../memory/jev-settings';
import { createJevContradictionJudge } from './jev-contradiction-judge';

/** A deterministic finding, with D-004's kind attributed to it. */
export interface KindedFinding extends DocOverlapFinding, PairKindVerdict {}

/**
 * Attach a kind to each finding. Pure: titles come from the caller.
 *
 * A finding whose section carries no title still classifies — `classifyOverlapPair`
 * refuses to read blank-equals-blank as a shared origin, so a missing title
 * degrades the verdict to a surface-based one rather than manufacturing a
 * confident `rehomed-copy` out of two absences.
 */
export function attributeKinds(
  findings: readonly DocOverlapFinding[],
  titles: ReadonlyMap<string, string>,
): KindedFinding[] {
  return findings.map((finding) => {
    const verdict = classifyOverlapPair(
      { ref: finding.refA, title: titles.get(finding.a) ?? '' },
      { ref: finding.refB, title: titles.get(finding.b) ?? '' },
    );
    return { ...finding, ...verdict };
  });
}

/** Judge candidates from kinded findings — the shape the judged leg consumes. */
export function toJudgeCandidates(findings: readonly KindedFinding[]): JudgeCandidate[] {
  return findings.map((f) => ({ a: f.a, b: f.b, similarity: f.similarity, kind: f.kind }));
}

/** Section ids -> titles, for kind attribution. One query, only the reported ids. */
export async function loadSectionTitles(ids: readonly string[]): Promise<Map<string, string>> {
  const rows = await loadSectionRows(ids);
  return new Map(rows.map((r) => [r.id, r.title]));
}

/** Section ids -> title + content, for the judge. One query, only the pairs asked. */
export async function loadJudgeSections(ids: readonly string[]): Promise<Map<string, JudgeSection>> {
  const rows = await loadSectionRows(ids);
  return new Map(rows.map((r) => [r.id, { id: r.id, title: r.title, content: r.content }]));
}

/**
 * Fetch rows for a set of encoded section ids.
 *
 * ## Why this over-fetches and then filters in JS, rather than matching the PK tuple
 *
 * The exact query is a row-constructor `IN` over `(source_key, slug, anchor)`.
 * That idiom has ZERO precedent in this package — every other query here uses
 * `= ANY(${array})` — and an unverified SQL shape on the path that feeds the
 * judge fails in the direction that matters: a query that silently matches
 * nothing returns an empty map, every pair is then counted as `contentMissing`,
 * and the run reports inconclusive for a reason that has nothing to do with the
 * corpus. So this composes three `= ANY` filters (the verified idiom) into a
 * deliberate SUPERSET and narrows it by exact id membership in JS, where the
 * narrowing is testable.
 *
 * The over-fetch is bounded by the ids actually asked for — at most the
 * distinct source_keys x slugs x anchors of the reported pairs — and both
 * callers pass only the ids of pairs already selected, never the corpus.
 *
 * A row whose id does not decode is dropped HERE rather than sent to Postgres.
 * Every dropped id is simply absent from the returned map, which both callers
 * treat as missing content and COUNT, so nothing vanishes silently.
 */
async function loadSectionRows(
  ids: readonly string[],
): Promise<Array<{ id: string; title: string; content: string }>> {
  if (ids.length === 0) return [];
  const wanted = new Set<string>();
  const refs: DocSectionRef[] = [];
  for (const id of ids) {
    const ref = decodeSectionId(id);
    if (ref) {
      refs.push(ref);
      wanted.add(id);
    }
  }
  if (refs.length === 0) return [];

  const sourceKeys = Array.from(new Set(refs.map((r) => r.sourceKey)));
  const slugs = Array.from(new Set(refs.map((r) => r.slug)));
  const anchors = Array.from(new Set(refs.map((r) => r.anchor)));

  const { sql } = getOrgPg();
  const rows = await sql<Array<{ source_key: string; slug: string; anchor: string; title: string; content: string }>>`
    SELECT source_key, slug, anchor, title, content
      FROM harness_shared.doc_sections
     WHERE source_key = ANY(${sourceKeys})
       AND slug = ANY(${slugs})
       AND anchor = ANY(${anchors})`;

  const out: Array<{ id: string; title: string; content: string }> = [];
  for (const r of rows) {
    const id = encodeSectionId({ sourceKey: r.source_key, slug: r.slug, anchor: r.anchor });
    // The superset above can match a (slug, anchor) combination nobody asked
    // for; only exact ids survive.
    if (!wanted.has(id)) continue;
    out.push({ id, title: r.title, content: r.content });
  }
  return out;
}

/**
 * Is the contradiction leg enabled? A FLAGS capability, never an ad-hoc
 * `process.env.PAPERCUSP_*` boolean — an env gate ships dark, dodges the
 * default-on guard and the dark-flag expiry, and cannot be flipped at runtime.
 * (That mis-classification is itself the filed root cause behind the inert
 * memory conflict-check: EI-18747066020546067.)
 */
export async function contradictionScanEnabled(): Promise<boolean> {
  try {
    const { getFlag } = await import('@papercusp/flags/server');
    const { FLAGS } = await import('@papercusp/flags');
    return Boolean(await getFlag(FLAGS.GUIDANCE_CONTRADICTION_SCAN, 'system'));
  } catch {
    // Fail CLOSED, and the caller reports it as inconclusive rather than clean:
    // a flag store we cannot read is not permission to skip the leg silently.
    return false;
  }
}

/**
 * Can a REAL judge be built? Cheap and synchronous BY DESIGN — it only asks
 * whether a credential resolves, and deliberately does NOT construct a client,
 * because its whole purpose is to be checked BEFORE the expensive work that
 * feeds the judge (loading section content for every eligible pair).
 *
 * Reused wholesale from `memory/anthropic-judge`, which added the probe for
 * exactly this reason after `remember.ts` was measured running a full semantic
 * neighbour search on every write to feed a judge that could never answer.
 */
export function contradictionJudgeAvailable(opts?: { apiKey?: string }): boolean {
  return Boolean((opts?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '').trim());
}

/**
 * Haiku-class: the question is narrow and the volume is what costs money.
 * Shared with the memory judge so a model retirement is fixed in one place:
 * this used to pin `claude-3-5-haiku-latest`, which now answers HTTP 404, so
 * every pair came back as a judge error on any keyed host (WI-10004165).
 */
export const DOC_CONTRADICTION_JUDGE_MODEL = ANTHROPIC_JUDGE_MODEL;
const JUDGE_MODEL = DOC_CONTRADICTION_JUDGE_MODEL;

/**
 * The gateway-routed judge.
 *
 * Routed through the inference gateway so this leg load-balances across the
 * account pool and is paced like every other call, instead of egressing direct
 * to one account on its API key.
 *
 * ⚠ Every failure path returns `null`, NEVER `{ contradicts: false }`. That is
 * the whole discipline: a `false` from a judge that never ran is indistinguishable
 * from a real "these agree", and `judgeContradictions` counts a `null` as an
 * error and refuses to call an all-null run clean.
 */
export function createGatewayContradictionJudge(opts?: {
  apiKey?: string;
  model?: string;
}): ContradictionJudgeFn {
  const apiKey = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
  const model = opts?.model ?? JUDGE_MODEL;

  return async ({ a, b }) => {
    if (!apiKey) return null;
    try {
      const mod = (await import('@anthropic-ai/sdk')) as unknown as {
        default: new (o: { apiKey: string; baseURL?: string }) => {
          messages: {
            create: (args: unknown) => Promise<{ content?: Array<{ type?: string; text?: string }> }>;
          };
        };
      };
      let baseURL = process.env.PAPERCUSP_ANTHROPIC_URL ?? process.env.ANTHROPIC_BASE_URL;
      if (!baseURL) {
        try {
          const { getFlag } = await import('@papercusp/flags/server');
          const { FLAGS } = await import('@papercusp/flags');
          if (await getFlag(FLAGS.INFERENCE_GATEWAY, 'system')) {
            const { gatewayLlmEnv } = await import('../inference-gateway/spawn-env');
            baseURL = gatewayLlmEnv(true).PAPERCUSP_ANTHROPIC_URL;
          }
        } catch {
          /* best-effort: gateway resolution must never turn into a false verdict */
        }
      }
      const client = new mod.default({ apiKey, ...(baseURL ? { baseURL } : {}) });
      const res = await client.messages.create({
        model,
        max_tokens: 300,
        messages: [{ role: 'user', content: buildContradictionPrompt(a, b) }],
      });
      const text = (res.content ?? [])
        .filter((part) => part?.type === 'text')
        .map((part) => part.text ?? '')
        .join('');
      return parseContradictionVerdict(text);
    } catch {
      return null;
    }
  };
}

export type ContradictionJudgeBackend = 'jev' | 'anthropic';

export type ContradictionJudgeResolution =
  | { readonly available: true; readonly backend: ContradictionJudgeBackend; readonly judge: ContradictionJudgeFn }
  | { readonly available: false; readonly reason: string };

export const CONTRADICTION_JUDGE_UNAVAILABLE_REASON =
  'no Jev key is stored (Settings > Memory) and no ANTHROPIC_API_KEY resolves in this process';

export interface ContradictionJudgeDeps {
  readonly readJevKey: () => Promise<string | null>;
  readonly anthropicAvailable: () => boolean;
  readonly jevJudge: () => ContradictionJudgeFn;
  readonly anthropicJudge: () => ContradictionJudgeFn;
}

const defaultContradictionJudgeDeps: ContradictionJudgeDeps = {
  readJevKey: readJevApiKey,
  anthropicAvailable: () => contradictionJudgeAvailable(),
  jevJudge: () => createJevContradictionJudge({ client: ensureJevDecisionClient }),
  anthropicJudge: () => createGatewayContradictionJudge(),
};

/**
 * Which contradiction judge runs, if any (plan jev-decision-model-integration-2026-09-29,
 * P-010, decisions D-017 and D-018).
 *
 * Jev when a Jev key is stored (it met the D-017 bar, D-018), else the Anthropic
 * judge when ANTHROPIC_API_KEY resolves, else no judge, which `judgeContradictions`
 * reports as inconclusive rather than clean. Same order as the memory conflict
 * judge (resolveConflictJudge, D-016), so one stored key moves both narrow judges.
 * A key store that cannot be read counts as "no Jev key", never as an error that
 * disables the Anthropic fallback.
 */
export async function resolveContradictionJudge(
  deps: ContradictionJudgeDeps = defaultContradictionJudgeDeps,
): Promise<ContradictionJudgeResolution> {
  let jevKey: string | null = null;
  try {
    jevKey = await deps.readJevKey();
  } catch {
    jevKey = null;
  }
  if (jevKey) return { available: true, backend: 'jev', judge: deps.jevJudge() };
  if (deps.anthropicAvailable()) return { available: true, backend: 'anthropic', judge: deps.anthropicJudge() };
  return { available: false, reason: CONTRADICTION_JUDGE_UNAVAILABLE_REASON };
}

/**
 * Parse the judge's reply. Returns `null` for anything not recognisably a
 * verdict — an unparseable answer is a judge error, not a "no".
 */
export function parseContradictionVerdict(
  text: string,
): { contradicts: boolean; reason: string } | null {
  if (typeof text !== 'string') return null;
  const match = text.match(/\{[\s\S]*\}/u);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { contradicts?: unknown; reason?: unknown };
    if (typeof parsed?.contradicts !== 'boolean') return null;
    return {
      contradicts: parsed.contradicts,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    };
  } catch {
    return null;
  }
}

export interface RunContradictionLegOptions {
  findings: readonly DocOverlapFinding[];
  /** The stricter, SECOND threshold that keeps the LLM leg cheap. Required. */
  judgeThreshold: number;
  /** Hard cap on judge calls per run. */
  maxJudged: number;
  /** Overridable for tests; defaults to the live flag / credential / stores. */
  deps?: Partial<{
    enabled: () => Promise<boolean>;
    /** Which judge runs. Defaults to {@link resolveContradictionJudge}. */
    resolveJudge: () => Promise<ContradictionJudgeResolution>;
    loadTitles: (ids: readonly string[]) => Promise<Map<string, string>>;
    loadSections: (ids: readonly string[]) => Promise<Map<string, JudgeSection>>;
  }>;
}

export interface ContradictionLegResult {
  kinded: KindedFinding[];
  report: ContradictionReport;
  /** Which judge answered, or null when none could be built. */
  judgeBackend: ContradictionJudgeBackend | null;
}

/**
 * Run the contradiction leg over a deterministic scan's findings.
 *
 * Kind attribution happens for EVERY finding (it is free and it is what the
 * report buckets on); only the pairs that clear `judgeThreshold` cost a call.
 */
export async function runContradictionLeg(
  opts: RunContradictionLegOptions,
): Promise<ContradictionLegResult> {
  const deps = opts.deps ?? {};
  const enabled = await (deps.enabled ?? contradictionScanEnabled)();
  // Resolved BEFORE any section content is loaded, so an unavailable judge is
  // never fed (the reason contradictionJudgeAvailable exists).
  const resolution = await (deps.resolveJudge ?? resolveContradictionJudge)();

  const titleIds = Array.from(new Set(opts.findings.flatMap((f) => [f.a, f.b])));
  const titles = await (deps.loadTitles ?? loadSectionTitles)(titleIds);
  const kinded = attributeKinds(opts.findings, titles);

  const report = await judgeContradictions({
    candidates: toJudgeCandidates(kinded),
    judgeThreshold: opts.judgeThreshold,
    maxJudged: opts.maxJudged,
    enabled,
    judgeAvailable: resolution.available,
    loadSections: deps.loadSections ?? loadJudgeSections,
    judge: resolution.available ? resolution.judge : async () => null,
  });

  return { kinded, report, judgeBackend: resolution.available ? resolution.backend : null };
}
