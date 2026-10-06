/**
 * WI-10005680 — name a failed `gitnexus analyze` instead of reporting "exited 139".
 *
 * The vendor analyzer (1.6.9) does not fail cleanly when LadybugDB's buffer manager runs out of its
 * virtual reservation during the manual WAL checkpoint: it logs
 * "Buffer manager exception: Maximum database size of 17179869184 bytes has been reached" →
 * "manual WAL checkpoint failed after retries" and then dies with SIGSEGV. Callers used to surface only
 * `exited 139` (the bench) or `exited 1` with the signal erased (the reindex action: Node reports a
 * signal death as `code=null`, collapsed to 1), so the one string that names the knob —
 * GITNEXUS_LBUG_MAX_DB_SIZE — was buried in a 300–500 char stderr tail, or cut off entirely.
 *
 * Pure and dependency-free on purpose: both `gitnexus-reindex-action.ts` (production) and
 * `engine-comparison-arms.ts` (the bench) import it, and it must not import either back.
 */

export type AnalyzeFailureKind =
  | 'lbug-max-db-size'
  | 'buffer-pool-full'
  | 'wal-checkpoint-failed'
  | 'native-crash';

export interface AnalyzeFailureInput {
  /** Exit status. A signal death observed through `child.on('close')` arrives as null/1 plus `signal`. */
  readonly code: number | null;
  readonly signal?: string | null;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface AnalyzeFailureClass {
  readonly kind: AnalyzeFailureKind;
  /** One line stating WHAT happened, quoting the measured value where the vendor message carries one. */
  readonly summary: string;
  /** One line stating WHICH knob or residue to look at. */
  readonly remedy: string;
}

/** Shell convention for death by SIGSEGV (128 + 11); also what GNU `time`/`timeout` re-report. */
const SIGSEGV_EXIT = 139;
/** SIGABRT (134) and SIGBUS (135) are the same class: the native layer died, not the JS. */
const NATIVE_CRASH_EXITS: ReadonlySet<number> = new Set([134, 135, SIGSEGV_EXIT]);
const NATIVE_CRASH_SIGNALS: ReadonlySet<string> = new Set(['SIGSEGV', 'SIGABRT', 'SIGBUS']);

const MAX_DB_SIZE = /Maximum database size of (\d+) bytes has been reached/;
const BUFFER_POOL_FULL = /Unable to allocate memory! The buffer pool is full/;
const WAL_CHECKPOINT_FAILED = /manual WAL checkpoint failed/i;

const GIB = 1024 ** 3;

/**
 * Classify a FAILED analyze, or return null when the run did not fail (exit 0, no signal) or the
 * failure is not one this recognises — null means "unrecognised", never "fine": the caller keeps
 * its raw tail for that case.
 *
 * Output is searched in full (stdout + stderr), not a tail: the named line sits seconds before the
 * crash but the run may print progress after the checkpoint driver restarts.
 */
export function classifyAnalyzeFailure(run: AnalyzeFailureInput): AnalyzeFailureClass | null {
  const signalled = run.signal != null && run.signal !== '';
  if (run.code === 0 && !signalled) return null;
  const text = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;

  const size = MAX_DB_SIZE.exec(text);
  if (size) {
    const bytes = Number(size[1]);
    return {
      kind: 'lbug-max-db-size',
      summary: `LadybugDB size ceiling reached (${bytes} bytes = ${(bytes / GIB).toFixed(0)} GiB)`,
      remedy:
        'GITNEXUS_LBUG_MAX_DB_SIZE bounds the buffer manager\'s virtual reservation, not the file on disk; ' +
        "production's analyzeEnv pins it (GITNEXUS_LBUG_MAX_DB_BYTES), so a run that reports the 16 GiB vendor " +
        'default ran WITHOUT that pin (a bare vendor spawn, or an ambient override). Re-run through analyzeEnv; ' +
        'a crash here can leave a 0-byte lbug.shadow / orphan lbug.wal (D-016) that cleanCrashResidue recovers.',
    };
  }
  if (BUFFER_POOL_FULL.test(text)) {
    return {
      kind: 'buffer-pool-full',
      summary: 'LadybugDB buffer pool exhausted during bulk COPY',
      remedy:
        'GITNEXUS_LBUG_BUFFER_POOL_SIZE (resident native memory, NOT the node heap — raising --max-old-space-size ' +
        'does not help); production pins it via analyzeEnv (GITNEXUS_LBUG_BUFFER_POOL_BYTES).',
    };
  }
  if (WAL_CHECKPOINT_FAILED.test(text)) {
    return {
      kind: 'wal-checkpoint-failed',
      summary: 'gitnexus manual WAL checkpoint failed after retries',
      remedy:
        'GITNEXUS_WAL_MANUAL_CHECKPOINT=0 on Linux (production default; the driver exists for a Windows rename race); ' +
        'check lbug.wal / lbug.shadow residue (D-016) before the next analyze.',
    };
  }
  if ((run.code != null && NATIVE_CRASH_EXITS.has(run.code)) || (signalled && NATIVE_CRASH_SIGNALS.has(run.signal as string))) {
    return {
      kind: 'native-crash',
      summary: `analyze died from a native crash (${signalled ? run.signal : `exit ${run.code}`}) with no recognised vendor message`,
      remedy: 'read the full analyze log for the last vendor line, then check lbug.wal / lbug.shadow residue (D-016).',
    };
  }
  return null;
}

/** `[kind] summary — remedy`, for a log line or alert body. */
export function describeAnalyzeFailure(c: AnalyzeFailureClass): string {
  return `[${c.kind}] ${c.summary} — ${c.remedy}`;
}
