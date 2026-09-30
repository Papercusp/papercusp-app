/**
 * pot-git/own-head-publish.ts — G-2a: the FIRST link of the replication chain,
 * the Radicle `git push rad` analogue (p2p-git-live-activation-2026-07-09,
 * WI-5146). Publishes THIS device's local worktree branch head into its own
 * namespace in the (hive, repo) bare store.
 *
 * Every other wired leg is a DOWNSTREAM consumer of namespace refs — bootstrap
 * (G-8) seeds them FROM a peer, ref-announce (P-202) announces a namespace
 * that already advanced, the integrator (G-5) merges member heads, the
 * worktree-bridge (P-204) follows staging the integrator computed. Until this
 * module landed, NOTHING in production wrote a device's own commits into its
 * own namespace: a bridged/p2p-only hive produced no bare store, announced
 * nothing, and left a cold joiner with nothing to bootstrap from — the design
 * doc's G-1..G-8 list simply never specced this link (live-caught on the
 * tower↔VM rig, 2026-07-17).
 *
 * Ordering contract (the git-sync caller): runs AFTER the bootstrap leg and
 * BEFORE ref-announce. After bootstrap because a genuinely cold joiner must
 * seed peers' namespaces first — own-head-first would warm the store
 * (`listNamespaces` non-empty) and permanently skip G-8's one-shot cold-join.
 * Before ref-announce so the same tick that ingests a new head also signs +
 * announces it.
 *
 * Exposure discipline: objects are transferred REF-LESSLY first (a plain
 * `git fetch <worktree> <ref>` writes the ODB + FETCH_HEAD but creates no
 * ref, so nothing new is advertised by upload-pack), then the G-10 publish
 * guard judges the (prior, head] range, and only an allowed range gets the
 * namespace ref CAS-written. A refused head is therefore never servable to
 * peers — same layering as ref-announce's own guard, one hop earlier.
 *
 * Single-writer-per-namespace makes the CAS a belt-and-braces guard, not a
 * contention mechanism; a forced move (rebase/reset in the worktree) is a
 * legitimate own-namespace rewrite (Radicle semantics — receivers judge
 * rollback via sigrefs versioning, not this ref).
 *
 * Pure over the injected RunGit seam like its siblings; no swarm, no signing,
 * no policy — storage + guard + one ref write.
 */
import {
  type RunGit,
  NETWORK_RUN_GIT_TIMEOUT_MS,
  defaultRunGit,
  deviceNamespaceKey,
  ensurePotGitRepo,
  readNamespaceRef,
  writeNamespaceRef,
} from './storage';
import { WORK_REF } from './integrator';
import {
  type IncrementalPublishResolution,
  type PublishGuardCaps,
  type PublishGuardResult,
  resolveIncrementalPublishSha,
} from './publish-guard';
import type { SecretFinding } from './secrets-guard';
import { listTempPackFiles, pruneFailedFetchTempPacks } from '../../harness/git-sync/run-git-sync';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export interface OwnHeadPublishTickInput {
  /** Hive home slug — the bare-store directory key (storage.ts G-1). */
  potHomeSlug: string;
  /** Managed-repo key within the hive (G-1b) — the git-sync caller passes the
   *  member harness slug, matching hiveGitRepoPath(potHomeSlug, slug)
   *  everywhere else in the tick chain. */
  repoKey: string;
  /** The local worktree (ProjectEntry.path) whose branch head is published. */
  worktreePath: string;
  /** Branch to publish (the git-sync routine's cfg.branch). Absent ⇒ resolved
   *  from the worktree's checked-out branch; a detached HEAD is a no-op. */
  branch?: string;
  /** This device's raw-32 Ed25519 pubkey, base64 (the namespace key). */
  devicePubkeyBase64: string;
  publishGuardCaps?: PublishGuardCaps;
  /**
   * WI-5395 follow-on (genesis-publish baseline): the sha of content ALREADY
   * EXPOSED outside this machine (e.g. the GitHub origin's branch tip), used as
   * the G-10 guard baseline ONLY on a FIRST-EVER publish (priorSha null).
   *
   * Without it, genesis judges `(null, head]` — the repo's ENTIRE history — so
   * any pre-existing repo above the flood caps (papercusp: 200k+ objects vs the
   * 50k cap) is refused forever and can never onboard onto the hive-git plane.
   * Content the GitHub remote already serves to every hive member is not NEW
   * exposure; only `(alreadyExposed, head]` is. The caller must VERIFY the
   * baseline is an ancestor of head before passing it (git-sync-action does:
   * remote-tracking ref + merge-base --is-ancestor). Ignored after genesis —
   * incremental publishes keep the strict namespace-prior baseline.
   */
  genesisBaselineSha?: string | null;
  runGit?: RunGit;
  /** WI-5591: workspace whose runtime secrets-guard path exemptions to
   *  consult (see publish-guard.ts's PublishGuardInput.workspaceId). Omitted
   *  ⇒ no runtime exemptions consulted (only static FIXTURE_FILES applies). */
  workspaceId?: string;
  /**
   * WI-2142873: budget for the shallow-worktree `git fetch --unshallow`.
   * Omitted ⇒ NETWORK_RUN_GIT_TIMEOUT_MS. The git-sync caller MUST pass
   * `boundedUnshallowTimeoutMs(idleDeadline)`, because the post-legs liveness
   * guard gives each leg the same 600s idle budget as NETWORK_RUN_GIT_TIMEOUT_MS.
   * An unshallow that could not finish first made the guard abort the WHOLE
   * action every tick, so ref-announce, integrator and worktree-bridge never ran.
   */
  unshallowTimeoutMs?: number;
  /**
   * WI-2142873: epoch-ms until which the unshallow fetch is NOT attempted
   * (a persisted backoff after a failed attempt — see nextUnshallowBackoff).
   * While deferred the tick returns at once with `unshallow.state:'deferred'`,
   * so a worktree too large to unshallow within budget costs later legs nothing.
   */
  unshallowDeferredUntil?: number | null;
  /** Clock seam for tests. */
  now?: () => number;
}

/**
 * WI-2142873: the per-tick unshallow budget, derived from the git-sync
 * post-legs idle deadline so the unshallow ALWAYS returns (as a failure) well
 * before the guard aborts the action. Half the idle deadline, never above the
 * generic network timeout, never below 1s.
 */
export function boundedUnshallowTimeoutMs(idleDeadlineMs: number): number {
  const half = Math.floor(idleDeadlineMs / 2);
  return Math.max(1_000, Math.min(NETWORK_RUN_GIT_TIMEOUT_MS, half));
}

/** Persisted per-install unshallow backoff (routine metadata `own_head_unshallow`). */
export interface OwnHeadUnshallowBackoffState {
  failures: number;
  lastAttemptAt: number;
  nextAttemptAt: number;
  lastError: string;
}

export const UNSHALLOW_BACKOFF_BASE_MS = 15 * 60_000;
export const UNSHALLOW_BACKOFF_CAP_MS = 6 * 60 * 60_000;

/**
 * WI-2142873: next backoff state after a tick. `failed` doubles the deferral
 * (15m, 30m, 1h, … capped at 6h); `ok` clears it (null); `deferred` / no
 * attempt leaves the prior state unchanged.
 */
export function nextUnshallowBackoff(
  prior: OwnHeadUnshallowBackoffState | null,
  unshallow: OwnHeadPublishTickOutcome['unshallow'],
  now: number,
): OwnHeadUnshallowBackoffState | null {
  if (!unshallow || unshallow.state === 'deferred') return prior;
  if (unshallow.state === 'ok' || unshallow.state === 'not-needed') return null;
  const failures = (prior?.failures ?? 0) + 1;
  const delay = Math.min(UNSHALLOW_BACKOFF_CAP_MS, UNSHALLOW_BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 16));
  return { failures, lastAttemptAt: now, nextAttemptAt: now + delay, lastError: unshallow.error ?? 'unknown' };
}

/** WI-2142873: most shallow-boundary lines checked before falling back to the
 *  unshallow (a depth-N clone has one line per fetched tip). */
const SHALLOW_COVERAGE_MAX_BOUNDARIES = 64;

/**
 * WI-2142873: does the bare store already hold the history a shallow worktree
 * hides? When every parent behind the worktree's shallow boundary is a commit
 * the store can walk to its root, the ref-less transfer ships only the
 * worktree's own new commits and the store's history stays complete across the
 * boundary. The `--unshallow` (a network fetch from `origin` that re-downloads
 * the whole history into the worktree) then buys nothing.
 *
 * Measured on the P-203 Mac VM, 2026-09-27: a July-10 depth-1 clone failed to
 * unshallow from GitHub inside the tick budget 3 times, so own-head publish
 * stayed frozen and the worktree fell 28,008 commits behind staging. The
 * local mirror already held the boundary's parent, and
 * `git fetch <worktree> <branch>` into that mirror took 9s and left the
 * history fully walkable.
 *
 * Conservative by construction: a shallow STORE, an unreadable shallow file,
 * too many boundaries, or any parent the store cannot walk answers false, and
 * the caller falls back to the unshallow. The G-10 guard's `rev-list` walk
 * stays the fail-closed check either way.
 */
export async function shallowBoundaryCoveredByStore(
  runGit: RunGit,
  worktreePath: string,
  storePath: string,
): Promise<boolean> {
  const storeShallow = await runGit(['rev-parse', '--is-shallow-repository'], storePath);
  if (storeShallow.code !== 0 || storeShallow.stdout.trim() !== 'false') return false;
  const shallowFile = await runGit(['rev-parse', '--git-path', 'shallow'], worktreePath);
  const rel = shallowFile.code === 0 ? shallowFile.stdout.trim() : '';
  if (!rel) return false;
  let boundaries: string[];
  try {
    const text = await readFile(isAbsolute(rel) ? rel : join(worktreePath, rel), 'utf8');
    boundaries = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return false;
  }
  if (boundaries.length === 0 || boundaries.length > SHALLOW_COVERAGE_MAX_BOUNDARIES) return false;
  const parents: string[] = [];
  for (const boundary of boundaries) {
    // `cat-file commit` prints the RAW object, so its parent lines survive the
    // shallow graft that hides them from rev-parse / rev-list.
    const raw = await runGit(['cat-file', 'commit', boundary], worktreePath);
    if (raw.code !== 0) return false;
    const header = raw.stdout.split('\n\n', 1)[0] ?? '';
    for (const line of header.split('\n')) {
      if (line.startsWith('parent ')) parents.push(line.slice('parent '.length).trim());
    }
  }
  if (parents.length === 0) return true;
  // One commit walk from every hidden parent to the root: a missing commit
  // anywhere on the way fails it, which is what the guard's walk would hit.
  const walk = await runGit(['rev-list', '--quiet', ...parents], storePath);
  return walk.code === 0;
}

export interface OwnHeadPublishTickOutcome {
  /** False only when the input could not even be evaluated (no worktree /
   *  unborn branch / detached HEAD with no branch given) — all legit no-ops. */
  ran: boolean;
  /** True iff the namespace ref moved this tick. */
  changed: boolean;
  /** The branch actually used (input or resolved), null when unresolvable. */
  branch: string | null;
  /** The worktree head judged this tick (null when `ran` is false). */
  headSha: string | null;
  /** The namespace ref's prior sha (null on first-ever publish). */
  priorSha: string | null;
  /** Set when the G-10 guard REFUSED a commit for a HARD reason (oversized
   *  blob / secret). WI-5738: this no longer implies nothing was published —
   *  the range is drained up to the offending commit first, so check
   *  `publishedSha`/`changed` for what DID become servable. Deliberate
   *  refusal, not an error. */
  refused: PublishGuardResult | null;
  /** WI-5738: the exact commit a hard refusal stopped at (null when none).
   *  Attribution is now one commit, not "somewhere in this range". */
  blockedAtCommit?: string | null;
  /** WI-5738: true when the publish advanced but did NOT reach the worktree
   *  head — a volume cap split the range and the remainder drains on
   *  following ticks. Not an error; a healthy partial publish.
   *
   *  EI-19341709637436070: named `backlogRemains` (not `drained`) DELIBERATELY —
   *  the prior name `drained` read as "has been drained" (healthy) while this is
   *  assigned `!resolution.complete`, i.e. it means the OPPOSITE: backlog still
   *  remains. Two separate agents had to leave "read the value, never the name"
   *  warning comments at the consumers before the field itself got renamed. */
  backlogRemains?: boolean;
  /** WI-5738: a single commit that alone exceeds the volume caps and so cannot
   *  be split. It IS published (refusing it forever is the outage this
   *  replaces); named here so the health layer can raise it. */
  oversizedCommit?: string | null;
  /** WI-5738: the sha actually written to the namespace ref this tick. */
  publishedSha?: string | null;
  /** Secret findings suppressed by a runtime path exemption this tick (WI-5591)
   *  — populated whether the publish ultimately admitted or was refused for a
   *  DIFFERENT reason, so an exemption's use is always visible for audit. */
  exemptedFindings: SecretFinding[];
  /** WI-2142873: set only when the source worktree was shallow this tick —
   *  `ok` unshallowed, `not-needed` skipped because the bare store already holds
   *  every parent the shallow boundary hides (see shallowBoundaryCoveredByStore),
   *  `failed` attempted and failed (error names why),
   *  `deferred` skipped because a prior failure's backoff is still active. */
  unshallow?: { state: 'ok' | 'not-needed' | 'failed' | 'deferred'; error?: string; deferredUntil?: number };
  errors: string[];
}

/**
 * ONE own-head publish pass: ensure the bare store, transfer the worktree
 * branch head's objects ref-lessly, guard the new range, CAS the namespace
 * branch ref. Safe to call on every git-sync tick — an unmoved head is a free
 * no-op (one rev-parse + one ref read).
 */
export async function runOwnHeadPublishTick(
  input: OwnHeadPublishTickInput,
): Promise<OwnHeadPublishTickOutcome> {
  const runGit = input.runGit ?? defaultRunGit;
  const errors: string[] = [];
  // WI-2142873: set to 'ok' once a shallow worktree was unshallowed this tick,
  // so every later outcome reports it and the caller clears its backoff.
  let unshallowResult: OwnHeadPublishTickOutcome['unshallow'];
  const unshallowTag = (): Pick<OwnHeadPublishTickOutcome, 'unshallow'> =>
    unshallowResult ? { unshallow: unshallowResult } : {};
  const noop = (branch: string | null): OwnHeadPublishTickOutcome => ({
    ran: false,
    changed: false,
    branch,
    headSha: null,
    priorSha: null,
    refused: null,
    exemptedFindings: [],
    errors,
  });

  // Resolve the branch: explicit config wins; otherwise the worktree's
  // checked-out branch (detached HEAD ⇒ nothing to publish under).
  let branch = input.branch ?? null;
  if (!branch) {
    const r = await runGit(['symbolic-ref', '-q', '--short', 'HEAD'], input.worktreePath);
    branch = r.code === 0 ? r.stdout.trim() : null;
    if (!branch) return noop(null);
  }
  const branchRef = `refs/heads/${branch}`;

  // Worktree head. An unborn branch (fresh clone of an empty repo) is a no-op.
  const head = await runGit(['rev-parse', '--verify', '-q', `${branchRef}^{commit}`], input.worktreePath);
  const headSha = head.code === 0 ? head.stdout.trim() : '';
  if (!headSha) return noop(branch);

  const repoPath = await ensurePotGitRepo(input.potHomeSlug, input.repoKey, runGit);

  let priorSha: string | null;
  try {
    priorSha = await readNamespaceRef(repoPath, input.devicePubkeyBase64, branchRef, runGit);
  } catch (e) {
    errors.push(`reading own namespace ref failed: ${e instanceof Error ? e.message : e}`);
    return { ...noop(branch), ran: true, headSha };
  }
  if (priorSha === headSha) {
    return { ran: true, changed: false, branch, headSha, priorSha, refused: null, exemptedFindings: [], ...unshallowTag(), errors };
  }

  // WI-5163: a SHALLOW source worktree (from-repo's `shallow:true` smoke
  // default) transfers ONLY the graft-truncated history via the ref-less
  // fetch below — the bare store gets no `.git/shallow` marker of its own, so
  // checkPublishGuard's `rev-list --objects` walk hits a commit whose parent
  // was never transferred and fail-closes (correct guard behavior, but the
  // net effect is this device can NEVER publish its own head — every tick
  // refuses forever, silently). Detect + unshallow the SOURCE worktree first
  // so the objects transferred are always full, walkable history. On failure,
  // reclaim this attempt's partial packs and stop before transferring incomplete
  // history. Reuse the normal git-sync cleanup for this separate fetch path.
  const shallowCheck = await runGit(['rev-parse', '--is-shallow-repository'], input.worktreePath);
  const worktreeShallow = shallowCheck.code === 0 && shallowCheck.stdout.trim() === 'true';
  // WI-2142873: checked BEFORE the deferral, because it needs no network: once
  // the store covers the boundary, a pending backoff is irrelevant.
  const storeCoversShallow =
    worktreeShallow && (await shallowBoundaryCoveredByStore(runGit, input.worktreePath, repoPath));
  if (storeCoversShallow) unshallowResult = { state: 'not-needed' };
  if (worktreeShallow && !storeCoversShallow) {
    const nowMs = (input.now ?? Date.now)();
    const deferredUntil = input.unshallowDeferredUntil ?? null;
    if (deferredUntil !== null && deferredUntil > nowMs) {
      // WI-2142873: a prior attempt failed; do not spend this tick's budget on
      // it again. Return immediately so every later git-sync leg still runs.
      errors.push(
        `source worktree is shallow; unshallow deferred until ${new Date(deferredUntil).toISOString()} ` +
          `after a failed attempt (own head not published until it succeeds)`,
      );
      return { ...noop(branch), ran: true, headSha, priorSha, unshallow: { state: 'deferred', deferredUntil } };
    }
    const remotesRes = await runGit(['remote'], input.worktreePath);
    const remoteName =
      (remotesRes.code === 0
        ? remotesRes.stdout
            .split('\n')
            .map((l) => l.trim())
            .find(Boolean)
        : undefined) ?? 'origin';
    // Generous network timeout — a real remote (e.g. GitHub) unshallow can
    // legitimately transfer a lot of history, not a local-op-speed transfer
    // (github-bridge-ingress-timeout-too-short-2026-07-20, EI-18189246091367226).
    const beforeUnshallow = await listTempPackFiles(runGit, input.worktreePath);
    let unshallow: Awaited<ReturnType<RunGit>> | undefined;
    try {
      unshallow = await runGit(['fetch', '--quiet', '--unshallow', remoteName], input.worktreePath, {
        timeoutMs: input.unshallowTimeoutMs ?? NETWORK_RUN_GIT_TIMEOUT_MS,
      });
    } finally {
      if (unshallow?.code !== 0) {
        await pruneFailedFetchTempPacks(runGit, input.worktreePath, beforeUnshallow, (message) => errors.push(message));
      }
    }
    if (unshallow.code !== 0) {
      const detail = `source worktree is shallow and could not be unshallowed (remote '${remoteName}'): ${unshallow.stderr.trim().slice(0, 500)}`;
      errors.push(detail);
      return { ...noop(branch), ran: true, headSha, priorSha, unshallow: { state: 'failed', error: detail } };
    }
    unshallowResult = { state: 'ok' };
  }

  // Ref-less object transfer: ODB + FETCH_HEAD only — no ref is created, so
  // upload-pack advertises nothing new until the guard below allows the write.
  const beforeTransfer = await listTempPackFiles(runGit, repoPath);
  let fetch: Awaited<ReturnType<RunGit>> | undefined;
  try {
    fetch = await runGit(['fetch', '--quiet', input.worktreePath, branchRef], repoPath);
  } finally {
    if (fetch?.code !== 0) {
      await pruneFailedFetchTempPacks(runGit, repoPath, beforeTransfer, (message) => errors.push(message));
    }
  }
  if (fetch.code !== 0) {
    errors.push(`object transfer from worktree failed: ${fetch.stderr.trim().slice(0, 500)}`);
    return { ran: true, changed: false, branch, headSha, priorSha, refused: null, exemptedFindings: [], ...unshallowTag(), errors };
  }

  // G-10: judge the (prior, head] range BEFORE the ref makes it servable. On a
  // rewound/rebased head this judges the new-side commits, same as announce.
  // Genesis (priorSha null): use the caller-verified already-exposed baseline
  // when given, so onboarding a pre-existing GitHub-backed repo judges only the
  // genuinely unexposed delta instead of refusing the whole history (see
  // genesisBaselineSha).
  const guardBaseline = priorSha ?? input.genesisBaselineSha ?? null;
  // WI-5738: resolve the furthest PUBLISHABLE sha instead of taking an
  // all-or-nothing verdict on the whole range. A volume refusal
  // (total-over-cap / object-flood) used to be TERMINAL here: the baseline
  // below advances ONLY via writeNamespaceRef, which runs ONLY after guard.ok
  // — so the baseline could only move through the publish it was blocking,
  // while every new commit enlarged the refused range (2261MB → 2415MB over
  // five days of total p2p outage, 2026-07-20). Now the range drains
  // incrementally, and a HARD refusal (oversized blob / secret) stops at the
  // exact offending commit with everything before it published.
  let resolution: IncrementalPublishResolution;
  try {
    resolution = await resolveIncrementalPublishSha({
      repoPath,
      fromOid: guardBaseline,
      toOid: headSha,
      caps: input.publishGuardCaps,
      runGit,
      workspaceId: input.workspaceId,
      // WI-10003528: skip content another device (or a remote) already exposed,
      // on EVERY publish, not only genesis — otherwise a device draining from
      // an old baseline re-judges months of already-public history.
      selfNamespaceHex: deviceNamespaceKey(input.devicePubkeyBase64),
    });
  } catch (e) {
    errors.push(`publish guard threw (refusing, fail-closed): ${e instanceof Error ? e.message : e}`);
    return { ran: true, changed: false, branch, headSha, priorSha, refused: null, exemptedFindings: [], ...unshallowTag(), errors };
  }
  errors.push(...resolution.errors);
  const guard = resolution.blocked?.result ?? null;
  const exemptedFindings = guard?.exemptedFindings ?? [];
  const publishSha = resolution.safeSha;
  const base = {
    ran: true as const,
    branch,
    headSha,
    priorSha,
    blockedAtCommit: resolution.blocked?.commit ?? null,
    oversizedCommit: resolution.oversizedCommit,
    exemptedFindings,
    ...unshallowTag(),
    errors,
  };
  // No forward progress at all — a hard refusal, reported exactly as before.
  if (!publishSha || publishSha === priorSha) {
    return { ...base, changed: false, backlogRemains: false, publishedSha: null, refused: guard };
  }

  try {
    await writeNamespaceRef(
      repoPath,
      input.devicePubkeyBase64,
      branchRef,
      publishSha,
      runGit,
      priorSha ?? undefined,
    );
  } catch (e) {
    errors.push(`namespace ref CAS write failed: ${e instanceof Error ? e.message : e}`);
    return { ...base, changed: false, backlogRemains: false, publishedSha: null, refused: null };
  }

  // The integrator gates member heads at the canonical WORK_REF, not the
  // branch-named ref — publish the alias too, over the same guarded range.
  // Best-effort: the branch ref is already servable, and the integrator's
  // default-branch fallback covers an alias miss.
  if (branchRef !== WORK_REF) {
    try {
      const workPrior = await readNamespaceRef(repoPath, input.devicePubkeyBase64, WORK_REF, runGit);
      // WI-5738: the alias tracks what was ACTUALLY published (publishSha),
      // never the unjudged head — on a partial drain those differ.
      if (workPrior !== publishSha) {
        await writeNamespaceRef(
          repoPath,
          input.devicePubkeyBase64,
          WORK_REF,
          publishSha,
          runGit,
          workPrior ?? undefined,
        );
      }
    } catch (e) {
      errors.push(`WORK_REF alias write failed (branch ref published): ${e instanceof Error ? e.message : e}`);
    }
  }
  return {
    ...base,
    changed: true,
    backlogRemains: !resolution.complete,
    publishedSha: publishSha,
    refused: guard,
  };
}
