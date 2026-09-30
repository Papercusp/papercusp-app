// Ambient declarations for non-TS imports the bundler (vite) resolves but tsc
// does not know about. Without this, every `import './x.css'` side-effect import
// raises TS2882 — which it did across ~10 operator components (admin-ops.css,
// testing.css, adv-dock.css, xterm.css, the P-006 roster css, …). This file
// matches `**/*.ts` in tsconfig "include", so it's picked up automatically.
declare module '*.css';
declare module '*.scss';
