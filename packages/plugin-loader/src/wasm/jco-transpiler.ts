/**
 * G2b — production wiring of the Transpiler abstraction in transpile.ts
 * to @bytecodealliance/jco's transpile API.
 *
 * Single seam: if jco is renamed/replaced/version-bumped, this is the
 * only file that touches the dep. Everything else in plugin-loader
 * consumes the Transpiler type.
 *
 * @bytecodealliance/jco is a peerDep — the loader works without it
 * for tests (using the injected Transpiler shape from transpile.ts);
 * production callers install it and wire `realJcoTranspiler` into
 * `transpileWasm({ ..., transpiler })`.
 *
 * Why peerDep, not regular dep: jco bundles wasm-tools + binaryen +
 * weighs ~50MB; we don't force that on every consumer. Callers that
 * use the WASM runtime install jco; callers that ship JS-only plugins
 * skip it.
 *
 * To install:
 *   pnpm add @bytecodealliance/jco
 *
 * Note: jco's API exports `transpile(componentBytes, opts)` which
 * returns `{ files: Record<string, Uint8Array> }`. The "entrypoint"
 * is the file ending in `.js` that re-exports the world bindings.
 * v0.1.0 plugins always export `lifecycle` + `actions`, so the
 * generated entrypoint is predictable per jco's naming convention.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Transpiler } from './transpile';

/**
 * Real jco transpiler. Lazy-imports `@bytecodealliance/jco` so this
 * module is loadable even when jco isn't installed (transpile-time
 * error surfaces only when production wiring actually invokes it).
 *
 * Output layout in the cache dir (per jco's defaults):
 *   transpiled.js                 — ESM entry re-exporting bindings
 *   transpiled.core.wasm          — extracted core wasm module
 *   interfaces/<wit-name>.d.ts    — typed bindings (optional)
 */
export const realJcoTranspiler: Transpiler = async (wasmBytes, outputDir) => {
  // Dynamic import so the loader package doesn't crash if jco isn't
  // installed (happens in JS-only-plugin deployments). Keep the specifier in
  // a variable: Vite resolves literal dynamic imports during the browser
  // bundle even with @vite-ignore, defeating this optional-dependency seam.
  const jcoSpecifier: string = '@bytecodealliance/jco';
  // Typed `unknown`, NOT `typeof import('@bytecodealliance/jco')`: a type-level
  // import resolves the module at COMPILE time, which defeats the very
  // optional-peerDep seam this file exists to provide (tsc fails with TS2307
  // wherever jco isn't installed — the normal case, per the header). Nothing is
  // lost: the annotation was already discarded on the next statement, which
  // re-casts to Record<string, unknown> and validates the API shape at runtime.
  let jco: unknown;
  try {
    jco = await import(
      /* @vite-ignore */ /* turbopackIgnore: true */ /* webpackIgnore: true */ jcoSpecifier
    );
  } catch (e) {
    throw new Error(
      `@bytecodealliance/jco is not installed. WASM plugin support requires it; install via \`pnpm add @bytecodealliance/jco\`. Underlying: ${(e as Error).message}`,
    );
  }

  // jco's transpile signature varies slightly across versions. v1.x
  // exports `transpile(componentBytes, opts)` returning
  // { files: Record<string, Uint8Array> }. Wrap defensively.
  const transpileFn = (jco as Record<string, unknown>).transpile as
    | ((bytes: Uint8Array, opts?: Record<string, unknown>) => Promise<{ files: Record<string, Uint8Array> }>)
    | undefined;
  if (typeof transpileFn !== 'function') {
    throw new Error(
      `@bytecodealliance/jco's API shape unexpected: no \`transpile\` export. ` +
        `If jco was upgraded past v1.x, this wrapper needs updating.`,
    );
  }

  const result = await transpileFn(wasmBytes, {
    name: 'transpiled',
    instantiation: 'async',
  });

  // Write all files jco produced. The entry filename ends with `.js`
  // and matches the `name` we passed in.
  for (const [filename, bytes] of Object.entries(result.files)) {
    const target = join(outputDir, filename);
    // Ensure subdirs exist (interfaces/ in particular).
    const dir = target.substring(0, target.lastIndexOf('/'));
    if (dir && dir !== outputDir) {
      await fs.mkdir(dir, { recursive: true });
    }
    await fs.writeFile(target, bytes);
  }

  // jco's entry is `<name>.js`; we passed name=transpiled so it's
  // transpiled.js. Confirm presence; if jco changes its convention,
  // the post-write scan will throw with the actual filename for
  // diagnosis.
  const expectedEntry = 'transpiled.js';
  if (!Object.keys(result.files).includes(expectedEntry)) {
    const actual = Object.keys(result.files).filter((k) => k.endsWith('.js'));
    throw new Error(
      `jco produced files but no \`${expectedEntry}\` entry. JS files found: ${actual.join(', ') || '(none)'}`,
    );
  }

  return { entryRelPath: expectedEntry };
};
