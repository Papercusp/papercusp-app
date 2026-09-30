/**
 * Production wirings of the per-pot learning gate
 * (plan learning-pot-scope-gate-2026-08-30, P-003 / P-004).
 *
 * The lanes take the gate as an INJECTED predicate so their unit tests stay
 * hermetic (unwired ⇒ no gate). These are the real implementations the boot
 * paths pass in — kept HERE, together, for one specific reason: the same lane
 * is wired from more than one entrypoint (Scout runs from both the
 * `system:scout-cycle` routine action and the `blender:cycle` blueprint op),
 * and a gate wired at one entrypoint but missed at the other silently no-ops.
 * That has already happened once in this exact file's neighbourhood — the P-051
 * workspace ceiling was not carried into the blueprint op and every cycle
 * passed its per-cycle cap while the aggregate cap refused nothing for months
 * (see the comment at blueprint-steps/ops/scout-cycle.ts). One shared helper is
 * cheap insurance against repeating it.
 *
 * Every helper here fails OPEN (R-5): an unreadable pot gate must not become a
 * fleet-wide learning outage. The store already fails open on a missing
 * relation; these add the same posture for any other read failure, because at
 * this layer the alternative is stopping a lane the owner never switched off.
 */
import type { Sql } from 'postgres';
import { potLearningEnabled } from './store';

/**
 * Scout's preflight (P-004): resolve the pot this install learns FOR, then ask
 * the gate. The install slug is resolved through `resolveLearningPotSlug` —
 * the ONE way a learning writer resolves its pot — rather than assumed to BE
 * the pot slug, because a Scout install can run under a member harness of a
 * pot, and gating on the raw harness slug would miss exactly those.
 *
 * An unresolvable pot (null) is NOT a disabled pot: a context-less system
 * writer belongs to no pot, so no pot switch can gate it.
 */
export async function scoutPotGate(input: {
  workspaceId: string;
  installSlug: string;
}): Promise<{ enabled: boolean }> {
  try {
    const [{ resolveLearningPotSlug }, { getOrgPg }] = await Promise.all([
      import('../pot-scope'),
      import('@papercusp/db-org'),
    ]);
    const potSlug = await resolveLearningPotSlug({
      workspaceId: input.workspaceId,
      harnessSlug: input.installSlug,
    });
    if (!potSlug) return { enabled: true };
    const { sql } = getOrgPg();
    return { enabled: await potLearningEnabled(sql, { workspaceId: input.workspaceId, potSlug }) };
  } catch (e) {
    console.warn(
      `[learning-pot-gate] scout gate read failed for ${input.installSlug} — allowing ` +
        `(fail-open, R-5): ${e instanceof Error ? e.message : e}`,
    );
    return { enabled: true };
  }
}

/**
 * Gym's tick filter (P-003): the pots switched OFF in this workspace, as a set
 * matched against `gym_autoloop_config.harness_slug`.
 *
 * Gym does NOT go through `resolveLearningPotSlug` the way Scout does, because
 * a gym autoloop row is per-hive by construction — its harness slug IS the pot
 * slug, which is the same assumption the governor mirror already makes when it
 * ledgers gym spend (`potSlug: input.ran.harnessSlug`, registrants.ts). Keeping
 * the two consistent matters: if this resolved differently, a pot's gym spend
 * would be filed under one slug and gated under another.
 */
export async function gymDisabledPots(sql: Sql, workspaceId: string): Promise<ReadonlySet<string>> {
  const { disabledPotSlugs } = await import('./store');
  return new Set(await disabledPotSlugs(sql, { workspaceId }));
}

/** The settings-resident sections the learning drawer owns, in layering order. */
const SCOUT_CONFIG_SECTIONS = ['scout', 'cadence', 'budget'] as const;

/**
 * Scout's settings-resident config resolver (WI-1664060) — the per-pot `scout`
 * (judgment tuning), `cadence` (fire threshold / heartbeat / floors) and `budget`
 * (per-cycle spend) deltas the owner sets in the learning drawer, which
 * `runScoutCycleTick` shallow-merges per section over the routine payload.
 *
 * It belongs in THIS file for the reason the header gives. This layering used to
 * live inside the `system:scout-cycle` routine action's body, so the
 * `blender:cycle` blueprint op — the path that actually runs Scout in production
 * — never applied it, and the owner's tuning was written to hive_settings and
 * never read. Same shape as the P-051 ceiling above it: one lane, two
 * entrypoints, a concern wired at only one of them. Now there is one resolver
 * and one merge site, and both entrypoints pass this.
 *
 * WORKSPACE-scoped Scout (WORKSPACE_COORDINATION ON) ticks under the workspace
 * SENTINEL slug, which has no `hive_settings` row — so a per-hive override could
 * never apply and the owner's model config once sat unread while Scout ran engine
 * defaults (2026-07-01). Hence the HOME-hive fallback, the same resolution the
 * Queen's steering uses.
 *
 * Fails OPEN like every helper here (R-5): any read failure returns null and the
 * routine payload is used unchanged — behaviour-neutral when no delta is set,
 * which is the common case, and never a reason a tick does not run.
 */
export async function scoutConfigDelta(input: {
  workspaceId: string;
  installSlug: string;
}): Promise<Record<string, Record<string, unknown>> | null> {
  try {
    const { getHiveLocalBlueprintConfig } = await import('../../hive-settings-store');

    let home: string | null = null;
    try {
      const [{ resolvePotHomeSlug }, { operatorHomeHarnessSlug }] = await Promise.all([
        import('../../pot/wake'),
        import('../../harness/operator-home-harness'),
      ]);
      home = resolvePotHomeSlug(null, null) ?? operatorHomeHarnessSlug();
    } catch {
      /* home resolution unavailable → primary scope only, as before */
    }

    const out: Record<string, Record<string, unknown>> = {};
    for (const section of SCOUT_CONFIG_SECTIONS) {
      let delta = await getHiveLocalBlueprintConfig(input.workspaceId, input.installSlug, section);
      if (delta == null && home && home !== input.installSlug) {
        delta = await getHiveLocalBlueprintConfig(input.workspaceId, home, section);
      }
      if (delta && typeof delta === 'object' && !Array.isArray(delta)) {
        out[section] = delta as Record<string, unknown>;
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch (e) {
    console.warn(
      `[learning-pot-gate] scout config read failed for ${input.installSlug} — using the ` +
        `routine payload unchanged (fail-open, R-5): ${e instanceof Error ? e.message : e}`,
    );
    return null;
  }
}
