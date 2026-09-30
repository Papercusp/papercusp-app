// Loaded via `node --require ./sidecar-preload.js` before the operator's
// server.js. Strips Node's experimental Web Storage API so that any module
// using the truthy-then-call pattern
//   if (globalThis.localStorage) globalThis.localStorage.getItem(...)
// short-circuits instead of crashing.
//
// Node 22+ enables a partial localStorage stub by default; Node 20 doesn't
// have it; --no-experimental-webstorage is unrecognized on Node 20 and
// disallowed in NODE_OPTIONS on Node 22+, so neither flag works portably
// across Node versions. Doing the cleanup in JS sidesteps both problems.
//
// The operator's @rocicorp/zero client is the trip wire: its module-load
// path checks `if (localStorage)` and then calls `.getItem`, which throws
// `TypeError: b.getItem is not a function` on Node 22+'s stub. The
// resulting unhandledRejection takes out the catch-all module and every
// Hono-mounted /api/* endpoint 404s.

try {
  if (typeof globalThis.localStorage !== 'undefined') {
    delete globalThis.localStorage;
  }
} catch {
  /* property may be non-configurable on some Node versions; ignore */
}
try {
  if (typeof globalThis.sessionStorage !== 'undefined') {
    delete globalThis.sessionStorage;
  }
} catch {}
