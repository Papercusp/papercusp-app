/**
 * pot-git/storage.ts — the per-hive bare-repo store with per-device ref
 * namespaces (cross-machine-coord-parity-and-trust-2026-07-01 Phase 7 G-1,
 * D-010/D-011). The Radicle-Heartwood storage model, adapted:
 *
 *   ONE bare git repo per (hive, managed repo). Inside it, EACH device writes
 *   ONLY under its own namespace `refs/namespaces/<device-ns>/refs/…`, and every
 *   namespace SHARES one object database (a git bare repo already has exactly
 *   one ODB), so a commit is stored once no matter how many device namespaces
 *   reference it. Single-writer-per-namespace eliminates push contention BY
 *   CONSTRUCTION — there is no shared branch anyone races to write; the "real"
 *   refs (staging, release tags) are COMPUTED from the namespaced refs by the
 *   integrator (G-5) / canonical-ref rules (G-6), never pushed directly.
 *
 * DEVICE NAMESPACE KEY (a load-bearing seam the rest of Phase 7 depends on):
 * a device pubkey is raw-32 Ed25519 as BASE64 on the wire (contains '/','+','='
 * — NOT a legal git ref component). We HEX-encode it for the namespace path, so
 * the namespace is `refs/namespaces/<64-hex>/…` (ref-safe, collision-free,
 * mirrors Radicle's node-id namespace). `deviceNamespaceKey` is the ONE place
 * that mapping lives — G-4 (sigrefs), G-5 (integrator) and G-2 (fetch) all key
 * on it.
 *
 * Pure over an injected RunGit (the run-git-sync seam shape), so the whole layer
 * unit-tests against a real temp bare repo with no network. The transport
 * (G-2) and the sigrefs/announcement/integrator layers build ON this module;
 * this file does storage + ref plumbing only — no swarm, no signing, no policy.
 */

import { spawn } from 'node:child_process';
import { processGroupLifetime } from '../../fleet/process-group-lifetime';
import { withGitFetchHeadroom } from '../../harness/git-sync/git-fetch-headroom';
import { collectChildOutput, createTextCollector } from '../../child-output.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, access, readdir, rm, stat, unlink } from 'node:fs/promises';
import {
  gitSidecarEnabled,
  noteSidecarFallback,
  runGitViaSpawnerSidecar,
  runGitStdinViaSpawnerSidecar,
} from '../../fleet/git-via-sidecar';

/** Per-call override for {@link defaultRunGit}'s kill-timeout. */
export interface RunGitOptions {
  /**
   * Kill the process after this many ms instead of the 60s default
   * (github-bridge-ingress-timeout-too-short-2026-07-20, EI-18189246091367226).
   * A genuine BULK network transfer (a GitHub fetch/push doing a large
   * catch-up, as opposed to a fast local op like merge-base/update-ref/rev-parse)
   * can legitimately take much longer than 60s on a real connection — measured
   * ~2-3 MB/s on this box's link to GitHub, so a several-hundred-MB catch-up
   * pack straightforwardly exceeds 60s even with NOTHING wrong. Since a killed
   * fetch discards its partial pack (git only finalizes a COMPLETE index-pack),
   * a timeout tighter than the transfer needs makes that fetch permanently
   * un-completable: every tick restarts from zero, `github-divergence.ts`'s
   * escalation can never self-clear (its clear path only fires on a signal-free
   * tick), and the `unresolved-escalation` watchdog re-files an "Unresolved
   * escalation" EI every cycle forever. Callers doing real network I/O should
   * pass a generous `timeoutMs` (see `NETWORK_RUN_GIT_TIMEOUT_MS`); local,
   * same-host git plumbing should keep the 60s default so a truly wedged
   * process is still caught quickly.
   */
  timeoutMs?: number;
  /** Retain the process lifetime until cancellation has actually drained Git and its helpers. */
  signal?: AbortSignal;
}

/** The run-git seam (matches harness/git-sync/run-git-sync.ts): spawn `git
 *  <args>` in `cwd`, never throw, return the exit code + captured streams. */
export type RunGit = (
  args: string[],
  cwd: string,
  opts?: RunGitOptions,
) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * A local child_process.spawn() pays the caller's fork/page-table cost. Keep
 * that fallback out of the multi-GB RSS band where it blocks the bg-host's
 * event loop for hundreds of milliseconds per git call. The sidecar remains
 * the normal path; this is a loud, transient failure rather than a fabricated
 * git result when the sidecar is unavailable at an unsafe parent RSS.
 */
export const POT_GIT_LOCAL_SPAWN_RSS_LIMIT_MB = 4096;
const POT_GIT_LOCAL_SPAWN_RSS_LIMIT_ENV = 'PAPERCUSP_POT_GIT_LOCAL_SPAWN_RSS_LIMIT_MB';

export function resolvePotGitLocalSpawnRssLimitMb(env: NodeJS.ProcessEnv = process.env): number {
  const explicit = Number(env[POT_GIT_LOCAL_SPAWN_RSS_LIMIT_ENV]);
  return Number.isFinite(explicit) && explicit > 0 ? explicit : POT_GIT_LOCAL_SPAWN_RSS_LIMIT_MB;
}

export interface PotGitLocalSpawnAdmission {
  allowed: boolean;
  rssMb: number;
  limitMb: number;
}

/** Pure/testable admission decision for the in-process git fallback. */
export function potGitLocalSpawnAdmission(
  rssBytes: number,
  env: NodeJS.ProcessEnv = process.env,
): PotGitLocalSpawnAdmission {
  const limitMb = resolvePotGitLocalSpawnRssLimitMb(env);
  return {
    allowed: rssBytes < limitMb * 1024 * 1024,
    rssMb: Math.round(rssBytes / (1024 * 1024)),
    limitMb,
  };
}

function localSpawnRefusal(admission: PotGitLocalSpawnAdmission): string {
  return (
    `pot-git: refusing local git spawn at RSS ${admission.rssMb}MB ` +
    `(limit ${admission.limitMb}MB); spawner sidecar is required at this parent size`
  );
}

/**
 * Local (in-process) RunGit — bounded, C-locale, never-throw. `cwd` is the bare
 * repo (git operates on it via -C-equivalent cwd; bare repos need no worktree).
 *
 * ⚠ Forking from THIS process is expensive in proportion to its own RSS — see
 * {@link defaultRunGit}. Prefer `defaultRunGit`, which routes through the
 * spawner sidecar when one is available and falls back to this. This is
 * exported so the fallback path stays directly testable.
 */
export const runGitLocal: RunGit = (args, cwd, opts) =>
  new Promise((resolve) => {
    if (opts?.signal?.aborted) {
      resolve({ code: -1, stdout: '', stderr: 'git aborted before spawn' });
      return;
    }
    const admission = potGitLocalSpawnAdmission(process.memoryUsage().rss);
    if (!admission.allowed) {
      resolve({ code: -1, stdout: '', stderr: localSpawnRefusal(admission) });
      return;
    }
    const child = spawn('git', args, {
      cwd, detached: process.platform !== 'win32',
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0' },
    });
    const out = collectChildOutput(child);
    const lifetime = processGroupLifetime(child, (message) => out.stderr.append(`\n${message}`));
    let settled = false;
    let terminating = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      clearTimeout(killTimer);
      opts?.signal?.removeEventListener('abort', abort);
      resolve({ code: terminating ? -1 : code, stdout: out.stdout.text(), stderr: out.stderr.text() });
    };
    const terminate = (reason: string): void => {
      if (settled || terminating) return;
      terminating = true;
      out.stderr.append(`\ngit ${reason}`);
      lifetime.signal('SIGTERM');
      killTimer = setTimeout(() => lifetime.signal('SIGKILL'), 5_000);
      killTimer.unref?.();
    };
    const abort = (): void => terminate('aborted');
    const timeoutMs = opts?.timeoutMs ?? 60_000;
    const t = setTimeout(() => terminate(`${args.join(' ')} timed out`), timeoutMs);
    t.unref?.();
    opts?.signal?.addEventListener('abort', abort, { once: true });
    if (opts?.signal?.aborted) abort();
    child.on('error', (e) => {
      out.stderr.append(String(e));
      if (child.pid === undefined) finish(-1);
    });
    child.on('close', async (code) => {
      await lifetime.waitForExit();
      finish(code ?? -1);
    });
  });

/**
 * Default RunGit — bounded, C-locale, never-throw.
 *
 * Routes through the SPAWNER SIDECAR when one is enabled, falling back to
 * {@link runGitLocal} on any sidecar problem (so a sidecar fault degrades
 * performance, never correctness). The child `git` is identical either way:
 * same argv, same cwd, same C-locale env, same captured output.
 *
 * ## Why (EI-18808838427010743 — measured on the live bg-host)
 *
 * `fork()` copies the calling process's page tables, so the parent-side cost of
 * spawning ANY child scales with the PARENT's RSS, charged as synchronous
 * system time on the main thread. Measured here: ~40 ms of blocked event loop
 * per GB of parent RSS. The bg-host runs at ~4.2 GB, so each `git` call from it
 * cost ~165 ms of dead loop — for plumbing git finishes in ~4 ms.
 *
 * pot-git reads refs one-git-process-per-ref ({@link readNamespaceRef} is a
 * single `rev-parse`), and callers loop over them: `collectGateableHeads`,
 * `readSigrefs`, `handleRefAnnouncement`, `runOwnHeadPublishTick`,
 * `runRefAnnouncePublishTick`, `checkPublishGuard`, `bootstrapFromPeer`. A 150s
 * CPU profile caught the result — bursts at 98% main-thread busy with 83% of it
 * inside `spawn()`, and multi-second stretches where the loop was dead. Peer
 * sockets were dying mid-transfer (EI-18808621019872598) because UDX/hyperswarm
 * keepalives and timers cannot fire while the loop is blocked, which made a
 * multi-GB pot repo unable to converge at all.
 *
 * The sidecar is small, so ITS fork is cheap (~3 ms measured); this process
 * pays only a Unix-socket round-trip. Set `PAPERCUSP_POT_GIT_SPAWN_SIDECAR=0`
 * to force the local path for this subsystem alone.
 */
export const defaultRunGit: RunGit = async (args, cwd, opts) => {
  return withGitFetchHeadroom(args,
    (guardedArgs, signal) => runGitUnchecked(guardedArgs, cwd, { ...opts, signal }), opts?.signal);
};

const runGitUnchecked: RunGit = async (args, cwd, opts) => {
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  if (gitSidecarEnabled('PAPERCUSP_POT_GIT_SPAWN_SIDECAR')) {
    try {
      return await runGitViaSpawnerSidecar(args, cwd, timeoutMs, {
        ...process.env,
        LC_ALL: 'C',
        LANG: 'C',
      }, { signal: opts?.signal });
    } catch (e) {
      // Fall through to the local spawn, but COUNT it: falling back means every
      // git call here is paying the full ~165 ms fork stall again, which is the
      // exact condition the sidecar exists to remove. Accounting lives in the
      // shared seam so a persistent fault stays loud instead of logging once
      // and then looking identical to a healthy process — see
      // {@link noteSidecarFallback}.
      noteSidecarFallback('pot-git', e);
    }
  }
  return runGitLocal(args, cwd, opts);
};

/**
 * The run-git seam for plumbing that takes its INPUT SET ON STDIN — the
 * `cat-file --batch` / `--batch-check` family. {@link RunGit} is `(args, cwd)`
 * only and cannot feed stdin, so before this seam existed each caller grew its
 * own private copy (publish-guard.ts and foreign-mirror-quarantine.ts both had
 * one). Lifted here, next to {@link defaultRunGit}, so there is ONE.
 *
 * `stdout` is a **Buffer**, not a string: `cat-file --batch` frames its output
 * as `<oid> SP <type> SP <size> LF <contents> LF`, and walking those frames
 * needs exact BYTE offsets. Decoding to a string first would silently shift
 * every offset for any non-ASCII content and desynchronise the whole stream.
 */
export type RunGitStdin = (
  args: string[],
  cwd: string,
  stdin: string,
  opts?: RunGitOptions,
) => Promise<{ code: number; stdout: Buffer; stderr: string }>;

/**
 * Local (in-process) {@link RunGitStdin} — the fallback behind
 * {@link defaultRunGitStdin}.
 *
 * ⚠ Forking from THIS process is expensive in proportion to its own RSS — see
 * {@link defaultRunGit}. Prefer `defaultRunGitStdin`. Exported so the fallback
 * path stays directly testable, mirroring {@link runGitLocal}.
 */
export const runGitStdinLocal: RunGitStdin = (args, cwd, stdin, opts) =>
  new Promise((resolve) => {
    const admission = potGitLocalSpawnAdmission(process.memoryUsage().rss);
    if (!admission.allowed) {
      resolve({ code: -1, stdout: Buffer.alloc(0), stderr: localSpawnRefusal(admission) });
      return;
    }
    const child = spawn('git', args, { cwd, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
    // stdout stays RAW BUFFERS here on purpose: this is the `cat-file --batch`
    // seam, whose frames are `<oid> SP <type> SP <size> LF <contents> LF` — the
    // byte offsets are load-bearing, so it must never be decoded to text.
    // Only stderr is human-readable, and only it needs the text collector.
    const chunks: Buffer[] = [];
    const errOut = createTextCollector(child.stderr);
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout: Buffer.concat(chunks), stderr: errOut.text() });
    };
    const timeoutMs = opts?.timeoutMs ?? 60_000;
    const t = setTimeout(() => {
      errOut.append(`\ngit ${args.join(' ')} timed out`);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref?.();
      setTimeout(() => finish(-1), 10_000).unref?.();
    }, timeoutMs);
    t.unref?.();
    child.stdout.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(String(d))));
    child.on('error', (e) => {
      clearTimeout(t);
      errOut.append(String(e));
      finish(-1);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      finish(code ?? -1);
    });
    child.stdin.on('error', () => {
      /* EPIPE when git exits before consuming the whole oid list — the close
         handler above still reports the real exit code. */
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });

/**
 * Default {@link RunGitStdin} — same bounded/C-locale/never-throw contract as
 * {@link defaultRunGit}, with the oid set written to stdin.
 *
 * Routes through the SPAWNER SIDECAR when one is enabled, falling back to
 * {@link runGitStdinLocal} on any sidecar problem. Same reasoning as
 * {@link defaultRunGit} — see there for the measured fork cost — but this seam
 * needed a transport of its own (WI-6404): the sidecar RPC is line-delimited
 * JSON, and `cat-file --batch` carries multi-MB blob CONTENTS whose byte
 * offsets are load-bearing. So the payload rides an fd handoff instead of the
 * JSON line; {@link runGitStdinViaSpawnerSidecar} documents the design.
 *
 * ## Why this was missed the first time
 *
 * {@link RunGit} is `(args, cwd)` and cannot feed stdin, so this is a SEPARATE
 * type — converting `defaultRunGit` did not touch it, and nothing FAILS when
 * it is left behind; it just stays slow. A later profile put this exact seam at
 * the TOP of the host's remaining git spawn attribution (~2.69% of main-thread
 * samples, via `readScannableBlobs`, `checkPublishGuard` and `readTextBlobs`),
 * invisible in an earlier window only because the GitHub-egress secrets scan
 * that drives it is EPISODIC.
 */
export const defaultRunGitStdin: RunGitStdin = async (args, cwd, stdin, opts) => {
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  if (gitSidecarEnabled('PAPERCUSP_POT_GIT_SPAWN_SIDECAR')) {
    try {
      return await runGitStdinViaSpawnerSidecar(args, cwd, stdin, timeoutMs, {
        ...process.env,
        LC_ALL: 'C',
        LANG: 'C',
      });
    } catch (e) {
      noteSidecarFallback('pot-git', e);
    }
  }
  return runGitStdinLocal(args, cwd, stdin, opts);
};

/**
 * Timeout budget for a genuine bulk network transfer (GitHub fetch/push) —
 * see {@link RunGitOptions.timeoutMs}. 10 minutes: comfortably covers a
 * multi-hundred-MB catch-up at the ~2-3 MB/s throughput measured against
 * github.com from this box, while still bounded (a truly wedged process is
 * still killed, just not mistaken for one after 60s of real transfer).
 */
export const NETWORK_RUN_GIT_TIMEOUT_MS = 10 * 60_000;

/** The pot-git storage root — one dir tree of bare repos. Env-overridable
 *  (tests point it at a temp dir; the shipping desktop uses ~/.papercusp). */
export function potGitRoot(): string {
  return (
    process.env.PAPERCUSP_POT_GIT_ROOT ||
    process.env.PAPERCUSP_HIVE_GIT_ROOT || // legacy env name — dual-accept until callers migrate
    join(homedir(), '.papercusp', 'pot-git')
  );
}

/** A slug/key is used as a path component — reject traversal + separators so a
 *  hostile hive slug or repo key can't escape the storage root. */
function assertSafeComponent(v: string, what: string): void {
  if (!v || v.includes('/') || v.includes('\\') || v.includes('..') || v.includes('\0')) {
    throw new Error(`pot-git: unsafe ${what} path component: ${JSON.stringify(v)}`);
  }
}

/** The bare repo path for a (hive home slug, managed-repo key). D-011 G-1b: one
 *  bare repo per (hive, managed repo) — a hive binds N repos, so the repo key
 *  (e.g. the github repo id or the member slug) is part of the path. */
export function hiveGitRepoPath(potHomeSlug: string, repoKey: string): string {
  assertSafeComponent(potHomeSlug, 'potHomeSlug');
  assertSafeComponent(repoKey, 'repoKey');
  return join(potGitRoot(), potHomeSlug, `${repoKey}.git`);
}

/**
 * The git ref-namespace key for a device: raw-32 Ed25519 pubkey (base64 on the
 * wire) → lowercase hex (a legal, collision-free ref component). THE canonical
 * device→namespace mapping for all of Phase 7. Throws on a malformed pubkey
 * (wrong length) so a bad key can't silently write to a garbage namespace.
 */
export function deviceNamespaceKey(devicePubkeyBase64: string): string {
  const raw = Buffer.from(devicePubkeyBase64, 'base64');
  if (raw.length !== 32) {
    throw new Error(`pot-git: device pubkey must be raw-32 Ed25519 (got ${raw.length} bytes)`);
  }
  return raw.toString('hex');
}

/** The full namespaced ref path: `refs/namespaces/<devHex>/<ref>` where `ref`
 *  is a normal ref like `refs/heads/work` or `refs/rad/sigrefs`. */
export function namespaceRefPath(devicePubkeyBase64: string, ref: string): string {
  if (!ref.startsWith('refs/')) throw new Error(`pot-git: ref must start with refs/ (got ${ref})`);
  return `refs/namespaces/${deviceNamespaceKey(devicePubkeyBase64)}/${ref}`;
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** How long an `objects/pack/tmp_*` file must be untouched before
 *  {@link sweepStalePackTmpFiles} reclaims it. Comfortably past
 *  `DEFAULT_FETCH_TIMEOUT_MS` (120 s), so a fetch that is genuinely still in
 *  flight — ours or another leg's — never has its temp pack pulled out from
 *  under it. */
export const STALE_PACK_TMP_MAX_AGE_MS = 15 * 60_000;

/**
 * How long `shallow.lock` must be untouched before it is treated as stranded.
 * MUCH tighter than {@link STALE_PACK_TMP_MAX_AGE_MS}, and deliberately so —
 * the two leaks have opposite cost profiles and must not share a gate.
 *
 * A stale temp pack only wastes disk, so waiting 15 min to be sure costs
 * nothing. A stale `shallow.lock` WEDGES the ladder: git holds it for the whole
 * `index-pack` (`git --shallow-file …/shallow.lock index-pack --stdin`), so
 * while it exists EVERY shallow fetch dies instantly with
 * `fatal: Unable to create '…/shallow.lock': File exists` and the joiner makes
 * zero progress. Live-caught on the rig 2026-07-26: a rung SIGKILLed at 22:51Z
 * stranded the lock, and the 22:56Z tick failed on it instantly — with a 15-min
 * gate the store would have sat wedged until 23:06Z, ~3 wasted ticks.
 *
 * The right bound is not a guess, it is the fetch ceiling. We SIGKILL any fetch
 * at `timeoutMs`, so no live fetch can hold this lock longer than that; a lock
 * older than the ceiling plus a margin is stranded BY CONSTRUCTION, and removing
 * it cannot race a healthy fetch. Callers running a non-default ceiling should
 * pass `shallowLockMaxAgeMs` derived from their own (bootstrap does).
 *
 * ⚠ The ceiling is spelled out literally rather than imported: `fetch-transport`
 * already imports THIS module, so importing `DEFAULT_FETCH_TIMEOUT_MS` back
 * would close a module cycle. `storage.integration.test.ts` asserts the two stay
 * equal, so the duplication cannot drift silently.
 */
export const STALE_SHALLOW_LOCK_MARGIN_MS = 60_000;
/** Must equal `fetch-transport`'s `DEFAULT_FETCH_TIMEOUT_MS` — test-enforced. */
export const FETCH_CEILING_MS_MIRROR = 120_000;
export const STALE_SHALLOW_LOCK_MAX_AGE_MS =
  FETCH_CEILING_MS_MIRROR + STALE_SHALLOW_LOCK_MARGIN_MS;

/**
 * Repos with a fetch IN FLIGHT in this process (path → refcount).
 *
 * EI-18776567787336109 made this necessary. The age gate above rests on the
 * argument "we SIGKILL any fetch at `timeoutMs`, so no live fetch can hold this
 * lock longer than that" — which was true only while the ceiling was WALL-CLOCK.
 * Now that it is an IDLE ceiling, a large-but-healthy fetch legitimately runs
 * for many minutes, and since ticks fire every ~5-10 min the NEXT tick's sweep
 * would happily unlink the `shallow.lock` of a fetch that is still streaming —
 * corrupting the very cold join the idle ceiling was introduced to enable.
 *
 * So liveness is now tracked explicitly instead of inferred from a duration.
 * The age gate stays tight (a stranded lock still clears in ~3 min, preserving
 * the WI-6189 wedge-recovery this was tuned for); a lock belonging to a live
 * fetch is simply never eligible, at any age.
 */
const fetchesInFlight = new Map<string, number>();

/** Mark `repoPath` as having a fetch in flight; returns the release fn.
 *  Refcounted, so concurrent legs on one repo can't release each other's mark. */
export function noteFetchInFlight(repoPath: string): () => void {
  fetchesInFlight.set(repoPath, (fetchesInFlight.get(repoPath) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (fetchesInFlight.get(repoPath) ?? 1) - 1;
    if (n <= 0) fetchesInFlight.delete(repoPath);
    else fetchesInFlight.set(repoPath, n);
  };
}

/** True while any fetch is in flight against `repoPath` in this process. */
export function isFetchInFlight(repoPath: string): boolean {
  return (fetchesInFlight.get(repoPath) ?? 0) > 0;
}

/**
 * EI-18745600910177355: reclaim orphaned `index-pack` temp files (plus two
 * other SIGKILL-stranded artifacts of the same failure — see the inline
 * comments below: WI-6189's `shallow.lock`, and WI-2141452's per-ref
 * `refs/namespaces/**\/*.lock` files).
 *
 * `git index-pack` (inside `git fetch`) streams an incoming pack to
 * `objects/pack/tmp_pack_XXXXXX` and only renames it to its final
 * `pack-<sha>.pack` once the pack is fully received AND delta-resolved. It
 * unlinks the temp file on a clean error exit — but BOTH pot-git failure
 * paths kill it with an uncatchable **SIGKILL** (`fetchOverDuplex`'s timeout
 * ceiling, and the duplex-error path when a pot-git channel closes mid-pack),
 * so that cleanup never runs. Nothing else sweeps them: `git gc` only prunes
 * temp names it wrote itself.
 *
 * Live cost, measured on the P-302 rig VM: **13 orphans totalling 21 GB** in a
 * store holding 0 refs and 64 MB of real objects — one leaked partial pack per
 * interrupted cold-join, up to the full repo size each, on a ~5-minute tick.
 *
 * Best-effort and never throws: a missing pack dir, a racing unlink, or an
 * unreadable entry is skipped. Returns what it actually reclaimed.
 */
export async function sweepStalePackTmpFiles(
  repoPath: string,
  opts: { maxAgeMs?: number; shallowLockMaxAgeMs?: number; now?: number } = {},
): Promise<{ removed: string[]; bytesReclaimed: number }> {
  const maxAgeMs = opts.maxAgeMs ?? STALE_PACK_TMP_MAX_AGE_MS;
  const shallowLockMaxAgeMs = opts.shallowLockMaxAgeMs ?? STALE_SHALLOW_LOCK_MAX_AGE_MS;
  const now = opts.now ?? Date.now();
  const removed: string[] = [];
  let bytesReclaimed = 0;

  // WI-6189, live-caught on the rig: a killed fetch also strands `shallow.lock`,
  // and that one is far worse than a leaked pack — it does not merely waste
  // disk, it WEDGES the ladder permanently. git takes this lock to update the
  // `shallow` file on every `--depth`/`--deepen` fetch, and SIGKILL (our
  // timeout ceiling, or a pot-git channel dying mid-pack) leaves it behind; from
  // then on EVERY shallow fetch fails instantly with
  //   fatal: Unable to create '…/shallow.lock': File exists
  // so a cold-join that had been making real progress stops dead and never
  // resumes, on any tick, forever. On a link that drops channels 23–36x/min
  // that outcome is not a corner case, it is the expected one — the ladder
  // would have self-wedged in production while every test stayed green.
  //
  // Gated on its OWN, much tighter age (see STALE_SHALLOW_LOCK_MAX_AGE_MS) — NOT
  // the packs' 15 min. Sharing the packs' gate was itself live-caught as a bug:
  // on 2026-07-26 a rung SIGKILLed at 22:51Z stranded the lock and the 22:56Z
  // tick died on it instantly, with the store due to stay wedged until 23:06Z.
  // A stale lock is not merely wasted disk like a stale pack, it is total
  // stoppage, so the gate must be as tight as correctness allows: one fetch
  // ceiling plus a margin, past which no live fetch can still hold it.
  // ⚠ Never sweep a lock belonging to a fetch that is still running here. With
  // the idle ceiling (EI-18776567787336109) a healthy multi-GB rung outlives the
  // age gate by design, so age ALONE no longer implies "stranded".
  for (const lock of isFetchInFlight(repoPath) ? [] : ['shallow.lock']) {
    const p = join(repoPath, lock);
    try {
      const st = await stat(p);
      if (now - st.mtimeMs >= shallowLockMaxAgeMs) {
        await unlink(p);
        removed.push(lock);
        bytesReclaimed += st.size;
      }
    } catch {
      // absent (the normal case) or unreadable — nothing to do
    }
  }

  // WI-2141452, live-caught on the two-machine rig: the SAME SIGKILL that
  // strands `shallow.lock` (above) also strands per-ref lock files under
  // `refs/namespaces/<ns>/refs/**` — `fetchPeerNamespace`'s wildcard refspec
  // (`+refs/namespaces/<hex>/*:refs/namespaces/<hex>/*`, fetch-transport.ts)
  // writes potentially many refs in one `git fetch`, and a kill mid-transaction
  // (idle/absolute ceiling, or the duplex 'error' handler) leaves behind
  // whichever `<ref>.lock` files git had open — e.g.
  // `refs/namespaces/<ns>/refs/heads/staging.lock`, `heads/work.lock`,
  // `rad/sigrefs.lock`, `rad/handoff.lock`. From then on EVERY fetch that would
  // touch that SPECIFIC ref fails instantly with
  //   error: cannot lock ref 'refs/namespaces/…': File exists
  // and nothing else clears it — `git gc` does not touch ref locks, and unlike
  // `shallow.lock` there is no bound on how many of these can accumulate (one
  // per ref in the wildcard, per killed rung). Reuses the EXACT SAME gates as
  // `shallow.lock` on purpose: both are stranded by the same kill, during the
  // same fetch, so `isFetchInFlight` (never touch a namespace a live fetch
  // might still be writing) and `shallowLockMaxAgeMs` (no live fetch of ours
  // can outlive its own ceiling, so anything older is stranded by construction)
  // apply unchanged — no new parameter, no new caller wiring.
  if (!isFetchInFlight(repoPath)) {
    const nsDir = join(repoPath, 'refs', 'namespaces');
    // No explicit array type here on purpose: `readdir`'s overloads make
    // `Awaited<ReturnType<typeof readdir>>` resolve to the Buffer-dirent
    // variant rather than the string one this call actually returns —
    // inferring from the call (via .catch, mirroring this file's existing
    // `.catch(() => null)` idiom) sidesteps that mismatch entirely.
    const nsEntries = await readdir(nsDir, { recursive: true, withFileTypes: true }).catch(() => []);
    for (const entry of nsEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.lock')) continue;
      // Node's recursive readdir gives each dirent the SUBDIRECTORY it was
      // found in via `parentPath` (not `nsDir` itself) — join is required to
      // recover the real path; `entry.name` alone would collide across
      // namespaces/refs sharing a basename (every namespace has its own
      // `heads/staging.lock`).
      const parentPath = (entry as { parentPath?: string; path?: string }).parentPath ?? entry.path;
      const full = join(parentPath, entry.name);
      try {
        const st = await stat(full);
        if (now - st.mtimeMs < shallowLockMaxAgeMs) continue; // possibly still in flight
        await unlink(full);
        // Reported relative to repoPath (e.g.
        // `refs/namespaces/<hex>/refs/heads/staging.lock`) — still ends in
        // `.lock`, so callers that split on `.endsWith('.lock')` (the
        // "unwedged" vs "packs" split in git-sync-action.ts's runBootstrapLeg)
        // classify it correctly with no caller change.
        removed.push(full.slice(repoPath.length + 1));
        bytesReclaimed += st.size;
      } catch {
        // vanished under us, or unreadable — either way not ours to worry about
      }
    }
  }

  const packDir = join(repoPath, 'objects', 'pack');
  let entries: string[];
  try {
    entries = await readdir(packDir);
  } catch {
    return { removed, bytesReclaimed }; // no pack dir yet — nothing more to sweep
  }
  for (const name of entries) {
    // index-pack's own temp names. Anchored so a real `pack-*.pack`/`.idx`
    // (or anything else git owns) can never match.
    if (!/^tmp_(pack|idx)_/.test(name)) continue;
    const full = join(packDir, name);
    try {
      const st = await stat(full);
      if (now - st.mtimeMs < maxAgeMs) continue; // possibly still in flight
      await unlink(full);
      removed.push(name);
      bytesReclaimed += st.size;
    } catch {
      // vanished under us, or unreadable — either way not ours to worry about
    }
  }
  return { removed, bytesReclaimed };
}

/**
 * Ensure the bare repo for (hive, repo) exists; `git init --bare -q` if absent.
 * Idempotent + safe to call on the hot path. Returns the repo path. Throws only
 * if init genuinely fails (disk / permissions) — a fresh init on an existing
 * bare repo is a no-op git handles cleanly.
 */
/** Ensure a bare repo exists at (potHomeSlug, repoKey), creating it if absent.
 *
 * REUSE-BY-DESIGN: when a bare repo already exists at this path, it is
 * returned AS-IS — including every namespaced ref left over from prior runs.
 * This is deliberate (repos are meant to persist across ticks for a given
 * hive/repo pair), but it means a caller that hardcodes a LITERAL `repoKey`
 * and re-runs against the same `potHomeSlug` (common in tests/drills against
 * an "existing" throwaway hive) will silently REUSE the same repo + its
 * leftover refs across runs — no error, just stale history bleeding into a
 * "fresh run" assumption (bit hive-git-drill.sh's LEG D this way — fixed
 * there via a unique `$$`-suffixed repoKey). Two ways to get isolation:
 *   1. Key uniquely per run (e.g. suffix `repoKey` with a pid/uuid), or
 *   2. Pass `fresh: true` to wipe + reinit unconditionally.
 */
export async function ensurePotGitRepo(
  potHomeSlug: string,
  repoKey: string,
  runGit: RunGit = defaultRunGit,
  opts: { fresh?: boolean } = {},
): Promise<string> {
  const repoPath = hiveGitRepoPath(potHomeSlug, repoKey);
  if (opts.fresh) {
    await rm(repoPath, { recursive: true, force: true });
  } else if (await pathExists(join(repoPath, 'HEAD'))) {
    return repoPath; // already a bare repo — reused as-is, see doc-comment above
  }
  await mkdir(repoPath, { recursive: true });
  const r = await runGit(['init', '--bare', '-q', repoPath], potGitRoot());
  if (r.code !== 0) throw new Error(`pot-git: init --bare failed for ${repoPath}: ${r.stderr.trim()}`);
  return repoPath;
}

/** Write (create/move) a device's namespaced ref to `sha`. `expectedOld` (when
 *  given) makes it a compare-and-swap so a concurrent local writer can't be
 *  silently clobbered. */
export async function writeNamespaceRef(
  repoPath: string,
  devicePubkeyBase64: string,
  ref: string,
  sha: string,
  runGit: RunGit = defaultRunGit,
  expectedOld?: string,
): Promise<void> {
  const full = namespaceRefPath(devicePubkeyBase64, ref);
  const args = expectedOld !== undefined
    ? ['update-ref', full, sha, expectedOld]
    : ['update-ref', full, sha];
  const r = await runGit(args, repoPath);
  if (r.code !== 0) throw new Error(`pot-git: update-ref ${full} failed: ${r.stderr.trim()}`);
}

/** Read a device's namespaced ref → its sha, or null if the ref does not exist. */
export async function readNamespaceRef(
  repoPath: string,
  devicePubkeyBase64: string,
  ref: string,
  runGit: RunGit = defaultRunGit,
): Promise<string | null> {
  const full = namespaceRefPath(devicePubkeyBase64, ref);
  const r = await runGit(['rev-parse', '--verify', '-q', `${full}^{object}`], repoPath);
  const sha = r.stdout.trim();
  return r.code === 0 && sha ? sha : null;
}

/** Delete a device's namespaced ref (idempotent — a missing ref is not an error). */
export async function deleteNamespaceRef(
  repoPath: string,
  devicePubkeyBase64: string,
  ref: string,
  runGit: RunGit = defaultRunGit,
): Promise<void> {
  const full = namespaceRefPath(devicePubkeyBase64, ref);
  const r = await runGit(['update-ref', '-d', full], repoPath);
  // update-ref -d on a nonexistent ref exits nonzero with "not found" — treat as done.
  if (r.code !== 0 && !/does not exist|not found|no such ref/i.test(r.stderr)) {
    throw new Error(`pot-git: update-ref -d ${full} failed: ${r.stderr.trim()}`);
  }
}

/** Distinct device namespace keys (hex) that have any refs in the repo. */
export async function listNamespaces(
  repoPath: string,
  runGit: RunGit = defaultRunGit,
): Promise<string[]> {
  const r = await runGit(
    ['for-each-ref', '--format=%(refname)', 'refs/namespaces/'],
    repoPath,
  );
  if (r.code !== 0) return [];
  const ns = new Set<string>();
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().match(/^refs\/namespaces\/([0-9a-f]+)\//);
    if (m) ns.add(m[1]);
  }
  return [...ns].sort();
}

export interface NamespaceRef {
  /** The within-namespace ref, e.g. `refs/heads/work`. */
  ref: string;
  sha: string;
}

/** All refs (+ shas) under one device's namespace, with the
 *  `refs/namespaces/<dev>/` prefix stripped back to normal ref names. */
export async function listNamespaceRefs(
  repoPath: string,
  devicePubkeyBase64: string,
  runGit: RunGit = defaultRunGit,
): Promise<NamespaceRef[]> {
  const prefix = `refs/namespaces/${deviceNamespaceKey(devicePubkeyBase64)}/`;
  const r = await runGit(['for-each-ref', '--format=%(objectname) %(refname)', prefix], repoPath);
  if (r.code !== 0) return [];
  const out: NamespaceRef[] = [];
  for (const line of r.stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const sp = t.indexOf(' ');
    if (sp < 0) continue;
    const sha = t.slice(0, sp);
    const full = t.slice(sp + 1);
    if (full.startsWith(prefix)) out.push({ ref: full.slice(prefix.length), sha });
  }
  return out.sort((a, b) => a.ref.localeCompare(b.ref));
}

/**
 * Read ONE ref across MANY device namespaces in a SINGLE `git` invocation.
 * Returns `devicePubkeyBase64 -> sha`, with NO entry for a device lacking the ref.
 *
 * ⚠ PERFORMANCE-CRITICAL — this is not a convenience wrapper (EI-18808838427010743).
 * The obvious serial shape,
 *
 *     for (const dev of devices) await readNamespaceRef(repoPath, dev, REF, runGit);
 *
 * costs one `git` SPAWN PER DEVICE, and a spawn is not cheap in the process that
 * matters here: fork() copies the PARENT's page tables at ~40ms per GB of parent
 * RSS, charged as synchronous system time on the calling thread. bg-host runs at
 * ~4.2GB RSS, so each spawn blocks its event loop ~165ms for a command git itself
 * completes in ~4ms. A 12-member pot therefore stalls the loop ~2s per tick —
 * long enough to stop UDX/hyperswarm keepalives and kill peer sockets mid-transfer
 * (the mechanism behind EI-18808621019872598). One `for-each-ref` is O(1) spawns
 * regardless of member count, which is why callers must prefer this over a loop.
 *
 * ⚠ SEMANTIC DELTA vs `readNamespaceRef`, stated so nobody has to rediscover it:
 * `for-each-ref` reports what a ref POINTS AT and does not perform
 * `rev-parse --verify <ref>^{object}`'s object-existence check. A ref whose object
 * is missing locally (a torn or partial fetch) is therefore REPORTED here but reads
 * as ABSENT there. That is the same trade the long-standing sibling
 * `listNamespaceRefs` already makes, and it fails in the safe direction for these
 * callers: an unusable sha surfaces as a downstream integration/fetch error rather
 * than silently excluding a member from a gate.
 */
export async function readNamespaceRefForDevices(
  repoPath: string,
  devicePubkeysBase64: readonly string[],
  ref: string,
  runGit: RunGit = defaultRunGit,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (devicePubkeysBase64.length === 0) return out;

  // Build the exact full ref path per device via namespaceRefPath so this can
  // never drift from how readNamespaceRef/writeNamespaceRef address the same ref.
  const wanted = new Map<string, string>(); // fullRefPath -> devicePubkeyBase64
  for (const dev of devicePubkeysBase64) wanted.set(namespaceRefPath(dev, ref), dev);

  const r = await runGit(
    ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/namespaces/'],
    repoPath,
  );
  if (r.code !== 0) return out;

  for (const line of r.stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const sp = t.indexOf(' ');
    if (sp < 0) continue;
    const sha = t.slice(0, sp);
    const dev = wanted.get(t.slice(sp + 1));
    if (dev && sha) out.set(dev, sha);
  }
  return out;
}
