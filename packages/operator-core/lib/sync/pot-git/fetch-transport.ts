/**
 * pot-git/fetch-transport.ts — native git protocol-v2 fetch over an injected
 * duplex (Phase 7 G-2, cross-machine-coord-parity-and-trust-2026-07-01 / P-026,
 * D-010/D-011).
 *
 * THE decision (research doc → D-010): replicate git OBJECTS with the real git
 * wire protocol (v2 pack negotiation), NOT bundles and NEVER loose objects. Each
 * fetch is one request/response byte stream between two peers; the peer serving
 * runs `git upload-pack`, the peer fetching runs `git fetch`. This module is the
 * transport CORE, pure over an injected `Duplex`:
 *
 *   - PROD: the duplex is a PER-FETCH Protomux sub-stream on the existing hive
 *     swarm connection (the `papercusp/pot-git` channel family — wired
 *     separately, the way presence-gossip wires its chassis). One stream per
 *     fetch so it opens/closes independently of the shared socket.
 *   - TESTS: the duplex is a plain socket pair — so the whole path (real
 *     upload-pack ↔ real fetch, real pack negotiation, real bare repos) runs
 *     offline with no swarm.
 *
 * The client half cannot hand git an arbitrary fd, so it uses git's native
 * `ext::` transport: git execs `node git-ext-bridge.mjs <sock>` as the
 * connection command, and we bridge that unix socket to the caller's duplex.
 * `protocol.ext.allow=always` is required (git blocks ext by default) — safe
 * here because WE construct the command, not a remote.
 *
 * Fail-soft by contract: every path is try/catch + never-throw; a broken fetch
 * resolves with a nonzero code, never rejects (the integrator/announcement layer
 * treats a failed fetch as "try again next announce").
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createTextCollector } from '../../child-output.js';
import { resolveBundledNode } from '../../bundled-node';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';
import { deviceNamespaceKey, noteFetchInFlight, potGitRoot } from './storage';
import { isScopeRepoFamilyPath } from './scope-repo';
import { type ScopeRepoServeGrant, isIssuedScopeServeGrant } from './scope-serve-gate';

/** The ext:: bridge helper git execs on the client (a real on-disk node script). */
const EXT_BRIDGE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'git-ext-bridge.mjs');

/**
 * Escape ONE literal argv token for git's `ext::` command line.
 *
 * git-remote-ext(1): "Command and arguments are separated by an unescaped
 * space", with `'% '` meaning a literal space and `%%` a literal percent sign.
 * Percent MUST be escaped first — doing spaces first would then re-escape the
 * `%` this function just introduced, turning `% ` into `%% `.
 */
function escapeExtToken(token: string): string {
  return token.replace(/%/g, '%%').replace(/ /g, '% ');
}

/**
 * Build an `ext::` transport URL from LITERAL argv tokens, escaped so git
 * reconstructs them exactly (see {@link escapeExtToken}).
 *
 * ## Why this exists (WI-37735 — shipped, then found on a real 0.0.14 install)
 *
 * The url used to be a plain template string, guarded only by a comment
 * asserting that "EXT_BRIDGE_PATH/sockPath live under tmp/dist dirs with no
 * spaces, so a plain command is safe". That is true of the dev tree and false
 * of every real macOS install: the bridge sits beside THIS module, and a
 * packaged app's own default location is `/Applications/Papercusp GUI.app/…`.
 * git split the command at that space, handed `node` the prefix alone, and the
 * ref-announce receive-fetch died `Cannot find module '/Applications/Papercusp'`
 * on every tick — self-retrying forever, so pot-git replication simply never
 * converged on macOS.
 *
 * The class is "any install path containing a space", not "/Applications", so
 * the escape is applied to every token rather than to one known prefix.
 */
export function formatExtTransportUrl(argv: readonly string[]): string {
  return `ext::${argv.map(escapeExtToken).join(' ')}`;
}

/**
 * The interpreter token for the `ext::` command — an ABSOLUTE path to the
 * bundled node whenever this process can see it.
 *
 * ## Why this is not a bare `node` (EI-20078551747038927)
 *
 * git execs the ext command itself, inheriting whatever PATH the sidecar
 * carries — and on a packaged install that is not guaranteed to contain node at
 * all. On the macOS 0.0.14 VM a non-interactive shell had NO node on PATH
 * (`node: command not found`) even though the app was running its own bundled
 * runtime at `…/Contents/Resources/sidecar/bin/node`. A bare token resolves on
 * the dev box and fails on exactly the installs that matter.
 *
 * The failure is silent by construction, which is why it is worth resolving
 * deliberately: the fetch fail-softs by contract, so a broken interpreter shows
 * up only as a per-tick stderr line while pot-git replication never converges
 * and self-retries forever — the same shape that let WI-37735 ship unnoticed.
 *
 * `resolveBundledNode` deliberately does NOT fall back to `process.execPath` in
 * a packaged build (there it is the Tauri binary, not node — EI-2114), so the
 * bare-`node` fallback below is the honest last resort: it is what a dev tree
 * with node on PATH has always used, and it is no worse than the old behaviour
 * anywhere else. The resolved binary is plain node, never a loader wrapper, so
 * it boots quietly for the pack stream (see the NODE_OPTIONS strip at the
 * spawn site).
 */
export async function extNodeCommand(): Promise<string> {
  return (await resolveBundledNode()) ?? 'node';
}

/** Protomux protocol id for the per-fetch git streams (the wiring opens one
 *  channel of this protocol per in-flight fetch, keyed by the hive topic). */
export const POT_GIT_PROTOCOL = 'papercusp/pot-git';

/**
 * Default per-fetch IDLE ceiling (ms) — a fetch that moves NO bytes in either
 * direction for this long is killed, so a hostile or wedged peer can't pin a
 * stream open forever.
 *
 * ⚠ THIS IS AN IDLE TIMEOUT, NOT A WALL-CLOCK ONE (EI-18776567787336109). It
 * used to be measured from spawn, which conflated two opposite conditions:
 *
 *   - a STALLED transfer (no bytes moving)        → must die fast
 *   - a LARGE but healthy transfer (bytes flowing) → must NOT be killed
 *
 * A wall-clock ceiling makes a large pot structurally un-joinable: the tower's
 * 6.3 GB papercusp store spends well over 120 s in upload-pack's counting/
 * compressing phase alone, so EVERY cold-join fetch died at exactly 120 s while
 * warm incremental fetches finished in 100-650 ms (live, 2026-07-27: 8/8 cold
 * fetches timed out, 101/101 warm fetches succeeded). Worse, the ladder's
 * last-resort `--unshallow` rung is unbounded in size BY DESIGN, so no rung
 * size could ever have rescued it.
 *
 * Resetting the deadline on progress preserves the original anti-wedge
 * guarantee EXACTLY — no progress for this long and the child is SIGKILLed —
 * while letting a genuinely large transfer run to completion.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 120_000;

/**
 * Absolute per-fetch ceiling (ms), regardless of progress. The idle timeout
 * above is the operative guard; this one exists so a hostile peer that
 * slow-drips a byte every 119 s still cannot pin a stream open indefinitely.
 * Generous on purpose — a multi-GB cold join over a p2p link legitimately takes
 * many minutes, and killing one that is actively streaming is the exact bug
 * this module just stopped having.
 */
export const DEFAULT_FETCH_MAX_MS = 30 * 60_000;

export interface TransportResult {
  /**
   * git process exit code (0 = success).
   *
   * ⚠ `-1` is an OVERLOADED sentinel — it does NOT mean "git never ran". THREE
   * different situations collapse onto it: the spawn itself failing
   * (`child.on('error')`, the only case where no process existed), the sync
   * `catch` around the spawn, and — by far the most common in the field — git
   * running normally and then dying by a SIGNAL, because `child.on('close')`
   * reports `code === null` for a signalled child and we coalesce that with
   * `code ?? -1`. A caller that reads -1 as "no git process ran" will print a
   * self-contradiction the moment `stderr` is non-empty; non-empty stderr is
   * positive proof git ran. See the label at git-sync-action.ts (ref-announce
   * receive) for the honest phrasing.
   */
  code: number;
  /** Captured stderr (diagnostics; never surfaced to a peer). */
  stderr: string;
  /**
   * True when a CEILING fired — the idle timeout or the absolute ceiling.
   *
   * NOT "the process was killed": a serve is also killed when the requester's
   * duplex goes away or the caller aborts, and neither is a timeout. Conflating
   * them (EI-18808621019872598) logged 169ms serves as `timedOut=true` against a
   * 120000ms ceiling, which reads as "raise the timeout" for what is really a
   * connection teardown. The kill itself is witnessed by `stderr`, which always
   * carries the reason killChild recorded.
   */
  timedOut: boolean;
}

/**
 * Optional durable-admission wrapper for the serving process boundary.
 *
 * `serveUploadPack` is a transport primitive and therefore keeps its
 * low-level tests usable without a workspace runtime. The live
 * `serve-wiring` caller supplies this callback so the `git upload-pack`
 * lifetime is covered by the shared governor lease.
 */
export type GovernedServeExecution = (
  run: () => Promise<TransportResult>,
) => Promise<TransportResult>;

/** Guard: only ever serve upload-pack for a repo INSIDE our pot-git root — a
 *  defense-in-depth backstop so a wiring bug can't turn this into an arbitrary
 *  repo-read oracle for a peer. The (hive, repo) → path mapping already sanitizes
 *  components (storage.hiveGitRepoPath), this re-checks the resolved path. */
function assertServeableRepo(repoPath: string): void {
  const root = potGitRoot();
  if (repoPath !== root && !repoPath.startsWith(root.endsWith('/') ? root : `${root}/`)) {
    throw new Error(`pot-git: refusing to serve a repo outside the pot-git root: ${repoPath}`);
  }
}

/** §5.3 fail-closed serve gate for the per-scope repo family (P-108 / D-018
 *  option b): any path inside `<root>/<hive>/scopes/` is UNSERVABLE without a
 *  roster-verified grant from `authorizeScopeRepoServe`, bound to this exact
 *  path — so future serve wiring structurally cannot skip the membership
 *  check. Checked regardless of `allowOutsideRoot` (an out-of-root test path
 *  is not in the family, so tests are unaffected). */
function assertScopeServeAuthorized(repoPath: string, grant?: ScopeRepoServeGrant): void {
  if (!isScopeRepoFamilyPath(repoPath)) return;
  if (!grant || !isIssuedScopeServeGrant(grant) || grant.repoPath !== repoPath) {
    throw new Error(
      `pot-git: refusing to serve scope repo without a roster-verified serve grant: ${repoPath}`,
    );
  }
}

/**
 * SERVER half — serve `git upload-pack` (protocol v2) for `repoPath` over
 * `duplex`, piping duplex↔child both ways. Ends `duplex` when upload-pack exits
 * (the per-fetch stream is disposable). Resolves with the exit result; never
 * throws. `allowOutsideRoot` (tests only) skips the root guard.
 */
function serveUploadPackUnmanaged(
  repoPath: string,
  duplex: Duplex,
  opts: {
    /** IDLE ceiling — reset on every byte of progress. See
     *  {@link DEFAULT_FETCH_TIMEOUT_MS}. */
    timeoutMs?: number;
    /** Absolute ceiling regardless of progress. See {@link DEFAULT_FETCH_MAX_MS}. */
    maxMs?: number;
    allowOutsideRoot?: boolean;
    /** REQUIRED for any repo in the scopes/ family (§5.3 roster serve gate). */
    scopeServeGrant?: ScopeRepoServeGrant;
    /** EI-18802033487678337: abort this serve (SIGKILL the child) on demand —
     *  used by `serve-wiring` to stand down a serve that a newer request for
     *  the same repo on the same channel has superseded. */
    signal?: AbortSignal;
    /**
     * EI-18776567787336109 (secondary defect): called ONCE, synchronously, the
     * moment this serve is KNOWN to have failed and — critically — BEFORE the
     * duplex is ended, so the caller can put the reason on the wire while the
     * requester's session still exists.
     *
     * The ordering is the whole point: ending the duplex sends the end frame,
     * and the requester DELETES its session on that frame
     * (serve-wiring.handleEndToClient), so any reason sent afterwards is
     * silently dropped. Before this hook the serving side knew exactly why it
     * failed (`timedOut=true`, a guard refusal, a spawn error), logged it
     * locally, and told the requester NOTHING — the peer saw only a bare EOF
     * and reported "serve channel closed". That opacity is what made a
     * 120s-ceiling bug undiagnosable from the joining machine and cost several
     * diagnosis wakes chasing the wrong half of a two-machine system.
     */
    onFailure?: (reason: string) => void;
    /** Durable governor wrapper supplied by the live serve wiring. */
    governedExecution?: GovernedServeExecution;
  } = {},
): Promise<TransportResult> {
  return new Promise((resolve) => {
    // Created before the spawn because the authorization failure path below
    // appends a reason and resolves without ever starting a child.
    const stderrOut = createTextCollector();
    let settled = false;
    let timedOut = false;
    let failureReported = false;
    /** Fire the onFailure hook at most once, never letting it throw into us. */
    const reportFailure = (reason: string): void => {
      if (failureReported) return;
      failureReported = true;
      try {
        opts.onFailure?.(reason);
      } catch {
        /* best-effort — the channel may already be gone */
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const idleMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const maxMs = opts.maxMs ?? DEFAULT_FETCH_MAX_MS;
    let bytesServed = 0;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      resolve({ code, stderr: stderrOut.text(), timedOut });
    };
    try {
      if (!opts.allowOutsideRoot) assertServeableRepo(repoPath);
      assertScopeServeAuthorized(repoPath, opts.scopeServeGrant);
    } catch (e) {
      stderrOut.append(e instanceof Error ? e.message : String(e));
      reportFailure(`serve refused: ${e instanceof Error ? e.message : String(e)}`);
      try {
        duplex.end();
      } catch {
        /* ignore */
      }
      finish(-1);
      return;
    }
    const child = spawn('git', ['upload-pack', '--strict', repoPath], {
      env: { ...process.env, GIT_PROTOCOL: 'version=2', LC_ALL: 'C', LANG: 'C' },
    });
    /**
     * `kind` separates a CEILING firing (the idle / absolute timers below) from
     * an ABANDONMENT (the requester's duplex went away, or our caller aborted).
     * Both kill the child, but only the former is a timeout.
     *
     * EI-18808621019872598: this used to set `timedOut = true` unconditionally,
     * so every abandonment was reported as a timeout. Measured on the tower
     * 2026-08-08T17:01Z, serves lasting 169ms / 238ms / 241ms were all logged
     * `code=-1 timedOut=true` against a 120000ms idle ceiling — a signal that
     * invites a timeout-TUNING fix for what is actually a connection teardown.
     * That misattribution cost real diagnosis time on this exact blocker, so
     * `kind` is required rather than defaulted: a new call site must say which
     * it is instead of silently inheriting the wrong one.
     */
    const killChild = (why: string, kind: 'timeout' | 'abandon'): void => {
      if (kind === 'timeout') timedOut = true;
      stderrOut.append(`\nupload-pack ${why} (served ${bytesServed}B)`);
      // Report HERE, at the moment of the decision, not from the 'close'
      // handler's generic fallback: this names the ceiling that actually fired
      // and does not depend on SIGKILL→'close' being prompt.
      reportFailure(`upload-pack ${why} (served ${bytesServed}B)`);
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    };
    // IDLE ceiling: armed now, rearmed on every byte of progress in EITHER
    // direction. A transfer that is still streaming never trips it; one that
    // has genuinely stalled dies exactly as fast as it used to.
    const armIdle = (): void => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => killChild(`timed out after ${idleMs}ms idle`, 'timeout'), idleMs);
      timer.unref?.();
    };
    armIdle();
    // ABSOLUTE ceiling: never rearmed, so a slow-drip peer still cannot pin the
    // stream open forever.
    hardTimer = setTimeout(
      () => killChild(`timed out after ${maxMs}ms (absolute ceiling)`, 'timeout'),
      maxMs,
    );
    hardTimer.unref?.();
    stderrOut.attach(child.stderr);
    child.stderr.on('data', () => {
      // upload-pack's counting/compressing phase on a multi-GB repo emits
      // progress here while stdout is still silent — that IS liveness, and
      // treating it as idle is what killed every large cold join.
      armIdle();
    });
    /**
     * EI-18802033487678337 — THE ORPHANED-SERVE ROOT CAUSE.
     *
     * Before this, nothing killed `upload-pack` when the REQUESTER went away.
     * `duplex.on('error')` was a bare crash-guard, and a destroyed duplex is
     * exactly what a channel close produces (`serve-wiring.failAllSessions`
     * destroys every in-flight session; pot-git channels churn 23-36x/min). So
     * the child kept running with nowhere to send bytes — and, worse, its own
     * `child.stdout`/`child.stderr` output kept calling `armIdle()`, so the
     * IDLE ceiling could never fire either. The serve then ran to the ABSOLUTE
     * ceiling: 30 MINUTES of `pack-objects` on a multi-GB repo, per orphan.
     *
     * Live on the tower 2026-07-27: 3+ concurrent `pack-objects` on the same
     * 4.1G repo (1.0-1.7GB RSS and 40-126% CPU EACH), spawned ~15s apart, with
     * serves logging 120-566s wall time against a requester whose own ceiling
     * is 120s. Every one of those serves was already unreachable when it
     * started burning the box. This is a self-amplifying loop: the orphans slow
     * the next real serve past the requester's ceiling, which abandons it,
     * which creates another orphan.
     *
     * A duplex that is closed or errored can never deliver a pack, so there is
     * nothing to preserve by continuing — kill immediately and report, exactly
     * as a ceiling would. Idempotent via `settled`/`failureReported`; the
     * normal completion path has already settled by the time `duplex.end()`
     * asynchronously emits its own 'close'.
     */
    const abandon = (why: string): void => {
      if (settled) return;
      killChild(why, 'abandon');
    };
    // Never let a stream error crash the host (peer resets, EPIPE mid-pack).
    //
    // EI-18808621019872598: "requester duplex errored" NAMES THE WRONG PARTY in
    // the common case. A destroyed duplex is exactly what a LOCAL channel close
    // produces — `serve-wiring.failAllSessions` destroys every in-flight session
    // with `d.destroy(new Error('pot-git: serve channel closed …'))` — so this
    // handler fires for our own teardown just as readily as for a peer fault,
    // and the bare string sends diagnosis to the peer either way. Carrying the
    // underlying message through makes the two distinguishable at a glance
    // without coupling this module to serve-wiring's wording (serve-wiring
    // imports THIS file, so a shared constant would be a cycle).
    duplex.on('error', (e?: Error) => {
      const detail = e?.message ? ` (${e.message})` : '';
      abandon(`abandoned: requester duplex errored${detail}`);
    });
    duplex.on('close', () => abandon('abandoned: requester duplex closed'));
    // WI-6373/EI-18802033487678337: the serving side may also be told to stand
    // down by its caller (a newer request for the same repo on the same channel
    // supersedes this one — see serve-wiring.resolveServeAdmission).
    if (opts.signal) {
      const sig = opts.signal;
      if (sig.aborted) {
        abandon(`aborted: ${String(sig.reason ?? 'cancelled')}`);
      } else {
        sig.addEventListener('abort', () => abandon(`aborted: ${String(sig.reason ?? 'cancelled')}`), {
          once: true,
        });
      }
    }
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    // Safe to attach 'data' alongside the pipes below: `.pipe()` already puts
    // both in flowing mode and Node delivers each chunk to EVERY listener, so
    // these counters never consume or steal bytes (same reasoning as the
    // client half's byte counters).
    duplex.on('data', armIdle);
    child.stdout.on('data', (d: Buffer | string) => {
      bytesServed += typeof d === 'string' ? Buffer.byteLength(d) : d.length;
      armIdle();
    });
    duplex.pipe(child.stdin);
    // `{ end: false }` is load-bearing, not a style choice. The default
    // `end: true` ends the duplex the instant child.stdout hits EOF — which is
    // BEFORE the child's 'close' event, so the end frame would always beat the
    // failure reason onto the wire and the requester (which deletes its session
    // on that frame) could never be told why a nonzero exit happened. Ending is
    // now done explicitly in the 'close'/'error' handlers below, after
    // `reportFailure`, so the ordering is ours rather than a pipe side effect.
    child.stdout.pipe(duplex, { end: false });
    child.on('error', (e) => {
      stderrOut.append(String(e));
      reportFailure(`upload-pack spawn failed: ${e instanceof Error ? e.message : String(e)}`);
      // WI-6184: END the duplex here too, not only in the 'close' handler. A
      // spawn failure (`spawn git ENOENT` — live-observed once on the tower
      // bg-host) is not guaranteed to also emit 'close', and without an end
      // frame the REQUESTER is told nothing: it waits out its full 120s fetch
      // ceiling and reports a bare timeout, hiding a purely local, instantly
      // knowable failure. Ending is idempotent, so the common 'error'-then-
      // 'close' ordering is unaffected.
      try {
        duplex.end();
      } catch {
        /* ignore */
      }
      finish(-1);
    });
    child.on('close', (code) => {
      // A nonzero exit is a real failure the requester must be told about; a
      // timeout already reported its (more specific) reason from killChild.
      if ((code ?? -1) !== 0) {
        reportFailure(
          `upload-pack exited ${code ?? -1}: ${stderrOut.text().trim().slice(0, 200) || 'no stderr'}`,
        );
      }
      try {
        duplex.end();
      } catch {
        /* ignore */
      }
      finish(code ?? -1);
    });
  });
}

/**
 * SERVER half — govern the actual `git upload-pack` process when the caller
 * provides the live workspace admission seam. The transport tests call this
 * primitive directly with no workspace context; production wiring always
 * passes `governedExecution` so no capacity cap is needed here.
 */
export function serveUploadPack(
  repoPath: string,
  duplex: Duplex,
  opts: Parameters<typeof serveUploadPackUnmanaged>[2] = {},
): Promise<TransportResult> {
  const { governedExecution, ...transportOpts } = opts;
  const run = (): Promise<TransportResult> => serveUploadPackUnmanaged(repoPath, duplex, transportOpts);
  const runGovernedOperation = governedExecution;
  return runGovernedOperation ? runGovernedOperation(run) : run();
}

/**
 * CLIENT half — fetch `refspecs` into the local bare repo `localRepoPath` from a
 * peer, driving native `git fetch` (protocol v2) over `duplex` via the ext::
 * bridge. Bridges a temp unix socket → `duplex`; git's ext helper connects to
 * that socket. Resolves with the exit result; never throws. Cleans up the socket
 * + temp dir on completion.
 */
export interface FetchOverDuplexOptions {
  /** IDLE ceiling — rearmed on every byte of progress in either direction, and
   *  on git's own progress output. See {@link DEFAULT_FETCH_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Absolute ceiling regardless of progress. See {@link DEFAULT_FETCH_MAX_MS}. */
  maxMs?: number;
  /** WI-6189 resumable cold-join: `--depth=<n>` — request a SHALLOW fetch
   *  truncated to `n` commits per tip. The ladder's first rung: for the
   *  papercusp pot-home store this is a 78 MB transfer against 2.5 GB for the
   *  full history. Mutually exclusive with {@link deepen}. */
  depth?: number;
  /** WI-6189: `--deepen=<n>` — extend an ALREADY-shallow repo by `n` more
   *  commits per tip. Each successful deepen is durably committed to the local
   *  ODB + refs, so an interrupted ladder resumes from where it stopped
   *  instead of restarting. Mutually exclusive with {@link depth}. */
  deepen?: number;
  /** WI-6189: `--unshallow` — convert a shallow store to a complete one in a
   *  single transfer. The ladder's LAST-RESORT rung, used only when a `--deepen`
   *  rung lands without moving the shallow boundary (git will hand over no more
   *  at that granularity). Unbounded in size, so never the default path.
   *  Requires an already-shallow repo. */
  unshallow?: boolean;
  /** Suppress git's automatic tag-following. The bootstrap ladder sets this:
   *  auto-followed tags land OUTSIDE the requested refspec (in `refs/tags/*`),
   *  dragging in history nobody asked for and making a shallow rung's transfer
   *  size unpredictable. */
  noTags?: boolean;
  /** Remove destination refs covered by the supplied refspec when the peer no
   *  longer advertises them. Use only when the fetched refspec is an
   *  authoritative mirror: ordinary one-off fetches must not delete local
   *  receiver state. */
  prune?: boolean;
}

export function fetchOverDuplex(
  localRepoPath: string,
  duplex: Duplex,
  refspecs: string[],
  opts: FetchOverDuplexOptions = {},
): Promise<TransportResult> {
  return new Promise((resolve) => {
    // Created before the spawn: several setup failure paths below append a
    // reason and resolve without ever starting a child.
    const stderrOut = createTextCollector();
    let settled = false;
    let timedOut = false;
    let tmpDir: string | null = null;
    // Tracked so the OUTER ceiling timer (below) can actually kill whatever's
    // in flight — a child process, or nothing yet if we're still stuck in
    // mkdtemp/server.listen setup.
    let child: ChildProcessWithoutNullStreams | null = null;
    // ── WI-6184 timeout forensics ──
    // A bare "fetch timed out after 120000ms" is undiagnosable: it cannot
    // distinguish "the peer never answered at all" from "the peer answered and
    // then stalled mid-pack" — and those have completely different causes (a
    // silently-swallowed serve error vs. a dying transport). Counting bytes in
    // each direction makes the timeout message name which one happened, on the
    // DIALING box, without a cross-machine log read (the exact gap that stalled
    // five diagnosis wakes — see git-sync-action.ts:1746-1757).
    //
    // Safe to attach alongside the pipes below: `duplex`/`conn` are ALREADY put
    // in flowing mode by `.pipe()`, and Node delivers each chunk to EVERY
    // 'data' listener, so an extra counter never consumes or steals bytes.
    // (Contrast swarm.ts's warning about adding a 'data' listener to a socket
    // that is NOT piped — that would switch it to flowing and eat bytes.)
    let bytesFromPeer = 0;
    let bytesToPeer = 0;
    let bridgeConnected = false;
    // Idle + absolute ceilings (EI-18776567787336109). `timer` is REARMED on
    // every byte of progress, so a large-but-healthy fetch is never killed;
    // `hardTimer` is never rearmed and bounds the whole fetch absolutely.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const idleMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const maxMs = opts.maxMs ?? DEFAULT_FETCH_MAX_MS;
    // Never let a stream error crash the host — attached SYNCHRONOUSLY, before
    // any await, so an already-destroyed/decoy duplex (the documented
    // DIAL-REGISTRY GAP idiom several callers use — a pre-destroyed stub
    // returned when there's no live dial path yet: pot-git-gc-action /
    // git-sync-action's bootstrap+ref-announce legs, peer-dial-registry.ts's
    // openHiveGitDuplexToDevice) can never emit an unhandled 'error' event.
    // Below (in the real `server.on('connection', ...)` path) a SECOND
    // `duplex.on('error', () => {})` is attached once a real connection
    // exists — harmless double-attach, EventEmitter supports multiple
    // listeners on the same event.
    //
    // FAIL FAST on a destroyed duplex (EI-8863/WI-3643, su-95401d6d's
    // handoff finding): a `.destroy(err)` on the injected duplex means the
    // PEER already refused or the channel/connection dropped (serve-wiring.ts's
    // handleRefuse / failAllSessions) — there is nothing left to wait for.
    // Previously this listener was a pure no-op, so a refused fetch sat until
    // the OUTER ceiling timer (`opts.timeoutMs`) fired regardless —
    // serve-wiring.integration.test.ts's 3 refusal-path tests each burned
    // their FULL 15s timeout on an instant refusal, fragile under host load
    // (the "hangs, times out near 90s" symptom the handoff reproduced).
    // Finish immediately instead — mirrors the fail-soft contract (never
    // throws, never crashes) while resolving as fast as the real signal
    // allows.
    duplex.on('error', (err) => {
      if (settled) return;
      stderrOut.append(`\nduplex error: ${err instanceof Error ? err.message : String(err)}`);
      try {
        child?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish(-1);
    });
    // allowHalfOpen:true so a FIN on either leg does NOT destroy the socket
    // before its buffered bytes flush — the git pack is delimited in-band, so a
    // premature destroy truncates it ("bad pack header"). Default end:true pipes
    // then propagate each half-close cleanly.
    const server = createServer({ allowHalfOpen: true });
    /**
     * EI-18765930091826096: THIS FETCH OWNS THE DUPLEX'S LIFETIME — release it
     * when the fetch settles, on EVERY path (success, refusal, ceiling).
     *
     * Nothing here used to end or destroy the caller's duplex at all: `finish`
     * closed our LOCAL unix bridge and removed the tmpdir, and the peer-facing
     * duplex was simply dropped on the floor still open. For a pot-git
     * `FrameDuplex` that is a two-sided leak, and it is the mechanism behind a
     * peer channel that degrades until it can serve nothing:
     *
     *   - the PEER is never told we left. `FrameDuplex._final` (which sends the
     *     `end` frame) only runs on a graceful `.end()`, so an abandoned rung
     *     left the serving side's `git upload-pack` running against an open
     *     stdin until ITS own ceiling — one zombie upload-pack per failed rung,
     *     still generating and pushing pack bytes at us.
     *   - OUR side kept absorbing those bytes. The session stayed registered in
     *     `clientSessions`, so every inbound data frame was buffered into a
     *     duplex whose only reader (git) had already been SIGKILLed.
     *
     * A cold-join ladder fails rungs BY DESIGN, so this accumulated per tick and
     * was freed only by the connection dying — i.e. only by a process restart,
     * exactly the observed signature.
     *
     * Ordering matters: `end()` first so `_final` fires and the end frame
     * actually reaches the peer, and only THEN destroy (which would abort a
     * pending `_final` and swallow the frame). The unref'd fallback timer covers
     * a writable side that can never finish because the transport is already
     * gone — without it, a dead-transport abandon would leak the very session
     * this is here to release.
     */
    const releasePeerDuplex = (): void => {
      try {
        if (duplex.destroyed) return;
        const hardRelease = (): void => {
          try {
            if (!duplex.destroyed) duplex.destroy();
          } catch {
            /* ignore */
          }
        };
        if (duplex.writableEnded) {
          hardRelease();
          return;
        }
        duplex.once('finish', hardRelease);
        const fallback = setTimeout(hardRelease, 1_000);
        fallback.unref?.();
        duplex.end();
      } catch {
        /* ignore — releasing a duplex must never fail a settled fetch */
      }
    };
    // Hold the in-flight mark for this repo until the fetch settles, so a
    // concurrent tick's stale-lock sweep can never unlink the `shallow.lock`
    // this fetch is actively holding (EI-18776567787336109).
    const releaseInFlight = noteFetchInFlight(localRepoPath);
    const cleanup = async (): Promise<void> => {
      releaseInFlight();
      releasePeerDuplex();
      try {
        server.close();
      } catch {
        /* ignore */
      }
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    };
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      void cleanup();
      resolve({ code, stderr: stderrOut.text(), timedOut });
    };
    // BUG FIXED (WI-3490/P-201): this ceiling used to only SET `timedOut` —
    // it never actually killed anything or resolved the promise. So a stall
    // BEFORE `child` exists (mkdtemp / server.listen never resolving — e.g. a
    // wedged fs call) had NO ceiling at all: the inner `killTimer` below only
    // starts once `spawn()` has already run, so it can't cover that window.
    // A hostile/wedged peer or a slow host could then pin this open forever
    // (bounded only by an external caller's own timeout, if any — vitest's
    // global 90s test timeout is what surfaced this in serve-wiring's
    // integration tests, not a real fix). Now this outer timer is the actual
    // enforced ceiling: kill the child if one was spawned, and always finish.
    const expire = (why: string): void => {
      timedOut = true;
      // WI-6184: name what we were WAITING ON, not just that we waited.
      //   peer→us 0 B  ⇒ the serving side never answered (its handleReq refused
      //                  silently, threw and got swallowed, or never received
      //                  the req frame) — look at the PEER, not the transport.
      //   peer→us > 0  ⇒ the peer did answer and the stream then stalled — a
      //                  transport/connection-death problem on this path.
      //   bridge=no    ⇒ we never even got git's ext helper connected locally,
      //                  so the stall is LOCAL setup (mkdtemp/listen/spawn).
      stderrOut.append(
        `\nfetch ${why}` +
          ` (peer→us ${bytesFromPeer}B, us→peer ${bytesToPeer}B,` +
          ` bridge=${bridgeConnected ? 'yes' : 'no'}, gitChild=${child ? 'spawned' : 'none'})`,
      );
      try {
        child?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish(-1);
    };
    // IDLE ceiling — rearmed by `noteProgress()` on every byte in either
    // direction, so only a genuinely STALLED fetch trips it.
    const armIdle = (): void => {
      if (settled) return;
      clearTimeout(timer);
      // Wording note: the `fetch timed out after <n>ms` prefix is an ASSERTED
      // contract (fetch-transport.test.ts, WI-6184 forensics). The ceiling that
      // fired is appended rather than replacing it, so the diagnostic gains
      // which-ceiling information without breaking that contract.
      timer = setTimeout(() => expire(`timed out after ${idleMs}ms idle`), idleMs);
      timer.unref?.();
    };
    armIdle();
    // ABSOLUTE ceiling — never rearmed.
    hardTimer = setTimeout(() => expire(`timed out after ${maxMs}ms (absolute ceiling)`), maxMs);
    hardTimer.unref?.();

    // FAIL FAST on an ALREADY-destroyed duplex (WI-3496 rig finding): the
    // 'error' listener above only covers a destroy that happens AFTER this
    // call — a pre-destroyed decoy stub (openHiveGitDuplexToDevice's "no live
    // dial path" contract) emitted its 'error' ticks ago into its own no-op
    // listener, before callers like bootstrapFromPeer (which awaits
    // dropQuarantine/listNamespaces first) ever reach here. Without this
    // check such a fetch hangs the FULL outer ceiling (live-observed: every
    // G-8 cold-join burned 120s per tick instead of failing fast).
    if (duplex.destroyed) {
      // Name WHICH fail-soft stub this was. Every caller destroys its stub with
      // a distinct reason ("no live connection to device …", "no-such-repo
      // backoff: …", "hive-git: no live swarm join for this harness yet",
      // "substrate sidecar dial failed: …"), and `stream.errored` (Node ≥18)
      // still holds it here. Flattening them all to "no live dial path" is what
      // let a 210-minute VM→tower stall read as an ordinary transient dial miss
      // on the P-203 rig — the one string in the log that could have said
      // which leg was dead said nothing.
      const why = (duplex as { errored?: Error | null }).errored?.message;
      stderrOut.append(
        `\nduplex already destroyed before fetch began (${why ? why : 'no live dial path'})`,
      );
      finish(-1);
      return;
    }

    server.on('error', () => {});

    // ── WI-6189: propagate a peer half-close to git, ALWAYS ──
    // `duplex.pipe(conn)` forwards EOF only if the duplex's 'end' is still
    // ahead of us. Two very common cases leave nothing to forward:
    //   (a) the channel closed BEFORE git's ext helper connected (we're
    //       awaiting mkdtemp/listen/spawn for a few ms — a pot-git channel
    //       closing 23–36x/min lands in that window constantly), so 'end'
    //       fired into the void and a later `.pipe()` never re-emits it;
    //   (b) the channel was DESTROYED without an error, which emits 'close'
    //       and no 'end' at all, so `pipe` has nothing to act on either.
    // In both, the bridge sits waiting for bytes that can never arrive, git
    // waits on the bridge, and the fetch burns its FULL ceiling (120 s in
    // prod) before anyone learns the peer left. Latch the half-close and hand
    // the EOF to the bridge by hand so git fails in milliseconds instead.
    //
    // Deliberately NOT `finish(-1)`: on a HEALTHY fetch the serving side also
    // ends the duplex as soon as upload-pack exits, while our git is still
    // indexing/resolving deltas. Aborting there would kill successful fetches.
    // Handing git the EOF is correct in both cases — it then exits on its own,
    // successfully if it already has the whole pack.
    let bridgeConn: import('node:net').Socket | null = null;
    let peerHalfClosed = false;
    const propagateHalfClose = (): void => {
      peerHalfClosed = true;
      try {
        bridgeConn?.end();
      } catch {
        /* ignore */
      }
    };
    duplex.on('end', propagateHalfClose);
    duplex.on('close', propagateHalfClose);

    // The bridge (git's ext helper) connects here; wire it to the caller's duplex.
    server.on('connection', (conn) => {
      conn.on('error', () => {});
      duplex.on('error', () => {});
      bridgeConn = conn;
      conn.pipe(duplex);
      duplex.pipe(conn);
      // Case (a)/(b) above: the peer was already gone when git got here.
      if (peerHalfClosed || duplex.readableEnded || duplex.destroyed) propagateHalfClose();
      // WI-6184: counters — see the declarations above for why an extra
      // 'data' listener on an already-piped stream is byte-safe. These are also
      // the IDLE-ceiling's progress signal (EI-18776567787336109): every byte in
      // either direction rearms it, so a multi-GB transfer that is still moving
      // is never killed for taking a long time.
      bridgeConnected = true;
      duplex.on('data', (c: Buffer | string) => {
        bytesFromPeer += typeof c === 'string' ? Buffer.byteLength(c) : c.length;
        armIdle();
      });
      conn.on('data', (c: Buffer | string) => {
        bytesToPeer += typeof c === 'string' ? Buffer.byteLength(c) : c.length;
        armIdle();
      });
    });

    void (async () => {
      try {
        tmpDir = await mkdtemp(join(tmpdir(), 'hgfetch-'));
        // The duplex may already have errored (fast refusal, or a
        // pre-destroyed decoy stub — see the `duplex.on('error', ...)`
        // handler above) while we were still awaiting mkdtemp — `finish`
        // already ran, so don't waste a real `git fetch` spawn on a fetch
        // that's already resolved failed.
        if (settled) return;
        const sockPath = join(tmpDir, 's.sock');
        await new Promise<void>((r, rej) => {
          server.once('error', rej);
          server.listen(sockPath, () => r());
        });
        if (settled) return;
        // ext:: command tokens are space-split by git, and ALL THREE paths below
        // can contain a space on a real install (WI-37735: the bridge sits beside
        // this module, i.e. inside `/Applications/Papercusp GUI.app/…` on every
        // macOS install). formatExtTransportUrl escapes them for git.
        const nodeCmd = await extNodeCommand();
        if (settled) return;
        const url = formatExtTransportUrl([nodeCmd, EXT_BRIDGE_PATH, sockPath]);
        // The ext helper is a plain `node` grandchild whose STDOUT *is* the git
        // pkt-line channel — so it must boot vanilla. Strip any injected loader
        // (NODE_OPTIONS / tsx --import|--require) that would print startup noise
        // to fd 1 and corrupt the pack stream ("bad pack header"). git passes its
        // env through to the ext command.
        const cleanEnv = { ...process.env } as Record<string, string | undefined>;
        delete cleanEnv.NODE_OPTIONS;
        delete cleanEnv.TSX_TSCONFIG_PATH;
        // WI-6189: the shallow-ladder knobs. `--depth` and `--deepen` are
        // mutually exclusive in git; depth wins if a caller passes both
        // (bootstrap.ts never does — its phase machine picks exactly one).
        const ladderArgs: string[] = [];
        if (opts.noTags) ladderArgs.push('--no-tags');
        if (opts.prune) ladderArgs.push('--prune');
        if (opts.depth !== undefined) ladderArgs.push(`--depth=${opts.depth}`);
        else if (opts.deepen !== undefined) ladderArgs.push(`--deepen=${opts.deepen}`);
        else if (opts.unshallow) ladderArgs.push('--unshallow');
        child = spawn(
          'git',
          [
            '-c',
            'protocol.ext.allow=always',
            '-c',
            'protocol.version=2',
            'fetch',
            '--no-write-fetch-head',
            ...ladderArgs,
            url,
            ...refspecs,
          ],
          { cwd: localRepoPath, env: { ...cleanEnv, GIT_PROTOCOL: 'version=2', LC_ALL: 'C', LANG: 'C' } },
        );
        // Fires faster than the outer ceiling timer would in the common case
        // (same deadline, but this one only has to wait on the child, not
        // re-derive that nothing else settled it) — the outer `timer` above
        // is the actual backstop now, so this being redundant on the happy
        // path is fine; `finish` is idempotent either way.
        const killTimer = setTimeout(() => {
          try {
            child?.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }, opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
        killTimer.unref?.();
        stderrOut.attach(child.stderr);
        child.stderr.on('data', () => {
          // git's own progress ("Receiving objects", "Resolving deltas") is
          // liveness too: during index-pack the client burns minutes writing to
          // disk with NO network bytes moving, which the byte counters above
          // cannot see. Without this, a large cold join would idle out at the
          // very last step (EI-18776567787336109).
          armIdle();
        });
        child.on('error', (e) => {
          clearTimeout(killTimer);
          stderrOut.append(String(e));
          finish(-1);
        });
        child.on('close', (code) => {
          clearTimeout(killTimer);
          finish(code ?? -1);
        });
      } catch (e) {
        stderrOut.append(e instanceof Error ? e.message : String(e));
        finish(-1);
      }
    })();
  });
}

/** The refspec that mirrors ONE peer device's entire namespace into our local
 *  bare repo, verbatim (`refs/namespaces/<devHex>/*` ↔ same). Forced (`+`) — the
 *  peer is the sole writer of its own namespace, so its head is authoritative for
 *  its subtree; there is no local writer to clobber. */
export function peerNamespaceRefspec(peerDevicePubkeyBase64: string): string {
  const hex = deviceNamespaceKey(peerDevicePubkeyBase64);
  return `+refs/namespaces/${hex}/*:refs/namespaces/${hex}/*`;
}

/**
 * Convenience: fetch a single peer device's whole namespace into `localRepoPath`
 * over `duplex`. The announcement layer (G-3) calls this when a peer advertises
 * its sigrefs advanced; the integrator (G-5) then merges the mirrored heads.
 */
export function fetchPeerNamespace(
  localRepoPath: string,
  duplex: Duplex,
  peerDevicePubkeyBase64: string,
  opts?: { timeoutMs?: number },
): Promise<TransportResult> {
  // This forced wildcard is an authoritative mirror of the peer-owned
  // namespace. Rewrites already win via `+`; deletions must win as well, or a
  // receiver-only stale ref survives forever and strict signed-snapshot
  // convergence can never succeed (WI-39953).
  return fetchOverDuplex(localRepoPath, duplex, [peerNamespaceRefspec(peerDevicePubkeyBase64)], {
    ...opts,
    prune: true,
  });
}
