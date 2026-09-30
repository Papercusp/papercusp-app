/**
 * no-bare-db-in-tx.js — ESLint rule.
 *
 * Inside a transaction callback (e.g. `db.transaction(async (tx) => { ... })`
 * or `withWorkspace(ws, async (tx) => { ... })`), bare-pool db handles
 * (`db.X(...)`, `getOrgPg().sql\`...\``, `getHarnessPg(slug).sql\`...\``)
 * must not be used. The transaction's `tx` parameter is the only correct
 * way to run queries inside the callback — a bare-pool checkout would
 * have no `app.workspace_id` GUC set and would silently bypass RLS.
 *
 * This rule flags:
 *   - Identifier references to `db`, `sql`, `orgPg`, `harnessPg` inside
 *     a callback whose first parameter is named `tx`.
 *   - Calls to `getOrgPg()` / `getHarnessPg(...)` inside such callbacks.
 *
 * Recommended targets: files in `@papercusp/papercusp-db/`, the operator's
 * Hono routes, and anywhere the workspace-context wrapper is used.
 *
 * Wire-up when ESLint config is added to the project:
 *   {
 *     plugins: { 'papercusp': require('./tools/eslint-rules/index.js') },
 *     rules: { 'papercusp/no-bare-db-in-tx': 'error' }
 *   }
 */

'use strict';

const FORBIDDEN_IDENTIFIERS = new Set(['db', 'sql', 'orgPg', 'harnessPg']);
const FORBIDDEN_CALLEES = new Set(['getOrgPg', 'getHarnessPg']);

function findEnclosingTxCallback(node) {
  let current = node.parent;
  while (current) {
    if (
      (current.type === 'ArrowFunctionExpression' || current.type === 'FunctionExpression') &&
      current.params.length > 0
    ) {
      const firstParam = current.params[0];
      if (firstParam.type === 'Identifier' && firstParam.name === 'tx') {
        return current;
      }
    }
    current = current.parent;
  }
  return null;
}

function isWithinAllowedReference(node) {
  // Allow obj.tx, etc. — only flag bare references.
  return node.parent && node.parent.type === 'MemberExpression' && node.parent.property === node;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow bare-pool db/sql references inside a transaction callback. ' +
        'Use the tx parameter to keep the workspace_id GUC.',
    },
    schema: [],
    messages: {
      bareDbInTx:
        'Bare-pool reference "{{name}}" inside a transaction callback would bypass the workspace_id GUC. Use `tx` instead.',
      bareCalleeInTx:
        'Calling "{{name}}" inside a transaction callback creates a bare-pool checkout that bypasses RLS. Use `tx` instead.',
    },
  },

  create(context) {
    return {
      Identifier(node) {
        if (!FORBIDDEN_IDENTIFIERS.has(node.name)) return;
        if (isWithinAllowedReference(node)) return;
        // Skip declarations / parameter names (only flag references).
        if (
          node.parent &&
          (node.parent.type === 'VariableDeclarator' ||
            node.parent.type === 'FunctionDeclaration' ||
            node.parent.type === 'ImportSpecifier' ||
            node.parent.type === 'ImportDefaultSpecifier')
        ) {
          return;
        }
        const tx = findEnclosingTxCallback(node);
        if (tx) {
          context.report({
            node,
            messageId: 'bareDbInTx',
            data: { name: node.name },
          });
        }
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier') return;
        if (!FORBIDDEN_CALLEES.has(node.callee.name)) return;
        const tx = findEnclosingTxCallback(node);
        if (tx) {
          context.report({
            node,
            messageId: 'bareCalleeInTx',
            data: { name: node.callee.name },
          });
        }
      },
    };
  },
};
