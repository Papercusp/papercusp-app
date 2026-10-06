/**
 * P-017 (pot-review-integration-mode-2026-10-05, D-007): the pot-settings form of
 * the ONE question "Where should the agents' work go?".
 *
 *   GET /harness/:slug/integration-mode → the question (owner-approved wording,
 *       repo name substituted, option availability) + the pot's current answer.
 *   PUT /harness/:slug/integration-mode { mode } → switch through
 *       choosePotIntegrationMode, the same seam pot creation uses: switching to
 *       the working copy creates and records the pot's fork first, and is refused
 *       in plain language when the pot has no test suite. Users never see
 *       low-level git settings.
 *
 * Handlers are built by makeIntegrationModeRoutes(deps) so tests inject the
 * registry, the setting read, the suite resolver and the switch.
 */
import { defineTool } from '@papercusp/agent-mcp';
import type {
  ChoosePotIntegrationModeInput,
  ChoosePotIntegrationModeResult,
} from '../../../harness/git-sync/pot-integration-mode';
import { repoHasSubmodules } from '../../../harness/git-sync/pot-integration-mode';
import { parseIntegrationModeAnswer } from '../../../harness/git-sync/integration-mode-question';
import {
  defaultIntegrationModeSettingsDeps,
  readIntegrationModeSettings,
  resolveIntegrationModePot,
  type IntegrationModePotResolution,
  type IntegrationModeSettingsDeps,
} from '../../../harness/git-sync/integration-mode-settings';

export { repoLabelFromRemote, type IntegrationModeRegistryEntry } from '../../../harness/git-sync/integration-mode-settings';

export interface IntegrationModeRouteDeps extends IntegrationModeSettingsDeps {
  choose: (input: ChoosePotIntegrationModeInput) => Promise<ChoosePotIntegrationModeResult>;
  /** Push the new answer to every live settings section (`potIntegration.settings`). */
  notifySaved?: (slug: string) => Promise<void>;
}

/** The HTTP refusal for a slug that is not a pot, or null when it is one. */
function notAPotResponse(r: { kind: IntegrationModePotResolution['kind'] }): Response | null {
  if (r.kind === 'unknown-harness') return Response.json({ error: 'unknown harness' }, { status: 404 });
  if (r.kind === 'not-a-pot') {
    return Response.json(
      { error: 'not_a_pot', message: 'This project is not a pot, so there is no shared agent work to route.' },
      { status: 409 },
    );
  }
  return null;
}

export function makeIntegrationModeRoutes(deps: IntegrationModeRouteDeps) {
  const get = defineTool({
    method: 'GET',
    path: '/harness/:slug/integration-mode',
    auth: 'loopback',
    async handler(_req, ctx) {
      const r = await readIntegrationModeSettings(deps, ctx.params.slug as string);
      if (r.kind !== 'pot') return notAPotResponse(r) as Response;
      return Response.json({ question: r.question, current: r.current, workingCopyUrl: r.workingCopyUrl });
    },
  });

  const put = defineTool({
    method: 'PUT',
    path: '/harness/:slug/integration-mode',
    auth: 'loopback',
    async handler(req, ctx) {
      const r = await resolveIntegrationModePot(deps, ctx.params.slug as string);
      if (r.kind !== 'pot') return notAPotResponse(r) as Response;
      const body = (await req.json().catch(() => ({}))) as { mode?: unknown };
      const mode = parseIntegrationModeAnswer(body.mode);
      if (!mode) {
        return Response.json({ error: 'mode_required', message: "mode must be 'direct' or 'review'" }, { status: 400 });
      }
      const ws = await deps.workspaceId();
      const greenCmd = await deps.resolveSuite(r.entry.slug, ws).catch(() => null);
      const result = await deps.choose({
        workspaceId: ws,
        potHomeSlug: r.potHomeSlug,
        harnessSlug: r.entry.slug,
        mode,
        greenCmd,
        forkRemote: r.entry.fork_remote ?? null,
        upstreamRemote: r.entry.github_remote ?? null,
        hasSubmodules: repoHasSubmodules(r.entry.path),
      });
      if (!result.ok) return Response.json(result, { status: 409 });
      // After the write committed: live settings sections re-read (a push failure never fails the save).
      await deps.notifySaved?.(r.entry.slug).catch(() => undefined);
      return Response.json(result);
    },
  });

  return [get, put];
}

export default makeIntegrationModeRoutes({
  ...defaultIntegrationModeSettingsDeps,
  notifySaved: async (slug) =>
    (await import('../../../sync-sse')).notifySyncInvalidate('potIntegration.settings', { slug }),
  choose: async (input) =>
    (await import('../../../harness/git-sync/pot-integration-mode')).choosePotIntegrationMode(input),
});
