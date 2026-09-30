#!/usr/bin/env node
/**
 * P-004 (plan agent-context-firewall-and-output-spill-2026-08-02) — the
 * tokens-into-context baseline this plan is judged on, decomposed by source.
 *
 * WHY NOT `harness_shared.session_turn_parts`: that table is the obvious
 * candidate (it already carries speaker/part_kind/tool_name/text) and it is
 * WRONG for this measurement — `session-ingest.ts:97` caps every part at
 * `PART_TEXT_CAP = 2000` chars. The cap is deliberate and correct for its own
 * purpose (faithful RENDER of recent sessions), but it clips exactly the
 * category this plan is about: the ingester's own comment measures tool_result
 * at 218 MB raw against text's 21 MB over 7 days, and says capping at 2k
 * "recovers 61% of it". A decomposition read off that table understates
 * tool_result by roughly an order of magnitude while looking entirely
 * plausible. This script therefore reads the RAW transcript JSONL — the exact
 * bytes the model saw.
 *
 * NOT A SECOND CORPUS: the sibling plan
 * `bash-substitution-reachable-ceiling-2026-08-01` extracts Bash `tool_use`
 * blocks from these same transcripts (`bash-substitution/corpus.ts`). This is a
 * second EXTRACT of the same corpus, not a second corpus — it reads the same
 * files and adds no new collection path.
 *
 * Usage: node scripts/measure-context-token-baseline.mjs [days] [outJsonPath]
 */
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const DAYS = Number(process.argv[2] || 6);
const OUT = process.argv[3] || '/tmp/context-token-baseline.json';
const CUTOFF = Date.now() - DAYS * 86400_000;
const ROOTS = [join(homedir(), '.claude', 'projects'), join(homedir(), '.papercusp', 'session-claude')];
/** chars→tokens estimate. Labelled everywhere it is used; never presented as a count. */
const CPT = 4;

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

/** Length of a tool_result's content, which may be a string or a block array. */
function resultChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return content == null ? 0 : JSON.stringify(content).length;
  let n = 0;
  for (const b of content) {
    if (typeof b === 'string') n += b.length;
    else if (b && typeof b.text === 'string') n += b.text.length;
    else if (b) n += JSON.stringify(b).length;
  }
  return n;
}

/** P-011: the doored-result population, bucketed by the shape the D-012 footer branches on. */
const doorFooters = { total: 0, json: 0, 'multi-line-text': 0, 'single-line-text': 0 };
/** Concatenated text of a tool_result's block array (the string case is handled inline). */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : '')).join('\n');
}

const byKind = new Map(); // kind -> {chars, blocks}
const byTool = new Map(); // tool -> {useChars, resultChars, calls, results}
const perSession = []; // {file, chars}
const byInjector = new Map(); // injector -> {chars, blocks, host:*}
const injected = { chars: 0, blocks: 0, hostResidual: 0 };

/**
 * The papercusp-authored markers that open an injected span, injector -> marker.
 *
 * These are the ONLY handle available: injected context is spliced into ordinary
 * `text` and `tool_result` blocks, so nothing in the transcript's own structure
 * distinguishes it from the human's prose or a tool's real output.
 *
 * ⚠ THIS TABLE GOES STALE SILENTLY. Renaming a header in the injection path
 * stops it matching here with no error — the bytes then land in the reported
 * unattributed remainder instead of disappearing, which is why that remainder
 * is printed as a first-class number rather than dropped.
 */
const INJECT_MARKERS = [
  ['related-context', '### Related context (pointers'],
  ['related-context', '## Related context (pointers'],
  ['mem0-recall', '## Relevant memory'],
  ['mem0-recall', '## Possibly relevant'],
  ['hook-additional-context', 'hook additional context'],
  ['system-reminder', '<system-reminder>'],
  ['turn-provenance', '⟦turn-provenance⟧'],
  ['ctrl-transition', '⟦CTRL:transition⟧'],
  ['coord-delta', '[coord+'],
  ['presence-roster', '[presence ⟲'],
];
let files = 0;
let lines = 0;
let badLines = 0;

function bump(map, key, field, n) {
  let row = map.get(key);
  if (!row) map.set(key, (row = {}));
  row[field] = (row[field] || 0) + n;
}

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
    const idToName = new Map();
    let sessionChars = 0;
    /**
     * Attribute the papercusp-INJECTED slice of a block's text to its injector.
     *
     * Each marker opens a block that runs to the next blank-line-separated
     * marker or to end-of-text, so the injected span is measured from its
     * marker to the next one rather than assumed to be the whole block — the
     * human's own prose frequently sits in the SAME text block, and charging
     * their sentence to the injector would overstate exactly what we are here
     * to measure.
     *
     * ⚠ REPORTS ITS OWN COVERAGE. Marker matching is a heuristic over authored
     * strings: a renamed header silently stops matching and its bytes migrate
     * into `injectedUnattributed` rather than vanishing. That counter is the
     * falsifier — if it grows, the marker table is stale, and a share computed
     * without reading it is a share computed over an unknown population.
     */
    // eslint-disable-next-line no-inner-declarations
    function attributeInjected(text, host) {
      const hits = [];
      for (const [injector, marker] of INJECT_MARKERS) {
        let from = 0;
        for (;;) {
          const at = text.indexOf(marker, from);
          if (at < 0) break;
          hits.push({ at, injector });
          from = at + marker.length;
        }
      }
      if (!hits.length) return;
      hits.sort((x, y) => x.at - y.at);
      let injectedTotal = 0;
      for (let i = 0; i < hits.length; i += 1) {
        const start = hits[i].at;
        const end = i + 1 < hits.length ? hits[i + 1].at : text.length;
        const span = Math.max(0, end - start);
        injectedTotal += span;
        bump(byInjector, hits[i].injector, 'chars', span);
        bump(byInjector, hits[i].injector, 'blocks', 1);
        bump(byInjector, hits[i].injector, `host:${host}`, span);
      }
      injected.chars += injectedTotal;
      injected.blocks += 1;
      injected[`host:${host}`] = (injected[`host:${host}`] || 0) + injectedTotal;
      // Everything BEFORE the first marker in a block carrying injected content
      // is the genuine non-injected remainder (the human's prose, the tool's
      // real output). Tracked so the injected share always has a denominator.
      injected.hostResidual += hits[0].at;
    }
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      lines += 1;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        badLines += 1;
        continue;
      }
      // ── INJECTED CONTEXT arrives as its OWN record type, not as a content
      // block, and was therefore invisible to this scan entirely (measured on a
      // live transcript: 66 `attachment` records / 91,872 bytes, ~70% of the
      // file's bytes unattributed). Unlike the in-text case these are
      // STRUCTURALLY labelled — `attachment.type === 'hook_additional_context'`
      // with `hookName`/`hookEvent` — so they are attributed from the schema
      // rather than by marker heuristics, and the injector name is exact.
      //
      // These ARE a sibling category here (their own records), so they add to
      // the kind totals rather than slicing them — they are real context bytes
      // that no previous run of this script counted at all.
      if (rec.type === 'attachment') {
        const a = rec.attachment;
        if (!a || typeof a !== 'object') continue;
        const body = Array.isArray(a.content) ? a.content.join('') : typeof a.content === 'string' ? a.content : '';
        const chars = body.length;
        if (!chars) continue;
        const injector = a.hookName || a.hookEvent || a.type || '(unnamed-attachment)';
        bump(byKind, 'injected_context', 'chars', chars);
        bump(byKind, 'injected_context', 'blocks', 1);
        bump(byInjector, String(injector), 'chars', chars);
        bump(byInjector, String(injector), 'blocks', 1);
        bump(byInjector, String(injector), 'host:attachment', chars);
        injected.chars += chars;
        injected.blocks += 1;
        injected['host:attachment'] = (injected['host:attachment'] || 0) + chars;
        sessionChars += chars;
        continue;
      }
      const msg = rec?.message;
      if (!msg || (rec.type !== 'user' && rec.type !== 'assistant')) continue;
      const content = msg.content;
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        let kind = b.type;
        let chars = 0;
        if (kind === 'text') {
          chars = typeof b.text === 'string' ? b.text.length : 0;
          // INJECTED-CONTEXT attribution. Papercusp authors these blocks and
          // splices them into turns, so they are indistinguishable from the
          // human's own prose by BLOCK TYPE — they are `text` like anything
          // else. They are separated here by their own stable authored markers.
          //
          // ⚠ Deliberately measured as a SLICE OF `text`, never as a sibling
          // kind: double-counting it against the kind totals would inflate the
          // denominator every share is computed from.
          if (typeof b.text === 'string' && b.text.length) attributeInjected(b.text, 'text');
        } else if (kind === 'thinking') chars = typeof b.thinking === 'string' ? b.thinking.length : 0;
        else if (kind === 'tool_use') {
          chars = (b.name?.length || 0) + (b.input ? JSON.stringify(b.input).length : 0);
          if (b.id && b.name) idToName.set(b.id, b.name);
          bump(byTool, b.name || '(unnamed)', 'useChars', chars);
          bump(byTool, b.name || '(unnamed)', 'calls', 1);
        } else if (kind === 'tool_result') {
          chars = resultChars(b.content);
          const name = idToName.get(b.tool_use_id) || '(unmatched)';
          bump(byTool, name, 'resultChars', chars);
          bump(byTool, name, 'results', 1);
          // P-011: how many results the door actually cut, and what SHAPE they
          // were — the population the D-012 footer change acts on. Classified
          // from the KEPT head (the transcript holds the doored text, not the
          // original), which is why this is a shape heuristic and is reported
          // as one: leading `{`/`[` after trim, plus the kept head's line count.
          const text = typeof b.content === 'string' ? b.content : resultText(b.content);
          // PostToolUse / PostToolBatch additionalContext rides INSIDE tool
          // results, so the injected slice has to be measured here too — a
          // text-blocks-only pass would miss the per-tool-batch injections
          // entirely, which is the highest-frequency injector we have.
          if (text) attributeInjected(text, 'tool_result');
          const at = text.indexOf('[result-door:');
          if (at >= 0) {
            doorFooters.total += 1;
            const head = text.slice(0, at).trim();
            const jsonish = head.startsWith('{') || head.startsWith('[');
            const oneLine = !head.includes('\n');
            const bucket = jsonish ? 'json' : oneLine ? 'single-line-text' : 'multi-line-text';
            doorFooters[bucket] = (doorFooters[bucket] || 0) + 1;
            bump(byTool, name, 'doored', 1);
          }
        } else {
          kind = `other:${String(kind).slice(0, 24)}`;
          chars = JSON.stringify(b).length;
        }
        bump(byKind, kind, 'chars', chars);
        bump(byKind, kind, 'blocks', 1);
        sessionChars += chars;
      }
    }
    perSession.push({ file: file.slice(-60), chars: sessionChars });
  }
}

const total = [...byKind.values()].reduce((a, r) => a + (r.chars || 0), 0);
const kinds = [...byKind.entries()]
  .map(([kind, r]) => ({
    kind,
    blocks: r.blocks || 0,
    chars: r.chars || 0,
    estTokens: Math.round((r.chars || 0) / CPT),
    pct: total ? +((100 * (r.chars || 0)) / total).toFixed(2) : 0,
  }))
  .sort((a, b) => b.chars - a.chars);
// INJECTED-CONTEXT roll-up. `injected.chars` combines TWO accounting shapes:
// attachment records already counted as the sibling `injected_context` kind,
// plus marker-detected slices that live inside `text` and `tool_result`.
// The roll-up therefore describes all injected bytes, but must never be added
// to the kind totals a second time. Its share uses the same `total` denominator
// as every byKind share.
const injectors = [...byInjector.entries()]
  .map(([injector, r]) => ({
    injector,
    spans: r.blocks || 0,
    chars: r.chars || 0,
    estTokens: Math.round((r.chars || 0) / CPT),
    pctOfAll: total ? +((100 * (r.chars || 0)) / total).toFixed(2) : 0,
    inText: r['host:text'] || 0,
    inToolResult: r['host:tool_result'] || 0,
  }))
  .sort((a, b) => b.chars - a.chars);
// COVERAGE, stated on the aggregate rather than left to the reader: how much of
// the text sharing a block with injected content was NOT claimed by any marker.
// A rising residual means the marker table has drifted from the injectors.
const injectedSummary = {
  chars: injected.chars,
  estTokens: Math.round(injected.chars / CPT),
  pctOfAllContent: total ? +((100 * injected.chars) / total).toFixed(2) : 0,
  blocksCarryingInjection: injected.blocks,
  attachmentChars: injected['host:attachment'] || 0,
  inTextChars: injected['host:text'] || 0,
  inToolResultChars: injected['host:tool_result'] || 0,
  unattributedHostChars: injected.hostResidual,
  markerCoveragePct: injected.chars + injected.hostResidual
    ? +((100 * injected.chars) / (injected.chars + injected.hostResidual)).toFixed(2)
    : 0,
  caveat:
    'injected.* combines two accounting shapes: attachmentChars is already counted as the sibling ' +
    'byKind injected_context category, while inTextChars + inToolResultChars are slices of those existing kinds. ' +
    'Do not add the combined injected.chars roll-up to the kind totals again. Attachment attribution uses the transcript ' +
    'schema; in-block attribution uses authored marker strings. unattributedHostChars is the non-injected remainder of ' +
    'blocks carrying marker-detected injection, and a rising value means the marker table may have drifted.',
};
const toolResultTotal = [...byTool.values()].reduce((a, r) => a + (r.resultChars || 0), 0);
const toolsTop = [...byTool.entries()]
  .map(([tool, r]) => ({
    tool,
    calls: r.calls || 0,
    results: r.results || 0,
    useChars: r.useChars || 0,
    resultChars: r.resultChars || 0,
    estResultTokens: Math.round((r.resultChars || 0) / CPT),
    pctOfToolResults: toolResultTotal ? +((100 * (r.resultChars || 0)) / toolResultTotal).toFixed(2) : 0,
    avgResultChars: r.results ? Math.round((r.resultChars || 0) / r.results) : 0,
  }))
  .sort((a, b) => b.resultChars - a.resultChars)
  .slice(0, 25);
// WI-7261: `toolsTop` is ranked by resultChars and truncated at 25, so reading
// its `useChars` column for "which tool has the biggest ARGUMENTS" is ranking by
// one quantity and reading for another. A tool with large arguments and small
// results — write a lot, get back a short ack — can be absent from that list
// entirely. tool_use is 25.4% of all context (D-014), so it gets its own ranking
// over the FULL byTool map, never a re-slice of the result-ranked one.
const toolUseTotal = [...byTool.values()].reduce((a, r) => a + (r.useChars || 0), 0);
const toolsTopByUse = [...byTool.entries()]
  .map(([tool, r]) => ({
    tool,
    calls: r.calls || 0,
    useChars: r.useChars || 0,
    estUseTokens: Math.round((r.useChars || 0) / CPT),
    pctOfToolUse: toolUseTotal ? +((100 * (r.useChars || 0)) / toolUseTotal).toFixed(2) : 0,
    avgUseChars: r.calls ? Math.round((r.useChars || 0) / r.calls) : 0,
  }))
  .sort((a, b) => b.useChars - a.useChars)
  .slice(0, 25);
const sessionTokens = perSession.map((s) => s.chars / CPT).sort((a, b) => a - b);
const q = (p) => (sessionTokens.length ? Math.round(sessionTokens[Math.min(sessionTokens.length - 1, Math.floor(p * sessionTokens.length))]) : 0);

const summary = {
  measuredAt: new Date().toISOString(),
  windowDays: DAYS,
  method: 'raw claude transcript JSONL, per content block; chars/4 is an ESTIMATE, not a token count',
  caveat:
    'Counts each block ONCE, as it first entered the window. The BILLED cost is far higher: the whole window is re-sent every turn.',
  files,
  lines,
  badLines,
  totalChars: total,
  totalEstTokens: Math.round(total / CPT),
  perSessionEstTokens: { n: sessionTokens.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: q(1) },
  byKind: kinds,
  injected: injectedSummary,
  byInjector: injectors,
  toolUseTotalChars: toolUseTotal,
  topToolsByResultChars: toolsTop,
  topToolsByUseChars: toolsTopByUse,
  doorFooters,
};
await writeFile(OUT, JSON.stringify({ ...summary, perSession }, null, 2));
console.log(JSON.stringify(summary, null, 2));
