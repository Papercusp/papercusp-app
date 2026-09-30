/**
 * smoke:hyperbee — Hyperbee KV on top of an Autobase view, two-writer
 * convergence including a same-key conflict resolved deterministically.
 *
 * This is the actual production pattern from v5 §7.1:
 *   Hyperbee key prefix `features/by-id/<feature_id>` over the autobase
 *   merged log, projected back into Postgres on each peer.
 *
 * If this passes, the dogfood plan's HYPERBEE bucket is on solid ground.
 *
 * Test scenario:
 *   1. Writer A puts features/F-001 = {title: "A's version"}
 *   2. Writer B puts features/F-002 = {title: "B's version"}
 *   3. Both also put features/F-CONFLICT — different values, same key.
 *      Verify both peers agree on which one wins (deterministic LWW).
 */

import Corestore from 'corestore';
import Autobase from 'autobase';
import Hyperbee from 'hyperbee';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpA = mkdtempSync(join(tmpdir(), 'hb-a-'));
const tmpB = mkdtempSync(join(tmpdir(), 'hb-b-'));
process.on('exit', () => {
  try { rmSync(tmpA, { recursive: true, force: true }); } catch {}
  try { rmSync(tmpB, { recursive: true, force: true }); } catch {}
});

const storeA = new Corestore(tmpA);
const storeB = new Corestore(tmpB);
await storeA.ready();
await storeB.ready();

const s1 = storeA.replicate(true);
const s2 = storeB.replicate(false);
s1.on('error', () => {});
s2.on('error', () => {});
s1.pipe(s2).pipe(s1);

// Hyperbee-as-view: open returns a Hyperbee instance backed by a hypercore.
function open(store) {
  const core = store.get('view');
  return new Hyperbee(core, {
    keyEncoding: 'utf-8',
    valueEncoding: 'json',
  });
}

async function apply(nodes, view, host) {
  // Use the batch API for atomic apply
  const batch = view.batch({ update: false });
  for (const node of nodes) {
    const op = node.value;
    if (op && op.type === 'addWriter') {
      await host.addWriter(Buffer.from(op.key, 'hex'));
      continue;
    }
    if (op && op.type === 'put') {
      await batch.put(op.key, op.value);
    }
    if (op && op.type === 'del') {
      await batch.del(op.key);
    }
  }
  await batch.flush();
}

const baseA = new Autobase(storeA, null, {
  apply, open, valueEncoding: 'json',
});
await baseA.ready();

const baseB = new Autobase(storeB, baseA.key, {
  apply, open, valueEncoding: 'json',
});
await baseB.ready();

await baseA.append({ type: 'addWriter', key: baseB.local.key.toString('hex') });
await baseA.update();
await new Promise((r) => setTimeout(r, 500));
await baseB.update();

// Distinct keys
await baseA.append({ type: 'put', key: 'features/F-001', value: { title: "A's feature", owner: 'A' } });
await baseB.append({ type: 'put', key: 'features/F-002', value: { title: "B's feature", owner: 'B' } });

// Same-key conflict: both write to features/F-CONFLICT with different values.
await baseA.append({ type: 'put', key: 'features/F-CONFLICT', value: { title: "A wrote this", owner: 'A' } });
await baseB.append({ type: 'put', key: 'features/F-CONFLICT', value: { title: "B wrote this", owner: 'B' } });

// Converge
const deadline = Date.now() + 10_000;
let converged = false;
while (Date.now() < deadline) {
  await baseA.update();
  await baseB.update();
  const a1 = await baseA.view.get('features/F-001');
  const b1 = await baseB.view.get('features/F-001');
  const a2 = await baseA.view.get('features/F-002');
  const b2 = await baseB.view.get('features/F-002');
  const aC = await baseA.view.get('features/F-CONFLICT');
  const bC = await baseB.view.get('features/F-CONFLICT');
  if (
    a1 && b1 && a2 && b2 && aC && bC &&
    JSON.stringify(a1.value) === JSON.stringify(b1.value) &&
    JSON.stringify(a2.value) === JSON.stringify(b2.value) &&
    JSON.stringify(aC.value) === JSON.stringify(bC.value)
  ) {
    console.log('Converged. KV state on both peers:');
    console.log(`  features/F-001       → ${JSON.stringify(a1.value)}`);
    console.log(`  features/F-002       → ${JSON.stringify(a2.value)}`);
    console.log(`  features/F-CONFLICT  → ${JSON.stringify(aC.value)}  (deterministic winner)`);
    converged = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}

if (!converged) {
  console.error('FAIL — Hyperbee views did not converge within 10s');
  process.exit(1);
}

// Verify range query works (this is how we'll do "all features" lookups)
const rangeKeys = [];
for await (const { key } of baseA.view.createReadStream({ gte: 'features/', lt: 'features/\xff' })) {
  rangeKeys.push(key);
}
if (rangeKeys.length !== 3) {
  console.error(`FAIL — range query expected 3 keys, got ${rangeKeys.length}: ${rangeKeys}`);
  process.exit(1);
}
console.log(`Range query (gte=features/, lt=features/\\xff) returned ${rangeKeys.length} keys:`);
for (const k of rangeKeys) console.log(`  - ${k}`);

console.log('\nsmoke:hyperbee PASSED — KV-over-Autobase converges + LWW deterministic + range queries work.');
process.exit(0);
