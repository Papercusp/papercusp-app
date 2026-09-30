/**
 * native-compaction-audit — the P-022 (WI-4998) zero-invocation audit.
 *
 * Owner terminal state 2026-07-14: "remove the compact call entirely" — no
 * /compact, no omp native strategies, no provider-side compaction; papercusp
 * carry (builder + respawn/handoff + shake) is the only compaction path. The
 * completion criterion is auditable: ZERO native-summarizer invocations across
 * sessions started after the cutover.
 *
 * A Claude Code native compaction (auto OR manual /compact) writes a
 * `{"type":"system","subtype":"compact_boundary"}` row into the session
 * transcript. Codex writes a top-level `{"type":"compacted"}` rollout event.
 * Both shapes are verified against real transcripts on this box. This module
 * scans the managed Claude and Codex trees for sessions STARTED at/after a
 * cutover instant and counts those rows. A session whose start timestamp cannot
 * be read is included CONSERVATIVELY when its file was modified after the
 * cutover — an unattributable session with native boundaries must surface,
 * never hide.
 *
 * (OMP native strategies are covered separately: the launcher forces the
 * papercusp compaction block into every relocated config — psu-launcher.mjs
 * P-022 leg — and the gateway's `maintenance.carried` vs `.requests` counters
 * expose any LLM-lane serve. This scanner is the Claude-transcript leg.)
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const COMPACT_BOUNDARY_MARKER = '"subtype":"compact_boundary"';
export const CODEX_COMPACTED_EVENT_MARKER = '"type":"compacted"';

export type NativeCompactionBackend = 'claude' | 'codex';

export interface NativeCompactionSessionFinding {
  /** Absolute transcript path. */
  file: string;
  /** Native transcript dialect that emitted the boundary. */
  backend: NativeCompactionBackend;
  /** Parsed start instant of the session (first row timestamp), null when unreadable. */
  sessionStartMs: number | null;
  /** Count of native compact-boundary rows found in the transcript. */
  compactBoundaries: number;
}

export interface NativeCompactionAuditReport {
  /** Transcripts in scope (session started — or conservatively, file modified — at/after sinceMs). */
  scanned: number;
  scannedByBackend: Record<NativeCompactionBackend, number>;
  /** In-scope sessions with ≥1 native compact boundary — MUST be empty for the P-022 verdict. */
  offenders: NativeCompactionSessionFinding[];
  totalBoundaries: number;
  verdict: 'clean' | 'violations';
}

export function defaultClaudeProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

/** Managed Codex rollout roots. The per-session root is the primary su/fleet
 * store; role homes and the global home cover the remaining supported launch
 * surfaces. Callers supplying a custom Claude `root` get no implicit Codex
 * roots so filesystem tests/audits stay hermetic; pass `codexRoots` explicitly. */
export function defaultCodexRolloutRoots(): string[] {
  return [
    join(homedir(), '.papercusp', 'su-codex-homes'),
    join(homedir(), '.papercusp', 'role-codex-homes'),
    join(homedir(), '.codex', 'sessions'),
  ];
}

/** First transcript row's `timestamp` — the session start. Fail-soft null. */
export function firstTimestampMs(text: string): number | null {
  const nl = text.indexOf('\n');
  const first = (nl >= 0 ? text.slice(0, nl) : text).trim();
  if (!first) return null;
  try {
    const row = JSON.parse(first) as { timestamp?: unknown };
    const t = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/** Count native compact-boundary rows. Cheap substring prefilter, then a real
 *  parse so a quoted marker inside message CONTENT can never count as a boundary. */
export function countCompactBoundaries(text: string): number {
  if (!text.includes(COMPACT_BOUNDARY_MARKER)) return 0;
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line.includes(COMPACT_BOUNDARY_MARKER)) continue;
    try {
      const row = JSON.parse(line) as { type?: unknown; subtype?: unknown };
      if (row.type === 'system' && row.subtype === 'compact_boundary') n++;
    } catch {
      /* not a well-formed row — never counted */
    }
  }
  return n;
}

/** Count only REAL top-level Codex compaction events. A copied marker inside a
 * message/replacement_history string cannot trip the audit. */
export function countCodexCompactions(text: string): number {
  if (!text.includes(CODEX_COMPACTED_EVENT_MARKER)) return 0;
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line.includes(CODEX_COMPACTED_EVENT_MARKER)) continue;
    try {
      const row = JSON.parse(line) as { type?: unknown };
      if (row.type === 'compacted') n++;
    } catch {
      /* not a well-formed row — never counted */
    }
  }
  return n;
}

async function jsonlFilesUnder(root: string, maxDepth: number): Promise<string[]> {
  const files: string[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) await visit(p, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(p);
    }
  };
  await visit(root, 0);
  return files;
}

async function auditRoot(
  root: string,
  backend: NativeCompactionBackend,
  sinceMs: number,
  report: NativeCompactionAuditReport,
  seen: Set<string>,
): Promise<void> {
  // Claude: projects/<cwd>/<session>.jsonl. Codex: either
  // su-codex-homes/session-N/sessions/YYYY/MM/DD/rollout*.jsonl or the global
  // sessions/YYYY/MM/DD form. Seven levels covers both without an unbounded walk.
  const maxDepth = backend === 'claude' ? 3 : 7;
  for (const file of await jsonlFilesUnder(root, maxDepth)) {
    if (seen.has(file)) continue;
    if (backend === 'codex' && !file.split('/').at(-1)?.startsWith('rollout-')) continue;
    seen.add(file);
    let mtimeMs = 0;
    try {
      mtimeMs = (await fs.stat(file)).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs < sinceMs) continue;
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const startMs = firstTimestampMs(text);
    if (startMs != null && startMs < sinceMs) continue;
    report.scanned++;
    report.scannedByBackend[backend]++;
    const boundaries = backend === 'codex' ? countCodexCompactions(text) : countCompactBoundaries(text);
    if (boundaries > 0) {
      report.offenders.push({ file, backend, sessionStartMs: startMs, compactBoundaries: boundaries });
      report.totalBoundaries += boundaries;
    }
  }
}

export async function auditNativeCompactionRetirement(opts: {
  /** The cutover instant: only sessions started at/after this count. */
  sinceMs: number;
  /** Claude projects root override (tests); defaults to ~/.claude/projects. */
  root?: string;
  /** Codex rollout-root overrides. Omit in production to scan every managed
   * root; a custom Claude root defaults this to [] for hermetic callers. */
  codexRoots?: string[];
}): Promise<NativeCompactionAuditReport> {
  const root = opts.root ?? defaultClaudeProjectsRoot();
  const codexRoots = opts.codexRoots ?? (opts.root ? [] : defaultCodexRolloutRoots());
  const report: NativeCompactionAuditReport = {
    scanned: 0,
    scannedByBackend: { claude: 0, codex: 0 },
    offenders: [],
    totalBoundaries: 0,
    verdict: 'clean',
  };
  const seen = new Set<string>();
  await auditRoot(root, 'claude', opts.sinceMs, report, seen);
  for (const codexRoot of codexRoots) await auditRoot(codexRoot, 'codex', opts.sinceMs, report, seen);
  report.verdict = report.offenders.length > 0 ? 'violations' : 'clean';
  return report;
}
