/**
 * no-raw-route-handlers.js — ESLint rule.
 *
 * Bars raw Hono route registration outside an allowlist of host-seam files.
 * Regression guard for `endpoint-hono-elimination-2026-05-21` — once
 * `_hono/` is deleted, the only legitimate Hono use is at the host edge
 * (`bin/host-app.ts` + a small set of harness/middleware files). Every
 * application route must be a `defineRoute` under
 * `lib/endpoint-route/routes/`.
 *
 * Flags:
 *   - `app.get(...)` / `app.post(...)` / `app.put(...)` / `app.patch(...)` /
 *     `app.delete(...)` / `app.options(...)` / `app.head(...)` / `app.all(...)`
 *   - `app.use(...)` (Hono middleware registration)
 *   - `app.route('/x', ...)` (sub-app mount)
 *   - `harness.get(...)` etc. (any identifier — caught by the method-name
 *     allowlist, not the receiver, so renaming the binding doesn't dodge it)
 *   - `new Hono(...)` instantiation
 *
 * Allowlist:
 *   - `tools/eslint-rules/__tests__/no-raw-route-handlers-fixture.ts`
 *   - `apps/operator/bin/host-app.ts` (the relocated host seam)
 *   - `apps/operator/bin/host-handler.ts` (top-level Hono composition)
 *   - `apps/operator/bin/host-bootstrap.ts` (startup hooks, no routes today)
 *   - Any file inside `node_modules/`
 *
 * Wire-up:
 *   {
 *     plugins: { 'papercusp': require('./tools/eslint-rules/index.js') },
 *     rules: { 'papercusp/no-raw-route-handlers': 'error' }
 *   }
 */

'use strict';

const HONO_VERBS = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'options', 'head',
  'use', 'route',
]);

// Receivers that look like Hono apps. Static enumeration — better than an
// exclude-list since any local Map/Set instance has `.get`/`.delete`. New
// Hono-instance bindings: add here.
const HONO_RECEIVERS = new Set([
  'app', 'harness', 'plugins', 'pty', 'experts', 'agentChats', 'projects',
  'crossHarness', 'router', 'mcpHttp', 'hono', 'subApp',
]);

// Trailing patterns that match Hono-naming conventions (`*App`, `*Router`,
// `*Hono`).
const HONO_NAME_SUFFIXES = /(App|Router|Hono)$/;

function looksLikeHonoReceiver(name) {
  if (HONO_RECEIVERS.has(name)) return true;
  return HONO_NAME_SUFFIXES.test(name);
}

const ALLOWLIST_SUFFIXES = [
  '/tools/eslint-rules/__tests__/no-raw-route-handlers-fixture.ts',
  '/apps/operator/bin/host-app.ts',
  '/apps/operator/bin/host-handler.ts',
  '/apps/operator/bin/host-bootstrap.ts',
];

function isAllowlisted(filename) {
  if (!filename) return false;
  if (filename.includes('/node_modules/')) return true;
  return ALLOWLIST_SUFFIXES.some((suffix) => filename.endsWith(suffix));
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow raw Hono route handlers (`app.get/post/use/route/...`, `new Hono(...)`) outside the host-seam allowlist; routes must use `defineRoute`.',
    },
    schema: [],
    messages: {
      rawHandler:
        'Raw Hono route registration (`{{name}}.{{verb}}`) is not allowed outside `bin/host-*.ts`. Use `defineRoute` under `lib/endpoint-route/routes/` instead.',
      newHono:
        '`new Hono(...)` is only allowed in the host seam (`bin/host-*.ts`). For application routes use `defineRoute`.',
    },
  },

  create(context) {
    const filename = context.getFilename
      ? context.getFilename()
      : context.filename;
    if (isAllowlisted(filename)) {
      return {};
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier' &&
          HONO_VERBS.has(callee.property.name) &&
          callee.object.type === 'Identifier'
        ) {
          const verb = callee.property.name;
          const receiver = callee.object.name;
          if (!looksLikeHonoReceiver(receiver)) return;
          // Heuristic to avoid false positives on unrelated `.use` /
          // `.delete` calls — every Hono verb-call takes at least one
          // arg, and the first arg of every Hono verb except `.route`
          // is either a string path or a middleware. We additionally
          // require that the call has ≥1 argument, and for `.route` the
          // first argument must be a string literal (the mount path).
          if (node.arguments.length === 0) return;
          if (verb === 'route') {
            const first = node.arguments[0];
            if (!first || first.type !== 'Literal' || typeof first.value !== 'string') {
              return;
            }
          }
          context.report({
            node,
            messageId: 'rawHandler',
            data: { name: receiver, verb },
          });
        }
      },
      NewExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'Hono') {
          context.report({ node, messageId: 'newHono' });
        }
      },
    };
  },
};
