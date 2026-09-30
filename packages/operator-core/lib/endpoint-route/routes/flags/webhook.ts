/**
 * POST /api/flags/webhook
 *
 * Receives flag-change notifications from the self-hosted PostHog
 * instance and broadcasts onto the in-process flag bus (which fans out
 * to /api/flags/stream subscribers).
 *
 * Ported from app/api/flags/webhook/route.ts — R1 pilot, the
 * `auth: 'public'` case. "Public" here means the route opts out of
 * `requirePrincipal`: the caller is PostHog, not a Papercusp principal.
 * The route keeps its OWN auth — a shared-secret header check — inside
 * the handler. This is exactly the pattern `auth: 'public'` exists for:
 * webhooks and OAuth callbacks that authenticate by a non-principal
 * mechanism.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ALL_FLAG_KEYS, type FlagKey } from '@papercusp/flags';
import { publishFlagChange } from '../../../flag-bus';
import { defineTool } from '@papercusp/agent-mcp';

function expectedSecret(): string | null {
  const envSecret = process.env.PAPERCUSP_POSTHOG_WEBHOOK_SECRET;
  if (envSecret) return envSecret;
  try {
    const raw = fs.readFileSync(
      path.join(os.homedir(), '.papercusp', 'posthog.json'),
      'utf8',
    );
    const parsed = JSON.parse(raw) as { webhookSecret?: string };
    return parsed.webhookSecret ?? null;
  } catch {
    return null;
  }
}

function extractFlagKey(body: unknown): FlagKey | null {
  if (!body || typeof body !== 'object') return null;
  const stack: unknown[] = [body];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    for (const [k, v] of Object.entries(node)) {
      if (
        (k === 'key' || k === 'flag_key') &&
        typeof v === 'string' &&
        (ALL_FLAG_KEYS as readonly string[]).includes(v)
      ) {
        return v as FlagKey;
      }
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

export default defineTool({
  method: 'POST',
  path: '/flags/webhook',
  auth: 'public',
  // No `input` schema — PostHog's webhook payload shape varies by
  // trigger; the handler walks it permissively. Freeform-body case.
  async handler(req) {
    const expected = expectedSecret();
    const provided = req.headers.get('x-papercusp-webhook-secret');
    if (!expected || provided !== expected) {
      return Response.json({ ok: false, reason: 'auth' }, { status: 401 });
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      body = null;
    }
    const key = extractFlagKey(body);
    publishFlagChange(key);
    return Response.json({ ok: true, key });
  },
});
