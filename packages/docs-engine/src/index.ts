/**
 * @papercusp/docs-engine — source-agnostic docs retrieval.
 *
 * Engine functions operate on a DocSource (adapter). Each surface
 * (public Papercusp docs, per-harness docs, future internal-engineering
 * docs) registers thin defineTool wrappers that instantiate an adapter
 * and call the engine. One implementation; many surfaces.
 */

export type {
  DocHeading,
  DocPage,
  DocSource,
  SectionMeta,
  EngineCtx,
  OutlinePayload,
  OutlinePageEntry,
  OutlineSectionEntry,
  GetArgs,
  GetEntry,
  GetResult,
  SearchArgs,
  SearchHit,
  SearchResult,
} from './types.js';

export {
  OKF_VERSION,
  parseOkfFrontmatter,
  okfFromObject,
  normalizeOkfDate,
  evaluateOkfTrust,
  okfTrustBanner,
  okfTrustIsNotable,
  CANONICAL_DOC_STATUSES,
  DOC_STATUS_ALIASES,
  normalizeDocStatus,
  isCanonicalDocStatus,
  isRetiredDocStatus,
  isMachineVerifier,
  type OkfFrontmatter,
  type OkfTrust,
  type OkfTrustTier,
  type OkfVerifiedEvent,
  type CanonicalDocStatus,
  type DocStatusAlias,
  parseFrontmatterBlock,
  type FrontmatterBlock,
} from './okf.js';

export {
  findOkfDocViolations,
  findOkfManifestViolations,
  formatOkfViolations,
  OKF_CONFORMANCE_RULES,
  OKF_MANIFEST_KEY,
  type OkfConformanceRule,
  type OkfViolation,
} from './okf-conformance.js';

export { buildOutline } from './outline.js';
export { getDocs, MAX_PAYLOAD_BYTES } from './get.js';
export { searchDocs, tokenize } from './search.js';

export {
  reactToText,
  escapeRegex,
  humanize,
  levenshtein,
  levenshteinNearest,
  sliceByHeading,
  truncationTail,
  hasTruncationTail,
  hasResultDoorTruncation,
  TRUNCATION_TAIL_MARKER,
  TRUNCATION_TAIL_WINDOW,
  RESULT_DOOR_TRUNCATION_RE,
  type TocEntry,
  type NearestOpts,
} from './shared.js';

export { renderMdxToMarkdown, withPreamble } from './render-mdx.js';

export { harnessFsAdapter, type HarnessFsAdapterOptions } from './adapters/harness-fs.js';
export { genericFsAdapter, type GenericFsAdapterOptions } from './adapters/generic-fs.js';
export {
  starlightContentAdapter,
  type StarlightContentAdapterOptions,
} from './adapters/starlight.js';
export { RunCache, type RunCacheCtx } from './per-run-cache.js';
