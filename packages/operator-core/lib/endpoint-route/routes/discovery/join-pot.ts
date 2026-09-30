/**
 * POST /api/discovery/join-pot — join a discovered hive AS A HIVE
 * (hive-from-repo-hardening-2026-06-11 P-007 / D-007).
 *
 * Body: { potId, title?, hivePubkey?, ownerDevicePubkey?, memberLinks: string[] }
 * Composes the existing per-member-link join for every link, then
 * materializes the joiner-side registry VIEW (a `remote_hive`-flagged
 * kind:'hive' entry + hive_slug on the joined members) so the Harnesses tab
 * groups them. This is what the directory panel's Join drives now; the
 * per-link POST /api/harness/join-link stays the underlying mechanic.
 *
 * Loopback + long timeout: N member joins = N read-only clones.
 */
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/discovery/join-pot',
  // The formal Wave-1 tier (auth-posture standing gate) — N member joins =
  // N read-only clones, desktop-webview-only like its discovery siblings.
  auth: 'loopback',
  timeoutSec: 600,
  async handler(req) {
    let body: {
      potId?: string;
      title?: string;
      hivePubkey?: unknown;
      ownerDevicePubkey?: unknown;
      memberLinks?: unknown;
    } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      /* empty body */
    }
    const potId = String(body.potId ?? '').trim();
    const memberLinks = Array.isArray(body.memberLinks)
      ? body.memberLinks.filter((l): l is string => typeof l === 'string' && l.length > 0)
      : [];
    if (!potId || memberLinks.length === 0) {
      return Response.json(
        { error: 'potId and memberLinks[] required', code: 'invalid_args' },
        { status: 400 },
      );
    }
    if (memberLinks.length > 64) {
      return Response.json(
        { error: 'too many member links (max 64)', code: 'invalid_args' },
        { status: 400 },
      );
    }
    const { joinHiveAsView } = await import('../../../harness/join-hive');
    const { activeWorkspaceId } = await import('../../../workspace-registry');
    const workspaceId = activeWorkspaceId();
    // WI-5672: this is the discovery-panel / rig `rig_join_hive` join path, and it
    // used to be the ONLY joiner path that never wired the hive-directory swarm
    // topic — papercusp-hive-join.ts's canonical dogfood-bootstrap join calls
    // ensureHiveDirectoryWired BEFORE joinHiveAsView (see its `defaultEnsureWired`),
    // but this route went straight to joinHiveAsView. Live-reproduced on the
    // 2-machine gate rig: the joiner's serve.log never emitted a single
    // `[topic-gossip:papercusp/hive-directory]` line (only hive-presence), so the
    // joiner never subscribes to the directory topic peers announce/re-announce
    // hive membership changes on. Mirror the canonical path's pattern — best-effort,
    // memoized (a no-op if boot-all already wired it), NEVER fails the join.
    try {
      const { ensureHiveDirectoryWired } = await import('../../../hive-directory-boot');
      await ensureHiveDirectoryWired(workspaceId);
    } catch {
      /* best-effort — directory wiring never blocks the join itself */
    }
    // WI-38343: forward the caller's VERIFIED owner-device binding. `joinHiveAsView`
    // stamps (hive_pubkey, owner_device_pubkey) onto the registry view, which is the
    // DETERMINISTIC leg the substrate's owner-bootstrap admit resolves from in every
    // process (hive-membership-store.ts leg 0 / Brief-3). Without it this join-BY-ID
    // path had no explicit source at all: `opts.ownerDevicePubkey` was never supplied,
    // the observed gist-less owner path omitted the normally link-carried binding
    // (WI-38345), and the local-directory fallback was empty on the fresh joiner — so
    // the view went unstamped and admission fell back on directory TIMING, the exact
    // race Brief-3 removed. Live-reproduced on
    // the 2-machine gate rig: `owner-resolve → ownerDevice=<null>` on the joiner, the
    // owner's announce conclusively rejected `binding_invalid`, and because announces
    // are never re-delivered the A→B stall is PERMANENT (0 pot_members, never converged).
    const res = await joinHiveAsView({
      potId,
      ...(typeof body.title === 'string' && body.title.trim() ? { title: body.title.trim() } : {}),
      ...(typeof body.hivePubkey === 'string' && body.hivePubkey.trim()
        ? { hivePubkey: body.hivePubkey.trim() }
        : {}),
      ...(typeof body.ownerDevicePubkey === 'string' && body.ownerDevicePubkey.trim()
        ? { ownerDevicePubkey: body.ownerDevicePubkey.trim() }
        : {}),
      memberLinks,
      workspaceId,
    });
    if (!res.ok) {
      const status = res.error === 'invalid_member_links' ? 400 : 502;
      return Response.json(
        { error: res.error ?? 'join failed', code: res.error, members: res.members },
        { status },
      );
    }
    // Bust the registry caches so the new view + members group immediately.
    try {
      const { bustProjectsLiteCache } = await import('../../../harness/projects-lite');
      bustProjectsLiteCache();
    } catch {
      /* best-effort */
    }
    return Response.json(res);
  },
});
