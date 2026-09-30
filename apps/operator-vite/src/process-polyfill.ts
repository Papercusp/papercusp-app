// Node's `process` is a global in Node and was provided in the browser by
// Next.js's webpack build (DefinePlugin inlined `process.env.NEXT_PUBLIC_*` and
// the `process/browser` shim supplied a `process` object). The operator-vite
// SPA is bundled by Vite, which — exactly like with `Buffer` (see
// buffer-polyfill.ts) — does NOT polyfill Node globals. The operator still has
// many browser-side `process.env.*` reads (the IPC force-HTTP escape hatch in
// `apps/operator/lib/transport-adapters/configure.ts`, the Chatwoot URLs in
// OracleDock, the PTY ws in PiPanel, `NODE_ENV` in DevReloadGate, …), so in the
// Tauri WebKit renderer those throw "ReferenceError: process is not defined".
//
// Several run at MODULE-EVAL time — most importantly `RootSyncProvider`'s
// top-level `installDesktopIpcPolyfills()` → `isForceHttp()` → the configured
// `forceHttp` resolver reads `process.env.NEXT_PUBLIC_PAPERCUSP_FORCE_HTTP_TRANSPORT`.
// Because that runs while `__root.tsx`'s module graph evaluates, the throw
// blanks the WHOLE app, not just one feature.
//
// Restore the parity the app was written against: a minimal browser `process`.
// `env` keys default to undefined → each read falls back to its `?? '<default>'`
// (the intended production value); `NODE_ENV` is set from Vite's mode so
// `process.env.NODE_ENV === 'development'` checks (e.g. DevReloadGate) still
// work. A Vite-native rollback hatch would set a key here or read
// `import.meta.env` directly.
//
// MUST be imported before anything else in `main.tsx` (and therefore before
// `routeTree.gen` + every route/component module + their deps) so the global
// exists by the time any module body reads `process.env`.
interface MinimalProcess {
  env: Record<string, string | undefined>;
  browser: boolean;
  platform: string;
  version: string;
  versions: Record<string, string>;
  nextTick: (cb: (...args: unknown[]) => void, ...args: unknown[]) => void;
}

// Build against our own shape, then install through an `unknown` slot — the
// global `process` is typed as @types/node's strict `NodeJS.Process` (in scope
// via the operator deps), which our browser shim deliberately doesn't fully
// satisfy.
const shim: MinimalProcess = {
  env: { NODE_ENV: import.meta.env.MODE },
  browser: true,
  platform: '',
  version: '',
  versions: {},
  nextTick: (cb, ...args) => {
    queueMicrotask(() => cb(...args));
  },
};

const g = globalThis as unknown as { process?: { env?: Record<string, string | undefined> } };
if (typeof g.process === 'undefined') {
  (g as { process?: unknown }).process = shim;
} else if (typeof g.process.env === 'undefined') {
  g.process.env = shim.env;
}
