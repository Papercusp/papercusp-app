/**
 * Compact-by-default REVIEW reads (review-system-rework-reduction-2026-09-23 P-007,
 * clause RSR-P-007-A).
 *
 * The three reads a reviewer or grader leans on — plans:evaluate-spec-test-adequacy,
 * plans:get-spec-evidence and rubrics:get — returned their full bodies on every call:
 * one spec evaluation measured ~138 KB, and ~950k chars of such output across one review
 * session forced three carry-respawns in 3.3 h. Most calls only need the verdicts.
 *
 * So each read now answers with a per-clause (per-binding / per-criterion) TABLE by
 * default and a `fullBody` REF — a ready re-call with `detail:'full'` — and returns the
 * unabridged body only when asked. This is a published argument, not the framework-
 * reserved `payloadTier`: rubrics:get deliberately ignores session payload tiers
 * (EI-21406267171411887), and a reviewer must be able to SEE the full-body switch in the
 * tool's own schema rather than learn a reserved dispatch key.
 */
import { z } from 'zod';

export const REVIEW_READ_DETAILS = ['summary', 'full'] as const;
export type ReviewReadDetail = (typeof REVIEW_READ_DETAILS)[number];

export const reviewReadDetailArg = z
  .enum(REVIEW_READ_DETAILS)
  .optional()
  .describe(
    "Response size. Default 'summary' returns a compact verdict table plus a fullBody ref; 'full' returns the complete body (evidence text, drafts, criteria prose).",
  );

/** The ref every summary carries: the exact re-call that returns the full body. */
export type FullBodyRef = {
  tool: string;
  args: Record<string, unknown>;
  omitted: string[];
};

export function fullBodyRef(tool: string, args: Record<string, unknown>, omitted: string[]): FullBodyRef {
  const { detail: _detail, ...rest } = args;
  return { tool, args: { ...rest, detail: 'full' }, omitted };
}

export function isFullDetail(detail: ReviewReadDetail | undefined): boolean {
  return detail === 'full';
}
