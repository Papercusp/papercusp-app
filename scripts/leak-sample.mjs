#!/usr/bin/env node
// Attach to a running node process's inspector (opened via SIGUSR1), run the V8
// SAMPLING heap profiler for a window, and print the top allocation call-sites by
// total allocated bytes. Ideal for a FAST leak: names the exact code path that is
// allocating the growing memory, with low overhead + tiny output.
//
// Usage: node scripts/leak-sample.mjs <pid> [durationMs] [inspectorPort]
import { setTimeout as sleep } from 'node:timers/promises';
import {
  closeInspector,
  createCdpClient,
  discoverInspector,
  redactDiagnosticUrl,
} from './cdp-inspector.mjs';

const pid = Number(process.argv[2]);
const durationMs = Number(process.argv[3] || 45000);
const startPort = Number(process.argv[4] || 9229);
if (!pid) { console.error('usage: leak-sample.mjs <pid> [durationMs] [port]'); process.exit(1); }

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
let samplingError = null;
try {
  await client.send('HeapProfiler.enable');
  await client.send('HeapProfiler.startSampling', { samplingInterval: 16384 });
  console.error(`sampling ${durationMs}ms ...`);
  await sleep(durationMs);
  ({ profile } = await client.send('HeapProfiler.stopSampling'));
} catch (error) {
  samplingError = error;
}

let closeError = null;
try {
  await closeInspector(client, inspector.port);
} catch (error) {
  closeError = error;
}
if (samplingError) throw samplingError;
if (closeError) throw closeError;

// 3) aggregate self-allocated bytes per call frame (function@file:line)
const bySite = new Map();
let total = 0;
(function walk(node) {
  const cf = node.callFrame || {};
  const key = `${cf.functionName || '(anon)'} @ ${(cf.url || '').replace(/^.*\/papercusp\//, '')}:${cf.lineNumber ?? '?'}`;
  const self = node.selfSize || 0;
  bySite.set(key, (bySite.get(key) || 0) + self);
  total += self;
  for (const c of node.children || []) walk(c);
})(profile.head);

const top = [...bySite.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
console.log(`\n=== TOP ALLOCATION SITES (sampled ${(durationMs/1000)|0}s, total ${(total/1048576).toFixed(1)}MB sampled) ===`);
for (const [site, bytes] of top) {
  const mb = (bytes / 1048576).toFixed(1);
  const pct = ((bytes / total) * 100).toFixed(1);
  console.log(`${mb.padStart(8)}MB  ${pct.padStart(5)}%  ${site}`);
}
