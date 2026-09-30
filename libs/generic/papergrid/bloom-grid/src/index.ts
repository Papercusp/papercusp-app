export type {
  Versioned,
  ManifestEntry,
  BloomQueryRequest,
  BloomQueryResponse,
} from './protocol';
export { createRowStore } from './rowStore';
export type { RowStore, RowStoreOptions, RowStorePersistence } from './rowStore';
// Server helper re-exported here because shop-api's tsconfig uses
// `moduleResolution: node10` which does not honour `exports` subpaths.
// The bloom filter is pure JS — no client-bundle cost.
export { createBloomHandler } from './server';
export type { BloomHandlerAdapters } from './server';
// NOTE: `useBloomQuery` is NOT re-exported from the root. It lives in
// `./client` (marked 'use client') so Next.js server routes that import
// the root don't pull React hooks into the server bundle.
