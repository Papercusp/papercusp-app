// Node's `Buffer` is a global in Node and in Next.js's webpack browser
// bundle (webpack auto-provides it). The operator-vite SPA is bundled by
// Vite, which does NOT polyfill Node globals — so any bundled dependency
// that touches `Buffer` at eval or call time throws
// "ReferenceError: Can't find variable: Buffer" in the Tauri WebKit
// renderer. This restores parity with the retired `next dev` content
// layer by exposing the `buffer` package's implementation as the global.
//
// MUST be imported before anything else in `main.tsx` (and therefore
// before `routeTree.gen` and every route module + their deps) so the
// global exists by the time dependency module bodies evaluate.
import { Buffer as BufferPolyfill } from 'buffer';

if (typeof (globalThis as { Buffer?: unknown }).Buffer === 'undefined') {
  (globalThis as { Buffer?: unknown }).Buffer = BufferPolyfill;
}
