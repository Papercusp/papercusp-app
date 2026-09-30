/** Loopback owner mutation door for Settings → Identities. */
import { defineTool } from '@papercusp/agent-mcp';
import { isLoopbackRequest } from '../../../superuser-token';
import { activeWorkspaceId } from '../../../workspace-registry';
import { composeModePromptSection } from './bootstrap-su';

interface Body {
  ownerId?: unknown;
  action?: unknown;
  identityId?: unknown;
  slot?: unknown;
  compositionId?: unknown;
  componentRefs?: unknown;
  description?: unknown;
  harnessSlug?: unknown;
}

const ACTIONS = new Set(['preview', 'attach', 'switch', 'detach', 'rollback',
  'preview-composition', 'save-composition']);

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/identity-management',
  auth: 'loopback',
  async handler(req) {
    if (!isLoopbackRequest(req.headers)) {
      return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
    }
    let body: Body;
    try {
      body = await req.json() as Body;
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }
    const ownerId = typeof body.ownerId === 'string' ? body.ownerId.trim() : '';
    const action = typeof body.action === 'string' && ACTIONS.has(body.action) ? body.action : '';
    const compositionAction = action === 'preview-composition' || action === 'save-composition';
    if ((!ownerId && !compositionAction) || !action) {
      return Response.json({ ok: false, error: 'ownerId and a valid action are required' }, { status: 400 });
    }
    try {
      if (compositionAction) {
        if (typeof body.compositionId !== 'string' || !Array.isArray(body.componentRefs) ||
            body.componentRefs.some((ref) => typeof ref !== 'string') ||
            (body.description != null && typeof body.description !== 'string')) {
          return Response.json({ ok: false, error: 'compositionId, componentRefs and description are invalid' }, { status: 400 });
        }
        const harnessSlug = typeof body.harnessSlug === 'string' ? body.harnessSlug.trim() : '';
        const [{ previewNamedIdentityComposition, saveNamedIdentityComposition },
          { resolveProjectDir }, { papercuspPathForWorkspace }] = await Promise.all([
          import('../../../identity-management'), import('../../../spawn-config'),
          import('../../../papercusp-root'),
        ]);
        const workspaceId = activeWorkspaceId();
        const repoDir = harnessSlug
          ? await resolveProjectDir(harnessSlug, workspaceId)
          : papercuspPathForWorkspace(workspaceId);
        if (!repoDir) return Response.json({ ok: false, error: 'selected harness is not registered' }, { status: 404 });
        const input = { id: body.compositionId, componentRefs: body.componentRefs as string[],
          description: body.description as string | undefined, repoDir };
        const result = action === 'save-composition'
          ? await saveNamedIdentityComposition(input)
          : await previewNamedIdentityComposition(input);
        if (action === 'save-composition') {
          const { notifySyncInvalidate } = await import('../../../sync-sse');
          await notifySyncInvalidate('identities.surface').catch(() => {});
        }
        return Response.json({ ok: true, action, ...result });
      }
      const [{ mutateIdentityStack }, { readSuLaunchSpecByOwner, }, { parseSuLaunchSpecRecord }] = await Promise.all([
        import('../../../identity-management'),
        import('../../../adv-sessions'),
        import('../../../su-persona-render'),
      ]);
      const record = parseSuLaunchSpecRecord(await readSuLaunchSpecByOwner(ownerId));
      if (!record) {
        return Response.json({ ok: false, error: 'The selected session has no mutable launch specification.' }, { status: 409 });
      }
      const result = await mutateIdentityStack({
        workspaceId: activeWorkspaceId(),
        ownerId,
        action: action as 'preview' | 'attach' | 'switch' | 'detach' | 'rollback',
        identityId: typeof body.identityId === 'string' ? body.identityId : null,
        slot: typeof body.slot === 'string' ? body.slot : null,
        operatorBaseUrl: new URL(req.url).origin,
        modeSection: composeModePromptSection({
          autoMode: record.autoMode,
          drainMode: record.drainMode,
          loopArmed: record.loopArmed,
        }),
      });
      const { notifySyncInvalidate } = await import('../../../sync-sse');
      await notifySyncInvalidate('identities.surface').catch(() => {});
      return Response.json(result);
    } catch (error) {
      return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 409 });
    }
  },
});
