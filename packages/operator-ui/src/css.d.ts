/**
 * Side-effect stylesheet imports (`import '…/x.css'`) inside this package and
 * the file:-linked sources it compiles (grid-core's DataGridShell imports the
 * Glide stylesheet). tsc resolves them as modules and needs a declaration, or
 * the FIRST dependency that ships CSS turns the whole package red (TS2882) —
 * which is what grid-theme-bridge.ts pulling in @papercusp/grid-core did.
 */
declare module '*.css';
