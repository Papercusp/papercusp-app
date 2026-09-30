/**
 * Parse + validate a caller's `projection` argument.
 *
 * FAIL-CLOSED, BEFORE DISPATCH. A malformed spec is rejected and the tool never
 * runs. That is deliberate and is the opposite of how the stage handles a spec
 * that is well-formed but does not fit the actual result (see apply.ts, which
 * fails OPEN with a note). The split follows what the caller can act on:
 *
 *   - A bad spec is the CALLER'S bug and is knowable without running anything.
 *     Running the tool first would burn the work, and — worse — a caller who
 *     asked for `head 20` and silently received 4,000 lines has been handed a
 *     token bill they did not agree to. Refuse it while refusing is still free.
 *
 *   - A good spec that does not fit the result (a `pick` on a non-JSON body) is
 *     only discoverable AFTER the tool ran. Failing the call there would throw
 *     away a valid result over a presentational miss, so that case passes the
 *     result through with the reason attached.
 *
 * @see ./types.ts for why the regex flavor is declared rather than assumed.
 */

import type { ProjectionSpec, ProjectionStage } from './types';

export interface ProjectionParseOk {
  ok: true;
  /** null when the caller passed no projection at all. */
  spec: ProjectionSpec | null;
}
export interface ProjectionParseErr {
  ok: false;
  error: string;
}
export type ProjectionParseResult = ProjectionParseOk | ProjectionParseErr;

/**
 * POSIX bracket expressions. In a JS RegExp `[[:digit:]]` is a character class
 * of `[`, `:`, `d`, `i`, `g`, `t` — it compiles, it matches, and every row it
 * returns is wrong. This is the one divergence that must be refused rather than
 * reported, because it is invisible in the output. Matches the class token
 * anywhere, so a compound `[[:digit:][:alpha:]]` is caught too.
 */
const POSIX_CLASS_RE = /\[:[a-z]+:\]/;

const KNOWN_OPS = new Set(['grep', 'head', 'tail', 'sort', 'uniq', 'cut', 'count']);

/** Max stages in one pipeline — a composition longer than this is a code:run, not a projection. */
export const MAX_PIPELINE_STAGES = 8;
/** Max `pick` paths in one spec; larger selections must be split across calls. */
export const MAX_PICK_PATHS = 32;

/** Compact shape hint reused by parse failures so the caller sees the `pick` ceiling. */
const PROJECTION_SPEC_HINT = `{ pick?: string[] (max ${MAX_PICK_PATHS} paths), pipe?: [{ op, ... }] }`;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A non-negative integer (line counts, field indexes). */
function intAtLeast(v: unknown, min: number, label: string): { ok: true; n: number } | { ok: false; error: string } {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
    return { ok: false, error: `${label} must be an integer (got ${JSON.stringify(v)})` };
  }
  if (v < min) return { ok: false, error: `${label} must be >= ${min} (got ${v})` };
  return { ok: true, n: v };
}

function parseStage(raw: unknown, i: number): { ok: true; stage: ProjectionStage } | { ok: false; error: string } {
  const at = `projection.pipe[${i}]`;
  if (!isPlainObject(raw)) return { ok: false, error: `${at} must be an object` };
  const op = raw.op;
  if (typeof op !== 'string' || !KNOWN_OPS.has(op)) {
    return {
      ok: false,
      error: `${at}.op must be one of ${[...KNOWN_OPS].join(', ')} (got ${JSON.stringify(op)})`,
    };
  }

  switch (op) {
    case 'grep': {
      if (typeof raw.pattern !== 'string' || raw.pattern.length === 0) {
        return { ok: false, error: `${at}.pattern must be a non-empty string` };
      }
      const fixed = raw.fixed === true;
      if (!fixed) {
        if (POSIX_CLASS_RE.test(raw.pattern)) {
          return {
            ok: false,
            error:
              `${at}.pattern uses a POSIX bracket expression (e.g. [[:digit:]]), which this stage ` +
              `CANNOT honor: patterns here are JavaScript RegExp, where [[:digit:]] is a character ` +
              `class of [ : d i g t — it would match, and every row would be wrong. Use the JS ` +
              `equivalent (\\d, \\w, \\s, [A-Za-z]) or pass fixed:true for a literal substring.`,
          };
        }
        try {
          new RegExp(raw.pattern);
        } catch (err) {
          return {
            ok: false,
            error: `${at}.pattern is not a valid JavaScript RegExp: ${
              err instanceof Error ? err.message : String(err)
            }. Use ignoreCase:true for case-insensitive matching, or fixed:true to match it as a literal substring.`,
          };
        }
      }
      const stage: ProjectionStage = { op: 'grep', pattern: raw.pattern };
      if (fixed) stage.fixed = true;
      if (raw.ignoreCase === true) stage.ignoreCase = true;
      if (raw.invert === true) stage.invert = true;
      for (const key of ['before', 'after', 'context'] as const) {
        if (raw[key] === undefined) continue;
        const r = intAtLeast(raw[key], 0, `${at}.${key}`);
        if (!r.ok) return r;
        stage[key] = r.n;
      }
      // grep -C sets both sides unless an explicit -A/-B overrides it.
      if (stage.context !== undefined) {
        if (stage.before === undefined) stage.before = stage.context;
        if (stage.after === undefined) stage.after = stage.context;
      }
      return { ok: true, stage };
    }
    case 'head':
    case 'tail': {
      const r = intAtLeast(raw.n, 0, `${at}.n`);
      if (!r.ok) return r;
      return { ok: true, stage: { op, n: r.n } };
    }
    case 'sort': {
      const stage: ProjectionStage = { op: 'sort' };
      if (raw.numeric === true) stage.numeric = true;
      if (raw.reverse === true) stage.reverse = true;
      if (raw.unique === true) stage.unique = true;
      return { ok: true, stage };
    }
    case 'uniq': {
      const stage: ProjectionStage = { op: 'uniq' };
      if (raw.count === true) stage.count = true;
      return { ok: true, stage };
    }
    case 'cut': {
      if (!Array.isArray(raw.fields) || raw.fields.length === 0) {
        return { ok: false, error: `${at}.fields must be a non-empty array of 1-indexed field numbers` };
      }
      const fields: number[] = [];
      for (const f of raw.fields) {
        const r = intAtLeast(f, 1, `${at}.fields[]`);
        if (!r.ok) return r;
        fields.push(r.n);
      }
      const stage: ProjectionStage = { op: 'cut', fields };
      if (raw.delimiter !== undefined) {
        if (typeof raw.delimiter !== 'string' || raw.delimiter.length === 0) {
          return { ok: false, error: `${at}.delimiter must be a non-empty string` };
        }
        stage.delimiter = raw.delimiter;
      }
      if (raw.onlyDelimited === true) stage.onlyDelimited = true;
      return { ok: true, stage };
    }
    case 'count':
      return { ok: true, stage: { op: 'count' } };
    default:
      /* c8 ignore next — KNOWN_OPS guard above makes this unreachable. */
      return { ok: false, error: `${at}.op unsupported: ${op}` };
  }
}

/**
 * Validate the caller's `projection` arg. Returns `{ ok:true, spec:null }` when
 * absent — the overwhelmingly common path, and deliberately not an error.
 */
export function parseProjection(rawInput: unknown): ProjectionParseResult {
  if (rawInput === undefined || rawInput === null) return { ok: true, spec: null };
  let raw: unknown = rawInput;

  // A JSON STRING is accepted and parsed here, and that is not leniency for its
  // own sake — without it the knob is UNREACHABLE from an entire class of client.
  //
  // `projection` is reserved at the DISPATCH layer, so it is deliberately absent
  // from every tool's advertised inputSchema (declaring it on ~550 tools is the
  // expensive form this design exists to avoid). But a client that types its
  // outgoing args FROM that schema has no type for an undeclared key, so it sends
  // the value as a STRING. Claude Code does exactly this — measured 2026-08-02,
  // both from a direct tool call and over raw HTTP: the object form applied
  // correctly while the identical spec sent as a string was refused with
  // "projection must be an object". The caller cannot fix that from their side;
  // the arg is undeclared precisely so it stays cheap.
  //
  // So the string is not a malformed spec — it is a well-formed spec that a
  // schema-driven client had no way to send as anything else. Refusing it means
  // the result-door footer advertises a remedy those callers can never take,
  // which is worse than silence: it teaches a knob and then rejects its use.
  // Parse it, then hold it to exactly the same validation as an object; a string
  // that is not JSON is still a real caller bug and still fails closed below.
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return { ok: true, spec: null };
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return {
        ok: false,
        error:
          'projection was sent as a string that is not valid JSON. Send the object ' +
          `${PROJECTION_SPEC_HINT}, or a JSON-encoded string of it.`,
      };
    }
  }

  if (!isPlainObject(raw)) {
    return { ok: false, error: `projection must be an object: ${PROJECTION_SPEC_HINT}` };
  }
  const spec: ProjectionSpec = {};

  if (raw.pick !== undefined) {
    if (!Array.isArray(raw.pick) || raw.pick.length === 0) {
      return { ok: false, error: 'projection.pick must be a non-empty array of field paths' };
    }
    if (raw.pick.length > MAX_PICK_PATHS) {
      return { ok: false, error: `projection.pick accepts at most ${MAX_PICK_PATHS} paths (got ${raw.pick.length})` };
    }
    const paths: string[] = [];
    for (const p of raw.pick) {
      if (typeof p !== 'string' || p.trim().length === 0) {
        return { ok: false, error: 'projection.pick entries must be non-empty strings, e.g. "results[].id"' };
      }
      paths.push(p.trim());
    }
    spec.pick = paths;
  }

  if (raw.pipe !== undefined) {
    if (!Array.isArray(raw.pipe) || raw.pipe.length === 0) {
      return { ok: false, error: 'projection.pipe must be a non-empty array of stages' };
    }
    if (raw.pipe.length > MAX_PIPELINE_STAGES) {
      return {
        ok: false,
        error:
          `projection.pipe accepts at most ${MAX_PIPELINE_STAGES} stages (got ${raw.pipe.length}). ` +
          `A longer composition is a code:run script, not a result projection.`,
      };
    }
    const stages: ProjectionStage[] = [];
    for (let i = 0; i < raw.pipe.length; i++) {
      const r = parseStage(raw.pipe[i], i);
      if (!r.ok) return r;
      stages.push(r.stage);
    }
    spec.pipe = stages;
  }

  if (!spec.pick && !spec.pipe) {
    return { ok: false, error: 'projection must specify at least one of `pick` or `pipe`' };
  }
  return { ok: true, spec };
}

/** Render a spec back as the shell pipeline it stands in for — the `command` echo D-041 requires. */
export function describeProjection(spec: ProjectionSpec): string {
  const parts: string[] = [];
  if (spec.pick) parts.push(`pick ${spec.pick.join(',')}`);
  for (const s of spec.pipe ?? []) {
    switch (s.op) {
      case 'grep': {
        const flags = [
          s.fixed ? '-F' : null,
          s.ignoreCase ? '-i' : null,
          s.invert ? '-v' : null,
          s.before !== undefined && s.before === s.after ? `-C${s.before}` : null,
          s.before !== undefined && s.before !== s.after ? `-B${s.before}` : null,
          s.after !== undefined && s.before !== s.after ? `-A${s.after}` : null,
        ].filter(Boolean);
        parts.push(`grep ${flags.length ? `${flags.join(' ')} ` : ''}${JSON.stringify(s.pattern)}`);
        break;
      }
      case 'head':
        parts.push(`head -${s.n}`);
        break;
      case 'tail':
        parts.push(`tail -${s.n}`);
        break;
      case 'sort':
        parts.push(
          `sort${s.numeric ? ' -n' : ''}${s.reverse ? ' -r' : ''}${s.unique ? ' -u' : ''}`,
        );
        break;
      case 'uniq':
        parts.push(`uniq${s.count ? ' -c' : ''}`);
        break;
      case 'cut':
        parts.push(
          `cut -f${s.fields.join(',')}${s.delimiter ? ` -d${JSON.stringify(s.delimiter)}` : ''}${
            s.onlyDelimited ? ' -s' : ''
          }`,
        );
        break;
      case 'count':
        parts.push('wc -l');
        break;
    }
  }
  return parts.join(' | ');
}
