/**
 * Worker script for cpu-task-worker.ts — handles CPU-heavy synchronous work
 * off the operator main thread:
 *
 *   serialize  → JSON.stringify (with BigInt→Number replacer)
 *
 * Runs in a dedicated worker_threads thread so the main event loop is free
 * during the blocking compute. Protocol is intentionally minimal — one task
 * type, round-trip id for pending-map correlation.
 *
 * infra-perf-reliability-audit-round3-2026-06-19 P-011 / round4 P-002.
 * The gzip half was removed 2026-07-26: the operator is a loopback desktop
 * sidecar and no longer compresses any response, so there is nothing to
 * offload. Do not re-add it (scripts/check-no-wire-compression.mjs).
 *
 * Protocol (main → worker):
 *   { kind: 'serialize', id: number, value: unknown }
 *
 * Protocol (worker → main):
 *   { kind: 'ready' }
 *   { kind: 'serialize_ok', id: number, json: string }
 *   { kind: 'serialize_err', id: number, error: string }
 *
 * Plain ESM .mjs (no TypeScript transform) — same convention as
 * local-embedder-worker.script.mjs.
 */

import { parentPort } from 'node:worker_threads';

/**
 * BigInt-safe JSON.stringify replacer. Matches the replacer used in
 * rest-query-batch.ts so the worker output is byte-identical to what the
 * main thread produced before.
 */
function replaceBigInt(_k, v) {
  return typeof v === 'bigint' ? Number(v) : v;
}

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  const { kind, id } = msg;

  if (kind !== 'serialize') return;

  try {
    const json = JSON.stringify(msg.value, replaceBigInt);
    parentPort.postMessage({ kind: 'serialize_ok', id, json });
  } catch (err) {
    parentPort.postMessage({
      kind: 'serialize_err',
      id,
      error: err && err.message ? err.message : String(err),
    });
  }
});

// Signal ready immediately — no heavy init here; the worker is cheap to spawn.
parentPort.postMessage({ kind: 'ready' });
