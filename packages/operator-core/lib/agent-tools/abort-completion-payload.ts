/**
 * Shared payload reader for `abortCompletionReceipt` resolvers (WI-10005670).
 *
 * A mutating tool whose handler returns AFTER the dispatch deadline would otherwise
 * be reported as a bare `timeout` although its write committed (the commit-unknown
 * window). A tool opts out of that by declaring an `abortCompletionReceipt` resolver
 * that reads its OWN completed result and names the effect it recorded. Every such
 * resolver starts by locating the JSON payload in the returned ToolResult; this is
 * that one parser, so the receipts cannot drift in how they read a result envelope.
 */
import { parseJsonWithTrailer, type ToolResult } from '@papercusp/tooldef';

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The JSON payload of a completed tool result: the first text block parsed as JSON
 * (tolerating a trailing hint block), unwrapped from a `{ data }` envelope when the
 * tool returned one. `null` when the result carries no parseable object — callers
 * must treat that as "no proof of the effect" and fail closed.
 */
export function completedResultPayload(result: ToolResult): Record<string, unknown> | null {
  const firstText = result.content.find(
    (item): item is Extract<ToolResult['content'][number], { type: 'text' }> => item.type === 'text',
  );
  if (!firstText) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(firstText.text);
  } catch {
    parsed = parseJsonWithTrailer(firstText.text)?.value;
  }
  const root = asRecord(parsed);
  return asRecord(root?.data) ?? root;
}
