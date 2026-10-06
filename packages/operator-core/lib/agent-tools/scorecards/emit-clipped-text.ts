/**
 * WI-10005715 (observation EI-24791159197848671): refuse scorecard narrative that is a
 * CLIPPED TOOL RESPONSE rather than authored evidence.
 *
 * The mechanism, measured at HEAD 2026-10-02: `plans:evaluate-spec-quality` and
 * `plans:evaluate-spec-test-adequacy` return a `scorecardDraft` through the trimmed tier;
 * the MCP result door then clips the response and leaves
 * `…[TRUNCATED +N chars — see _projection.cursor]` where the tail was. An agent that
 * re-types that draft into `scorecards:emit` persists rating evidence that ENDS in the
 * marker — a graded record whose evidence is a read the grader never finished.
 *
 * `docs:author` already refuses the same shape (`truncatedBodyVerdict`, WI-1511581). This
 * reuses its detector — `hasResultDoorTruncation` from `@papercusp/docs-engine` — so there
 * is ONE definition of "the door's marker": a format change fails the docs:author tests
 * and this module's tests together instead of drifting in one place.
 *
 * Same two-sided rule as docs:author: only a field that ENDS with the marker is refused
 * (the detector is end-anchored), so a rating that quotes the marker mid-prose while
 * explaining this very failure mode still files.
 *
 * Kept free of the emit.ts module graph so the policy is unit-testable without the
 * rubric/scorecard stores.
 */
import { hasResultDoorTruncation } from '@papercusp/docs-engine';

export const CLIPPED_SCORECARD_TEXT_CODE = 'clipped_tool_response_text' as const;

/** The caller-authored narrative on a per-criterion rating. Short refs (`evidenceRef`,
 *  `evidenceKind`) are excluded: they are identifiers, never a pasted tool response. */
const RATING_TEXT_FIELDS = ['evidence', 'suggestion', 'nextEvidenceAction', 'remediation', 'disregard'] as const;

/** Structural subset of the emit args this guard reads — every field optional so the
 *  zod-inferred union (ratings absent on an acceptance-adoption emit) is assignable. */
export interface ClippableScorecardArgs {
  title?: string;
  body?: string;
  ratings?: Record<string, Partial<Record<(typeof RATING_TEXT_FIELDS)[number], string>> | undefined>;
  acceptance?: { reasoning?: string };
}

/**
 * The path of the first caller-authored text field that ends with the result door's clip
 * marker, or null when every field is whole. Path form matches what the caller sent
 * (`ratings.<criterion>.evidence`) so the refusal points at the exact field to re-send.
 */
export function findClippedScorecardText(args: ClippableScorecardArgs): string | null {
  const clipped = (value: unknown): boolean => typeof value === 'string' && hasResultDoorTruncation(value);
  if (clipped(args.title)) return 'title';
  if (clipped(args.body)) return 'body';
  if (clipped(args.acceptance?.reasoning)) return 'acceptance.reasoning';
  for (const [criterion, rating] of Object.entries(args.ratings ?? {})) {
    if (!rating) continue;
    for (const field of RATING_TEXT_FIELDS) {
      if (clipped(rating[field])) return `ratings.${criterion}.${field}`;
    }
  }
  return null;
}

/**
 * The refusal MESSAGE for a clipped field. Deliberately a string, not the `{ok,code,error}`
 * object: emit.ts builds that as an inline object LITERAL, because TypeScript only
 * normalises a union of fresh literals (every sibling gains `checkRefusal?: undefined`
 * etc.). A helper-returned object is not normalised, so it would strand every caller that
 * reads an optional field off `emitScorecard`'s result (emit.checks.test.ts did).
 * No override is offered: deleting the marker would not make the evidence whole.
 */
export function clippedScorecardTextMessage(path: string): string {
  return (
    `\`${path}\` ends with the MCP result door's clip marker (\`…[TRUNCATED +N chars — see _projection.cursor]\`), ` +
    'so it is a CLIPPED TOOL RESPONSE, not authored evidence — the tool returned the full text and the response was ' +
    'trimmed on the way to you. A scorecard built on it would cite a read that was never completed. ' +
    "Re-read the source with payloadTier:'full' (tools:invoke { name, args:{ …, payloadTier:'full' } }) or page the " +
    '`_projection.cursor` scratch spill with capability:read until eof, then re-send the COMPLETE text. ' +
    'There is no override: removing the marker does not make the evidence whole. ' +
    'A marker quoted mid-prose is fine — only a field that ENDS with it is refused. Nothing was filed.'
  );
}
