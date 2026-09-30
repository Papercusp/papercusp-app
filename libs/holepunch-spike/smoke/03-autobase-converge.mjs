/**
 * smoke:autobase — two-writer Autobase, in-process replication,
 * verify both peers converge on the same merged view.
 *
 * This is the heart of the dogfood plan's HYPERBEE sync model.
 * If this works, the plan's multi-writer CRDT-ish layer is on solid ground.
 *
 * Strategy:
 *   1. Two independent corestores (separate tmp dirs).
 *   2. Pipe their replicate() streams together to simulate a perfect link.
 *   3. Writer A bootstraps; A adds B as a writer; A and B both append.
 *   4. Wait briefly for convergence, then assert both views are identical.
 */

import Corestore from 'corestore';
import Autobase from 'autobase';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpA = mkdtempSync(join(tmpdir(), 'autobase-a-'));
const tmpB = mkdtempSync(join(tmpdir(), 'autobase-b-'));
process.on('exit', () => {
  try { rmSync(tmpA, { recursive: true, force: true }); } catch {}
  try { rmSync(tmpB, { recursive: true, force: true }); } catch {}
});

const storeA = new Corestore(tmpA);
const storeB = new Corestore(tmpB);
await storeA.ready();
await storeB.ready();

// pipe replication both ways
const s1 = storeA.replicate(true);
const s2 = storeB.replicate(false);
s1.on('error', () => {});
s2.on('error', () => {});
s1.pipe(s2).pipe(s1);

// Autobase config — view is a hypercore where we just push ops as-is.
function open(store) {
  return store.get('view', { valueEncoding: 'json' });
}

function makeApply(label) {
  return async function apply(nodes, view, host) {
    for (const node of nodes) {
      const op = node.value;
      if (op && op.type === 'addWriter') {
        await host.addWriter(Buffer.from(op.key, 'hex'));
        continue;
      }
      await view.append(op);
    }
  };
}

// A bootstraps — no remote.key
const baseA = new Autobase(storeA, null, {
  apply: makeApply('A'),
  open,
  valueEncoding: 'json',
});
await baseA.ready();

// B uses A's bootstrap key
const baseB = new Autobase(storeB, baseA.key, {
  apply: makeApply('B'),
  open,
  valueEncoding: 'json',
});
await baseB.ready();

// A adds B as a writer
await baseA.append({ type: 'addWriter', key: baseB.local.key.toString('hex') });
await baseA.update();

// give replication a moment to propagate the addWriter
await new Promise((r) => setTimeout(r, 500));
await baseB.update();

// Both append something
await baseA.append({ from: 'A', msg: 'hello from A', t: Date.now() });
await baseB.append({ from: 'B', msg: 'hello from B', t: Date.now() });

// Convergence wait — poll until both views agree, max 10s
const deadline = Date.now() + 10_000;
let final = null;
while (Date.now() < deadline) {
  await baseA.update();
  await baseB.update();
  const lenA = baseA.view.length;
  const lenB = baseB.view.length;
  if (lenA === lenB && lenA >= 2) {
    // pull views
    const viewA = [];
    const viewB = [];
    for (let i = 0; i < lenA; i++) viewA.push(await baseA.view.get(i));
    for (let i = 0; i < lenB; i++) viewB.push(await baseB.view.get(i));
    const aJson = JSON.stringify(viewA);
    const bJson = JSON.stringify(viewB);
    if (aJson === bJson) {
      final = { len: lenA, view: viewA };
      break;
    }
  }
  await new Promise((r) => setTimeout(r, 100));
}

if (!final) {
  console.error('FAIL — views did not converge within 10s');
  console.error(`  A.view.length=${baseA.view.length}, B.view.length=${baseB.view.length}`);
  process.exit(1);
}

console.log(`Converged: view length = ${final.len}`);
console.log('View ops (in deterministic merged order):');
for (const op of final.view) {
  console.log(`  ${JSON.stringify(op)}`);
}

// sanity: both A and B's messages are present
const fromA = final.view.find((o) => o && o.from === 'A');
const fromB = final.view.find((o) => o && o.from === 'B');
if (!fromA || !fromB) {
  console.error('FAIL — missing one of the writer messages');
  process.exit(1);
}

console.log('\nsmoke:autobase PASSED — multi-writer convergence works.');
process.exit(0);
