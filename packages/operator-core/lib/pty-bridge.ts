/**
 * Server-side wrapper around node-pty for embedded terminal panes.
 *
 * Spawns child processes with a pseudo-terminal so interactive TUIs (pi/omp,
 * shells, REPLs, etc.) work end-to-end inside the harness UI's xterm.js pane.
 * The Hono pty router (`_hono/pty.ts`) mediates the HTTP/SSE transport
 * between the browser and these handles.
 *
 * Process lifecycle:
 *   - Each call to `spawnPty` produces a new IPty handle keyed by uuid.
 *   - Handles register an onData listener to fan bytes out to subscribers.
 *   - The router calls `kill()` on disconnect; idle handles auto-kill via
 *     `markActive()` not having been called for `IDLE_TIMEOUT_MS`.
 *   - Every production start enters the durable resource governor before the
 *     node-pty fork; health feedback controls admission without a local cap.
 *
 * This module is server-only — it imports `node-pty`, which loads a native
 * binding. Don't import it from a client component.
 */
import { spawn, type IPty } from '@lydell/node-pty';
import { randomUUID } from 'node:crypto';
import * as xtermHeadless from '@xterm/headless';
import * as xtermAddonSerialize from '@xterm/addon-serialize';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import {
  samePtyAccessScope,
  type PtyAccessScope,
} from './pty-ticket';
import { resolveClusterWorkers } from './cluster-fork';
import { getResourceProfile } from './resource-profile';
import type { AdmissionContext, ResourceDemand } from './resource-governor/admission';
import { beginGovernedExecution, governedExecutionRuntime } from './resource-governor/execution';

// @xterm/headless + @xterm/addon-serialize are CJS; their named exports aren't
// statically visible to ESM named-import LINKING (cjs-module-lexer) under tsx now
// that operator-core is `"type": "module"`, so `import { Terminal } from …` fails
// to link. A namespace import resolves the constructor at runtime instead — and,
// unlike a renamed `createRequire`, stays statically inlinable by the desktop
// sidecar's esbuild bundle (a createRequire'd literal would not inline → "cannot
// find module" in the shipped sidecar).
// Lazy-resolve at call time (not module load) to work around CJS interop timing
// race on first spawnPty call in wake-resume flow.
//
// EI-13212: neither package declares a package.json "exports" map, only
// "main" (CJS) + "module" (an ESM build, the bundler-only convention). The
// two build targets disagree on `.default`:
//   - Node/tsx has no "exports" map to honor, so it always resolves "main"
//     (CJS) — and Node's CJS→ESM interop then SYNTHESIZES `ns.default =
//     module.exports` for a namespace import, so `.default.Terminal` happens
//     to also work here too (redundant with the direct property, never
//     actually needed).
//   - Rolldown/Vite (the operator-vite / desktop-sidecar production build)
//     instead prefers the "module" field for a browser target — a REAL ESM
//     file (`export{Jr as Terminal}` / `export{...,D as SerializeAddon}`,
//     verified against the installed build) that ships no default at all. The
//     bundler can PROVE that statically and flags the dead `.default` access
//     as an IMPORT_IS_UNDEFINED warning.
// So `(ns as any).default?.X` was never anything but dead weight: redundant
// under Node, and provably-undefined under the bundler that actually warned.
// The namespace's own named property is the only path either target needs —
// keep it that way; do not reintroduce a `.default` fallback without first
// re-checking the shipped "module" build (pty-bridge.test.ts statically
// inspects that file directly, so a regression can't hide behind Node's
// interop-synthesized default, which only Node ever sees).
const getHeadlessTerminal = () => xtermHeadless.Terminal;
const getSerializeAddon = () => xtermAddonSerialize.SerializeAddon;

export interface SpawnPtyOpts {
  /** Authorization boundary captured by the handle and required for every id lookup. */
  accessScope: PtyAccessScope;
  /** Binary to launch (e.g. 'omp', 'bash', '/usr/local/bin/omp'). */
  command: string;
  /** Arguments to pass. */
  args: readonly string[];
  /** Working directory. */
  cwd: string;
  /** Environment to pass; merged with sidecar env. */
  env?: Record<string, string | undefined>;
  /**
   * Whether to inherit the operator process environment before applying `env`.
   * Defaults to true for the existing desktop-pane callers. Capability tools set
   * this false and provide a scrubbed environment so operator secrets never cross
   * the execution boundary.
   */
  inheritEnv?: boolean;
  /** Durable task-ledger identity for capability-owned sessions. */
  taskId?: string | null;
  /** Initial terminal size. xterm.js sends a resize on its first frame too. */
  cols: number;
  rows: number;
}

export interface GovernedPtySpawnInput {
  readonly workspaceId: string;
  readonly idempotencyKey: string;
  readonly owner: string;
  readonly payloadRef?: string;
  readonly parent?: AdmissionContext;
  readonly demand?: ResourceDemand;
}

export interface PtyHandle {
  id: string;
  /** Durable task-ledger identity; null for legacy/UI-owned panes. */
  taskId: string | null;
  /** Tenant/workspace/harness/host/principal boundary that owns this handle. */
  accessScope: PtyAccessScope;
  pty: IPty;
  command: string;
  args: readonly string[];
  cwd: string;
  /**
   * The coord owner (PAPERCUSP_SID) this pty was spawned for, captured from the
   * spawn env. null when the spawn carried no SID (a shell/REPL pane, a legacy
   * untagged spawn). The wake executor matches on it to prevent a recycled pid
   * from routing one agent's wake turn into another agent's session (EI-151).
   */
  ownerSid: string | null;
  startedAtMs: number;
  /** Track activity so the idle reaper can drop ghost handles. */
  lastActivityMs: number;
  /** Has this handle been killed (by user, idle reaper, or process exit)? */
  killed: boolean;
  /** Exit code, set after the underlying process exits. */
  exitCode: number | null;
  /** Subscribers for stdout bytes — Hono SSE handlers register here. */
  onData: Set<(chunk: Buffer) => void>;
  /** Fired once the underlying process exits. */
  onExit: Set<(code: number, signal: number) => void>;
  /**
   * Persistent ring buffer of bytes the pty has emitted, capped at
   * HISTORY_CAP_BYTES. Kept as a fallback for clients that don't want
   * a full screen-state replay (notably the SSE path, which streams
   * raw bytes anyway and benefits from the same byte representation).
   */
  history: Buffer[];
  historyBytes: number;
  /**
   * P4: server-side xterm-headless instance fed every byte the pty
   * emits. Lets us replay bounded screen state on reconnect (a few KB
   * of ANSI escapes) instead of the full byte history. Geometry-
   * correct for vim/htop because the headless Terminal resizes
   * alongside the pty.
   */
  headless: InstanceType<ReturnType<typeof getHeadlessTerminal>>;
  serializer: InstanceType<ReturnType<typeof getSerializeAddon>>;
}

const HISTORY_CAP_BYTES = 1024 * 1024;
const HEADLESS_SCROLLBACK = 1000;

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const REAPER_INTERVAL_MS = 30 * 1000;

// Pin module state on globalThis so multiple compiled instances of this
// module share the same Map. Next.js 16 bundles instrumentation.ts and
// API routes separately — without this, the WS server (lib/pty-ws.ts,
// imported from instrumentation.ts) sees an empty handles map even
// though the Hono /spawn route just registered a handle.
type Globals = typeof globalThis & {
  __papercuspPtyHandles?: Map<string, PtyHandle>;
  __papercuspPtyReaperStarted?: boolean;
};
const _globals = globalThis as Globals;
const handles: Map<string, PtyHandle> = _globals.__papercuspPtyHandles ?? new Map<string, PtyHandle>();
_globals.__papercuspPtyHandles = handles;

/**
 * Memoized worker count for `ptyRegistryClusterRefusal`. A plain module-scope `let`
 * on purpose (not a `globalThis` pin): the value is a pure function of `process.env`
 * plus the host profile, so a split module record recomputes the SAME number — there
 * is no shared mutable state to keep coherent, unlike the `handles` map above.
 */
let _clusterWorkersMemo: number | null = null;

/**
 * The worker count when multi-worker clustering makes the pty registry above
 * unserviceable in this process, or `null` when it is safe to serve terminals.
 *
 * THE REGISTRY IS THE THING THAT BREAKS, which is why this predicate lives here
 * rather than beside either transport. `handles` is per-process state, so every
 * pty operation must land in the process that spawned the handle. Under
 * `node:cluster` it cannot: spawn requests round-robin across N request workers,
 * so a later attach/input/resize/kill finds no entry and fails (workers-1)/workers
 * of the time, strictly interleaved. Both transports that front this map are
 * affected identically — the WS attach path (`pty-ws.ts`) and the HTTP/SSE control
 * plane (`endpoint-route/routes/pty`) — so both consult THIS predicate and refuse
 * together. Refusing loudly deletes nothing that worked: the shipping desktop
 * target pins PAPERCUSP_CLUSTER=0, where this returns `null`.
 *
 * Callers that already resolved the authoritative count (hono-host, which computes
 * it once at boot) pass it in; callers with no injection point (the route handlers)
 * omit it and get the same value re-derived from the same resolver, so the two legs
 * cannot disagree.
 */
export function ptyRegistryClusterRefusal(opts?: { clusterWorkers?: number }): number | null {
  let workers = opts?.clusterWorkers;
  if (workers == null) {
    if (_clusterWorkersMemo == null) {
      _clusterWorkersMemo = resolveClusterWorkers(process.env, getResourceProfile().httpWorkers);
    }
    workers = _clusterWorkersMemo;
  }
  const n = Math.floor(Number(workers));
  if (!Number.isFinite(n) || n <= 1) return null;
  return n;
}

/** Test-only: drop the memoized worker count so a test can vary `process.env`. */
export function __resetPtyRegistryClusterMemoForTests(): void {
  _clusterWorkersMemo = null;
}

function startReaper(): void {
  if (_globals.__papercuspPtyReaperStarted) return;
  _globals.__papercuspPtyReaperStarted = true;
  managedSetInterval('pty-idle-reaper', REAPER_INTERVAL_MS, () => {
    const now = Date.now();
    for (const handle of handles.values()) {
      if (handle.killed) continue;
      if (now - handle.lastActivityMs > IDLE_TIMEOUT_MS) {
        killPty(handle.id, handle.accessScope);
      }
    }
  }, { category: 'global-sweep' });
}

export class PtyError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'PtyError';
  }
}

/** Admit at the PTY fork boundary and exact-release when node-pty reports exit. */
export async function spawnGovernedPty(
  opts: SpawnPtyOpts,
  admission: GovernedPtySpawnInput,
): Promise<PtyHandle> {
  const execution = await beginGovernedExecution(
    {
      idempotencyKey: admission.idempotencyKey,
      admissionClass: 'process',
      demand: admission.demand ?? { cpuWeight: 1 },
      payloadRef: admission.payloadRef,
      parent: admission.parent,
      metadata: {
        processKind: 'pty',
        taskId: opts.taskId ?? null,
        harnessSlug: opts.accessScope.harnessSlug,
      },
    },
    { owner: admission.owner },
    governedExecutionRuntime(admission.workspaceId, 'pty-process'),
  );

  let handle: PtyHandle;
  try {
    handle = spawnPty({
      ...opts,
      env: {
        ...opts.env,
        PAPERCUSP_ADMISSION_CONTEXT: JSON.stringify(execution.context),
      },
    });
  } catch (error) {
    await execution.cancel(`pty spawn threw: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  handle.onExit.add(() => {
    void execution.finish();
  });
  return handle;
}

/** Create a new pty-backed subprocess. Admission belongs to spawnGovernedPty. */
export function spawnPty(opts: SpawnPtyOpts): PtyHandle {
  startReaper();

  const env: Record<string, string> = {};
  if (opts.inheritEnv !== false) {
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v;
    }
  }
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }

  let pty: IPty;
  try {
    pty = spawn(opts.command, [...opts.args], {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env,
      // F3: cooperate with node-pty's built-in XON/XOFF handling for
      // children that emit flow-control bytes. omp/pi don't normally
      // emit raw XOFF (they're TUIs that own input directly), but
      // shells in the pty might. Pairs with the F2 watermark in
      // pty-ws.ts: F2 throttles on bytes the *server* hasn't yet
      // ack'd from the client; F3 throttles on the kernel-pty side.
      // PAPERCUSP_PTY_FLOW_CONTROL=0 disables.
      handleFlowControl: process.env.PAPERCUSP_PTY_FLOW_CONTROL !== '0',
    });
  } catch (err) {
    throw new PtyError(
      `failed to spawn ${opts.command}: ${(err as Error).message}`,
      'SPAWN_FAILED',
    );
  }

  const id = randomUUID();
  const T = getHeadlessTerminal();
  const S = getSerializeAddon();
  if (!T) {
    throw new PtyError(
      'HeadlessTerminal constructor not resolved (CJS interop)',
      'TERMINAL_CONSTRUCTOR_FAILED',
    );
  }
  if (!S) {
    throw new PtyError(
      'SerializeAddon constructor not resolved (CJS interop)',
      'SERIALIZE_ADDON_FAILED',
    );
  }
  const headless = new T({
    cols: opts.cols,
    rows: opts.rows,
    scrollback: HEADLESS_SCROLLBACK,
    allowProposedApi: true,
  });
  const serializer = new S();
  headless.loadAddon(serializer);

  const handle: PtyHandle = {
    id,
    taskId: opts.taskId ?? null,
    accessScope: { ...opts.accessScope },
    pty,
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    ownerSid: opts.env?.PAPERCUSP_SID ?? null,
    startedAtMs: Date.now(),
    lastActivityMs: Date.now(),
    killed: false,
    exitCode: null,
    onData: new Set(),
    onExit: new Set(),
    history: [],
    historyBytes: 0,
    headless,
    serializer,
  };
  handles.set(id, handle);

  pty.onData((chunk) => {
    handle.lastActivityMs = Date.now();
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    // Maintain raw byte ring (SSE fallback path).
    handle.history.push(buf);
    handle.historyBytes += buf.length;
    while (handle.historyBytes > HISTORY_CAP_BYTES && handle.history.length > 1) {
      const dropped = handle.history.shift()!;
      handle.historyBytes -= dropped.length;
    }
    // Mirror into the headless terminal — feeds the SerializeAddon so
    // getScreenSerialization() always reflects the live pty state.
    // xterm-headless accepts strings (already-decoded code points)
    // OR Uint8Array (UTF-8 decode); we have a Buffer so converting
    // to Uint8Array is the cheap correct thing.
    try {
      handle.headless.write(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
    } catch { /* a write in the wrong state — drop, the byte ring is authoritative */ }
    for (const sub of handle.onData) {
      try { sub(buf); } catch { /* subscriber threw — drop it next loop */ }
    }
  });

  pty.onExit(({ exitCode, signal }) => {
    handle.killed = true;
    handle.exitCode = exitCode;
    for (const sub of handle.onExit) {
      try { sub(exitCode, signal ?? 0); } catch { /* ignore */ }
    }
    handle.onData.clear();
    handle.onExit.clear();
    // Drop the handle from the map after a grace period so a late-
    // arriving subscriber can still read the final screen state, but
    // we don't accumulate dead entries or grow the map indefinitely.
    // 30 s is well past any realistic
    // reconnect window.
    setTimeout(() => {
      handles.delete(id);
      try { handle.headless.dispose(); } catch { /* */ }
    }, 30_000).unref?.();
  });

  return handle;
}

export function getPty(id: string, accessScope: PtyAccessScope): PtyHandle | undefined {
  const handle = handles.get(id);
  return handle && samePtyAccessScope(handle.accessScope, accessScope) ? handle : undefined;
}

/**
 * Resolve a capability-owned PTY through its durable task id. The task id is the
 * only model-facing session handle: process-local PTY ids stay an implementation
 * detail, while the complete access scope is still re-checked on every lookup.
 */
export function getPtyByTaskId(taskId: string, accessScope: PtyAccessScope): PtyHandle | undefined {
  for (const handle of handles.values()) {
    if (handle.taskId === taskId && samePtyAccessScope(handle.accessScope, accessScope)) {
      return handle;
    }
  }
  return undefined;
}

/**
 * Return only the authorization boundary for an id. The WebSocket upgrade
 * verifier uses this to validate a signed ticket before any handle is exposed.
 */
export function getPtyAccessScope(id: string): PtyAccessScope | null {
  const handle = handles.get(id);
  return handle ? { ...handle.accessScope } : null;
}

/** Write user keystrokes to the pty stdin. No-op if killed. */
export function writePty(id: string, data: Buffer, accessScope: PtyAccessScope): boolean {
  const handle = getPty(id, accessScope);
  if (!handle || handle.killed) return false;
  handle.lastActivityMs = Date.now();
  handle.pty.write(data.toString('utf8'));
  return true;
}

/** Resize the underlying pty. No-op if killed. */
export function resizePty(id: string, cols: number, rows: number, accessScope: PtyAccessScope): boolean {
  const handle = getPty(id, accessScope);
  if (!handle || handle.killed) return false;
  handle.lastActivityMs = Date.now();
  try {
    handle.pty.resize(cols, rows);
    // Mirror to the headless terminal so the serialized state matches
    // what curses apps will draw at the new geometry.
    try { handle.headless.resize(cols, rows); } catch { /* */ }
    return true;
  } catch {
    return false;
  }
}

/** Kill the pty process. Idempotent. */
export function killPty(id: string, accessScope: PtyAccessScope): boolean {
  const handle = getPty(id, accessScope);
  if (!handle) return false;
  if (!handle.killed) {
    try { handle.pty.kill(); } catch { /* already dying */ }
    handle.killed = true;
  }
  // Free the headless terminal — no consumers can ask for replay once
  // a pty is explicitly killed (vs the soft "client disconnected" path
  // where the handle stays alive for resume).
  try { handle.headless.dispose(); } catch { /* already disposed */ }
  return true;
}

/** Mark this pty as actively consumed by a subscriber so the reaper spares it. */
export function markActive(id: string, accessScope: PtyAccessScope): void {
  const handle = getPty(id, accessScope);
  if (handle) handle.lastActivityMs = Date.now();
}

/**
 * Snapshot the persistent history buffer. Does NOT drain — survives any
 * number of subscriber attach/detach cycles so a tab switch (PiPanel
 * unmount → remount) can replay the full session into a fresh xterm.
 * Returns null if empty. Used by the SSE fallback path; modern WS
 * clients prefer getScreenSerialization which is bounded by screen
 * size rather than session bytes.
 */
export function getHistory(id: string, accessScope: PtyAccessScope): Buffer | null {
  const handle = getPty(id, accessScope);
  if (!handle || handle.history.length === 0) return null;
  return Buffer.concat(handle.history);
}

/**
 * P4 replay: serialize the current xterm-headless screen state to a
 * string of ANSI escapes. Writing this string into a fresh client
 * xterm reproduces the exact on-screen state without replaying every
 * byte the pty has ever emitted.
 *
 * Bounded by terminal size + scrollback (HEADLESS_SCROLLBACK rows),
 * which is typically tens of KB regardless of session length. Uses
 * VS Code's same approach for remote terminal restore.
 *
 * Async: xterm-headless `Terminal.write()` is queued — we MUST flush
 * the queue before serializing or a fast reconnect can race the
 * mirror-write and produce an empty screen. The flush is a no-op
 * write whose callback fires after every prior queued write commits.
 *
 * Returns null if the pty is unknown or the headless terminal has
 * been disposed.
 */
export async function getScreenSerialization(id: string, accessScope: PtyAccessScope): Promise<string | null> {
  const handle = getPty(id, accessScope);
  if (!handle) return null;
  try {
    await new Promise<void>((resolve) => handle.headless.write('', resolve));
    return handle.serializer.serialize({ scrollback: HEADLESS_SCROLLBACK });
  } catch {
    return null;
  }
}

/**
 * Look up a pty by id. Returns metadata if alive, null if missing/dead.
 * Used by /pty/spawn to honor a `resumePtyId` request from a remounting
 * client.
 */
export function getPtyMeta(
  id: string,
  accessScope: PtyAccessScope,
): { id: string; command: string; args: readonly string[]; cwd: string; pid: number } | null {
  const handle = getPty(id, accessScope);
  if (!handle || handle.killed) return null;
  return {
    id: handle.id,
    command: handle.command,
    args: handle.args,
    cwd: handle.cwd,
    pid: handle.pty.pid,
  };
}

/**
 * Find a live pty whose process (or the process it spawned — same pid for
 * direct spawns) matches `pid`. Used by the await-event wake executor
 * (events/await/wake-executor.ts) to pick the inject channel when the
 * sleeping agent's session is one of OUR managed ptys. Returns null when no
 * live handle matches — most sessions (detached terminal emulators) won't.
 *
 * Cross-agent misroute guard (EI-151): a recorded pid can be RECYCLED by the OS
 * to a DIFFERENT agent's live managed pty after the original session exits
 * uncleanly (its adv_sessions row never marked ended). Matching on pid alone
 * would then route the original subscriber's wake turn into the unrelated
 * agent's session. So when the caller names the owner it expects (`ownerSid`),
 * a handle TAGGED with a different owner is NOT a match. An untagged handle
 * (`ownerSid === null` — a shell pane / legacy spawn) still matches: it carries
 * no contrary evidence, so this is never stricter than the pid-only behavior.
 */
export function findPtyByPid(pid: number, ownerSid?: string | null): PtyHandle | null {
  for (const h of handles.values()) {
    if (h.killed || h.exitCode !== null || h.pty.pid !== pid) continue;
    if (ownerSid && h.ownerSid && h.ownerSid !== ownerSid) continue; // recycled-pid misroute
    return h;
  }
  return null;
}

/** Stats for an `/api/desktop/pty/stats` debug endpoint or similar. */
export function ptyStats(): { live: number; total: number } {
  let live = 0;
  for (const h of handles.values()) if (!h.killed) live++;
  return { live, total: handles.size };
}
