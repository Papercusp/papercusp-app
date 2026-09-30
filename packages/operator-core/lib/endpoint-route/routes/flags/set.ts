/**
 * POST /api/flags/set { key, enabled }
 *
 * Flips a single feature flag and broadcasts the change. With PostHog
 * configured the flip lands there (and any stale PG override for the key
 * is cleared so it can't shadow PostHog); without PostHog the flip lands
 * in the PG-backed override store (audit P-070, EI-76) — runtime flag
 * toggling on dev boxes with no PostHog and no process restart.
 * Used by the /admin/features UI.
 *
 * Ported from app/api/flags/set/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { z } from 'zod';

import { ALL_FLAG_KEYS, type FlagKey } from '@papercusp/flags';
import { setFlag, setFlagOverride, getFlag } from '@papercusp/flags/server';
import { publishFlagChange } from '../../../flag-bus';
import '../../../flag-bus';
import { recordFlagAudit } from '../../../flag-audit';
import { defineTool } from '@papercusp/agent-mcp';

/**
 * `enabled: null` CLEARS the runtime pg-override for this key (the store has always
 * supported it — FlagOverrideStore.set is `boolean | null`, "`null` clears it" —
 * but this edge declared `z.boolean()`, so no caller could reach it). Kept at parity
 * with the flags:set MCP tool deliberately: two edges onto the same store that accept
 * different shapes is how one of them silently rots.
 *
 * ⚠ null is NOT `false`. `false` PINS the flag off with an override row; `null` REMOVES
 * the row so the code default (or PostHog) governs again.
 */
const Body = z.object({ key: z.string(), enabled: z.boolean().nullable() });

export default defineTool({
  method: 'POST',
  path: '/flags/set',
  auth: 'loopback',
  input: Body,
  async handler(req, ctx) {
    const { key: rawKey, enabled } = ctx.input;
    const key = rawKey as FlagKey;
    if (!ALL_FLAG_KEYS.includes(key)) {
      return Response.json({ ok: false, error: 'unknown flag key' }, { status: 400 });
    }
    // Handled BEFORE the PostHog path on purpose: clearing a LOCAL override must never
    // rewrite the PostHog value, which governs other deployments.
    if (enabled === null) {
      const cleared = await setFlagOverride(key, null);
      if (!cleared.ok) {
        return Response.json(
          { ok: false, applied: false, key, error: `could not clear the pg-override: ${cleared.reason}` },
          { status: 502 },
        );
      }
      publishFlagChange(key);
      // Report what NOW governs — the caller's real question after a clear.
      const resolved = await getFlag(key, 'system');
      await recordFlagAudit(key, resolved, ctx.principal?.slug ?? 'operator', {
        backend: 'pg-override',
      });
      return Response.json({
        ok: true,
        applied: true,
        key,
        enabled: resolved,
        cleared: true,
        backend: 'pg-override-cleared',
      });
    }
    const result = await setFlag(key, enabled);
    if (result.ok) {
      // The flip lives in PostHog now — drop any PG override so it can't
      // shadow later PostHog changes (best-effort; the flip itself is done,
      // and setFlagOverride reports failure in-band rather than throwing).
      await setFlagOverride(key, null);
      publishFlagChange(key);
      await recordFlagAudit(key, enabled, ctx.principal?.slug ?? 'operator', { backend: 'posthog' });
      return Response.json({ ok: true, applied: true, key, enabled, backend: 'posthog' });
    }
    // EI-7088: fall back to the PG override store for ANY setFlag failure, not
    // just 'flag-backend-not-configured'. PostHog CONFIGURED-but-unreachable
    // (a fetch error, `list:<status>`, `patch:<status>`, or the flag simply not
    // existing there yet) previously fell straight to the 502 below with no
    // fallback attempt at all — during a PostHog outage NO existing-in-PostHog
    // flag could be toggled, including a kill-switch an operator might urgently
    // need to flip. The PG override is the same safe local mechanism already
    // used for the no-PostHog-configured case; using it here too keeps runtime
    // toggling working regardless of WHY the PostHog write failed.
    const override = await setFlagOverride(key, enabled);
    if (override.ok) {
      publishFlagChange(key);
      // EI-18712738949489735 (FALSE-TEST-SETUP CLASS BUG): a successful pg-override
      // WRITE does not by itself prove the flip is OBSERVABLE — a stale per-scope
      // read cache, a workspace-scope mismatch between the writer and a later reader,
      // or (the historical codex-gateway-chatgpt-live case) a resolving process that
      // never installed the override store at all can all make this same process's
      // OWN getFlag() keep serving the old value even though the write "succeeded".
      // Read back in-process, right now, before claiming success — a caller (a rig
      // script arming a flag before relying on it) must never be told `ok:true` for a
      // flip its own resolver doesn't yet see. Scoped to the pg-override path only:
      // the posthog path already round-trips through the SAME client this process
      // reads with, and posthog's own local-eval poll interval would make a readback
      // here a source of flaky false negatives, not a real signal.
      const verified = await getFlag(key, 'system');
      if (verified !== enabled) {
        return Response.json(
          {
            ok: false,
            applied: false,
            key,
            enabled,
            backend: 'pg-override',
            error: `pg-override write reported success but this process's own getFlag() still resolves ${verified} (expected ${enabled}) — the write is not observably applied here; treat as NOT armed`,
          },
          { status: 502 },
        );
      }
      await recordFlagAudit(key, enabled, ctx.principal?.slug ?? 'operator', {
        backend: 'pg-override',
        posthogFailureReason: result.reason,
      });
      return Response.json({ ok: true, applied: true, key, enabled, backend: 'pg-override', posthogFailureReason: result.reason });
    }
    return Response.json(
      { ok: false, error: `posthog: ${result.reason}; pg-override fallback also failed: ${override.reason}`, key },
      { status: 502 },
    );
  },
});
