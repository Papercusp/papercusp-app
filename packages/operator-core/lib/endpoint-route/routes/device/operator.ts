/**
 * Device operator-surface routes — Phase E4 batch M3
 * (endpoint-unification-2026-05-21). Ported off `_hono/mobile.ts`.
 *
 *   GET    /device/notifications/recent             device JWT
 *   GET    /device/actions/recent                   device JWT
 *   GET    /device/operator/pause                   device JWT
 *   POST   /device/operator/pause                   device JWT
 *   DELETE /device/operator/pause                   device JWT
 *   GET    /device/operator/cards                   device JWT  (RETIRED — empty)
 *   POST   /device/operator/cards/:id/dispatch      device JWT  (RETIRED — 410)
 *   POST   /device/operator/cards/:id/dismiss       device JWT  (RETIRED — 410)
 *   GET    /device/operator/standing-candidates     device JWT
 *   POST   /device/operator/standing-candidates/decide  device JWT
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { DEVICE_AUTH, devicePrincipal } from './_shared';
import { recentToasts, recentAuditEntries } from '../../../device-feeds';
import { setPaused, setResumed, getPauseInfo } from '../../../device-operator-actions';
import { readCandidates, refreshCandidates } from '../../../operator-standing-candidates';
import { appendPreferenceEntry } from '../../../operator-preferences';

/** Clamp a `?limit=` query param to [1, 200], default 50. */
function limitParam(req: Request): number {
  const raw = new URL(req.url).searchParams.get('limit') ?? '50';
  return Math.min(Number(raw) || 50, 200);
}

/* ─── Activity feeds ─────────────────────────────────────────────────── */

const notificationsRecent = defineTool({
  method: 'GET',
  path: '/device/notifications/recent',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(req, ctx) {
    const rows = await recentToasts(devicePrincipal(ctx).workspaceId, limitParam(req));
    return Response.json({ toasts: rows });
  },
});

const actionsRecent = defineTool({
  method: 'GET',
  path: '/device/actions/recent',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(req, ctx) {
    const rows = await recentAuditEntries(devicePrincipal(ctx).workspaceId, limitParam(req));
    return Response.json({ entries: rows });
  },
});

/* ─── Global pause flag ──────────────────────────────────────────────── */

const pauseGet = defineTool({
  method: 'GET',
  path: '/device/operator/pause',
  auth: DEVICE_AUTH,
  cors: true,
  async handler() {
    return Response.json(await getPauseInfo());
  },
});

const pauseSet = defineTool({
  method: 'POST',
  path: '/device/operator/pause',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(_req, ctx) {
    await setPaused(devicePrincipal(ctx).label ?? 'mobile');
    return Response.json(await getPauseInfo());
  },
});

const pauseClear = defineTool({
  method: 'DELETE',
  path: '/device/operator/pause',
  auth: DEVICE_AUTH,
  cors: true,
  async handler() {
    await setResumed();
    return Response.json(await getPauseInfo());
  },
});

/* ─── Operator cards — RETIRED (unify-agent-launches D-005) ──────────────
 * The scanner card stream dissolved into the scheduled `scan` launch
 * blueprint; findings are tracked work_items in the self-improvement
 * backlog (read via improvements:digest), not a card feed. The list route
 * stays as a graceful empty so older mobile builds render an empty deck;
 * the card mutations are 410 Gone. */

const cardsList = defineTool({
  method: 'GET',
  path: '/device/operator/cards',
  auth: DEVICE_AUTH,
  cors: true,
  async handler() {
    return Response.json({ cards: [] });
  },
});

const cardGone = (path: string) =>
  defineTool({
    method: 'POST',
    path,
    auth: DEVICE_AUTH,
    cors: true,
    async handler() {
      return Response.json(
        { ok: false, error: 'operator cards retired (unify-agent-launches D-005) — findings live in the improvements backlog' },
        { status: 410 },
      );
    },
  });

const cardDispatch = cardGone('/device/operator/cards/:id/dispatch');
const cardDismiss = cardGone('/device/operator/cards/:id/dismiss');

/* ─── Standing-approval candidates ───────────────────────────────────── */

const standingCandidatesList = defineTool({
  method: 'GET',
  path: '/device/operator/standing-candidates',
  auth: DEVICE_AUTH,
  cors: true,
  async handler() {
    const candidates = await refreshCandidates().catch(() => readCandidates());
    return Response.json({ candidates });
  },
});

const standingCandidatesDecide = defineTool({
  method: 'POST',
  path: '/device/operator/standing-candidates/decide',
  auth: DEVICE_AUTH,
  cors: true,
  input: z.object({
    capability: z.string().min(1),
    targetHarness: z.string().min(1),
    decision: z.enum(['approve', 'dismiss']),
  }),
  async handler(_req, ctx) {
    const { capability, targetHarness, decision } = ctx.input;
    if (decision === 'approve') {
      const today = new Date().toISOString().slice(0, 10);
      const entry = `- [OPERATOR-PROPOSED-USER-CONFIRMED-${today}] [STANDING-APPROVE]\n  capability=${capability}, target=${targetHarness}\n  pattern: ≥3 silent dispatches in 24h\n  user confirmed: ${new Date().toISOString()}`;
      await appendPreferenceEntry(entry);
    }
    await refreshCandidates().catch(() => {});
    return Response.json({ ok: true });
  },
});

export default [
  notificationsRecent,
  actionsRecent,
  pauseGet,
  pauseSet,
  pauseClear,
  cardsList,
  cardDispatch,
  cardDismiss,
  standingCandidatesList,
  standingCandidatesDecide,
];
