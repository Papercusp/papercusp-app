/**
 * Branch-action projections for <StructuredStreamView>.
 *
 * `deriveBranchActionSteps` is a PURE reducer: branch-action events (in
 * arrival order) → a typed step list (one "run" row carrying status +
 * duration + the latest output line as detail). The raw stdout/stderr stays
 * one click away in the view's raw drawer, formatted by
 * `renderBranchActionRawLine` (ANSI rendering lifted from the old xterm-only
 * BranchActionRunner so the escape hatch is visually unchanged).
 *
 * Plan: structured-streams-not-terminals-2026-06-05 (D-004, P1).
 */
import type { StreamEvent, StreamStep } from './structured-stream-types';

/* ─── Step derivation (pure) ───────────────────────────────────────────── */

const RUN_ID = 'run';

function tsMs(ts: string): number | undefined {
  const n = Date.parse(ts);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Fold the branch-action event stream into a typed step list. The feed is a
 * single action run, so the projection is one primary row; stderr volume is
 * surfaced as a note so a quiet-exit-code-0-but-noisy run is still visible.
 * Robust to partial streams: output before `action-started` still creates
 * the row.
 */
export function deriveBranchActionSteps(events: StreamEvent[]): StreamStep[] {
  let run: StreamStep | null = null;
  let stderrCount = 0;
  const ensure = (): StreamStep => {
    if (!run) run = { id: RUN_ID, label: 'Run', status: 'running', notes: [] };
    return run;
  };

  for (const e of events) {
    switch (e.kind) {
      case 'action-started': {
        const d = e.data as { branch?: string; name?: string; cwd?: string } | undefined;
        const s = ensure();
        s.label = d?.branch && d?.name ? `${d.branch}/${d.name}` : 'Run';
        s.status = 'running';
        s.startedAt = tsMs(e.ts);
        if (d?.cwd) s.notes.push(`cwd: ${d.cwd}`);
        break;
      }
      case 'output': {
        const line = (e.data as { line?: string } | undefined)?.line;
        const s = ensure();
        if (s.endedAt == null && typeof line === 'string' && line.trim()) {
          s.detail = line.trim();
        }
        break;
      }
      case 'stderr': {
        const line = (e.data as { line?: string } | undefined)?.line;
        const s = ensure();
        stderrCount++;
        if (s.endedAt == null && typeof line === 'string' && line.trim()) {
          s.detail = `stderr: ${line.trim()}`;
        }
        break;
      }
      case 'action-completed': {
        const d = e.data as { exitCode?: number; durationMs?: number } | undefined;
        const s = ensure();
        s.status = 'ok';
        s.endedAt = tsMs(e.ts);
        s.detail = `exit ${d?.exitCode ?? 0}`;
        break;
      }
      case 'action-failed': {
        const d = e.data as { exitCode?: number; durationMs?: number } | undefined;
        const s = ensure();
        s.status = 'failed';
        s.endedAt = tsMs(e.ts);
        s.detail = `exit ${d?.exitCode ?? '?'}`;
        break;
      }
      default:
        break;
    }
  }

  if (run && stderrCount > 0) {
    (run as StreamStep).notes.push(`${stderrCount} stderr line${stderrCount === 1 ? '' : 's'}`);
  }
  return run ? [run] : [];
}

/* ─── Raw drawer line renderer (ANSI; lifted from the old xterm view) ──── */

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

/**
 * Render one branch-action event as a colourised terminal line for the raw
 * drawer. Returns a CRLF-terminated string, or null to skip. Formatting is
 * preserved from the old xterm-only BranchActionRunner.
 */
export function renderBranchActionRawLine(e: StreamEvent): string | null {
  const t = (e.ts ?? '').slice(11, 19); // HH:MM:SS
  const ts = `${C.dim}${t}${C.reset} `;
  switch (e.kind) {
    case 'action-started': {
      const d = e.data as { branch?: string; name?: string; cwd?: string } | undefined;
      return (
        `${ts}${C.cyan}── starting ${d?.branch ?? '?'}/${d?.name ?? '?'} ──${C.reset}\r\n` +
        `${ts}${C.dim}cwd: ${d?.cwd ?? '?'}${C.reset}\r\n`
      );
    }
    case 'output': {
      const line = (e.data as { line?: string } | undefined)?.line ?? '';
      return `${line}\r\n`;
    }
    case 'stderr': {
      const line = (e.data as { line?: string } | undefined)?.line ?? '';
      return `${C.red}${line}${C.reset}\r\n`;
    }
    case 'action-completed': {
      const d = e.data as { exitCode?: number; durationMs?: number } | undefined;
      return `\r\n${ts}${C.green}${C.bold}✓ completed${C.reset} (exit ${d?.exitCode ?? 0}, ${d?.durationMs ?? '?'} ms)\r\n`;
    }
    case 'action-failed': {
      const d = e.data as { exitCode?: number; durationMs?: number } | undefined;
      return `\r\n${ts}${C.red}${C.bold}✗ failed${C.reset} (exit ${d?.exitCode ?? '?'}, ${d?.durationMs ?? '?'} ms)\r\n`;
    }
    default:
      return null;
  }
}

/** Event kinds the branch-action feed emits (SSE event names to subscribe). */
export const BRANCH_ACTION_EVENT_KINDS = [
  'action-started',
  'output',
  'stderr',
  'action-completed',
  'action-failed',
] as const;

/** Classify a branch-action event as a terminal outcome (or null). */
export function classifyBranchActionTerminal(e: StreamEvent): 'success' | 'failed' | null {
  if (e.kind === 'action-completed') return 'success';
  if (e.kind === 'action-failed') return 'failed';
  return null;
}
