/**
 * trajectory-recorder — per-desktop ACTION-SAMPLED recordings (P-009, D-013).
 *
 * READ D-013 BEFORE EXTENDING THIS. Three properties are load-bearing and easy to
 * undo by accident:
 *
 * 1. ACTION-SAMPLED, NOT TIME-SAMPLED. `deployment/desktop-capture.ts` is a 5s
 *    wall-clock sweep for the HUMAN live view. A trajectory is not a video of a
 *    screen — it is the sequence of (action → resulting screen) pairs, so this
 *    recorder appends exactly ONE frame per completed action, keyed by that
 *    action's P-008 ledger `seq`. Frame N and ledger line N are therefore the same
 *    event by construction, and an idle desktop produces no frames at all.
 *
 * 2. THE FRAME NEVER ENTERS THE TOOL RESULT. P-008/D-012 took the unconditional
 *    post-action screenshot OUT of the result; a recorder that captured by
 *    RETURNING pixels would silently put it back. Frames go to disk only. When the
 *    action's own observation already produced a PNG the recorder stores THOSE
 *    EXACT BYTES (`pngBase64`) instead of capturing again — one capture per step,
 *    and the recorded frame is provably the one the model saw.
 *
 * 3. THE ACTION STREAM IS APPEND-ONLY; THE FRAME FILES ARE A BOUNDED RING. Every
 *    appended frame writes one line to `actions.jsonl` and never rewrites it, so a
 *    crashed recording is still readable. When a bound is hit the OLDEST frame
 *    FILES are unlinked (the tail is where the failure is — a recorder that stopped
 *    at the cap would present a truncated trajectory as a complete one). The number
 *    dropped is therefore DERIVED at read time — jsonl lines whose file is gone —
 *    rather than maintained as a second copy of the same truth.
 *
 * Nothing here may throw into the action path: a recording is a diagnostic, and an
 * agent's click must not fail because a disk write did. Failures are captured on
 * the recording as `lastError` and surfaced by `recordingStatus`, which is honest
 * degradation rather than a silent swallow.
 */
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pinModuleState } from '@papercusp/module-singleton';
import { renderLedgerLine, type ActionLedgerEntry } from './action-ledger';
import { papercuspPath } from '../../papercusp-root';

/** Caps enforced at append time. See D-013 §5 — overflow drops the OLDEST frames. */
export interface RecordingBounds {
  /** Frame FILES kept on disk (the jsonl keeps every line regardless). */
  maxFrames: number;
  /** Total bytes of kept frame files. */
  maxBytes: number;
  /** Wall-clock ceiling; crossing it AUTO-STOPS the recording (`duration-cap`). */
  maxDurationSec: number;
}

export const DEFAULT_RECORDING_BOUNDS: RecordingBounds = {
  maxFrames: 240,
  maxBytes: 64 * 1024 * 1024,
  maxDurationSec: 3600,
};

/** How many finished recordings a root retains; the oldest are pruned on start. */
export const DEFAULT_MAX_RETAINED_RECORDINGS = 12;

export const MANIFEST_BASENAME = 'manifest.json';
export const ACTIONS_BASENAME = 'actions.jsonl';

export type RecordingEndReason = 'stopped' | 'duration-cap' | 'desktop-released';

/** One line of `actions.jsonl` — the action stream, append-only. */
export interface RecordedFrame {
  /** The P-008 ledger seq this frame belongs to. */
  seq: number;
  /** Frame file basename (`frame-000007.png`). */
  file: string;
  bytes: number;
  atMs: number;
  /** The rendered ledger line, so the export is readable without the transcript. */
  line: string;
  /** true when the bytes came from the action's own observation (no extra capture). */
  reused: boolean;
}

export interface RecordingManifest {
  id: string;
  display: string;
  /** The work-item this recording is parked on, bound at START (D-013 §8). */
  workItem: string | null;
  /** The DesktopSession registry row, when the caller knew it. */
  sessionId: string | null;
  note: string | null;
  startedAtMs: number;
  endedAtMs: number | null;
  endReason: RecordingEndReason | null;
  bounds: RecordingBounds;
  /** Frames appended over the recording's life, including ones later dropped. */
  appended: number;
  lastError: string | null;
}

interface ActiveRecording extends RecordingManifest {
  dir: string;
  /** Kept frame files, oldest first — the ring the bounds evict from. */
  kept: Array<{ file: string; bytes: number }>;
  keptBytes: number;
}

const state = pinModuleState('@papercusp/operator-core.computer-trajectory-recorder', () => ({
  byDisplay: new Map<string, ActiveRecording>(),
}));

/** Where recordings live. Workspace-scoped via the shared papercusp root. */
export function recordingsRoot(): string {
  return papercuspPath('recordings');
}

function frameName(seq: number): string {
  return `frame-${String(seq).padStart(6, '0')}.png`;
}

function writeManifest(rec: ActiveRecording): void {
  const { dir, kept, keptBytes, ...manifest } = rec;
  void kept;
  void keptBytes;
  writeFileSync(join(dir, MANIFEST_BASENAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export interface StartRecordingOpts {
  display: string;
  workItem?: string | null;
  sessionId?: string | null;
  note?: string | null;
  bounds?: Partial<RecordingBounds>;
  /** Override the recordings root (tests; a caller with its own storage policy). */
  root?: string;
  /** Retention for FINISHED recordings under the root. */
  maxRetained?: number;
}

export class RecordingAlreadyOpenError extends Error {
  constructor(public readonly existing: RecordingManifest) {
    super(
      `capability:computer — display ${existing.display} is already recording (${existing.id}, started ${new Date(existing.startedAtMs).toISOString()}). ` +
        'Stop it before starting another, or a single trajectory would be split across two recordings.',
    );
    this.name = 'RecordingAlreadyOpenError';
  }
}

/**
 * Open a recording for a display. Refuses loudly when one is already open: a
 * second `start` would split one trajectory across two directories, which reads
 * later as two short successful runs rather than one long confusing one.
 */
export function startRecording(opts: StartRecordingOpts): RecordingManifest & { dir: string } {
  const open = state.byDisplay.get(opts.display);
  if (open) throw new RecordingAlreadyOpenError(publicManifest(open));

  const root = opts.root ?? recordingsRoot();
  const id = `rec-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${randomUUID().slice(0, 8)}`;
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });

  const rec: ActiveRecording = {
    id,
    dir,
    display: opts.display,
    workItem: opts.workItem ?? null,
    sessionId: opts.sessionId ?? null,
    note: opts.note ?? null,
    startedAtMs: Date.now(),
    endedAtMs: null,
    endReason: null,
    bounds: { ...DEFAULT_RECORDING_BOUNDS, ...(opts.bounds ?? {}) },
    appended: 0,
    lastError: null,
    kept: [],
    keptBytes: 0,
  };
  state.byDisplay.set(opts.display, rec);
  writeManifest(rec);
  // Append-only from here: create it now so an export of a zero-action recording
  // reads an empty stream instead of a missing file.
  appendFileSync(join(dir, ACTIONS_BASENAME), '', 'utf8');

  pruneRecordings(root, opts.maxRetained ?? DEFAULT_MAX_RETAINED_RECORDINGS);
  return { ...publicManifest(rec), dir };
}

function publicManifest(rec: ActiveRecording): RecordingManifest {
  const { dir, kept, keptBytes, ...manifest } = rec;
  void dir;
  void kept;
  void keptBytes;
  return { ...manifest };
}

/** Is this display being recorded right now? The hot-path guard — one Map lookup. */
export function isRecording(display: string): boolean {
  return state.byDisplay.has(display);
}

export interface NoteActionOpts {
  /** Pixels the action's OWN observation already produced — reused, never re-captured. */
  pngBase64?: string;
  /** Capture a PNG when the observation produced none. Called ONLY while recording. */
  capture?: () => Promise<Buffer>;
}

/**
 * Append one action's frame. Returns the stored frame, or null when this display is
 * not being recorded / the frame could not be captured.
 *
 * NEVER throws: the caller is the agent's action path (see the header).
 */
export async function noteRecordedAction(
  display: string,
  entry: ActionLedgerEntry,
  opts: NoteActionOpts = {},
): Promise<RecordedFrame | null> {
  const rec = state.byDisplay.get(display);
  if (!rec) return null;

  // D-013 §5: the wall-clock cap ends the recording rather than letting a
  // long-lived pot desktop record forever.
  if (Date.now() - rec.startedAtMs > rec.bounds.maxDurationSec * 1000) {
    stopRecording(display, 'duration-cap');
    return null;
  }

  try {
    let png: Buffer | null = null;
    let reused = false;
    if (opts.pngBase64) {
      png = Buffer.from(opts.pngBase64, 'base64');
      reused = true;
    } else if (opts.capture) {
      png = await opts.capture();
    }
    if (!png || png.length === 0) return null;

    const file = frameName(entry.seq);
    writeFileSync(join(rec.dir, file), png);
    rec.kept.push({ file, bytes: png.length });
    rec.keptBytes += png.length;
    rec.appended += 1;

    const frame: RecordedFrame = {
      seq: entry.seq,
      file,
      bytes: png.length,
      atMs: entry.atMs,
      line: renderLedgerLine(entry),
      reused,
    };
    appendFileSync(join(rec.dir, ACTIONS_BASENAME), `${JSON.stringify(frame)}\n`, 'utf8');
    enforceBounds(rec);
    return frame;
  } catch (err) {
    // Honest degradation: the action still succeeded, and `status`/`stop` report
    // that the recording lost frames rather than presenting a silent gap.
    rec.lastError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

/** Drop the OLDEST frame files until the recording fits its bounds (D-013 §5). */
function enforceBounds(rec: ActiveRecording): void {
  while (
    rec.kept.length > 0 &&
    (rec.kept.length > rec.bounds.maxFrames || rec.keptBytes > rec.bounds.maxBytes)
  ) {
    const oldest = rec.kept.shift();
    if (!oldest) break;
    rec.keptBytes -= oldest.bytes;
    try {
      unlinkSync(join(rec.dir, oldest.file));
    } catch {
      /* already gone — the jsonl still names it, which is how a drop is counted */
    }
  }
}

/**
 * Close a recording. Idempotent — a second stop returns null.
 *
 * Returns the DIRECTORY as well as the manifest, deliberately: a caller that
 * rebuilt it as `join(recordingsRoot(), id)` would silently answer about the wrong
 * place for any recording opened under a different root.
 */
export function stopRecording(
  display: string,
  reason: RecordingEndReason = 'stopped',
): (RecordingManifest & { dir: string }) | null {
  const rec = state.byDisplay.get(display);
  if (!rec) return null;
  state.byDisplay.delete(display);
  rec.endedAtMs = Date.now();
  rec.endReason = reason;
  try {
    writeManifest(rec);
  } catch (err) {
    rec.lastError = err instanceof Error ? err.message : String(err);
  }
  return { ...publicManifest(rec), dir: rec.dir };
}

/** The open recording for a display, or null. */
export function recordingStatus(display: string): (RecordingManifest & { dir: string; keptFrames: number; keptBytes: number }) | null {
  const rec = state.byDisplay.get(display);
  if (!rec) return null;
  return { ...publicManifest(rec), dir: rec.dir, keptFrames: rec.kept.length, keptBytes: rec.keptBytes };
}

/** Displays with an open recording (diagnostics / shutdown sweeps). */
export function recordingDisplays(): string[] {
  return [...state.byDisplay.keys()];
}

export interface LoadedRecording {
  manifest: RecordingManifest;
  dir: string;
  /** Frames whose file is still on disk, oldest first. */
  frames: RecordedFrame[];
  /**
   * Frames the action stream recorded whose file the bounds evicted. DERIVED from
   * the two artifacts rather than tracked separately (D-013 §5 / the derived-truth
   * rule) — a hand-maintained counter is a second copy that drifts.
   */
  droppedFrames: number;
}

/** Read a recording directory back. Works on an OPEN recording too (a snapshot). */
export function readRecording(dir: string): LoadedRecording {
  const manifestPath = join(dir, MANIFEST_BASENAME);
  if (!existsSync(manifestPath)) {
    throw new Error(`computer:record — no recording at ${dir} (missing ${MANIFEST_BASENAME}).`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RecordingManifest;
  const streamPath = join(dir, ACTIONS_BASENAME);
  const lines = existsSync(streamPath)
    ? readFileSync(streamPath, 'utf8').split('\n').filter((l) => l.trim().length > 0)
    : [];

  const frames: RecordedFrame[] = [];
  let dropped = 0;
  for (const line of lines) {
    let parsed: RecordedFrame;
    try {
      parsed = JSON.parse(line) as RecordedFrame;
    } catch {
      // A torn last line is what a crash mid-append looks like; it is not a
      // corrupt recording, so keep every complete line before it.
      continue;
    }
    if (existsSync(join(dir, parsed.file))) frames.push(parsed);
    else dropped += 1;
  }
  return { manifest, dir, frames, droppedFrames: dropped };
}

/** Recording directories under a root, newest first. */
export function listRecordings(root = recordingsRoot()): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name.startsWith('rec-'))
    .map((name) => {
      const dir = join(root, name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(dir).mtimeMs;
      } catch {
        /* raced with a prune */
      }
      return { dir, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((r) => r.dir);
}

/**
 * Keep the newest `maxRetained` recordings under a root; delete the rest. Never
 * deletes a directory with an OPEN recording — those are still being appended to.
 */
export function pruneRecordings(root: string, maxRetained: number): string[] {
  const open = new Set([...state.byDisplay.values()].map((r) => r.dir));
  const dirs = listRecordings(root).filter((d) => !open.has(d));
  const doomed = dirs.slice(Math.max(0, maxRetained));
  const removed: string[] = [];
  for (const dir of doomed) {
    try {
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      /* best effort — a recordings root that cannot be pruned is not a reason to fail a start */
    }
  }
  return removed;
}

/** Test seam — forget every open recording without touching the disk. */
export function __resetRecordingsForTests(): void {
  state.byDisplay.clear();
}

/** Test seam — move a recording's start back so the wall-clock cap can be exercised
 *  without fake timers (the cap is real elapsed time, not a tick count). */
export function __backdateRecordingForTests(display: string, startedAtMs: number): void {
  const rec = state.byDisplay.get(display);
  if (!rec) throw new Error(`__backdateRecordingForTests: no open recording on ${display}`);
  rec.startedAtMs = startedAtMs;
}
