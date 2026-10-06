// WI-10005223: the admission worker body, UNBUNDLED form (`npx tsx bin/hono-host.ts` — :3070,
// bg-host, dev). A worker thread does NOT inherit the parent's tsx loader hooks, and the
// admission graph is not loadable by Node's native type stripping (extension-less relative
// imports, a TS parameter property), so this plain-JS entry registers tsx ON THE WORKER
// THREAD before importing the real job module. Measured 2026-10-02: from a plain-node and a
// tsx parent alike, `--import tsx` in Worker execArgv still fell through to strip-only mode,
// while an in-thread `register()` loaded the full graph (~0.6-0.75s, once per worker).
// Bundled hosts never use this file: they load the esbuilt admission-jobs.worker.mjs.
import { parentPort } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

if (!parentPort) throw new Error('admission-jobs.tsx-worker must run on a worker thread');
register();
const { serveAdmissionJobs } = await import('./admission-jobs.ts');
serveAdmissionJobs(parentPort);
