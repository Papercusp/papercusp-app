// @papercusp/token-kit — generic Style Dictionary tooling, shared across projects.
//
//   transforms  — tokenkit/name (kebab, drop color./shop. prefix),
//                 tokenkit/srgb (→ hex / rgba), tokenkit/oklch (→ oklch(L C H [/a]))
//   formats     — tokenkit/tailwind-theme (@theme block), tokenkit/grid-ts (typed `as const`)
//   preflight   — validate token sources (zero-token / tree-merge / $schema collisions)
//
// No brand values live here — projects supply their own *.tokens.json + SD config.
export { transforms } from './transforms.mjs';
export { formats } from './formats.mjs';
export { preflight } from './preflight.mjs';
