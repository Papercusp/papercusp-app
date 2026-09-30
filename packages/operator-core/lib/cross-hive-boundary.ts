/**
 * cross-hive-boundary — the mediated Hive→Hive boundary (hive-coordination-model
 * D-004/D-005). A Hive-A agent addresses **Hive B** (never a B agent); the envelope
 * lands at B's boundary, which ADMITS it per B's owner-set capability grants and
 * TRANSLATES it into a B-side object routed by B's ORDINARY substrate — an `ask`
 * becomes a conversation; a `work-request` becomes a work_item in B's backlog. There is
 * NO special cross-Hive router: once admitted+translated it is just normal B work, and
 * the Queen steers its priority. The mediation IS the sovereignty boundary — A cannot
 * commandeer B's agents, read B's coordination, or jump B's priorities.
 *
 * THIS module is the boundary LOGIC (admission + translation), composing B's existing
 * surfaces (conversations / work_items). The TRANSPORT that DELIVERS an envelope from A
 * to B (dial Hive B by pubkey over hyperdht) is the federation layer
 * ([[shared-hive-federation-2026-06-08]]); it hands a received envelope to
 * `routeCrossHiveEnvelope`. Grant PERSISTENCE + the live cross-machine/cross-Hive E2E
 * are tracked in [[cross-hive-boundary-2026-06-08]]. Pure admission ⇒ unit-testable
 * without PG; routing is decoupled via ports.
 */
import { createWorkItem } from './work-items';
import { openConversation } from './agent-tools/coordination/conversations';
import type { AgentIdentity } from './agent-tools/coordination/identity';

/** The kinds a cross-Hive envelope may carry (D-004's MVP: ask / work-request). */
export type CrossHiveKind = 'ask' | 'work-request';

/** A directed Hive→Hive message — the boundary's unit. Addressed by Hive pubkey. */
export interface CrossHiveEnvelope {
  /** Sending Hive's pubkey (from the discovery directory). */
  fromHivePubkey: string;
  /** Receiving Hive's pubkey — an envelope not addressed to THIS Hive is rejected. */
  toHivePubkey: string;
  kind: CrossHiveKind;
  subject: string;
  body: string;
  /**
   * Ed25519 signature by the sending Hive's key. The boundary checks PRESENCE; full
   * cryptographic verification against the sender's directory pubkey is the transport
   * layer's responsibility before it hands the envelope here.
   */
  sig: string;
}

/**
 * An owner-set capability grant: which peer-Hive may send which kinds INTO this Hive.
 * Trust is per-peer-Hive + revocable (the Hive-granularity analog of contributor
 * admission). The absence of a grant is a hard reject — admission is allow-list, not
 * deny-list.
 *
 * P-013 (D-005 hardening): every grant additionally carries QUOTAS — a rolling
 * per-hour request cap, a payload size cap, and an optional expiry. Absent fields
 * fall back to the module defaults below, so even a bare grant is never unbounded.
 */
export interface CrossHiveGrant {
  peerHivePubkey: string;
  allowedKinds: readonly CrossHiveKind[];
  /** Max requests per rolling hour with this peer (default {@link DEFAULT_CROSS_HIVE_MAX_PER_HOUR}). */
  maxPerHour?: number;
  /** Max `body` size in BYTES per request (default {@link DEFAULT_CROSS_HIVE_MAX_BODY_BYTES}). */
  maxBodyBytes?: number;
  /** Epoch-ms after which the grant is void (absent = no expiry). */
  expiresAt?: number;
}

/**
 * P-013 quota defaults — applied when a grant does not set its own. Deliberately
 * always-on (D-005: "a granted peer can flood … unbounded" was the recorded gap):
 * a grant with no explicit quota is capped, not open.
 */
export const DEFAULT_CROSS_HIVE_MAX_PER_HOUR = 60;
export const DEFAULT_CROSS_HIVE_MAX_BODY_BYTES = 64 * 1024;

/** UTF-8 byte length of a request body (the quota unit — chars lie about size). */
export function crossHiveBodyBytes(body: string): number {
  return Buffer.byteLength(body, 'utf8');
}

/**
 * The P-013 quota verdict shared by both directions. Pure: callers supply the
 * clock + the rolling-window usage count (the wiring counts the C-1 ledger).
 * An absent `recentCount` skips the rate check (the caller could not count —
 * fail-open on telemetry, never on the allow-list itself).
 */
function checkGrantQuota(
  grant: CrossHiveGrant,
  opts: { bodyBytes?: number; nowMs?: number; recentCount?: number },
  peerLabel: string,
): CrossHiveAdmission | null {
  const now = opts.nowMs ?? Date.now();
  if (grant.expiresAt != null && now > grant.expiresAt) {
    return {
      admitted: false,
      reason: `grant for Hive ${peerLabel} expired at ${new Date(grant.expiresAt).toISOString()}`,
    };
  }
  const maxBody = grant.maxBodyBytes ?? DEFAULT_CROSS_HIVE_MAX_BODY_BYTES;
  if (opts.bodyBytes != null && opts.bodyBytes > maxBody) {
    return {
      admitted: false,
      reason: `payload ${opts.bodyBytes}B exceeds the ${maxBody}B cap for Hive ${peerLabel}`,
    };
  }
  const maxPerHour = grant.maxPerHour ?? DEFAULT_CROSS_HIVE_MAX_PER_HOUR;
  if (opts.recentCount != null && opts.recentCount >= maxPerHour) {
    return {
      admitted: false,
      reason: `rate cap reached for Hive ${peerLabel} — ${opts.recentCount} requests in the last hour (cap ${maxPerHour})`,
    };
  }
  return null;
}

export interface CrossHiveAdmission {
  admitted: boolean;
  reason: string;
}

export interface AdmitOpts {
  /** THIS Hive's pubkey. */
  selfHivePubkey: string;
  /** The owner-set capability grants for inbound peer-Hives. */
  grants: readonly CrossHiveGrant[];
  /** Clock for grant-expiry checks (P-013; default Date.now). */
  nowMs?: number;
  /**
   * Requests admitted FROM `env.fromHivePubkey` within the rolling hour (P-013 rate
   * cap; the wiring counts the C-1 `in` ledger). Absent = the rate check is skipped
   * (the caller could not count — never silently zero).
   */
  recentFromPeerCount?: number;
}

/**
 * Decide whether an inbound cross-Hive envelope is admitted. Pure. Rejects when: not
 * addressed to this Hive, unsigned, no grant for the sending Hive, the grant does
 * not cover the envelope's kind, or a P-013 quota trips (grant expired / payload
 * over the size cap / peer over the rolling per-hour rate cap).
 */
export function admitCrossHiveEnvelope(env: CrossHiveEnvelope, opts: AdmitOpts): CrossHiveAdmission {
  if (env.toHivePubkey !== opts.selfHivePubkey) {
    return { admitted: false, reason: 'envelope not addressed to this Hive' };
  }
  if (!env.sig || env.sig.length === 0) {
    return { admitted: false, reason: 'unsigned envelope' };
  }
  const grant = opts.grants.find((g) => g.peerHivePubkey === env.fromHivePubkey);
  if (!grant) {
    return { admitted: false, reason: `no capability grant for Hive ${env.fromHivePubkey}` };
  }
  if (!grant.allowedKinds.includes(env.kind)) {
    return { admitted: false, reason: `Hive ${env.fromHivePubkey} is not granted '${env.kind}'` };
  }
  const quota = checkGrantQuota(
    grant,
    {
      bodyBytes: crossHiveBodyBytes(env.body),
      ...(opts.nowMs != null ? { nowMs: opts.nowMs } : {}),
      ...(opts.recentFromPeerCount != null ? { recentCount: opts.recentFromPeerCount } : {}),
    },
    env.fromHivePubkey,
  );
  if (quota) return quota;
  return { admitted: true, reason: 'admitted by capability grant' };
}

/** A pending OUTBOUND request — which peer Hive we want to send which kind to. */
export interface OutboundCrossHiveRequest {
  /** The peer Hive we are sending to (its directory pubkey). */
  toHivePubkey: string;
  kind: CrossHiveKind;
  /** The request body's UTF-8 byte size (P-013 size cap; absent = size check skipped). */
  bodyBytes?: number;
}

export interface OutboundAdmitOpts {
  /** This Hive's owner-set OUTBOUND grants — which peer-Hives we may send which kinds TO. */
  grants: readonly CrossHiveGrant[];
  /** Clock for grant-expiry checks (P-013; default Date.now). */
  nowMs?: number;
  /**
   * Requests already sent TO `req.toHivePubkey` within the rolling hour (P-013 rate
   * cap; the send path counts the C-1 `out` ledger). Absent = rate check skipped.
   */
  recentToPeerCount?: number;
}

/**
 * Decide whether an OUTBOUND cross-Hive request is permitted to leave this Hive. The
 * egress twin of {@link admitCrossHiveEnvelope}: default-deny, allow-list. Rejects when
 * there is no outbound grant for the destination Hive, the grant does not cover the
 * request's kind, or a P-013 quota trips (expiry / size cap / per-hour rate cap).
 * Pure — the send path loads `grants` via `loadOutboundCrossHiveGrants`.
 */
export function admitOutboundCrossHive(
  req: OutboundCrossHiveRequest,
  opts: OutboundAdmitOpts,
): CrossHiveAdmission {
  const grant = opts.grants.find((g) => g.peerHivePubkey === req.toHivePubkey);
  if (!grant) {
    return {
      admitted: false,
      reason: `no outbound grant for Hive ${req.toHivePubkey} — the owner must grant it first`,
    };
  }
  if (!grant.allowedKinds.includes(req.kind)) {
    return { admitted: false, reason: `Hive ${req.toHivePubkey} is not granted outbound '${req.kind}'` };
  }
  const quota = checkGrantQuota(
    grant,
    {
      ...(req.bodyBytes != null ? { bodyBytes: req.bodyBytes } : {}),
      ...(opts.nowMs != null ? { nowMs: opts.nowMs } : {}),
      ...(opts.recentToPeerCount != null ? { recentCount: opts.recentToPeerCount } : {}),
    },
    req.toHivePubkey,
  );
  if (quota) return quota;
  return { admitted: true, reason: 'admitted by outbound capability grant' };
}

/**
 * Ports that translate an ADMITTED envelope into a B-side object via B's ORDINARY
 * substrate. Injected so the boundary logic is testable without PG and so the
 * translation reuses (never forks) B's normal conversation/work-item surfaces.
 */
export interface CrossHiveBoundaryPorts {
  /** ask → a B-side conversation. Returns the created object's ref. */
  openAsk(env: CrossHiveEnvelope): Promise<{ ref: string }>;
  /** work-request → a B-side work_item in B's backlog. Returns the created object's ref. */
  createWorkRequest(env: CrossHiveEnvelope): Promise<{ ref: string }>;
}

export interface CrossHiveRouteResult {
  admitted: boolean;
  reason: string;
  /** What B-side object the admitted envelope became (when admitted). */
  action?: 'conversation' | 'work_item';
  ref?: string;
}

/**
 * Admit an inbound cross-Hive envelope and, if admitted, translate it into a B-side
 * object via B's ordinary substrate (the ports). A rejected envelope touches no port.
 */
export async function routeCrossHiveEnvelope(
  env: CrossHiveEnvelope,
  opts: AdmitOpts,
  ports: CrossHiveBoundaryPorts,
): Promise<CrossHiveRouteResult> {
  const adm = admitCrossHiveEnvelope(env, opts);
  if (!adm.admitted) return { admitted: false, reason: adm.reason };
  if (env.kind === 'ask') {
    const { ref } = await ports.openAsk(env);
    return { admitted: true, reason: adm.reason, action: 'conversation', ref };
  }
  const { ref } = await ports.createWorkRequest(env);
  return { admitted: true, reason: adm.reason, action: 'work_item', ref };
}

/** A short, human-readable tag for the sending Hive (envelopes carry full pubkeys). */
function peerTag(pubkey: string): string {
  return pubkey.slice(0, 8);
}

/**
 * Live ports: translate via B's REAL substrate. An `ask` opens a conversation (B's
 * agents route it via topics/subscriptions); a `work-request` mints a `change`
 * work_item in B's backlog (B's Queen triages/prioritizes it like any other work).
 */
export function makeLiveBoundaryPorts(opts: { identity: AgentIdentity; harness?: string }): CrossHiveBoundaryPorts {
  return {
    async openAsk(env) {
      const res = await openConversation(opts.identity, {
        kind: 'question',
        producer: 'cross-hive-boundary',
        title: `[cross-Hive ask · ${peerTag(env.fromHivePubkey)}] ${env.subject}`,
        body: env.body,
        ...(opts.harness ? { harness_slug: opts.harness } : {}),
      });
      return { ref: res.conversation.id };
    },
    async createWorkRequest(env) {
      const wi = await createWorkItem({
        // Born-pending (work-queue-admission-and-bulk-dedup-2026-08-24 P-002): this is
        // an inbound request from a PEER HIVE — the one filing path where the author is
        // outside this install entirely. Nothing local has reviewed it, so it lands
        // pending and the promoter judges it against our own corpus before it can be
        // claimed. (Distinct from the G2 remote-trust `audit_verdict` gate, which asks
        // whether the AUTHOR is trusted; this asks whether the WORK is a duplicate.)
        admission: 'pending',
        kind: 'change',
        title: `[cross-Hive request · ${peerTag(env.fromHivePubkey)}] ${env.subject}`,
        summary: env.body,
        ...(opts.harness ? { harness: opts.harness } : {}),
        createdBy: `hive:${peerTag(env.fromHivePubkey)}`,
      });
      return { ref: wi.id };
    },
  };
}
