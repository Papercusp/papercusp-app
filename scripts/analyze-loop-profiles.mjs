#!/usr/bin/env node
// Attribute event-loop saturation to its hot frames from the V8 cpuprofiles the
// lag monitor drops in ~/.papercusp/loop-profiles/ (loop-saturation-*.cpuprofile).
//
// Companion to the agent-insight "attributing-loop-saturation-via-cpuprofiles":
// it aggregates SELF-TIME per call frame across every capture, SUBTRACTS the
// profiler's own observer-effect (node:inspector — can be ~44% of samples and
// will skew every number ~2x if left in), and buckets the real workload so you
// fix the actual culprit instead of the assumed one.
//
// Usage:
//   node scripts/analyze-loop-profiles.mjs [dir] [--top N] [--json]
//
// Defaults:
//   dir      ~/.papercusp/loop-profiles
//   --top    25     how many hot frames to print
//   --json   emit machine-readable JSON instead of the table

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { classifyCpuFrame } from './lib/cpu-profile.mjs';

const args = process.argv.slice(2);
const topIdx = args.indexOf('--top');
const TOP = topIdx >= 0 && args[topIdx + 1] ? Number(args[topIdx + 1]) : 25;
const asJson = args.includes('--json');
// Positional = non-flag args, skipping the value that follows --top.
const skip = topIdx >= 0 ? topIdx + 1 : -1;
const positional = args.filter((a, i) => !a.startsWith('--') && i !== skip);
const dir = positional[0] ?? join(homedir(), '.papercusp', 'loop-profiles');

/** Trim a V8 callFrame url to something readable + repo-relative. */
function shortUrl(u) {
  if (!u) return '(native)';
  u = u.replace(/^file:\/\//, '');
  for (const m of ['/papercup/', '/papercup-release/']) {
    const i = u.indexOf(m);
    if (i >= 0) return u.slice(i + 1);
  }
  if (u.includes('/node_modules/')) return 'node_modules/' + u.split('/node_modules/').pop();
  return u;
}

/** Classify a frame into a cost bucket (extend as new culprits show up). */
function bucketOf(fn, url) {
  const k = `${fn} ${url}`;
  if (/\bspawn\b|child_process/.test(k)) return 'git/child_process spawn';
  if (/garbage collector/.test(k)) return 'GC (alloc churn)';
  if (/postgres/.test(url) && (fn === 'parse' || fn === 'DataRow')) return 'postgres result-set parse';
  if (/@hono/.test(url) && /json/i.test(fn)) return '@hono JSON response serialize';
  if (/node:buffer|utf8|encoding/i.test(k)) return 'buffer/utf8/encode';
  if (fn === 'stat' || /recursive_watch|fs\/watch|node:path/.test(k) || fn === 'normalizeString') return 'fs stat/watch/path';
  if (/dev-deploy-state|git-pipeline/.test(url)) return 'dev-deploy-state (git glue)';
  if (/escalations\.ts|attention\.ts/.test(url)) return 'coord escalation/attention read-path';
  return 'other';
}

let files;
try {
  files = readdirSync(dir).filter((f) => f.endsWith('.cpuprofile')).map((f) => join(dir, f));
} catch (e) {
  console.error(`Cannot read profile dir ${dir}: ${e.message}`);
  process.exit(1);
}
if (files.length === 0) {
  console.error(`No *.cpuprofile in ${dir}`);
  process.exit(1);
}

const selfByFrame = new Map(); // frame -> ms
const selfByBucket = new Map();
const spawnByCaller = new Map(); // nearest APP-frame ancestor of a spawn/exec node -> ms
let realMs = 0;
let profilerMs = 0; // observer-effect (node:inspector)
let idleMs = 0;
let spawnMs = 0;

/** Is this frame in first-party app code (not node_modules / native / node:)? */
const isAppFrame = (u) => /operator-core\/lib|apps\/operator|packages\//.test(shortUrl(u));

for (const file of files) {
  let prof;
  try {
    prof = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    console.error(`  skip (unparseable): ${file}`);
    continue;
  }
  const nodes = new Map(prof.nodes.map((n) => [n.id, n]));
  // child->parent map, so a native/opaque frame (spawn, GC) can be walked up to
  // the first-party frame RESPONSIBLE for it. Without this the #1 recurring culprit
  // — `spawn @ (native)` — has no app url and hides in the generic spawn bucket
  // (dev-deploy-state reads 0.00s even when it IS the spawner). See the insight.
  const parent = new Map();
  for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const nearestAppAncestor = (id) => {
    let cur = parent.get(id), hops = 0;
    while (cur != null && hops < 80) {
      const p = nodes.get(cur);
      const u = p?.callFrame?.url ?? '';
      if (isAppFrame(u)) {
        return `${p.callFrame.functionName || '(anon)'}  @ ${shortUrl(u)}:${(p.callFrame.lineNumber ?? -1) + 1}`;
      }
      cur = parent.get(cur); hops++;
    }
    return '(no app ancestor)';
  };
  const samples = prof.samples ?? [];
  const deltas = prof.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const dt = Math.max(0, deltas[i] ?? 0); // µs
    const n = nodes.get(samples[i]);
    if (!n) continue;
    const cf = n.callFrame;
    const url = cf.url ?? '';
    const fn = cf.functionName || '(anonymous)';
    const excludedKind = classifyCpuFrame(fn, url);
    if (excludedKind === 'profiler') { profilerMs += dt / 1000; continue; } // observer-effect
    if (excludedKind === 'non-work') { idleMs += dt / 1000; continue; }
    realMs += dt / 1000;
    const key = `${fn}  @ ${shortUrl(url)}:${(cf.lineNumber ?? -1) + 1}`;
    selfByFrame.set(key, (selfByFrame.get(key) ?? 0) + dt / 1000);
    const b = bucketOf(fn, shortUrl(url));
    selfByBucket.set(b, (selfByBucket.get(b) ?? 0) + dt / 1000);
    // Attribute native spawn/exec self-time to the app frame that triggered it.
    if (fn === 'spawn' || fn === 'spawnSync' || /child_process/.test(url)) {
      spawnMs += dt / 1000;
      const caller = nearestAppAncestor(samples[i]);
      spawnByCaller.set(caller, (spawnByCaller.get(caller) ?? 0) + dt / 1000);
    }
  }
}

const pct = (ms) => (100 * ms / (realMs || 1)).toFixed(1).padStart(5);
const sec = (ms) => (ms / 1000).toFixed(2).padStart(8);
const topFrames = [...selfByFrame].sort((a, b) => b[1] - a[1]).slice(0, TOP);
const buckets = [...selfByBucket].sort((a, b) => b[1] - a[1]);
const spawnCallers = [...spawnByCaller].sort((a, b) => b[1] - a[1]).slice(0, 12);

if (asJson) {
  console.log(JSON.stringify({
    profiles: files.length,
    profilerMs: Math.round(profilerMs), idleMs: Math.round(idleMs), realMs: Math.round(realMs),
    spawnMs: Math.round(spawnMs),
    buckets: buckets.map(([k, v]) => ({ bucket: k, ms: Math.round(v), pctOfReal: +(100 * v / (realMs || 1)).toFixed(1) })),
    spawnCallers: spawnCallers.map(([k, v]) => ({ caller: k, ms: Math.round(v), pctOfSpawn: +(100 * v / (spawnMs || 1)).toFixed(1), pctOfReal: +(100 * v / (realMs || 1)).toFixed(1) })),
    topFrames: topFrames.map(([k, v]) => ({ frame: k, ms: Math.round(v), pctOfReal: +(100 * v / (realMs || 1)).toFixed(1) })),
  }, null, 2));
} else {
  console.log(`\nProfiles: ${files.length}   on-CPU sampled — profiler(observer-effect): ${(profilerMs / 1000).toFixed(1)}s · idle/program: ${(idleMs / 1000).toFixed(1)}s · REAL workload: ${(realMs / 1000).toFixed(1)}s`);
  console.log(`(profiler frames = node:inspector capturing the profile; EXCLUDED from the % below — see the agent-insight)\n`);
  console.log('REAL workload by bucket:');
  for (const [k, v] of buckets) console.log(`  ${sec(v)}s  ${pct(v)}%  ${k}`);
  if (spawnCallers.length) {
    console.log(`\nspawn/exec self-time by nearest APP-frame caller (native \`spawn\` has no url of its own — this is who triggered it):`);
    for (const [k, v] of spawnCallers) console.log(`  ${sec(v)}s  ${(100 * v / (spawnMs || 1)).toFixed(1).padStart(5)}% of spawn  ${pct(v)}% of real  ${k}`);
  }
  console.log(`\nTop ${TOP} frames by self-time:`);
  for (const [k, v] of topFrames) console.log(`  ${sec(v)}s  ${pct(v)}%  ${k}`);
}
