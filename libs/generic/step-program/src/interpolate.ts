/**
 * `interpolate` — `{{ path }}` template substitution over a step-program scope.
 *
 * A step's `args` (and a gate branch's `args`) are authored with `{{ path }}`
 * references into the bound scope — `{{ payload.question }}`,
 * `{{ thread.conversation_id }}`, `{{ tally.winner }}`. The runner interpolates
 * the args against the current scope before invoking the op.
 *
 * **Type-preserving:** when a string value is *exactly* one `{{ path }}` (after
 * trim), the raw scope value is returned with its type intact — so
 * `quorum: "{{ payload.quorum }}"` binds the *number* 3, and
 * `options: "{{ payload.options }}"` binds the *array*, not its `String()`-ified
 * form. A string with surrounding text or multiple placeholders is string-
 * substituted (`"Vote split on: {{ payload.question }}"`). Recurses through
 * arrays + plain objects so nested args interpolate.
 *
 * Pure (uses the same `readPath` as the evaluator so path semantics match
 * exactly). A missing path → `undefined` for a whole-string placeholder, or the
 * empty string in a mixed-string substitution (never throws).
 */
import { readPath, type Scope } from './expr.js';

/** `{{ a.b[0].c }}` → path segments; bare-name → single segment. */
function pathSegments(raw: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const part of raw.trim().split('.')) {
    if (!part) continue;
    for (const g of part.matchAll(/([^[\]]+)|\[(\d+)\]/g)) {
      if (g[1] != null) out.push(g[1]);
      else if (g[2] != null) out.push(Number(g[2]));
    }
  }
  return out;
}

const WHOLE_PLACEHOLDER = /^\{\{\s*([^{}]+?)\s*\}\}$/;
const ANY_PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

function interpolateString(str: string, scope: Scope): unknown {
  // Exactly one placeholder, no surrounding text → return the raw scope value
  // (type preserved: number/array/object stay themselves).
  const whole = str.match(WHOLE_PLACEHOLDER);
  if (whole) {
    return readPath(scope, pathSegments(whole[1]!));
  }
  // Mixed string → stringify each placeholder's value inline.
  if (!str.includes('{{')) return str;
  return str.replace(ANY_PLACEHOLDER, (_m, expr: string) => {
    const v = readPath(scope, pathSegments(expr));
    if (v == null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  });
}

/**
 * Recursively interpolate any value: strings get `{{ path }}` substitution
 * (type-preserving for a whole-string placeholder), arrays + plain objects
 * recurse, everything else passes through. Returns a NEW structure (never
 * mutates the input).
 */
export function interpolate(value: unknown, scope: Scope): unknown {
  if (typeof value === 'string') return interpolateString(value, scope);
  if (Array.isArray(value)) return value.map((v) => interpolate(v, scope));
  if (value != null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolate(v, scope);
    }
    return out;
  }
  return value;
}

/** Interpolate an args object and assert the object shape (the common case). */
export function interpolateArgs(
  args: Record<string, unknown>,
  scope: Scope,
): Record<string, unknown> {
  return interpolate(args, scope) as Record<string, unknown>;
}
