/**
 * no-bare-jsonb-cast.js — ESLint rule.
 *
 * In a postgres-js tagged template, binding a JSON string to a jsonb column as
 * a BARE `${expr}::jsonb` is client-dependent: it stores a real jsonb OBJECT
 * under the operator runtime client (`getOrgPg().sql`) but DOUBLE-ENCODES (a
 * jsonb *string*) under a fresh / testcontainer `postgres()` pool — so the same
 * code is correct in prod and wrong in tests (or vice-versa). The form that is
 * correct under BOTH is `${expr}::text::jsonb`: the explicit `::text` cast
 * forces a plain text param, parsed once server-side.
 *
 * This rule flags `${expr}::jsonb` and autofixes it to `${expr}::text::jsonb`.
 * It does NOT flag:
 *   - `${expr}::text::jsonb` (already correct),
 *   - `${sql.json(x)}::jsonb` / `${pg.json(x)}::jsonb` / `${pgJson(x)}::jsonb`
 *     (the postgres-js json-helper form — a different binding strategy; ::text
 *     would be wrong there),
 *   - `::jsonb[]` / `::jsonb_path` and other longer type names.
 *
 * Background: agent-insight postgres-js-jsonb-binding;
 * handoff-coordination-dx-followups-2026-06-04 §A2.
 *
 * Wire-up (eslint.config.mjs):
 *   { plugins: { papercusp: rules }, rules: { 'papercusp/no-bare-jsonb-cast': 'error' } }
 */

'use strict';

// `::jsonb` NOT already prefixed by `::text`, and NOT a longer type (jsonb[], jsonb_path…).
const BARE_JSONB_AT_START = /^::jsonb(?![A-Za-z0-9_[])/;

function unwrapExpression(expr) {
  let current = expr;
  while (
    current &&
    (current.type === 'ChainExpression' ||
      current.type === 'ParenthesizedExpression' ||
      current.type === 'TSAsExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'TSNonNullExpression')
  ) {
    current = current.expression;
  }
  return current;
}

function isNullish(expr) {
  const value = unwrapExpression(expr);
  return (
    (value?.type === 'Literal' && value.value === null) ||
    (value?.type === 'Identifier' && value.name === 'undefined')
  );
}

/** True for postgres-js JSON-helper VALUES — a direct `sql.json(x)` / `pgJson(...)`
 *  call or a conditional whose non-null branches are all helper values. The
 *  conditional case matters for nullable columns: `${ok ? sql.json(x) : null}::jsonb`
 *  is the same safe binding strategy and must not be autofixed to the invalid
 *  `sql.json(...)::text::jsonb` shape. */
function isJsonHelperValue(expr) {
  const value = unwrapExpression(expr);
  if (!value) return false;
  if (value.type === 'ConditionalExpression') {
    const branches = [value.consequent, value.alternate];
    return (
      branches.some((branch) => isJsonHelperValue(branch)) &&
      branches.every((branch) => isNullish(branch) || isJsonHelperValue(branch))
    );
  }
  if (value.type !== 'CallExpression') return false;
  const callee = unwrapExpression(value.callee);
  if (
    callee.type === 'MemberExpression' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'json'
  ) {
    return true;
  }
  if (callee.type === 'Identifier' && /json/i.test(callee.name)) return true;
  return false;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Bind jsonb columns as ${x}::text::jsonb, not a client-dependent bare ${x}::jsonb.',
    },
    fixable: 'code',
    schema: [],
    messages: {
      bare: 'Bare `${{{expr}}}::jsonb` is client-dependent (double-encodes under a fresh/testcontainer pool). Use `::text::jsonb` (correct under every client).',
    },
  },
  create(context) {
    const sourceCode = context.getSourceCode
      ? context.getSourceCode()
      : context.sourceCode;
    return {
      TemplateLiteral(node) {
        // quasis[k] (k>=1) is the static text right after expressions[k-1].
        for (let k = 1; k < node.quasis.length; k++) {
          const quasi = node.quasis[k];
          const raw = quasi.value.raw;
          if (!BARE_JSONB_AT_START.test(raw)) continue;
          const prevExpr = node.expressions[k - 1];
          if (isJsonHelperValue(prevExpr)) continue;
          const fullText = sourceCode.getText();
          const idx = fullText.indexOf('::jsonb', quasi.range[0]);
          if (idx === -1) continue;
          context.report({
            node: quasi,
            messageId: 'bare',
            data: { expr: sourceCode.getText(prevExpr) },
            fix(fixer) {
              return fixer.replaceTextRange(
                [idx, idx + '::jsonb'.length],
                '::text::jsonb',
              );
            },
          });
        }
      },
    };
  },
};
