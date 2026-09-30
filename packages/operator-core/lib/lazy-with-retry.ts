// Single source of truth lives in @papercusp/sync. The desktop chunk-reload
// guard (don't auto-reload the Tauri webview / :3070 / :4173 on a chunk-hash
// miss) must be identical for the sync provider — which lazy-loads app-wide —
// and the operator, so they share ONE implementation here rather than two
// copies that drift. (They drifted once: the sync copy lacked the guard and
// auto-reloaded the desktop on every `vite build --watch` rebuild.)
export {
  lazyWithRetry,
  shouldAutoReloadChunkFailure,
  isChunkLoadError,
  CHUNK_LOAD_ERROR_RE,
} from '@papercusp/sync';
