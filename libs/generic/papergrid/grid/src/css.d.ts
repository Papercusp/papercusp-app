/**
 * Ambient declarations for side-effect stylesheet imports (EI-19409888189789017).
 *
 * This package is a thin compat re-export of `@papercusp/grid-core`, which
 * resolves to grid-core's SOURCE — so this program compiles grid-core's
 * `DataGridShell.tsx`, including its `import '@glideapps/glide-data-grid/dist/index.css'`.
 * A `.css` file has no type declarations, so under `moduleResolution: "bundler"`
 * that surfaces as TS2882 here even though this package imports no stylesheet
 * of its own.
 *
 * grid-core carries the identical declaration, but an ambient `.d.ts` only
 * enters a program if that program INCLUDES it, and nothing imports this file
 * — `tsconfig.json`'s `include` is what pulls it in, and each package's
 * `include` covers only its own `src/**`. Measured 2026-08-03: adding the
 * declaration to grid-core alone left this package still red on exactly this
 * error. Hence the duplicate; deleting it re-reds the gate.
 */
declare module '*.css';
declare module '*.scss';
