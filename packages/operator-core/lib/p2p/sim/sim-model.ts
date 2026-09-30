/**
 * P-306 — P2P work-distribution SIMULATION HARNESS (executable spec).
 *
 * A pure, deterministic, IO-free reference model of the pull-based P2P
 * work-distribution scheduler, plus the invariant predicates the real
 * host-gateway / claim / lease / metering code (P-202..P-205, P-304) must
 * satisfy. It exists so the LIVE-2 drill (P-305) can be gated on a green
 * simulation BEFORE any two-machine run: in-process green is necessary (not
 * sufficient) for live green.
 *
 * The model encodes the BINDING decisions from p2p-work-distribution-2026-07-02:
 *
 *  - D-007  host gateway is ALWAYS claim authority; two-layer gate =
 *           POLICY (remote allotment) × PHYSICS (live local headroom);
 *           leases-not-snapshots; safe oversubscription (caps not
 *           reservations); loud exhaustion.
 *  - D-008  two-axis allotments: REMOTE axis = budget-denominated (tokens/$),
 *           a spend CAP; LOCAL axis = contention-denominated (concurrent
 *           foreign slots), a hard PHYSICAL reservation. Host interactive
 *           ALWAYS preempts a foreign slot, loudly.
 *  - D-012  (C4) the PUBLISHER stamps the assignment on the offer at publish
 *           time over an epoch-versioned opt-in roster; receivers VERIFY the
 *           stamp (they never each recompute eligibility → no double-claim
 *           under eventual consistency). SOFT designation: an offer becomes
 *           STEALABLE after the steal timeout T2 so a slow-but-alive designee
 *           cannot stall work. Failover = claim-lease-TTL expiry reassignment.
 *  - X12    steal / reassignment target is WEIGHTED by host capacity weight.
 *  - X6     epoch fencing: a work-offer (spawn-class, per capabilities.ts) is
 *           only claimable while its stamped grant epoch is >= the grantor's
 *           monotonic high-water. A revocation BUMPS the high-water; a stale
 *           pre-revocation op replayed "fresh" after a partition heal carries
 *           an OLD epoch and MUST be refused (stale-backlog replay defense).
 *
 * The model is a REDUCER: `simulate(scenario)` plays a timed event schedule
 * against N virtual hosts and returns the full state + trace. Invariant
 * predicates read the result. No Date.now / Math.random — determinism is a
 * requirement (a flaky sim gate is worse than none), so all "randomness" is
 * the caller's seeded input and the assignment hash is content-addressed.
 */

/* ─────────────────────────────────────────────────────────────────────────
 * Content-addressed weighted rendezvous (HRW) — the publisher's stamp (D-012)
 * ───────────────────────────────────────────────────────────────────────── */

/** FNV-1a 32-bit accumulate — a small, fast, dependency-free content hash. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** murmur3 32-bit finalizer (avalanche) — FNV-1a's low bits are weak, so a
 *  proper mix is what makes the weighted-rendezvous assignment actually
 *  uniform (tight fairness bounds, not just monotone). */
function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Map a key to a uniform value in the OPEN interval (0, 1). */
export function hashUnit(key: string): number {
  // +1 / (2^32 + 1) keeps the result strictly inside (0,1): never 0 (so the
  // weighted exponent is finite) and never 1.
  return (mix32(fnv1a(key)) + 1) / 4294967297;
}

export interface WeightedHost {
  id: string;
  weight: number;
}

/**
 * Weighted rendezvous ("highest random weight") assignment — the PUBLISHER'S
 * deterministic stamp (D-012 C4). Given an offer id and the eligible roster,
 * returns the single designated host id, or null when the roster is empty.
 *
 * The score `hashUnit(offer|host) ** (1 / weight)` is the standard weighted-HRW
 * form: hashUnit ∈ (0,1), so a larger weight (smaller exponent) pushes the
 * score toward 1 → a proportionally larger share of keys. The result is a pure
 * function of (offerId, {id,weight} set) — INDEPENDENT of roster ORDER, which
 * is exactly the property that makes every replica agree on the designee
 * without a lock (no double-claim under eventual consistency).
 */
export function hrwAssign(offerId: string, eligible: readonly WeightedHost[]): string | null {
  let best: string | null = null;
  let bestScore = -Infinity;
  for (const h of eligible) {
    const w = h.weight > 0 ? h.weight : Number.EPSILON;
    const score = hashUnit(`${offerId}|${h.id}`) ** (1 / w);
    // Deterministic tie-break by id so equal scores never depend on input order.
    if (score > bestScore || (score === bestScore && (best === null || h.id < best))) {
      bestScore = score;
      best = h.id;
    }
  }
  return best;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Scenario shapes
 * ───────────────────────────────────────────────────────────────────────── */

export interface SimHost {
  id: string;
  /** X12 capacity weight (> 0); steal/assignment favor higher-weight hosts. */
  weight: number;
  /** D-008 REMOTE axis: committed-spend cap (tokens/$). */
  remoteBudget: number;
  /** D-008 LOCAL axis: max concurrent foreign slots (hard physical cap). */
  localSlots: number;
}

export interface SimOffer {
  id: string;
  /** Higher = claimed sooner. */
  priority: number;
  /** REMOTE-budget cost committed when the offer COMPLETES. */
  cost: number;
  /** Host ids on the epoch-versioned opt-in roster eligible for this offer. */
  eligible: string[];
  /** The grantor (numeric gh id) whose grant authorizes this work-offer. */
  grantorId: number;
  /** The grant epoch STAMPED on this offer's authorizing op (X6). */
  grantEpoch: number;
}

export type SimEvent =
  | { t: number; kind: 'publish'; offerId: string }
  | { t: number; kind: 'progress'; offerId: string }
  | { t: number; kind: 'complete'; offerId: string }
  | { t: number; kind: 'crash'; hostId: string }
  | { t: number; kind: 'heal'; hostId: string }
  | { t: number; kind: 'interactive'; hostId: string }
  | { t: number; kind: 'revoke'; grantorId: number }
  /** A stale pre-revocation op for `offerId` replayed after a heal, carrying
   *  its OLD (now-stale) grant epoch — the X6 stale-backlog replay attack. */
  | { t: number; kind: 'replayStale'; offerId: string; grantEpoch: number };

export interface SimScenario {
  hosts: SimHost[];
  offers: SimOffer[];
  events: SimEvent[];
  /** T2 — steps a designation may sit without progress before it is stealable. */
  stealTimeout: number;
  /** Claim-lease TTL — steps a claim may sit without completion before failover. */
  leaseTtl: number;
  /** Steps to run (0..maxSteps inclusive). */
  maxSteps: number;
  /** Initial grantor high-water epochs (default 0 for every grantor). */
  initialHighWater?: Record<number, number>;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Trace + result
 * ───────────────────────────────────────────────────────────────────────── */

export type OfferStatus =
  | 'pending' // published, awaiting a claim (fresh: designee only)
  | 'claimed' // held by a host under a lease
  | 'done' // completed, spend committed
  | 'reaped' // authorization revoked mid-flight (X6 revoke reaping)
  | 'exhausted'; // completion refused — would exceed the remote cap (loud)

export interface AdmissionRecord {
  step: number;
  offerId: string;
  hostId: string;
  /** Was this a steal (claimer ≠ the original publisher-stamped designee)? */
  stolen: boolean;
  grantEpoch: number;
  highWaterAtClaim: number;
  /** Host committed spend BEFORE this offer's cost (soft-gate view). */
  spentBefore: number;
  budget: number;
}

export interface SimEventLog {
  step: number;
  kind: string;
  detail: string;
}

export interface SimResult {
  scenario: SimScenario;
  offers: Map<string, OfferRuntime>;
  hosts: Map<string, HostRuntime>;
  highWater: Map<number, number>;
  admissions: AdmissionRecord[];
  /** Loud operational events (preemptions, exhaustion, reaps, failovers). */
  log: SimEventLog[];
  /** Per-step max-concurrency / max-spend snapshots, for invariant checks. */
  peakActiveByHost: Map<string, number>;
  peakSpentByHost: Map<string, number>;
}

export interface OfferRuntime {
  offer: SimOffer;
  status: OfferStatus;
  designee: string | null;
  designatedAt: number | null;
  claimedBy: string | null;
  claimedAt: number | null;
  lastProgressAt: number | null;
  published: boolean;
  /** Effective (possibly replayed-stale) grant epoch currently presented. */
  presentedEpoch: number;
  /** How many times this offer has been ADMITTED — the aging key that keeps
   *  the claim pass fair under lease churn (fewest-admits-first → no low-id
   *  monopoly, so no eligible offer starves). */
  admitCount: number;
}

export interface HostRuntime {
  host: SimHost;
  alive: boolean;
  spent: number;
  active: Set<string>;
}

/* ─────────────────────────────────────────────────────────────────────────
 * The reducer
 * ───────────────────────────────────────────────────────────────────────── */

function eligibleWeighted(offer: SimOffer, hosts: Map<string, HostRuntime>): WeightedHost[] {
  const out: WeightedHost[] = [];
  for (const id of offer.eligible) {
    const h = hosts.get(id);
    if (h) out.push({ id, weight: h.host.weight });
  }
  return out;
}

/** highWater for a grantor (default 0). */
function hw(highWater: Map<number, number>, grantorId: number): number {
  return highWater.get(grantorId) ?? 0;
}

/** X6 epoch fence: is `presentedEpoch` still authorized against the high-water? */
export function epochAuthorized(presentedEpoch: number, highWater: number): boolean {
  return presentedEpoch >= highWater;
}

export function simulate(scenario: SimScenario): SimResult {
  const hosts = new Map<string, HostRuntime>();
  for (const h of scenario.hosts) {
    hosts.set(h.id, { host: h, alive: true, spent: 0, active: new Set() });
  }
  const offers = new Map<string, OfferRuntime>();
  for (const o of scenario.offers) {
    offers.set(o.id, {
      offer: o,
      status: 'pending',
      designee: null,
      designatedAt: null,
      claimedBy: null,
      claimedAt: null,
      lastProgressAt: null,
      published: false,
      presentedEpoch: o.grantEpoch,
      admitCount: 0,
    });
  }
  const highWater = new Map<number, number>();
  for (const [k, v] of Object.entries(scenario.initialHighWater ?? {})) {
    highWater.set(Number(k), v);
  }

  const admissions: AdmissionRecord[] = [];
  const log: SimEventLog[] = [];
  const peakActiveByHost = new Map<string, number>();
  const peakSpentByHost = new Map<string, number>();

  // Bucket events by step for O(1) lookup.
  const eventsByStep = new Map<number, SimEvent[]>();
  for (const e of scenario.events) {
    const arr = eventsByStep.get(e.t);
    if (arr) arr.push(e);
    else eventsByStep.set(e.t, [e]);
  }

  const release = (or: OfferRuntime, reason: OfferStatus, note: string, step: number) => {
    const holder = or.claimedBy;
    if (holder) {
      const h = hosts.get(holder);
      h?.active.delete(or.offer.id);
    }
    or.claimedBy = null;
    or.claimedAt = null;
    or.status = reason;
    log.push({ step, kind: reason, detail: `${or.offer.id}: ${note}` });
  };

  const requeue = (or: OfferRuntime, note: string, step: number) => {
    const holder = or.claimedBy;
    if (holder) {
      const h = hosts.get(holder);
      h?.active.delete(or.offer.id);
    }
    or.claimedBy = null;
    or.claimedAt = null;
    or.status = 'pending';
    // A requeued offer is immediately stealable (its designation already lapsed).
    or.lastProgressAt = null;
    log.push({ step, kind: 'requeue', detail: `${or.offer.id}: ${note}` });
  };

  for (let now = 0; now <= scenario.maxSteps; now++) {
    // 1. Apply this step's events.
    for (const e of eventsByStep.get(now) ?? []) {
      switch (e.kind) {
        case 'publish': {
          const or = offers.get(e.offerId);
          if (or && !or.published) {
            or.published = true;
            or.status = 'pending';
            const winner = hrwAssign(e.offerId, eligibleWeighted(or.offer, hosts));
            or.designee = winner;
            or.designatedAt = now;
          }
          break;
        }
        case 'progress': {
          const or = offers.get(e.offerId);
          if (or && or.status === 'claimed') or.lastProgressAt = now;
          break;
        }
        case 'complete': {
          const or = offers.get(e.offerId);
          if (or && or.status === 'claimed' && or.claimedBy) {
            const h = hosts.get(or.claimedBy)!;
            // D-007 loud exhaustion: the CAP is enforced at commit (caps not
            // reservations). A completion that would exceed the remote budget
            // is refused rather than silently over-spending.
            if (h.spent + or.offer.cost <= h.host.remoteBudget) {
              h.spent += or.offer.cost;
              h.active.delete(or.offer.id);
              or.status = 'done';
              log.push({ step: now, kind: 'complete', detail: `${or.offer.id} on ${h.host.id} (+${or.offer.cost})` });
            } else {
              release(or, 'exhausted', `remote budget exhausted on ${h.host.id} (spent ${h.spent}+${or.offer.cost} > ${h.host.remoteBudget})`, now);
            }
          }
          break;
        }
        case 'crash': {
          const h = hosts.get(e.hostId);
          if (h) {
            h.alive = false;
            log.push({ step: now, kind: 'crash', detail: e.hostId });
          }
          break;
        }
        case 'heal': {
          const h = hosts.get(e.hostId);
          if (h) {
            h.alive = true;
            log.push({ step: now, kind: 'heal', detail: e.hostId });
          }
          break;
        }
        case 'interactive': {
          // D-008: host-local interactive work ALWAYS preempts a foreign slot,
          // loudly. Evict the lowest-priority active foreign claim and requeue
          // it (work is never lost — it is reassigned).
          const h = hosts.get(e.hostId);
          if (h && h.active.size > 0) {
            let victimId: string | null = null;
            let victimPri = Infinity;
            for (const oid of h.active) {
              const p = offers.get(oid)!.offer.priority;
              if (p < victimPri || (p === victimPri && (victimId === null || oid < victimId))) {
                victimPri = p;
                victimId = oid;
              }
            }
            if (victimId) {
              const vo = offers.get(victimId)!;
              log.push({ step: now, kind: 'preempt', detail: `${e.hostId} preempts ${victimId} (loud)` });
              requeue(vo, `preempted by host-interactive on ${e.hostId}`, now);
            }
          }
          break;
        }
        case 'revoke': {
          const next = hw(highWater, e.grantorId) + 1;
          highWater.set(e.grantorId, next);
          log.push({ step: now, kind: 'revoke', detail: `grantor ${e.grantorId} -> high-water ${next}` });
          // X6 revocation reaping: any in-flight offer whose presented epoch now
          // trails the high-water loses authorization immediately.
          for (const or of offers.values()) {
            if (
              (or.status === 'claimed' || or.status === 'pending') &&
              or.offer.grantorId === e.grantorId &&
              !epochAuthorized(or.presentedEpoch, next)
            ) {
              release(or, 'reaped', `grant epoch ${or.presentedEpoch} < high-water ${next} (X6)`, now);
            }
          }
          break;
        }
        case 'replayStale': {
          // A stale pre-revocation op arrives "fresh" after a heal. It tries to
          // re-present an OLD grant epoch for an offer. The model records the
          // stale epoch; the claim pass's epoch fence must refuse it.
          const or = offers.get(e.offerId);
          if (or && (or.status === 'reaped' || or.status === 'pending')) {
            or.presentedEpoch = e.grantEpoch;
            or.published = true;
            or.status = 'pending';
            or.designee = hrwAssign(e.offerId, eligibleWeighted(or.offer, hosts));
            or.designatedAt = now;
            log.push({ step: now, kind: 'replayStale', detail: `${e.offerId} replays stale epoch ${e.grantEpoch}` });
          }
          break;
        }
      }
    }

    // 2. Lease expiry / dead-holder failover (D-012 failover = TTL expiry).
    for (const or of offers.values()) {
      if (or.status === 'claimed' && or.claimedBy) {
        const holder = hosts.get(or.claimedBy)!;
        // Leases-not-snapshots (D-007): a claim that keeps making PROGRESS
        // renews its lease; only a silent (no-progress) claim expires.
        const anchor = Math.max(or.claimedAt ?? now, or.lastProgressAt ?? Number.NEGATIVE_INFINITY);
        const leaseAge = now - anchor;
        if (!holder.alive) {
          requeue(or, `holder ${holder.host.id} down — failover`, now);
        } else if (leaseAge >= scenario.leaseTtl) {
          requeue(or, `lease TTL expired on ${holder.host.id} — failover`, now);
        }
      }
    }

    // 3. Claim pass — highest priority first (D-007 host gateway = authority).
    const claimable = [...offers.values()]
      .filter((or) => or.published && or.status === 'pending')
      .sort(
        (a, b) =>
          // Priority dominates; within a priority, AGING (fewest prior
          // admissions first) keeps churned offers fair so none starves;
          // id is the final deterministic tie-break.
          b.offer.priority - a.offer.priority ||
          a.admitCount - b.admitCount ||
          (a.offer.id < b.offer.id ? -1 : 1),
      );

    for (const or of claimable) {
      const grantorHw = hw(highWater, or.offer.grantorId);
      // X6 epoch fence FIRST — an unauthorized offer is never claimed, and a
      // replayed-stale one is dropped (reaped) rather than looping forever.
      if (!epochAuthorized(or.presentedEpoch, grantorHw)) {
        if (or.presentedEpoch < or.offer.grantEpoch || or.status === 'pending') {
          release(or, 'reaped', `epoch ${or.presentedEpoch} < high-water ${grantorHw} — refused at claim (X6)`, now);
        }
        continue;
      }

      const designatedAt = or.designatedAt ?? now;
      const progressAnchor = Math.max(designatedAt, or.lastProgressAt ?? designatedAt);
      const stealable = now - progressAnchor >= scenario.stealTimeout;

      // Candidate set: fresh → only the live designee; stealable → all live,
      // capacity-having eligible hosts, X12-weighted pick (highest weight, HRW
      // tie-break) so a steal favors a strong host.
      let candidateId: string | null = null;
      if (!stealable) {
        const d = or.designee;
        if (d && hosts.get(d)?.alive) candidateId = d;
      } else {
        const pool = eligibleWeighted(or.offer, hosts).filter((wh) => {
          const h = hosts.get(wh.id)!;
          return h.alive && h.active.size < h.host.localSlots && h.spent < h.host.remoteBudget;
        });
        // X12: prefer the highest-weight candidate; HRW(offer,host) as the
        // deterministic tie-break so steals still spread over equal weights.
        pool.sort(
          (a, b) =>
            b.weight - a.weight ||
            hashUnit(`${or.offer.id}|${b.id}`) - hashUnit(`${or.offer.id}|${a.id}`) ||
            (a.id < b.id ? -1 : 1),
        );
        candidateId = pool[0]?.id ?? null;
      }
      if (!candidateId) continue;

      const h = hosts.get(candidateId)!;
      // Two-layer gate (D-007): PHYSICS (a free local slot — hard) × POLICY
      // (remote budget not already exhausted — soft, caps-not-reservations).
      if (!h.alive) continue;
      if (h.active.size >= h.host.localSlots) continue; // physical slot cap
      if (h.spent >= h.host.remoteBudget) continue; // remote budget exhausted (loud)

      // Admit.
      or.status = 'claimed';
      or.claimedBy = candidateId;
      or.claimedAt = now;
      or.lastProgressAt = now;
      or.admitCount += 1;
      h.active.add(or.offer.id);
      admissions.push({
        step: now,
        offerId: or.offer.id,
        hostId: candidateId,
        stolen: or.designee !== null && candidateId !== or.designee,
        grantEpoch: or.presentedEpoch,
        highWaterAtClaim: grantorHw,
        spentBefore: h.spent,
        budget: h.host.remoteBudget,
      });
    }

    // 4. Snapshot peaks for invariant checks.
    for (const h of hosts.values()) {
      peakActiveByHost.set(h.host.id, Math.max(peakActiveByHost.get(h.host.id) ?? 0, h.active.size));
      peakSpentByHost.set(h.host.id, Math.max(peakSpentByHost.get(h.host.id) ?? 0, h.spent));
    }
  }

  return { scenario, offers, hosts, highWater, admissions, log, peakActiveByHost, peakSpentByHost };
}

/* ─────────────────────────────────────────────────────────────────────────
 * Invariant predicates — the executable spec the real system must satisfy.
 * Each returns { ok, violations } so a failing property shrinks to a readable
 * witness rather than a bare boolean.
 * ───────────────────────────────────────────────────────────────────────── */

export interface InvariantResult {
  ok: boolean;
  violations: string[];
}

function ok(): InvariantResult {
  return { ok: true, violations: [] };
}
function fail(violations: string[]): InvariantResult {
  return { ok: violations.length === 0, violations };
}

/** No host ever COMMITS spend beyond its remote allotment (D-007 / D-008). */
export function invariantNoOverSpend(r: SimResult): InvariantResult {
  const v: string[] = [];
  for (const h of r.hosts.values()) {
    if (h.spent > h.host.remoteBudget) {
      v.push(`host ${h.host.id} committed ${h.spent} > budget ${h.host.remoteBudget}`);
    }
  }
  for (const [id, peak] of r.peakSpentByHost) {
    const h = r.hosts.get(id)!;
    if (peak > h.host.remoteBudget) v.push(`host ${id} peaked spend ${peak} > budget ${h.host.remoteBudget}`);
  }
  return fail(v);
}

/** Physical local slots are never oversubscribed at any step (D-008 physics). */
export function invariantNoSlotOversub(r: SimResult): InvariantResult {
  const v: string[] = [];
  for (const [id, peak] of r.peakActiveByHost) {
    const h = r.hosts.get(id)!;
    if (peak > h.host.localSlots) v.push(`host ${id} peaked ${peak} concurrent > slots ${h.host.localSlots}`);
  }
  return fail(v);
}

/**
 * No offer is EVER claimed/done under a grant epoch that trails the grantor's
 * high-water at the moment of claim (X6). Directly mirrors grant-store.ts's
 * checkP2pCapability spawn-class fence.
 */
export function invariantEpochFenced(r: SimResult): InvariantResult {
  const v: string[] = [];
  for (const a of r.admissions) {
    if (a.grantEpoch < a.highWaterAtClaim) {
      v.push(`claim of ${a.offerId} on ${a.hostId} at step ${a.step}: epoch ${a.grantEpoch} < high-water ${a.highWaterAtClaim}`);
    }
  }
  // And no offer is left in a live 'claimed'/'done' state below the final HW.
  for (const or of r.offers.values()) {
    if ((or.status === 'claimed' || or.status === 'done')) {
      const finalHw = r.highWater.get(or.offer.grantorId) ?? 0;
      // 'done' before a later revoke is legitimate; only flag a still-CLAIMED
      // offer that trails the current high-water (should have been reaped).
      if (or.status === 'claimed' && or.presentedEpoch < finalHw) {
        v.push(`offer ${or.offer.id} still CLAIMED with epoch ${or.presentedEpoch} < high-water ${finalHw} (missed reap)`);
      }
    }
  }
  return fail(v);
}

/**
 * At most one host is ever admitted for a given offer's ACTIVE lease at a time
 * (no double-claim). Across the whole run, concurrent claims on one offer are
 * impossible in the model; this checks the stamp-agreement property that makes
 * that true under eventual consistency: the publisher stamp is a single value
 * every replica computes identically (see invariantStampDeterministic).
 */
export function invariantNoConcurrentDoubleClaim(r: SimResult): InvariantResult {
  const v: string[] = [];
  // Group admissions by offer and verify no two admissions overlap without an
  // intervening release (requeue/complete/reap). We reconstruct from the log +
  // admissions by step ordering.
  const byOffer = new Map<string, AdmissionRecord[]>();
  for (const a of r.admissions) {
    const arr = byOffer.get(a.offerId);
    if (arr) arr.push(a);
    else byOffer.set(a.offerId, [a]);
  }
  for (const [offerId, arr] of byOffer) {
    arr.sort((a, b) => a.step - b.step);
    // Consecutive admissions must be separated by a release event in the log.
    for (let i = 1; i < arr.length; i++) {
      const prev = arr[i - 1]!;
      const cur = arr[i]!;
      const releasedBetween = r.log.some(
        (l) =>
          l.detail.startsWith(`${offerId}:`) &&
          (l.kind === 'requeue' || l.kind === 'reaped' || l.kind === 'complete' || l.kind === 'exhausted') &&
          l.step >= prev.step &&
          l.step <= cur.step,
      );
      if (!releasedBetween) {
        v.push(`offer ${offerId} re-admitted at step ${cur.step} (prev ${prev.step}) with no release between — double-claim`);
      }
    }
  }
  return fail(v);
}

/**
 * No WORK starvation — the SCHEDULER's guarantee. Completion is the worker's
 * job (a `complete` signal), so the thing the scheduler owns is ADMISSION: every
 * published offer that is still authorized at the final high-water AND has an
 * eligible host with real capacity (a slot AND enough remote budget for its
 * cost) must be ADMITTED at least once — never left forever pending because a
 * low-id peer monopolized the frontier under lease churn (the aging tie-break
 * guarantees this). An offer that reached a terminal `done` counts as served.
 *
 * Only meaningful under benign conditions (no crashes/revokes racing admission);
 * pass { requireTerminal:false } to skip it entirely in adversarial suites.
 */
export function invariantNoWorkStarvation(r: SimResult, opts?: { requireTerminal?: boolean }): InvariantResult {
  const v: string[] = [];
  if (opts?.requireTerminal === false) return ok();
  const admittedOffers = new Set(r.admissions.map((a) => a.offerId));
  for (const or of r.offers.values()) {
    if (!or.published) continue;
    const finalHw = r.highWater.get(or.offer.grantorId) ?? 0;
    if (!epochAuthorized(or.presentedEpoch, finalHw)) continue; // legitimately un-runnable
    const hasCapableHost = or.offer.eligible.some((id) => {
      const h = r.hosts.get(id);
      return h != null && h.host.localSlots > 0 && h.host.remoteBudget >= or.offer.cost;
    });
    if (!hasCapableHost) continue;
    if (!admittedOffers.has(or.offer.id) && or.status !== 'done') {
      v.push(`offer ${or.offer.id} never admitted despite eligible capacity — starvation`);
    }
  }
  return fail(v);
}

/**
 * Priority monotonicity: whenever two offers CONTEND (were both pending and
 * eligible for the same host in the same window), the higher-priority one is
 * admitted no later than the lower-priority one on that host. Checked as: for
 * each host, admissions are non-increasing in priority within the same step.
 */
export function invariantPriorityRespected(r: SimResult): InvariantResult {
  const v: string[] = [];
  const offerPri = (id: string) => r.offers.get(id)!.offer.priority;
  const byStepHost = new Map<string, AdmissionRecord[]>();
  for (const a of r.admissions) {
    const key = `${a.step}|${a.hostId}`;
    const arr = byStepHost.get(key);
    if (arr) arr.push(a);
    else byStepHost.set(key, [a]);
  }
  // Within one step, the claim pass processes offers high→low priority, so a
  // host that takes multiple in one step must take them in non-increasing order.
  for (const [, arr] of byStepHost) {
    for (let i = 1; i < arr.length; i++) {
      if (offerPri(arr[i]!.offerId) > offerPri(arr[i - 1]!.offerId)) {
        v.push(`host ${arr[i]!.hostId} at step ${arr[i]!.step} admitted lower-pri ${arr[i - 1]!.offerId} before higher-pri ${arr[i]!.offerId}`);
      }
    }
  }
  return fail(v);
}

/** Convenience: run every universal invariant and merge violations. */
export function checkAllInvariants(r: SimResult, opts?: { requireTerminal?: boolean }): InvariantResult {
  const parts = [
    invariantNoOverSpend(r),
    invariantNoSlotOversub(r),
    invariantEpochFenced(r),
    invariantNoConcurrentDoubleClaim(r),
    invariantPriorityRespected(r),
    invariantNoWorkStarvation(r, opts),
  ];
  return fail(parts.flatMap((p) => p.violations));
}
