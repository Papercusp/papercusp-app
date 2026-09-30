/**
 * Claude (Anthropic subscription) OAuth credential bundle — the `~/.claude/.credentials.json`
 * file the `claude` CLI maintains — plus the `grant_type=refresh_token` exchange that revives
 * a REJECTED access token in place.
 *
 * WHY THIS LIVES IN papercusp-shared (WI-38316): the stateless `anthropic-direct` transport
 * in `chat-stream.ts` is the hot path for every in-process LLM call (llm-testing judge +
 * sim-user, summarisers, scout ideators, benches) and it read ONLY `accessToken` + `expiresAt`.
 * When Anthropic rejects an access token that is still locally unexpired — a token revoked or
 * rotated out from under us — the EI-281 retry re-read the same unchanged file, found the same
 * token, and surfaced a hard non-retryable 401. The refresh token sitting in the very same
 * bundle was never tried. Measured 2026-08-12: that took out every llm-testing caller on the
 * host for ~3.5 minutes until an external refresher happened to rewrite the file, and the
 * diagnosis cost far more than the outage.
 *
 * `packages/operator-core/lib/oauth/providers.ts` (the hive gateway's credential refresher)
 * already implements this exchange, but operator-core is DOWNSTREAM of this lib — importing it
 * here would invert the dependency. So the constants + the exchange live here, at the leaf, and
 * providers.ts re-exports them: ONE definition, which is what EI-553 (endpoints moved and the
 * stale copies kept authenticating against a dead host) argues for.
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The well-known PUBLIC Claude Code OAuth client (PKCE; no client secret) — the same client id
 * the `claude` CLI uses. A refresh token minted under it can ONLY be refreshed under it
 * (Anthropic binds the refresh grant to the minting client_id).
 *
 * EI-553 (2026-07-17): the pre-2026-07 defaults (`claude.ai/oauth/authorize` +
 * `console.anthropic.com/...`) were STALE — claude-code moved to `claude.com/cai` +
 * `platform.claude.com`. Re-verified directly against the live `claude` CLI (v2.1.212) by
 * extracting its own bundled OAuth config object (`Bol` in the minified CLI — `strings` + a
 * bounded-context scan of the binary, no live auth flow needed):
 *   `CLAUDE_AI_AUTHORIZE_URL: "https://claude.com/cai/oauth/authorize"`,
 *   `TOKEN_URL: "https://platform.claude.com/v1/oauth/token"`,
 *   `MANUAL_REDIRECT_URL: "https://platform.claude.com/oauth/code/callback"`,
 *   `CLIENT_ID: "9d1c250a-e61b-44d9-88ed-5944d1962f5e"` (unchanged — confirms this is still
 *   the same client_id/PKCE flow, just re-hosted).
 * (There's a SEPARATE `CONSOLE_AUTHORIZE_URL: "https://platform.claude.com/oauth/authorize"`
 * in the same CLI config — that's the API-console / API-key-creation flow, a different client;
 * CLAUDE_AI_AUTHORIZE_URL is the one behind `claude setup-token`'s Max/Pro subscription login.)
 *
 * Endpoints stay env-overridable (`CLAUDE_OAUTH_TOKEN_URL` / `CLAUDE_OAUTH_CLIENT_ID`) so the
 * next re-host is a config change, not a code change.
 */
export const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

export const CLAUDE_OAUTH_DEFAULTS = {
  clientId: CLAUDE_CODE_CLIENT_ID,
  /** claude.com/cai issues the auth code for a Max/Pro subscription login (EI-553)… */
  authorizeUrl: 'https://claude.com/cai/oauth/authorize',
  /** …and platform.claude.com exchanges + refreshes it (form-encoded; JSON bodies can time out). */
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  redirectUri: 'https://platform.claude.com/oauth/code/callback',
  scopes: ['org:create_api_key', 'user:profile', 'user:inference'] as const,
} as const;

/** The `claudeAiOauth` block inside a `.credentials.json` bundle. Unknown keys are preserved
 *  verbatim on write — the CLI stores `scopes`/`subscriptionType`/`rateLimitTier` here too. */
export interface ClaudeOauthBlock {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  [key: string]: unknown;
}

export interface ClaudeCredentialBundle {
  claudeAiOauth?: ClaudeOauthBlock;
  [key: string]: unknown;
}

/** Default bundle location. Mirrors chat-stream's existing resolution exactly. */
export function claudeCredentialsPath(): string {
  return join(homedir(), '.claude', '.credentials.json');
}

export function readClaudeCredentialBundle(path = claudeCredentialsPath()): ClaudeCredentialBundle | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ClaudeCredentialBundle;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export type ClaudeRefreshOutcome =
  | {
      ok: true;
      accessToken: string;
      expiresAt: number | null;
      /** true = another writer (the `claude` CLI, a peer process) had ALREADY replaced the
       *  rejected token on disk, so no exchange was issued and no refresh token was burned. */
      adopted: boolean;
    }
  | {
      ok: false;
      reason: 'no-bundle' | 'no-refresh-token' | 'refresh-token-expired' | 'exchange-failed';
      detail?: string;
    };

/** One in-flight refresh per bundle path per process — 10 concurrent judge calls hitting the
 *  same dead token must issue ONE exchange, not ten. Anthropic ROTATES the refresh token on
 *  every use, so a storm would invalidate its own successors and fail most of them. */
const inFlight = new Map<string, Promise<ClaudeRefreshOutcome>>();

export interface RefreshClaudeOauthOpts {
  /** The access token that was just REJECTED. If the on-disk bundle no longer carries it,
   *  someone else already refreshed and we adopt their token instead of burning ours. */
  rejectedAccessToken?: string;
  path?: string;
  clientId?: string;
  tokenUrl?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Exchange the bundle's refresh token for a new access token and persist it in place.
 *
 * Never throws — every failure is a typed `ok: false` outcome, because the caller is already
 * on an error path and a throw here would mask the original 401. Writes are atomic
 * (temp file + rename, 0600) and preserve every other field in the bundle: this file is the
 * live credential for the owner's own `claude` sessions and every agent on the box, so a
 * partial write is far worse than a failed refresh.
 */
export function refreshClaudeOauthCredential(opts: RefreshClaudeOauthOpts = {}): Promise<ClaudeRefreshOutcome> {
  const path = opts.path ?? claudeCredentialsPath();
  const existing = inFlight.get(path);
  if (existing) return existing;
  const p = doRefresh(path, opts).finally(() => {
    inFlight.delete(path);
  });
  inFlight.set(path, p);
  return p;
}

async function doRefresh(path: string, opts: RefreshClaudeOauthOpts): Promise<ClaudeRefreshOutcome> {
  const now = opts.now ?? Date.now;
  const bundle = readClaudeCredentialBundle(path);
  const block = bundle?.claudeAiOauth;
  if (!bundle || !block) return { ok: false, reason: 'no-bundle', detail: path };

  // Someone else already rotated it — adopt, don't refresh. This is the multi-process guard:
  // the box runs many agents against ONE bundle, and a refresh token is single-use.
  if (opts.rejectedAccessToken && block.accessToken && block.accessToken !== opts.rejectedAccessToken) {
    return { ok: true, accessToken: block.accessToken, expiresAt: block.expiresAt ?? null, adopted: true };
  }

  const refreshToken = typeof block.refreshToken === 'string' ? block.refreshToken.trim() : '';
  if (!refreshToken) return { ok: false, reason: 'no-refresh-token' };
  if (typeof block.refreshTokenExpiresAt === 'number' && block.refreshTokenExpiresAt <= now()) {
    return {
      ok: false,
      reason: 'refresh-token-expired',
      detail: new Date(block.refreshTokenExpiresAt).toISOString(),
    };
  }

  const doFetch = opts.fetchImpl ?? fetch;
  const tokenUrl = opts.tokenUrl ?? process.env.CLAUDE_OAUTH_TOKEN_URL ?? CLAUDE_OAUTH_DEFAULTS.tokenUrl;
  const clientId = opts.clientId ?? process.env.CLAUDE_OAUTH_CLIENT_ID ?? CLAUDE_OAUTH_DEFAULTS.clientId;

  let json: { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  try {
    const res = await doFetch(tokenUrl, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
    });
    json = (await res.json().catch(() => ({}))) as typeof json;
    if (!res.ok && !json.error) return { ok: false, reason: 'exchange-failed', detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: 'exchange-failed', detail: err instanceof Error ? err.message : String(err) };
  }

  if (json.error || !json.access_token) {
    return { ok: false, reason: 'exchange-failed', detail: json.error_description ?? json.error ?? 'no access_token in response' };
  }

  const expiresAt = json.expires_in ? now() + json.expires_in * 1000 : null;
  // Re-read immediately before writing so a concurrent writer's OTHER fields survive, then
  // overwrite only the three token fields we just minted. Anthropic rotates the refresh token
  // on use; fall back to the old one only when the response omits a replacement, so we never
  // persist an empty refresh token.
  const latest = readClaudeCredentialBundle(path) ?? bundle;
  const merged: ClaudeCredentialBundle = {
    ...latest,
    claudeAiOauth: {
      ...(latest.claudeAiOauth ?? block),
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? refreshToken,
      ...(expiresAt !== null ? { expiresAt } : {}),
    },
  };

  const wrote = writeBundleAtomically(path, merged);
  if (!wrote.ok) return { ok: false, reason: 'exchange-failed', detail: `minted a token but could not persist it: ${wrote.detail}` };
  return { ok: true, accessToken: json.access_token, expiresAt, adopted: false };
}

function writeBundleAtomically(path: string, bundle: ClaudeCredentialBundle): { ok: true } | { ok: false; detail: string } {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    return { ok: true };
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The human-readable half of the fix: an auth rejection whose credential is locally VALID is
 * the confusing case, because every local check (expiry, file present, file fresh) passes. Say
 * that out loud, with the refresh attempt's own verdict, instead of a bare `401 {...}` that
 * reads like a misconfiguration.
 */
export function describeClaudeAuthFailure(args: {
  expiresAt: number | null;
  refreshOutcome?: ClaudeRefreshOutcome;
  now?: number;
}): string {
  const now = args.now ?? Date.now();
  const parts: string[] = [];
  if (args.expiresAt !== null && args.expiresAt > now) {
    const hours = ((args.expiresAt - now) / 3_600_000).toFixed(1);
    parts.push(
      `the local Claude OAuth credential is NOT expired (expires ${new Date(args.expiresAt).toISOString()}, ` +
        `${hours}h from now) — it was rejected UPSTREAM, i.e. revoked or rotated out from under this host`,
    );
  } else if (args.expiresAt !== null) {
    parts.push(`the local Claude OAuth credential expired at ${new Date(args.expiresAt).toISOString()}`);
  }

  const o = args.refreshOutcome;
  if (o?.ok) {
    parts.push(o.adopted ? 'a peer had already rotated the on-disk token' : 'the refresh-token exchange succeeded');
  } else if (o) {
    const why =
      o.reason === 'no-refresh-token'
        ? 'the bundle carries no refresh token'
        : o.reason === 'refresh-token-expired'
          ? `the refresh token itself expired (${o.detail})`
          : o.reason === 'no-bundle'
            ? `no readable credential bundle at ${o.detail}`
            : `the exchange failed (${o.detail})`;
    parts.push(`an automatic refresh was attempted and did NOT recover it: ${why}`);
  }

  parts.push(
    're-authenticate the Claude session (`claude` CLI login) to restore it; ' +
      'LLM_TEST_BACKEND=claude-code routes llm-testing/bench callers through the CLI\'s separate auth path meanwhile',
  );
  return ` [${parts.join('; ')} — WI-38316]`;
}
