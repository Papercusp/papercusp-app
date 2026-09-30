/**
 * steering-lease — the per-Hive SINGLE-STEERER lease
 * (hive-network-surface-2026-06-11 P-011, design RATIFIED in D-004; built early
 * under D-004 revisit condition (a) — owner un-gated 2026-06-12 with the first
 * 2nd-Swarm metal runs underway).
 *
 * Concurrent multi-Queen steering is unarbitrated LWW on `feature_order` — safe
 * for execution (the claim layer is exactly-once) but open to ping-pong the day
 * two Swarms steer one backlog. Rather than CRDT priority merges (priorities are
 * an opinion, not mergeable content) or static backlog partitioning (kills the
 * pull model), steering converts to SINGLE-WRITER: the lease rides the EXISTING
 * per-Hive lock authority (`lockAuthorityForHive` — lowest-live-pubkey election,
 * heartbeat staleness, fail-open per partition, deterministic reconcile on
 * rejoin; the exact machinery that already arbitrates work-item claims). The
 * lease-holder IS that authority wearing a steering hat — no new election, no
 * new table, no behavior change at N=1 (a lone Swarm trivially holds it).
 *
 * The HOLDER commits cross-Swarm priority writes. NON-HOLDERS keep full local
 * placement authority (assignee ranks, claims — untouched) but their
 * `feature_order` steers become PROPOSALS (propose/dispose, like the bee rank
 * overlay): the write is NOT committed; a durable comment lands on the
 * work-item and an advisory escalation rides the federated coord plane so the
 * holding Queen disposes (re-applies or ignores).
 *
 * FAIL-OPEN posture (D-004): any resolution error — partition, missing tables
 * in a fixture, presence outage — yields `holder: true` and the steer commits.
 * LWW remains the backstop exactly as before the lease; the P-010 churn
 * tripwire (steering-churn.ts) is the telemetry that catches sustained thrash.
 */
import type { AuthorityResolution } from './authority/lock-authority';
import { lockAuthorityForHive } from './authority/lock-authority';
import { potHomeSlugForHarness } from './hive-federation';
import { evaluateMugTurnGate } from './shared-pot-loop/mug-guard';
import type { AgentIdentity } from './agent-tools/coordination/identity';

/** The lease verdict for one steering write. */
export interface SteeringLeaseVerdict {
  /** True ⇒ commit the steer (we hold the lease, or fail-open). */
  holder: boolean;
  reason: 'not-in-hive' | 'authority' | 'remote-holder' | 'fail-open' | 'queen-home' | 'not-queen-home';
  /** The hive whose authority arbitrated (absent for not-in-hive/fail-open). */
  potSlug?: string;
  /** Live Swarms considered by the election (when resolved). */
  liveCount?: number;
  /** Human-readable holder label, set when a REMOTE Swarm holds the lease. */
  holderLabel?: string;
}

/** Injectable resolution seams (tests; production uses the live defaults). */
export interface SteeringLeaseDeps {
  /** harness → its home Hive slug (null = not in a Hive). Default: potHomeSlugForHarness. */
  resolveHive?: (workspaceId: string, harnessSlug: string) => Promise<string | null>;
  /** The per-Hive lock authority. Default: lockAuthorityForHive. */
  hiveAuthority?: (potSlug: string) => Promise<AuthorityResolution>;
  /**
   * P-021: the Hive's recorded queen-home device pubkey (null when unset). Default:
   * getQueenHomePubkey. When SET it overrides the lock-authority election — the owner
   * deployed the Queen on a specific Swarm, so THAT Swarm steers (others propose),
   * regardless of which holds the lowest pubkey. Unset (every Hive today) ⇒ fall
   * through to the election (unchanged). The queen-guard's evaluateMugTurnGate
   * makes the home-vs-self decision.
   */
  resolveQueenHome?: (workspaceId: string, potSlug: string) => Promise<string | null>;
  /** This Swarm's device pubkey (null when gh-unauthenticated). Default: resolveUsageActor().devicePubkey. */
  resolveSelfPubkey?: () => Promise<string | null>;
  /** Proposal sinks (recordSteeringProposal). Defaults: work-item comment + coord escalation. */
  comment?: (input: { featureId: string; harness: string; body: string }) => Promise<void>;
  escalate?: (input: { summary: string; body: string }) => Promise<void>;
}

let testDeps: SteeringLeaseDeps | null = null;

/** TEST ONLY: override the resolution/sink seams (pass null to restore production). */
export function __setSteeringLeaseTestDeps(d: SteeringLeaseDeps | null): void {
  testDeps = d;
}

/** Synthetic identity for the lease's escalation + comment authorship. */
const STEERING_LEASE_IDENTITY: AgentIdentity = {
  ownerId: 'steering-lease',
  ownerLabel: 'system · steering-lease',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/**
 * Resolve whether THIS Swarm holds the steering lease for a harness's Hive.
 * Inert at N=1 (single Swarm ⇒ trivially the authority ⇒ holder) and for
 * non-Hive harnesses; FAIL-OPEN on every resolution error (D-004 — LWW is the
 * backstop, telemetry the tripwire). Never throws.
 */
export async function checkSteeringLease(
  workspaceId: string,
  harnessSlug: string,
  deps: SteeringLeaseDeps = {},
): Promise<SteeringLeaseVerdict> {
  const resolveHive = deps.resolveHive ?? testDeps?.resolveHive ?? potHomeSlugForHarness;
  // WI-6032 (P-005): scope the election to THIS workspace — `workspaceId` is the
  // caller's own param, a genuine caller-known value (see
  // LockAuthorityDeps.workspaceId), not an ambient/guessed one.
  const authority =
    deps.hiveAuthority ?? testDeps?.hiveAuthority ?? ((slug: string) => lockAuthorityForHive(slug, { workspaceId }));
  const resolveQueenHome =
    deps.resolveQueenHome ??
    testDeps?.resolveQueenHome ??
    (async (ws: string, slug: string) => {
      const { getQueenHomePubkey } = await import('./hive-settings-store');
      return getQueenHomePubkey(ws, slug);
    });
  const resolveSelfPubkey =
    deps.resolveSelfPubkey ??
    testDeps?.resolveSelfPubkey ??
    (async () => {
      const { resolveUsageActor } = await import('./harness/usage-actor');
      return (await resolveUsageActor())?.devicePubkey ?? null;
    });
  try {
    const potSlug = await resolveHive(workspaceId, harnessSlug);
    if (!potSlug) return { holder: true, reason: 'not-in-hive' };

    // P-021 (I2 / queen-guard D-008): an EXPLICITLY-RECORDED queen home overrides
    // the election. The owner deployed the Queen on a chosen Swarm; THAT Swarm
    // steers (others propose), regardless of incidental pubkey ordering. Only the
    // home-vs-self comparison decides here — when the home is unset (every Hive
    // today) the gate fails open and we fall through to the lock-authority election,
    // so behaviour is unchanged until a home is recorded. A node with no resolvable
    // self identity ALSO falls through (never strand a lone box on an unset self).
    const queenHome = await resolveQueenHome(workspaceId, potSlug);
    if (queenHome) {
      const self = await resolveSelfPubkey();
      if (self) {
        const gate = evaluateMugTurnGate({ selfPubkey: self, queenHomePubkey: queenHome });
        if (gate.ok && gate.reason === 'home-swarm') {
          return { holder: true, reason: 'queen-home', potSlug };
        }
        if (!gate.ok) {
          return {
            holder: false,
            reason: 'not-queen-home',
            potSlug,
            holderLabel: `${queenHome.slice(0, 12)}… (recorded queen home)`,
          };
        }
        // gate.ok with a non-home reason can't occur for a set home; fall through.
      }
      // self unresolved → fall through to the election (fail-open).
    }

    const res = await authority(potSlug);
    if (res.isSelf) {
      return { holder: true, reason: 'authority', potSlug, liveCount: res.liveCount };
    }
    return {
      holder: false,
      reason: 'remote-holder',
      potSlug,
      liveCount: res.liveCount,
      holderLabel: res.peer
        ? res.peer.machineLabel || `${res.peer.devicePubkey.slice(0, 12)}…`
        : 'an unidentified peer Swarm',
    };
  } catch {
    // Fail-open: a lease that cannot be resolved must never block a steer —
    // same posture as work-item claims (partition ⇒ both sides act; the
    // deterministic election reconciles on rejoin; LWW is the merge).
    return { holder: true, reason: 'fail-open' };
  }
}

/** One non-holder steer, recorded for the holding Queen to dispose. */
export interface SteeringProposalInput {
  workspaceId: string;
  harnessSlug: string;
  featureId: string;
  /** The feature_order the non-holder wanted (null = unprioritize). */
  requestedOrder: number | null;
  potSlug: string;
  holderLabel: string;
}

/**
 * Record a non-holder's steering PROPOSAL durably: a comment on the work-item
 * (in-context, federates with the item) + an advisory coord escalation (the
 * federated plane the holding Queen reviews — coord_event_log rides the Hive
 * substrate, mig 147). Both sinks are best-effort INDIVIDUALLY: one landing is
 * enough for the proposal to be visible; both failing loses only the proposal
 * record, never the caller (which has already withheld the write).
 */
export async function recordSteeringProposal(
  input: SteeringProposalInput,
  deps: SteeringLeaseDeps = {},
): Promise<void> {
  const want =
    input.requestedOrder === null ? 'clear its priority (unprioritize)' : `feature_order=${input.requestedOrder}`;
  const text =
    `Steering PROPOSAL (single-steerer lease, D-004 @ hive-network-surface-2026-06-11): ` +
    `this Swarm does not hold hive '${input.potSlug}'s steering lease (holder: ${input.holderLabel}) — ` +
    `the request to ${want} on ${input.featureId} was NOT committed. ` +
    `Holder Mug: dispose by re-applying via work_items:set_priority, or ignore.`;

  const comment =
    deps.comment ??
    testDeps?.comment ??
    (async (c: { featureId: string; harness: string; body: string }) => {
      const { commentWorkItem } = await import('./work-items');
      await commentWorkItem(c.featureId, c.body, STEERING_LEASE_IDENTITY.ownerId, {
        harness: c.harness,
      });
    });
  const escalate =
    deps.escalate ??
    testDeps?.escalate ??
    (async (e: { summary: string; body: string }) => {
      const { openEscalation } = await import('./agent-tools/coordination/escalations');
      await openEscalation(STEERING_LEASE_IDENTITY, {
        severity: 'advisory',
        summary: e.summary,
        body: e.body,
      });
    });

  await Promise.allSettled([
    comment({ featureId: input.featureId, harness: input.harnessSlug, body: text }),
    escalate({
      summary: `Steering proposal: ${input.harnessSlug}/${input.featureId} → ${want} (non-holder Swarm; holder ${input.holderLabel})`,
      body: text,
    }),
  ]);
}
