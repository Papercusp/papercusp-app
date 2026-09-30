/**
 * content-lint — pure content-validity detectors shared by the CI lint scripts
 * (scripts/check-mdx.mjs, scripts/check-smart-quotes.mjs), the git-sync content
 * guard (run-git-sync.ts), and the content-fixer's success-check
 * (git-sync-content-guard-2026-06-13 P-007 / D-003). One implementation of "is
 * this file valid" so the three can never disagree.
 */
export { blankFrontmatter, findMdxCompileError, type MdxCompileError } from './mdx';
export { findCodePositionCurlyQuotes, curlyLabel, CURLY, type CurlyQuoteHit } from './smart-quotes';
export { findStaleInsightCitations, formatStaleCitations, type StaleCitation } from './insight-citations';
export { findConflictMarker, CONFLICT_MARKER_ERE, type ConflictMarkerHit } from './conflict-markers';
export { findTsParseError, type TsParseError } from './ts-parse';
export { findEsbuildTransformError, type EsbuildTransformError } from './esbuild-transform';
export {
  findSqlCommentBacktick,
  sqlCommentBacktickScopeMatches,
  type SqlCommentBacktickHit,
} from './sql-comment-backtick';
export { findConstantConditional, type ConstantConditionalHit } from './constant-conditional';
export {
  type ContentDetector,
  mdxDetector,
  smartQuotesDetector,
  tsParseDetector,
  esbuildTransformDetector,
  sqlCommentBacktickDetector,
  shellSyntaxDetector,
  conflictMarkersDetector,
  constantConditionalDetector,
  DEFAULT_CONTENT_DETECTORS,
  CONTENT_FIXER_ROLE,
} from './registry';
