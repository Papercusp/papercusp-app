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
 *
 * WI-10004897: the message names EVERY backend the turn tried, in order. A papercup turn
 * that hit a usage cap and failed over used to report only the failover's error (a 401
 * from an expired codex copy), so the real cause, the cap, never reached the user. A
 * failover that was skipped because the alternate's login is known dead is named too,
 * with the reason.
 */
export const BRAIN_NO_OUTPUT_PREFIX = 'operator brain produced no output (agent backend failure';

const MAX_BACKEND_ERROR_CHARS = 240;

/** One attempt that produced nothing: the backend and model that ran, and its own error text. */
export interface BrainAttemptOutcome {
  engine: string | null | undefined;
  model: string | null | undefined;
  error: string | null | undefined;
}

/** A failover the turn did NOT take because the alternate's credential cannot work. */
export interface SkippedBrainFailover {
  engine: string;
  model: string;
  credential: 'absent' | 'expired-no-refresh' | 'unreadable';
}

function firstErrorLine(error: string | null | undefined): string | null {
  const line = (error ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  return line.length > MAX_BACKEND_ERROR_CHARS ? `${line.slice(0, MAX_BACKEND_ERROR_CHARS - 1)}…` : line;
}

function skippedCredentialText(skip: SkippedBrainFailover): string {
  switch (skip.credential) {
    case 'absent':
      return `this host has no ${skip.engine} credential`;
    case 'expired-no-refresh':
      return `this host's ${skip.engine} login has expired and has no refresh token, so it cannot renew itself`;
    case 'unreadable':
      return `this host's ${skip.engine} credential file could not be parsed`;
  }
}

export function brainNoOutputMessage(input: {
  attempts: readonly BrainAttemptOutcome[];
  skippedFailover?: SkippedBrainFailover | null;
}): string {
  // Consecutive attempts on the same backend with the same error read as one entry.
  const groups: Array<{ engine: string; model: string | undefined; line: string | null; count: number }> = [];
  for (const attempt of input.attempts.length ? input.attempts : [{ engine: null, model: null, error: null }]) {
    const engine = attempt.engine?.trim() || 'unknown backend';
    const model = attempt.model?.trim() || undefined;
    const line = firstErrorLine(attempt.error);
    const last = groups[groups.length - 1];
    if (last && last.engine === engine && last.model === model && last.line === line) last.count += 1;
    else groups.push({ engine, model, line, count: 1 });
  }
  const parts = groups.map((g) => {
    const ran = `${g.model ? `${g.engine}, model ${g.model}` : g.engine}${g.count > 1 ? ` (${g.count} attempts)` : ''}`;
    return g.line
      ? `${ran}: ${g.line}`
      : `${ran} returned an empty turn and reported no error; check that this host has a working ${g.engine} credential`;
  });
  let text = parts.join('; then ');
  const skip = input.skippedFailover;
  if (skip) text += `; failover to ${skip.engine} (model ${skip.model}) skipped: ${skippedCredentialText(skip)}`;
  return `${BRAIN_NO_OUTPUT_PREFIX}: ${text})`;
}
