/**
 * Turn a transport failure into a ledger detail that is never empty (WI-10005372).
 *
 * WHY. The ledger stored `err.message` as the network-error detail. Node reports a
 * connect that failed on every address of a multi-address host (api.typesafe.ai has
 * two IPv4 and two IPv6 addresses; Node's happy-eyeballs connect tries them all) as an
 * `AggregateError` whose message is the EMPTY string: the cause lives only in `code`
 * and in the per-address `errors`. Measured 2026-10-02: 221 memory-injection calls
 * failed in about 2 ms with `network-error` and an empty detail, so nothing on record
 * said why. undici's `TypeError: fetch failed` hides its cause the same way, one
 * level down in `cause`.
 *
 * The description names the error class, its code, its message, any nested errors and
 * the cause chain, bounded in depth and count, and falls back to an explicit
 * "(no message)" rather than ever returning ''.
 */

/** The fields of an error that survive a thread hop (a worker posts these, not the Error). */
export interface ErrorFields {
  name: string;
  message: string;
  code: string | null;
  errors: ErrorFields[];
  cause: ErrorFields | null;
}

const MAX_NESTED = 4;
const MAX_DEPTH = 3;

function codeOf(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

/** Copy the describable fields of any thrown value into plain, cloneable data. */
export function errorFields(err: unknown, depth = 0): ErrorFields {
  if (typeof err !== 'object' || err === null) {
    return { name: 'Error', message: err === undefined ? '' : String(err), code: null, errors: [], cause: null };
  }
  const e = err as { name?: unknown; message?: unknown; code?: unknown; errors?: unknown; cause?: unknown };
  const nested = depth < MAX_DEPTH && Array.isArray(e.errors) ? e.errors.slice(0, MAX_NESTED) : [];
  return {
    name: typeof e.name === 'string' && e.name !== '' ? e.name : 'Error',
    message: typeof e.message === 'string' ? e.message.trim() : '',
    code: codeOf(e.code),
    errors: nested.map((inner) => errorFields(inner, depth + 1)),
    cause: depth < MAX_DEPTH && e.cause !== undefined && e.cause !== null ? errorFields(e.cause, depth + 1) : null,
  };
}

function render(f: ErrorFields): string {
  let text = f.code ? `${f.name} [${f.code}]` : f.name;
  if (f.message) text += `: ${f.message}`;
  if (f.errors.length > 0) text += ` (${f.errors.map(render).join('; ')})`;
  if (f.cause) text += `; cause: ${render(f.cause)}`;
  return text;
}

/**
 * A one-line, never-empty description of a thrown value, e.g.
 * `AggregateError [ECONNREFUSED] (Error [ECONNREFUSED]: connect ECONNREFUSED 104.18.24.46:443; ...)`.
 */
export function describeError(err: unknown): string {
  const fields = isErrorFields(err) ? err : errorFields(err);
  const text = render(fields);
  const informative = fields.message !== '' || fields.code !== null || fields.errors.length > 0 || fields.cause !== null;
  return informative ? text : `${text} (no message)`;
}

/** True for a value already shaped as {@link ErrorFields} (e.g. posted back by a worker). */
export function isErrorFields(value: unknown): value is ErrorFields {
  if (typeof value !== 'object' || value === null || value instanceof Error) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === 'string' && typeof v.message === 'string' && Array.isArray(v.errors) && 'code' in v && 'cause' in v;
}
