/**
 * Browser shim for `node:module` (desktop-load crash fix, 2026-06-22).
 *
 * Unlike path/url/fs/buffer/process, `node:module` has NO browser polyfill, so Vite
 * externalizes it to an empty module → `createRequire` is `undefined`. Several
 * operator-core backend modules reachable through the generated route tree create a
 * `const require = createRequire(import.meta.url)` at MODULE SCOPE; with `createRequire`
 * undefined that threw at module-eval ("createRequire is not a function") and blanked
 * the ENTIRE desktop app on load.
 *
 * This shim makes `createRequire` EXIST in the browser so importing those modules is
 * safe. The `require` it returns throws ONLY if actually CALLED — and those node-builtin
 * reads only ever run server-side (DB connect, plugin discovery/hot-reload), never in
 * the SPA, so the throw is never reached. `require.cache`/`require.resolve` are stubbed
 * (empty/throwing) so the rare hot-reload paths that touch them don't crash either.
 */

type RequireLike = ((id: string) => never) & {
  cache: Record<string, unknown>;
  resolve: (id: string) => never;
  main: undefined;
  extensions: Record<string, unknown>;
};

export function createRequire(_from?: string | URL): RequireLike {
  const fail = (): never => {
    throw new Error('[node:module shim] require() is unavailable in the browser bundle');
  };
  const req = ((_id: string): never => fail()) as RequireLike;
  // Read in plugin hot-reload paths that never run in the SPA; an empty object keeps
  // `Object.keys(require.cache)` / `delete require.cache[k]` from throwing.
  req.cache = Object.create(null);
  req.resolve = (_id: string): never => fail();
  req.main = undefined;
  req.extensions = Object.create(null);
  return req;
}

// The mutation-probe gate uses this only on the server. Keep its import
// linkable in the SPA while failing loudly if that server path runs there.
export function isBuiltin(_id: string): never {
  throw new Error('[node:module shim] isBuiltin() is unavailable in the browser bundle');
}

// Some consumers `import module from 'node:module'` and reach `.createRequire`.
export default { createRequire, isBuiltin };
