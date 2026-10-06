/**
 * pot-git/worktree-bridge.ts — the staging→worktree bridge (Phase 7 G-7,
 * cross-machine-coord-parity-and-trust-2026-07-01 / P-031, D-010/D-011).
 *
 * WHAT THIS IS: the receiver-side glue that turns a SIGNED staging-advance
 * announcement (G-5d, staging-advance.ts — built by the integrator, carried by
 * the G-3 announcement rail) into a LOCAL working-tree update, composing the
 * already-landed seams end to end:
 *
 *   announcement → [pure fence: sig + device + (epoch,seq)]        (G-5d, no I/O)
 *               → [fetch the integrator's namespace over a duplex]  (G-2)
 *               → [full acceptance: ff of the last accepted staging](G-5d + git)
 *               → [object-bridge mirror → worktree ODB]             (this module)
 *               → [ff-only, dirty-safe worktree advance]            (G-7c/G-7b)
 *
 * ORDERING MATTERS: the PURE fence runs FIRST so a forged / stale / replayed
 * announcement is rejected for free — it can never trigger fetch traffic (a
 * hostile peer must not be able to make us dial out with junk envelopes).
 *
 * TWO LEVELS OF ACCEPTANCE, deliberately separate:
 *   - MIRROR acceptance (the watermark): the canonical staging moved — the
 *     caller persists `watermark` (epoch, seq, sha) whenever `outcome:
 *     'accepted'`, EVEN IF the worktree could not advance yet (deferred-dirty /
 *     diverged-manual). Staging is authority-published truth; the worktree is a
 *     best-effort follower.
 *   - WORKTREE advance (`advance` in the result): ff-only + dirty-safe per
 *     G-7c/G-7b — a deferral here is retried by the next sweep
 *     (`bridgeStagingShaToWorktree` with the persisted watermark sha) after the
 *     local autocommit picks the dirty files up.
 *
 * Injectable seams (all of it tests offline against real repos + a socket
 * duplex, no swarm): `openDuplex` dials the per-fetch stream (prod: a
 * `papercusp/pot-git` Protomux sub-stream on an existing hive connection —
 * leader-held wiring; tests: a unix socket). Omit `openDuplex` when the
 * objects are already local (the integrator's own machine).
 *
 * Fail-soft by contract: never throws on runtime data; every failure is a
 * typed outcome. (Sole exception: a config missing the mandatory device gate
 * throws — that is a wiring bug, not runtime data.)
 */

import type { Duplex } from 'node:stream';
import { type RunGit, defaultRunGit, deviceNamespaceKey } from './storage';
import { fetchPeerNamespace } from './fetch-transport';
import { fetchCoalescerKey, withFetchCoalescing } from './fetch-coalescer';
import { STAGING_REF, mergeTree } from './integrator';
import {
  type AcceptStagingAdvanceOpts,
  type EpochSeq,
  type SignedStagingAdvance,
  type StagingAdvanceAcceptance,
  acceptStagingAdvance,
  acceptStagingAdvanceFF,
} from './staging-advance';
import { type WorktreeAdvanceResult, advanceWorktree } from './worktree-advance';
import { scavengeStaleTempPacks } from '../../harness/git-sync/run-git-sync';

/** Where the worktree-side repo tracks the canonical staging it last bridged
 *  (a plain local ref — NEVER a branch anyone works on). */
export const WORKTREE_STAGING_REF = 'refs/hive/staging';

/**
 * WI-2142873: ceiling for the object-bridge fetch (mirror → worktree). Both
 * repos share one disk, so this is not an RPC: `pack-objects` builds a thin
 * pack against the worktree's SHALLOW boundary and the cost scales with the
 * history the worktree lacks. `defaultRunGit`'s 60s RPC default killed it on
 * EVERY attempt on the P-203 VM (2026-09-27: a first bridge needed a 2.98 GB
 * pack, 3m39s wall), so the worktree never received the objects and each kill
 * leaked a 300–700 MB `tmp_pack_*` (199 orphans, 8.4 GB, disk at 99%).
 * Must stay BELOW the git-sync action idle ceiling (LOCK_TTL_SEC=600s in
 * git-sync-action.ts) so a slow fetch fails this leg, not the whole action.
 */
export const WORKTREE_OBJECT_BRIDGE_FETCH_TIMEOUT_MS = 8 * 60_000;

export interface WorktreeBridgeConfig {
  /** The local pot-git bare mirror for this (hive, managed repo) — G-1. */
  bareRepoPath: string;
  /** The machine's working tree that follows canonical staging. */
  worktreePath: string;
  /** The last ACCEPTED watermark (both null before the first accept). The
   *  caller persists this and threads it back on the next announcement. */
  prior: { epochSeq: EpochSeq | null; stagingSha: string | null };
  /**
   * Dial a FRESH per-fetch duplex to a peer that can serve the integrator's
   * namespace (G-2). Omitted ⇒ no transport fetch — the objects are expected
   * to already be in the local mirror (e.g. this machine IS the integrator).
   *
   * Receives the ANNOUNCING device's pubkey (`incoming.device_pubkey`) — the
   * same identity `fetchPeerNamespace` then asks for on the wire, so the
   * duplex MUST terminate on that device (EI-14555). A zero-arg closure stays
   * assignable here (TS permits fewer params), which is why the offline tests
   * that dial a fixed unix socket needed no change.
   */
  openDuplex?: (devicePubkeyBase64: string) => Promise<Duplex>;
  /**
   * Device gate for the announcement — MANDATORY (HIGH fix, 2026-07-02
   * cross-review): `expectedDevice` = the current integrator authority, or
   * `allowedDevices` = the admitted member set (see staging-advance.ts). One of
   * the two MUST be set — without a device gate `acceptStagingAdvance` checks
   * signature SELF-consistency only, so ANY key can self-sign an
   * `epoch: 1e9` envelope over the CURRENT sha; the fence would accept it,
   * poison the persisted watermark, and every legitimate future advance would
   * be rejected as `stale-epoch-seq` (a one-message DoS). A gate-less config is
   * a programmer error and THROWS (the one deliberate exception to the
   * fail-soft contract).
   *
   * With `allowedDevices` (a member SET), ALSO set `maxGrantedEpoch` (WI-1560,
   * see AcceptStagingAdvanceOpts) — the ADMITTED-member variant of the same
   * poisoning is otherwise still open: any member key passes the set gate and
   * can claim an arbitrary epoch. Cap it at the lease epoch. (Production no
   * longer publishes per-advance handoff tokens — WI-10005753 / git-live
   * D-055 — so `adoptHandoffToken(...).nextEpoch` is a legacy-only source.)
   */
  accept: AcceptStagingAdvanceOpts;
  runGit?: RunGit;
  fetchTimeoutMs?: number;
}

export type StagingAdvanceBridgeResult =
  | {
      /** The announcement failed the fence (forged / stale / wrong device /
       *  non-ff / unknown sha). Nothing was applied; watermark unchanged. */
      outcome: 'rejected';
      reason: Extract<StagingAdvanceAcceptance, { ok: false }>['reason'];
      /** True when the reject happened BEFORE any fetch (the pure fence). */
      preFetch: boolean;
    }
  | {
      /** The transport fetch failed — try again on the next announcement. */
      outcome: 'fetch-failed';
      detail: string;
    }
  | {
      /** Another driver is already fetching this exact repo+device. Hold the
       * cursor and retry later, but do not report a transport failure. */
      outcome: 'already-in-flight';
    }
  | {
      /** Accepted: the canonical staging moved. PERSIST `watermark`. The
       *  worktree-level result rides along (advanced / noop / deferred-dirty /
       *  diverged-manual / error) — a non-advance there is NOT a rejection. */
      outcome: 'accepted';
      watermark: { epochSeq: EpochSeq; stagingSha: string };
      advance: WorktreeAdvanceResult;
    };

/**
 * Bring the objects reachable from the integrator's published staging into the
 * WORKTREE's own ODB (worktree and mirror are separate repos), then ff-advance
 * the worktree (G-7c/G-7b). Fetches BY REF NAME (always advertised), pinning
 * the worktree-side `refs/hive/staging`; the advance itself targets `sha` —
 * even if the mirror ref has already moved past it, ff-only means the newer
 * ref contains `sha`, so the objects are present either way.
 *
 * Also the RETRY path for a deferred/diverged worktree: call it from the sweep
 * with the persisted watermark sha once the local autocommit has drained the
 * dirty files.
 */
export async function bridgeStagingShaToWorktree(
  bareRepoPath: string,
  worktreePath: string,
  integratorDevicePubkeyBase64: string,
  sha: string,
  opts: {
    runGit?: RunGit;
    fetchTimeoutMs?: number;
    /** Test seam for the post-failure temp-pack reclaim (defaults to the real scavenger). */
    reclaimTempPacks?: (worktreePath: string) => Promise<{ removed: string[]; bytesReclaimed: number }>;
  } = {},
): Promise<WorktreeAdvanceResult> {
  const runGit = opts.runGit ?? defaultRunGit;
  try {
    const nsStaging = `refs/namespaces/${deviceNamespaceKey(integratorDevicePubkeyBase64)}/${STAGING_REF}`;
    const fetchError = await fetchMirrorRefIntoWorktree(bareRepoPath, worktreePath, nsStaging, { ...opts, runGit });
    if (fetchError !== null) return { outcome: 'error', from: null, to: sha, detail: fetchError };
    return advanceWorktree(worktreePath, sha, { runGit });
  } catch (e) {
    return { outcome: 'error', from: null, to: sha, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Object-bridge `sourceRef` from the bare mirror into the worktree's
 * `refs/hive/staging`. Returns null on success, or the failure detail (after
 * reclaiming any partial temp pack the failed fetch stranded).
 */
async function fetchMirrorRefIntoWorktree(
  bareRepoPath: string,
  worktreePath: string,
  sourceRef: string,
  opts: {
    runGit: RunGit;
    fetchTimeoutMs?: number;
    reclaimTempPacks?: (worktreePath: string) => Promise<{ removed: string[]; bytesReclaimed: number }>;
  },
): Promise<string | null> {
  const { runGit } = opts;
  const reclaimTempPacks =
    opts.reclaimTempPacks ??
    ((repo: string) =>
      // staleMs 0: a killed fetch's own partial pack is reclaimed at once. The
      // scavenger still refuses any file that is open (a concurrent fetch in the
      // same worktree is writing it), referenced, or changing — so this never
      // races a live index-pack, and it also clears older crash-left leaks.
      scavengeStaleTempPacks(runGit, repo, (m) => console.warn(m), { staleMs: 0 }));
  const fetched = await runGit(
    ['fetch', '-q', bareRepoPath, `+${sourceRef}:${WORKTREE_STAGING_REF}`],
    worktreePath,
    { timeoutMs: opts.fetchTimeoutMs ?? WORKTREE_OBJECT_BRIDGE_FETCH_TIMEOUT_MS },
  );
  if (fetched.code === 0) return null;
  // WI-2142873: a timed-out/killed fetch strands index-pack's partial
  // `tmp_pack_*` (SIGKILL skips git's own cleanup). Reclaim it now; waiting
  // for age-based GC let 8.4 GB accumulate on the P-203 VM in 16h.
  let reclaimed = '';
  try {
    const r = await reclaimTempPacks(worktreePath);
    if (r.removed.length > 0) {
      reclaimed = `; reclaimed ${r.removed.length} partial temp pack(s), ${r.bytesReclaimed} bytes`;
    }
  } catch {
    // best-effort: a reclaim failure must never mask the fetch error
  }
  return `object-bridge fetch from the mirror failed: ${fetched.stderr.trim()}${reclaimed}`;
}

/** Result of {@link catchUpWorktreeToWatermark}: `current` is the cheap
 *  steady-state answer (the worktree already contains the watermark), so the
 *  caller can tell "nothing to retry" from a real advance attempt. */
export type WorktreeCatchUpResult =
  | { outcome: 'current'; to: string }
  | (WorktreeAdvanceResult & {
      /** Set only on `diverged-manual` (WI-10006476 / plan
       *  agent-capacity-and-cost-gcp-2026-09-30 D-055): the paths a 3-way merge of
       *  the local head with the hive head conflicts on. `[]` = the merge is clean,
       *  so the integrator will merge this member's head itself and the divergence
       *  is transient. Absent = not probed, or the probe failed (see `detail`). A
       *  non-empty list is the state that never resolves on its own: the
       *  integrator parks the member head, and this ff-only worktree cannot follow. */
      conflictPaths?: string[];
    });

/**
 * WI-10003772 — the deferred-advance retry sweep. `handleStagingAdvance`
 * persists the watermark even when the worktree could not follow
 * (deferred-dirty / diverged-manual / a transient error), and nothing
 * re-announces that same staging. Before this sweep existed the caller only
 * re-tried on the NEXT accepted announcement, so a member that cleaned up its
 * overlapping dirt sat on stale staging indefinitely, and its next commit
 * landed on a stale base (P-505 run 25: a guaranteed content conflict at the
 * integrator, staging frozen).
 *
 * Call it every bridge tick that accepted nothing. The steady state is cheap
 * and fetch-free: when the worktree already contains `stagingSha` it returns
 * `current` after one rev-parse + one ancestry check. Otherwise it fetches the
 * BARE mirror's canonical pin (`refs/hive/staging`, which step 3.5 of
 * `handleStagingAdvance` sets on every acceptance — device-agnostic, so the
 * persisted watermark needs no announcing-device field) only when the object
 * is missing locally, then applies the same ff-only, dirty-safe, never-rewind
 * `advanceWorktree`. A still-dirty or diverged worktree simply stays deferred
 * and is retried next tick. Never throws.
 */
export async function catchUpWorktreeToWatermark(
  bareRepoPath: string,
  worktreePath: string,
  stagingSha: string,
  opts: {
    runGit?: RunGit;
    fetchTimeoutMs?: number;
    reclaimTempPacks?: (worktreePath: string) => Promise<{ removed: string[]; bytesReclaimed: number }>;
  } = {},
): Promise<WorktreeCatchUpResult> {
  const runGit = opts.runGit ?? defaultRunGit;
  try {
    const haveTarget = (await runGit(['cat-file', '-e', `${stagingSha}^{commit}`], worktreePath)).code === 0;
    if (haveTarget) {
      const headR = await runGit(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], worktreePath);
      const head = headR.code === 0 ? headR.stdout.trim() : '';
      if (
        head === stagingSha ||
        (head !== '' && (await runGit(['merge-base', '--is-ancestor', stagingSha, head], worktreePath)).code === 0)
      ) {
        return { outcome: 'current', to: stagingSha };
      }
    } else {
      const fetchError = await fetchMirrorRefIntoWorktree(bareRepoPath, worktreePath, WORKTREE_STAGING_REF, {
        ...opts,
        runGit,
      });
      if (fetchError !== null) return { outcome: 'error', from: null, to: stagingSha, detail: fetchError };
    }
    const advanced = await advanceWorktree(worktreePath, stagingSha, { runGit });
    if (advanced.outcome !== 'diverged-manual' || advanced.from === null) return advanced;
    // D-055: name what keeps this member diverged. Same merge the integrator runs,
    // so a conflict here is (up to the member's last publish) the park there.
    const probe = await mergeTree(worktreePath, advanced.from, stagingSha, runGit);
    if ('tree' in probe) return { ...advanced, conflictPaths: [] };
    if ('conflict' in probe) return { ...advanced, conflictPaths: [...probe.paths].sort() };
    return { ...advanced, detail: `${advanced.detail ?? 'diverged'}; conflict probe failed: ${probe.error}` };
  } catch (e) {
    return { outcome: 'error', from: null, to: stagingSha, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * G-7: handle ONE staging-advance announcement end to end. Never throws.
 *
 *   1. PURE fence (no I/O): signature + device gate + strict (epoch, seq)
 *      monotonicity vs `cfg.prior.epochSeq` — a junk envelope never dials out.
 *   2. Fetch the integrator's namespace into the local mirror (when
 *      `openDuplex` is given) — G-2 `fetchPeerNamespace`.
 *   3. FULL acceptance vs the mirror: the announced sha resolves locally AND
 *      is a fast-forward of the last accepted staging (never rewinds).
 *   4. Object-bridge to the worktree + ff-only dirty-safe advance.
 *
 * On `outcome: 'accepted'` the caller MUST persist `watermark` — including
 * when the worktree advance was deferred (the sweep catches it up later).
 *
 * Never throws on runtime DATA (announcements, transport, git) — but a config
 * with no device gate is a programmer error and throws immediately (see
 * `WorktreeBridgeConfig.accept`).
 */
export async function handleStagingAdvance(
  cfg: WorktreeBridgeConfig,
  incoming: SignedStagingAdvance,
): Promise<StagingAdvanceBridgeResult> {
  // MANDATORY device gate — misconfiguration must fail LOUD, before any
  // envelope can reach a self-consistency-only fence (watermark poisoning).
  if (
    cfg.accept === undefined ||
    (cfg.accept.expectedDevice === undefined && cfg.accept.allowedDevices === undefined)
  ) {
    throw new TypeError(
      'worktree-bridge: cfg.accept must pin a device gate (expectedDevice or allowedDevices) — ' +
        'without one, any key can self-sign a max-epoch staging-advance over the current sha ' +
        'and poison the watermark fence (accepted, then every real advance is stale-epoch-seq)',
    );
  }
  const runGit = cfg.runGit ?? defaultRunGit;
  try {
    // 1) Pure fence FIRST — reject junk before any network or git I/O.
    const pure = acceptStagingAdvance(incoming, cfg.prior.epochSeq, cfg.accept);
    if (!pure.ok) return { outcome: 'rejected', reason: pure.reason, preFetch: true };

    // 2) Mirror the integrator's namespace (objects + refs) over the duplex —
    //    strictly ON DEMAND (EI-14555). The dial is skipped whenever the
    //    announced sha is ALREADY a commit in the local mirror, which is the
    //    common case: this machine IS the integrator, or P-202's ref-announce
    //    fetch already synced the namespace. Making the fetch conditional (it
    //    used to fire on every announcement whenever `openDuplex` was set) is
    //    what lets git-sync-action wire this seam unconditionally:
    //      - a SELF-announcement would otherwise dial our OWN device pubkey,
    //        which resolves no socket -> `fetch-failed` -> the P-505 cursor
    //        HOLDS -> the worktree bridge wedges. Skipping the dial when the
    //        objects are local removes that whole failure mode.
    //      - an already-current mirror no longer pays a swarm round-trip per
    //        announcement.
    //    This generalizes the old caller-level advice ("omit openDuplex when
    //    the objects are already local") into a per-announcement decision the
    //    bridge makes for itself.
    if (cfg.openDuplex) {
      const haveSha = await runGit(
        ['rev-parse', '--verify', '-q', `${incoming.staging_sha}^{commit}`],
        cfg.bareRepoPath,
      );
      if (haveSha.code !== 0) {
        // WI-6418: worktree-bridge is a THIRD fetch driver, alongside
        // ref-announce and bootstrap. Every managed harness's git-sync routine
        // can reach this path against the same shared mirror, so leaving it
        // outside the process-wide coalescer still let a later routine open a
        // rival session while the first was streaming. Reuse ref-announce's
        // exact (repoPath, device) key so the two drivers exclude each other.
        const coalesced = await withFetchCoalescing(
          fetchCoalescerKey(cfg.bareRepoPath, incoming.device_pubkey),
          async (): Promise<{ ok: true } | { ok: false; detail: string }> => {
            let duplex: Duplex;
            try {
              duplex = await cfg.openDuplex!(incoming.device_pubkey);
            } catch (e) {
              return {
                ok: false,
                detail: `openDuplex failed: ${e instanceof Error ? e.message : String(e)}`,
              };
            }
            const fetched = await fetchPeerNamespace(cfg.bareRepoPath, duplex, incoming.device_pubkey, {
              timeoutMs: cfg.fetchTimeoutMs,
            });
            return fetched.code === 0
              ? { ok: true }
              : { ok: false, detail: fetched.stderr.trim() || `fetch exited ${fetched.code}` };
          },
        );
        if (!coalesced.ran) return { outcome: 'already-in-flight' };
        if (!coalesced.result.ok) {
          return { outcome: 'fetch-failed', detail: coalesced.result.detail };
        }
      }
    }

    // 3) Full acceptance: sha present locally + ff of the last accepted staging.
    // A recorded watermark whose OBJECT is gone from this store (pruned store,
    // drill residue, re-clone) can never verify ancestry — is-ancestor errors
    // and every legitimate advance rejects as non-fast-forward FOREVER
    // (live-caught on the hello-world-3-pot canary: watermark ad47cd48's
    // object was missing, so the epoch-2 takeover advance was consumed+
    // rejected every tick). Re-anchor an unverifiable watermark on the bare
    // canonical ref (the very ref step 3.5 maintains — the true local
    // lineage anchor); if that is absent too, treat as genesis (sha-exists
    // check still applies, and the worktree advance below is ff-only anyway).
    let effectivePriorSha = cfg.prior.stagingSha;
    if (effectivePriorSha) {
      const priorExists = await runGit(['rev-parse', '--verify', '-q', `${effectivePriorSha}^{commit}`], cfg.bareRepoPath);
      if (priorExists.code !== 0) {
        const cur = await runGit(['rev-parse', '--verify', '-q', `${WORKTREE_STAGING_REF}^{commit}`], cfg.bareRepoPath);
        const reanchored = cur.code === 0 ? cur.stdout.trim() : null;
        console.warn(
          `[worktree-bridge] watermark stagingSha ${effectivePriorSha.slice(0, 12)} has no object in ${cfg.bareRepoPath} — ` +
            `re-anchoring the FF fence on ${reanchored ? `canonical ${reanchored.slice(0, 12)}` : 'genesis (no canonical ref either)'}`,
        );
        effectivePriorSha = reanchored;
      }
    }
    const full = await acceptStagingAdvanceFF(
      cfg.bareRepoPath,
      incoming,
      cfg.prior.epochSeq,
      effectivePriorSha,
      { ...cfg.accept, runGit },
    );
    if (!full.ok) return { outcome: 'rejected', reason: full.reason, preFetch: false };

    // 3.5) Maintain the BARE-side canonical mirror: the GitHub bridge's egress
    //      leg reads `refs/hive/staging` from the BARE repo (github-bridge-tick
    //      BRIDGE_CANONICAL_REF — same ref string as WORKTREE_STAGING_REF), so
    //      every accepted advance must pin it there, not only in the worktree.
    //      Safe: the FF fence just ran, so this never rewinds the canonical
    //      line. Best-effort: on failure the github-bridge leg's catch-up pin
    //      (git-sync-action) re-derives it from the persisted watermark.
    await runGit(['update-ref', WORKTREE_STAGING_REF, incoming.staging_sha], cfg.bareRepoPath);

    // 4) Follow with the worktree (ff-only, dirty-safe; deferral is fine).
    const advance = await bridgeStagingShaToWorktree(
      cfg.bareRepoPath,
      cfg.worktreePath,
      incoming.device_pubkey,
      incoming.staging_sha,
      { runGit },
    );

    return {
      outcome: 'accepted',
      watermark: {
        epochSeq: { epoch: incoming.epoch, seq: incoming.seq },
        stagingSha: incoming.staging_sha,
      },
      advance,
    };
  } catch (e) {
    // Fail-soft backstop: surface as a transport-class failure, never throw.
    return { outcome: 'fetch-failed', detail: e instanceof Error ? e.message : String(e) };
  }
}
