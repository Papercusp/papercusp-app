/**
 * Type declarations for `tsc-red-observations.mjs` (EI-19365056012137849).
 *
 * WHY THIS FILE EXISTS. The module is plain ESM JS, and operator-core compiles with
 * `allowJs: false` + `strict: true`. Importing it from a .ts test therefore raised
 * TS7016 ("implicitly has an 'any' type"), and — because the import then resolved to
 * `any` — six further TS7006 "parameter implicitly has an 'any' type" errors on the
 * `.filter(o => …)` / `.find(r => …)` callbacks downstream. Seven errors, one cause.
 *
 * The original suppression attempt was a `// @ts-ignore` above the import statement.
 * It could not work: for a MULTI-LINE import, TS reports TS7016 at the module-specifier
 * line (here line 31), not at the `import` keyword (line 23), and `@ts-ignore` only
 * suppresses the line immediately following it. So the directive silently applied to
 * nothing — the failure mode being that it LOOKS like the case was handled.
 *
 * Declaring the surface is strictly better than relocating the suppression: it removes
 * all seven errors at the root rather than muting one and leaving six, and it gives real
 * types to every future caller. The shapes below are transcribed from the module's own
 * JSDoc `@param`/`@returns` annotations, so this file and the implementation state the
 * same contract in two places that can be diffed.
 */

/** Default JSONL store path, under the papercusp state dir. */
export declare const DEFAULT_OBSERVATION_PATH: string;

/** How long a red must persist before it counts as OWNERLESS rather than in-flight. */
export declare const DWELL_SEC: number;

/** How long observations are retained before pruning. */
export declare const RETENTION_SEC: number;

/** After this long with no fresh sighting, an observation is treated as stale. */
export declare const STALE_SEC: number;

/** One standing red as handed to {@link recordStandingReds}. */
export interface StandingRedEntry {
  file: string;
  current?: number;
  baseline?: number;
}

/** One persisted observation line. */
export interface TscRedObservation {
  ts: number;
  file: string;
  count: number | null;
  project: string;
}

/** A file whose red has persisted long enough to be reported. */
export interface DwelledRed {
  file: string;
  firstSeen: number;
  lastSeen: number;
  sightings: number;
  spanSec: number;
  latestCount: number | null;
}

export declare function recordStandingReds(opts: {
  entries: StandingRedEntry[];
  path?: string;
  nowMs?: number;
  project?: string;
  /** Tree the entries are relative to; omitted writes no stamp, which readers admit. */
  root?: string;
}): { ok: boolean; written: number; error?: string };

export declare function readObservations(opts?: {
  path?: string;
  nowMs?: number;
  retentionSec?: number;
  /** Drop observations STAMPED with a different tree. Unstamped lines are always admitted. */
  root?: string;
}): TscRedObservation[];

export declare function selectDwelledReds(
  observations: Array<{ ts: number; file: string; count: number | null }>,
  opts?: { nowMs?: number; dwellSec?: number; staleSec?: number },
): DwelledRed[];

export declare function pruneObservations(opts?: {
  path?: string;
  nowMs?: number;
  retentionSec?: number;
}): { ok: boolean; kept: number; keptRuns: number; error?: string };

/** One persisted RUN HEARTBEAT line — a compile that knew the complete standing set. */
export interface TscRunHeartbeatRecord {
  ts: number;
  project: string;
  verdict: string;
  standingCount: number;
}

/** Gate verdicts on which the complete standing new-file red set is known. */
export declare const COMPLETE_STANDING_SET_VERDICTS: readonly string[];

export declare function verdictObservesCompleteStandingSet(verdict: string | undefined): boolean;

export declare function recordGateRun(opts: {
  verdict: string | undefined;
  project?: string;
  standingCount?: number;
  path?: string;
  nowMs?: number;
}): { ok: boolean; written: number; skipped?: string; error?: string };

export declare function readRunHeartbeats(opts?: {
  path?: string;
  nowMs?: number;
  retentionSec?: number;
}): TscRunHeartbeatRecord[];
