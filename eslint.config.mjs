/**
 * Root ESLint config.
 *
 * Wires the project's custom rules from tools/eslint-rules/. Most
 * notably enforces tx-only inside transaction callbacks for files in
 * @papercusp/agent-mcp/ and the substrate code paths that use
 * withWorkspace().
 *
 * Per-package configs may layer on top.
 */

import papercuspRules from './tools/eslint-rules/index.js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/build/**',
      '**/*.d.ts',
      '**/.turbo/**',
    ],
  },
  {
    // TypeScript syntax support — PARSER ONLY, no type-aware linting and no
    // recommended rule sets (the rule surface stays exactly the custom
    // papercusp rules below). Without this, espree choked on any TS-only
    // syntax (inline `type` imports, generics, interfaces…), so the guard
    // rules silently never ran on most TS/TSX files
    // (memory-taxonomy-and-debt-followups P-005).
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },
  {
    // The workspace still uses deliberate `react-hooks/exhaustive-deps`
    // suppressions in hooks whose dependency set is intentionally narrower
    // than the rule's inferred set. Register the plugin at the root so those
    // directives are valid under flat config (and keep the rule advisory,
    // matching the existing custom-only lint posture).
    files: ['**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: [
      'packages/agent-mcp/**/*.ts',
      'libs/papercusp/libs/db/src/**/*.ts',
      'apps/operator/app/api/agent-mcp/**/*.ts',
      'packages/operator-core/lib/operator-*.ts',
    ],
    plugins: {
      papercusp: papercuspRules,
    },
    rules: {
      'papercusp/no-bare-db-in-tx': 'error',
    },
  },
  {
    // EI-18808330244321407: projected handlers are transaction-free by
    // default. A first-party tool that reads ctx.tx must opt in explicitly;
    // runtime dispatch carries the same fail-loud contract for indirect misses.
    files: [
      'packages/agent-mcp/src/tools/**/*.ts',
      'packages/operator-core/lib/agent-tools/**/*.ts',
    ],
    ignores: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**'],
    plugins: {
      papercusp: papercuspRules,
    },
    rules: {
      'papercusp/no-undeclared-workspace-tx': 'error',
    },
  },
  {
    // Regression guard for `endpoint-hono-elimination-2026-05-21` —
    // every application route must use `defineRoute`. Raw Hono
    // (`app.get/post/use/route/...`, `new Hono()`) is restricted to
    // `bin/host-*.ts` (the host seam). See
    // `tools/eslint-rules/no-raw-route-handlers.js`.
    files: [
      'apps/operator/**/*.ts',
      'apps/operator/**/*.tsx',
      'packages/agent-mcp/**/*.ts',
    ],
    plugins: {
      papercusp: papercuspRules,
    },
    rules: {
      'papercusp/no-raw-route-handlers': 'error',
    },
  },
  {
    // A bare `${x}::jsonb` is client-dependent — it double-encodes (stores a
    // jsonb *string*) under a fresh/testcontainer postgres() pool while working
    // under getOrgPg, so the same code is right in prod + wrong in tests.
    // Enforce the universal `${x}::text::jsonb`. See
    // `tools/eslint-rules/no-bare-jsonb-cast.js` + agent-insight
    // postgres-js-jsonb-binding (handoff-coordination-dx-followups §A2).
    files: [
      'packages/operator-core/lib/**/*.ts',
      'packages/coordination/src/**/*.ts',
      'libs/papercusp/libs/db/src/**/*.ts',
    ],
    plugins: {
      papercusp: papercuspRules,
    },
    rules: {
      'papercusp/no-bare-jsonb-cast': 'error',
    },
  },
  {
    // WI-5977: a field read directly off JSON.parse(...) must not be
    // defaulted to a falsy value (`?? false` / `|| 0` / `|| ''`) — it
    // collapses "the key was never sent" and "the key was sent as that
    // value" into one reading, the exact shape behind ~10 separate
    // incidents in one p2p-release session (udxRelayed-absent-read-as-false,
    // bytesReceived-absent-read-as-0, …). `warn`, not `error`, for this
    // first landing — conservative rollout (see the rule file's own risk
    // note) until the false-positive rate on the real tree is measured; a
    // codebase-wide `error` here could redden the shared lint gate for the
    // whole fleet on a pattern not yet proven low-noise. See
    // `tools/eslint-rules/no-parse-boundary-falsy-default.js`.
    files: ['packages/**/*.ts', 'apps/**/*.ts', 'libs/**/*.ts'],
    plugins: {
      papercusp: papercuspRules,
    },
    rules: {
      'papercusp/no-parse-boundary-falsy-default': 'warn',
    },
  },
  {
    // EI-18817814737628830: a same-named inner `const`/`let` re-declaration silently
    // SHADOWS an outer validated binding — tsc passes (shadowing is legal TS), tests pass
    // (nothing exercised the case the outer binding guarded against), and `git blame` is
    // useless on this tree (git-sync squashes the fleet under one identity), so nothing
    // catches it. Confirmed live: a peer's inner `const marker = inp.marker` shadowed the
    // guarded outer `const marker = inp.marker?.trim() ? inp.marker : null` in
    // git-pipeline-position.ts, silently disabling the whitespace-marker screen in the
    // module whose one design constraint is "an ABSENCE must never read as a POSITIVE" —
    // a caller-supplied all-whitespace marker would have substring-matched every line of
    // indentation and returned a confident WRONG "your change is present" verdict.
    // `@typescript-eslint/no-shadow` (not the base `no-shadow` — it understands TS-only
    // declarations like enums/overloads and doesn't false-positive on them) is the
    // reuse-first catch for this class. `warn`, not `error`, for this first landing —
    // same conservative rollout as `no-parse-boundary-falsy-default` above: 133 existing
    // warnings across 70/4147 files in packages/operator-core/lib on the real tree
    // (measured 2026-07-27), not yet worth reddening the shared lint gate over. Scoped to
    // operator-core/lib (where the instance was found) rather than repo-wide, to keep the
    // first rollout's blast radius small; widen once the false-positive rate is confirmed
    // low. See `tools/eslint-rules/README.md` if one is added for the rationale link.
    files: ['packages/operator-core/lib/**/*.ts'],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      'no-shadow': 'off', // superseded by the TS-aware version below
      '@typescript-eslint/no-shadow': 'warn',
    },
  },
];
