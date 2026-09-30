/**
 * Type shim for @jitsi/rnnoise-wasm — the WASM RNNoise suppressor used by the
 * voice-node noise gate (voice-node/rnnoise-suppressor.ts). Upstream ships no
 * .d.ts for the /dist entrypoints, so the import is implicit-`any` (TS7016).
 * Declared here (surface left `any` — the consumer wraps it behind a typed
 * façade and needs no strict types on the raw module) to keep the operator-core
 * typecheck clean.
 */
declare module '@jitsi/rnnoise-wasm/dist/rnnoise-sync.js';
