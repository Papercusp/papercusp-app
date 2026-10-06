#!/usr/bin/env node
// Summarize top retainer classes from V8 .heapsnapshot files captured by the
// event-loop-lag monitor's heap-snapshot-on-high-RSS feature
// (~/.papercusp/heap-snapshots/heap-*.heapsnapshot).
//
// Companion to analyze-loop-profiles.mjs — use both together: the CPU profile
// says "what code is on the loop", the heap snapshot says "what objects are
// leaking". Load the .heapsnapshot file in Chrome DevTools Memory tab for
// the full retainer tree; this script gives you the quick class-level summary.
//
// Usage:
//   node scripts/analyze-heap-snapshots.mjs [dir] [--top N] [--json]
//
// Defaults:
//   dir      ~/.papercusp/heap-snapshots
//   --top    30     how many top retainer classes to print
//   --json   emit machine-readable JSON instead of the table
//
// Output columns (human-readable table):
//   size(MB)  — total self_size of all instances of that class
//   %         — fraction of the total tracked heap in this snapshot set
//   count     — number of node instances of that class
//   class     — the V8 class/constructor name (from the snapshot string table)
//
// V8 heap snapshot format (JSON):
//   snapshot.meta.node_fields  — ordered field names per node entry
//   snapshot.meta.node_types   — node_types[0] is the array of type name strings
//   snapshot.node_count        — number of nodes
//   nodes[]                    — flat array: node_count × node_fields.length
//   strings[]                  — string table indexed by the 'name' field value

import { readdirSync, createReadStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { createHash } from 'node:crypto';
import { parser } from 'stream-json';
import { executeGovernedByteProcess } from './lib/governed-test-process.mjs';

const classLabel = (type, raw) => !type.includes('string') && typeof raw === 'string' && raw.length <= 80 &&
  (/^[A-Za-z_$][A-Za-z0-9_.$]*$/.test(raw) || /^\(object (?:elements|properties)\)$/.test(raw))
  ? raw : '(' + type + ')';

/** A complete node census, not a dominator graph or exclusive retained bytes.
 * Snapshot string names contain actual payloads. Only fixed V8 types and
 * constructor-shaped labels are eligible for this persisted aggregate.
 */
export function summarizeHeapSnapshot(snap, { top = 30 } = {}) {
  if (!Number.isInteger(top) || top < 1 || top > 100) throw new TypeError('Invalid heap census top limit');
  const meta = snap?.snapshot?.meta;
  const fields = meta?.node_fields, types = meta?.node_types?.[0];
  const count = snap?.snapshot?.node_count;
  if (!Array.isArray(fields) || !Array.isArray(types) || !types.every(type => typeof type === 'string') ||
      !Number.isSafeInteger(count) || count < 0 || !Array.isArray(snap.nodes) || !Array.isArray(snap.strings))
    throw new TypeError('Invalid heap snapshot node metadata');
  const ti = fields.indexOf('type'), ni = fields.indexOf('name'), si = fields.indexOf('self_size');
  if (!fields.length || ti < 0 || ni < 0 || si < 0 || snap.nodes.length !== count * fields.length)
    throw new TypeError('Incomplete heap snapshot nodes');
  const byType = new Map(), byClass = new Map();
  let totalSelfSizeBytes = 0;
  for (let index = 0; index < count; index++) {
    const base = index * fields.length;
    const typeId = snap.nodes[base + ti], nameId = snap.nodes[base + ni], bytes = snap.nodes[base + si];
    if (!Number.isSafeInteger(typeId) || typeId < 0 || typeId >= types.length ||
        !Number.isSafeInteger(nameId) || nameId < 0 || nameId >= snap.strings.length ||
        !Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('Invalid heap snapshot node values');
    const type = types[typeId];
    const raw = snap.strings[nameId];
    // Never inspect STRING-family names as labels: they are the string content.
    // Native/code names can contain filesystem paths or source text too.
    const label = classLabel(type, raw);
    const key = type + '\0' + label;
    const add = (map, key, initial) => {
      const row = map.get(key) ?? { ...initial, count: 0, selfSizeBytes: 0 };
      row.count++; row.selfSizeBytes += bytes; map.set(key, row);
    };
    add(byType, type, { type }); add(byClass, key, { type, class: label });
    totalSelfSizeBytes += bytes;
  }
  return { nodeCount: count, totalSelfSizeBytes,
    types: [...byType.values()].sort((a, b) => b.selfSizeBytes - a.selfSizeBytes),
    topClasses: [...byClass.values()].sort((a, b) => b.selfSizeBytes - a.selfSizeBytes).slice(0, top),
    definition: 'V8 snapshot node self_size, after snapshot GC; not retained/exclusive bytes or total native memory.' };
}

/** @typedef {{index: number, id: number, type: string, class: string, selfSizeBytes: number, retainedSizeBytes: number, children: number, retainers: {index: number, id: number, type: string, class: string, selfSizeBytes: number, retainedSizeBytes: number, children: number, retainsIndex: number, edgeType: string}[], retainerCount: number, retainersTruncated: boolean}} HeapRetainerNode */
/** @typedef {{parser: string, rootIndex: number, limits: {top: number, perClass: number, retainerDepth: number, maxRetainers: number, objectIds?: number[]}, groups: {class: string, count: number, selfSizeBytes: number, retainedSizeBytes: number, nodes: HeapRetainerNode[]}[], requestedNodes?: {id: number, status: string, node?: HeapRetainerNode}[], definition: string, privacy: string, upstreamRevision?: string, retainerDefinition?: string, native?: {executableSha256: string, inputBytes: number, inputSha256: string, elapsedMs: number, status: number|null, signal: NodeJS.Signals|null, stdoutBytes: number, stderrBytes: number, errorCode: string|null}}} HeapRetainerReport */

/** Private snapshot analysis using the maintained Rust native/WASM dominator graph.
 * Input remains bytes: constructing a V8 string would reject large snapshots.
 * Returned names contain only constructor/function labels, never string values
 * or edge/property names. Class retained sizes overlap and must not be added.
 * @param {Uint8Array} input
 * @param {{ top?: number, perClass?: number, retainerDepth?: number, maxRetainers?: number, decoderControl?: string, nativeExecutable?: string, objectIds?: number[] }} [options]
 * @returns {Promise<HeapRetainerReport>}
 */
export async function summarizeHeapRetainers(input, { top = 10, perClass = 3, nativeExecutable, retainerDepth = nativeExecutable ? 1 : 2, maxRetainers = 32, decoderControl, objectIds } = {}) {
  if (!(input instanceof Uint8Array) || !input.byteLength) throw new TypeError('Heap graph requires snapshot bytes');
  for (const [name, value, maximum] of [['top', top, 30], ['perClass', perClass, 10],
    ['retainerDepth', retainerDepth, 3], ['maxRetainers', maxRetainers, 100]]) {
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new TypeError('Invalid heap graph ' + name);
  }
  if (objectIds !== undefined && (!Array.isArray(objectIds) || objectIds.length < 1 || objectIds.length > 64 ||
      new Set(objectIds).size !== objectIds.length || objectIds.some(id => !Number.isSafeInteger(id) || id < 1)))
    throw new TypeError('Invalid heap object IDs');
  if (objectIds && !nativeExecutable) throw new TypeError('Exact heap object IDs require the native adapter');
  if (nativeExecutable) return summarizeNativeHeapRetainers(input, nativeExecutable, { top, perClass, retainerDepth, maxRetainers, objectIds });
  const heapParser = await import('@vscode/v8-heap-parser');
  const { decode_bytes, init_panic_hook, NodeType, EdgeType, WasmSortBy } = heapParser;
  // Without the upstream hook, a Rust panic loses its origin and becomes only
  // "unreachable". Reduce panic output to fixed kinds and numeric evidence;
  // decoder messages can quote private input and must never be persisted.
  init_panic_hook();
  /** @type {import('@vscode/v8-heap-parser').Graph | undefined} */
  let graph;
  let phase = 'decode-bytes';
  const panic = { kind: 'unclassified', source: '', allocationBytes: 0, length: 0, index: 0 };
  const consoleError = console.error;
  console.error = (...args) => {
    const text = args.filter(value => typeof value === 'string').join('\n');
    const source = text.match(/(?:^|\/)src\/([a-z_]+\.rs:\d+:\d+)/m);
    if (source) panic.source = source[1];
    const allocation = text.match(/memory allocation of (\d+) bytes failed/);
    const bounds = text.match(/index out of bounds: the len is (\d+) but the index is (\d+)/);
    if (allocation) { panic.kind = 'allocation-failed'; panic.allocationBytes = Number(allocation[1]); }
    else if (bounds) { panic.kind = 'index-out-of-bounds'; panic.length = Number(bounds[1]); panic.index = Number(bounds[2]); }
    else if (text.includes('capacity overflow')) panic.kind = 'capacity-overflow';
    else if (text.includes('attempt to subtract with overflow')) panic.kind = 'subtract-overflow';
    else if (text.includes('expected root index to be first or last')) panic.kind = 'unsupported-root-index';
  };
  const safeBytes = value => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) throw new TypeError('Unsafe heap graph byte count');
    return number;
  };
  const nodeRow = node => {
    const type = NodeType[node.typ] ?? 'Other';
    // The parser's enum uses title-case names. Normalize STRING variants before
    // applying the same payload exclusion as the streaming self-size census.
    const typeLabel = type.toLowerCase();
    return { index: node.index, id: node.id, type,
      class: typeLabel.includes('string') ? '(' + typeLabel + ')' : classLabel(typeLabel, node.name()),
      selfSizeBytes: safeBytes(node.self_size),
      retainedSizeBytes: safeBytes(node.retained_size), children: node.children_len };
  };
  const genericLabels = new Set(['(system)', '(array)', '(string)', '(object)', '(compiled code)',
    '(closure)', '(regexp)', '(number)', '(native)', '(synthetic)', '(concatenated string)',
    '(sliced string)', '(bigint)', '(unknown)']);
  try {
    graph = decode_bytes(input);
    phase = 'class-dominators';
    const groups = graph.get_class_groups(0, top, false);
    try {
      const rows = groups.map((group, groupIndex) => {
        const raw = group.name();
        const row = { class: genericLabels.has(raw) ? raw : classLabel('class', raw),
          count: group.children_len, selfSizeBytes: safeBytes(group.self_size),
          retainedSizeBytes: safeBytes(group.retained_size) };
        phase = 'class-children';
        const nodes = graph.class_children(groupIndex, 0, perClass, WasmSortBy.RetainedSize);
        try {
          const nodeRows = nodes.map(node => {
            phase = 'direct-retainers';
            const retainers = graph.get_all_retainers(node.index, retainerDepth);
            try {
              return { ...nodeRow(node), retainers: retainers.slice(0, maxRetainers).map(retainer => ({
                ...nodeRow(retainer), retainsIndex: retainer.retains_index,
                edgeType: EdgeType[retainer.edge_typ] ?? 'Other' })),
                retainerCount: retainers.length, retainersTruncated: retainers.length > maxRetainers };
            } finally { for (const retainer of retainers) retainer.free(); }
          });
          return { ...row, nodes: nodeRows };
        } finally { for (const node of nodes) node.free(); }
      });
      return { parser: '@vscode/v8-heap-parser@0.1.0', rootIndex: graph.root_index,
        limits: { top, perClass, retainerDepth, maxRetainers }, groups: rows,
        definition: 'Node retained_size is dominator-owned V8 self_size; class retained sizes overlap. Not total native memory or production savings.',
        privacy: 'String payloads, source text, filesystem names and edge/property names are omitted.' };
    } finally { for (const group of groups) group.free(); }
  } catch (cause) {
    // Never include the decoder's message: it can quote private input. Phase
    // and error class are enough to distinguish decode from graph failures.
    const wasm = Object.getOwnPropertyDescriptor(heapParser.default ?? heapParser, '__wasm')?.value;
    const wasmFrames = cause instanceof Error ? [...(cause.stack ?? '').matchAll(/wasm-function\[(\d+)\]:(0x[a-f0-9]+)/g)]
      .slice(0, 16).map(match => ({ functionIndex: Number(match[1]), offset: match[2] })) : [];
    throw Object.assign(new Error('Heap retainer analysis failed at ' + phase + ' (' +
      (cause instanceof Error ? cause.name : 'unknown') + ')'), {
      diagnostic: { phase, inputBytes: input.byteLength, wasmMemoryBytes: wasm?.memory?.buffer?.byteLength ?? null, panic, wasmFrames,
        ...(decoderControl && phase === 'decode-bytes' ? { nativeControl: await checkNativeHeapDecode(input, decoderControl) } : {}) },
    });
  } finally { console.error = consoleError; graph?.free(); }
}

/** Run the pinned native adapter without persisting the private snapshot.
 * Build with cargo build --locked --release --manifest-path scripts/heap-retainers-native/Cargo.toml.
 * @param {Uint8Array} input
 * @param {string} executable
 * @param {{ top: number, perClass: number, retainerDepth: number, maxRetainers: number, objectIds?: number[] }} limits
 * @returns {Promise<HeapRetainerReport>}
 */
async function summarizeNativeHeapRetainers(input, executable, limits) {
  if (limits.retainerDepth !== 1) throw new TypeError('Native heap graph supports retainerDepth 1 only');
  const executableSha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
  const started = Date.now();
  const args = [limits.top, limits.perClass, limits.retainerDepth, limits.maxRetainers].map(String);
  if (limits.objectIds) args.push(limits.objectIds.join(','));
  const result = await executeGovernedByteProcess(executable, args, input,
    { namespace: 'heap-retainer-analysis', timeoutMs: 120_000, maxBuffer: 16 * 1024 * 1024 });
  const receipt = { executableSha256, inputBytes: input.byteLength,
    inputSha256: createHash('sha256').update(input).digest('hex'), elapsedMs: Date.now() - started,
    status: result.status, signal: result.signal, stdoutBytes: Buffer.byteLength(result.stdout ?? ''),
    stderrBytes: Buffer.byteLength(result.stderr ?? ''), errorCode: result.error?.code ?? null };
  let report;
  try { report = JSON.parse(result.stdout ?? ''); } catch {}
  if (result.status !== 0 || result.error || report?.upstreamRevision !== '05edd8131a77790ab0e7bce2eedf5770d6bb83ae') {
    const phase = ['preflight', 'read-input', 'decode-bytes', 'class-dominators', 'direct-retainers'].includes(report?.error?.phase)
      ? report.error.phase : 'native-process';
    throw Object.assign(new Error('Heap retainer analysis failed at ' + phase + ' (native)'), {
      diagnostic: { phase, native: receipt },
    });
  }
  return { ...report, native: receipt };
}

/** Compare the SAME bytes with the pinned upstream native v8-heap executable.
 * This is a decoder discriminator, not retainer attribution. --top 0 prevents
 * private names from reaching stdout; even failures persist only fixed/numeric
 * fields, never subprocess stderr or input. No snapshot file is created.
 * @param {Uint8Array} input
 * @param {string} executable
 */
export async function checkNativeHeapDecode(input, executable) {
  const started = Date.now();
  const executableSha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
  const result = await executeGovernedByteProcess(executable, ['-', '--no-retained', '--top', '0', '--format', 'json'], input,
    { namespace: 'heap-decode-control', timeoutMs: 60_000, maxBuffer: 16 * 1024 });
  return { parser: 'microsoft/vscode-v8-heap-tools native decoder', executableSha256,
    inputBytes: input.byteLength, inputSha256: createHash('sha256').update(input).digest('hex'),
    elapsedMs: Date.now() - started, status: result.status, signal: result.signal,
    decoded: result.status === 0 && result.stdout.trim() === '[]',
    stdoutBytes: Buffer.byteLength(result.stdout ?? ''), stderrBytes: Buffer.byteLength(result.stderr ?? ''),
    errorCode: result.error?.code ?? null, definition: 'Native decode and class enumeration only; no dominators or retaining-owner proof.' };
}

/** Stream even multi-GB snapshots. Never pack a payload string or node array.
 * @param {import('node:stream').Readable} input
 * @param {{ top?: number }} [options] top=0 keeps all classes for multi-snapshot aggregation.
 */
export async function summarizeHeapSnapshotStream(input, { top = 30 } = {}) {
  if (!Number.isInteger(top) || top < 0 || top > 100) throw new TypeError('Invalid heap census top limit');
  const hash = createHash('sha256'); let bytes = 0;
  input.on('data', chunk => { hash.update(chunk); bytes += Buffer.byteLength(chunk); });
  const stream = input.pipe(parser.asStream({ packStrings: false, streamStrings: true,
    packNumbers: true, streamNumbers: false, packKeys: true, streamKeys: false }));
  const fields = [], types = [], frames = [], byType = new Map(), byClass = new Map(), names = new Map();
  let nodeCount, values = 0, examined = 0, strings = 0, maxNameId = -1, totalSelfSizeBytes = 0;
  let valueText = '', longString = false, row = [], nodesSeen = false, stringsSeen = false;
  const path = () => {
    const frame = frames[frames.length - 1];
    return frame ? frame.path.concat(frame.array ? frame.index : frame.key) : [];
  };
  const finish = () => { const frame = frames[frames.length - 1]; if (frame?.array) frame.index++; };
  const add = (map, key, initial, count, size) => {
    const entry = map.get(key) ?? { ...initial, count: 0, selfSizeBytes: 0 };
    entry.count += count; entry.selfSizeBytes += size; map.set(key, entry);
  };
  const classify = (typeId, raw, count, size) => {
    const type = types[typeId], label = classLabel(type, raw);
    add(byClass, type + '\0' + label, { type, class: label }, count, size);
  };
  const scalar = value => {
    const p = path();
    if (p.join('.') === 'snapshot.node_count') nodeCount = value;
    else if (p.length === 4 && p.slice(0, 3).join('.') === 'snapshot.meta.node_fields') fields.push(value);
    else if (p.length === 5 && p.slice(0, 4).join('.') === 'snapshot.meta.node_types.0') types.push(value);
    else if (p.length === 2 && p[0] === 'nodes') {
      if (!fields.length || !types.length) throw TypeError('Heap metadata must precede nodes');
      const nf = fields.length;
      row.push(value); values++;
      if (row.length === nf) {
        const typeId = row[fields.indexOf('type')], nameId = row[fields.indexOf('name')], size = row[fields.indexOf('self_size')];
        if (!Number.isSafeInteger(typeId) || typeId < 0 || typeId >= types.length ||
            !Number.isSafeInteger(nameId) || nameId < 0 || !Number.isSafeInteger(size) || size < 0)
          throw TypeError('Invalid heap snapshot node values');
        maxNameId = Math.max(maxNameId, nameId); examined++; totalSelfSizeBytes += size;
        add(byType, types[typeId], { type: types[typeId] }, 1, size);
        if (types[typeId].includes('string')) classify(typeId, '', 1, size);
        else {
          const name = names.get(nameId) ?? new Map();
          add(name, typeId, {}, 1, size); names.set(nameId, name);
        }
        row = [];
      }
    } else if (p.length === 2 && p[0] === 'strings') {
      if (typeof value !== 'string') throw TypeError('Invalid heap string table');
      for (const [typeId, entry] of names.get(strings) ?? []) classify(typeId, value, entry.count, entry.selfSizeBytes);
      names.delete(strings); strings++;
    }
    finish();
  };
  await new Promise((resolve, reject) => {
    input.once('error', reject); stream.once('error', reject); stream.once('end', resolve);
    stream.on('data', token => {
      try {
        if (token.name === 'keyValue') frames[frames.length - 1].key = token.value;
        else if (token.name === 'startObject' || token.name === 'startArray') {
          const p = path();
          if (p.length === 1 && p[0] === 'nodes') nodesSeen = true;
          if (p.length === 1 && p[0] === 'strings') stringsSeen = true;
          frames.push({ path: p, array: token.name === 'startArray', index: 0 });
        } else if (token.name === 'endObject' || token.name === 'endArray') { frames.pop(); finish(); }
        else if (token.name === 'startString') { valueText = ''; longString = false; }
        else if (token.name === 'stringChunk' && !longString) {
          if (valueText.length + token.value.length > 80) { valueText = ''; longString = true; }
          else valueText += token.value;
        } else if (token.name === 'endString') scalar(longString ? '' : valueText);
        else if (token.name === 'numberValue') scalar(Number(token.value));
        else if (['trueValue', 'falseValue', 'nullValue'].includes(token.name)) scalar(token.value);
      } catch (error) { input.destroy(); stream.destroy(error); }
    });
  });
  if (!Number.isSafeInteger(nodeCount) || nodeCount < 0 || !nodesSeen || !stringsSeen ||
      examined !== nodeCount || values !== nodeCount * fields.length || maxNameId >= strings || names.size)
    throw TypeError('Incomplete heap snapshot nodes/string table');
  return { bytes, sha256: hash.digest('hex'), census: { nodeCount, totalSelfSizeBytes,
    types: [...byType.values()].sort((a, b) => b.selfSizeBytes - a.selfSizeBytes),
    topClasses: [...byClass.values()].sort((a, b) => b.selfSizeBytes - a.selfSizeBytes).slice(0, top || undefined),
    definition: 'V8 snapshot node self_size, after snapshot GC; not retained/exclusive bytes or total native memory.' } };
}

async function main() {

const args = process.argv.slice(2);
const topIdx = args.indexOf('--top');
const TOP = topIdx >= 0 && args[topIdx + 1] ? Number(args[topIdx + 1]) : 30;
const asJson = args.includes('--json');
// Positional = non-flag args, skipping the value that follows --top.
const skipIdx = topIdx >= 0 ? topIdx + 1 : -1;
const positional = args.filter((a, i) => !a.startsWith('--') && i !== skipIdx);
const dir = positional[0] ?? join(homedir(), '.papercusp', 'heap-snapshots');

let files;
try {
  files = readdirSync(dir)
    .filter((f) => f.endsWith('.heapsnapshot'))
    .sort() // oldest→newest so we process in capture order
    .map((f) => join(dir, f));
} catch (e) {
  console.error(`Cannot read snapshot dir ${dir}: ${e.message}`);
  process.exit(1);
}
if (files.length === 0) {
  console.error(`No *.heapsnapshot in ${dir}`);
  console.error(
    `Tip: enable heap snapshots by setting PAPERCUSP_HEAP_SNAPSHOT=1 in the bg-host env.`,
  );
  process.exit(1);
}

// Aggregate across all snapshots: class name → { selfSize, count }.
// Aggregation by string value is cross-snapshot safe — each snapshot's strings[]
// is resolved to its actual value before accumulation.
const byClass = new Map(); // name → { selfSize: number, count: number }
let totalSizeBytes = 0;
let parsedSnapshots = 0;

for (const file of files) {
  try {
    const { census } = await summarizeHeapSnapshotStream(createReadStream(file), { top: 0 });
    parsedSnapshots++; totalSizeBytes += census.totalSelfSizeBytes;
    for (const row of census.topClasses) {
      const prev = byClass.get(row.class) ?? { selfSize: 0, count: 0 };
      prev.selfSize += row.selfSizeBytes; prev.count += row.count; byClass.set(row.class, prev);
    }
  } catch (error) { console.error(`  skip (unparseable): ${file}: ${error.message}`); }
}

if (parsedSnapshots === 0) {
  console.error('No valid snapshots found — all files skipped.');
  process.exit(1);
}

const sorted = [...byClass.entries()]
  .sort((a, b) => b[1].selfSize - a[1].selfSize)
  .slice(0, TOP);

const mb = (b) => (b / 1_048_576).toFixed(1).padStart(8);
const pct = (b) => (100 * (b / (totalSizeBytes || 1))).toFixed(1).padStart(5);
// Single-line + length-clamp a class label so one long/multi-line name can't
// break the table alignment (string nodes are already collapsed, but regexp /
// long constructor names can still be wide).
const label = (s) => {
  const oneLine = String(s).replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? oneLine.slice(0, 77) + '…' : oneLine;
};
const totalMb = (totalSizeBytes / 1_048_576).toFixed(1);
const totalGb = (totalSizeBytes / 1_073_741_824).toFixed(2);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        snapshots: parsedSnapshots,
        totalSizeBytes,
        topRetainers: sorted.map(([cls, { selfSize, count }]) => ({
          class: cls,
          selfSizeBytes: selfSize,
          selfSizeMb: Math.round(selfSize / 1_048_576),
          count,
          pctOfTotal: +(100 * (selfSize / (totalSizeBytes || 1))).toFixed(1),
        })),
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    `\nSnapshots: ${parsedSnapshots}  total tracked heap: ${totalMb} MB (${totalGb} GB)`,
  );
  console.log(`\nTop ${TOP} retainer classes by self_size (aggregated across ${parsedSnapshots} snapshot(s)):`);
  console.log(`  ${'size(MB)'.padStart(8)}  ${'%'.padStart(5)}  ${'count'.padStart(10)}  class`);
  for (const [cls, { selfSize, count }] of sorted) {
    console.log(
      `  ${mb(selfSize)}  ${pct(selfSize)}%  ${String(count).padStart(10)}  ${label(cls)}`,
    );
  }
  console.log(
    `\nTip: load a .heapsnapshot in Chrome DevTools (Memory → Load) for the full retainer tree.`,
  );
  console.log(`     Snapshots are in: ${dir}`);
}
}

if (isCliEntry(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
