// gremlins.js has no @types package. `gremlins-runtime.ts` imports it purely
// as an opaque default export (feature-detected: `.default ?? importedGremlins`,
// since its UMD/ESM interop shape varies by bundler) and never touches its
// internal API surface, so a bare ambient module declaration is sufficient —
// no need to hand-author a fuller .d.ts for an API this file doesn't call
// into directly. Keeps standalone `tsc --noEmit` clean (EI-262).
declare module 'gremlins.js';
