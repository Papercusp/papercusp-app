/**
 * flags:set - flip one OR many Papercusp feature flags on or off in PostHog.
 *
 * High-tier tool: changes the live behavior of the entire app. Audited
 * via harness_shared.audit_log; agents are expected to provide a reason.
 *
 * With PostHog configured the flip lands there (and any stale PG override for the key
 * is cleared so it can't shadow PostHog); without PostHog the flip lands
 * in the PG-backed override store (audit P-070, EI-76) — runtime flag
 * toggling on dev boxes with no PostHog and no process restart.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21 P-006): pass `{ key, enabled }` for
 * one or `items:[{ key, enabled }]` for several (per-key enabled is
 * heterogeneous, so it rides `items`) → { ok, results:[{ ok, key, enabled,
 * backend | error }], counts }. Each flip is audited + publishes its own
 * flag-change; a backend failure on one key fails ONLY that key (the rest still
 * flip), with the batch's top-level ok:true and counts.failed the truth signal.
 * `reason` is batch-level.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

import { ALL_FLAG_KEYS, type FlagKey } from '@papercusp/flags';
import { setFlag, setFlagOverride, getFlag } from '@papercusp/flags/server';
import { publishFlagChange } from '../../flag-bus';
import { runBulk, bulkContent } from '@papercusp/agent-mcp/_bulk';
import './_register-backend';

// EI-1168: NOT a z.enum(ALL_FLAG_KEYS) anymore — see flags:get.ts's identical comment
// for the full rationale (a static enum bakes the key list at module-load time, so a
// flag added to libs/flags/src/types.ts after that moment is unflippable through this
// tool even though flags:list, reading the same ALL_FLAG_KEYS, may already see it in a
// fresher process). assertKnownFlagKey still rejects a genuinely-unknown key, per-item,
// through the existing bulk error contract.
const FlagKeySchema = z.string().min(1).describe('a Papercusp flag key (libs/flags/src/types.ts)');
/**
 * `enabled: null` = CLEAR the runtime pg-override for this key, so whatever governs
 * underneath (PostHog, else the derived FLAG_DEFAULTS) takes over again.
 *
 * WHY THIS EXISTS (the gap it closes): the override store has ALWAYS implemented
 * clear-by-null — `FlagOverrideStore.set(key, enabled: boolean | null)` is documented
 * "`null` clears it" (libs/flags/src/server.ts:48) and flag-override-store.ts does
 * `if (enabled === null) delete current[key]`. But BOTH agent-facing edges — this tool
 * and POST /api/flags/set — declared `z.boolean()`, so no caller could ever express it.
 * A documented capability that no surface can reach is unreachable in practice, and it
 * blocked plan git-sync-attribution-graduation-2026-08-10 P-002, whose whole remaining
 * step is "clear the now-redundant pg-override so the graduated default governs".
 *
 * ⚠ null is NOT `false`. `false` PINS the flag off with an override row; `null` REMOVES
 * the row and lets the default decide — which for a graduated flag means it stays ON.
 */
const FlagFlip = z.object({ key: FlagKeySchema, enabled: z.boolean().nullable() });

/** Throws with guidance when `key` isn't a live flag (EI-1168) — mirrors flags:get.ts. */
function assertKnownFlagKey(key: string): asserts key is FlagKey {
  if (!(ALL_FLAG_KEYS as readonly string[]).includes(key)) {
    throw new Error(
      `Unknown flag key "${key}" — not in this process's flag registry (libs/flags/src/types.ts). ` +
        `If this flag was just added, the operator process may need a restart to pick it up; ` +
        `check flags:list for the current known set.`,
    );
  }
}

export default defineTool({
  name: 'flags:set',
  profile: 'engineer',
  // P-062 Phase 4: an operator-level action; its only PG write is to the
  // operator audit_log (whose INSERT carries no workspace_id), so it runs on
  // the admin (rolbypassrls) handle rather than a workspace-scoped RLS tx.
  crossWorkspace: true,
  description:
    'Flip one OR many Papercusp feature flags on or off in PostHog. High-risk: changes app-wide behavior. Pass `{ key, enabled }` for one or `items:[{ key, enabled }]` for several. Provide a clear reason; it is recorded for audit. Returns { ok, results:[{ ok, key, enabled, backend | error }], counts } — correlate by key, not position; a backend failure on one key fails only that key.',
  capability: 'audit:write',
  guidance: {
    when: 'User explicitly asks to enable / disable feature(s), OR Papercusp is being prepared for a release and the V1 ship state needs to be set. Flipping several at once? Pass them all via `items:[{ key, enabled }]`.',
    notWhen: 'For ad-hoc testing of UI behavior, prefer the PostHog dashboard so changes are visible to other agents and humans.',
    seeAlso: [
      'flags:get (read the current value first)',
      'flags:list (all flags + defaults)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect'],
  args: z
    .object({
      key: FlagKeySchema.optional().describe('a single flag key (n=1 shorthand; pair with `enabled`)'),
      enabled: z
        .boolean()
        .nullable()
        .optional()
        .describe(
          'the new value for the single `key` (n=1 shorthand). `null` CLEARS the runtime ' +
            'pg-override instead of setting a value, so the code default (or PostHog) governs ' +
            'again — NOT the same as `false`, which pins the flag off with an override row.',
        ),
      items: z
        .array(FlagFlip)
        .min(1)
        .max(100)
        .optional()
        .describe('flag flips to apply (1–100), each { key, enabled } — `enabled: null` clears that key\'s override'),
      reason: z.string().min(8, 'Provide a short reason (>=8 chars) for the audit log.'),
    })
    .refine((a) => Boolean(a.items?.length) || (Boolean(a.key) && a.enabled !== undefined), {
      message: 'pass `{ key, enabled }` (one) or `items:[{ key, enabled }]` (many)',
    }),
  async handler(args, ctx) {
    // NOT `args.enabled!` — that assertion strips `null` from the type, which would make
    // the single-key form LOOK like it can't clear even though the refine above admits
    // null (it only rejects `undefined`). The runtime value is unchanged either way; the
    // point is that the type keeps saying so.
    const flips: { key: string; enabled: boolean | null }[] = args.items?.length
      ? args.items
      : [{ key: args.key!, enabled: args.enabled as boolean | null }];
    const actor = ctx?.principal?.slug ?? 'agent';
    const env = await runBulk(
      flips,
      async ({ key, enabled }) => {
        assertKnownFlagKey(key);
        // `null` = CLEAR the override (see FlagFlip above). Handled BEFORE the PostHog
        // path on purpose: clearing a local override must never rewrite the PostHog
        // value, which governs other deployments.
        if (enabled === null) {
          const cleared = await setFlagOverride(key, null);
          if (!cleared.ok) {
            return {
              ok: false as const,
              key,
              error: `could not clear the pg-override: ${cleared.reason}`,
            };
          }
          publishFlagChange(key);
          // Report what now GOVERNS, read back in-process — the caller's real question is
          // "what is this flag after the clear?", and for a graduated flag the answer
          // should still be `true` (proving the derived default, not the override, governs).
          const resolved = await getFlag(key, 'system');
          const { recordFlagAudit } = await import('../../flag-audit');
          await recordFlagAudit(key, resolved, actor, {
            reason: args.reason,
            backend: 'pg-override',
          });
          return {
            ok: true as const,
            key,
            enabled: resolved,
            cleared: true as const,
            backend: 'pg-override-cleared' as const,
          };
        }
        const result = await setFlag(key, enabled);
        if (result.ok) {
          // The flip lives in PostHog now — drop any PG override so it can't
          // shadow later PostHog changes.
          await setFlagOverride(key, null);
          publishFlagChange(key);
          const { recordFlagAudit } = await import('../../flag-audit');
          await recordFlagAudit(key, enabled, actor, { reason: args.reason, backend: 'posthog' });
          return { ok: true as const, key, enabled, backend: 'posthog' as const };
        }
        // Fallback to PG override if PostHog is not configured.
        if (result.reason === 'flag-backend-not-configured') {
          const override = await setFlagOverride(key, enabled);
          if (override.ok) {
            // EI-18712738949489735 (FALSE-TEST-SETUP CLASS BUG): a successful
            // pg-override WRITE does not by itself prove the flip is observable —
            // read back in-process before reporting success, so a caller (an agent
            // or a rig script) is never told `ok:true` for a flip its own resolving
            // process doesn't actually see (e.g. no override store propagated here).
            const verified = await getFlag(key, 'system');
            if (verified !== enabled) {
              return {
                ok: false as const,
                key,
                error: `pg-override write reported success but this process's own getFlag() still resolves ${verified} (expected ${enabled}) — not observably applied here`,
              };
            }
            publishFlagChange(key);
            const { recordFlagAudit } = await import('../../flag-audit');
            await recordFlagAudit(key, enabled, actor, { reason: args.reason, backend: 'pg-override' });
            return { ok: true as const, key, enabled, backend: 'pg-override' as const };
          }
          return { ok: false as const, key, error: override.reason };
        }
        return { ok: false as const, key, error: result.reason };
      },
      { keyOf: ({ key }) => ({ key }) },
    );
    return bulkContent(env);
  },
});
