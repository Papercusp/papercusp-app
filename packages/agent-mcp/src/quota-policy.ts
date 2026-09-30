/**
 * Papercusp's quota windowing policy — the host half of plan P-011 / D-006.
 *
 * `@papercusp/tooldef` is policy-agnostic about quotas: its dispatcher resolves
 * each call's window (telemetry grouping + quota scope) and ceiling through the
 * injected `computeQuotaWindow` function, defaulting to run-scoped/`perRun` when
 * none is supplied. This file is the Papercusp override, wired into
 * `PROJECTED_DEPS` (`apps/operator/lib/projected-tool-deps.ts`). It used to live
 * baked inside the core (`dispatch-types.ts#computeProjectedQuotaWindowKey` +
 * the `role === 'worker' ? perChunk : perRun` branch in the quota step); P-011
 * moved it out so the engine carries no role/chunk/run specifics.
 *
 * The policy, by role:
 *   - **worker** — chunk-windowed (`chunk:<chunkId>`), capped by `perChunk`. A
 *     worker turn is the smallest unit of work; quotas reset per chunk. No
 *     chunk → no window (uncounted).
 *   - **power-user session** — a power-user (`?power_user=1`) MCP call gets a
 *     fresh `runId` per request, so a run-keyed window would never accumulate.
 *     Key on the stable auth session (`uiClientId` carries the auth_session_id)
 *     so the workspace's operator-tier quota actually applies across the
 *     session. `perRun` cap. See omp-power-user-bundle-2026-05-20.md §4.1.
 *   - **named quota subject** — the same problem for in-process callers that
 *     mint a fresh `runId` per dispatch but act for one party (identity work run
 *     as its wearer: `subject:wearer:<ownerId>`). Key on `ctx.quotaSubject`.
 *     `perRun` cap. See portable-identity-packages-2026-09-26 D-032.
 *   - **everyone else** — run-windowed (`run:<runId>`), capped by `perRun`.
 */

import type { QuotaWindow, RolesQuota, UnifiedToolContext } from '@papercusp/tooldef';

export function papercuspComputeQuotaWindow(
  ctx: UnifiedToolContext,
  roleQuota: RolesQuota | undefined,
  toolName?: string,
  input?: unknown,
): QuotaWindow {
  let window: QuotaWindow;
  if (ctx.role === 'worker') {
    window = {
      key: ctx.chunkId ? `chunk:${ctx.chunkId}` : null,
      limit: roleQuota?.perChunk ?? null,
    };
  } else if (ctx.isPowerUser && ctx.uiClientId) {
    window = {
      key: `power-user:${ctx.uiClientId}`,
      limit: roleQuota?.perRun ?? null,
    };
  } else if (ctx.quotaSubject) {
    window = {
      key: `subject:${ctx.quotaSubject}`,
      limit: roleQuota?.perRun ?? null,
    };
  } else {
    window = {
      key: ctx.runId ? `run:${ctx.runId}` : null,
      limit: roleQuota?.perRun ?? null,
    };
  }

  // A release cut can take an hour. Its routine status and artifact handoff
  // reads must remain available after the bounded mutating calls are spent.
  // Distinct keys keep successful reads out of the write quota's count.
  if (toolName === 'release:cut' && window.limit != null && window.key) {
    const op = input && typeof input === 'object' && 'op' in input ? input.op : undefined;
    const readOnly = op === 'preflight' || op === 'status' || op === 'handoff';
    return {
      key: `${window.key}:${readOnly ? 'read' : 'write'}`,
      limit: readOnly ? null : window.limit,
    };
  }
  return window;
}
