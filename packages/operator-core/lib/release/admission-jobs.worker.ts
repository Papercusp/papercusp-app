/**
 * WI-10005223: the admission worker body, BUNDLED form.
 *
 * `bundle-host-common.sh` esbuilds this entry to `admission-jobs.worker.mjs` beside the
 * bundled host (`node dist-host/hono-host.mjs` — :3170, packaged desktop, current-build rig),
 * which is where admission-offthread.ts looks first. The admission graph is NOT loadable by
 * Node's native type stripping (extension-less relative imports, a TS parameter property), so
 * an UNBUNDLED host uses the sibling `admission-jobs.tsx-worker.mjs` bootstrap instead.
 */
import { parentPort } from 'node:worker_threads';
import { serveAdmissionJobs } from './admission-jobs.ts';

if (!parentPort) throw new Error('admission-jobs.worker must run on a worker thread');
serveAdmissionJobs(parentPort);
