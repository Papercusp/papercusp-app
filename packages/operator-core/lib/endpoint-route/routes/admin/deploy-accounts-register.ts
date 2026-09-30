/**
 * POST /api/admin/deploy-accounts/register — register a Claude or Codex gateway credential.
 *
 * Body: { accountId, label?, provider?, value }
 *   value = either a `claude setup-token` long-lived token (`sk-ant-oat…`) → written raw and
 *           registered as `credentialRef: token:<path>`, OR a `.credentials.json` bundle (JSON with
 *           a `claudeAiOauth` block) → written as-is and registered as `credentialRef: file:<path>`.
 *
 * This is the PROVEN flow: claude.ai's authorize endpoint rejects a hand-built OAuth URL (it needs
 * claude-code's own client handshake), so the owner runs `claude setup-token` (which does that
 * handshake in their real browser) and pastes the result here. Never touches this box's ~/.claude.
 * The deploy frame-installer already consumes both `token:` and `file:` credentialRefs.
 */
import { writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { registerAccount } from '../../../deployment/account-pool';
import { updateAccountPool, accountStatus } from '../../../deployment/account-pool-store';
import { notifySyncInvalidate } from '../../../sync-sse';
import { papercuspPath } from '../../../papercusp-root';
import { requireAllowedOriginOr403 } from '../../cors';
import { defineTool } from '@papercusp/agent-mcp';

const ID_RE = /^[A-Za-z0-9._-]+$/;

export default defineTool({
  method: 'POST',
  path: '/admin/deploy-accounts/register',
  // unverified-loopback: cookie-less desktop webview (EI-338) — see credentials/index.ts.
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  async handler(req) {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    let body: { accountId?: string; label?: string; provider?: 'claude' | 'codex'; value?: string; egress?: { proxyUrl?: string; localAddress?: string } };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
    }
    const accountId = body?.accountId?.trim();
    const provider = body?.provider === 'codex' ? 'codex' : 'claude';
    const value = body?.value?.trim();
    // Optional per-account egress (per-account IP routing) — only kept if a field is set.
    const proxyUrl = body?.egress?.proxyUrl?.trim();
    const localAddress = body?.egress?.localAddress?.trim();
    const egress = proxyUrl || localAddress ? { proxyUrl: proxyUrl || undefined, localAddress: localAddress || undefined } : undefined;
    if (!accountId || !ID_RE.test(accountId)) {
      return Response.json({ ok: false, error: 'accountId required (allowed: A-Za-z0-9 . _ -)' }, { status: 400 });
    }
    if (!value) return Response.json({ ok: false, error: provider === 'codex' ? 'value required (a bearer token or env:NAME reference)' : 'value required (a sk-ant-oat… token or a .credentials.json bundle)' }, { status: 400 });

    try {
      let credentialRef: string;
      // A token pasted from a terminal can carry an EMBEDDED newline (line wrap) that `trim()`
      // cannot see — written raw it corrupts the credential file and every gateway request on the
      // account dies with `Headers.append: invalid header value` (WI-1919, 2026-07-03: three pool
      // accounts never served a request). A bearer's alphabet has no whitespace, so collapsing ALL
      // of it reconstructs the intended token. Bundles (JSON) are left untouched.
      const tokenValue = value.replace(/\s+/g, '');
      if (provider === 'claude') {
        // Discriminate: a setup-token (token:) vs a pasted .credentials.json bundle (file:).
        const isBundle = value.startsWith('{');
        if (isBundle) {
          try {
            const parsed = JSON.parse(value);
            if (!parsed?.claudeAiOauth?.accessToken) {
              return Response.json({ ok: false, error: 'bundle has no claudeAiOauth.accessToken' }, { status: 400 });
            }
          } catch {
            return Response.json({ ok: false, error: 'value looked like JSON but failed to parse' }, { status: 400 });
          }
        } else if (!tokenValue.startsWith('sk-ant-oat')) {
          // A `code#state` paste is the OAuth authorization CODE from claude.ai's callback page —
          // owners land here when the one-click flow showed them a code and they reach for the
          // manual tab instead (2026-07-03). Name the mistake precisely; a code is useless here
          // (its PKCE verifier lives in the CLI process that requested it).
          const looksLikeOAuthCode = /^[A-Za-z0-9_-]{20,}#[A-Za-z0-9_-]{20,}$/.test(value);
          return Response.json(
            {
              ok: false,
              error: looksLikeOAuthCode
                ? 'that looks like the OAuth code from claude.ai (code#state), not a token — paste it in the browser-login flow’s "code" box (step 3) instead. To use THIS tab, run `claude setup-token` and paste the sk-ant-oat… token it mints.'
                : 'value must be a setup-token (sk-ant-oat…) or a .credentials.json bundle ({…})',
            },
            { status: 400 },
          );
        }
        const fileName = isBundle ? `${accountId}.credentials.json` : accountId;
        const credPath = papercuspPath('deploy-credentials', fileName);
        await mkdir(dirname(credPath), { recursive: true });
        await writeFile(credPath, isBundle ? value : tokenValue, { mode: 0o600 });
        await chmod(credPath, 0o600);
        credentialRef = `${isBundle ? 'file' : 'token'}:${credPath}`;
      } else if (value.startsWith('env:')) {
        credentialRef = value;
      } else {
        const credPath = papercuspPath('deploy-credentials', `${accountId}.codex`);
        await mkdir(dirname(credPath), { recursive: true });
        await writeFile(credPath, tokenValue, { mode: 0o600 });
        await chmod(credPath, 0o600);
        credentialRef = `token:${credPath}`;
      }
      await updateAccountPool((p) =>
        registerAccount(p, { id: accountId, provider, credentialRef, label: body.label?.trim() || undefined, egress }, Date.now()),
      );
      const account = (await accountStatus()).find((a) => a.id === accountId) ?? null;
      // Live UI reflection — the Accounts tab reads the accounts.pool sync query.
      void notifySyncInvalidate('accounts.pool', {}).catch(() => {});
      return Response.json({ ok: true, account });
    } catch (err) {
      return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
    }
  },
});
