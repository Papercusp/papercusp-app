// WI-10002855 — source-tree entry for the snapshot-fold worker (tsx and vitest runtimes).
//
// A worker thread does not inherit a TypeScript loader it can use: measured on Node 25,
// both a plain `new Worker('snapshot-fold.worker.ts')` and one with
// `execArgv: ['--import', 'tsx']` fail on the worker's first extensionless import
// ("Cannot find module …/snapshot-fold-protocol"). tsx's scoped `tsImport` API loads the
// .ts worker with its own resolver, which works inside the thread.
//
// Bundled runtimes never use this file: they load `snapshot-fold.worker.mjs`, esbuilt
// beside the entry by bundle-host.sh / build-desktop-sidecar.sh.
import { tsImport } from 'tsx/esm/api';

await tsImport('./snapshot-fold.worker.ts', import.meta.url);
