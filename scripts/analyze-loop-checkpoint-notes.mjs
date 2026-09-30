#!/usr/bin/env node
/**
 * WI-7264 — decompose the `loop:checkpoint` carry-note population.
 *
 * WHY: D-017 measured `loop:checkpoint` as the largest papercusp-side consumer
 * of agent context — 7.95M chars / 6d, 6,275 per call, 15.4% of all `tool_use`.
 * That is a MEASUREMENT, not a diagnosis. A carry-note is a cold-resume anchor;
 * writing one too SHORT fails worse (and more silently) than writing one too
 * long. Before anyone sets a budget, three things have to be known:
 *
 *   1. the SHAPE of the distribution — a mean of 6,275 is consistent with both
 *      "uniformly 6K" and "a handful of 40K outliers", and the remedy differs;
 *   2. WHICH FIELD carries the bytes — a `did` that has become a log is a
 *      different problem from a `checks` array that legitimately grew;
 *   3. RE-WRITE AMPLIFICATION — 1,267 calls over 6d is many calls per loop. If
 *      a wake re-sends a mostly-unchanged note, the cost is the rewrite
 *      FREQUENCY, not the note size, and the fix is write-on-change: cheaper,
 *      safer, and it costs no recall at all.
 *
 * NOT A SECOND CORPUS: same ROOTS/walk/cutoff as
 * scripts/measure-context-token-baseline.mjs, so totals reconcile with D-017.
 *
 * Usage: node scripts/analyze-loop-checkpoint-notes.mjs [days] [outJsonPath]
 */
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const DAYS = Number(process.argv[2] || 6);
const OUT = process.argv[3] || '/tmp/loop-checkpoint-notes.json';
const CUTOFF = Date.now() - DAYS * 86400_000;
const ROOTS = [join(homedir(), '.claude', 'projects'), join(homedir(), '.papercusp', 'session-claude')];

/** The tool as it appears in a transcript, whichever client wrote it. */
const IS_CHECKPOINT = (name) => typeof name === 'string' && /loop[_:]checkpoint$/.test(name);
/** Authored fields, in the order the tool documents them. */
const FIELDS = ['did', 'left', 'insight', 'next', 'note', 'walls', 'checks', 'harness', 'ownerId'];

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

const chars = (v) => (v == null ? 0 : typeof v === 'string' ? v.length : JSON.stringify(v).length);
/** Stable text for a field, so consecutive calls are comparable byte-for-byte. */
const asText = (v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));

/**
 * RESTATEMENT: how many chars of `cur` appear as a VERBATIM line (or JSON row)
 * that was already in `prev`. Prefix/suffix comparison is blind to this — the
 * normal edit prepends new material, so a note that is 90% carried-over text
 * reads as ~0% unchanged to a prefix/suffix measure while being almost entirely
 * a re-send. This is the measure that can actually see the thing agents call
 * "dropping restatement".
 */
function restatedChars(prev, cur) {
  if (!cur) return 0;
  const split = (s) => {
    const t = s.trim();
    if (t.startsWith('[') || t.startsWith('{')) {
      try {
        const v = JSON.parse(t);
        if (Array.isArray(v)) return v.map((r) => JSON.stringify(r));
      } catch {
        /* fall through to line split */
      }
    }
    return s.split('\n');
  };
  const seen = new Set(split(prev).map((l) => l.trim()).filter((l) => l.length > 0));
  let n = 0;
  for (const line of split(cur)) {
    const key = line.trim();
    if (key.length > 0 && seen.has(key)) n += line.length;
  }
  return n;
}

/** How many leading/trailing chars two strings share — cheap, no diff library. */
function unchangedChars(a, b) {
  if (a === b) return a.length;
  const n = Math.min(a.length, b.length);
  let pre = 0;
  while (pre < n && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (suf < n - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1;
  return pre + suf;
}

/** Calls in transcript order, per session file. */
const bySession = new Map();
let files = 0;
let calls = 0;
let totalChars = 0;
const fieldTotals = new Map(FIELDS.map((f) => [f, { chars: 0, present: 0 }]));

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
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      if (!line.includes('checkpoint')) continue; // cheap prefilter
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const content = rec?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (!b || b.type !== 'tool_use' || !IS_CHECKPOINT(b.name)) continue;
        const input = b.input && typeof b.input === 'object' ? b.input : {};
        const total = chars(input);
        calls += 1;
        totalChars += total;
        const perField = {};
        for (const f of FIELDS) {
          const c = chars(input[f]);
          perField[f] = c;
          if (c > 0) {
            const t = fieldTotals.get(f);
            t.chars += c;
            t.present += 1;
          }
        }
        const key = file;
        if (!bySession.has(key)) bySession.set(key, []);
        bySession.get(key).push({ total, perField, text: Object.fromEntries(FIELDS.map((f) => [f, asText(input[f])])) });
      }
    }
  }
}

const sizes = [...bySession.values()].flat().map((c) => c.total).sort((a, b) => a - b);
const pct = (p) => (sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(p * sizes.length))] : 0);

// Re-write amplification: for each consecutive pair in the same session, how
// many of the chars re-sent were byte-identical to the immediately preceding
// call's same field. This is the "did we pay to re-send text nobody changed"
// number, and it is the one that decides whether the lever is size or frequency.
let pairs = 0;
let resentChars = 0;
let resentUnchanged = 0;
let identicalCalls = 0;
const perFieldResend = new Map(FIELDS.map((f) => [f, { resent: 0, unchanged: 0, identicalPairs: 0, identicalChars: 0, pairsWithField: 0, restated: 0 }]));
for (const seq of bySession.values()) {
  for (let i = 1; i < seq.length; i += 1) {
    pairs += 1;
    let allSame = true;
    for (const f of FIELDS) {
      const prev = seq[i - 1].text[f];
      const cur = seq[i].text[f];
      if (!cur) continue;
      const u = unchangedChars(prev, cur);
      resentChars += cur.length;
      resentUnchanged += u;
      const r = perFieldResend.get(f);
      r.resent += cur.length;
      r.unchanged += u;
      r.pairsWithField += 1;
      r.restated += restatedChars(prev, cur);
      // BYTE-IDENTICAL re-send. For `checks`/`walls` this is not merely
      // redundant, it is AVOIDABLE BY CONTRACT: the tool carries those rows
      // forward when the field is OMITTED, so an identical re-send is a field
      // that never needed to be on the wire.
      if (prev === cur) {
        r.identicalPairs += 1;
        r.identicalChars += cur.length;
      } else {
        allSame = false;
      }
    }
    if (allSame) identicalCalls += 1;
  }
}

const summary = {
  measuredAt: new Date().toISOString(),
  windowDays: DAYS,
  method: 'raw claude transcript JSONL, loop:checkpoint tool_use inputs; same ROOTS/cutoff as measure-context-token-baseline.mjs',
  files,
  calls,
  totalChars,
  meanChars: calls ? Math.round(totalChars / calls) : 0,
  distribution: { min: sizes[0] || 0, p10: pct(0.1), p25: pct(0.25), p50: pct(0.5), p75: pct(0.75), p90: pct(0.9), p99: pct(0.99), max: sizes[sizes.length - 1] || 0 },
  sessions: bySession.size,
  callsPerSession: bySession.size ? +(calls / bySession.size).toFixed(1) : 0,
  byField: FIELDS.map((f) => ({
    field: f,
    chars: fieldTotals.get(f).chars,
    pctOfTotal: totalChars ? +((100 * fieldTotals.get(f).chars) / totalChars).toFixed(2) : 0,
    presentInCalls: fieldTotals.get(f).present,
    avgWhenPresent: fieldTotals.get(f).present ? Math.round(fieldTotals.get(f).chars / fieldTotals.get(f).present) : 0,
  })).sort((a, b) => b.chars - a.chars),
  rewriteAmplification: {
    consecutivePairs: pairs,
    byteIdenticalRewrites: identicalCalls,
    resentChars,
    resentUnchangedChars: resentUnchanged,
    pctOfResentThatWasUnchanged: resentChars ? +((100 * resentUnchanged) / resentChars).toFixed(2) : 0,
    byField: FIELDS.map((f) => ({
      field: f,
      resent: perFieldResend.get(f).resent,
      unchanged: perFieldResend.get(f).unchanged,
      pctUnchanged: perFieldResend.get(f).resent ? +((100 * perFieldResend.get(f).unchanged) / perFieldResend.get(f).resent).toFixed(2) : 0,
      pairsWithField: perFieldResend.get(f).pairsWithField,
      identicalPairs: perFieldResend.get(f).identicalPairs,
      identicalChars: perFieldResend.get(f).identicalChars,
      restatedChars: perFieldResend.get(f).restated,
      pctRestated: perFieldResend.get(f).resent ? +((100 * perFieldResend.get(f).restated) / perFieldResend.get(f).resent).toFixed(2) : 0,
      pctPairsByteIdentical: perFieldResend.get(f).pairsWithField
        ? +((100 * perFieldResend.get(f).identicalPairs) / perFieldResend.get(f).pairsWithField).toFixed(2)
        : 0,
    })).filter((r) => r.resent > 0).sort((a, b) => b.restatedChars - a.restatedChars),
  },
};

await writeFile(OUT, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
