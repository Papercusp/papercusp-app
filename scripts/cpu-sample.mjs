#!/usr/bin/env node
// Attach to a running node process's inspector (opened via SIGUSR1), run the V8
// CPU profiler for a window, and print the top self-time call-sites. Companion to
// leak-sample.mjs (heap allocation) — this one is for CPU/event-loop attribution.
// Mirrors the manual method in the agent-insight
// "attributing-loop-saturation-via-cpuprofiles": subtracts the profiler's own
// observer-effect (node:inspector / (idle) / (program) frames) before ranking.
//
// Usage: node scripts/cpu-sample.mjs <pid> [durationMs] [inspectorPort] [--save <path>]
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import {
  closeInspector,
  createCdpClient,
  discoverInspector,
  redactDiagnosticUrl,
} from './cdp-inspector.mjs';
import { aggregateCpuProfile } from './lib/cpu-profile.mjs';

const args = process.argv.slice(2);
const saveIdx = args.indexOf('--save');
const savePath = saveIdx >= 0 ? args[saveIdx + 1] : null;
const positional = args.filter((a, i) => !a.startsWith('--') && (saveIdx < 0 || i !== saveIdx + 1));

const pid = Number(positional[0]);
const durationMs = Number(positional[1] || 30000);
const startPort = Number(positional[2] || 9229);
if (!pid) { console.error('usage: cpu-sample.mjs <pid> [durationMs] [port] [--save <path>]'); process.exit(1); }

// 1) open the inspector on the target
try { process.kill(pid, 'SIGUSR1'); } catch (e) { console.error('SIGUSR1 failed:', e.message); process.exit(1); }
await sleep(1200);

// 2) discover the inspector ws url (Node picks startPort, or next free)
let inspector = null;
for (let i = 0; i < 8 && !inspector; i += 1) {
  inspector = await discoverInspector({ startPort });
  if (!inspector) await sleep(700);
}
if (!inspector) { console.error('could not find inspector ws url (SIGUSR1 may need --inspect support)'); process.exit(1); }
console.error('inspector:', redactDiagnosticUrl(inspector.wsUrl));

const client = createCdpClient(inspector.wsUrl);
await client.connect();

let profile;
let profilingError = null;
try {
  await client.send('Profiler.enable');
  await client.send('Profiler.setSamplingInterval', { interval: 200 }); // µs; 200us = 5kHz, plenty for a 30s window
  await client.send('Profiler.start');
  console.error(`profiling ${durationMs}ms ...`);
  await sleep(durationMs);
  ({ profile } = await client.send('Profiler.stop'));
} catch (error) {
  profilingError = error;
}

let closeError = null;
try {
  await closeInspector(client, inspector.port);
} catch (error) {
  closeError = error;
}
if (profilingError) throw profilingError;
if (closeError) throw closeError;

if (savePath) {
  writeFileSync(savePath, JSON.stringify(profile));
  console.error(`saved raw profile to ${savePath}`);
}

// 3) aggregate self-time per call frame (function@file:line), excluding the
// profiler's observer/non-work frames before ranking.
const { totalUs, excludedUs, realUs, frames } = aggregateCpuProfile(profile);
const excludedPct = totalUs ? ((excludedUs / totalUs) * 100).toFixed(1) : '0.0';
const top = frames.slice(0, 30);
console.log(`\n=== TOP CPU SELF-TIME (sampled ${(durationMs/1000)|0}s, total ${(totalUs/1e6).toFixed(1)}s, observer/non-work excluded ${(excludedUs/1e6).toFixed(1)}s [${excludedPct}%], real workload ${(realUs/1e6).toFixed(1)}s) ===`);
for (const [site, us] of top) {
  const s = (us / 1e6).toFixed(2);
  const pct = ((us / (realUs || 1)) * 100).toFixed(1);
  console.log(`${s.padStart(7)}s  ${pct.padStart(5)}%  ${site}`);
}
