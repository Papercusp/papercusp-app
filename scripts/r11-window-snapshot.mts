#!/usr/bin/env tsx
/** One-shot R-11 evidence capture. Example: npx tsx scripts/r11-window-snapshot.mts T0 /absolute/output.json */
import { createHash } from 'node:crypto';
import { openSync, closeSync, writeFileSync, linkSync, unlinkSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { getOrgPg } from '@papercusp/db-org';
import { resolveBackfillEmbedder } from '../packages/operator-core/lib/search/embed-backfill.ts';
import { buildR11TimerSpecs, captureR11Snapshot, evaluateR11Snapshots, scheduleR11Timers, type R11Snapshot, type R11Stage } from '../packages/operator-core/lib/search/r11-window-snapshot.ts';

const [stage, path, arg3, arg4, arg5] = process.argv.slice(2);
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const load = (file: string): R11Snapshot => {
  const bytes = readFileSync(file);
  return JSON.parse((file.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8')) as R11Snapshot;
};
let exitCode = 0;
try {
  if (stage === 'schedule') {
    if (!path || !arg3 || !arg4 || ![path, arg3, arg4].every((file) => file.startsWith('/')) ||
        !arg3.endsWith('.json.gz') || !arg4.endsWith('.json.gz') ||
        new Set([path, arg3, arg4]).size !== 3 || (arg5 && arg5 !== '--dry-run')) {
      throw new Error('Usage: schedule <absolute-T0.json.gz> <absolute-Tcut.json.gz> <absolute-T1.json.gz> [--dry-run]');
    }
    const t0 = load(path);
    const specs = buildR11TimerSpecs(t0);
    if (Date.parse(t0.capturedAt) > Date.now() + 60_000 ||
        Date.parse(t0.capturedAt) + (24 * 60 - 10) * 60_000 <= Date.now() + 60_000) {
      throw new Error('T0 is in the future or the Tcut deadline is too close to arm safely');
    }
    if (!existsSync(resolve(repoRoot, 'apps/operator/.env.local')) ||
        !existsSync(resolve(repoRoot, 'node_modules/.bin/tsx')) ||
        existsSync(arg3) || existsSync(arg4)) {
      throw new Error('Capture runtime is missing or a frozen output path already exists');
    }
    const script = fileURLToPath(import.meta.url);
    const tsx = resolve(repoRoot, 'node_modules/.bin/tsx');
    const timers = await scheduleR11Timers(specs, { t0: path, cut: arg3, t1: arg4 },
      { repoRoot, tsx, script }, arg5 === '--dry-run');
    const t0Bytes = readFileSync(path);
    process.stdout.write(`${JSON.stringify({ t0: { path, capturedAt: t0.capturedAt,
      bytes: t0Bytes.length, sha256: sha256(t0Bytes) }, timers, dryRun: arg5 === '--dry-run' })}\n`);
  } else if (stage === 'evaluate') {
    if (!path || !arg3 || !arg4) throw new Error('Usage: evaluate <T0.json.gz> <Tcut.json.gz> <T1.json.gz>');
    const t0 = load(path);
    const cut = load(arg3);
    const t1 = load(arg4);
    process.stdout.write(`${JSON.stringify(evaluateR11Snapshots(t0, cut, t1))}\n`);
  } else {
    if (!['preflight', 'T0', 'Tcut', 'T1'].includes(stage ?? '') || !path?.startsWith('/')) {
      throw new Error('Usage: <preflight|T0|Tcut|T1> <absolute-output.json>');
    }
    const resolved = await resolveBackfillEmbedder();
    if (!('profile' in resolved)) throw new Error(`Cannot capture R-11 with embedder ${resolved.mode}`);
    if (stage === 'Tcut' && !arg3) throw new Error('Tcut requires <T0.json.gz>');
    if (stage === 'T1' && (!arg3 || !arg4)) throw new Error('T1 requires <T0.json.gz> <Tcut.json.gz>');
    const prior = stage === 'Tcut' ? { t0: load(arg3!) } : stage === 'T1'
      ? { t0: load(arg3!), cut: load(arg4!) } : {};
    const snapshot = await captureR11Snapshot(getOrgPg().sql, stage as R11Stage, resolved, prior);
    const data = JSON.stringify(snapshot);
    const bytes = path.endsWith('.gz') ? gzipSync(data) : Buffer.from(data);
    // Hard-link publication is no-clobber: a duplicate timer fire cannot replace evidence.
    const temp = `${path}.tmp-${process.pid}`;
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
    try { linkSync(temp, path); } finally { unlinkSync(temp); }
    process.stdout.write(`${JSON.stringify({ stage, path, capturedAt: snapshot.capturedAt,
      targetCount: snapshot.targets.length, bytes: bytes.length, uncompressedBytes: Buffer.byteLength(data), sha256: sha256(bytes),
      staleByTarget: snapshot.targets.map((target) => ({ table: target.table,
        stale: target.rows.filter((row) => row.stale).length })) })}\n`);
  }
} catch (err) {
  process.stderr.write(`r11-window-snapshot: ${err instanceof Error ? err.message : String(err)}\n`);
  exitCode = 2;
} finally {
  await getOrgPg().sql.end({ timeout: 5 }).catch(() => {});
}
process.exitCode = exitCode;
