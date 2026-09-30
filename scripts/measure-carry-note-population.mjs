#!/usr/bin/env node
/**
 * WI-7264 — what are `loop:checkpoint`'s bytes actually spent on?
 *
 * The context baseline (`scripts/measure-context-token-baseline.mjs`) established
 * that `loop:checkpoint` is the largest papercusp-OWNED consumer of agent context:
 * 7.95M argument chars over 6d, 15.4% of all `tool_use`, at 6,275 chars/call.
 * That is a MEAN, and a mean cannot distinguish a handful of 40KB outliers from a
 * uniform 6KB population — the two have completely different fixes. This script
 * samples the population itself and answers the three questions WI-7264 poses:
 *
 *   1. SIZE DISTRIBUTION — percentiles, not the mean, plus the head of the tail.
 *   2. FIELD DECOMPOSITION — which of did/left/insight/next/walls/checks carries
 *      the bytes. A `did` that has degenerated into a log is a different problem
 *      from a `checks` array that legitimately grew.
 *   3. REWRITE AMPLIFICATION — 1,267 calls over 6d against far fewer loops means
 *      notes are rewritten repeatedly. If a wake re-sends a mostly-unchanged note,
 *      the cost is the rewrite FREQUENCY, not the note size, and the fix is
 *      write-on-change (much cheaper). Measured as: of the chars in each call,
 *      how many were byte-identical lines already present in that session's
 *      PREVIOUS checkpoint call.
 *
 * Method matches the baseline deliberately so the numbers are comparable: same
 * transcript ROOTS, same file-mtime window, same `tool_use` argument accounting
 * (`name.length + JSON.stringify(input).length`).
 *
 * Caveat inherited from the baseline: the window filter is per-FILE mtime, so a
 * transcript touched inside the window contributes all its lines, including older
 * ones. Reported as `recordsOlderThanWindow` rather than silently corrected, so
 * this stays comparable to the number it is explaining.
 *
 * Usage: node scripts/measure-carry-note-population.mjs [days=6]
 */
import { createReadStream } from 'node:fs';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DAYS = Number(process.argv[2] || 6);
const CUTOFF = Date.now() - DAYS * 86_400_000;
const ROOTS = [join(homedir(), '.claude', 'projects'), join(homedir(), '.papercusp', 'session-claude')];
const OUT = join(
  homedir(),
  '.papercusp',
  `carry-note-population-${(process.argv[3] || 'loop:checkpoint').replace(/[^a-z0-9]+/gi, '-')}-${DAYS}d.json`,
);
/** chars→tokens estimate. Labelled everywhere it is used; never presented as a count. */
const CPT = 4;
/**
 * The tool under study, in every spelling a transcript may carry it. Defaults to
 * `loop:checkpoint`; pass a second argv (e.g. `work_items:checkpoint`) to point the
 * same analysis at any sibling that shares the carry-row shape — the row caps and the
 * `{claim, recheck, verified}` schema are common to both checkpoint tools, so the
 * rejection classes this measures are expected to be common too.
 */
const TOOL = (process.argv[3] || 'loop:checkpoint').replace(/[:_.]/g, '[:_.]?');
const TARGET = new RegExp(`(^|[:_.])${TOOL}$`, 'i');

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

/** Every call found, in transcript order within each session. */
const calls = [];
/** Name spellings actually observed, so a rename can never silently zero this out. */
const nameVariants = new Map();
/** The schema caps, from the tool's own zod `args` (checkpoint.ts). */
const CAPS = { note: 32_000, did: 8_000, left: 8_000, insight: 8_000, next: 8_000 };
let files = 0;
let lines = 0;
let recordsOlderThanWindow = 0;

for (const root of ROOTS) {
  for await (const file of walk(root)) {
    let st;
    try {
      st = await stat(file);
    } catch {
      continue;
    }
    if (st.mtimeMs < CUTOFF) continue;
    files += 1;
    let seq = 0;
    /** tool_use_id → call, so a later tool_result can be matched back to it. */
    const pending = new Map();
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      lines += 1;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const msg = rec?.message;
      if (!msg || (rec.type !== 'assistant' && rec.type !== 'user')) continue;
      const content = msg.content;
      const blocks = Array.isArray(content) ? content : [];
      for (const b of blocks) {
        // A rejected write is OBSERVABLE, not inferred: match the tool_result back
        // to its tool_use and read is_error. This is what separates "the schema
        // would reject this" from "the schema DID reject this".
        if (b && b.type === 'tool_result' && pending.has(b.tool_use_id)) {
          const call = pending.get(b.tool_use_id);
          pending.delete(b.tool_use_id);
          const text =
            typeof b.content === 'string'
              ? b.content
              : Array.isArray(b.content)
                ? b.content.map((x) => (typeof x === 'string' ? x : (x?.text ?? ''))).join('\n')
                : '';
          call.isError = b.is_error === true;
          if (call.isError) call.errorHead = text.slice(0, 300);
          continue;
        }
        if (!b || b.type !== 'tool_use' || typeof b.name !== 'string') continue;
        if (!TARGET.test(b.name)) continue;
        nameVariants.set(b.name, (nameVariants.get(b.name) || 0) + 1);
        const input = b.input && typeof b.input === 'object' ? b.input : {};
        const chars = b.name.length + JSON.stringify(input).length;
        const ts = Date.parse(rec.timestamp || '') || null;
        if (ts && ts < CUTOFF) recordsOlderThanWindow += 1;
        const fields = {};
        for (const [k, v] of Object.entries(input)) {
          fields[k] = typeof v === 'string' ? v.length : JSON.stringify(v).length;
        }
        const overCap = Object.entries(fields).filter(([k, n]) => CAPS[k] && n > CAPS[k]);
        const call = {
          file: file.slice(-64),
          seq: seq++,
          ts,
          chars,
          fields,
          overCap: overCap.map(([k, n]) => `${k}:${n}>${CAPS[k]}`),
          isError: null,
          errorHead: null,
          // Only the string fields are needed for the rewrite-overlap measure;
          // the structured ones (walls/checks) are compared by their JSON text.
          text: Object.fromEntries(
            Object.entries(input).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
          ),
        };
        calls.push(call);
        if (b.id) pending.set(b.id, call);
      }
    }
  }
}

const pct = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
const sizes = calls.map((c) => c.chars).sort((a, b) => a - b);
const totalChars = sizes.reduce((a, n) => a + n, 0);

// ── 2. FIELD DECOMPOSITION ────────────────────────────────────────────────────
const byField = new Map();
for (const c of calls) {
  for (const [k, n] of Object.entries(c.fields)) {
    const row = byField.get(k) || { chars: 0, present: 0, max: 0 };
    row.chars += n;
    row.present += 1;
    row.max = Math.max(row.max, n);
    byField.set(k, row);
  }
}
const fieldTable = [...byField.entries()]
  .map(([field, r]) => ({
    field,
    chars: r.chars,
    pctOfArgs: totalChars ? +((100 * r.chars) / totalChars).toFixed(2) : 0,
    present: r.present,
    presentPct: calls.length ? +((100 * r.present) / calls.length).toFixed(1) : 0,
    avgWhenPresent: r.present ? Math.round(r.chars / r.present) : 0,
    max: r.max,
  }))
  .sort((a, b) => b.chars - a.chars);

// ── 3. REWRITE AMPLIFICATION ──────────────────────────────────────────────────
// Per session, walk consecutive checkpoint calls and count how many chars of each
// call were carried in byte-identical LINES from that session's previous call.
// Line granularity (not whole-field equality) is deliberate: an agent that appends
// one line to a 6KB `did` re-sends ~6KB of unchanged text, and whole-field equality
// would score that as a full rewrite and hide the amplification entirely.
const bySession = new Map();
for (const c of calls) {
  if (!bySession.has(c.file)) bySession.set(c.file, []);
  bySession.get(c.file).push(c);
}
let repeatChars = 0;
let comparedChars = 0;
let pairs = 0;
const callsPerSession = [];
for (const [, list] of bySession) {
  list.sort((a, b) => a.seq - b.seq);
  callsPerSession.push(list.length);
  for (let i = 1; i < list.length; i += 1) {
    const prev = list[i - 1].text;
    const cur = list[i].text;
    pairs += 1;
    for (const [k, v] of Object.entries(cur)) {
      const prevLines = new Set(String(prev[k] ?? '').split('\n'));
      for (const ln of String(v).split('\n')) {
        comparedChars += ln.length + 1;
        if (ln.trim() && prevLines.has(ln)) repeatChars += ln.length + 1;
      }
    }
  }
}
const cps = callsPerSession.sort((a, b) => a - b);

// ── 4. REJECTED WRITES ────────────────────────────────────────────────────────
// A field over its zod `.max()` is REJECTED, not truncated — so the agent paid the
// full argument cost to transmit it and got a validation error back, then paid it
// again on the retry. Observed (is_error on the matched tool_result), not inferred.
const overCapCalls = calls.filter((c) => c.overCap.length);
const erroredCalls = calls.filter((c) => c.isError === true);
const rejected = {
  overCapCalls: overCapCalls.length,
  overCapChars: overCapCalls.reduce((a, c) => a + c.chars, 0),
  overCapDetail: overCapCalls.map((c) => ({ chars: c.chars, over: c.overCap, at: c.ts ? new Date(c.ts).toISOString() : null })),
  observedErrorCalls: erroredCalls.length,
  observedErrorChars: erroredCalls.reduce((a, c) => a + c.chars, 0),
  resultMatched: calls.filter((c) => c.isError !== null).length,
  errorSamples: erroredCalls.slice(0, 8).map((c) => ({ chars: c.chars, over: c.overCap, head: c.errorHead })),
  byClass: (() => {
    // Classify each failure by what an agent would have to change to avoid it.
    // Transport faults are separated out: they are not the tool's schema and no
    // amount of note-shaping prevents them.
    const classify = (h) => {
      const s = String(h || '');
      if (/MCP error|ECONNREFUSED|timed out|request_timeout/i.test(s)) return 'transport/infra (not schema)';
      if (/too long/i.test(s)) {
        const f = s.match(/invalid_args: ([\w.]+):/);
        return `row-field over its cap: ${f ? f[1].replace(/\.\d+\./, '[].') : 'unknown'}`;
      }
      if (/Unrecognized key/i.test(s)) return 'undeclared arg rejected';
      if (/expected string, received undefined|Invalid input/i.test(s)) return 'wrong row shape';
      return 'other';
    };
    const m = new Map();
    for (const c of erroredCalls) {
      const k = classify(c.errorHead);
      const row = m.get(k) || { calls: 0, chars: 0 };
      row.calls += 1;
      row.chars += c.chars;
      m.set(k, row);
    }
    return [...m.entries()]
      .map(([klass, r]) => ({ klass, ...r }))
      .sort((a, b) => b.chars - a.chars);
  })(),
  // Which arg names agents actually reach for that the tool does not declare —
  // a tally dominated by one or two names is a cheap alias, not an intrinsic cost.
  undeclaredKeys: (() => {
    const m = new Map();
    for (const c of erroredCalls) {
      for (const mm of String(c.errorHead || '').matchAll(/Unrecognized keys?: ((?:"[^"]+",? ?)+)/g)) {
        for (const k of mm[1].matchAll(/"([^"]+)"/g)) m.set(k[1], (m.get(k[1]) || 0) + 1);
      }
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([key, calls]) => ({ key, calls }));
  })(),
};

const biggest = [...calls]
  .sort((a, b) => b.chars - a.chars)
  .slice(0, 10)
  .map((c) => ({
    chars: c.chars,
    file: c.file,
    at: c.ts ? new Date(c.ts).toISOString() : null,
    fields: Object.fromEntries(Object.entries(c.fields).sort((a, b) => b[1] - a[1])),
  }));

// What share of the total lives in the top decile — the outliers-vs-uniform question.
const topDecileChars = sizes.slice(Math.floor(sizes.length * 0.9)).reduce((a, n) => a + n, 0);

const summary = {
  measuredAt: new Date().toISOString(),
  windowDays: DAYS,
  method:
    'raw claude transcript JSONL; tool_use argument chars = name.length + JSON.stringify(input).length — identical accounting to measure-context-token-baseline.mjs',
  filesScanned: files,
  linesScanned: lines,
  nameVariants: Object.fromEntries(nameVariants),
  recordsOlderThanWindow,
  calls: calls.length,
  totalChars,
  totalEstTokens: Math.round(totalChars / CPT),
  mean: calls.length ? Math.round(totalChars / calls.length) : 0,
  distribution: {
    min: sizes[0] ?? 0,
    p10: pct(sizes, 0.1),
    p25: pct(sizes, 0.25),
    p50: pct(sizes, 0.5),
    p75: pct(sizes, 0.75),
    p90: pct(sizes, 0.9),
    p95: pct(sizes, 0.95),
    p99: pct(sizes, 0.99),
    max: sizes[sizes.length - 1] ?? 0,
  },
  topDecileShareOfChars: totalChars ? +((100 * topDecileChars) / totalChars).toFixed(1) : 0,
  byField: fieldTable,
  rejected,
  rewriteAmplification: {
    sessionsWithCalls: bySession.size,
    callsPerSession: { p50: pct(cps, 0.5), p90: pct(cps, 0.9), max: cps[cps.length - 1] ?? 0 },
    consecutivePairs: pairs,
    comparedChars,
    repeatedChars: repeatChars,
    repeatedPct: comparedChars ? +((100 * repeatChars) / comparedChars).toFixed(1) : 0,
  },
  biggestCalls: biggest,
};

await writeFile(OUT, JSON.stringify({ ...summary, allSizes: sizes }, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`\n(full detail written to ${OUT})`);
