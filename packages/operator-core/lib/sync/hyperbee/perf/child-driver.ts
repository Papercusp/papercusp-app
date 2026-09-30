/**
 * child-driver.ts — parent-side harness for `peer-child.ts` processes
 * (P-005/P-006 multi-process scenarios).
 *
 * Spawns one OS process per peer (`node --import tsx peer-child.ts`, config
 * via env), parses the child's ndjson stdout into typed events, and exposes
 * await-helpers for the scenario scripts (`waitFor('ready')`, `sendGo()`, …).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import type { PeerChildConfig, PeerChildResult } from './peer-child';
import type { PerfArtifact } from './artifact';
import { recomputeConvergenceVerdict, type ScenarioMeter } from './metrics';
import { MeshFormationError } from './mesh-outcome';
// WI-41206: HostCapacityError is intentionally no longer imported — the mesh preflight is
// advisory and throws nothing. The class itself stays exported from host-capacity.ts for any
// out-of-tree caller, but nothing in this driver may refuse a run on a memory projection.
import { capacityOverridesFromEnv, decideMeshCapacity, readMemAvailableBytes } from './host-capacity';

const CHILD_PATH = fileURLToPath(new URL('./peer-child.ts', import.meta.url));
/** `--import` shim that installs the no-PG resolution hooks (see spawnPeerChild). */
const NO_PG_REGISTER_PATH = fileURLToPath(new URL('./no-pg-register.mjs', import.meta.url));

export interface ChildEvent {
  evt: string;
  [k: string]: unknown;
}

/** Minimal structural shape of something awaitable for a child event (lets tests drive fakes). */
export interface CaughtUpWaitable {
  waitFor(pred: string, timeoutMs: number): Promise<ChildEvent | null>;
}

/**
 * Await `evt` on EVERY reader CONCURRENTLY, against a SHARED deadline: all timers
 * start at the same instant, so a reader is judged on the run's wall clock and never
 * on its position in the iteration order.
 *
 * EI-20581532536662596 — the scenarios previously did this SERIALLY, giving each reader
 * a FRESH budget as the loop reached it. Because `waitFor` resolves immediately for an
 * already-fired event, the reader polled FIRST got the full budget measured from loop
 * start while the Nth effectively got the budget PLUS all the time already spent waiting
 * on readers 0..N-1. The first slow reader was penalised hardest and, by burning its
 * budget, widened everyone else's — producing the giveaway signature that every failing
 * run missed by EXACTLY ONE reader. That made a red convergence verdict unable to
 * separate "the substrate failed" from "the box was loaded", which on a shared host
 * running an agent fleet is the difference between a release blocker and noise.
 *
 * Returns one entry per reader, in the SAME ORDER as `readers`; `event` is null on timeout.
 * `elapsedMs` is measured from the ONE shared start instant below — not from when this
 * reader's promise happened to be created — so the times are mutually comparable and
 * `budgetMs - max(elapsedMs)` is the run's true headroom (EI-20581532536662596).
 */
export async function awaitAllChildEvent<T extends CaughtUpWaitable>(
  readers: readonly T[],
  evt: string,
  budgetMs: number,
): Promise<Array<{ reader: T; event: ChildEvent | null; elapsedMs: number }>> {
  const startedAt = Date.now();
  return Promise.all(
    readers.map((reader) =>
      reader.waitFor(evt, budgetMs).then((event) => ({
        reader,
        event,
        elapsedMs: Date.now() - startedAt,
      })),
    ),
  );
}

/**
 * Per-reader time from the parent's `go` instant to the instant THAT reader
 * actually caught up — the number `floodCatchUpMs` / `ceilingOpsPerSec` are
 * supposed to report.
 *
 * EI-20582417177742601: the scenarios used to compute this as `Date.now() - tGo`
 * read inside the await loop, which measures WHEN THE PARENT GOT AROUND TO
 * OBSERVING the event rather than when it fired. Under the old SERIAL loop that
 * inflated every reader queued behind a slow one; the distortion grew with peer
 * count and with host load, so a metric that exists to answer "what is our max
 * replication throughput" partly measured the parent's own event-loop scheduling.
 * Several p2p-perf regression reports cite floodCatchUpMs deltas, so the confound
 * landed directly in the regression signal.
 *
 * ⚠ Converting such a loop to `awaitAllChildEvent` does NOT by itself fix it, and
 * the naive conversion is strictly worse: with concurrent waits every reader has
 * already resolved before the loop body runs, so a `Date.now() - tGo` in the body
 * stamps them ALL with the time the SLOWEST finished — collapsing the metric into
 * one repeated value that still looks like a distribution. Route every site
 * through here instead of open-coding the arithmetic.
 *
 * Preference order:
 *  1. the child's OWN `wallMs` (its catch-up instant on the shared host clock) —
 *     exact, contains zero parent lag;
 *  2. `tAwait - tGo + elapsedMs` — the concurrent parent-side measurement, used
 *     when `wallMs` is absent (a child predating the field, or a fake in a test).
 *
 * Both branches stay in the PARENT's wall-clock epoch. The child also emits `t`,
 * which is bootT0-relative and therefore NOT comparable to `tGo` — mixing those
 * two epochs is the specific error this helper exists to make unavailable.
 *
 * Returns null when `event` is null (the reader never caught up), so a
 * non-convergence can never be silently scored as a fast catch-up.
 */
export function catchUpElapsedMs(
  event: ChildEvent | null,
  opts: { tGo: number; tAwait: number; elapsedMs: number },
): number | null {
  if (!event) return null;
  const wallMs = event['wallMs'];
  if (typeof wallMs === 'number' && Number.isFinite(wallMs)) return wallMs - opts.tGo;
  return opts.tAwait - opts.tGo + opts.elapsedMs;
}

/** How many trailing stderr lines a handle keeps for `diagnostics()`. */
const STDERR_TAIL_LINES = 40;

export class PeerChildHandle {
  readonly events: ChildEvent[] = [];
  private waiters: Array<{
    pred: (e: ChildEvent) => boolean;
    resolve: (e: ChildEvent | null) => void;
  }> = [];
  exited = false;
  /** Set once the process has exited AND every stdio stream has drained — after this no
   *  further event can arrive, so every pending `waitFor` is settled with null. */
  closed = false;
  exitCode: number | null = null;
  exitSignal: NodeJS.Signals | null = null;
  private readonly stderrTail: string[] = [];

  constructor(
    readonly cfg: PeerChildConfig,
    readonly proc: ChildProcess,
    private readonly log: (line: string) => void,
  ) {
    let buf = '';
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const e = JSON.parse(line) as ChildEvent;
          this.events.push(e);
          this.waiters = this.waiters.filter((w) => {
            if (w.pred(e)) {
              w.resolve(e);
              return false;
            }
            return true;
          });
        } catch {
          this.log(`[child ${cfg.peerIndex}] ${line}`);
        }
      }
    });
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (chunk: string) => {
      for (const raw of chunk.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        this.log(`[child ${cfg.peerIndex} stderr] ${line}`);
        this.stderrTail.push(line);
        if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
      }
    });
    proc.on('exit', (code, signal) => {
      this.exited = true;
      this.exitCode = code;
      this.exitSignal = signal;
    });
    // 'close' fires after 'exit' AND after stdout/stderr have fully drained, so every event
    // the child managed to emit has already been parsed above. A waiter still pending here
    // is waiting for something that can no longer happen: settle it NOW rather than letting
    // it sit out its full timeout. Measured (WI-2141194 #9): a child that dies at module-link
    // time exits in ~3s, and before this the parent's `waitFor('ready', 30_000)` spent the
    // remaining ~27s reporting nothing — the failure was a timeout that named no cause.
    proc.on('close', () => {
      this.closed = true;
      const pending = this.waiters;
      this.waiters = [];
      for (const w of pending) w.resolve(null);
    });
  }

  /**
   * First event (past or future) matching `pred`, bounded by `timeoutMs`. Resolves null on
   * timeout — or IMMEDIATELY once the child has closed without emitting a match, since the
   * event can never arrive; read `diagnostics()` for why.
   */
  waitFor(pred: string | ((e: ChildEvent) => boolean), timeoutMs: number): Promise<ChildEvent | null> {
    const p = typeof pred === 'string' ? (e: ChildEvent) => e.evt === pred : pred;
    const past = this.events.find(p);
    if (past) return Promise.resolve(past);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== wrapped);
        resolve(null);
      }, timeoutMs);
      const wrapped = (e: ChildEvent | null) => {
        clearTimeout(timer);
        resolve(e);
      };
      this.waiters.push({ pred: p, resolve: wrapped });
    });
  }

  /**
   * One string naming WHY an awaited event never came: whether the child is still running,
   * how it exited, and the tail of its stderr. Meant for the message slot of an assertion, so
   * a null from `waitFor` fails with the child's own one-line cause (a link-time
   * `SyntaxError` from no-pg-stub.mjs, an unhandled rejection, a signal) instead of the bare
   * "expected null to match { evt: 'ready' }" that hid exactly that for days (WI-761481,
   * WI-2141194 #9).
   */
  diagnostics(): string {
    const state = !this.exited
      ? 'child still running'
      : this.exitSignal
        ? `child exited on signal ${this.exitSignal}`
        : `child exited with exit code ${this.exitCode}`;
    const events = this.events.map((e) => String(e.evt)).join(', ') || '(none)';
    const stderr = this.stderrTail.length ? this.stderrTail.join('\n    ') : '(empty)';
    return `[child ${this.cfg.peerIndex} ${this.cfg.role}] ${state}; events seen: ${events}; stderr tail:\n    ${stderr}`;
  }

  send(line: 'go' | 'stop' | 'ping' | 'wait-snapshot'): void {
    try {
      this.proc.stdin!.write(line + '\n');
    } catch {
      /* child already gone */
    }
  }

  /** `stop` + await result + exit. Null when the child died without a result. */
  async stopAndCollect(timeoutMs = 30_000): Promise<PeerChildResult | null> {
    const resultP = this.waitFor('result', timeoutMs);
    this.send('stop');
    const result = (await resultP) as PeerChildResult | null;
    if (!this.exited) {
      const exitP = once(this.proc, 'exit');
      const killTimer = setTimeout(() => this.proc.kill('SIGKILL'), 5000);
      await exitP;
      clearTimeout(killTimer);
    }
    return result;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    try {
      this.proc.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

export function spawnPeerChild(
  cfg: PeerChildConfig,
  log: (line: string) => void,
  opts: {
    /** Command prefix, e.g. ['ip','netns','exec','p1'] for the Tier-2 netns peers. */
    execPrefix?: string[];
  } = {},
): PeerChildHandle {
  // `--import tsx` FIRST (the child is TypeScript), then the no-PG resolution
  // hooks, so `@papercusp/db-org` is diverted to a throwing stub before any
  // substrate module resolves it. A perf peer never queries Postgres — it passes
  // applyOverride / loadRevokedOverride / verifyBindingOverride /
  // announceIdentityOverride — but the substrate's module graph reaches db-org by
  // 51 static paths, and one surviving edge loads the whole drizzle graph.
  // MEASURED (fresh process, `node --expose-gc --import tsx`, RSS after 3x GC):
  // peer-child's module graph is 247-254MB with db-org and 130-142MB without, so
  // this is ~112MB of pure import cost per peer for an ORM the child never calls
  // — ~29GB across 256 peers, and the dominant reason `decideMeshCapacity()`
  // refuses a mesh much above 64 on this host. Plan
  // harden-shared-hive-to-256-peers-2026-06-29 P-012 / D-024; see
  // perf/no-pg-hooks.mjs for the full rationale and why this is a rig-local
  // loader rather than ~40 lazy imports across production projection modules.
  //
  // GATED ON `!cfg.hivePubkey`, and that gate is load-bearing rather than
  // cautious. A paired smoke (one reader, local testnet, `ready` reached in both
  // arms) measured VmRSS 312.6MB without the loader and 179.4MB with it, boot
  // 8.4s vs 7.6s — but it also showed the ONE behavioural difference: with the
  // stub in place `buildHiveRekeyBootDeps` fail-opens (logged loudly as
  // `epoch_gate_skipped`) where the control completed it. For a `kind:'local'`
  // peer that resolves to the same null rekeyDeps either way, since the re-key is
  // inert without a hive. For a HIVE-bound peer it would not: those scenarios
  // exercise the re-key path deliberately and must keep the real db-org. So a
  // hive peer pays the memory and a local peer does not — the >64-peer mesh
  // ladder this exists for is local-bound.
  const noPgLoader = !cfg.hivePubkey;
  const argv = [
    ...(opts.execPrefix ?? []),
    process.execPath,
    '--import',
    'tsx',
    ...(noPgLoader ? ['--import', NO_PG_REGISTER_PATH] : []),
    CHILD_PATH,
  ];
  const proc = spawn(argv[0], argv.slice(1), {
    env: {
      ...process.env,
      P2P_PERF_CHILD: JSON.stringify(cfg),
      // Children must never inherit a vitest/test PG context by accident.
      NODE_ENV: 'test',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new PeerChildHandle(cfg, proc, log);
}

export interface ProcMesh {
  writer: PeerChildHandle;
  readers: PeerChildHandle[];
  roots: { writer: string; readers: string[] };
  bootstrap: Array<{ host: string; port: number }>;
  workspaceId: string;
  harnessSlug: string;
  teardown(): Promise<void>;
}

/**
 * Spawn a writer + N readers, each its own OS process, all joined to one
 * local-testnet swarm topic. Resolves once every reader has admitted the
 * writer's log (the mesh is ready for a load phase). Pass `bootstrap` to ride
 * an externally-owned testnet (churn re-spawns need the DHT to outlive the
 * mesh); otherwise a testnet is created and torn down with the mesh.
 */
export async function spawnProcMesh(opts: {
  readers: number;
  log: (l: string) => void;
  writerCfg?: Partial<PeerChildConfig>;
  readerCfg?: Partial<PeerChildConfig>;
  meshTimeoutMs?: number;
  bootstrap?: Array<{ host: string; port: number }>;
  /** Reuse roots (churn re-spawn). Default: fresh tmp dirs. */
  roots?: { writer: string; readers: string[] };
  /** Per-peer spawn prefix (Tier-2: ['ip','netns','exec',`p${i}`]). Index 0 = writer. */
  execPrefixFor?: (peerIndex: number) => string[] | undefined;
  /** Test seam: factory for each peer child (default `spawnPeerChild`). Lets a
   *  unit test drive mesh-formation OUTCOMES — and assert the typed
   *  `MeshFormationError` (EI-115) — without spawning real OS processes. */
  spawnChild?: typeof spawnPeerChild;
  /** Test seam: override the host's reported MemAvailable for the capacity
   *  preflight. `null` = host does not report it (guard abstains). */
  availableBytes?: number | null;
}): Promise<ProcMesh> {
  const mkChild = opts.spawnChild ?? spawnPeerChild;

  // Capacity preflight — BEFORE any testnet, tmpdir or child exists, so a mesh
  // that cannot fit costs nothing and leaves nothing to clean up. See
  // host-capacity.ts for the measurement this is anchored on.
  const capacity = decideMeshCapacity({
    peers: opts.readers + 1, // + the writer
    availableBytes: opts.availableBytes !== undefined ? opts.availableBytes : readMemAvailableBytes(),
    ...capacityOverridesFromEnv(),
  });
  // WI-41206 / remove-memory-derived-work-refusals-2026-08-24: ADVISORY, never a refusal.
  // This used to throw HostCapacityError. A memory projection may warn that a resulting
  // convergence number could be swap-distorted and therefore unquotable — it must not decide
  // that the operator may not run the mesh at all.
  if (capacity.reason) opts.log(`[mesh] ${capacity.reason}`);

  let ownedTestnet: { destroy(): Promise<void> } | null = null;
  let bootstrap = opts.bootstrap;
  if (!bootstrap) {
    const testnet = await createTestnet(3);
    ownedTestnet = testnet;
    bootstrap = (testnet.bootstrap as Array<{ host: string; port: number }>).map((b) => ({
      host: b.host,
      port: b.port,
    }));
  }
  const workspaceId = 'ws-p2p-perf-proc';
  const harnessSlug = 'perf-proc';
  const dirs: string[] = [];
  const mkRoot = (p: string) => {
    const d = mkdtempSync(join(tmpdir(), p));
    dirs.push(d);
    return d;
  };
  const roots = opts.roots ?? {
    writer: mkRoot('p2p-perf-w-'),
    readers: Array.from({ length: opts.readers }, (_, i) => mkRoot(`p2p-perf-r${i}-`)),
  };

  const writer = mkChild(
    {
      role: 'writer',
      workspaceId,
      harnessSlug,
      root: roots.writer,
      bootstrap,
      peerIndex: 0,
      ...opts.writerCfg,
    },
    opts.log,
    { execPrefix: opts.execPrefixFor?.(0) },
  );
  // Writer first (it may pre-seed history); readers join once it is ready.
  const meshTimeout = opts.meshTimeoutMs ?? 120_000;
  const writerReady = await writer.waitFor('ready', meshTimeout);
  if (!writerReady) {
    writer.kill('SIGKILL');
    throw new MeshFormationError('proc mesh: writer never became ready');
  }

  const readers = Array.from({ length: opts.readers }, (_, i) =>
    mkChild(
      {
        role: 'reader',
        workspaceId,
        harnessSlug,
        root: roots.readers[i],
        bootstrap,
        peerIndex: i + 1,
        ...opts.readerCfg,
      },
      opts.log,
      { execPrefix: opts.execPrefixFor?.(i + 1) },
    ),
  );

  for (const r of readers) {
    const ok = (await r.waitFor('ready', meshTimeout)) && (await r.waitFor('admitted', meshTimeout));
    if (!ok) {
      writer.kill('SIGKILL');
      for (const rr of readers) rr.kill('SIGKILL');
      throw new MeshFormationError(
        `proc mesh: reader ${r.cfg.peerIndex} never admitted the writer`,
        r.cfg.peerIndex,
      );
    }
  }

  return {
    writer,
    readers,
    roots,
    bootstrap,
    workspaceId,
    harnessSlug,
    async teardown() {
      writer.kill('SIGKILL');
      for (const r of readers) r.kill('SIGKILL');
      if (ownedTestnet) {
        try {
          await ownedTestnet.destroy();
        } catch {
          /* ignore */
        }
      }
      for (const d of dirs) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    },
  };
}

/** Fold child results into the artifact: worst-child lag is the SLO basis
 *  (the parent's own loop only orchestrates — P-007/D-003 judge the peers). */
export function foldChildResults(
  meter: ScenarioMeter,
  artifactPatch: (a: PerfArtifact) => void,
  results: Array<PeerChildResult | null>,
): PerfArtifact {
  const lagP95 = meter.metric('childLoopLagP95Ms', 'ms');
  const rss = meter.metric('childRssPeak', 'bytes');
  let worst: PeerChildResult['loopLag'] | null = null;
  for (const r of results) {
    if (!r) continue;
    lagP95.push(r.loopLag.p95Ms);
    rss.push(r.rssPeakBytes);
    if (!worst || r.loopLag.p95Ms > worst.p95Ms) worst = r.loopLag;
  }
  const artifact = meter.finish();
  if (worst) {
    artifact.loopLag = worst;
    artifact.sloPassed = worst.p95Ms < artifact.sloLimitMs;
  }
  artifactPatch(artifact);
  // The patch is what attaches `appendToVisibleMs`, so the latency half of the
  // convergence verdict can only be judged here, after it (EI-20576392705164447).
  recomputeConvergenceVerdict(artifact);
  return artifact;
}
