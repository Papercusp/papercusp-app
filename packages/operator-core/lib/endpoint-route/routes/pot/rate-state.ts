/**
 * GET /api/pot/:id/policy/rate — live EN-2 per-member rate observability
 * (shared-hive-owner-enforcement-2026-06-19 EN-1 "Remaining for full release" /
 * findings-EN-4.md "EN-1 GUI snapshot surface — fast follow"; closes WI-253).
 *
 * Reads the CURRENT `MemberRateLimiter.snapshot()` for this hive's boot substrate via
 * the process-local `rate-limiter-registry` (populated by boot.ts) and the owner's
 * signed rate caps via {@link getHivePolicy}, so a row's `cap`/`throttled` reflects the
 * LIVE policy, not a stale one. Read-only — never mutates enforcement state.
 *
 * `booted: false` (with `rows: []`) means this hive's substrate is not currently booted
 * on THIS machine — process-local by design (each machine reports its own attention),
 * the same posture `member-rate-gate.ts` documents. That is expected/normal, not an
 * error: the GUI should render "no live data" rather than treat it as a failure.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../../workspace-registry';
import { getHivePolicy } from '../../../hive-policy-store';
import { getRateLimiter } from '../../../sync/hyperbee/rate-limiter-registry';
import type { RateStateRow } from '../../../sync/hyperbee/rate-limiter';

export interface RateStateResponse {
  ok: true;
  booted: boolean;
  rows: RateStateRow[];
}

/** The gate + read core, deps-injected so it's unit-testable without a real boot/PG. */
export async function runGetRateState(
  workspaceId: string,
  potHomeSlug: string,
  deps: {
    getRateLimiter: typeof getRateLimiter;
    getHivePolicy: typeof getHivePolicy;
  },
): Promise<RateStateResponse> {
  const limiter = deps.getRateLimiter(workspaceId, potHomeSlug);
  if (!limiter) {
    return { ok: true, booted: false, rows: [] };
  }
  let caps: import('../../../hive-policy-schema').HivePolicyRate | null = null;
  try {
    const resolved = await deps.getHivePolicy(workspaceId, potHomeSlug);
    caps = resolved?.policy.rate ?? null;
  } catch (e: unknown) {
    // No policy row / missing table ⇒ uncapped (today's permissive default) — the
    // limiter still reports counts, just with cap: null on every row.
    const msg = e instanceof Error ? e.message : String(e);
    if (!/does not exist|relation .* does not exist/i.test(msg)) throw e;
  }
  return { ok: true, booted: true, rows: limiter.snapshot(caps) };
}

const get = defineTool({
  method: 'GET',
  path: '/pot/:id/policy/rate',
  auth: 'public',
  async handler(_req, ctx) {
    const potHomeSlug = ctx.params.id as string;
    const workspaceId = activeWorkspaceId();
    const result = await runGetRateState(workspaceId, potHomeSlug, { getRateLimiter, getHivePolicy });
    return Response.json(result);
  },
});

export default [get];
