/**
 * The `capability:computer` action ledger (P-008, D-012).
 *
 * WHAT THE "TEXT ACTION LEDGER" ACTUALLY IS. The obvious implementation — keep the
 * last N actions and embed them in every tool result — is O(N²) text: a 40-step
 * task with an 8-line ledger ships 320 lines of history the transcript already
 * contains. It would make token hygiene WORSE while looking like it was helping.
 *
 * So each result contributes EXACTLY ONE line (`#7 left_click (412,388) ok · tree`)
 * and the transcript accumulates the ledger for free. That also keeps the prompt
 * prefix immutable, which is the other half of D-012: nothing already emitted is
 * ever rewritten, so the cache prefix survives.
 *
 * The in-memory ring below therefore exists for TWO narrow purposes, neither of
 * which re-serializes history into results:
 *   1. the monotonic step number, so `#7` means the same thing across a session; and
 *   2. diagnostics — `readLedger` answers "what has this desktop been asked to do",
 *      which no transcript read can answer for a peer inspecting a live desktop.
 *
 * TYPED TEXT IS NEVER ECHOED. A `type` action records its LENGTH, not its content.
 * The model already knows what it typed (it is in its own tool-call args), so
 * echoing it back doubles the tokens for zero information — and a password typed
 * into a GUI would otherwise be copied into a diagnostics buffer that outlives the
 * call. Key chords (`key ctrl+s`) ARE recorded: they are short and not secrets.
 */
import { pinModuleState } from '@papercusp/module-singleton';

/** How many entries per display the diagnostics ring keeps. */
export const LEDGER_RING_SIZE = 32;

/** What the post-action observation actually returned, so the line is honest. */
export type ObservedAs = 'image' | 'tree' | 'none';

export interface ActionLedgerEntry {
  /** 1-based, monotonic per display for the life of the process. */
  seq: number;
  action: string;
  coordinate?: readonly [number, number];
  /** Length of the typed text — never the text itself (see the header). */
  typedChars?: number;
  /** The keysym/chord for `key`/`hold_key` — short, and not a secret. */
  keys?: string;
  ok: boolean;
  observed: ObservedAs;
  /** Short failure detail when `ok` is false. */
  note?: string;
  atMs: number;
}

interface DisplayLedger {
  seq: number;
  entries: ActionLedgerEntry[];
}

// Module-scoped mutable state in a bundled package: pinned per the shared-lib
// singleton rule, so a second module record (tsx's CJS preflight, a bare vs
// relative specifier, a bundled copy beside source) cannot give one caller a
// private ring while another writes to a different one.
const state = pinModuleState('@papercusp/operator-core.computer-action-ledger', () => ({
  byDisplay: new Map<string, DisplayLedger>(),
}));

function ledgerFor(display: string): DisplayLedger {
  let l = state.byDisplay.get(display);
  if (!l) {
    l = { seq: 0, entries: [] };
    state.byDisplay.set(display, l);
  }
  return l;
}

export type ActionLedgerInput = Omit<ActionLedgerEntry, 'seq' | 'atMs'> & { atMs?: number };

/** Append one action to a display's ledger and return the stored entry. */
export function recordAction(display: string, input: ActionLedgerInput): ActionLedgerEntry {
  const l = ledgerFor(display);
  l.seq += 1;
  const entry: ActionLedgerEntry = {
    ...input,
    seq: l.seq,
    atMs: input.atMs ?? Date.now(),
  };
  l.entries.push(entry);
  if (l.entries.length > LEDGER_RING_SIZE) l.entries.splice(0, l.entries.length - LEDGER_RING_SIZE);
  return entry;
}

/**
 * Render ONE entry as the single line a tool result contributes.
 *
 * Deliberately terse and stable: it is emitted once per step and never rewritten,
 * so every character is paid for on every action of every GUI task.
 */
export function renderLedgerLine(entry: ActionLedgerEntry): string {
  const parts: string[] = [`#${entry.seq}`, entry.action];
  if (entry.coordinate) parts.push(`(${entry.coordinate[0]},${entry.coordinate[1]})`);
  if (entry.keys) parts.push(entry.keys);
  if (typeof entry.typedChars === 'number') parts.push(`${entry.typedChars} chars`);
  parts.push(entry.ok ? 'ok' : 'FAILED');
  let line = parts.join(' ');
  if (entry.observed !== 'none') line += ` · ${entry.observed}`;
  if (entry.note) line += ` · ${entry.note}`;
  return line;
}

/** Diagnostics read — the recent actions on a display, oldest first. */
export function readLedger(display: string, limit?: number): readonly ActionLedgerEntry[] {
  const entries = state.byDisplay.get(display)?.entries ?? [];
  if (limit === undefined || limit >= entries.length) return [...entries];
  return entries.slice(entries.length - Math.max(0, limit));
}

/** Drop a display's ledger — call when its desktop is released, so a recycled
 *  display number never inherits the previous lease's step numbers. */
export function resetLedger(display: string): void {
  state.byDisplay.delete(display);
}

/** Displays that currently carry a ledger (diagnostics / tests). */
export function ledgerDisplays(): string[] {
  return [...state.byDisplay.keys()];
}

/** Test seam — clear every display's ledger. */
export function __resetAllLedgersForTests(): void {
  state.byDisplay.clear();
}
