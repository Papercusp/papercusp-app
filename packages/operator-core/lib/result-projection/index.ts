/**
 * Caller-specified result projection (P-020 / D-041) — the reduction operators
 * bash gets from pipes, available on EVERY tool call at the dispatch layer.
 *
 * @see ./types.ts for the design contract (the two domains, the tier rationale,
 *      and why the regex flavor is declared rather than assumed).
 */

export {
  applyPick,
  applyResultProjection,
  classifyProjectionBody,
  parsePickPath,
  projectionMaterializationFormat,
} from './apply';
export type { ApplyProjectionOpts, ProjectableResult, ProjectionBodyShape } from './apply';
export {
  MAX_PICK_PATHS,
  MAX_PIPELINE_STAGES,
  describeProjection,
  parseProjection,
} from './parse';
export type { ProjectionParseErr, ProjectionParseOk, ProjectionParseResult } from './parse';
export { PROJECTION_ARG } from './types';
export type { ProjectionReport, ProjectionSpec, ProjectionStage } from './types';
export {
  applyNestedProjection,
  nestedProjectionContext,
  nestedProjectionInvalidMessage,
  prepareNestedProjection,
} from './nested-dispatch';
export type { PreparedNestedProjection } from './nested-dispatch';

/**
 * Named result views — schema-stable recovery capsules (P-001 of
 * named-result-views-schema-stable-recovery-capsules-with-proj-2026-08-14).
 * A stable NAME resolves to a VERSIONED field selection plus a byte budget, and
 * the receipt reports which version applied — the part free-form `pick` cannot
 * give a cold successor.
 */
export {
  NAMED_VIEWS,
  VIEW_ARG,
  VIEW_BUDGET_MARKER,
  applyNamedView,
  applyNamedViewToResult,
  describeNamedView,
  resolveNamedView,
  takeNamedViewFromArgs,
  viewNamesFor,
} from './named-views';
export type {
  AppliedNamedView,
  NamedViewDef,
  NamedViewReceipt,
  TakeNamedViewResult,
  ViewResolution,
  ViewableResult,
} from './named-views';
