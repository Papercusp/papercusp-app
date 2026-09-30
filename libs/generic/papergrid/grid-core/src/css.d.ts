/**
 * Ambient declarations for side-effect stylesheet imports (EI-19409888189789017).
 *
 * `DataGridShell.tsx` does `import '@glideapps/glide-data-grid/dist/index.css'`
 * — a SIDE-EFFECT import, which the bundler resolves and TypeScript cannot,
 * because a `.css` file has no type declarations. Under
 * `moduleResolution: "bundler"` that surfaces as TS2882 and was one of the two
 * things keeping this package off the automatic `lint:tsc:workspaces` gate.
 *
 * Declaring the module (rather than suppressing the line) is the right fix: it
 * is true of EVERY stylesheet import in this package, present and future, so a
 * second one will not re-red the gate. It also stays honest — the module is
 * declared with no exported members, so `import styles from './x.css'` is still
 * a type error. Only the side-effect form this package actually uses compiles.
 *
 * NOTE: `@papercusp/grid` re-exports this package's SOURCE, so its program
 * compiles `DataGridShell.tsx` too and needs the same ambient declaration. An
 * unimported `.d.ts` is not reachable across that boundary, so `grid` carries
 * its own copy — see `libs/generic/papergrid/grid/src/css.d.ts`.
 */
declare module '*.css';
declare module '*.scss';
