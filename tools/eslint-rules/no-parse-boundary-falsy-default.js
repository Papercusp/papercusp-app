/**
 * no-parse-boundary-falsy-default.js — ESLint rule.
 *
 * WI-5977: one night, ~10 separate incidents, ONE shape — a boundary that
 * cannot tell "absent" from "measured falsy" collapses both into the same
 * value, and the collapse looks exactly like a real measurement:
 *   - `udxRelayed` ABSENT from a log line, read as `relayed:false`
 *   - `bytesReceived` ABSENT, read as `0`
 *   - a job runner's wrapper exit code (0) read as "the real command passed"
 * `dataPathProven`/`readWireStats` (this same repo, swarm.ts) is the fix
 * shape that already works: an explicit tri-state (`true | false | null`)
 * instead of collapsing "unknown" into `false`.
 *
 * This rule catches the narrowest, highest-confidence instance of the
 * pattern: defaulting a field read directly off a `JSON.parse(...)` result
 * to a FALSY value that is ALSO a legitimate measurement (`false`, `0`, or
 * `''`) via `??` or `||`. A parsed payload's field being MISSING (the key
 * was never sent) and a parsed payload's field being PRESENT-AND-FALSY (the
 * key was sent with a falsy value) are different facts; `?? false` / `|| 0`
 * silently reports the same value for both, so a consumer can never again
 * tell "the sender said false" from "the sender said nothing".
 *
 * Deliberately NOT flagged (kept narrow to avoid false-positive noise on a
 * large codebase — see WI-5977's own checkpoint on this risk):
 *   - defaulting to `null`/`undefined` (that IS the explicit-absence idiom),
 *   - any object/array/non-JSON.parse source (too broad a net without also
 *     tracking which fields are genuinely tri-state vs. plain-optional),
 *   - a `typeof x === 'undefined'` / `'field' in x` explicit presence check
 *     followed by a default (already explicit — this rule only catches the
 *     *implicit*, single-expression collapse).
 *
 * Wire-up (eslint.config.mjs):
 *   { plugins: { papercusp: rules },
 *     rules: { 'papercusp/no-parse-boundary-falsy-default': 'warn' } }
 * (starts at `warn`, not `error`, until false-positive rate on the real tree
 * is measured.)
 */

'use strict';

const FALSY_LITERAL_VALUES = new Set([false, 0, '']);

/** True for `JSON.parse(...)` — the exact call form, not a wrapper. Widening
 * this to "any function named parse/deserialize" was considered and
 * rejected for v1: it would need a way to know the wrapper's OWN
 * absence-handling, and guessing from the name alone is exactly the kind of
 * unverified inference this rule exists to discourage. */
function isJsonParseCall(node) {
  return (
    node &&
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'JSON' &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === 'parse'
  );
}

/** Walk a MemberExpression chain (`x.a.b.c`, optionally `?.`) down to its
 * root object, so `JSON.parse(s).a.b ?? false` is caught, not just the
 * single-property `JSON.parse(s).a ?? false`. */
function rootObjectOf(node) {
  let cur = node;
  while (
    cur &&
    (cur.type === 'MemberExpression' || cur.type === 'ChainExpression')
  ) {
    if (cur.type === 'ChainExpression') {
      cur = cur.expression;
      continue;
    }
    cur = cur.object;
  }
  return cur;
}

function isFalsyLiteral(node) {
  if (!node) return false;
  if (node.type === 'Literal') return FALSY_LITERAL_VALUES.has(node.value);
  // Cover the unary forms too: `-0`.
  if (
    node.type === 'UnaryExpression' &&
    node.operator === '-' &&
    node.argument.type === 'Literal'
  ) {
    return FALSY_LITERAL_VALUES.has(-node.argument.value);
  }
  return false;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'A field read off JSON.parse(...) must not be defaulted to a falsy value via ??/|| — it collapses "absent" and "measured falsy" into the same reading (WI-5977).',
    },
    schema: [],
    messages: {
      collapsed:
        'Defaulting a JSON.parse(...) field to {{value}} via `{{operator}}` collapses "the key was never sent" and "the key was sent as {{value}}" into the same value — the exact defect class behind ~10 incidents in one session (WI-5977: udxRelayed-absent-read-as-false, bytesReceived-absent-read-as-0, …). Use an explicit presence check (`"field" in parsed`, `parsed.field !== undefined`) or a tri-state read (see readWireStats/dataPathProven in packages/operator-core/lib/sync/hyperbee/swarm.ts) instead of collapsing them here.',
    },
  },
  create(context) {
    return {
      LogicalExpression(node) {
        if (node.operator !== '??' && node.operator !== '||') return;
        if (!isFalsyLiteral(node.right)) return;
        const left =
          node.left.type === 'ChainExpression'
            ? node.left.expression
            : node.left;
        if (left.type !== 'MemberExpression') return;
        if (!isJsonParseCall(rootObjectOf(left))) return;
        context.report({
          node,
          messageId: 'collapsed',
          data: {
            value: JSON.stringify(
              node.right.type === 'Literal' ? node.right.value : 0,
            ),
            operator: node.operator,
          },
        });
      },
    };
  },
};
