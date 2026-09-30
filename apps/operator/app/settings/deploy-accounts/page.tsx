'use client';

import { useCallback, useEffect, useState } from 'react';
import { useQueryState, parseAsBoolean, parseAsString } from 'nuqs';
import { toast } from 'sonner';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';
import { Tooltip } from '@/app/harness/Tooltip';
import { KeyRound, Plus, Star, Trash2 } from 'lucide-react';
import {
  formatResetIn,
  isActiveAccount,
  setupTokenCommand,
  utilizationTone,
  type PoolHeadroom,
} from './headroom';

/**
 * Inference settings — the provider-account pool used by the inference
 * gateway. Claude Max accounts back Anthropic-compatible fleet egress and
 * deploy credentials; Codex accounts back OpenAI-compatible Codex account pins.
 * Link one by minting or referencing the provider credential.
 *
 * ⚠ Named "Deploy accounts" until inference-rename-and-provider-agnostic-default-2026-08-09
 * P-001 relabelled it to "Inference". That rename was VISIBLE STRINGS ONLY (D-003): the route
 * is still /settings/deploy-accounts and the API is still /api/admin/deploy-accounts/*, so a
 * search for either name has to find this file.
 *
 * Why paste-a-token (not an in-app OAuth redirect): claude.ai's authorize endpoint rejects a
 * hand-built URL (it needs claude-code's own client handshake), so the owner runs
 * `claude setup-token` — which does that handshake in their real browser — and pastes the result.
 * Accepts a `sk-ant-oat…` setup-token (→ token:) or a `.credentials.json` bundle (→ file:).
 * Never touches this box's ~/.claude. Backed by /api/admin/deploy-accounts{,/register,/remove}.
 *
 * Live utilization comes from /api/admin/inference-gateway/stats when the gateway reports its
 * current route, and falls back to each account row's last observed provider-limit projection.
 *
 * Lives under /settings/deploy-accounts (moved here from the /admin tabs). The
 * /settings layout supplies the chrome, so this page renders bare content.
 */
interface AccountRow {
  id: string;
  provider?: 'claude' | 'codex';
  label?: string;
  credentialRef: string;
  boundTo: string[];
  available: boolean;
  sustainedlyLimited: boolean;
  rate: { pausedUntil: number; penaltyCount: number; utilization?: number; windowResetAt?: number };
}

type AccountProvider = NonNullable<AccountRow['provider']>;

function accountProvider(row: Pick<AccountRow, 'provider'>): AccountProvider {
  return row.provider === 'codex' ? 'codex' : 'claude';
}

function providerLabel(provider: AccountProvider): string {
  return provider === 'codex' ? 'Codex' : 'Claude';
}

function providerCredentialHint(provider: AccountProvider): string {
  return provider === 'codex'
    ? 'Codex accounts use a bearer token or env:NAME reference for the OpenAI-compatible gateway route.'
    : 'Claude accounts use a setup-token or .credentials.json bundle minted by claude setup-token.';
}

export default function DeployAccountsPage() {
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [headroom, setHeadroom] = useState<PoolHeadroom | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  // undefined = not read yet, null = no default (this box's own ~/.claude login), string = an
  // account id. The three states are distinct on purpose: rendering "using the local login"
  // before the read lands would state the opposite of the truth for a moment.
  const [defaultAccountId, setDefaultAccountId] = useState<string | null | undefined>(undefined);
  const [defaultBusy, setDefaultBusy] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useQueryState('add', parseAsBoolean.withDefault(false));
  const [accountId, setAccountId] = useQueryState('id', parseAsString.withDefault(''));
  const [label, setLabel] = useQueryState('label', parseAsString.withDefault(''));

  const [value, setValue] = useState(''); // the pasted token / bundle — secret, useState only
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Link mode (accounts-pool-tab-2026-06-15 P-002): "oauth" = click a link → authorize in the
  // browser → paste the code (the link-start/link-complete round-trip); "token" = the proven
  // `claude setup-token` paste. OAuth is the default the owner reaches for; it's experimental
  // because claude.ai may reject a server-built authorize URL (D-005) — the token flow always works.
  // Default to the one-click browser login. It now runs the REAL `claude setup-token` CLI
  // server-side (account-link-cli.ts) and relays its link, so claude.ai accepts it (the CLI does
  // the client handshake a hand-built URL can't — accounts-pool-tab D-016). The setup-token paste
  // tab stays as the manual fallback.
  const [linkMode, setLinkMode] = useState<'oauth' | 'token'>('oauth');
  const [provider, setProvider] = useState<'claude' | 'codex'>('claude');
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [linkId, setLinkId] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [code, setCode] = useState('');

  const refresh = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const r = await fetch('/api/admin/deploy-accounts');
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'failed to load accounts');
      setAccounts(j.accounts ?? []);
    } catch (e) {
      setListError((e as Error).message);
    } finally {
      setLoadingList(false);
    }
    // Live rate-headroom is best-effort: a gateway-off / unreachable read just
    // hides the utilization, it never blocks or errors the account list.
    try {
      const r = await fetch('/api/admin/inference-gateway/stats');
      const j = await r.json();
      setHeadroom(j?.ok ? (j.gateway as PoolHeadroom) : null);
    } catch {
      setHeadroom(null);
    }
    // Which account (if any) stands in for this box's ~/.claude login. Best-effort for the
    // same reason as headroom: failing to read the steer must not blank the account list.
    // null is a real value here ("no default — the local login"), so the unknown case is
    // deliberately left as-is rather than being coerced to null.
    try {
      const r = await fetch('/api/admin/deploy-accounts/session-override');
      const j = await r.json();
      if (j?.ok) setDefaultAccountId(j.override?.defaultAccountId ?? null);
    } catch {
      /* leave the last known value */
    }
  }, []);

  /**
   * Nominate (or, with null, clear) the default account. The server validates against the
   * pool and 400s a bad pick, so the error surfaced here is the server's own reason rather
   * than a guess. Refreshes rather than patching state locally: the write can change more
   * than this one field (clearing a default is also what the override-reset concern does).
   */
  const setDefault = useCallback(
    async (id: string | null) => {
      setDefaultBusy(id ?? '__clear__');
      try {
        const r = await fetch('/api/admin/deploy-accounts/session-override', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ defaultAccountId: id }),
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'failed to set the default account');
        setDefaultAccountId(j.override?.defaultAccountId ?? null);
        toast.success(
          id ? `${id} is now the default account` : "Default cleared — using this machine's own Claude login",
        );
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setDefaultBusy(null);
      }
    },
    [],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resetForm = useCallback(() => {
    setAddOpen(false);
    setAccountId('');
    setLabel('');
    setValue('');
    setAddError(null);
    setAuthorizeUrl(null);
    setLinkId(null);
    setUserCode(null);
    setCode('');
    setProvider('claude');
  }, [setAddOpen, setAccountId, setLabel]);

  const register = useCallback(async () => {
    setAddError(null);
    if (!/^[A-Za-z0-9._-]+$/.test(accountId)) {
      setAddError('Account ID must be A-Za-z0-9 . _ - (no spaces, no : or @).');
      return;
    }
    if (!value.trim()) {
      setAddError(provider === 'codex' ? 'Paste a Codex/OpenAI bearer token or env:NAME reference.' : 'Paste a setup-token (sk-ant-oat…) or a .credentials.json bundle.');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/admin/deploy-accounts/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId, label: label || undefined, provider, value: value.trim() }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'register failed');
      resetForm();
      // Explicit success signal — the form reset alone is ambiguous if the
      // follow-up list refresh fails (refresh surfaces its own listError).
      toast.success(`${providerLabel(provider)} account "${accountId}" linked`);
      await refresh();
    } catch (e) {
      setAddError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [accountId, label, provider, value, resetForm, refresh]);

  // OAuth mode step A: start the provider CLI and capture its browser-login URL.
  const startOAuth = useCallback(async () => {
    setAddError(null);
    if (!/^[A-Za-z0-9._-]+$/.test(accountId)) {
      setAddError('Account ID must be A-Za-z0-9 . _ - (no spaces, no : or @).');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/admin/deploy-accounts/link-start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId, label: label || undefined, provider }),
      });
      const j = await r.json();
      if (r.status === 404) throw new Error('OAuth linking isn’t available on this build yet — use “Paste a setup-token”.');
      if (!j.ok || !j.authorizeUrl || !j.linkId) throw new Error(j.error || 'could not start the OAuth link');
      setAuthorizeUrl(j.authorizeUrl as string);
      setLinkId(j.linkId as string);
      setUserCode(typeof j.userCode === 'string' ? j.userCode : null);
    } catch (e) {
      setAddError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [accountId, label, provider]);

  // While a claude OAuth link is held open, poll its server-side status: claude CLI ≥2.1.200
  // runs a localhost callback listener, so a SAME-MACHINE browser approval delivers the code
  // straight to the CLI ("You're all set up … close this window" — no code shown) and the server
  // auto-finalizes. Without this poll that path looked like "nothing happened" (2026-07-03).
  useEffect(() => {
    if (!linkId || !authorizeUrl || provider !== 'claude') return;
    let stopped = false;
    const tick = async () => {
      try {
        const r = await fetch('/api/admin/deploy-accounts/link-status', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ linkId }),
        });
        if (r.status === 404) return; // older build without the route — paste flow still works
        const j = await r.json();
        if (stopped || !j?.ok) return;
        if (j.status === 'completed') {
          stopped = true;
          resetForm();
          toast.success(`Claude account "${accountId}" linked via browser login`);
          await refresh();
        } else if (j.status === 'failed') {
          stopped = true;
          setAddError(j.error || 'link failed');
        }
      } catch {
        /* transient — next tick retries */
      }
    };
    const h = setInterval(() => void tick(), 2500);
    return () => {
      stopped = true;
      clearInterval(h);
    };
  }, [linkId, authorizeUrl, provider, accountId, resetForm, refresh]);

  // OAuth mode step B: finish the held provider CLI and register the server-side credential.
  const completeOAuth = useCallback(async () => {
    setAddError(null);
    if (!linkId) {
      setAddError('Generate the authorize link first.');
      return;
    }
    if (provider === 'claude' && !code.trim()) {
      setAddError(
        'Paste the code claude.ai showed you after you approved. (If claude said "You\'re all set up" with no code, the link completes automatically — give it a few seconds.)',
      );
      return;
    }
    setBusy(true);
    try {
      const r = await fetch('/api/admin/deploy-accounts/link-complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ linkId, ...(code.trim() ? { code: code.trim() } : {}) }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'link failed');
      resetForm();
      toast.success(`${providerLabel(provider)} account "${accountId}" linked via browser login`);
      await refresh();
    } catch (e) {
      setAddError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [linkId, code, provider, accountId, resetForm, refresh]);

  const remove = useCallback(
    async (id: string) => {
      const ok = await askConfirm({
        title: 'Remove account',
        body: `Remove account "${id}" from the pool? The credential file is left in place.`,
        confirmLabel: 'Remove',
        destructive: true,
      });
      if (!ok) return;
      await fetch('/api/admin/deploy-accounts/remove', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      await refresh();
    },
    [askConfirm, refresh],
  );

  const command = setupTokenCommand(accountId);
  const activeLinkMode = linkMode;
  const oauthProviderName = providerLabel(provider);
  const copyCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the command is visible to copy by hand */
    }
  }, [command]);

  const primaryAction =
    activeLinkMode === 'oauth'
      ? authorizeUrl
        ? completeOAuth
        : startOAuth
      : register;
  const primaryLabel =
    activeLinkMode === 'oauth'
      ? authorizeUrl
        ? busy ? 'Linking...' : 'Complete link'
        : busy ? 'Generating...' : 'Get authorize link'
      : busy ? 'Linking...' : 'Link account';
  const primaryDisabled =
    busy ||
    !accountId ||
    (activeLinkMode === 'oauth'
      ? authorizeUrl
        ? provider === 'claude' && !code.trim()
        : false
      : !value.trim());
  const formStatus = addError
    ? 'Resolve the error before continuing.'
    : busy
      ? 'Saving changes...'
      : activeLinkMode === 'oauth'
        ? authorizeUrl
          ? provider === 'codex'
            ? 'Enter the device code in the browser, then complete the link.'
            : code.trim()
              ? 'Ready to complete the link.'
              : 'Paste the approval code to continue.'
          : accountId
            ? `Ready to start the ${oauthProviderName} browser login.`
            : 'Enter an account ID to continue.'
        : value.trim()
          ? 'Ready to link this account.'
          : provider === 'codex' ? 'Paste a bearer token or env reference to continue.' : 'Paste a setup-token or credentials bundle to continue.';
  const providerCounts = accounts.reduce(
    (acc, account) => {
      acc[accountProvider(account)] += 1;
      return acc;
    },
    { claude: 0, codex: 0 } as Record<AccountProvider, number>,
  );
  const constrainedCount = accounts.filter((account) => (
    account.sustainedlyLimited || account.rate.pausedUntil > Date.now()
  )).length;
  const activeAccount = headroom?.reachable && headroom.accountId
    ? accounts.find((account) => account.id === headroom.accountId)
    : null;
  const activeRouteLabel = activeAccount?.id ?? 'none';
  const gridHeight = Math.min(560, 34 + accounts.length * 46 + 4);

  return (
    <div className="pc-da">
      {confirmEl}
      <header className="pc-da__hero">
        <div className="pc-da__hero-copy">
          <h1>Inference</h1>
          <div className="pc-da__meta-line" aria-label="Inference account pool summary">
            <span>{accounts.length} accounts</span>
            <span>{providerCounts.claude} Claude / {providerCounts.codex} Codex</span>
            <span>active {activeRouteLabel}</span>
            <span>{Math.max(0, accounts.length - constrainedCount)} ok</span>
            <span>{constrainedCount} limited</span>
          </div>
        </div>
        {!addOpen && (
          <button className="pc-da__btn pc-da__btn--primary pc-da__hero-action" onClick={() => setAddOpen(true)}>
            <Plus size={15} aria-hidden="true" />
            <span>Link account</span>
          </button>
        )}
      </header>

      {addOpen && (
        <div className="pc-da__wizard">
          <div className="pc-da__wizard-head">
            <strong>Link an account</strong>
            <button className="pc-da__btn pc-da__btn--ghost" onClick={resetForm}>
              Cancel
            </button>
          </div>

          <div className="pc-da__modes" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={provider === 'claude'}
              className={`pc-da__mode${provider === 'claude' ? ' is-active' : ''}`}
              onClick={() => {
                setProvider('claude');
                setAddError(null);
                setValue('');
                setAuthorizeUrl(null);
                setLinkId(null);
                setUserCode(null);
                setCode('');
              }}
            >
              Claude
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={provider === 'codex'}
              className={`pc-da__mode${provider === 'codex' ? ' is-active' : ''}`}
              onClick={() => {
                setProvider('codex');
                setLinkMode('oauth');
                setAuthorizeUrl(null);
                setLinkId(null);
                setUserCode(null);
                setCode('');
                setValue('');
                setAddError(null);
              }}
            >
              Codex
            </button>
          </div>

          <div className="pc-da__modes" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={linkMode === 'oauth'}
              className={`pc-da__mode${linkMode === 'oauth' ? ' is-active' : ''}`}
              onClick={() => {
                setLinkMode('oauth');
                setAddError(null);
              }}
            >
              🔗 One-click (browser login)
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={linkMode === 'token'}
              className={`pc-da__mode${linkMode === 'token' ? ' is-active' : ''}`}
              onClick={() => {
                setLinkMode('token');
                setAddError(null);
              }}
            >
              {provider === 'codex' ? 'Paste a bearer token' : 'Paste a setup-token'}
            </button>
          </div>

          <label className="pc-da__field">
            <span>1 · Account ID</span>
            <input value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="e.g. machine-2 or acct-10" />
          </label>
          <label className="pc-da__field">
            <span>Label (optional)</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Hetzner NYC" />
          </label>

          {activeLinkMode === 'oauth' ? (
            !authorizeUrl ? (
              <div className="pc-da__step">
                <p className="pc-da__step-hint">
                  {provider === 'codex' ? (
                    <>
                      2 · We'll start a Codex device login for this account and show you the OpenAI device code.
                      Open the link signed in as the <strong>target ChatGPT/Codex account</strong>, enter the code,
                      then complete the link. The credential is written server-side and never returned to the browser.
                    </>
                  ) : (
                    <>
                      2 · We'll start a Claude login for this account and give you a link (this runs the real{' '}
                      <code>claude setup-token</code> handshake on the server, so claude.ai accepts it). Open the link signed in
                      as the <strong>TARGET Max account</strong> and approve. If claude shows a code, paste it below; if it says
                      <em> "You're all set up — you can close this window"</em> (no code), the link completes automatically —
                      just come back here. The token is written server-side and never returned to the browser.
                    </>
                  )}
                </p>
              </div>
            ) : (
              <>
                <div className="pc-da__step">
                  <span className="pc-da__step-label">
                    2 · Open &amp; approve (signed in as the target {provider === 'codex' ? 'Codex account' : 'Max account'})
                  </span>
                  <div className="pc-da__cmd">
                    <a className="pc-da__authlink" href={authorizeUrl} target="_blank" rel="noreferrer">
                      ↗ open the {provider === 'codex' ? 'OpenAI device login page' : 'claude.ai authorize page'}
                    </a>
                    <button
                      type="button"
                      className="pc-da__btn pc-da__btn--ghost pc-da__copy"
                      onClick={() => void navigator.clipboard?.writeText(authorizeUrl)}
                    >
                      Copy link
                    </button>
                  </div>
                  {provider === 'codex' && userCode && (
                    <div className="pc-da__cmd">
                      <code>{userCode}</code>
                      <button
                        type="button"
                        className="pc-da__btn pc-da__btn--ghost pc-da__copy"
                        onClick={() => void navigator.clipboard?.writeText(userCode)}
                      >
                        Copy code
                      </button>
                    </div>
                  )}
                </div>
                {provider === 'claude' ? (
                  <label className="pc-da__field">
                    <span>3 · Paste the code claude.ai shows you</span>
                    <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="code#state" />
                    <p className="pc-da__step-hint">
                      No code? If claude said <em>"You're all set up"</em>, the link is completing automatically — this dialog
                      closes itself within a few seconds.
                    </p>
                  </label>
                ) : (
                  <div className="pc-da__step">
                    <span className="pc-da__step-label">3 · Complete after the browser confirms login</span>
                    <p className="pc-da__step-hint">
                      Codex polls the device login in the held CLI process. When the browser says the login is complete, click Complete link.
                    </p>
                  </div>
                )}
              </>
            )
          ) : (
            <>
              <div className="pc-da__step">
                {provider === 'claude' ? (
                  <>
                    <span className="pc-da__step-label">2 · Mint a token for it</span>
                    <p className="pc-da__step-hint">
                      On a machine where you can sign in as that account, run this — the isolated config dir keeps the mint
                      off this box's own login:
                    </p>
                    <div className="pc-da__cmd">
                      <code>{command}</code>
                      <button type="button" className="pc-da__btn pc-da__btn--ghost pc-da__copy" onClick={() => void copyCommand()}>
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <p className="pc-da__step-hint">
                      Sign in as the target account in the browser it opens; it prints a token (<code>sk-ant-oat…</code>).
                    </p>
                  </>
                ) : (
                  <>
                    <span className="pc-da__step-label">2 · Add bearer credential</span>
                    <p className="pc-da__step-hint">
                      Paste a Codex/OpenAI bearer token, or enter <code>env:NAME</code> to reference a server environment variable.
                    </p>
                  </>
                )}
              </div>
              <label className="pc-da__field">
                <span>{provider === 'codex' ? '3 · Paste the bearer token or env reference' : '3 · Paste the token (or a .credentials.json bundle)'}</span>
                <textarea value={value} onChange={(e) => setValue(e.target.value)} rows={3} placeholder={provider === 'codex' ? 'sk-…   or   env:OPENAI_API_KEY' : 'sk-ant-oat01-…   or   {&quot;claudeAiOauth&quot;:{…}}'} />
                <small>{providerCredentialHint(provider)}</small>
              </label>
            </>
          )}
          {addError && <p className="pc-da__error">⚠ {addError}</p>}
          <div className="pc-da__save-row">
            <span className="pc-da__save-status" aria-live="polite">{formStatus}</span>
            <div className="pc-da__save-actions">
              <button type="button" className="pc-da__btn pc-da__btn--ghost" onClick={resetForm}>
                Cancel
              </button>
              <button className="pc-da__btn pc-da__btn--primary" disabled={primaryDisabled} onClick={() => void primaryAction()}>
                {primaryLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* State the account that is actually in force, always — the commonest question this
          page has to answer is "which one is being used right now", and before the default
          existed the honest answer ("this box's own login") was nowhere on the page. */}
      {defaultAccountId !== undefined && (
        <div className="pc-da__default-banner" role="status">
          <Star size={13} aria-hidden="true" fill={defaultAccountId ? 'currentColor' : 'none'} />
          {defaultAccountId ? (
            // Provider-aware since P-003: a Codex default fronts Codex traffic only, so the
            // Claude-shaped promise ("judges and summarisers start here") would be false for it.
            accounts.find((a) => a.id === defaultAccountId && accountProvider(a) === 'codex') ? (
              <span>
                Default Codex account: <strong className="pc-da__mono">{defaultAccountId}</strong> —
                Codex/OpenAI work starts here and fails over to the rest of the Codex pool. Anthropic
                traffic is unaffected; set a Claude account as default to steer that too.
              </span>
            ) : (
              <span>
                Default account: <strong className="pc-da__mono">{defaultAccountId}</strong> — agents,
                the operator brain, judges and summarisers start here and fail over to the rest of the
                pool.
              </span>
            )
          ) : (
            <span>
              No default account — everything falls back to this machine&rsquo;s own Claude login
              (<code className="pc-da__mono">~/.claude</code>). Set one below to use a pool account
              instead.
            </span>
          )}
          {defaultAccountId && (
            <button
              type="button"
              className="pc-da__btn pc-da__btn--ghost"
              disabled={defaultBusy !== null}
              onClick={() => setDefault(null)}
            >
              Clear
            </button>
          )}
        </div>
      )}

      <div className="pc-da__list">
        {loadingList && <p className="pc-da__muted">Loading…</p>}
        {listError && <p className="pc-da__error">⚠ {listError}</p>}
        {!loadingList && !listError && accounts.length === 0 && (
          <div className="pc-da__empty">
            <KeyRound size={18} aria-hidden="true" />
            <p>No accounts in the pool yet. Link one to grow the fleet's aggregate capacity.</p>
          </div>
        )}
        {accounts.length > 0 && (
          <>
            <div className="pc-da__grid-shell">
              <div className="pc-da__grid" style={{ height: gridHeight }}>
                <RichGrid<AccountRow>
                  columns={accountColumns(headroom, remove, defaultAccountId, defaultBusy, setDefault)}
                  rows={accounts}
                  getRowId={(a) => a.id}
                  rowMinHeight={46}
                  headerHeight={34}
                />
              </div>
            </div>
            <div className="pc-da__cards" aria-label="Inference accounts">
              {accounts.map((account) => (
                <AccountCard
                  key={account.id}
                  account={account}
                  headroom={headroom}
                  remove={remove}
                  defaultAccountId={defaultAccountId}
                  defaultBusy={defaultBusy}
                  setDefault={setDefault}
                />
              ))}
            </div>
          </>
        )}
      </div>

      <style>{`
        .pc-da { container-type: inline-size; display: grid; gap: 6px; min-width: 0; color: var(--fg); }
        .pc-da__hero { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px; padding-bottom: 7px; border-bottom: 1px solid color-mix(in srgb, var(--border), white 8%); }
        .pc-da__hero-copy { display: grid; gap: 4px; min-width: 0; }
        .pc-da__default-banner { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 6px 9px; border: 1px solid color-mix(in srgb, var(--border), white 6%); border-radius: 8px; background: color-mix(in srgb, var(--bg-2), transparent 20%); color: var(--fg-mute); font-size: 11.5px; line-height: 1.35; }
        .pc-da__default-banner strong { color: var(--fg); font-weight: 600; }
        .pc-da__default-banner > button { margin-left: auto; }
        .pc-da__btn--default-on { color: var(--accent-ink, var(--fg)); background: color-mix(in srgb, var(--accent), transparent 72%); border-color: color-mix(in srgb, var(--accent), transparent 40%); }
        .pc-da h1 { margin: 0; font-size: clamp(21px, 2.6vw, 29px); line-height: 1; letter-spacing: 0; text-shadow: none; }
        .pc-da__meta-line { display: flex; flex-wrap: wrap; gap: 4px 10px; min-width: 0; color: var(--fg-mute); font-size: 11px; line-height: 1.2; }
        .pc-da__meta-line span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pc-da__meta-line span:first-child { color: var(--fg-dim); font-weight: 700; }
        .pc-da__hero-action { white-space: nowrap; }
        .pc-da__btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 28px; padding: 4px 9px; border-radius: 7px; border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 78%); background: var(--bg-2); color: var(--fg); font-size: 11.5px; font-weight: 650; cursor: pointer; }
        .pc-da__btn:hover { background: color-mix(in srgb, var(--bg-popover), transparent 4%); border-color: color-mix(in srgb, var(--accent-strong), transparent 60%); }
        .pc-da__btn:disabled { opacity: 0.5; cursor: default; }
        .pc-da__btn--primary { background: color-mix(in srgb, var(--accent), transparent 82%); color: var(--accent-soft); border-color: color-mix(in srgb, var(--accent-strong), transparent 55%); }
        .pc-da__btn--ghost { background: transparent; }
        .pc-da__wizard { border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 72%); border-radius: 12px; background: color-mix(in srgb, var(--bg), transparent 30%); padding: 14px; margin-bottom: 18px; max-width: 680px; }
        .pc-da__wizard-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .pc-da__modes { display: inline-flex; gap: 4px; padding: 3px; margin-bottom: 12px; border-radius: 9px; background: color-mix(in srgb, var(--bg-deeper), transparent 20%); }
        .pc-da__mode { font-size: 12px; padding: 5px 12px; border-radius: 7px; border: none; background: transparent; color: var(--fg-dim); cursor: pointer; font-weight: 600; }
        .pc-da__mode.is-active { background: color-mix(in srgb, var(--accent-strong), transparent 78%); color: var(--accent-cool); }
        .pc-da__authlink { flex: 1; font-size: 13px; color: var(--accent-cool); text-decoration: none; font-weight: 650; }
        .pc-da__authlink:hover { text-decoration: underline; }
        .pc-da__step { margin: 2px 0 12px; }
        .pc-da__step-label { font-size: 11px; color: color-mix(in srgb, var(--accent-soft), transparent 30%); font-weight: 650; }
        .pc-da__step-hint { margin: 6px 0; font-size: 12.5px; color: var(--fg-dim); line-height: 1.5; }
        .pc-da__cmd { display: flex; align-items: center; gap: 8px; margin: 6px 0; padding: 8px 10px; background: color-mix(in srgb, var(--bg-deeper), transparent 15%); border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 82%); border-radius: 7px; }
        .pc-da__cmd code { flex: 1; font-size: 12px; color: var(--accent-cool); overflow-x: auto; white-space: nowrap; }
        .pc-da__copy { padding: 4px 9px; font-size: 11px; flex: 0 0 auto; }
        .pc-da__field { display: grid; gap: 4px; width: 100%; margin-bottom: 10px; }
        .pc-da__field > span { font-size: 11px; color: color-mix(in srgb, var(--accent-soft), transparent 30%); font-weight: 650; }
        .pc-da__field small { color: var(--fg-mute); font-size: 11.5px; line-height: 1.4; }
        .pc-da__field input, .pc-da__field textarea { background: color-mix(in srgb, var(--bg-deeper), transparent 20%); border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 80%); border-radius: 8px; color: var(--fg); padding: 8px 10px; font-size: 13px; font-family: ui-monospace, Menlo, monospace; }
        .pc-da__error { color: var(--bad); font-size: 12.5px; margin: 6px 0 0; }
        .pc-da__muted { color: color-mix(in srgb, var(--accent-soft), transparent 45%); font-size: 13px; }
        .pc-da__save-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
        .pc-da__save-status { color: var(--fg-mute); font-size: 12.5px; }
        .pc-da__save-actions { display: inline-flex; align-items: center; gap: 8px; }
        .pc-da__list { min-width: 0; }
        .pc-da__empty { display: flex; align-items: center; gap: 10px; min-height: 68px; padding: 14px; border: 1px solid color-mix(in srgb, var(--border), white 4%); border-radius: 12px; background: color-mix(in srgb, var(--bg-2), transparent 14%); color: var(--fg-dim); }
        .pc-da__empty p { margin: 0; font-size: 13px; line-height: 1.45; }
        .pc-da__grid-shell { min-width: 0; overflow-x: auto; overflow-y: hidden; border: 1px solid color-mix(in srgb, var(--border), white 5%); border-radius: 10px; background: color-mix(in srgb, var(--bg-2), transparent 14%); }
        .pc-da__grid { min-width: 880px; }
        .pc-da__cards { display: none; gap: 4px; }
        .pc-da__mono { min-width: 0; font-family: ui-monospace, Menlo, monospace; }
        .pc-da__identity { display: grid; min-width: 0; gap: 2px; }
        .pc-da__identity-main { display: flex; align-items: center; gap: 7px; min-width: 0; }
        .pc-da__identity-main > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pc-da__identity-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-mute); font-size: 10.5px; }
        .pc-da__cred { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: color-mix(in srgb, var(--accent-soft), transparent 38%); }
        .pc-da__pill { display: inline-flex; align-items: center; width: fit-content; max-width: 100%; padding: 1px 6px; border-radius: 999px; font-size: 10.5px; font-weight: 650; line-height: 1.3; }
        .pc-da__pill--active { margin-left: 4px; background: color-mix(in srgb, var(--accent-strong), transparent 80%); color: var(--accent-cool); }
        .pc-da__pill--neutral { background: color-mix(in srgb, var(--fg), transparent 88%); color: var(--fg-dim); }
        .pc-da__pill--ok { background: color-mix(in srgb, var(--good), transparent 84%); color: var(--good); }
        .pc-da__pill--warn { background: color-mix(in srgb, var(--warn), transparent 84%); color: var(--warn); }
        .pc-da__pill--bad { background: color-mix(in srgb, var(--bad), transparent 84%); color: var(--bad); }
        .pc-da__util { display: grid; gap: 3px; min-width: 78px; }
        .pc-da__util-bar { height: 4px; border-radius: 999px; background: color-mix(in srgb, var(--fg), transparent 88%); overflow: hidden; }
        .pc-da__util-bar > span { display: block; height: 100%; border-radius: 999px; }
        .pc-da__util-bar--ok > span { background: var(--good); }
        .pc-da__util-bar--warn > span { background: var(--warn); }
        .pc-da__util-bar--bad > span { background: var(--bad); }
        .pc-da__util-pct { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; color: var(--fg-dim); }
        .pc-da__card { display: grid; grid-template-columns: minmax(110px, 1.05fr) minmax(112px, 0.85fr) minmax(90px, 0.8fr) 28px; grid-template-areas: "identity badges usage remove" "identity bound credential remove"; align-items: center; column-gap: 8px; row-gap: 3px; min-height: 52px; padding: 6px 8px; border: 1px solid color-mix(in srgb, var(--border), white 5%); border-radius: 8px; background: color-mix(in srgb, var(--bg-2), transparent 12%); }
        .pc-da__card > .pc-da__identity { grid-area: identity; }
        .pc-da__card-badges { grid-area: badges; display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
        .pc-da__card-usage { grid-area: usage; min-width: 0; }
        .pc-da__card-bound { grid-area: bound; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-dim); font-size: 11px; }
        .pc-da__card-credential { grid-area: credential; font-size: 11px; }
        .pc-da__card-remove { grid-area: remove; align-self: stretch; min-width: 28px; min-height: 0; padding: 0; }
        @container (max-width: 900px) {
          .pc-da__grid-shell { display: none; }
          .pc-da__cards { display: grid; }
        }
        @container (max-width: 430px) {
          .pc-da__hero { grid-template-columns: 1fr auto; align-items: start; gap: 8px; }
          .pc-da h1 { font-size: 24px; }
          .pc-da__meta-line { gap: 3px 8px; font-size: 10.5px; }
          .pc-da__hero-action { padding-inline: 8px; }
          .pc-da__hero-action span { display: none; }
          .pc-da__wizard { padding: 12px; }
          .pc-da__modes { display: flex; flex-wrap: wrap; }
          .pc-da__save-row { align-items: stretch; flex-direction: column; }
          .pc-da__save-actions { justify-content: flex-end; }
          .pc-da__card { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "identity remove" "badges remove" "usage remove" "bound credential"; min-height: 0; }
        }
      `}</style>
    </div>
  );
}

function accountColumns(
  headroom: PoolHeadroom | null,
  remove: (id: string) => void,
  defaultAccountId: string | null | undefined,
  defaultBusy: string | null,
  setDefault: (id: string | null) => void,
): ColumnDef<AccountRow>[] {
  return [
    {
      key: 'id',
      header: 'ID',
      width: 1.5,
      toCopyText: (a) => a.id,
      render: ({ row }) => <AccountIdentity row={row} headroom={headroom} />,
    },
    {
      key: 'provider',
      header: 'Provider',
      width: 0.75,
      toCopyText: (a) => a.provider || 'claude',
      render: ({ row }) => <span className="pc-da__pill pc-da__pill--neutral">{providerLabel(accountProvider(row))}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      width: 1.1,
      toCopyText: (a) => accountStatusText(a),
      render: ({ row }) => accountStatus(row),
    },
    {
      key: 'budget',
      header: 'Usage',
      width: 1.5,
      toCopyText: (a) => accountUsageText(a, headroom),
      render: ({ row }) => <UsageCell row={row} headroom={headroom} />,
    },
    {
      key: 'bound',
      header: 'Bound to',
      width: 1.4,
      toCopyText: (a) => a.boundTo.length ? a.boundTo.join(', ') : '—',
      render: ({ row }) => <span className="pc-da__mono">{row.boundTo.length ? row.boundTo.join(', ') : '—'}</span>,
    },
    {
      key: 'credential',
      header: 'Credential',
      width: 1.5,
      toCopyText: (a) => a.credentialRef,
      render: ({ row }) => <span className="pc-da__mono pc-da__cred">{row.credentialRef}</span>,
    },
    {
      key: 'default',
      header: 'Default',
      width: '92px',
      toCopyText: (a) => (a.id === defaultAccountId ? 'default' : ''),
      render: ({ row }) => (
        <DefaultToggle
          row={row}
          defaultAccountId={defaultAccountId}
          busy={defaultBusy}
          setDefault={setDefault}
        />
      ),
    },
    {
      key: 'actions',
      header: '',
      width: '88px',
      render: ({ row }) => (
        <button className="pc-da__btn pc-da__btn--ghost" onClick={() => void remove(row.id)}>
          <Trash2 size={13} aria-hidden="true" />
          Remove
        </button>
      ),
    },
  ];
}

/**
 * Per-row "make this the default" control. Radio-like (picking one implicitly unpicks the
 * others) rather than a checkbox, because exactly one account can hold the role.
 *
 * Available on EVERY provider since inference-rename-and-provider-agnostic-default-2026-08-09
 * P-003 — Codex rows used to render a disabled "—" because the default stood in for the
 * machine's Claude login only. A default now applies to ITS OWN provider's resolution (D-002),
 * so the tooltip is provider-aware: picking a Codex account fronts Codex traffic and leaves
 * Anthropic traffic on whatever it already used.
 */
function DefaultToggle({
  row,
  defaultAccountId,
  busy,
  setDefault,
}: {
  row: AccountRow;
  defaultAccountId: string | null | undefined;
  busy: string | null;
  setDefault: (id: string | null) => void;
}) {
  const isDefault = defaultAccountId === row.id;
  const pending = busy !== null;
  const isClaude = accountProvider(row) === 'claude';
  return (
    // The shared Tooltip primitive rather than a bare `title` — a title-only tooltip on a
    // button is blocked by lint:design-primitives (it is invisible to keyboard + touch users).
    <Tooltip
      label={
        isDefault
          ? isClaude
            ? "This account stands in for the machine's own Claude login. Click to clear it."
            : 'This account is the default for Codex/OpenAI traffic. Click to clear it.'
          : isClaude
            ? 'Make this the account everything on this machine uses by default.'
            : 'Make this the default for Codex/OpenAI traffic. Anthropic traffic is unaffected.'
      }
    >
      <button
        type="button"
        className={`pc-da__btn ${isDefault ? 'pc-da__btn--default-on' : 'pc-da__btn--ghost'}`}
        disabled={pending}
        aria-pressed={isDefault}
        aria-label={isDefault ? `Clear ${row.id} as the default account` : `Make ${row.id} the default account`}
        onClick={() => setDefault(isDefault ? null : row.id)}
      >
        <Star size={13} aria-hidden="true" fill={isDefault ? 'currentColor' : 'none'} />
        {isDefault ? 'Default' : 'Set'}
      </button>
    </Tooltip>
  );
}

function AccountIdentity({ row, headroom }: { row: AccountRow; headroom: PoolHeadroom | null }) {
  const active = isActiveAccount(headroom, row.id);
  return (
    <span className="pc-da__identity">
      <span className="pc-da__identity-main pc-da__mono">
        <span>{row.id}</span>
        {active && <span className="pc-da__pill pc-da__pill--active" title="The gateway is routing egress through this account now">active</span>}
      </span>
      {row.label && <span className="pc-da__identity-label">{row.label}</span>}
    </span>
  );
}

function UsageCell({ row, headroom }: { row: AccountRow; headroom: PoolHeadroom | null }) {
  const usage = accountUsage(row, headroom);
  if (!usage) return <span className="pc-da__muted">—</span>;
  const pct = usage.pct;
  return (
    <div className="pc-da__util" title={`${usage.label}${usage.rejected ? ' — over budget' : ''}`}>
      <div className={`pc-da__util-bar pc-da__util-bar--${utilizationTone(pct)}`}>
        <span style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <span className="pc-da__util-pct">
        {pct}%{usage.reset ? ` · resets ${usage.reset}` : ''}
      </span>
    </div>
  );
}

function AccountCard({
  account,
  headroom,
  remove,
  defaultAccountId,
  defaultBusy,
  setDefault,
}: {
  account: AccountRow;
  headroom: PoolHeadroom | null;
  remove: (id: string) => void;
  defaultAccountId: string | null | undefined;
  defaultBusy: string | null;
  setDefault: (id: string | null) => void;
}) {
  const boundText = account.boundTo.length ? account.boundTo.join(', ') : '—';
  return (
    <article className="pc-da__card">
      <AccountIdentity row={account} headroom={headroom} />
      <div className="pc-da__card-badges">
        {accountStatus(account)}
        <span className="pc-da__pill pc-da__pill--neutral">{providerLabel(accountProvider(account))}</span>
        <DefaultToggle
          row={account}
          defaultAccountId={defaultAccountId}
          busy={defaultBusy}
          setDefault={setDefault}
        />
      </div>
      <div className="pc-da__card-usage">
        <UsageCell row={account} headroom={headroom} />
      </div>
      <span className="pc-da__mono pc-da__card-bound" title={`Bound to: ${boundText}`}>
        {boundText}
      </span>
      <span className="pc-da__mono pc-da__cred pc-da__card-credential" title={account.credentialRef}>
        {account.credentialRef}
      </span>
      <Tooltip label={`Remove ${account.id}`}>
        <button
          className="pc-da__btn pc-da__btn--ghost pc-da__card-remove"
          aria-label={`Remove ${account.id}`}
          onClick={() => void remove(account.id)}
        >
          <Trash2 size={13} aria-hidden="true" />
        </button>
      </Tooltip>
    </article>
  );
}

function accountStatusText(account: AccountRow): string {
  if (account.sustainedlyLimited) return 'limited';
  if (account.rate.pausedUntil > Date.now()) return `paused ${new Date(account.rate.pausedUntil).toLocaleTimeString()}`;
  return 'available';
}

function accountUsage(
  account: AccountRow,
  headroom: PoolHeadroom | null,
): { pct: number; reset?: string; label: string; rejected?: boolean } | null {
  if (isActiveAccount(headroom, account.id) && headroom?.utilizationPct !== undefined) {
    return {
      pct: headroom.utilizationPct,
      reset: headroom.resetInSec !== undefined ? formatResetIn(headroom.resetInSec) : undefined,
      label: `${headroom.window ?? (accountProvider(account) === 'codex' ? 'OpenAI' : '5h')} window`,
      rejected: headroom.rejected,
    };
  }
  const utilization = account.rate.utilization;
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return null;
  const resetMs = account.rate.windowResetAt && account.rate.windowResetAt > Date.now()
    ? Math.ceil((account.rate.windowResetAt - Date.now()) / 1000)
    : undefined;
  return {
    pct: Math.round(utilization * 100),
    reset: resetMs ? formatResetIn(resetMs) : undefined,
    label: accountProvider(account) === 'codex' ? 'OpenAI account usage' : 'Claude 5h budget',
  };
}

function accountUsageText(account: AccountRow, headroom: PoolHeadroom | null): string {
  const usage = accountUsage(account, headroom);
  return usage ? `${usage.pct}%${usage.reset ? ` reset ${usage.reset}` : ''}` : '—';
}

function accountStatus(account: AccountRow) {
  if (account.sustainedlyLimited) return <span className="pc-da__pill pc-da__pill--bad">limited</span>;
  if (account.rate.pausedUntil > Date.now()) {
    return (
      <span className="pc-da__pill pc-da__pill--warn">
        paused → {new Date(account.rate.pausedUntil).toLocaleTimeString()}
      </span>
    );
  }
  return <span className="pc-da__pill pc-da__pill--ok">available</span>;
}
