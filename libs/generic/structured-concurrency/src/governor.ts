/**
 * governor — the layered backpressure governor.
 *
 * No single primitive bounds a runaway fleet, so the control loop composes four over one
 * store:
 *
 *   • TOKEN BUCKET — the spend ceiling. refill_per_sec caps long-run cost; capacity
 *     allows bursts. The SAME mechanism scoped per harness/user IS the BULKHEAD: a
 *     runaway in one scope drains only its own bucket, not the pool (scope 'global').
 *   • CIRCUIT BREAKER — stop pouring work into a repeatedly-failing dependency
 *     (closed → open → half_open).
 *   • CREDITS — per-stage admission: a slow downstream grants credits as it drains; the
 *     producer can't admit beyond them (bounded-buffer backpressure).
 *
 * admitSpawn is the ALL-OR-NOTHING gate: it consumes nothing unless every configured gate
 * passes. A scope with no row is unconstrained (opt-in). The decision math is pure
 * (refilledTokens); the store owns the atomic FOR-UPDATE transaction.
 */
import type { BucketRow, GovernorStore, GovernorTx } from './ports';

export const DEFAULT_CB_THRESHOLD = 3;
export const DEFAULT_CB_COOLDOWN_SEC = 60;

export type CircuitState = 'closed' | 'open' | 'half_open';

/** Tokens after time-based refill (capped at capacity). Pure. */
export function refilledTokens(row: BucketRow, nowMs: number): number {
  const lastMs = row.updatedAtMs ?? nowMs;
  const elapsedSec = Math.max(0, (nowMs - lastMs) / 1000);
  return Math.min(row.capacity, row.tokens + elapsedSec * row.refillPerSec);
}

export interface AdmitInput {
  workspaceId: string;
  /** Tokens this spawn would consume from the buckets. Default 1. */
  cost?: number;
  harness?: string;
  user?: string;
  /** Stage/role — gates on the role's credits + (default) the role circuit. */
  role?: string;
  /** Explicit circuit scope_key; defaults to harness:<slug>, else role:<role>. */
  circuitKey?: string;
  /** Injectable clock (ms) for deterministic refill/cooldown in tests. */
  now?: number;
}

export interface AdmitResult {
  admitted: boolean;
  reason: string | null;
  /** Gates evaluated (only configured scopes appear). */
  checked: string[];
  /** Token buckets debited on admit. */
  buckets: { scopeKey: string; tokensAfter: number }[];
}

export interface Governor {
  configureBucket(opts: { workspaceId: string; scopeKey: string; capacity: number; refillPerSec: number; tokens?: number; now?: number }): Promise<void>;
  configureCircuit(opts: { workspaceId: string; scopeKey: string; threshold?: number; cooldownSec?: number }): Promise<void>;
  configureCredits(opts: { workspaceId: string; scopeKey: string; credits: number; max?: number }): Promise<void>;
  grantCredits(opts: { workspaceId: string; scopeKey: string; n: number }): Promise<number>;
  recordCircuitSuccess(opts: { workspaceId: string; scopeKey: string }): Promise<void>;
  recordCircuitFailure(opts: { workspaceId: string; scopeKey: string; now?: number }): Promise<{ state: CircuitState; failures: number } | null>;
  admitSpawn(input: AdmitInput): Promise<AdmitResult>;
}

export function createGovernor(store: GovernorStore): Governor {
  async function configureBucket(opts: { workspaceId: string; scopeKey: string; capacity: number; refillPerSec: number; tokens?: number; now?: number }): Promise<void> {
    await store.configureBucket({
      workspaceId: opts.workspaceId,
      scopeKey: opts.scopeKey,
      capacity: opts.capacity,
      refillPerSec: opts.refillPerSec,
      tokens: opts.tokens,
      nowMs: opts.now,
    });
  }

  async function configureCircuit(opts: { workspaceId: string; scopeKey: string; threshold?: number; cooldownSec?: number }): Promise<void> {
    await store.configureCircuit({
      workspaceId: opts.workspaceId,
      scopeKey: opts.scopeKey,
      threshold: opts.threshold ?? DEFAULT_CB_THRESHOLD,
      cooldownSec: opts.cooldownSec ?? DEFAULT_CB_COOLDOWN_SEC,
    });
  }

  async function configureCredits(opts: { workspaceId: string; scopeKey: string; credits: number; max?: number }): Promise<void> {
    await store.configureCredits(opts);
  }

  async function grantCredits(opts: { workspaceId: string; scopeKey: string; n: number }): Promise<number> {
    return store.grantCredits(opts);
  }

  async function recordCircuitSuccess(opts: { workspaceId: string; scopeKey: string }): Promise<void> {
    await store.recordCircuitSuccess(opts);
  }

  async function recordCircuitFailure(opts: { workspaceId: string; scopeKey: string; now?: number }): Promise<{ state: CircuitState; failures: number } | null> {
    const nowMs = opts.now ?? Date.now();
    return store.transaction(async (tx) => {
      const r = await tx.lockCircuit(opts.workspaceId, opts.scopeKey);
      if (!r) return null;
      const failures = Number(r.failures) + 1;
      const threshold = Number(r.threshold ?? DEFAULT_CB_THRESHOLD);
      const trip = r.state === 'half_open' || failures >= threshold;
      const state: CircuitState = trip ? 'open' : 'closed';
      await tx.setCircuit(opts.workspaceId, opts.scopeKey, { state, failures, openedAtMs: trip ? nowMs : undefined });
      return { state, failures };
    });
  }

  async function admitSpawn(input: AdmitInput): Promise<AdmitResult> {
    const cost = input.cost ?? 1;
    const nowMs = input.now ?? Date.now();
    const bucketScopes = [
      'global',
      input.harness ? `harness:${input.harness}` : null,
      input.user ? `user:${input.user}` : null,
    ].filter((s): s is string => !!s);
    const circuitScope = input.circuitKey ?? (input.harness ? `harness:${input.harness}` : input.role ? `role:${input.role}` : null);
    const creditScope = input.role ? `role:${input.role}` : null;

    const deny = (reason: string, checked: string[]): AdmitResult => ({ admitted: false, reason, checked, buckets: [] });

    return store.transaction(async (tx: GovernorTx) => {
      const checked: string[] = [];

      // 1. Circuit breaker — open (and not cooled) ⇒ refuse; cooled ⇒ admit one probe (half_open).
      if (circuitScope) {
        const c = await tx.lockCircuit(input.workspaceId, circuitScope);
        if (c) {
          checked.push(`circuit:${circuitScope}`);
          if ((c.state ?? 'closed') === 'open') {
            const openedMs = c.openedAtMs ?? 0;
            const cooldownMs = Number(c.cooldownSec ?? DEFAULT_CB_COOLDOWN_SEC) * 1000;
            if (nowMs - openedMs > cooldownMs) {
              await tx.setCircuit(input.workspaceId, circuitScope, { state: 'half_open' });
            } else {
              return deny(`circuit_open:${circuitScope}`, checked);
            }
          }
        }
      }

      // 2. Token buckets (global + bulkheads) — every configured bucket must hold `cost`.
      const debits: { scope: string; after: number }[] = [];
      for (const scope of bucketScopes) {
        const b = await tx.lockBucket(input.workspaceId, scope);
        if (b) {
          checked.push(`bucket:${scope}`);
          const refill = refilledTokens(b, nowMs);
          if (refill < cost) return deny(`bucket_exhausted:${scope}`, checked);
          debits.push({ scope, after: refill - cost });
        }
      }

      // 3. Credits — the downstream stage must have one to spend.
      if (creditScope) {
        const cr = await tx.lockCredit(input.workspaceId, creditScope);
        if (cr) {
          checked.push(`credit:${creditScope}`);
          if (Number(cr.credits ?? 0) < 1) return deny(`no_credits:${creditScope}`, checked);
        }
      }

      // All gates passed → commit the debits + credit consume.
      const buckets: { scopeKey: string; tokensAfter: number }[] = [];
      for (const { scope, after } of debits) {
        await tx.setBucketTokens(input.workspaceId, scope, after, nowMs);
        buckets.push({ scopeKey: scope, tokensAfter: after });
      }
      if (creditScope) {
        await tx.consumeCredit(input.workspaceId, creditScope);
      }
      return { admitted: true, reason: null, checked, buckets };
    });
  }

  return {
    configureBucket,
    configureCircuit,
    configureCredits,
    grantCredits,
    recordCircuitSuccess,
    recordCircuitFailure,
    admitSpawn,
  };
}
