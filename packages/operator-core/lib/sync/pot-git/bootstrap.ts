/**
 * pot-git/bootstrap.ts — cold-clone bootstrap for a new joiner (Phase 7 G-8,
 * cross-machine-coord-parity-and-trust-2026-07-01 / P-032, D-010/D-011).
 *
 * A NEW machine joining a hive has an EMPTY local mirror. Because every device
 * publishes under its own `refs/namespaces/<devHex>/…` and all namespaces share
 * one ODB (G-1), the whole hive state is seedable from ANY ONE member peer over
 * the G-2 transport — no bundle infrastructure needed (D-010 noted bundle-uri
 * as a LATER optimization).
 *
 * REWIND SAFETY (HIGH fix, 2026-07-02 cross-review): bootstrap must NEVER move
 * a namespace that already exists locally. A direct forced wildcard fetch
 * (`+refs/namespaces/*:refs/namespaces/*`) let a RE-RUN against a STALE peer
 * force-rewind locally-advanced namespaces — destroying the G-4b sigrefs
 * watermark a verified reconcile had already established. So the fetch lands in
 * a private QUARANTINE area (`refs/bootstrap-quarantine/*`, ours to clobber),
 * and only namespaces with NO local refs are then seeded from it; every
 * pre-existing namespace is SKIPPED wholesale and reported in
 * `skippedExisting`. Updates to existing namespaces flow EXCLUSIVELY through
 * the verified announcement pipeline (G-3 rail + G-4 `reconcileFetchedHeads`),
 * never through bootstrap.
 *
 * TRUST BOUNDARY (deliberate): bootstrap moves BYTES, not TRUST. The seeded
 * namespaces are claims by the SERVING peer about everyone else's refs until
 * the caller verifies each namespace's device-signed sigrefs (G-4
 * `reconcileFetchedHeads` — closes the transitive-relay tamper hole) and gates
 * devices against the admitted member set. Callers MUST run that verification
 * before treating any seeded head as a member's real state; the integrator /
 * bridge layers already do.
 *
 * Fail-soft: never throws; a failed bootstrap returns ok:false and is safely
 * re-runnable against the same or ANY OTHER member peer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RESUMABILITY (WI-6189, 2026-07-26) — why this is a LADDER, not one fetch
 *
 * The original shape was a single `git fetch` of the whole wildcard refspec.
 * That is unusable for a real pot: the papercusp pot-home store is **2.5 GB**,
 * while a pot-git channel's life is measured in SECONDS (23–36 channel closes
 * per minute, sustained, on the P-302 rig). A killed `git fetch` writes NOTHING
 * durable — `index-pack` discards a partial pack — so every tick restarted from
 * zero and the joiner sat at 0 refs indefinitely, forever, while leaking a
 * multi-GB `tmp_pack_*` per attempt (EI-18745600910177355).
 *
 * This must be fixed EVEN IF the churn (EI-18740968796318403) is fully solved:
 * on any real p2p link a transfer this size WILL be interrupted — laptops
 * sleep, wifi roams, NATs rebind, peers restart. A cold-join that cannot
 * survive an interruption can never converge for a large repo.
 *
 * The fix is to make progress DURABLE PER RUNG, using git's own shallow
 * machinery — every rung's objects and refs are committed to the local ODB
 * before the next rung starts, and a rung that dies costs only that rung:
 *
 *   rung 1 (`tip`)     `--depth=1`   — every namespace ref at its tip only.
 *                                      78 MB for papercusp vs 2.5 GB full.
 *   rung 2..n (`deepen`) `--deepen=N` — extend history by N commits per tip.
 *   rung n+1 (`seed`)                 — history complete (repo no longer
 *                                      shallow) ⇒ seed `refs/namespaces/*`.
 *
 * ADAPTIVE RUNG SIZE: N doubles after every rung that lands and halves after
 * every rung that dies, persisted in the repo's own git config so it survives
 * process restarts. The ladder therefore self-tunes to whatever the link
 * actually sustains — fast on a good link, and still converging on a link that
 * can only move a few commits per window — with no operator tuning.
 *
 * SEEDING IS STILL ALL-OR-NOTHING AT THE END. A half-transferred history must
 * never become a `refs/namespaces/*` ref: the announcement/integrator layers
 * would then treat a shallow, incomplete line as a peer's real state. So the
 * quarantine area doubles as the durable resume checkpoint — it is KEPT across
 * ticks while the ladder is climbing, and dropped only once the namespaces are
 * seeded. That also keeps `runBootstrapLeg`'s "warm" self-gate honest: no
 * member namespace exists until the join genuinely finished.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { DEFAULT_FETCH_TIMEOUT_MS, type TransportResult, fetchOverDuplex } from './fetch-transport';
import {
  type RunGit,
  STALE_SHALLOW_LOCK_MARGIN_MS,
  defaultRunGit,
  deviceNamespaceKey,
  listNamespaces,
  sweepStalePackTmpFiles,
} from './storage';

/** update-ref's "the ref must NOT exist" old-value (create-only CAS). */
const ZERO_SHA = '0'.repeat(40);

/** The private landing area for the bootstrap fetch — never read by anything
 *  else, always safe to clobber/delete. */
export const BOOTSTRAP_QUARANTINE_PREFIX = 'refs/bootstrap-quarantine';

/** Mirror EVERY device namespace into QUARANTINE (forced — quarantine is ours).
 *  The real `refs/namespaces/*` refs are only ever CREATED from it, per
 *  namespace, and only when the namespace does not exist locally. */
export const ALL_NAMESPACES_QUARANTINE_REFSPEC = `+refs/namespaces/*:${BOOTSTRAP_QUARANTINE_PREFIX}/*`;

/** Which rung of the resumable ladder a call attempted. See the module doc. */
export type BootstrapPhase = 'tip' | 'deepen' | 'unshallow' | 'seed';

/** Git-config key holding the adaptive deepen rung size, persisted on the
 *  local repo so the ladder's tuning survives process restarts. */
const DEEPEN_CONFIG_KEY = 'papercusp.bootstrapDeepen';
/**
 * Git-config key holding the `--unshallow` ESCALATION LATCH.
 *
 * WI-6241: this MUST be persisted, not a per-call local. The latch is set when
 * a deepen rung lands but moves the shallow boundary not at all — the signal
 * that only `--unshallow` can finish the job. But the unshallow rung needs a
 * channel, and the only channel a call reliably has is the FIRST duplex the
 * caller hands in; every later rung depends on `dial()`, which returns null
 * whenever the peer cannot serve a second fetch. A per-call latch therefore
 * spends the one good channel on a deepen rung ALREADY KNOWN to be a no-op,
 * escalates, finds no channel for the escalated rung, and forgets — so the
 * next tick repeats it forever. Observed live: a joiner pinned at
 * `papercusp.bootstrapDeepen`=64 (the initial value — the no-op branch skips
 * adaptation), "+1 rung, still shallow" every tick, ~3 s against a 150 s
 * budget. Persisting the latch lets the NEXT tick open directly in
 * `unshallow`, spending its first, always-available duplex on the rung that
 * can actually converge.
 */
const UNSHALLOW_LATCH_CONFIG_KEY = 'papercusp.bootstrapForceUnshallow';
/**
 * Git-config key holding the consecutive NON-TIMEOUT failure count at the
 * current rung size (WI-6261).
 *
 * The control law below backs the rung size off after a failed fetch, on the
 * theory that the bite was too big. That theory is right for a fetch the
 * TIMEOUT killed, and wrong for a transport that simply hung up: a flaky link
 * fails at any size, so halving on it walks the ladder down toward
 * {@link MIN_DEEPEN_COMMITS} while re-growth requires a rung that both lands
 * AND lands fast. Observed live on the P-302 rig cold join: deepen 1024 failed,
 * 512 LANDED (+551 commits), 512 then failed, 256 failed, 128 — one success in
 * the whole descent, with `have` frozen. If 512 were above the link's capacity
 * it could not have landed, so those were flakes, not a size ceiling. At the
 * floor — 16 when this was written — the remaining ~795 commits would need ~50
 * rungs at ~1 rung per ~10-min git-sync fire — roughly 8 hours for a join that
 * should take minutes, on the exact path a brand-new peer takes on first contact.
 *
 * ⚠ {@link MIN_DEEPEN_COMMITS} is now 1, not 16 (EI-18808621019872598); see its
 * own note for why that does NOT multiply the ~50-rung figure above. The fix for
 * this crawl is the flake tolerance below (don't walk down on flakes), not a high
 * floor (which instead makes a short-channel link unable to converge at all).
 *
 * So a non-timeout failure now RETRIES the same size before it halves, and only
 * a repeated failure at that size is taken as evidence the bite is too big.
 * Persisted because each tick is a fresh process (see readDeepenFlakes).
 */
const DEEPEN_FLAKE_CONFIG_KEY = 'papercusp.bootstrapDeepenFlakes';
/** Consecutive NON-TIMEOUT failures tolerated at one rung size before backing
 *  off. 2 = retry once, then halve — enough to ride out an isolated flake
 *  without stalling long on a size that is genuinely unreachable. */
export const DEEPEN_FLAKE_TOLERANCE = 2;
/**
 * Rung-size bounds + starting point for the adaptive `--deepen` ladder.
 *
 * The floor is 1 — the true atom of durable progress — and NOT a safety margin
 * (EI-18808621019872598). It was 16, which made the ladder unable to converge at
 * all on a link whose channels are short-lived: measured peer channel lifetime on
 * that blocker is 1.6-12 s with a ~1 s mean, and a rung that cannot finish inside
 * one channel can never land at ANY number of retries. With a floor of 16 the
 * descent bottoms out there (`Math.floor(16/2)` re-clamps to 16), so if 16 does
 * not fit, EVERY rung fails forever and the join makes zero progress — not slow
 * convergence, none.
 *
 * Lowering the floor is safe because the cost of the two outcomes is wildly
 * asymmetric, and the asymmetry runs the right way:
 *  - a rung that FAILS `return partial()`s, ending the tick — so it costs a whole
 *    git-sync fire (~5-10 min);
 *  - a rung that LANDS continues in-call and DOUBLES (see the control law below),
 *    up to {@link DEFAULT_MAX_STEPS} rungs, so a single tick that finds a landable
 *    size re-climbs 1 -> 2 -> 4 -> ... -> 2048 geometrically before it returns.
 * So a low floor is an ESCAPE HATCH, not a crawl: the ladder walks down only until
 * something lands, then climbs back out within that same call.
 *
 * ⚠ This deliberately re-tunes the WI-6261 trade-off documented above, which
 * treated bottoming out at 16 as the pathology to avoid ("~50 rungs ... roughly 8
 * hours"). That concern is real but is about the FAILING path — one rung per tick
 * — and it is already mitigated where it belongs: {@link DEEPEN_FLAKE_TOLERANCE}
 * stops a flaky link from walking the size down at all, and the geometric
 * re-climb above means reaching the floor is recoverable in one tick rather than
 * fifty. An 8-hour join is bad; a join that provably never completes is worse,
 * and that is what a floor of 16 produced on the measured link.
 */
export const MIN_DEEPEN_COMMITS = 1;
export const INITIAL_DEEPEN_COMMITS = 64;
export const MAX_DEEPEN_COMMITS = 8192;

/**
 * The rung-size control law targets WALL TIME, not commit count — because the
 * constraint that actually matters is "this rung must finish inside a channel
 * window", and commits are a terrible proxy for bytes. Measured against the
 * real papercusp store (11 612 commits, 2.5 GB), plain doubling produces:
 *
 *     deepen=64  → +66 MB / 7.4 s      deepen=512  → +132 MB / 21.1 s
 *     deepen=128 → +77 MB / 10.4 s     deepen=1024 → +512 MB and climbing
 *     deepen=256 → +42 MB / 6.6 s
 *
 * i.e. commit density varies ~4x between adjacent rungs (this repo's history
 * has a band of huge committed build artifacts), so a fixed commit ladder
 * overshoots badly exactly where the bytes are. Steering on elapsed time keeps
 * every rung inside the window regardless of what the history holds.
 *
 * Target is a FRACTION of the fetch ceiling: comfortably done before the
 * ceiling, with room for the link to be slower than the last rung suggested.
 */
const DEEPEN_TARGET_FRACTION = 0.25;
const DEEPEN_GROW_BELOW_FRACTION = 0.5; // grow only when well inside target
/** Default cap on rungs climbed per call, so one tick can make real headway
 *  without pinning the git-sync routine open indefinitely. */
const DEFAULT_MAX_STEPS = 12;

/**
 * WALL-CLOCK cap on the whole ladder call — the bound that actually keeps a
 * tick inside its cadence. `maxSteps` alone does NOT: the rung-size control law
 * deliberately steers each rung toward `DEEPEN_TARGET_FRACTION` of the fetch
 * ceiling (30 s at the 120 s default), so at steady state 12 rungs is ~6 min —
 * LONGER than git-sync's ~5-min tick. The ladder would then still be fetching
 * when the next fire starts, and two concurrent shallow fetches on one repo
 * collide on `shallow.lock`: the loser's whole tick is wasted, so the joiner
 * converges at half rate exactly once the control law has warmed up. (Not a
 * permanent wedge — the winner's git removes its own lock on exit; that only
 * becomes the forever-wedge {@link sweepStalePackTmpFiles} clears when a fetch
 * is SIGKILLed. But a silently halved convergence rate on a multi-GB cold join
 * is bad enough, and it is invisible to every test that counts rungs.)
 *
 * Checked BETWEEN rungs, so the true worst case is this budget plus one rung
 * (≤ `timeoutMs`): 150 s + 120 s = 4.5 min, still inside a 5-min cadence.
 * Progress is durable either way — the quarantine refs ARE the checkpoint, so
 * stopping on budget costs nothing but the next tick's resume.
 */
const DEFAULT_MAX_WALL_MS = 150_000;

export interface BootstrapResult extends TransportResult {
  /** True when the WHOLE ladder finished: history complete AND every seed
   *  ref-write succeeded. Unchanged meaning for callers — a joiner is only
   *  "bootstrapped" once its namespaces exist. */
  ok: boolean;
  /** True when this call moved the ladder forward (at least one rung landed),
   *  even if the join is not finished yet. `ok:false, progressed:true` is the
   *  HEALTHY in-progress state of a large cold-join — distinct from a real
   *  failure (`ok:false, progressed:false`), which callers must not conflate. */
  progressed: boolean;
  /** The rung this call ended on. */
  phase: BootstrapPhase;
  /** Rungs that landed during this call. */
  steps: number;
  /** Durable resume checkpoint depth: quarantine refs currently on disk. */
  quarantineRefs: number;
  /** Whether the local store still holds a truncated history. */
  shallow: boolean;
  /** The `--deepen` size the NEXT rung will request (post-adaptation). */
  deepenNext: number;
  /** Device namespace keys (hex) present locally AFTER the bootstrap —
   *  UNVERIFIED until the caller runs the G-4 sigrefs reconciliation. */
  namespaces: string[];
  /** Namespace keys the peer offered that already exist locally — left
   *  UNTOUCHED (rewind safety); they update via the announcement pipeline.
   *  Also contains namespaces that sprang into existence CONCURRENTLY with
   *  this run (the create-only CAS lost — see the WI-1558 note in
   *  {@link bootstrapFromPeer}). */
  skippedExisting: string[];
  /** The joiner's OWN namespace key when the peer offered it — REFUSED, never
   *  seeded from a peer (WI-1559 squat guard). Null when the peer did not
   *  offer it or `selfDevicePubkey` was not given. */
  skippedSelf: string | null;
}

interface QuarantineRef {
  key: string; // device namespace key (hex)
  rest: string; // the within-namespace ref path, e.g. 'refs/heads/work'
  sha: string;
}

async function readQuarantine(repoPath: string, runGit: RunGit): Promise<QuarantineRef[]> {
  const r = await runGit(
    ['for-each-ref', '--format=%(objectname) %(refname)', `${BOOTSTRAP_QUARANTINE_PREFIX}/`],
    repoPath,
  );
  if (r.code !== 0) return [];
  const out: QuarantineRef[] = [];
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{40,64}) refs\/bootstrap-quarantine\/([0-9a-f]+)\/(.+)$/);
    if (m) out.push({ sha: m[1], key: m[2], rest: m[3] });
  }
  return out;
}

/**
 * Is there staged-but-unfinished cold-join work in this store?
 *
 * WI-6189: the resumable ladder made bootstrap INCREMENTAL. It seeds
 * all-or-nothing PER NAMESPACE, so a store can legitimately hold some seeded
 * `refs/namespaces/*` while OTHER devices' history is still mid-ladder in
 * quarantine. Any caller whose "have we already bootstrapped?" check is
 * "does a peer namespace exist?" is therefore asking the wrong question now —
 * it was only ever equivalent back when bootstrap was all-or-nothing — and will
 * declare a PARTIAL join complete, stranding the unfinished namespaces forever.
 *
 * Live-caught on the P-302 rig 2026-07-26: the joiner seeded 5 namespaces,
 * still had 4 quarantined refs for another device, and its leg then returned
 * "warm" on every subsequent tick — the ladder never ran again and the store sat
 * permanently shallow. Pair this with the namespace check: warm means a peer
 * namespace exists AND nothing is left pending.
 */
export async function hasPendingQuarantine(
  repoPath: string,
  runGit: RunGit = defaultRunGit,
): Promise<boolean> {
  return (await readQuarantine(repoPath, runGit)).length > 0;
}

/** Best-effort delete of every quarantine ref.
 *
 * WI-6189: called ONLY once the ladder has finished and the namespaces are
 * seeded. It used to also run at the START of every bootstrap ("stale debris
 * from a crashed run") — which is precisely what made a cold-join
 * unresumable: the quarantine refs left by a partial transfer ARE the durable
 * checkpoint the next rung negotiates from, so wiping them threw away every
 * byte a dying channel had managed to deliver. Quarantine is force-updated
 * (`+`) and read only as a seed source, so carrying it across ticks — even
 * across a switch to a DIFFERENT serving peer — is safe. */
async function dropQuarantine(repoPath: string, runGit: RunGit): Promise<void> {
  for (const q of await readQuarantine(repoPath, runGit)) {
    await runGit(['update-ref', '-d', `${BOOTSTRAP_QUARANTINE_PREFIX}/${q.key}/${q.rest}`], repoPath);
  }
}

/** Authoritative shallow check — `git rev-parse --is-shallow-repository`
 *  rather than probing for the `shallow` file, which git may leave behind
 *  empty. Fail-soft: an unreadable repo reports NOT shallow, which routes the
 *  caller to the seed path where real errors surface with context. */
async function isShallowRepo(repoPath: string, runGit: RunGit): Promise<boolean> {
  const r = await runGit(['rev-parse', '--is-shallow-repository'], repoPath);
  return r.code === 0 && r.stdout.trim() === 'true';
}

/** The shallow BOUNDARY (the set of commits whose parents we don't have), used
 *  to detect a deepen rung that landed but moved nothing — the signal that the
 *  ladder is stuck and must escalate to `--unshallow`. */
async function readShallowBoundary(repoPath: string): Promise<string> {
  try {
    return (await readFile(join(repoPath, 'shallow'), 'utf8')).trim();
  } catch {
    return '';
  }
}

/**
 * The one place a rung size is bounded. Exported so the floor's load-bearing
 * property is testable without standing up the Docker cold-join rig — the
 * ladder's ability to DESCEND to a size a short-lived channel can actually
 * carry is what makes convergence possible at all (EI-18808621019872598), and
 * before this was extracted the same clamp expression was written out twice
 * with nothing asserting either copy.
 */
export function clampDeepenStep(n: number): number {
  return Math.min(Math.max(n, MIN_DEEPEN_COMMITS), MAX_DEEPEN_COMMITS);
}

async function readDeepenStep(repoPath: string, runGit: RunGit): Promise<number> {
  const r = await runGit(['config', '--get', DEEPEN_CONFIG_KEY], repoPath);
  const n = r.code === 0 ? Number.parseInt(r.stdout.trim(), 10) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return INITIAL_DEEPEN_COMMITS;
  return clampDeepenStep(n);
}

async function writeDeepenStep(repoPath: string, runGit: RunGit, n: number): Promise<number> {
  const clamped = clampDeepenStep(n);
  await runGit(['config', DEEPEN_CONFIG_KEY, String(clamped)], repoPath);
  return clamped;
}

/** Consecutive NON-TIMEOUT rung failures at the CURRENT deepen size (WI-6261).
 *  Persisted for the same reason the unshallow latch is: every tick is a fresh
 *  process, so an in-memory counter resets to zero each time and the ladder can
 *  never tell a second failure from a first. */
async function readDeepenFlakes(repoPath: string, runGit: RunGit): Promise<number> {
  const r = await runGit(['config', '--get', DEEPEN_FLAKE_CONFIG_KEY], repoPath);
  const n = r.code === 0 ? Number.parseInt(r.stdout.trim(), 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Persist (or clear) the flake counter. Fail-soft like the latch: losing this
 *  write only costs one extra retry-or-halve decision, never a landed rung. */
async function writeDeepenFlakes(repoPath: string, runGit: RunGit, n: number): Promise<void> {
  try {
    await runGit(
      n > 0 ? ['config', DEEPEN_FLAKE_CONFIG_KEY, String(n)] : ['config', '--unset', DEEPEN_FLAKE_CONFIG_KEY],
      repoPath,
    );
  } catch {
    /* fail-soft by contract — see readDeepenFlakes */
  }
}

/** Read the persisted `--unshallow` escalation latch (WI-6241). Absent/unset ⇒
 *  false, so a repo that has never escalated behaves exactly as before. */
async function readUnshallowLatch(repoPath: string, runGit: RunGit): Promise<boolean> {
  const r = await runGit(['config', '--get', UNSHALLOW_LATCH_CONFIG_KEY], repoPath);
  return r.code === 0 && r.stdout.trim() === 'true';
}

/** Persist (or clear) the escalation latch. Fail-soft by contract: losing this
 *  write only costs the ladder one wasted no-op deepen rung on the next tick —
 *  the pre-WI-6241 behaviour — so it must never abort a rung that succeeded.
 *  `--unset` exits non-zero when the key is already absent; that is a no-op,
 *  not an error. */
async function writeUnshallowLatch(repoPath: string, runGit: RunGit, on: boolean): Promise<void> {
  try {
    await runGit(
      on ? ['config', UNSHALLOW_LATCH_CONFIG_KEY, 'true'] : ['config', '--unset', UNSHALLOW_LATCH_CONFIG_KEY],
      repoPath,
    );
  } catch {
    /* ignore — see the fail-soft note above */
  }
}

/**
 * G-8: seed the hive repo's MISSING namespaces (any member's work + the
 * integrator's published staging, which lives inside its namespace) from one
 * member peer over `duplex`. The local bare repo must exist (G-1
 * `ensurePotGitRepo`); the caller picks any live peer and dials the per-fetch
 * stream. Namespaces that already exist locally are NEVER touched (see the
 * rewind-safety header note) and come back in `skippedExisting`.
 *
 * TWO seed guards on top of the quarantine (2026-07-02 re-verify residuals):
 *
 *   - CREATE-ONLY CAS (WI-1558): `preExisting` is a snapshot from BEFORE the
 *     (possibly long) wildcard fetch — the verified announcement pipeline
 *     (G-3/G-4) can create a namespace CONCURRENTLY with this run. Every seed
 *     write is therefore `update-ref <ref> <sha> <zero>` (the ref must not
 *     exist); a plain update-ref would clobber a concurrently-created verified
 *     ref — the same rewind class the quarantine exists to prevent. Losing the
 *     CAS means the namespace is now pipeline-owned: this run's partial seeds
 *     into it are rolled back (old-value-guarded deletes) and the namespace is
 *     skipped WHOLESALE, all-or-nothing, exactly like a pre-existing one.
 *
 *   - OWN-NAMESPACE REFUSAL (WI-1559): pass `selfDevicePubkey` (the joiner's
 *     own device key) and its namespace is NEVER seeded from a peer, even on a
 *     truly-fresh joiner — a malicious peer could otherwise pre-plant refs
 *     masquerading as this device's own work/sigrefs before the device's first
 *     publish. Own refs are published locally, only. Production wiring MUST
 *     pass it; it is optional solely for callers that predate the guard.
 */
export async function bootstrapFromPeer(
  localRepoPath: string,
  duplex: Duplex,
  opts: {
    timeoutMs?: number;
    runGit?: RunGit;
    selfDevicePubkey?: string;
    /** WI-6189: dial a FRESH per-fetch stream for each rung beyond the first.
     *  A pot-git duplex serves exactly ONE `git fetch` (upload-pack exits and
     *  the stream is ended), so climbing the ladder within a single call needs
     *  a way to open the next one. Resolve to `null` when no channel is
     *  available — the ladder then stops with its progress intact rather than
     *  failing. Omit entirely and this call climbs exactly one rung, which is
     *  still durable; the next tick continues. */
    dial?: () => Promise<Duplex | null>;
    /** Max rungs to climb in this call (default {@link DEFAULT_MAX_STEPS}). */
    maxSteps?: number;
    /** Wall-clock budget for the whole ladder (default
     *  {@link DEFAULT_MAX_WALL_MS}). Checked between rungs. */
    maxWallMs?: number;
    /** Injectable clock, for tests. */
    now?: () => number;
  } = {},
): Promise<BootstrapResult> {
  const runGit = opts.runGit ?? defaultRunGit;
  // EI-18745600910177355: reclaim partial packs SIGKILLed fetches leaked
  // (21 GB observed on the rig). Runs before the ladder so a long-running
  // joiner reclaims disk on every tick, not only on a gc pass.
  // The `shallow.lock` half of the sweep is gated on THIS call's fetch ceiling,
  // not the packs' 15-min gate: no fetch of ours can outlive `timeoutMs` (we
  // SIGKILL it), so a lock older than that is stranded by construction — and a
  // stranded one wedges every subsequent rung, so it must be cleared fast.
  await sweepStalePackTmpFiles(localRepoPath, {
    shallowLockMaxAgeMs: (opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS) + STALE_SHALLOW_LOCK_MARGIN_MS,
  }).catch(() => ({ removed: [], bytesReclaimed: 0 }));

  const preExisting = new Set(await listNamespaces(localRepoPath, runGit));
  const maxSteps = Math.max(1, opts.maxSteps ?? DEFAULT_MAX_STEPS);
  const now = opts.now ?? Date.now;
  const maxWallMs = Math.max(1, opts.maxWallMs ?? DEFAULT_MAX_WALL_MS);
  const ladderStartedAt = now();

  let res: TransportResult = { code: 0, stderr: '', timedOut: false };
  let phase: BootstrapPhase = 'seed';
  let steps = 0;
  let progressed = false;
  let deepenNext = await readDeepenStep(localRepoPath, runGit);
  let pending: Duplex | null = duplex;
  // Escalation latch: a deepen rung that LANDS but leaves the shallow boundary
  // untouched means `--deepen` can no longer make headway (git has handed us
  // everything it will hand us at that granularity). One `--unshallow` rung
  // then finishes the job. Without this the ladder could spin forever landing
  // no-op rungs.
  //
  // WI-6241: seeded from the PERSISTED latch, so a tick that already learned
  // "deepen cannot make headway" opens directly in `unshallow` and spends its
  // first (always-available) duplex on that rung. Held per-call only, the
  // escalation was forgotten every tick and the repo stayed shallow forever —
  // see UNSHALLOW_LATCH_CONFIG_KEY.
  let forceUnshallow = await readUnshallowLatch(localRepoPath, runGit);

  /** Close a duplex we accepted but never spent a rung on, so a caller's dialed
   *  stream is not left open when the ladder short-circuits (already complete,
   *  or out of budget). Never throws. */
  const releasePending = (): void => {
    const p = pending;
    pending = null;
    if (!p || p.destroyed) return;
    try {
      p.end();
    } catch {
      /* ignore */
    }
  };

  const partial = async (over: Partial<BootstrapResult> = {}): Promise<BootstrapResult> => ({
    ...res,
    ok: false,
    progressed,
    phase,
    steps,
    quarantineRefs: (await readQuarantine(localRepoPath, runGit)).length,
    shallow: await isShallowRepo(localRepoPath, runGit),
    deepenNext,
    namespaces: await listNamespaces(localRepoPath, runGit),
    skippedExisting: [],
    skippedSelf: null,
    ...over,
  });

  for (;;) {
    const quarantined = await readQuarantine(localRepoPath, runGit);
    const shallow = await isShallowRepo(localRepoPath, runGit);
    // Phase machine. `tip` only when there is no checkpoint at all; otherwise
    // keep extending the checkpoint we already paid for.
    phase =
      quarantined.length === 0 ? 'tip' : forceUnshallow ? 'unshallow' : shallow ? 'deepen' : 'seed';
    if (phase === 'seed') {
      releasePending();
      break;
    }
    // Budget spent — on rungs OR on wall time. Either way progress is durable
    // (the quarantine refs are the checkpoint) and the next tick resumes.
    // `steps > 0` on the wall-time arm: never refuse to climb the FIRST rung,
    // however little budget is left, or a tight budget turns into no progress
    // at all instead of slower progress.
    if (steps >= maxSteps || (steps > 0 && now() - ladderStartedAt >= maxWallMs)) {
      releasePending();
      return partial();
    }

    const stream = pending ?? (opts.dial ? await opts.dial().catch(() => null) : null);
    pending = null;
    // No channel for this rung: stop cleanly. Everything already fetched stays
    // on disk and the next tick resumes from it.
    if (!stream || stream.destroyed) {
      if (steps === 0 && stream) {
        // The FIRST duplex was already dead — the pre-WI-3583 decoy-stub path.
        // Run the fetch anyway so fetchOverDuplex produces its documented
        // fail-soft diagnosis (`duplex already destroyed …`) instead of a
        // silent no-op, preserving the old contract for that case.
        res = await fetchOverDuplex(localRepoPath, stream, [ALL_NAMESPACES_QUARANTINE_REFSPEC], {
          timeoutMs: opts.timeoutMs,
          depth: 1,
          noTags: true,
        });
        return partial();
      }
      return partial();
    }

    const before = await readShallowBoundary(localRepoPath);
    const rungStartedAt = Date.now();
    res = await fetchOverDuplex(localRepoPath, stream, [ALL_NAMESPACES_QUARANTINE_REFSPEC], {
      timeoutMs: opts.timeoutMs,
      noTags: true,
      ...(phase === 'tip'
        ? { depth: 1 }
        : phase === 'deepen'
          ? { deepen: deepenNext }
          : { unshallow: true }),
    });
    if (res.code !== 0) {
      // The rung died. Everything EARLIER rungs delivered stays on disk — that
      // is the whole point. Back the rung size off so the retry asks for a
      // bite this link can actually swallow — but only once we have evidence
      // the BITE is what failed (WI-6261).
      //
      // `timedOut` is the discriminator: it means the fetch burned the whole
      // window and was killed, i.e. too much to move in the time available —
      // halve immediately, as before. A non-timeout death is the peer or the
      // duplex hanging up ("fetch-pack: unexpected disconnect while reading
      // sideband packet"), which happens at ANY size; halving on that walks a
      // working ladder down to the floor. Retry the same size first, and treat
      // only repeated failure there as evidence about size.
      if (phase === 'deepen') {
        if (res.timedOut) {
          deepenNext = await writeDeepenStep(localRepoPath, runGit, Math.floor(deepenNext / 2));
          await writeDeepenFlakes(localRepoPath, runGit, 0);
        } else {
          const flakes = (await readDeepenFlakes(localRepoPath, runGit)) + 1;
          if (flakes >= DEEPEN_FLAKE_TOLERANCE) {
            deepenNext = await writeDeepenStep(localRepoPath, runGit, Math.floor(deepenNext / 2));
            await writeDeepenFlakes(localRepoPath, runGit, 0);
          } else {
            // Hold the size; the next tick re-attempts this same rung.
            await writeDeepenFlakes(localRepoPath, runGit, flakes);
          }
        }
      }
      return partial();
    }
    steps++;
    progressed = true;
    if (phase === 'deepen') {
      const after = await readShallowBoundary(localRepoPath);
      if (after === before) {
        // deepen can't make headway — escalate, and REMEMBER it (WI-6241) so
        // the next tick starts on the unshallow rung instead of re-spending
        // its one good channel on this same no-op deepen.
        forceUnshallow = true;
        await writeUnshallowLatch(localRepoPath, runGit, true);
      } else {
        // Steer on how long the rung actually took (see the control-law note
        // above): grow only when it finished well inside the target, shrink
        // when it ran over, otherwise hold. A rung that lands but takes most
        // of the window is already at the link's limit — doubling it there is
        // how the ladder overshoots into a rung that can never complete.
        // A rung LANDED at this size, so any earlier failures here were flakes,
        // not evidence about size (WI-6261). Clear the counter or an unrelated
        // failure much later would arrive pre-charged and halve prematurely.
        await writeDeepenFlakes(localRepoPath, runGit, 0);
        const elapsed = Date.now() - rungStartedAt;
        const target = (opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS) * DEEPEN_TARGET_FRACTION;
        const scaled =
          elapsed < target * DEEPEN_GROW_BELOW_FRACTION
            ? deepenNext * 2
            : elapsed > target
              ? Math.floor(deepenNext / 2)
              : deepenNext;
        deepenNext = await writeDeepenStep(localRepoPath, runGit, scaled);
      }
    } else if (phase === 'unshallow') {
      // The escalated rung landed: history is whole, so retire the latch (both
      // in-call and persisted) or every future tick would re-run `--unshallow`
      // on an already-complete repo.
      forceUnshallow = false;
      await writeUnshallowLatch(localRepoPath, runGit, false);
    }
  }

  // ── Ladder complete: history is whole. Seed the namespaces. ──
  // Group by namespace — seeding is all-or-nothing PER NAMESPACE.
  const byKey = new Map<string, QuarantineRef[]>();
  for (const q of await readQuarantine(localRepoPath, runGit)) {
    const group = byKey.get(q.key);
    if (group) group.push(q);
    else byKey.set(q.key, [q]);
  }

  const selfKey = opts.selfDevicePubkey !== undefined ? deviceNamespaceKey(opts.selfDevicePubkey) : null;
  const skipped = new Set<string>();
  let skippedSelf: string | null = null;
  let ok = true;
  let stderr = res.stderr;
  for (const [key, group] of byKey) {
    if (selfKey !== null && key === selfKey) {
      skippedSelf = key; // WI-1559: own namespace is never accepted from a peer
      continue;
    }
    if (preExisting.has(key)) {
      skipped.add(key);
      continue;
    }
    const seededHere: QuarantineRef[] = [];
    for (const q of group) {
      const ref = `refs/namespaces/${key}/${q.rest}`;
      // WI-1558: create-only CAS — never clobber a ref the verified pipeline
      // created after our preExisting snapshot.
      const w = await runGit(['update-ref', ref, q.sha, ZERO_SHA], localRepoPath);
      if (w.code === 0) {
        seededHere.push(q);
        continue;
      }
      const exists = await runGit(['show-ref', '--verify', '--quiet', ref], localRepoPath);
      if (exists.code === 0) {
        // Lost the race to the verified pipeline — the namespace is theirs.
        // Roll back what THIS run seeded into it (old-value-guarded deletes:
        // never remove a ref the pipeline has since moved) and skip wholesale.
        for (const s of seededHere) {
          await runGit(['update-ref', '-d', `refs/namespaces/${key}/${s.rest}`, s.sha], localRepoPath);
        }
        skipped.add(key);
        break;
      }
      ok = false;
      stderr += `\nseed ${key}/${q.rest}: ${w.stderr.trim()}`;
    }
  }
  await dropQuarantine(localRepoPath, runGit);

  const namespaces = await listNamespaces(localRepoPath, runGit);
  return {
    ...res,
    stderr,
    ok,
    progressed: progressed || ok,
    phase: 'seed',
    steps,
    quarantineRefs: 0,
    shallow: false,
    deepenNext,
    namespaces,
    skippedExisting: [...skipped].sort(),
    skippedSelf,
  };
}
