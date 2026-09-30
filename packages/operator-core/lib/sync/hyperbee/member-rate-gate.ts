/**
 * member-rate-gate — enforce the owner-signed hive policy's `rate` caps for a
 * member's federated COORD MESSAGES (cross-machine-coord-parity-and-trust-
 * 2026-07-01 P-015; policy schema EN-2, previously unenforced).
 *
 * SCOPE — the attention surface ONLY: coord messages/handoffs/escalations at
 * the hive-bound projection. State-convergence rows (features, plans, presence,
 * membership…) are NEVER rate-dropped — discarding LWW sync ops makes honest
 * peers permanently diverge (the forceReFold bug class). A member flooding the
 * DATA plane is a moderation/ban problem, not a rate-limiter problem.
 *
 * Mechanics: sliding windows per (workspace, hive, author-device) at two
 * grains — `opsPerMin` and `rowsPerHour` from `hive_policy.rate` (absent knob =
 * uncapped, today's behavior). Process-local counters (each machine defends
 * its own attention; the federated-wake-rate posture) with a TTL-cached policy
 * read. Fail-open on policy-read errors — the allow-list stance is membership;
 * rate is telemetry-grade throttling.
 */

import type { HivePolicyRate } from '../../hive-policy-schema';

const POLICY_CACHE_TTL_MS = Number(process.env.PAPERCUSP_MEMBER_RATE_POLICY_CACHE_MS) || 30_000;
const MIN_MS = 60_000;
const HOUR_MS = 60 * 60 * 1000;

interface Windows {
  minute: number[];
  hour: number[];
  warnedAt: number;
}
const windows = new Map<string, Windows>(); // ws::hive::device

interface PolicyRateCache {
  at: number;
  rate: HivePolicyRate | null;
}
const policyCache = new Map<string, PolicyRateCache>(); // ws::hive

export interface MemberRateDeps {
  loadPolicyRate: (workspaceId: string, potHomeSlug: string) => Promise<HivePolicyRate | null>;
}
const defaultDeps: MemberRateDeps = {
  loadPolicyRate: async (workspaceId, potHomeSlug) => {
    const { getHivePolicy } = await import('../../hive-policy-store');
    const policy = await getHivePolicy(workspaceId, potHomeSlug);
    const rate = (policy?.policy as { rate?: HivePolicyRate } | null | undefined)?.rate;
    return rate && typeof rate === 'object' ? rate : null;
  },
};
let deps: MemberRateDeps = defaultDeps;

async function policyRateFor(
  workspaceId: string,
  potHomeSlug: string,
  now: number,
): Promise<HivePolicyRate | null> {
  const key = `${workspaceId}::${potHomeSlug}`;
  const hit = policyCache.get(key);
  if (hit && now - hit.at < POLICY_CACHE_TTL_MS) return hit.rate;
  let rate: HivePolicyRate | null = null;
  try {
    rate = await deps.loadPolicyRate(workspaceId, potHomeSlug);
  } catch {
    rate = null; // fail-open: membership is the allow-list; rate is throttling
  }
  policyCache.set(key, { at: now, rate });
  return rate;
}

/**
 * Spend one message-op from the member device's policy-rate budget. True =
 * within caps (op recorded); false = over a configured cap (the caller
 * quarantines with reason 'rate-exceeded'). No policy / no knobs = uncapped.
 */
export async function tryConsumeMemberMessageRate(input: {
  workspaceId: string;
  potHomeSlug: string;
  devicePubkey: string;
  nowMs?: number;
}): Promise<boolean> {
  const now = input.nowMs ?? Date.now();
  const rate = await policyRateFor(input.workspaceId, input.potHomeSlug, now);
  const opsPerMin = typeof rate?.opsPerMin === 'number' && rate.opsPerMin >= 0 ? rate.opsPerMin : null;
  const rowsPerHour =
    typeof rate?.rowsPerHour === 'number' && rate.rowsPerHour >= 0 ? rate.rowsPerHour : null;
  if (opsPerMin == null && rowsPerHour == null) return true; // uncapped

  const key = `${input.workspaceId}::${input.potHomeSlug}::${input.devicePubkey}`;
  let w = windows.get(key);
  if (!w) {
    w = { minute: [], hour: [], warnedAt: 0 };
    windows.set(key, w);
  }
  w.minute = w.minute.filter((t) => t > now - MIN_MS);
  w.hour = w.hour.filter((t) => t > now - HOUR_MS);
  if ((opsPerMin != null && w.minute.length >= opsPerMin) || (rowsPerHour != null && w.hour.length >= rowsPerHour)) {
    if (now - w.warnedAt > HOUR_MS) {
      w.warnedAt = now;
       
      console.warn(
        `[member-rate-gate] device ${input.devicePubkey.slice(0, 12)}… exceeded the hive policy message rate — further messages quarantined this window.`,
      );
    }
    return false;
  }
  w.minute.push(now);
  w.hour.push(now);
  return true;
}

/** Test seams. */
export function __setMemberRateDeps(d: Partial<MemberRateDeps>): void {
  deps = { ...deps, ...d };
}
export function __resetMemberRateGate(): void {
  deps = defaultDeps;
  windows.clear();
  policyCache.clear();
}
