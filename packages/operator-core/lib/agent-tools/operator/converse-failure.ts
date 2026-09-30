/**
 * The user-facing error for a converse turn whose agent backend produced nothing.
 *
 * WI-10003188: this used to be the fixed string
 * `operator brain produced no output (agent backend failure)`. On a hosted workspace
 * host whose chat role is pinned to a backend with no credential, every portal turn
 * failed with exactly that text, so the person reading it could not tell
 * "this host has no credential for backend codex" from a transient upstream fault.
 * The real cause was already in hand — `runAgentChat` yields a terminal `error`
 * event with a message — but it only reached the host journal.
 *
 * The message now names the backend and model that actually ran and carries the
 * backend's own error line. Only the first line of `message` is used and it is
 * capped: stderr stays in the journal, because it can hold paths and environment
 * detail that do not belong in a chat surface.
 *
 * The leading `operator brain produced no output (agent backend failure` is kept
 * verbatim so anything grepping logs for the old text still matches.
 */
export const BRAIN_NO_OUTPUT_PREFIX = 'operator brain produced no output (agent backend failure';

const MAX_BACKEND_ERROR_CHARS = 240;

export function brainNoOutputMessage(input: {
  engine: string | null | undefined;
  model: string | null | undefined;
  lastBackendError: string | null | undefined;
}): string {
  const engine = input.engine?.trim() || 'unknown backend';
  const model = input.model?.trim();
  const ran = model ? `${engine}, model ${model}` : engine;
  const firstLine = (input.lastBackendError ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine) {
    const clipped =
      firstLine.length > MAX_BACKEND_ERROR_CHARS ? `${firstLine.slice(0, MAX_BACKEND_ERROR_CHARS - 1)}…` : firstLine;
    return `${BRAIN_NO_OUTPUT_PREFIX}: ${ran}: ${clipped})`;
  }
  return (
    `${BRAIN_NO_OUTPUT_PREFIX}: ${ran} returned an empty turn and reported no error; ` +
    `check that this host has a working ${engine} credential)`
  );
}
