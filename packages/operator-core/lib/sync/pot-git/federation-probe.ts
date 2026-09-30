/**
 * federation-probe — self-verifying probe receipts (RC-1 style shape + pure
 * logic; fleet-reliability-verification-2026-07-10 P-010, WI-3812).
 *
 * Root lesson (2026-07-10 cause #10, `shared-pot-federation-diagnosis-toolkit`):
 * every prior ad-hoc "v2t" liveness probe (a hand-written marker value, e.g.
 * the `p059:v2t:wakeN-<agent>` convention) was UNSTAMPED — nothing forced it to
 * carry the keys required to prove it actually rode the real federation
 * pipeline, so "green" was unreachable by construction for ~6h and nothing said
 * so. This module makes a probe correct-by-construction: {@link stampProbe}
 * REFUSES loudly (a typed reason, never a silent no-op) unless the required
 * federation keys are present and the target harness is actually federated.
 *
 * THE SHAPE + PURE LOGIC ONLY — mirrors `results-receipt.ts`'s split
 * deliberately: persistence lives in `federation-probe-store.ts`, the agent
 * tools in `agent-tools/probe/*`. Keeping this module pure (no PG, no
 * ambient Date.now) means the stamping + refusal + verdict logic is fully
 * unit-testable without a database.
 *
 * A successful probe records exactly one fact: the stamped declaration was
 * captured locally. It does NOT claim that the declaration drained, crossed a
 * peer connection, merged remotely, passed a member guard, or projected into
 * a receiver. Those events are observed in different processes and stores;
 * pretending this emitter-local row could name them produced a permanently
 * red health signal (WI-3962). Real federation health comes from the outbox,
 * merge cursor, and fresh remote-origin rows instead.
 */

export const PROBE_HOPS = ['captured'] as const;

export type ProbeHop = (typeof PROBE_HOPS)[number];

/** Why `probe:emit` refused to stamp a probe — never a silent no-op (P-010). */
export type ProbeRefusalReason =
  | 'missing_workspace'
  | 'missing_harness_slug'
  | 'invalid_harness_slug'
  | 'harness_not_federated'
  | 'missing_emitted_by';

export const PROBE_REFUSAL_DETAIL: Readonly<Record<ProbeRefusalReason, string>> = {
  missing_workspace:
    'no resolvable workspaceId — a probe cannot be stamped without knowing which workspace it belongs to',
  missing_harness_slug: 'harnessSlug is required — an unstamped probe is exactly the cause-#10 defect',
  invalid_harness_slug: "harnessSlug must not be '*' or empty — that is a scope selector, not a concrete harness",
  harness_not_federated:
    'this harness has no federation/registry entry (isRegisteredHive=false) — a probe emitted against it can never leave this box, so it would silently prove nothing',
  missing_emitted_by: 'no resolvable agent identity (emittedBy) to attribute the probe to',
};

export interface ProbeStampInput {
  workspaceId: string | null | undefined;
  harnessSlug: string | null | undefined;
  emittedBy: string | null | undefined;
  /** Resolved by the caller (async registry check) — kept out of this pure module. */
  harnessIsFederated: boolean;
  nowMs: number;
  /** Injected randomness seam for deterministic tests. Default Math.random. */
  random?: () => number;
}

/** The stamped, federation-key-complete probe declaration `probe:emit` persists. */
export interface StampedProbe {
  workspaceId: string;
  harnessSlug: string;
  probeKey: string;
  emittedBy: string;
  emittedAtMs: number;
}

export type StampProbeResult =
  | { ok: true; stamped: StampedProbe }
  | { ok: false; reason: ProbeRefusalReason; detail: string };

/**
 * Build a direction-unique, stamped probe key. Generalizes the ad-hoc
 * `p059:v2t:wakeN-<agent>` convention (the runbook's own recommendation:
 * "use direction-unique probe keys per attempt, never reuse a name in both
 * directions") into a collision-resistant default so a caller never has to
 * hand-craft one.
 */
export function buildProbeKey(
  harnessSlug: string,
  emittedBy: string,
  nowMs: number,
  random: () => number = Math.random,
): string {
  const nonce = Math.floor(random() * 36 ** 8)
    .toString(36)
    .padStart(8, '0');
  return `${harnessSlug}:v2t:${nowMs.toString(36)}-${emittedBy}-${nonce}`;
}

/**
 * Validate + stamp a probe. Pure — the caller resolves `harnessIsFederated`
 * (an async registry lookup) before calling this. Refuses loudly (typed
 * reason) rather than ever producing an unfederatable probe (cause #10).
 */
export function stampProbe(input: ProbeStampInput): StampProbeResult {
  const workspaceId = input.workspaceId?.trim();
  if (!workspaceId || workspaceId === '*') {
    return { ok: false, reason: 'missing_workspace', detail: PROBE_REFUSAL_DETAIL.missing_workspace };
  }
  const harnessSlug = input.harnessSlug?.trim();
  if (!harnessSlug) {
    return { ok: false, reason: 'missing_harness_slug', detail: PROBE_REFUSAL_DETAIL.missing_harness_slug };
  }
  if (harnessSlug === '*') {
    return { ok: false, reason: 'invalid_harness_slug', detail: PROBE_REFUSAL_DETAIL.invalid_harness_slug };
  }
  const emittedBy = input.emittedBy?.trim();
  if (!emittedBy) {
    return { ok: false, reason: 'missing_emitted_by', detail: PROBE_REFUSAL_DETAIL.missing_emitted_by };
  }
  if (!input.harnessIsFederated) {
    return { ok: false, reason: 'harness_not_federated', detail: PROBE_REFUSAL_DETAIL.harness_not_federated };
  }
  const probeKey = buildProbeKey(harnessSlug, emittedBy, input.nowMs, input.random);
  return {
    ok: true,
    stamped: { workspaceId, harnessSlug, probeKey, emittedBy, emittedAtMs: input.nowMs },
  };
}

/** Read-time view of one probe's hop receipts (mirrors the PG row shape). */
export interface ProbeReceipt {
  probeKey: string;
  workspaceId: string;
  harnessSlug: string;
  emittedBy: string;
  emittedAtMs: number;
  status: 'acked' | 'refused';
  refusalReason?: ProbeRefusalReason | string;
  /** `captured` -> epoch-ms for an accepted probe; absent for a refusal. */
  hops: Partial<Record<ProbeHop, number>>;
}
