// Empty shim so `import 'server-only'` resolves under vitest.
// The real `server-only` package is a Next.js compile-time-only sentinel
// that throws if loaded from a client chunk — see
// node_modules/next/dist/compiled/server-only/. This shim has no
// runtime; it just unblocks unit tests that load modules guarded by
// `import 'server-only'`.
export {};
