/**
 * POST /api/discovery/join-invite — the INVITEE side of a hive invite
 * (hive-from-repo-hardening-2026-06-11 P-006 / D-006).
 *
 * Body: { link: 'papercusp://pot?pubkey=…&secret=…&title=…' }. Parses the
 * invite artifact strictly (parseHiveInviteLink — null on anything off-shape),
 * lazily wires the hive directory if needed, and joins the invite-scoped
 * directory topic derived from the secret so the invite hive's announce is
 * ingested + listed in the Hives panel. Idempotent (the gossip topic join is).
 *
 * G-002 honest-join (shared-pot-release-testing brief L): joining the topic is
 * NOT the same as the hive existing on it. A withdrawn / wrong / offline-owner
 * invite parses identically to a good one (SECRET_RE accepts any 32–128 hex) and
 * the bare subscribe always "succeeds" — so the route used to return
 * `{ ok:true, joined:true }` for a join that NEVER materializes (the deceptive
 * "✓ accepted … appears shortly" no-op). Now we BOUNDED-WAIT for the invite hive
 * to actually announce on the topic (confirmInviteAnnounce) and report the truth:
 * `joined`/`found` reflect whether a hive really appeared, and `subscribed` is
 * the honest fallback (we're on the topic; nothing is announcing there yet).
 *
 * A box where the directory can't wire (gh-unauthenticated — no announce
 * identity) returns 503 `directory_unavailable` rather than pretending.
 *
 * `auth: 'loopback'` (auth-tier Wave 1), same perimeter as
 * /discovery/set-pot — the desktop webview is cookie-less.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { parseHiveInviteLink } from '../../../harness/hive-invite-link';

export default defineTool({
  method: 'POST',
  path: '/discovery/join-invite',
  auth: 'loopback',
  async handler(req) {
    let body: { link?: string } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      /* empty body */
    }
    const invite = parseHiveInviteLink(String(body.link ?? ''));
    if (!invite) {
      return Response.json(
        { error: 'malformed hive invite link', code: 'invalid_link' },
        { status: 400 },
      );
    }
    const { ensureHiveDirectoryWired } = await import('../../../hive-directory-boot');
    const { activeWorkspaceId } = await import('../../../workspace-registry');
    const wiring = await ensureHiveDirectoryWired(activeWorkspaceId());
    if (!wiring) {
      return Response.json(
        {
          ok: false,
          code: 'directory_unavailable',
          error: 'hive directory is not wired on this box (GitHub auth required)',
        },
        { status: 503 },
      );
    }
    try {
      await wiring.joinInviteTopic(invite.secret);
    } catch (e) {
      return Response.json(
        { ok: false, code: 'join_failed', error: e instanceof Error ? e.message : String(e) },
        { status: 500 },
      );
    }
    // G-002: bounded-wait for the hive to actually announce on this topic before
    // claiming it joined. A confirm seam may be absent on an older/partial wiring
    // (or a test stub) — treat that as "subscribed, unconfirmed" rather than
    // falling back to the old unconditional lie.
    const confirm = wiring.confirmInviteAnnounce
      ? await wiring.confirmInviteAnnounce(invite.secret).catch(() => null)
      : null;
    if (confirm?.found) {
      return Response.json({
        ok: true,
        joined: true,
        found: true,
        subscribed: true,
        peersOnTopic: confirm.peersOnTopic,
        hive: confirm.hive ?? null,
      });
    }
    // Subscribed, but no hive is announcing on this invite (withdrawn / wrong
    // secret / owner offline). Honest, not a fake success.
    return Response.json({
      ok: true,
      joined: false,
      found: false,
      subscribed: true,
      peersOnTopic: confirm?.peersOnTopic ?? 0,
      message:
        'Subscribed to the invite — but no hive is announcing on it yet. It will appear once the owner’s machine announces it, and will not appear if the invite was withdrawn or the link is wrong.',
    });
  },
});
