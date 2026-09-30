/**
 * Prefixes every `console.log/.warn/.error/.info/.debug` call with an
 * ISO-8601 timestamp.
 *
 * WI-5778 (P-422): frame `serve.log`s — the artifact every
 * `papercusp-desktop/bin/deb-hetzner-*.sh` / `local-matrix.sh` /
 * `two-instance-hive-from-repo-smoke.sh` rig produces by redirecting
 * `serve.mjs`'s stdout/stderr (`./bin/node ./serve.mjs --ensure >>
 * "$H/serve.log" 2>&1`) — have NO timestamp on most lines. That forced
 * every rig-forensics session (WI-5639, WI-5665, WI-5715, ...) to
 * correlate a log line to a boot cycle / wall-clock window via fragile
 * "which restart is this line from" bucketing (matching boot-marker
 * strings and counting occurrences) instead of just reading a time off
 * the line. Installing this once, as early as possible in `serve.ts`
 * (the source `serve.mjs` is esbuild-bundled from — see
 * `papercusp-desktop/bin/build-desktop-sidecar.sh`), fixes it at the one
 * choke point every rig's serve.log already flows through, instead of
 * patching N rig scripts' shell redirects individually.
 *
 * Deliberately does NOT touch `process.stdout/stderr.write` — those are
 * for pre-formatted / non-line-oriented output (e.g. `JSON.stringify(...)
 * + "\n"` used for the `--ensure` singleton-reuse reply on serve.ts's own
 * stdout) that a leading timestamp would corrupt for a machine reader.
 * `console.*` is the log-message surface; `process.stdout/stderr.write`
 * is the structured-reply surface. This only prefixes the former.
 */

const INSTALLED = Symbol.for('papercusp.timestampedConsole.installed');
type FlaggedConsole = Console & { [k: symbol]: boolean };

const CONSOLE_METHODS = ['log', 'warn', 'error', 'info', 'debug'] as const;
export type TimestampedConsoleMethod = (typeof CONSOLE_METHODS)[number];

/** `[<ISO-8601 with millisecond precision>]`, e.g. `[2026-07-25T21:30:00.123Z]`. */
export function timestampPrefix(now: Date = new Date()): string {
  return `[${now.toISOString()}]`;
}

/**
 * Idempotent (safe to call multiple times — the second call is a no-op,
 * matching `installConsoleInterceptor`'s pattern in `./log-events`) and
 * additive: it does not replace whatever is currently installed on
 * `console.*` (so it composes with `installConsoleInterceptor`,
 * regardless of install order) — it wraps whichever function is there
 * when called, and every call to the wrapped method still reaches it.
 */
export function installTimestampedConsole(): void {
  const c = console as FlaggedConsole;
  if (c[INSTALLED]) return;

  for (const method of CONSOLE_METHODS) {
    const real = console[method].bind(console);
    console[method] = (...args: unknown[]): void => {
      real(timestampPrefix(), ...args);
    };
  }

  c[INSTALLED] = true;
}
