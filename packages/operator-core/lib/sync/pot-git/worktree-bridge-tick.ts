/**
 * pot-git/worktree-bridge-tick.ts — P-204: the RUNTIME DRIVER for the
 * worktree bridge (p2p-git-live-activation-2026-07-09 P-204).
 *
 * Every piece already exists as a pure library: `staging-advance.ts` (G-5d
 * signed, epoch-fenced announcement), `worktree-bridge.ts` (G-7 announcement
 * → fetch → accept → ff-only worktree advance), `worktree-advance.ts` (G-7c/
 * G-7b). NONE of it runs on a schedule yet — this module is that missing
 * tick, composed exactly the way `integrator-tick.ts` (P-203) and
 * `ref-announce-tick.ts` (P-202) compose their own already-landed legs
 * (D-003: no new scheduler — the caller rides the existing `system:git-sync`
 * tick, mode-gated to `hiveGit.mode != legacy`).
 *
 * ONE TICK: given the pending inbound `pot-git:staging-advance` announcements
 * the caller collected off the P-009 fed-event log since its watermark
 * (`STAGING_ADVANCE_EVENT_KEY`, OLDEST FIRST — normally just one, since
 * `integrator-tick.ts` only ever emits on an actual advance, but a sparse
 * tick cadence or a caught-up cold start can hand this several at once), run
 * `handleStagingAdvance` per announcement, IN ORDER, threading the running
 * watermark from one to the next:
 *
 *   - `accepted` ⇒ advance the running watermark to this announcement's and
 *     continue to the next pending item (the worktree-level result rides
 *     along — a deferred/diverged worktree is NOT a rejection, see
 *     worktree-bridge.ts; the next sweep or the next accepted staging-advance
 *     retries it).
 *   - `rejected` (stale/malformed/forged/non-ff/unknown-sha) ⇒ skip it and
 *     continue — one bad/stale envelope in the batch must never starve the
 *     rest (mirrors `ref-announce-tick.ts`'s receive-tick contract).
 *   - `fetch-failed` ⇒ CONTINUE to the next pending item (WI-2039873 / P-203
 *     Leg A). A fetch failure is a fact about ONE announcing device's
 *     reachability, not about the batch: stopping there was head-of-line
 *     blocking by construction — one announcement from a device no peer holds
 *     a socket for (measured: a staging-advance signed by a gh-login actor the
 *     swarm never filed a hello for) pinned the VM at epoch=90,seq=315 for
 *     hours while every later announcement, from reachable devices, sat
 *     behind it unattempted. Staging advances are a total order on
 *     (epoch, seq), so a LATER accepted announcement SUPERSEDES an earlier
 *     failed one — on retry the failed one would reject `stale-epoch-seq`
 *     anyway. The cursor therefore holds at the earliest fetch-failed item that
 *     no later accept superseded (see `unprocessedFromIndex`), and only there.
 *     Within one tick, a device whose fetch already failed is NOT re-dialed
 *     (the dial seam short-circuits), so a dead device costs one dial per tick
 *     rather than one per queued announcement — an item from that device whose
 *     objects are already local still accepts, because it never dials.
 *   - `already-in-flight` ⇒ STOP processing further pending items this tick
 *     and return what's been done so far. It is a healthy coalescer refusal, so
 *     it holds the cursor without adding an error; the in-flight driver will
 *     finish the shared mirror fetch.
 *
 * The caller MUST persist the returned `watermark` (unconditionally — even
 * when nothing advanced this tick, so a resumed/retried caller doesn't
 * re-derive it) and should re-drive `bridgeStagingShaToWorktree` from a
 * separate dirty-drain sweep for any `deferred-dirty`/`diverged-manual`
 * worktree result it wants to retry outside of a fresh announcement (see
 * worktree-bridge.ts's own header — this tick does not do that itself).
 *
 * Never throws — every failure is folded into `errors`; a tick that hits one
 * always still returns its partial results (matches `handleStagingAdvance`'s
 * own fail-soft contract, plus a defensive catch here in case a future seam
 * bug breaks that contract).
 */
import type { Duplex } from 'node:stream';
import type { RunGit } from './storage';
import {
  type AcceptStagingAdvanceOpts,
  type EpochSeq,
  type SignedStagingAdvance,
  compareEpochSeq,
} from './staging-advance';
import { type StagingAdvanceBridgeResult, type WorktreeBridgeConfig, handleStagingAdvance } from './worktree-bridge';

export interface WorktreeBridgeTickInput {
  /** The local pot-git bare mirror for this (hive, managed repo) — G-1. */
  bareRepoPath: string;
  /** The machine's working tree that follows canonical staging. */
  worktreePath: string;
  /** Pending inbound staging-advance announcements collected off the fed-event
   *  log since the caller's watermark, OLDEST FIRST. Empty ⇒ a fast no-op
   *  (the common case on a git-sync tick where staging hasn't moved). */
  pending: readonly SignedStagingAdvance[];
  /** The last ACCEPTED watermark (both null before the first accept). The
   *  caller persists this and threads it back on the next tick. */
  prior: { epochSeq: EpochSeq | null; stagingSha: string | null };
  /** Device gate for every announcement this tick — MANDATORY, see
   *  worktree-bridge.ts's `WorktreeBridgeConfig.accept` for why a gate-less
   *  config throws (watermark-poisoning DoS). */
  accept: AcceptStagingAdvanceOpts;
  /**
   * Dial a FRESH per-fetch duplex to a peer that can serve the announcing
   * integrator's namespace (G-2, P-201's `openHiveGitFetchDuplex` client
   * seam). Called once PER pending announcement that reaches the fetch step
   * (a rejected-pre-fetch announcement never dials). Omit when the objects
   * are already local (this machine IS the integrator, or P-202's
   * ref-announce fetch already synced the namespace into the local mirror).
   *
   * Receives the ANNOUNCING device's pubkey so the caller can dial that
   * specific peer (EI-14555). WI-3583's per-device registry
   * (`peer-dial-registry.ts`) resolves device pubkey → live swarm socket, so
   * git-sync-action.ts now wires this the same way it wires the ref-announce
   * leg's `openStream` — a cold machine whose mirror lacks the announced sha
   * fetches on demand instead of rejecting `unknown-sha` forever. Still
   * optional: omit when the objects are always local (the integrator's own
   * machine) or in offline tests that serve from a fixed socket.
   */
  openDuplex?: (devicePubkeyBase64: string) => Promise<Duplex>;
  runGit?: RunGit;
  fetchTimeoutMs?: number;
  /**
   * TEST SEAM — the per-announcement handler, defaulting to
   * `handleStagingAdvance`. Production never sets it. It exists so the batch
   * policy this module owns (continue / hold / supersede / stop, and the
   * cursor index it reports) can be unit-tested by scripting outcomes, without
   * standing up the git repos, sockets and signatures the real handler needs
   * (those live in worktree-bridge-tick.integration.test.ts).
   */
  handle?: typeof handleStagingAdvance;
}

export interface WorktreeBridgeTickResultEntry {
  epoch: number;
  seq: number;
  stagingSha: string;
  bridge: StagingAdvanceBridgeResult;
}

/**
 * Rejections that are TRANSIENT-STATE, not verdicts on the envelope (P-505,
 * the WI-3497 drop-forever fix): `unknown-sha` = the objects haven't fetched
 * into the local mirror yet (P-202's ref-announce fetch races the fed-event);
 * `ungranted-epoch` = a successor authority's first advance arrived before
 * its granting handoff token federated. Both verify unchanged on a later
 * tick, so the batch STOPS there (same rationale as `fetch-failed`) and the
 * caller must NOT advance its cursor past the item. Every other reason
 * (stale/forged/wrong-device/non-ff/malformed) is a terminal verdict on the
 * envelope itself — retrying can never change it — so those skip-and-continue.
 */
export const RETRYABLE_REJECT_REASONS: ReadonlySet<string> = new Set(['unknown-sha', 'ungranted-epoch', 'unknown-generation']);

/** P-505: how long a transient staging-advance rejection may pin the
 * fed-event cursor before the stopped row is consumed as genuinely lost. */
export const WORKTREE_BRIDGE_RETRY_TTL_MS = 6 * 60 * 60 * 1000;

export interface WorktreeBridgeCursorRow {
  id: number;
  tsMs: number | null;
}

/**
 * Translate a tick's stop index into the durable fed-event cursor.
 *
 * This is deliberately pure because the boundary is the drop-forever rail:
 * before the TTL (including the exact boundary, or when age is unknowable),
 * hold immediately BEFORE the stopped row so it re-collects next tick. After
 * the TTL, consume ONLY that row and remain before its tail, so one lost
 * object/token cannot wedge every later announcement.
 */
export function decideWorktreeBridgeCursor(input: {
  maxRowId: number;
  pendingRows: readonly WorktreeBridgeCursorRow[];
  unprocessedFromIndex: number | null;
  nowMs: number;
  retryTtlMs?: number;
}): { cursor: number; expiredRow: WorktreeBridgeCursorRow | null } {
  const retryTtlMs = input.retryTtlMs ?? WORKTREE_BRIDGE_RETRY_TTL_MS;
  const k = input.unprocessedFromIndex;
  if (k === null) {
    return { cursor: input.maxRowId, expiredRow: null };
  }
  if (!Number.isInteger(k) || k < 0 || k >= input.pendingRows.length) {
    // Fail closed. A non-null stop index means the tick explicitly left one
    // row unprocessed. If it no longer maps to the index-aligned row census,
    // advancing to maxRowId would silently consume that row and recreate the
    // P-505 drop-forever failure this helper exists to prevent. The caller's
    // outer tick guard logs the error and leaves the prior cursor untouched.
    throw new RangeError(
      `worktree-bridge stop index ${k} is outside pendingRows[0..${input.pendingRows.length - 1}]`,
    );
  }

  const stuck = input.pendingRows[k]!;
  const age = stuck.tsMs === null ? null : input.nowMs - stuck.tsMs;
  if (age !== null && age > retryTtlMs) {
    return { cursor: stuck.id, expiredRow: stuck };
  }
  return { cursor: stuck.id - 1, expiredRow: null };
}

export interface WorktreeBridgeTickOutcome {
  ran: boolean;
  results: WorktreeBridgeTickResultEntry[];
  /** The watermark to persist — advances to the LAST accepted announcement's
   *  (epoch, seq, sha); unchanged from `input.prior` when nothing in this
   *  batch was accepted. ALWAYS persist this (even when `ran: false` or
   *  unchanged) so a resumed caller has a stable value to thread back. */
  watermark: { epochSeq: EpochSeq | null; stagingSha: string | null };
  /** True when at least one `fetch-failed` item is HOLDING the cursor this
   *  tick — i.e. its fetch failed AND no later announcement in the batch was
   *  accepted past its (epoch, seq). A fetch-failed item that a later accept
   *  superseded does not count: it was processed by being overtaken. The
   *  batch itself is never stopped by a fetch failure (see module header). */
  stoppedOnFetchFailure: boolean;
  /**
   * Index into `input.pending` of the first item NOT durably processed this
   * tick, or null when every item was (accepted, terminally rejected, or
   * fetch-failed-then-superseded). It is the value the caller's cursor math
   * needs: advance the fed-event cursor only past items BEFORE this index (the
   * held item re-collects and retries next tick). Three things set it, and the
   * EARLIEST wins: the first fetch-failed item that no later accept superseded;
   * a retryable rejection ({@link RETRYABLE_REJECT_REASONS}), which stops the
   * batch; an `already-in-flight` refusal, which also stops it. The caller
   * should age-bound the retry (a row stuck for hours is a genuinely lost
   * object or a dead device, not a race) so one poisoned row can't wedge the
   * cursor forever.
   */
  unprocessedFromIndex: number | null;
  errors: string[];
  /**
   * EI-19332963201820362: how many announcements this tick ACCEPTED. Together
   * with `results.length` (how many it consumed) this is the acceptance census
   * a health layer needs, and it exists because the absence of it hid a ~6h
   * canonical-staging freeze on 2026-08-02 behind uniformly green surfaces.
   *
   * `consumed >= 1 && acceptedCount === 0` is a REPORTABLE condition. It is not
   * necessarily a fault for ONE tick (a single stale/replayed envelope is
   * ordinary), but it is never healthy as a STEADY STATE: it means the cursor
   * is draining the announcement log while the watermark stands still.
   */
  acceptedCount: number;
  /**
   * EI-19332963201820362: terminal (non-retryable) rejections this tick, counted
   * by reason — `{ 'non-fast-forward': 12 }`.
   *
   * Note the inversion this exists to correct: RETRYABLE rejections, which are
   * transient and self-correcting, each push to {@link WorktreeBridgeTickOutcome.errors}
   * and halt the batch — they are LOUD. TERMINAL rejections, which by definition
   * can never succeed on retry and therefore indicate a PERSISTENT problem, used
   * to skip-and-continue emitting nothing at all. The quiet path was the
   * dangerous one.
   */
  terminalRejections: Record<string, number>;
}

/**
 * ONE tick: process every pending staging-advance announcement against the
 * local mirror + worktree, in order. Never throws — see module header for
 * the per-outcome continue/stop contract.
 */
export async function runWorktreeBridgeTick(
  input: WorktreeBridgeTickInput,
): Promise<WorktreeBridgeTickOutcome> {
  const errors: string[] = [];
  const results: WorktreeBridgeTickResultEntry[] = [];
  let watermark = input.prior;
  // EI-19332963201820362: the acceptance census. Both were already derivable
  // from `results` and simply never aggregated — the information was computed
  // and dropped on every one of ~6h of ticks.
  let acceptedCount = 0;
  const terminalRejections: Record<string, number> = {};

  if (input.pending.length === 0) {
    return {
      ran: false,
      results,
      watermark,
      stoppedOnFetchFailure: false,
      unprocessedFromIndex: null,
      errors,
      acceptedCount,
      terminalRejections,
    };
  }

  // WI-2039873 / P-203 Leg A — the head-of-line fix (module header). Fetch
  // failures are recorded with the fence each item would still have to clear,
  // and the cursor decision is made ONCE, at the end of the batch (or at an
  // explicit stop), against the watermark the batch actually reached.
  const fetchFailed: Array<{ index: number; epochSeq: EpochSeq }> = [];
  // Devices whose fetch failed this tick. The dial seam refuses a second dial
  // to any of them for the rest of the tick: the dial is per announcement, so
  // without this a dead device with N queued advances costs N dial timeouts
  // per tick. An announcement whose sha is already local never reaches the
  // seam, so this cannot starve an acceptable item from that device.
  const fetchFailedDevices = new Set<string>();
  const upstreamOpenDuplex = input.openDuplex;
  const openDuplex = upstreamOpenDuplex
    ? async (devicePubkeyBase64: string): Promise<Duplex> => {
        if (fetchFailedDevices.has(devicePubkeyBase64)) {
          throw new Error(
            `dial skipped: a fetch from ${devicePubkeyBase64.slice(0, 12)} already failed this tick — retrying next tick`,
          );
        }
        return upstreamOpenDuplex(devicePubkeyBase64);
      }
    : undefined;
  const handle = input.handle ?? handleStagingAdvance;

  const settle = (stopIndex: number | null): WorktreeBridgeTickOutcome => {
    // A fetch-failed item is SUPERSEDED once the watermark is at or past its
    // fence: on retry it would reject `stale-epoch-seq`, so holding the cursor
    // for it would only re-collect a dead row. Hold at the earliest one a later
    // accept did NOT supersede — and never later than an explicit stop.
    const held = fetchFailed.filter(
      (f) => watermark.epochSeq === null || compareEpochSeq(f.epochSeq, watermark.epochSeq) > 0,
    );
    const superseded = fetchFailed.length - held.length;
    if (superseded > 0) {
      errors.push(
        `${superseded} fetch-failed announcement(s) superseded by a later accepted advance this tick — not held`,
      );
    }
    const heldIndex = held.length > 0 ? held[0]!.index : null;
    const unprocessedFromIndex =
      heldIndex === null ? stopIndex : stopIndex === null ? heldIndex : Math.min(heldIndex, stopIndex);
    return {
      ran: true,
      results,
      watermark,
      stoppedOnFetchFailure: heldIndex !== null,
      unprocessedFromIndex,
      errors,
      acceptedCount,
      terminalRejections,
    };
  };

  for (const [index, incoming] of input.pending.entries()) {
    const cfg: WorktreeBridgeConfig = {
      bareRepoPath: input.bareRepoPath,
      worktreePath: input.worktreePath,
      prior: watermark,
      accept: input.accept,
      ...(openDuplex ? { openDuplex } : {}),
      ...(input.runGit ? { runGit: input.runGit } : {}),
      ...(input.fetchTimeoutMs !== undefined ? { fetchTimeoutMs: input.fetchTimeoutMs } : {}),
    };

    let bridge: StagingAdvanceBridgeResult;
    try {
      bridge = await handle(cfg, incoming);
    } catch (e) {
      // handleStagingAdvance is documented never-throw on runtime data (only a
      // gate-less config throws, which is a caller wiring bug we want loud —
      // let it propagate rather than silently swallow a misconfiguration).
      if (e instanceof TypeError && /device gate/.test(e.message)) throw e;
      errors.push(
        `handleStagingAdvance(epoch=${incoming.epoch},seq=${incoming.seq}) threw: ${
          e instanceof Error ? e.message : e
        }`,
      );
      continue;
    }

    results.push({ epoch: incoming.epoch, seq: incoming.seq, stagingSha: incoming.staging_sha, bridge });

    if (bridge.outcome === 'accepted') {
      watermark = bridge.watermark;
      acceptedCount += 1;
      continue;
    }
    if (bridge.outcome === 'fetch-failed') {
      // Continue past it (module header): record the fence it would still have
      // to clear, and let a later accepted announcement supersede it. The
      // cursor decision is `settle`'s, made against the batch's final
      // watermark. Its device is not re-dialed for the rest of this tick.
      fetchFailedDevices.add(incoming.device_pubkey);
      fetchFailed.push({ index, epochSeq: { epoch: incoming.epoch, seq: incoming.seq } });
      errors.push(
        `fetch failed for epoch=${incoming.epoch},seq=${incoming.seq}: ${bridge.detail} — continuing past it ` +
          `(a later accepted advance supersedes it; otherwise it re-collects next tick)`,
      );
      continue;
    }
    if (bridge.outcome === 'already-in-flight') {
      // WI-6418: a sibling git-sync routine (or ref-announce) already owns the
      // shared repo+device fetch. The announcement is not durably processed,
      // so hold the cursor at it; nothing failed, so add no error.
      return settle(index);
    }
    if (bridge.outcome === 'rejected' && RETRYABLE_REJECT_REASONS.has(bridge.reason)) {
      // P-505: transient-state rejection — the SAME envelope verifies once the
      // missing objects / granting token federate. Stop here so the caller's
      // cursor holds at this item (or at an earlier un-superseded fetch
      // failure, whichever comes first).
      errors.push(
        `retryable rejection (${bridge.reason}) for epoch=${incoming.epoch},seq=${incoming.seq} — ` +
          `holding the batch here, retrying next tick`,
      );
      return settle(index);
    }
    // 'rejected' with a TERMINAL reason (stale/malformed/forged/wrong-device/
    // non-ff): skip, never starve the rest of the batch — but COUNT it
    // (EI-19332963201820362). Skipping is still right; skipping SILENTLY is not.
    if (bridge.outcome === 'rejected') {
      terminalRejections[bridge.reason] = (terminalRejections[bridge.reason] ?? 0) + 1;
    }
  }

  return settle(null);
}
