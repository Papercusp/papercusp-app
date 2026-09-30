/**
 * The attribution SINK — the two dispatcher hooks, and the flush that turns buffered
 * observations into `coverage_evidence` rows.
 *
 * Plan: deterministic-coverage-census-2026-08-17 (P-004).
 *
 * TWO CHOKEPOINTS, CHOSEN BECAUSE THEY CANNOT DRIFT FROM THE CENSUS POPULATION:
 *   - HTTP  -> `runRouteStack`'s `finally`, which receives the `RouteDefinition` itself. The
 *     census (`providers/hono-routes.ts`) enumerates `routeRegistrationOrder()`, and
 *     `registerRoute` mounts exactly one `runRouteStack` call per entry in that same array.
 *     So the set of surfaces the census names and the set this hook can observe are the SAME
 *     set, by construction, and the surfaceId is built from the same `(method, path)` pair.
 *   - MCP   -> `recordInvocationImpl`, the single telemetry sink every `tools/call` settles
 *     through (including the replay branch). The census (`providers/mcp-tools.ts`) enumerates
 *     the live `getCatalog()`, and a tool that is not in the catalog cannot be dispatched.
 *
 * ⚠ THE REJECTED ALTERNATIVE, AND WHY. The obvious reading of "test-mode Hono middleware" is
 * an `app.use('*', ...)` middleware reading `c.req.routePath`. That would be a SECOND source of
 * truth for the surface identity — a matcher re-deriving what the mount already knew — and the
 * census design's central invariant (providers/types.ts) is that a surface's identity comes
 * from the registration code itself, never from a parallel derivation. A middleware also cannot
 * see WHICH of several overlapping routes actually served the request without re-implementing
 * Hono's precedence rules, and this repo's `isCatchAll` ordering exists precisely because that
 * precedence is subtle. Hooking the mount seam removes the whole class.
 *
 * WHY A `verdict` MAPPING RATHER THAN "the test passed":
 * this layer observes ONE call, not a test outcome — the test's own verdict is written later,
 * by the reporter, into `test_runs`, and joins to these rows on (run_group_id, file_path). So
 * `verdict` here means "what happened when this surface was exercised", and the mapping below
 * turns on ONE question: DID THE HANDLER ACTUALLY RUN?
 *   - it ran and returned            -> `pass`   (a 404/400/refusal is the handler behaving)
 *   - it ran and threw / timed out   -> `error`
 *   - a GATE rejected before it ran  -> `skip`   (auth, quota, role, replay)
 * That last line is the one that matters. A test that only ever gets 401 from a route has NOT
 * covered it — the guard was exercised, the behaviour was not. Recording that as `pass` would
 * manufacture exactly the false confidence this whole census exists to prevent, so it is
 * recorded as `skip`: observed, not covered.
 */

import { pinModuleState } from '@papercusp/module-singleton';
import {
  EvidenceBuffer,
  type BufferedEvidence,
  type EvidenceVerdict,
  type TrafficObservation,
} from './buffer';
import {
  FORBID_REAL_PG_ENV,
  isAttributionArmed,
  resolveAttributionScope,
  resolveCaller,
  type AttributionScope,
  type HeaderLike,
} from './context';

export const HTTP_ROUTE_KIND = 'http-route';
export const MCP_TOOL_KIND = 'mcp-tool';

/**
 * The census kinds this sink can actually OBSERVE — every kind a `record*` entry point
 * below emits, and nothing else.
 *
 * WHY THIS IS EXPORTED RATHER THAN LEFT FOR EACH READER TO RE-DERIVE. A censused surface
 * whose kind is absent here can never acquire traffic evidence by ANY path, so its
 * permanent place at the bottom of the coverage ladder is a structural fact about the
 * OBSERVER population, not a measurement of test coverage. A reader that cannot tell
 * those apart reports "below floor — work the gap queue" over surfaces where writing a
 * test changes nothing. Measured 2026-09-02 (P-008): 251 of 2,017 live surfaces — the
 * whole `sync-query` kind, 12.4% — sit in exactly that state, censused by
 * `providers/sync-queries.ts` with no observer anywhere.
 *
 * It lives beside the constants and the `record*` functions that emit them so a third
 * observer cannot be written without this set in the author's eye, and the paired
 * behavioural guard in `observed-surface-kinds.test.ts` DRIVES the real entry points and
 * fails when the set and the emitted kinds disagree. That makes this derived from
 * behaviour rather than asserted — the ladder's rung 2, not a hand-maintained list.
 */
export const OBSERVED_SURFACE_KINDS: readonly string[] = [HTTP_ROUTE_KIND, MCP_TOOL_KIND];

/** What a flush needs of a backend. Injected so the buffer + hooks are testable without PG. */
export interface EvidenceStore {
  write(
    scope: AttributionScope,
    rows: readonly BufferedEvidence[],
  ): Promise<{ written: number; unmatchedSurfaces: number }>;
}

interface SinkState {
  buffer: EvidenceBuffer;
  /** Debounce handle for the next flush. Unref'd — attribution must never hold a process open. */
  timer: ReturnType<typeof setTimeout> | null;
  /** In-flight flush, so concurrent triggers await one write instead of racing the drain. */
  inFlight: Promise<void> | null;
  store: EvidenceStore | null;
  /** Set after repeated write failures — see `noteFlushFailure`. */
  disabled: boolean;
  consecutiveFailures: number;
  lastError: string | null;
  exitHookInstalled: boolean;
  /** Cumulative counters, for the integration test and for diagnostics. */
  written: number;
  unmatched: number;
}

const state = pinModuleState<SinkState>(
  '@papercusp/operator-core.coverage-census.attribution.sink',
  () => ({
    buffer: new EvidenceBuffer(),
    timer: null,
    inFlight: null,
    store: null,
    disabled: false,
    consecutiveFailures: 0,
    lastError: null,
    exitHookInstalled: false,
    written: 0,
    unmatched: 0,
  }),
);

/** Flush when the buffer reaches this many distinct bindings, without waiting for the debounce. */
const FLUSH_AT_BINDINGS = 500;
/** Quiet period after the last observation before an automatic flush. */
const FLUSH_DEBOUNCE_MS = 250;
/**
 * Consecutive failed flushes after which the sink DISABLES itself for the process.
 *
 * A test run whose PG is unreachable must not spend a retry per request; and, more importantly,
 * a sink that keeps failing silently is worse than one that stops — the buffer would grow while
 * every flush drops it. Disabling makes the loss bounded and visible in `attributionStatus()`.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

/* ─── Verdict mapping ─────────────────────────────────────────────────── */

/** `RouteExecution['status']` -> verdict. See the file header for the did-the-handler-run rule. */
export function verdictForRouteStatus(
  status: 'ok' | 'unauthorized' | 'forbidden' | 'invalid-input' | 'timeout' | 'error',
): EvidenceVerdict {
  switch (status) {
    case 'ok':
      return 'pass';
    // The route's DECLARED input schema is part of its behaviour, and rejecting bad input is
    // that schema doing its job — the route stack reached the route's own contract. Coverage.
    case 'invalid-input':
      return 'pass';
    // The auth chain short-circuited BEFORE the handler. The guard is covered; the route is not.
    case 'unauthorized':
    case 'forbidden':
      return 'skip';
    case 'timeout':
    case 'error':
      return 'error';
  }
}

/** `RecordInvocationInput['status']` -> verdict. Same rule, MCP's larger status union. */
export function verdictForToolStatus(status: string): EvidenceVerdict {
  switch (status) {
    case 'ok':
    // 'refused' means the handler RAN and self-reported a business-level failure — exercised.
    case 'refused':
    case 'invalid-input':
      return 'pass';
    // None of these ran the handler: a quota/role gate refused, or the replay store answered.
    case 'quota-exceeded':
    case 'role-not-allowed':
    case 'replayed':
      return 'skip';
    case 'timeout':
    case 'error':
      return 'error';
    default:
      // An unrecognised status is a NEW member of the dispatcher's union that this mapping has
      // not been taught. `error` is the honest default: it can only over-report trouble, and it
      // shows up in the row's details so the omission is findable rather than silently 'pass'.
      return 'error';
  }
}

/* ─── The two hooks ───────────────────────────────────────────────────── */

/** Surface identity for an HTTP route — the SAME rule `providers/hono-routes.ts` uses. */
export function httpSurfaceId(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export interface HttpTrafficInput {
  method: string;
  /** The MOUNTED path pattern (`/api/widgets/:id`), never the concrete request URL. */
  path: string;
  status: 'ok' | 'unauthorized' | 'forbidden' | 'invalid-input' | 'timeout' | 'error';
  /** HTTP status code, kept as context on the row. */
  httpStatus?: number | null;
  headers?: HeaderLike | null;
}

/**
 * Record one HTTP route call. Called from `runRouteStack`'s `finally`.
 *
 * MUST NOT THROW and must be cheap when disarmed: the very first statement is the arming
 * check, so a production request pays one cached boolean.
 */
export function recordHttpTraffic(input: HttpTrafficInput): void {
  if (!isAttributionArmed() || state.disabled) return;
  try {
    const caller = resolveCaller(input.headers ?? null);
    observe({
      kind: HTTP_ROUTE_KIND,
      surfaceId: httpSurfaceId(input.method, input.path),
      verdict: verdictForRouteStatus(input.status),
      runGroupId: caller.runGroupId,
      testFile: caller.testFile,
      testCase: caller.testCase,
      details: {
        routeStatus: input.status,
        ...(input.httpStatus != null ? { httpStatus: input.httpStatus } : {}),
      },
    });
  } catch {
    /* attribution is best-effort and must never affect the response it is describing */
  }
}

export interface McpTrafficInput {
  toolName: string;
  status: string;
}

/** Record one MCP tool call. Called from `recordInvocationImpl`. Same contract as above. */
export function recordMcpTraffic(input: McpTrafficInput): void {
  if (!isAttributionArmed() || state.disabled) return;
  try {
    const caller = resolveCaller(null);
    observe({
      kind: MCP_TOOL_KIND,
      surfaceId: input.toolName,
      verdict: verdictForToolStatus(input.status),
      runGroupId: caller.runGroupId,
      testFile: caller.testFile,
      testCase: caller.testCase,
      details: { toolStatus: input.status },
    });
  } catch {
    /* see recordHttpTraffic */
  }
}

function observe(o: TrafficObservation): void {
  state.buffer.record(o);
  installExitFlush();
  if (state.buffer.size >= FLUSH_AT_BINDINGS) {
    void flushTrafficEvidence();
    return;
  }
  scheduleFlush();
}

/* ─── Flush ───────────────────────────────────────────────────────────── */

function scheduleFlush(): void {
  if (state.timer) return;
  const timer = setTimeout(() => {
    state.timer = null;
    void flushTrafficEvidence();
  }, FLUSH_DEBOUNCE_MS);
  // A pending attribution flush must never be the reason a test process stays alive — that
  // would turn this instrumentation into a hang, which is far worse than a lost row.
  timer.unref?.();
  state.timer = timer;
}

/**
 * Flush at process exit, so the last debounce window is not lost.
 *
 * `beforeExit` (not `exit`) because it is the only lifecycle hook that can still await async
 * work; `exit` runs synchronously and could not complete a PG write. Installed lazily on the
 * first observation so a disarmed process never registers a listener at all.
 */
function installExitFlush(): void {
  if (state.exitHookInstalled) return;
  state.exitHookInstalled = true;
  try {
    process.once('beforeExit', () => {
      void flushTrafficEvidence();
    });
  } catch {
    /* no process object (non-node runtime) — the debounce remains the only trigger */
  }
}

/**
 * Drain the buffer and write it. Safe to call concurrently: a second caller awaits the first.
 *
 * Never throws — a failed flush is counted, logged once, and eventually disables the sink.
 */
export async function flushTrafficEvidence(): Promise<void> {
  if (state.inFlight) return state.inFlight;
  if (state.disabled) return;
  if (state.buffer.size === 0) return;

  // Stand down QUIETLY in a layer that forbids a real connection — this is an expected
  // configuration, not a fault, so it is neither counted as a flush failure nor warned
  // about. `lastError` still says so, which is what keeps "correctly inert here" legible
  // in `attributionStatus()` rather than looking like silent data loss.
  if (realPgForbidden()) {
    state.disabled = true;
    state.lastError = `no real PG in this layer (${FORBID_REAL_PG_ENV}=1) — attribution stood down`;
    state.buffer.clear();
    return;
  }

  const scope = await resolveAttributionScope();
  if (!scope) {
    // D-011: the resolver is TOTAL, so reaching here means it THREW (an unreadable workspace
    // registry), not that the scope was merely unconfigured. Dropping is still right — there
    // is no join target — but this is now an exceptional path, not the steady state it used
    // to be. See resolveAttributionScope.
    noteFlushFailure('no attribution scope (census scope resolution failed)');
    state.buffer.clear();
    return;
  }

  const rows = state.buffer.drain();
  const run = (async () => {
    try {
      const store = await resolveStore();
      const result = await store.write(scope, rows);
      state.written += result.written;
      state.unmatched += result.unmatchedSurfaces;
      state.consecutiveFailures = 0;
      state.lastError = null;
    } catch (err) {
      noteFlushFailure(err instanceof Error ? err.message : String(err));
    } finally {
      state.inFlight = null;
    }
  })();
  state.inFlight = run;
  return run;
}

/**
 * Diagnostics go to `process.stderr`, NOT to `console.warn`.
 *
 * This is not a style choice. The shared vitest setup installs `vitest-fail-on-console`, which
 * turns any `console.warn` into a test FAILURE — so a sink that warned about its own PG trouble
 * would red every test in the file it happened to fire in, in EVERY layer. Instrumentation that
 * can fail the suite it is instrumenting is worse than no instrumentation: the failure would be
 * attributed to the test, not to attribution. stderr keeps the diagnostic visible to a human
 * reading the run output while staying out of the assertion path. The structured version is
 * always available in `attributionStatus()`, which is what tests assert on.
 */
function warn(message: string): void {
  try {
    process.stderr.write(`[coverage-attribution] ${message}\n`);
  } catch {
    /* no stderr (non-node runtime) — attributionStatus() still carries lastError */
  }
}

function noteFlushFailure(message: string): void {
  state.consecutiveFailures += 1;
  state.lastError = message;
  if (state.consecutiveFailures === 1 || state.consecutiveFailures === MAX_CONSECUTIVE_FAILURES) {
    warn(`flush failed (${state.consecutiveFailures}): ${message}`);
  }
  if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    state.disabled = true;
    warn('disabled for this process after repeated flush failures');
  }
}

/**
 * True when this process may not open a real PG connection AND no store was injected.
 *
 * This is why the RUNNERS (`testing:run`, the admin-UI runner) can stamp
 * `PAPERCUSP_TEST_ATTRIBUTION=1` unconditionally: one `files` array routinely spans the unit
 * and integration layers, so the runner cannot make this call — each fork can. Without the
 * check a unit fork would attempt a forbidden connection, fail, retry twice, and only then
 * disable itself: three failed connections and two stderr lines per fork, every ordinary
 * unit run, to record nothing.
 *
 * Note what it does NOT do: it never suppresses OBSERVATION, and it yields to an injected
 * store. A unit test driving the hooks against a fake store is a legitimate armed case, and
 * an earlier version of this rail that disarmed instead broke exactly those tests.
 */
function realPgForbidden(): boolean {
  return !state.store && process.env[FORBID_REAL_PG_ENV] === '1';
}

async function resolveStore(): Promise<EvidenceStore> {
  if (state.store) return state.store;
  // Imported lazily so a process that never observes traffic never loads the PG client — which
  // is what keeps this instrumentation inert (not merely quiet) in the unit-test layer, whose
  // `setup-no-real-pg.ts` rail forbids a real connection.
  const { createPgEvidenceStore } = await import('./pg-evidence-store');
  state.store = createPgEvidenceStore();
  return state.store;
}

/* ─── Test seams + diagnostics ────────────────────────────────────────── */

export function setEvidenceStoreForTests(store: EvidenceStore | null): void {
  state.store = store;
}

export function resetAttributionSinkForTests(): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.inFlight = null;
  state.store = null;
  state.disabled = false;
  state.consecutiveFailures = 0;
  state.lastError = null;
  state.written = 0;
  state.unmatched = 0;
  state.buffer.clear();
}

/** Everything a caller (or a test) needs to tell "wrote nothing" from "was never armed". */
export function attributionStatus(): {
  armed: boolean;
  disabled: boolean;
  buffered: number;
  dropped: number;
  written: number;
  unmatchedSurfaces: number;
  lastError: string | null;
} {
  return {
    armed: isAttributionArmed(),
    disabled: state.disabled,
    buffered: state.buffer.size,
    dropped: state.buffer.dropped,
    written: state.written,
    unmatchedSurfaces: state.unmatched,
    lastError: state.lastError,
  };
}

/** Peek at what is buffered — assertions only. */
export function peekBufferedEvidence(): BufferedEvidence[] {
  return state.buffer.peek();
}
