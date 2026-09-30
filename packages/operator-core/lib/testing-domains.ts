/**
 * Re-export shim. The testing-domains registry moved to the shared
 * @papercusp/testing-shell package as Phase A (P-001) of
 * harness-tests-tab-and-tester-promotion-2026-05-26, so the harness
 * Tests tab can consume the same shell as /admin/testing.
 *
 * This shim keeps every existing `@/lib/testing-domains` import site
 * working unchanged (testing-domains-registry.ts, the four admin
 * endpoint routes, and the two test files). New code should import from
 * `@papercusp/testing-shell` directly.
 *
 * DomainTestPanel is intentionally NOT re-exported here: it is a React
 * component with a CSS side-effect import that crashes the Hono/tsx server
 * when pulled in server-side. Import it directly from
 * `@papercusp/testing-shell` in browser-only (Vite-bundled) code.
 */
export * from '@papercusp/testing-shell/registry';
export * from '@papercusp/testing-shell/data-source';
