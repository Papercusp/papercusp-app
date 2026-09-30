/**
 * GET /api/discovery/pot-meta?potId=… — the OWNER side of one hive's share
 * state (comb-hive-native-sharing-2026-06-11 P-004/P-005).
 *
 * Projects the workspace's OWNED directory meta for one hive (the
 * hive-directory-meta registry blob): the current visibility (null = never
 * published — the "unpublished" chrome state), title/description prefill for
 * the Share-Hive dialog, the invite secret (so the owner can re-copy the
 * invite artifact instead of losing it after the first mint), the hive
 * identity pubkey (for the FULL `papercusp://pot` artifact), and the member
 * repos the next publish will list (derived fresh, same as the announce-build
 * enricher — member additions surface here before a republish).
 *
 * `auth: 'loopback'` — this is the owner's own workspace state served to the
 * desktop webview; the loopback bind is the perimeter, same as
 * /discovery/set-pot. The invite secret stays inside that perimeter (it
 * never rides an announce).
 */
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/discovery/pot-meta',
  auth: 'loopback',
  async handler(req) {
    const url = new URL(req.url);
    const potId = (url.searchParams.get('potId') ?? '').trim();
    if (!potId) {
      return Response.json({ error: 'potId required', code: 'invalid_args' }, { status: 400 });
    }
    const { activeWorkspaceId } = await import('../../../workspace-registry');
    const ws = activeWorkspaceId();
    const { getOwnedHiveMeta } = await import('../../../hive-directory-meta');
    const meta = await getOwnedHiveMeta(potId, ws);
    const hivePubkey = await import('../../../identity/hive-keypair')
      .then(({ loadHivePubkey }) => loadHivePubkey(ws, potId))
      .catch(() => null);
    const memberRepos = await import('../../../hive-member-repos')
      .then(({ deriveHiveMemberRepoRefs }) => deriveHiveMemberRepoRefs(ws, potId))
      .catch(() => [] as string[]);
    return Response.json({
      potId,
      found: meta !== null,
      visibility: meta?.visibility ?? null,
      title: meta?.title ?? potId,
      description: meta?.description ?? '',
      inviteSecret: meta?.inviteSecret ?? null,
      hivePubkey,
      memberRepos,
    });
  },
});
