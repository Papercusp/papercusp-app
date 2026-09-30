/**
 * project-fact-row.ts — the coord:orient standing-facts projection, extracted and made
 * TESTABLE (EI-19390161700979033).
 *
 * WHY THIS IS ITS OWN MODULE. The projection used to be an inline object literal inside
 * orient's facts fold: an explicit FIELD WHITELIST that every marker in the pipeline had
 * to separately remember to add itself to. Forgetting is SILENT and passes every test —
 * the marker runs, its own unit tests pass against the helper's return value, the fold
 * "works", and the field simply never reaches the agent. There is no error and no type
 * failure, because the literal is built from conditional spreads (so neither excess nor
 * missing properties are checked) and the tool's declared result type never listed most of
 * these fields either.
 *
 * That defect has now landed THREE times, and the code carried two of its own post-mortems
 * in comments before this extraction:
 *   • P-033 (e) — the same whitelist defect in `toAgentMessageRow`.
 *   • P-018 (`kind`) — "the MODALITY, which this projection dropped, so a normative
 *     convention arrived byte-identical to a settled conclusion, at the one surface every
 *     agent reads every wake ... the field was stored and the reader simply never
 *     selected it."
 *   • WI-7236 (`contested`) — caught only because the author happened to read far enough
 *     to notice the rule existed.
 *
 * A defect documented twice IN-FILE and still repeatable is a structural problem, not an
 * attention problem. So the projection is now a pure function with {@link FACT_MARKER_FIELDS}
 * as its declared inventory, and `project-fact-row.test.ts` asserts every listed field
 * round-trips. Add a marker without projecting it and that test fails loudly, at the point
 * of the mistake, instead of the field silently never reaching an agent.
 *
 * EMISSION RULE (unchanged, and load-bearing): every marker field is emitted ONLY when
 * present/true, so an ordinary fold stays byte-identical to what it was before any of
 * these markers existed. That is what keeps the fold cheap for the common case.
 */
import { renderFactSrc, factCitationRef, type AgentFact, type FactMeasurement } from '../../agent-facts/store';
import type { FactDependencyStaleness } from './dependency-staleness';
import type { FactContestMark } from './contested-fold';

/**
 * The marker fields this projection is responsible for emitting — the declared inventory
 * the completeness test enumerates.
 *
 * ⚠ ADDING A MARKER? Add its projected NAME here AND emit it in {@link projectFactRow}.
 * The test walks this list, so an entry with no emission fails; a field emitted but never
 * listed here is invisible to the guard and is exactly the silent drop this exists to stop.
 */
export const FACT_MARKER_FIELDS = [
  'stale',
  'dependsStale',
  'contested',
  'kind',
  'changed',
  'enforcement',
  'cite',
  'measurement',
] as const;

export type FactMarkerField = (typeof FACT_MARKER_FIELDS)[number];

/** A folded fact plus whatever the marker pipeline decorated it with. */
export type FoldedFact = AgentFact & {
  sourceStale?: unknown;
  depsStale?: FactDependencyStaleness;
  contested?: FactContestMark;
};

/** One projected row as coord:orient emits it under `facts`. */
export interface ProjectedFactRow {
  scope: string;
  ref: string | null;
  body: string;
  src: string | null;
  aud?: string;
  stale?: unknown;
  dependsStale?: FactDependencyStaleness;
  contested?: FactContestMark;
  kind?: string;
  changed?: true;
  enforcement?: unknown;
  cite?: string;
  measurement?: FactMeasurement;
}

/**
 * PURE: project one folded fact into its orient row.
 *
 * `changed` is passed in rather than derived, because it is a property of the CALLER's
 * watermark (P-008 c / D-012), not of the fact.
 */
export function projectFactRow(f: FoldedFact, opts: { changed?: boolean } = {}): ProjectedFactRow {
  return {
    scope: f.scope,
    ref: f.scopeRef,
    body: f.body,
    // P-007: provenance-hydrated src — a verified typed sourceRef renders its
    // platform-captured verbatim quote (`msg:x ✓ "…"`); an unresolvable one
    // renders LOUDLY (`✗unverified`); free-text anchors pass through as before.
    src: renderFactSrc(f) || null,
    ...(f.audienceScope ? { aud: f.audienceScope } : {}),
    // EI-20191740437408337: the fold must carry the structured snapshot marker
    // alongside the human-readable renderer's warning.
    ...(f.measurement ? { measurement: f.measurement } : {}),
    ...(f.sourceStale ? { stale: f.sourceStale } : {}),
    // P-008 (b): kept DISTINCT from `stale` above. `stale` is a hint (the anchoring
    // work-item closed); `dependsStale` is a mechanical verdict on a dependency the
    // fact's own author declared.
    ...(f.depsStale ? { dependsStale: f.depsStale } : {}),
    // P-006 read side (WI-7236): this key is contested, or was already settled as
    // UNDECIDABLE by someone else. DISTINCT from both markers above — those say the
    // ground under this fact moved; this says other agents wrote a DIFFERENT answer to
    // the same question, so read it as one party's answer rather than settled.
    ...(f.contested ? { contested: f.contested } : {}),
    // P-018: the MODALITY. Emitted ONLY when declared, so the common case (a legacy
    // fact with no kind) stays byte-identical and this costs the fold nothing.
    ...(f.kind ? { kind: f.kind } : {}),
    // P-008 (c) / D-012: asserted or superseded since this caller last oriented.
    ...(opts.changed ? { changed: true as const } : {}),
    ...(f.kind === 'convention'
      ? {
          // D-016's tier — and `cite`, the ref to pass verbatim as a `premises` entry at
          // the point of action (D-075 R1). Without it the fold could name a convention
          // it gave you no way to cite.
          ...(f.enforcement ? { enforcement: f.enforcement } : {}),
          cite: factCitationRef(f),
        }
      : {}),
  };
}
