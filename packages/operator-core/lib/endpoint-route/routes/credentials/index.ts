/**
 * GET / POST /api/credentials
 *
 * GET  — masked view of stored API credentials.
 * POST — set/clear credential fields (non-empty string sets, empty
 *        clears, absent leaves alone).
 *
 * Ported from app/api/credentials/route.ts. `auth: 'public'` preserves
 * the original (un-authed) behavior — see the R2-R6 report's decisions
 * log: tightening credential routes to a trusted principal is a
 * recommended follow-up, deliberately not folded into the mechanical port.
 */
import { readCredentials, writeCredentials, maskCredentials } from '../../../credentials';
import { requireAllowedOriginOr403 } from '../../cors';
import { invalidateMemoryClient } from '@papercusp/memory';
import { clearOpenAiEmbedHardExhaustion } from '../../../memory/configure';
import { defineTool } from '@papercusp/agent-mcp';

export default [
  defineTool({
    method: 'GET',
    path: '/credentials',
    // unverified-loopback: the desktop webview is cookie-less (EI-338) and
    // resolves as bare loopback; without it the API-keys settings page 403s.
    // Remote exposure stays blocked at boot (PAPERCUSP_BIND_HOST guard).
    auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
    async handler() {
      return Response.json(maskCredentials(await readCredentials()));
    },
  }),
  defineTool({
    method: 'POST',
    path: '/credentials',
    // unverified-loopback: the desktop webview is cookie-less (EI-338) and
    // resolves as bare loopback; without it the API-keys settings page 403s.
    // The cross-origin CSRF backstop the trust tier used to provide is restored
    // by requireAllowedOriginOr403 below (a foreign page can't write creds).
    auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
    async handler(req) {
      const csrf = requireAllowedOriginOr403(req);
      if (csrf) return csrf;
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== 'object') {
        return Response.json({ error: 'invalid body' }, { status: 400 });
      }
      const existing = await readCredentials();
      const next = { ...existing };
      for (const k of ['anthropic_api_key', 'openai_api_key', 'zeroentropy_api_key', 'github_pat'] as const) {
        if (k in body) {
          const v = (body as Record<string, unknown>)[k];
          if (typeof v === 'string') next[k] = v.trim() || undefined;
        }
      }
      const saved = await writeCredentials(next);
      // A rotated embedding/extraction key must take effect WITHOUT waiting for the mem0 client's
      // hourly TTL rebuild (cost-audit-2026-06-29 / key-rotation). The embedder + fact-extraction
      // LLM are resolved at client BUILD and the client is cached for an hour, so a key swap was
      // otherwise invisible to memory until the next rebuild. Drop the cached client now so the
      // next memory op rebuilds with the new credential — cheap (a no-network JS rebuild).
      if (
        existing.openai_api_key !== saved.openai_api_key ||
        existing.anthropic_api_key !== saved.anthropic_api_key
      ) {
        try { invalidateMemoryClient(); } catch { /* best-effort — never fail a credential write on this */ }
      }
      // WI-3615: a rotated openai_api_key is a real reason to believe embeddings might work
      // again — clear the sticky hard-exhaustion latch (see memory/configure.ts) so 'auto'
      // re-tries OpenAI once instead of staying pinned to local forever.
      if (existing.openai_api_key !== saved.openai_api_key) {
        try { clearOpenAiEmbedHardExhaustion(); } catch { /* best-effort */ }
      }
      return Response.json(maskCredentials(saved));
    },
  }),
];
