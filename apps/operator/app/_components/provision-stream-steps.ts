/**
 * Provisioning-specific projections for <StructuredStreamView>.
 *
 * `deriveProvisionSteps` is a PURE reducer: provision-audit events (in arrival
 * order) → a typed step list (one row per setup/teardown/verify phase, plus a
 * synthetic "Provisioning" row for output that precedes any phase). The raw
 * stdout/stderr stays one click away in the view's raw drawer, formatted by
 * `renderProvisionRawLine` (the ANSI renderer lifted verbatim from the old
 * xterm-only ProvisionStream so the escape hatch is byte-identical).
 *
 * Plan: structured-streams-not-terminals-2026-06-05 (D-003).
 */
import type { StreamEvent, StreamStep } from './structured-stream-types';

/* ─── Step derivation (pure) ───────────────────────────────────────────── */

const PHASES = ['setup', 'teardown', 'verify'] as const;
type Phase = (typeof PHASES)[number];

function phaseOf(kind: string): Phase | null {
  for (const p of PHASES) {
    if (kind === `${p}-started` || kind === `${p}-completed` || kind === `${p}-failed`) return p;
  }
  return null;
}

const PHASE_LABEL: Record<Phase, string> = {
  setup: 'Setup',
  teardown: 'Teardown',
  verify: 'Verify',
};

function tsMs(ts: string): number | undefined {
  const n = Date.parse(ts);
  return Number.isNaN(n) ? undefined : n;
}

function fmtData(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

const SYNTHETIC_ID = 'provision';

/**
 * Fold the provision-audit event stream into a typed step list. Robust to
 * out-of-order / partial streams: an unmatched completed/failed still resolves
 * its phase row; output before any phase lands on a synthetic "Provisioning"
 * row.
 */
export function deriveProvisionSteps(events: StreamEvent[]): StreamStep[] {
  const byId = new Map<string, StreamStep>();
  const order: string[] = [];
  const ensure = (id: string, label: string): StreamStep => {
    let s = byId.get(id);
    if (!s) {
      s = { id, label, status: 'info', notes: [] };
      byId.set(id, s);
      order.push(id);
    }
    return s;
  };
  let currentPhase: Phase | null = null;

  for (const e of events) {
    const phase = phaseOf(e.kind);
    if (phase) {
      const step = ensure(phase, PHASE_LABEL[phase]);
      if (e.kind.endsWith('-started')) {
        step.status = 'running';
        step.startedAt = tsMs(e.ts);
        currentPhase = phase;
      } else if (e.kind.endsWith('-completed')) {
        step.status = 'ok';
        step.endedAt = tsMs(e.ts);
        if (currentPhase === phase) currentPhase = null;
      } else if (e.kind.endsWith('-failed')) {
        step.status = 'failed';
        step.endedAt = tsMs(e.ts);
        const d = fmtData(e.data);
        if (d) step.detail = d;
        if (currentPhase === phase) currentPhase = null;
      }
      continue;
    }

    switch (e.kind) {
      case 'script-output': {
        const line = (e.data as { line?: string } | undefined)?.line ?? '';
        const target = currentPhase
          ? byId.get(currentPhase)!
          : ensure(SYNTHETIC_ID, 'Provisioning');
        // The synthetic row has no started/failed event of its own; once
        // output flows it's "running" until a terminal phase event.
        if (target.status === 'info' && target.endedAt == null) target.status = 'running';
        // Surface ::papercusp::progress markers as the running step's detail.
        if (typeof line === 'string' && line.startsWith('::papercusp::progress')) {
          const parts = line.split('\t');
          const label = (parts[1] ?? '').trim();
          if (label) target.detail = label;
        }
        break;
      }
      case 'resource-recorded': {
        const d = e.data as { kind?: string; externalId?: string } | undefined;
        const target = currentPhase
          ? byId.get(currentPhase)!
          : ensure(SYNTHETIC_ID, 'Provisioning');
        target.notes.push(`+ ${d?.kind ?? '?'} ${d?.externalId ?? ''}`.trim());
        break;
      }
      case 'consent-granted': {
        const s = ensure('consent', 'Consent');
        s.status = 'ok';
        s.endedAt = tsMs(e.ts);
        break;
      }
      case 'log-truncated': {
        const t = currentPhase ? byId.get(currentPhase) : byId.get(SYNTHETIC_ID);
        if (t) t.notes.push('log truncated');
        break;
      }
      default:
        // state-set and any unknown kinds: not surfaced as steps (still in the
        // raw drawer via renderProvisionRawLine).
        break;
    }
  }
  return order.map((id) => byId.get(id)!);
}

/* ─── Raw drawer line renderer (ANSI; lifted from the old xterm view) ──── */

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

/**
 * Render a single audit event as a colourised terminal line for the raw
 * drawer. Returns a CRLF-terminated string, or null to skip. Behaviour is
 * preserved from the original ProvisionStream.renderEntry so the escape-hatch
 * output is unchanged.
 */
export function renderProvisionRawLine(e: StreamEvent): string | null {
  const t = (e.ts ?? '').slice(11, 19); // HH:MM:SS
  const ts = `${C.dim}${t}${C.reset}`;
  switch (e.kind) {
    case 'script-output': {
      const line = (e.data as { line?: string } | undefined)?.line ?? '';
      if (line.startsWith('::papercusp::progress')) {
        const parts = line.split('\t');
        return `${ts} ${C.yellow}▸${C.reset} ${parts[1] ?? ''} ${C.dim}${parts.slice(2).join(' ')}${C.reset}\r\n`;
      }
      if (line.startsWith('::papercusp::warn')) {
        return `${ts} ${C.yellow}WARN${C.reset} ${line.replace(/^::papercusp::warn\t/, '')}\r\n`;
      }
      if (line.startsWith('::papercusp::error')) {
        return `${ts} ${C.red}${C.bold}ERROR${C.reset} ${line.replace(/^::papercusp::error\t/, '')}\r\n`;
      }
      if (line.startsWith('STDERR:')) {
        return `${ts} ${C.dim}${line}${C.reset}\r\n`;
      }
      return `${ts} ${line}\r\n`;
    }
    case 'resource-recorded': {
      const d = e.data as { kind?: string; externalId?: string } | undefined;
      return `${ts} ${C.green}+ ${d?.kind ?? '?'}${C.reset} ${d?.externalId ?? ''}\r\n`;
    }
    case 'setup-started':
    case 'teardown-started':
    case 'verify-started':
      return `${ts} ${C.cyan}${C.bold}${e.kind}${C.reset} ${C.dim}${fmtData(e.data)}${C.reset}\r\n`;
    case 'setup-completed':
    case 'teardown-completed':
    case 'verify-completed':
      return `${ts} ${C.green}${C.bold}✓ ${e.kind}${C.reset}\r\n`;
    case 'setup-failed':
    case 'teardown-failed':
    case 'verify-failed':
      return `${ts} ${C.red}${C.bold}✗ ${e.kind}${C.reset} ${C.dim}${fmtData(e.data)}${C.reset}\r\n`;
    case 'consent-granted':
      return `${ts} ${C.dim}consent granted${C.reset}\r\n`;
    case 'log-truncated':
      return `${ts} ${C.yellow}log truncated${C.reset} ${C.dim}${fmtData(e.data)}${C.reset}\r\n`;
    default:
      return `${ts} ${C.dim}${e.kind} ${fmtData(e.data)}${C.reset}\r\n`;
  }
}

/** Event kinds the provision feed emits (SSE event names to subscribe). */
export const PROVISION_EVENT_KINDS = [
  'script-output',
  'resource-recorded',
  'consent-granted',
  'setup-started',
  'setup-completed',
  'setup-failed',
  'teardown-started',
  'teardown-completed',
  'teardown-failed',
  'verify-started',
  'verify-completed',
  'verify-failed',
  'log-truncated',
  'state-set',
] as const;

const SUCCESS_KINDS = new Set(['setup-completed', 'teardown-completed', 'verify-completed']);
const FAILURE_KINDS = new Set(['setup-failed', 'teardown-failed', 'verify-failed']);

/** Classify a provision event as a terminal outcome (or null if not terminal). */
export function classifyProvisionTerminal(e: StreamEvent): 'success' | 'failed' | null {
  if (SUCCESS_KINDS.has(e.kind)) return 'success';
  if (FAILURE_KINDS.has(e.kind)) return 'failed';
  return null;
}
