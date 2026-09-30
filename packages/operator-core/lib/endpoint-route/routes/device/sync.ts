/**
 * Device sync + voice-tool-proxy routes — Phase E4 batch M5
 * (endpoint-unification-2026-05-21). Ported off `_hono/mobile.ts`.
 *
 *   GET  /device/rest-query        device JWT (via ?token= — see tokenIn)
 *   POST /device/voice-tool/:name  device JWT
 *
 * `/rest-query` reads the device JWT from `?token=` (`auth.tokenIn`)
 * because libs/sync's polling fetcher uses a bare `fetch()` and cannot
 * set an `Authorization` header.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { DEVICE_AUTH, devicePrincipal } from './_shared';
import { recentToasts, recentAuditEntries, currentlyRunning } from '../../../device-feeds';
import { listHarnessesFor, harnessStatusFor } from '../../../device-harnesses';
import { readCandidates, refreshCandidates } from '../../../operator-standing-candidates';

/**
 * GET /device/rest-query — REST query endpoint for libs/sync's polling
 * fetcher. `?token=<jwt>&name=<queryName>&args=<json>` →
 * `{ rows, version }` (the shape libs/sync expects).
 *
 * Auth is the device JWT, read from `?token=` via `auth.tokenIn` — the
 * route-stack lifts it into the standard bearer path, so the handler
 * just reads `ctx.principal`.
 */
const restQuery = defineTool({
  method: 'GET',
  path: '/device/rest-query',
  auth: { kind: ['device'], tokenIn: ['query'] },
  cors: true,
  async handler(req, ctx) {
    const workspaceId = devicePrincipal(ctx).workspaceId;
    const url = new URL(req.url);
    const name = url.searchParams.get('name');
    if (!name) return Response.json({ error: 'missing name' }, { status: 400 });
    const argsJson = url.searchParams.get('args') ?? '{}';
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson);
    } catch {
      return Response.json({ error: 'invalid args (not JSON)' }, { status: 400 });
    }

    try {
      switch (name) {
        case 'toastLog.recent': {
          const limit = Math.min(Number(args.limit) || 50, 200);
          const rows = await recentToasts(workspaceId, limit);
          return Response.json({ rows, version: String(Date.now()) });
        }
        case 'auditLog.recent': {
          const limit = Math.min(Number(args.limit) || 50, 200);
          const rows = await recentAuditEntries(workspaceId, limit);
          return Response.json({ rows, version: String(Date.now()) });
        }
        case 'operatorScans.running': {
          const snap = await currentlyRunning(workspaceId);
          // The polling fetcher expects {rows: T[]}; wrap single-value
          // queries in a one-element array (the screen unwraps via data[0]).
          return Response.json({ rows: [snap], version: String(Date.now()) });
        }
        case 'harnessStatus.list': {
          const rows = await listHarnessesFor(workspaceId);
          return Response.json({ rows, version: String(Date.now()) });
        }
        case 'harnessStatus.byHarness': {
          const slug = String(args.harnessSlug ?? '');
          if (!slug) return Response.json({ error: 'missing harnessSlug' }, { status: 400 });
          const status = await harnessStatusFor(workspaceId, slug);
          return Response.json({ rows: status ? [status] : [], version: String(Date.now()) });
        }
        case 'standingCandidates.list': {
          const candidates = await refreshCandidates().catch(() => readCandidates());
          return Response.json({ rows: candidates, version: String(Date.now()) });
        }
        default:
          return Response.json({ error: `unknown query: ${name}` }, { status: 400 });
      }
    } catch (e) {
      console.error('[/device/rest-query]', name, e);
      return Response.json(
        { error: e instanceof Error ? e.message : String(e) },
        { status: 500 },
      );
    }
  },
});

/**
 * POST /device/voice-tool/:name — server-side proxy for phone-side EL
 * voice tools that don't touch the phone UI. The Rust client's
 * VoiceManager dispatcher falls through to here for ~30 of the 37 tools
 * the EL agent has configured. EL normalizes registry ids to underscore
 * form; we reverse it to look the def up.
 *
 * Body: `{ parameters: {...} }`. Returns the tool result, or
 * `{ ok: false, error }` on failure.
 */
const voiceToolProxy = defineTool({
  method: 'POST',
  path: '/device/voice-tool/:name',
  auth: DEVICE_AUTH,
  cors: true,
  async handler(req, ctx) {
    const principal = devicePrincipal(ctx);
    const elName = ctx.params.name;
    if (!elName) return Response.json({ error: 'missing tool name' }, { status: 400 });
    const body = await req.json().catch(() => ({}));
    const params = (body && typeof body === 'object' && 'parameters' in body)
      ? (body as { parameters?: unknown }).parameters ?? {}
      : body ?? {};

    // ask_operator is a meta-tool, not in the command registry — it
    // drains the operator-converse SSE stream and returns the <say> body.
    if (elName === 'ask_operator') {
      const p = params as { text?: string; trigger?: string };
      const userText = (p?.text ?? '').toString().trim();
      const triggerRaw = typeof p?.trigger === 'string' ? p.trigger : 'user_message';
      if (!userText && !triggerRaw) return Response.json('');
      const base = process.env.MOBILE_SELF_BASE ?? `http://localhost:${process.env.PORT ?? 3055}`;
      const { askOperatorViaConverse } = await import('../../../device-ask-operator');
      const result = await askOperatorViaConverse({ baseUrl: base, userText, trigger: triggerRaw });
      if (result.kind === 'empty') {
        console.warn(`[mobile:ask_operator] empty — events=${result.eventCount} trigger=${result.trigger} userText.length=${userText.length}`);
      } else if (result.kind === 'timeout') {
        console.warn(`[mobile:ask_operator] TIMEOUT after ${result.timeoutMs}ms`);
      } else if (result.kind === 'bad-status') {
        console.warn(`[mobile:ask_operator] bad-status status=${result.status}`);
      } else if (result.kind === 'error') {
        console.warn(`[mobile:ask_operator] error: ${result.error}`);
      }
      return Response.json(result.text);
    }

    // EL normalizes registry ids (dots+dashes → underscores); the reverse
    // isn't unique, so resolveRegistryToolId iterates by normalized form.
    // Side-effect import populates the registry.
    await import('../../../commands/defs');
    const { get, list, runCommand, runQuery } = await import('../../../commands/registry');
    const { resolveRegistryToolId } = await import('../../../device-tool-resolver');
    const resolvedId = resolveRegistryToolId(elName, {
      get: (id) => get(id),
      list: () => [
        ...list({ kind: 'command', agent: 'operator' }),
        ...list({ kind: 'query', agent: 'operator' }),
      ],
    });
    const def = resolvedId ? get(resolvedId) : undefined;
    if (!def || !resolvedId) {
      return Response.json(
        { ok: false, error: { code: 'unknown-tool', message: `no such registry tool: ${elName}`, retryable: false } },
        { status: 404 },
      );
    }
    const { randomUUID } = await import('node:crypto');
    const { detectSurface } = await import('../../../device-surface');
    const cmdCtx = {
      agent: 'operator' as const,
      workspace: principal.workspaceId,
      sessionId: principal.slug,
      requestId: `el-mobile-${randomUUID()}`,
      surface: detectSurface({ userAgent: req.headers.get('user-agent') ?? undefined }),
      deviceId: principal.slug,
    };
    try {
      const result = def.kind === 'query'
        ? await runQuery(resolvedId, params, cmdCtx)
        : await runCommand(resolvedId, params, cmdCtx);
      return Response.json(result);
    } catch (e) {
      return Response.json(
        { ok: false, error: { code: 'tool-exec', message: (e as Error)?.message ?? String(e), retryable: true } },
        { status: 500 },
      );
    }
  },
});

export default [restQuery, voiceToolProxy];
