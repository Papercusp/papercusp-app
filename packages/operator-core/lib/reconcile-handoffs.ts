/**
 * reconcile-handoffs — auto-expire coordination handoffs left pending past the TTL
 * (F-FIX-037 "coord invariant: handoffs stuck pending past 12h").
 *
 * A handoff (coord:handoff) is an offer of work from one agent to another. It is an
 * IMMUTABLE coord_event_log record (surface 'handoffs'); acceptance is a SIBLING
 * 'handoff_accepted' record, and `foldHandoffs` pairs them. When an agent opens a
 * handoff that no one ever accepts, it sits `open` forever: coord:handoffs and the
 * fleet views show it as live pending work, and a successor told "pick up the open
 * handoff" chases a stale offer. There is no mutable status column to flip — the data
 * model is append-only events (NOT a `coord_handoffs` table).
 *
 * So this sweep writes a sibling 'handoff_expired' record (the SAME immutable pattern
 * as acceptance — it NEVER mutates the original) for every still-open handoff older
 * than the TTL; the fold then drops it out of `status:'open'`. Idempotent: an expired
 * handoff is no longer `open`, so re-running skips it. Mirrors reconcile-escalations.
 */

import { listHandoffs, expireHandoff, repingHandoff } from './agent-tools/coordination/handoffs';
import { sendMessage } from './agent-tools/coordination/messages';
import { wakeRecipients } from './agent-tools/coordination/inbox-wake';
import type { AgentIdentity } from './agent-tools/coordination/identity';

/** Resolver identity stamped on auto-expired handoffs (audit trail). */
export const RECONCILE_HANDOFF_OWNER = 'system:handoff-reconcile';

/** Coord identity for the reconcile's own re-ping write/notify. A system action
 *  runs in-process, so it attributes as a `principal` (mirrors the
 *  coord-invariant-monitor's MONITOR_IDENTITY) — never a real fleet agent. */
const RECONCILE_IDENTITY: AgentIdentity = {
  ownerId: RECONCILE_HANDOFF_OWNER,
  ownerLabel: 'system · handoff-reconcile',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/**
 * TTL for a pending handoff before auto-expiry: 12h (F-FIX-037). Override via
 * PAPERCUSP_STALE_HANDOFF_TTL_MS. A handoff still unaccepted after 12h is, in
 * practice, abandoned — the intended recipient has moved on or never woke to it;
 * keeping it `open` only misleads successors.
 */
export const STALE_HANDOFF_TTL_MS = (() => {
  const env = Number(process.env.PAPERCUSP_STALE_HANDOFF_TTL_MS);
  return Number.isFinite(env) && env > 0 ? env : 12 * 60 * 60 * 1000;
})();

/**
 * Re-ping window for a still-open, un-acked handoff before nudging the OFFERER
 * once: 30min (coord-dispatch-reliability P-003). Override via
 * PAPERCUSP_HANDOFF_REPING_MS. A handoff opened-but-unaccepted after ~30m
 * (but < the 12h expire TTL) likely woke nobody (the recipient was idle and the
 * wake-on-open missed, or they declined to accept); re-pinging the offerer once
 * lets THEM follow up / reassign before the 12h backstop expires it. Threaded
 * through livenessCfg.handoffRepingMs consistently with handoffTtlMs.
 */
export const STALE_HANDOFF_REPING_MS = (() => {
  const env = Number(process.env.PAPERCUSP_HANDOFF_REPING_MS);
  return Number.isFinite(env) && env > 0 ? env : 30 * 60 * 1000;
})();

/** Max handoffs expired per sweep tick — a safety bound; the pending volume is small. */
export const RECONCILE_HANDOFF_BATCH_LIMIT = 500;

/** Max handoffs re-pinged per sweep tick — a safety bound on the offerer-nudge fan. */
export const RECONCILE_REPING_BATCH_LIMIT = 200;

export interface StalePendingHandoffInput {
  msg_id: string;
  /** ISO timestamp the handoff was opened. */
  ts: string;
}

export interface StalePendingHandoff {
  msg_id: string;
  ageHours: number;
}

/**
 * PURE: which OPEN handoffs are stale (opened older than `ttlMs`), oldest first so a
 * batch-limited sweep drains the longest-stale first. Input is the record side of
 * listHandoffs({status:'open'}) — already filtered to neither accepted nor expired,
 * so this only applies the age gate.
 */
export function selectStalePendingHandoffs(
  opens: readonly StalePendingHandoffInput[],
  ctx: { nowMs: number; ttlMs?: number },
): StalePendingHandoff[] {
  const ttl = ctx.ttlMs ?? STALE_HANDOFF_TTL_MS;
  const out: StalePendingHandoff[] = [];
  for (const h of opens) {
    const openedMs = Date.parse(h.ts);
    if (!Number.isFinite(openedMs)) continue;
    const ageMs = ctx.nowMs - openedMs;
    if (ageMs >= ttl) out.push({ msg_id: h.msg_id, ageHours: ageMs / 3_600_000 });
  }
  out.sort((a, b) => b.ageHours - a.ageHours);
  return out;
}

export interface ReconcileHandoffResult {
  scanned: number;
  stale: number;
  expired: number;
  /** True when the stale backlog exceeded the batch limit (more remain for next tick). */
  truncated: boolean;
}

/**
 * One reconciliation pass: load open handoffs, expire the stale ones (up to the batch
 * limit) by writing a sibling 'handoff_expired' record each. Idempotent — an
 * already-expired handoff drops out of `open`, so re-running is a no-op for it.
 */
export async function reconcileStalePendingHandoffsOnce(
  opts: { nowMs?: number; ttlMs?: number; limit?: number } = {},
): Promise<ReconcileHandoffResult> {
  const opens = await listHandoffs({ status: 'open' });
  const nowMs = opts.nowMs ?? Date.now();
  const inputs: StalePendingHandoffInput[] = opens.map((h) => ({ msg_id: h.record.msg_id, ts: h.record.ts }));
  const stale = selectStalePendingHandoffs(inputs, { nowMs, ttlMs: opts.ttlMs });
  const limit = opts.limit ?? RECONCILE_HANDOFF_BATCH_LIMIT;
  const batch = stale.slice(0, limit);

  let expired = 0;
  for (const s of batch) {
    const rec = await expireHandoff(s.msg_id, {
      by: RECONCILE_HANDOFF_OWNER,
      note: `auto-expired: handoff pending ${Math.round(s.ageHours)}h with no acceptance (F-FIX-037 coord invariant)`,
    });
    if (rec) expired += 1;
  }

  return { scanned: opens.length, stale: stale.length, expired, truncated: stale.length > batch.length };
}

// ── Re-ping backstop (coord-dispatch-reliability P-003) ────────────────────────
// Wake-on-open (the load-bearing fix) starts the accept→wake-offerer chain, but a
// recipient can still be idle at open time (the wake missed) or simply not accept.
// This pass nudges the OFFERER once, ~30m in (well before the 12h expire backstop),
// so they can follow up / reassign instead of silently waiting. ONE re-ping per
// handoff — guaranteed by the immutable `handoff_repinged` sibling: a re-pinged
// handoff carries `repinged_by` in the fold and is excluded here next tick.

export interface RepingableHandoffInput {
  msg_id: string;
  /** Offerer ownerId — `handoff.from`; the addressee of the re-ping. */
  from: string;
  plan_slug?: string;
  /** ISO timestamp the handoff was opened. */
  ts: string;
  /** Recipient ownerIds the handoff was offered to (for the re-ping prose). */
  to?: string[];
  /** True if a `handoff_repinged` sibling already exists (fold's repinged_by). */
  repinged: boolean;
}

export interface RepingableHandoff {
  msg_id: string;
  from: string;
  plan_slug?: string;
  to: string[];
  ageMinutes: number;
}

/**
 * PURE: which OPEN handoffs should re-ping the offerer — opened in the window
 * [repingMs, ttlMs): old enough to have plausibly missed the recipient, but not yet
 * past the expire TTL (those are handled by selectStalePendingHandoffs and shouldn't
 * also be re-pinged). Excludes already-re-pinged handoffs (one nudge per handoff).
 * Oldest first so a batch-limited sweep drains the longest-waiting first. Input is
 * the record side of listHandoffs({status:'open'}) — already neither accepted nor
 * expired — so this only applies the age-window + not-already-repinged gates.
 */
export function selectRepingableHandoffs(
  opens: readonly RepingableHandoffInput[],
  ctx: { nowMs: number; repingMs?: number; ttlMs?: number },
): RepingableHandoff[] {
  const repingMs = ctx.repingMs ?? STALE_HANDOFF_REPING_MS;
  const ttlMs = ctx.ttlMs ?? STALE_HANDOFF_TTL_MS;
  const out: RepingableHandoff[] = [];
  for (const h of opens) {
    if (h.repinged) continue; // one re-ping per handoff (idempotent via the sibling)
    const openedMs = Date.parse(h.ts);
    if (!Number.isFinite(openedMs)) continue;
    const ageMs = ctx.nowMs - openedMs;
    // [repingMs, ttlMs): re-ping window is inclusive at the bottom, exclusive at the
    // top — once a handoff crosses the expire TTL it belongs to the expire pass.
    if (ageMs >= repingMs && ageMs < ttlMs) {
      out.push({
        msg_id: h.msg_id,
        from: h.from,
        plan_slug: h.plan_slug,
        to: h.to ?? [],
        ageMinutes: ageMs / 60_000,
      });
    }
  }
  out.sort((a, b) => b.ageMinutes - a.ageMinutes);
  return out;
}

export interface ReconcileRepingResult {
  scanned: number;
  repingable: number;
  repinged: number;
  /** True when the repingable backlog exceeded the batch limit (more next tick). */
  truncated: boolean;
}

/**
 * One re-ping pass: load open handoffs, re-ping the offerer of each un-acked one in
 * the [repingMs, ttlMs) window (up to the batch limit) by writing an immutable
 * sibling 'handoff_repinged' record + a coord message to the offerer's inbox + a
 * fail-soft inbox-wake so an idle offerer is actually re-invoked. Idempotent — a
 * re-pinged handoff carries `repinged_by` and is excluded next tick (one nudge per
 * handoff). Fully fail-soft per handoff: a sibling/notify/wake hiccup on one handoff
 * never aborts the pass.
 */
export async function reconcileHandoffRepingsOnce(
  opts: { nowMs?: number; repingMs?: number; ttlMs?: number; limit?: number } = {},
): Promise<ReconcileRepingResult> {
  const opens = await listHandoffs({ status: 'open' });
  const nowMs = opts.nowMs ?? Date.now();
  const inputs: RepingableHandoffInput[] = opens.map((h) => ({
    msg_id: h.record.msg_id,
    from: h.record.from,
    plan_slug: h.record.plan_slug,
    ts: h.record.ts,
    to: h.record.to,
    repinged: !!h.repinged_by,
  }));
  const repingable = selectRepingableHandoffs(inputs, {
    nowMs,
    repingMs: opts.repingMs,
    ttlMs: opts.ttlMs,
  });
  const limit = opts.limit ?? RECONCILE_REPING_BATCH_LIMIT;
  const batch = repingable.slice(0, limit);

  let repinged = 0;
  for (const r of batch) {
    try {
      // 1) The idempotency marker FIRST — the sibling record guarantees one re-ping
      //    even if the notify/wake below partially fail (they're best-effort nudges).
      const rec = await repingHandoff(r.msg_id, {
        by: RECONCILE_HANDOFF_OWNER,
        note:
          `re-ping: your handoff ${r.msg_id}${r.to.length ? ` to ${r.to.join(', ')}` : ''}` +
          `${r.plan_slug ? ` (plan ${r.plan_slug})` : ''} is still un-acked after ~${Math.round(r.ageMinutes)}m`,
      });
      if (!rec) continue; // handoff vanished between list + reping — skip
      repinged += 1;

      // 2) A visible coord message to the offerer's inbox (the actionable nudge —
      //    surfaces in coord:inbox, unlike the bare sibling event). Best-effort.
      try {
        await sendMessage(RECONCILE_IDENTITY, {
          to: [r.from],
          summary: `handoff ${r.msg_id} still un-acked after ~${Math.round(r.ageMinutes)}m — follow up or reassign`,
          body:
            `Your handoff ${r.msg_id}${r.to.length ? ` to ${r.to.join(', ')}` : ''}` +
            `${r.plan_slug ? ` (plan ${r.plan_slug})` : ''} is still open and un-acked ` +
            `~${Math.round(r.ageMinutes)}m after you opened it — the recipient may have been idle when it landed. ` +
            'Follow up (coord:send wake:\'required\'), reassign, or let it lapse (the 12h backstop will auto-expire it).',
          plan_slug: r.plan_slug,
          related_msg_id: r.msg_id,
        });
      } catch (e) {
        console.warn(
          `[handoff-reping] notify offerer ${r.from} for ${r.msg_id} failed: ${e instanceof Error ? e.message : e}`,
        );
      }

      // 3) Wake the offerer so an idle one is re-invoked NOW (not just on their next
      //    natural turn). Fail-soft + single-target (wakeRecipients skips '*'/'human').
      try {
        await wakeRecipients([r.from], {
          summary: `handoff ${r.msg_id} still un-acked after ~${Math.round(r.ageMinutes)}m`,
          source: RECONCILE_HANDOFF_OWNER,
        });
      } catch (e) {
        console.warn(
          `[handoff-reping] wake offerer ${r.from} for ${r.msg_id} failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    } catch (e) {
      // A re-ping failure on one handoff never aborts the pass.
      console.warn(
        `[handoff-reping] reping for ${r.msg_id} failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  return {
    scanned: opens.length,
    repingable: repingable.length,
    repinged,
    truncated: repingable.length > batch.length,
  };
}
