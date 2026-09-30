/**
 * File-index cap probe (memory-backend-benchmark-2026-06-05 P-010, D-004).
 *
 * The claude-file backend itself searches TOPIC FILES and never reads
 * `MEMORY.md` — but the real consumption path at session start is the
 * INDEX, an auto-generated projection (`~/.claude/scripts/memory-compact.mjs`,
 * plans fix-claude-code-memory-2026-06-05 + memory-backend-improve-and-hybrid
 * P-010) with a HARD ~24.4 KB cap (past it Claude silently drops the tail) and
 * a 20 KB soft cap. The projector keeps the index under the cap by TWO
 * mechanisms with different recall consequences:
 *   - **Archiving** — `project` topic files that read like derivable state are
 *     moved to `archive/` (stale >30d, or oldest-first to fit the soft cap).
 *     These LEAVE the backend's searchable store (collect() skips archive/).
 *   - **Tiering (P-010)** — the surviving durable set that still overflows the
 *     always-loaded budget is split: `user` + the newest durables stay in
 *     MEMORY.md, the rest page to `MEMORY-overflow.md`. Tiered entries are NOT
 *     archived — the topic file stays put and STAYS SEARCHABLE. This replaced
 *     the old abort-and-leave-a-stale-index failure (silent memory loss).
 *
 * Two distinct cap consequences this probe records per store size:
 *   1. **Session-start visibility** — only the always-loaded (kept) entries are
 *      visible to a booting agent; tiered + searchable-but-unlisted entries
 *      exist but load on demand.
 *   2. **Post-compaction searchability** — only ARCHIVED files leave the
 *      searchable store; tiering does not shrink recall. So
 *      `searchableAfterCompaction` = indexed + tiered (everything not archived).
 *
 * The simulation mirrors the projector's math exactly (constants, entry line
 * format, section order, eviction passes, the tier split + overflow note).
 * Fidelity is pinned by an integration test that runs the REAL script
 * (`--dry-run`) over the same store and compares the always-loaded count + KB.
 * The probe seeds temp-dir stores through the seam (D-009 — the live `~/.claude`
 * store is never written).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  classifyGovernedTestProcessOutcome,
  runGovernedTestProcess,
} from '../../../../../scripts/lib/governed-test-process.mjs';

import { collectChildOutput } from '../../child-output.js';
import { ClaudeFileMemoryBackend, parseTopicFile } from '@papercusp/memory';
import { generateSyntheticCorpus, seedCorpus, type CorpusEntry } from '@papercusp/memory/bench';

// ---- constants mirrored from memory-compact.mjs (defaults, no env) ---------

export const HARD_CAP_KB = 24.4;
export const SOFT_CAP_KB = 20;
export const MAX_ENTRY_CHARS = 140;
const STALE_DAYS = 30;
const DURABLE_TYPES = new Set(['user', 'feedback', 'reference']);
const KNOWN_TYPES = new Set(['user', 'feedback', 'reference', 'project']);
const SECTION_ORDER: ReadonlyArray<readonly [string, string]> = [
  ['user', 'User'],
  ['feedback', 'Feedback'],
  ['reference', 'Reference'],
  // (skills section omitted — bench temp stores have no skills/)
  ['project', 'Projects'],
];

export const DEFAULT_PROJECTOR_SCRIPT = path.join(os.homedir(), '.claude', 'scripts', 'memory-compact.mjs');

// ---- projection entries (the projector's view of a topic file) -------------

export interface ProjectionEntry {
  file: string;
  name: string;
  /** The picked index hook (frontmatter description or body fallback). */
  description: string;
  type: string;
  mtimeMs: number;
  /** Body text (dedup hashing + weak-description fallback source). */
  body: string;
}

/** Mirror of the projector's weak-description fallback (pickHook). */
const WEAK_DESC_LEN = 40;
export function pickHook(description: string, body: string): string {
  if (description && description.length >= WEAK_DESC_LEN) return description;
  const bodyHook = firstBodyHook(body);
  if (bodyHook.length > (description || '').length) return bodyHook;
  return description || '';
}

function firstBodyHook(body: string): string {
  if (!body) return '';
  const line = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && !l.startsWith('---'));
  return line ? stripMarkdown(line) : '';
}

function stripMarkdown(s: string): string {
  return s
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Read a memory dir into projection entries (read-only, projector-shaped). */
export function collectProjectionEntries(memoryDir: string): ProjectionEntry[] {
  const out: ProjectionEntry[] = [];
  for (const d of fs.readdirSync(memoryDir, { withFileTypes: true })) {
    if (!d.isFile() || !d.name.endsWith('.md') || d.name === 'MEMORY.md') continue;
    const full = path.join(memoryDir, d.name);
    let text: string;
    let stat: fs.Stats;
    try {
      text = fs.readFileSync(full, 'utf8');
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    const tf = parseTopicFile(text);
    const type = KNOWN_TYPES.has(tf.type) ? tf.type : 'project';
    out.push({
      file: d.name,
      name: tf.name || d.name.replace(/\.md$/, ''),
      description: pickHook(tf.description, tf.body),
      type,
      mtimeMs: stat.mtimeMs,
      body: tf.body,
    });
  }
  return out;
}

// ---- the projector's render + eviction math, mirrored ----------------------

function truncate(s: string): string {
  if (!s) return '';
  if (s.length <= MAX_ENTRY_CHARS) return s;
  return s.slice(0, MAX_ENTRY_CHARS - 1).trimEnd() + '…';
}

/** Bytes of one rendered index line — mirror of the projector's entrySize. */
function entrySize(e: ProjectionEntry): number {
  return ('- [' + e.name + '](' + e.file + ') — ' + truncate(e.description) + '\n').length;
}

const PLAN_SLUG_RE = /\b[a-z0-9]+(?:-[a-z0-9]+)*-20\d\d-\d\d-\d\d\b/;
function derivableSignalCount(text: string): number {
  if (!text) return 0;
  const signals = [
    /\bsu-[0-9a-f]{4,}\b/i,
    /\b(DONE|SHIPPED|BUILT|LANDED|COMPLETE|MERGED|FIXED|TESTED)\b/i,
    /\bmig(ration)?\s*\d{2,}\b/i,
    /\b20\d\d-\d\d-\d\d\b/,
    PLAN_SLUG_RE,
    /\b(F-\d|WI-\d|D-\d{2,}|P-\d{2,})/,
    /\b\d+\s*(tests?|specs?)\b/i,
  ];
  return signals.filter((re) => re.test(text)).length;
}

function isEvictable(e: ProjectionEntry): boolean {
  return e.type === 'project' && derivableSignalCount(e.description) >= 2;
}

function render(active: ProjectionEntry[], note = ''): string {
  const groups = new Map<string, ProjectionEntry[]>();
  for (const e of active) {
    if (!groups.has(e.type)) groups.set(e.type, []);
    groups.get(e.type)!.push(e);
  }
  for (const list of groups.values()) list.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push('# Memory Index');
  lines.push('');
  lines.push('<!-- AUTO-GENERATED by ~/.claude/scripts/memory-compact.mjs — DO NOT EDIT BY HAND.');
  lines.push('     This index is a projection of the topic files in this directory (the source of');
  lines.push('     truth). Edit the topic files; the index is regenerated terse + capped at each');
  lines.push('     session start. Stale/overflow memories move to archive/ (recoverable), never');
  lines.push(`     deleted. Last compacted: ${today}. Plan: fix-claude-code-memory-2026-06-05. -->`);
  lines.push('');
  for (const [type, heading] of SECTION_ORDER) {
    const list = groups.get(type);
    if (!list || !list.length) continue;
    lines.push(`## ${heading}`);
    for (const e of list) lines.push(`- [${e.name}](${e.file}) — ${truncate(e.description)}`);
    lines.push('');
  }
  if (note) lines.push(note);
  return lines.join('\n').replace(/\n+$/, '\n');
}

function renderSize(active: ProjectionEntry[]): number {
  return Buffer.byteLength(render(active), 'utf8');
}

// ---- tiering (mirror of memory-compact.mjs tierForCap / overflowNote) -------
// Post-eviction, the durable set can still exceed the always-loaded cap. Rather
// than abort + leave a stale index (the OLD silent-loss failure), the projector
// TIERS: keep `user` + the most-recent durables that fit a byte budget in
// MEMORY.md, and page the rest to MEMORY-overflow.md — reachable on demand and
// STILL searchable (the topic file is untouched). No fact is lost.
const OVERFLOW_FILE = 'MEMORY-overflow.md';

function tierForCap(active: ProjectionEntry[]): { keep: ProjectionEntry[]; tiered: ProjectionEntry[] } {
  const reserve = 1200 + renderSize([]); // header + (empty) skills + pointer block
  const budget = Math.max(4096, SOFT_CAP_KB * 1024 - reserve);
  const userEntries = active.filter((e) => e.type === 'user');
  const rest = active.filter((e) => e.type !== 'user').sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep = [...userEntries];
  let used = userEntries.reduce((s, e) => s + entrySize(e), 0);
  const tiered: ProjectionEntry[] = [];
  for (const e of rest) {
    const sz = entrySize(e);
    if (used + sz <= budget) { keep.push(e); used += sz; } else tiered.push(e);
  }
  return { keep, tiered };
}

function overflowNote(tiered: ProjectionEntry[]): string {
  if (!tiered.length) return '';
  const counts = tiered.reduce<Record<string, number>>((m, e) => ((m[e.type] = (m[e.type] || 0) + 1), m), {});
  const breakdown = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
  return `## More memories (load on demand)\n\n` +
    `${tiered.length} older memories (${breakdown}) did not fit the always-loaded cap and are in ` +
    `[${OVERFLOW_FILE}](${OVERFLOW_FILE}) — read that file (or grep the topic files in this dir) when you ` +
    `need a fact not listed above. The newest memories are kept above; only older ones page out.\n`;
}

export interface IndexProjectionResult {
  /** Topic files present in the store (post exact-dup dedup). */
  totalFiles: number;
  /**
   * Entries in the always-loaded MEMORY.md — what a booting agent sees at
   * session start (the projector's `always-loaded` count = tierForCap's keep).
   */
  indexed: number;
  /** Entries paged to MEMORY-overflow.md — on-demand, but STILL searchable. */
  tiered: number;
  /** Rendered MEMORY.md size (keep + overflow pointer), kept under the cap. */
  indexBytes: number;
  /** Eviction tallies — these files ARE physically archived by a real run. */
  archivedStale: number;
  archivedOverflow: number;
  /** Durable entries in the always-loaded MEMORY.md (keep). */
  durableIndexed: number;
  projectIndexed: number;
  /**
   * Durable entries still searchable after compaction — durables are NEVER
   * archived (only tiered), so this is every durable in the deduped store.
   * The P-010 invariant: durable recall is lossless regardless of store size.
   */
  durableSearchable: number;
  /** The untiered active set exceeded the soft cap → tiering kicked in. */
  overSoftCap: boolean;
  /** Even MEMORY.md (post-tiering) exceeds the hard cap — should never happen. */
  overHardCap: boolean;
  /** Fraction of the (deduped) store visible from the session-start index. */
  indexedFraction: number;
  /**
   * Files still SEARCHABLE after a real (non-dry-run) compaction pass. Tiering
   * (unlike archiving) leaves the topic file in place, so this is the active
   * set = indexed + tiered; only stale/overflow/dup ARCHIVE out of recall.
   * The whole point of P-010: tiering bounds session-start VISIBILITY without
   * bounding RECALL.
   */
  searchableAfterCompaction: number;
}

/** Pure mirror of the projector's dedup → evict → tier → render pipeline. */
export function simulateIndexProjection(
  entries: readonly ProjectionEntry[],
  nowMs: number = Date.now(),
): IndexProjectionResult {
  // Exact-dup dedup (projector archives byte-identical bodies, keeps newest).
  // Bench stores have unique bodies; mirrored for fidelity on real stores.
  const byBody = new Map<string, ProjectionEntry>();
  for (const e of entries) {
    const prev = byBody.get(e.body);
    if (!prev || e.mtimeMs > prev.mtimeMs) byBody.set(e.body, e);
  }
  const deduped = [...byBody.values()];

  // (a) STALE: derivable project memories older than STALE_DAYS → archived.
  const stale: ProjectionEntry[] = [];
  let active: ProjectionEntry[] = [];
  for (const e of deduped) {
    const ageDays = (nowMs - e.mtimeMs) / 86400000;
    if (isEvictable(e) && ageDays > STALE_DAYS) stale.push(e);
    else active.push(e);
  }

  const softCapBytes = SOFT_CAP_KB * 1024;
  const overflow: ProjectionEntry[] = [];
  const evict = (victim: ProjectionEntry) => {
    overflow.push(victim);
    active = active.filter((e) => e !== victim);
  };
  // (b) overflow pass 1: derivable project memories, oldest first → archived.
  const evictable = active.filter(isEvictable).sort((a, b) => a.mtimeMs - b.mtimeMs);
  let i = 0;
  while (renderSize(active) > softCapBytes && i < evictable.length) evict(evictable[i++]);
  // (c) overflow pass 2 (safety valve): any remaining project memory → archived.
  const fallback = active.filter((e) => e.type === 'project').sort((a, b) => a.mtimeMs - b.mtimeMs);
  let j = 0;
  while (renderSize(active) > softCapBytes && j < fallback.length) evict(fallback[j++]);

  // (d) TIER: the protected/active set that survives archiving is split into the
  // always-loaded MEMORY.md (keep) and the on-demand MEMORY-overflow.md (tiered).
  // Tiered entries are NOT archived — they stay in their topic file + searchable.
  const untieredBytes = renderSize(active);
  const { keep, tiered } = tierForCap(active);
  const indexBytes = Buffer.byteLength(render(keep, overflowNote(tiered)), 'utf8');
  return {
    totalFiles: deduped.length,
    indexed: keep.length,
    tiered: tiered.length,
    indexBytes,
    archivedStale: stale.length,
    archivedOverflow: overflow.length,
    durableIndexed: keep.filter((e) => DURABLE_TYPES.has(e.type)).length,
    projectIndexed: keep.filter((e) => e.type === 'project').length,
    durableSearchable: active.filter((e) => DURABLE_TYPES.has(e.type)).length,
    overSoftCap: untieredBytes > softCapBytes,
    overHardCap: indexBytes > HARD_CAP_KB * 1024,
    indexedFraction: deduped.length === 0 ? 1 : keep.length / deduped.length,
    searchableAfterCompaction: active.length,
  };
}

// ---- the real projector (cross-validation + opportunistic recording) -------

/**
 * Run the actual memory-compact.mjs in --dry-run over a store and parse its
 * report (`always-loaded: N of M`, `index size: X KB`). `indexed` is the
 * always-loaded count (tierForCap's keep). Returns null when the script is
 * missing or its output doesn't parse (CI boxes without ~/.claude).
 */
export interface GovernedProjectorRunOptions {
  /** Test seam; production uses the durable process governor. */
  governedProcess?: typeof runGovernedTestProcess;
  workspaceId?: string;
  owner?: string;
}

/** Keep the canonical helper call explicit for source-level enforcement audits. */
const defaultGovernedProjectorProcess: typeof runGovernedTestProcess = (...args) =>
  runGovernedTestProcess(...args);

/**
 * Run the real projector behind one durable process receipt.  The old sync
 * spawn made this benchmark invisible to the capless governor and could pile
 * CPU/disk pressure on the host while a fleet was already probing memory.
 * Keeping the receipt open until the child exits also makes cancellation and
 * actual-demand settlement truthful.
 */
export async function runRealProjectorDryRun(
  memoryDir: string,
  scriptPath: string = DEFAULT_PROJECTOR_SCRIPT,
  options: GovernedProjectorRunOptions = {},
): Promise<{ indexed: number; indexKb: number } | null> {
  if (!fs.existsSync(scriptPath)) return null;
  const governedProcess = options.governedProcess ?? defaultGovernedProjectorProcess;
  const r = await governedProcess(
    {
      workspaceId: options.workspaceId,
      namespace: 'memory-index-projector',
      owner: options.owner ?? 'memory-index-cap',
      admissionClass: 'embedding',
      demand: { cpuWeight: 1, memoryBytes: 64 * 1024 * 1024, diskBytes: 1 },
      timeoutMs: 120_000,
      env: {
        ...process.env,
        MEMORY_SOFT_CAP_KB: '',
        MEMORY_STALE_DAYS: '',
        MEMORY_MAX_ENTRY_CHARS: '',
      },
    },
    // `scripts/lib/governed-test-process.d.mts` declares the runner as
    // `run: any`, so this callback inherits NO contextual parameter types and
    // both params land as implicit `any` under noImplicitAny. Annotate them at
    // the consumer: with an `any` seam there is no inference to defer to, and
    // `childEnv` is load-bearing — it is what gets handed to `spawn`.
    async (_context: unknown, childEnv: NodeJS.ProcessEnv) =>
      await new Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          const child = spawn(process.execPath, [scriptPath, '--dry-run', '--memory-dir', memoryDir], {
            env: childEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          // `String(chunk)` per `data` event decodes each Buffer independently, so a
          // multi-byte character split across two chunks becomes replacement chars with
          // no error raised. This projector's OWN output is what gets regex-scanned for
          // `always-loaded:` / `index size:` below, and the dry-run prints a `⚠` — so
          // the corruption lands directly on the parse. collectChildOutput decodes with
          // one boundary-safe StringDecoder per stream; `text()` is the TERMINAL read
          // (close handler), which is where flushing the held-back bytes is correct.
          const out = collectChildOutput(child);
          child.once('error', reject);
          child.once('close', (code, signal) =>
            resolve({ stdout: out.stdout.text(), stderr: out.stderr.text(), code, signal }),
          );
        },
      ),
  );
  if (!r || typeof r !== 'object') return null;
  const outcome = r as { stdout?: string; stderr?: string; code?: number | null; signal?: NodeJS.Signals | null; error?: unknown };
  const settlement = classifyGovernedTestProcessOutcome({
    output: `${outcome.stdout ?? ''}\n${outcome.stderr ?? ''}`,
    code: outcome.code,
    signal: outcome.signal,
    error: outcome.error,
  });
  if (settlement.kind === 'cancel') return null;
  // P-010 tiering report: `always-loaded: <keep> of <active>`.
  const indexed = /always-loaded:\s*(\d+)\s+of\s+\d+/.exec(outcome.stderr ?? '');
  const sizeKb = /index size:\s*([\d.]+) KB/.exec(outcome.stderr ?? '');
  if (!indexed || !sizeKb) return null;
  return { indexed: Number(indexed[1]), indexKb: Number(sizeKb[1]) };
}

// ---- the probe --------------------------------------------------------------

export interface IndexCapPoint extends IndexProjectionResult {
  /** Total store size this point was measured at (real corpus + synthetic). */
  size: number;
  /** The real script's numbers for the same store, when available. */
  realProjector?: { indexed: number; indexKb: number };
}

export interface IndexCapReport {
  corpusSize: number;
  sizes: number[];
  points: IndexCapPoint[];
  notes: string[];
  markdown: string;
}

export interface IndexCapProbeOptions {
  /** Frozen real corpus (the 111-store baseline). */
  corpus: readonly CorpusEntry[];
  /** TOTAL store sizes beyond the corpus baseline (e.g. [1000, 10000]). */
  sizes: number[];
  syntheticSeed?: number;
  /** Path to memory-compact.mjs; null = skip the real-script cross-record. */
  projectorScript?: string | null;
  log?: (msg: string) => void;
}

/**
 * Seed temp-dir stores at corpus → each size (cumulative, like the bench's
 * scale tier) and record the index projection behavior at every point.
 */
export async function probeIndexCap(opts: IndexCapProbeOptions): Promise<IndexCapReport> {
  const log = opts.log ?? (() => {});
  const seed = opts.syntheticSeed ?? 1337;
  const scriptPath = opts.projectorScript === null ? null : (opts.projectorScript ?? DEFAULT_PROJECTOR_SCRIPT);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-index-cap-'));
  const backend = new ClaudeFileMemoryBackend({ memoryDir: dir, createIfMissing: true });
  const points: IndexCapPoint[] = [];
  try {
    log(`seeding the ${opts.corpus.length}-entry real corpus…`);
    await seedCorpus(backend, opts.corpus, { scope: 'bench', concurrency: 16 });

    let current = opts.corpus.length;
    const targets = [current, ...[...opts.sizes].sort((a, b) => a - b).filter((s) => s > current)];
    for (const target of targets) {
      const delta = target - current;
      if (delta > 0) {
        log(`seeding ${delta} synthetic distractors → ${target}…`);
        const synthetic = generateSyntheticCorpus(delta, seed + current);
        await seedCorpus(backend, synthetic, { scope: 'bench', concurrency: 16 });
        current = target;
      }
      log(`projecting @${target}…`);
      const sim = simulateIndexProjection(collectProjectionEntries(dir));
      const real = scriptPath ? await runRealProjectorDryRun(dir, scriptPath) : null;
      points.push({ size: target, ...sim, ...(real ? { realProjector: real } : {}) });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const notes = buildCapNotes(points);
  return {
    corpusSize: opts.corpus.length,
    sizes: points.map((p) => p.size),
    points,
    notes,
    markdown: renderIndexCapMarkdown(points, notes),
  };
}

function buildCapNotes(points: readonly IndexCapPoint[]): string[] {
  const notes: string[] = [
    `index caps (memory-compact.mjs defaults): soft ${SOFT_CAP_KB} KB always-loaded, hard ~${HARD_CAP_KB} KB (native Claude limit).`,
    'two distinct shedding mechanisms (P-010): (1) project memories that read like derivable state are PHYSICALLY ARCHIVED (stale >30d, or oldest-first to fit the soft cap) — these LEAVE the searchable store; (2) the surviving durable set that still overflows the always-loaded budget is TIERED to MEMORY-overflow.md — reachable on demand and STILL searchable (the topic file is untouched).',
    'durable types (user/feedback/reference) are never archived; the `user` section is always-loaded, other durables tier (newest-first) only when over budget. So tiering bounds session-start VISIBILITY, not RECALL.',
  ];
  const worst = points[points.length - 1];
  if (worst && worst.tiered > 0) {
    notes.push(
      `at ${worst.size} entries ${worst.indexed} are always-loaded and ${worst.tiered} are tiered to ${OVERFLOW_FILE} (still searchable); ` +
        `${worst.archivedOverflow + worst.archivedStale} project memories would be archived (out of recall) by one compaction pass.`,
    );
  }
  if (points.some((p) => p.overSoftCap)) {
    notes.push(
      'the active set exceeds the soft cap at some sizes — the projector tiers the durable overflow to the on-demand index (no abort, no stale index, no lost facts; the real store already hit this once).',
    );
  }
  if (points.some((p) => p.overHardCap)) {
    notes.push(
      'MEMORY.md STILL over the hard cap after tiering at some sizes — the belt-and-suspenders abort guard fires; this should not happen since the tier budget is below the soft cap.',
    );
  }
  return notes;
}

/** One markdown table over the probe points (folds into the bench report). */
export function renderIndexCapMarkdown(points: readonly IndexCapPoint[], notes: readonly string[]): string {
  const lines: string[] = [];
  lines.push('| store size | always-loaded | tiered (searchable) | index KB | loaded % | archived (out of recall) | over soft cap | real projector |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const p of points) {
    lines.push(
      `| ${p.size} | ${p.indexed} (${p.durableIndexed} durable + ${p.projectIndexed} project) | ${p.tiered} | ${(p.indexBytes / 1024).toFixed(1)} | ` +
        `${(p.indexedFraction * 100).toFixed(1)}% | ${p.archivedOverflow + p.archivedStale} | ${p.overSoftCap ? 'YES' : 'no'} | ` +
        `${p.realProjector ? `${p.realProjector.indexed} @ ${p.realProjector.indexKb} KB` : '—'} |`,
    );
  }
  lines.push('');
  for (const n of notes) lines.push(`- ${n}`);
  return lines.join('\n');
}
