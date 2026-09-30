/**
 * Classify why the postmaster died from its most recent log lines.
 * @param {readonly string[]} recentLines
 * @returns {'disk-full' | 'unknown'}
 */
export function classifyPostgresDeath(recentLines: readonly string[]): "disk-full" | "unknown";
/**
 * A bounded ring of the most recent postgres log LINES. embedded-postgres hands its
 * onLog callback raw stderr chunks, which can hold several lines or a partial one.
 * @param {number} [size]
 */
export function createPostgresLogWindow(size?: number): {
    /** @param {string} chunk */
    push(chunk: string): void;
    /** @returns {readonly string[]} */
    lines: () => readonly string[];
};
/**
 * True when a child process has already exited, so waiting for its 'exit' event
 * would hang forever (node emits 'exit' once and never replays it).
 * @param {{ exitCode?: number | null, signalCode?: string | null } | undefined | null} child
 */
export function childHasExited(child: {
    exitCode?: number | null;
    signalCode?: string | null;
} | undefined | null): boolean;
/**
 * @typedef {{
 *   code: number | null,
 *   signal: string | null,
 *   cause: 'disk-full' | 'unknown',
 *   freeBytes: number | null,
 *   nextAttemptInMs: number,
 *   attempt: number,
 * }} PostgresExitEvent
 */
/**
 * @typedef {{
 *   state: 'running' | 'restarting' | 'stopped',
 *   restarts: number,
 *   pendingAttempt: number,
 *   lastExit: null | { at: string, code: number | null, signal: string | null, cause: string, freeBytes: number | null },
 * }} PostgresSupervisorHealth
 */
/**
 * Watch an embedded-postgres instance after a successful start and restart it with
 * capped backoff whenever the postmaster exits without a stop() request.
 *
 * @param {{
 *   pg: { process?: any, start(): Promise<void> },
 *   dataDir: string,
 *   log: (m: string) => void,
 *   recentLines: () => readonly string[],
 *   backoffMs?: readonly number[],
 *   freeBytes?: (dir: string) => Promise<number | null>,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (t: unknown) => void,
 *   onExit?: (e: PostgresExitEvent) => void,
 *   onRestarted?: (e: { attempt: number }) => void,
 * }} deps
 * @returns {{ health(): PostgresSupervisorHealth, stop(): Promise<void> }}
 */
export function superviseEmbeddedPostgres(deps: {
    pg: {
        process?: any;
        start(): Promise<void>;
    };
    dataDir: string;
    log: (m: string) => void;
    recentLines: () => readonly string[];
    backoffMs?: readonly number[];
    freeBytes?: (dir: string) => Promise<number | null>;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (t: unknown) => void;
    onExit?: (e: PostgresExitEvent) => void;
    onRestarted?: (e: {
        attempt: number;
    }) => void;
}): {
    health(): PostgresSupervisorHealth;
    stop(): Promise<void>;
};
/**
 * Restart delays (ms) for a postmaster that exited on its own. The last step repeats.
 */
export const PG_RESTART_BACKOFF_MS: readonly number[];
/** How many recent postgres log lines are kept to classify a death. */
export const PG_DEATH_LOG_WINDOW: 50;
export type PostgresExitEvent = {
    code: number | null;
    signal: string | null;
    cause: "disk-full" | "unknown";
    freeBytes: number | null;
    nextAttemptInMs: number;
    attempt: number;
};
export type PostgresSupervisorHealth = {
    state: "running" | "restarting" | "stopped";
    restarts: number;
    pendingAttempt: number;
    lastExit: null | {
        at: string;
        code: number | null;
        signal: string | null;
        cause: string;
        freeBytes: number | null;
    };
};
