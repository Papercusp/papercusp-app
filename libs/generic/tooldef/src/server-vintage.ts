/**
 * server-vintage — a host-registered "how stale is this process" resolver.
 *
 * EI-19953470656367880: a long-lived server process (a Tauri desktop's own spawned
 * operator, chief among them — it has no file-watch and runs whatever code it booted
 * with, indefinitely) rejects a newly-added tool arg with a bare `Unrecognized key`
 * error. Nothing in that error says WHY: the caller (often a hot-reloaded UI sending
 * an arg the process's own code predates) has no way to distinguish "I made a typo"
 * from "the server I'm talking to is hours old and has never seen this arg exist."
 * Both look identical from the wire.
 *
 * The library owns the SEAM (where to hang the extra line, and how to fail safe);
 * the HOST owns the POLICY (what its own build id + boot time actually are) — the
 * same "declare the port here, wire the impl host-side" split as `result-annotator.ts`
 * / `setSemanticDeltaEnabledResolver`. This file stays host-agnostic on purpose: a
 * generic `libs/generic/*` package must not know what "PAPERCUSP_BUILD_SHA" is.
 *
 * Default is unregistered (no resolver ⇒ the unknown-arg hint is unchanged), so every
 * existing consumer/test is behavior-neutral until a host opts in.
 */

/** What the host process considers its own "vintage" — opaque build id + how long
 *  it has been running. Both best-effort; a host that cannot determine one leaves it
 *  `null` rather than guessing. */
export interface ServerVintage {
  /** Short git sha / build id the running process was started from, or null if unknown. */
  readonly buildId: string | null;
  /** Milliseconds since the process started serving. */
  readonly bootedAgoMs: number;
  /** Optional host-provided route to the endpoint serving the current source tree. */
  readonly freshCodeEndpoint?: string | null;
}

let resolver: (() => ServerVintage | null) | null = null;

/** Register the host's server-vintage resolver (last registration wins). Must be
 *  cheap + synchronous — it runs on the invalid-args failure path, which is already
 *  an error case; a host that needs I/O caches it out-of-band and the resolver only
 *  reads the cache (the same contract `getBuildInfo()` already keeps in Papercusp). */
export function setServerVintageResolver(fn: (() => ServerVintage | null) | null): void {
  resolver = fn;
}

/** Clear the registered resolver — test seam + host teardown. */
export function resetServerVintageResolver(): void {
  resolver = null;
}

/** Read the current server vintage, or null when no host resolver is registered, the
 *  host has none to report, or the resolver throws (NEVER lets a broken resolver fail
 *  the underlying tool-arg validation it is only trying to annotate). */
export function readServerVintage(): ServerVintage | null {
  if (!resolver) return null;
  try {
    return resolver();
  } catch {
    return null;
  }
}

/** Render `ms` as a short human duration ("52min", "4.6h", "3d") — coarse on purpose;
 *  this exists to answer "is this process old enough to be stale", not to be a clock. */
export function formatVintageAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'an unknown time';
  const min = ms / 60_000;
  if (min < 1) return '<1min';
  if (min < 60) return `${Math.round(min)}min`;
  const hr = min / 60;
  if (hr < 24) return `${hr.toFixed(1)}h`;
  return `${(hr / 24).toFixed(1)}d`;
}

/** The shared opening clause both hints below state — "which code is actually
 *  answering you". Empty string when there is no resolver / nothing to report, which
 *  is what makes every caller safe to concatenate unconditionally. */
function vintagePrefix(vintage: ServerVintage | null = readServerVintage()): string {
  if (!vintage) return '';
  const build = vintage.buildId ?? 'an unknown build';
  return ` This server is running build ${build}, started ${formatVintageAge(vintage.bootedAgoMs)} ago.`;
}

function freshCodeEndpointHint(vintage: ServerVintage): string {
  const endpoint = vintage.freshCodeEndpoint?.trim();
  return endpoint ? ` For the current source tree, retry this call against ${endpoint}.` : '';
}

/**
 * The extra sentence appended to an `Unrecognized key` invalid_args error, when a
 * host resolver is registered. Empty string when there is nothing to add (no
 * resolver, or the resolver returned null) — callers concatenate unconditionally.
 */
export function serverVintageHint(): string {
  const vintage = readServerVintage();
  const prefix = vintagePrefix(vintage);
  if (!prefix) return '';
  return (
    `${prefix} If this argument was added` +
    ' after that build, the running process has never seen it — restart the app/process to pick up the new code.' +
    freshCodeEndpointHint(vintage!)
  );
}

/**
 * The mirror of `serverVintageHint` for a CONSTRAINT violation (`minItems`, an enum
 * member, a range, a regex) — appended to a value-level invalid_args error.
 *
 * EI-21353729155349111: `serverVintageHint` covers the caller being NEWER than the
 * server (an arg the process predates). The mirror case is the server enforcing a
 * constraint the tree has since RELAXED, and it is strictly nastier to diagnose,
 * because the evidence a reader naturally reaches for actively misleads them: they
 * open the tool's source in the tree, see no such constraint, and conclude the error
 * is a defect in the tool rather than a skew between two versions of it. That is not
 * hypothetical — it cost a full investigation in EI-21310032409432146, where
 * `work_items:complete` refused `verification.coverage.residue: []` against a live
 * `minItems: 1` the tree had already dropped. An `Unrecognized key` would have been
 * annotated; the `too_small` that actually fired was not.
 *
 * WHY THIS GATES ON NOTHING BUT REGISTRATION (the design question EI-21353729155349111
 * left open, both of whose proposed gates are wrong):
 *
 *   - Gating on `bootedAgoMs` inverts the signal. The host wires it to
 *     `process.uptime()`, so it measures how long THIS PROCESS has run, not how old
 *     its CODE is. A process restarted two minutes ago from a three-day-old build is
 *     the most dangerous case there is, and an age threshold scores it "fresh" —
 *     suppressing the hint exactly when it was needed.
 *   - Gating on a real per-tool staleness probe (comparing the tool's defining file
 *     between the serving build and the tree) is precise, but every such probe is
 *     async and this is synchronous error construction. Wiring it needs an
 *     out-of-band cache — new machinery on a failure path, to suppress one sentence.
 *
 * So this follows the same discipline `serverVintageHint` already established: state
 * the vintage, phrase the consequence CONDITIONALLY, and let the reader judge. A
 * caller who really did send a bad enum reads past one clause; a caller staring at a
 * constraint that does not exist in the source in front of them is handed the answer.
 *
 * Deliberately ONE sentence: it lands on the value-level branch that EI-10943 keeps
 * free of the full args-schema dump precisely because that dump is context burn for a
 * caller who already knows the shape. This must not re-litigate that.
 */
export function constraintVintageHint(): string {
  const vintage = readServerVintage();
  const prefix = vintagePrefix(vintage);
  if (!prefix) return '';
  return (
    `${prefix} If this CONSTRAINT was relaxed after that build, the running process is still` +
    " enforcing the OLD one — the tool's source in the tree can disagree with what just refused you," +
    ' so verify against the serving build before treating this as a defect.' +
    freshCodeEndpointHint(vintage!)
  );
}
