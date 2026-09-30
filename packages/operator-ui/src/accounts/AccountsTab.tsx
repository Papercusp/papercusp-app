/**
 * AccountsTab (left sidebar) — the owner's account-pool panel, docked next to Queen
 * in the Colony left sidebar (accounts-pool-tab-2026-06-15 P-005).
 *
 * This is now the SINGLE in-app account view (the standalone /adv "Accounts" tab was
 * removed — its data folded in here). Compact by default: each row shows status +
 * provider usage + the session-now Force/Exclude steering levers; expanding a row reveals
 * the full card — masked credential ref, availability + pause/penalty, provider windows
 * with reset + "as of", bound member harnesses, egress, live governor buckets, and a
 * per-account Reset (clear a stale projected pause). Adding / removing / linking an
 * account lives in Settings -> Inference (the heavy wizard, still routed at
 * /settings/deploy-accounts); a link sits in the
 * footer. Rows are provider-aware: legacy rows are Claude, explicit Codex rows show the
 * OpenAI-compatible route instead of Anthropic Max copy. Shares the override logic with
 * nothing else now via useAccountOverride.
 *
 * Data: full account rows ← accounts.pool sync query (live over SSE; register/remove/
 * reset/override fire notifySyncInvalidate('accounts.pool') so rows refresh). Override
 * ← GET/POST /api/admin/deploy-accounts/session-override (hive_settings-backed),
 * applied OPTIMISTICALLY in useAccountOverride so the levers flip instantly.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { parseAsString, useQueryState } from 'nuqs';
import {
  RotateCcw,
  ChevronDown,
  ChevronRight,
  Pause,
  CircleCheck,
  CircleSlash,
  Network,
  Settings as SettingsIcon,
  KeyRound,
} from 'lucide-react';
import { useSyncQuery } from '@papercusp/sync';
import { useAccountOverride } from './use-account-override';
import { operatorUi } from '../seam';

// Full pool-account row — mirrors AccountStatusRow (operator-core account-pool-store).
// Sync rows are untyped on the client by convention, so we restate the shape.
interface AccountRate {
  pausedUntil: number;
  lastPenaltyAt: number;
  penaltyCount: number;
  windowStartedAt: number;
  utilization?: number;
  windowResetAt?: number;
  utilizationAt?: number;
  utilization7d?: number;
  windowResetAt7d?: number;
}
interface PoolAccount {
  id: string;
  provider?: 'claude' | 'codex';
  label?: string;
  credentialRef: string;
  boundTo: string[];
  available: boolean;
  sustainedlyLimited: boolean;
  edgeThrottleKnown?: boolean;
  edgeThrottled?: boolean;
  edgeThrottleResetAt?: number;
  edgeThrottleCooledIps?: number;
  edgeThrottleBare429Streak?: number;
  rate: AccountRate;
  egress?: { proxyUrl?: string; localAddress?: string };
  liveBuckets: { key: string; provider: string; modelClass: string; paused: boolean; pausedUntil: number }[];
}

type AccountProvider = NonNullable<PoolAccount['provider']>;

function accountProvider(a: Pick<PoolAccount, 'provider'>): AccountProvider {
  return a.provider === 'codex' ? 'codex' : 'claude';
}

function providerLabel(provider: AccountProvider): string {
  return provider === 'codex' ? 'Codex' : 'Claude';
}

function primaryUsageLabel(provider: AccountProvider): string {
  return provider === 'codex' ? 'OpenAI' : '5h';
}

function secondaryUsageLabel(provider: AccountProvider): string {
  return provider === 'codex' ? 'Long' : '7d';
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function postJson(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; j: { ok?: boolean; error?: string } }> {
  const res = await operatorUi().apiFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let j: { ok?: boolean; error?: string } = {};
  try {
    j = (await res.json()) as typeof j;
  } catch {
    /* non-JSON response */
  }
  return { ok: res.ok, j };
}

/** Show the credential's scheme + filename only — never the home path, never the token. */
function maskRef(ref: string): string {
  const colon = ref.indexOf(':');
  const scheme = colon > 0 ? ref.slice(0, colon) : '';
  const path = colon > 0 ? ref.slice(colon + 1) : ref;
  const base = path.split('/').filter(Boolean).pop() ?? path;
  return scheme ? `${scheme}:…/${base}` : `…/${base}`;
}

/** "~12%" from a 0..1+ fraction, or "—" when never observed. */
function pct(u?: number): string {
  return typeof u === 'number' ? `~${Math.round(u * 100)}%` : '—';
}

function usagePctValue(u?: number): number {
  if (typeof u !== 'number' || !Number.isFinite(u)) return 0;
  return Math.max(0, Math.min(100, Math.round(u * 100)));
}

function usageTone(u?: number): 'quiet' | 'ok' | 'warn' | 'hot' {
  if (typeof u !== 'number') return 'quiet';
  if (u >= 0.9) return 'hot';
  if (u >= 0.7) return 'warn';
  return 'ok';
}

/** Compact forward countdown — "3d 5h" / "2h 13m" / "12m" / "now". */
function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** "3m ago" / "2h ago" from a past epoch ms. */
function fmtAgo(at: number, now: number): string {
  const ms = now - at;
  if (ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function UsageMeter({ label, value, reset }: { label: string; value?: number; reset?: string }) {
  const width = usagePctValue(value);
  const tone = usageTone(value);
  return (
    <div className={`pclsb-acct__meter pclsb-acct__meter--${tone}`} aria-label={`${label} usage ${pct(value)}${reset}`}>
      <span className="pclsb-acct__meterlabel">{label}</span>
      <div className="pclsb-acct__bar" aria-hidden>
        <span style={{ width: `${width}%` }} />
      </div>
      <strong>{pct(value)}</strong>
      {reset ? <span className="pclsb-acct__meterreset">{reset.replace(/^ · /, '')}</span> : null}
    </div>
  );
}

/** A 1s-ticking clock for live countdowns; only runs while the tab is active. */
function useNow(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    // timer-classification: ui-timer — relative-time re-render (countdown/"Xs ago"
    // labels), reads no store; setNow(Date.now()) is a pure clock tick.
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [enabled, intervalMs]);
  return now;
}

export default function AccountsTab({ active }: { active: boolean }) {
  // Read at render, not at module scope: the host installs the seam at boot, and a
  // module-scope destructure would capture the DEFAULTS of whichever module record
  // evaluated first.
  const { Link } = operatorUi();
  const now = useNow(active);
  const { data: accounts, loading } = useSyncQuery<PoolAccount>({ queryName: 'accounts.pool', enabled: active });
  const {
    overrideBusy,
    forced,
    excluded,
    overrideActive,
    toggleForce,
    toggleExclude,
    clearOverride,
    defaultAccountId,
    setDefaultAccount,
  } = useAccountOverride();
  // Which card is expanded (accordion). URL state so it's agent-driveable + survives reload.
  const [expanded, setExpanded] = useQueryState('acct', parseAsString);
  const [resetBusyId, setResetBusyId] = useState<string | null>(null);
  const poolSummary = useMemo(() => {
    const rows = accounts ?? [];
    const paused = rows.filter((a) => a.rate.pausedUntil > now).length;
    const claude = rows.filter((a) => accountProvider(a) === 'claude').length;
    const codex = rows.filter((a) => accountProvider(a) === 'codex').length;
    return {
      total: rows.length,
      claude,
      codex,
      available: rows.filter((a) => a.available && a.rate.pausedUntil <= now).length,
      paused,
      limited: rows.filter((a) => a.sustainedlyLimited).length,
      forced: forced.size,
      excluded: excluded.size,
    };
  }, [accounts, excluded.size, forced.size, now]);

  const resetRate = useCallback(async (id: string) => {
    const { toast } = operatorUi();
    setResetBusyId(id);
    try {
      const { ok, j } = await postJson('/api/admin/deploy-accounts/reset-rate', { id });
      if (!ok || !j.ok) throw new Error(j.error || 'reset failed');
      toast.success(`Reset rate state for ${id}`);
    } catch (e) {
      toast.error(`Reset failed: ${errMsg(e)}`);
    } finally {
      setResetBusyId(null);
    }
  }, []);

  return (
    <div className="pclsb-acct">
      <header className="pclsb-acct__hero">
        <div className="pclsb-acct__herotitle">
          <KeyRound size={14} aria-hidden />
          <div>
            <span className="pclsb-acct__eyebrow">spawn account pool</span>
            <p>Session steering for fleet account use.</p>
          </div>
        </div>
        <div className="pclsb-acct__summary" aria-label="Account pool summary">
          <span><b>{poolSummary.available}/{poolSummary.total}</b> avail</span>
          <span><b>{poolSummary.claude}</b> Claude</span>
          <span><b>{poolSummary.codex}</b> Codex</span>
          <span><b>{poolSummary.paused}</b> paused</span>
          <span><b>{poolSummary.limited}</b> limited</span>
          <span><b>{poolSummary.forced || poolSummary.excluded ? `${poolSummary.forced}/${poolSummary.excluded}` : 'off'}</b> steer</span>
        </div>
      </header>

      <div className="pclsb-acct__rule" role="note">
        <strong>★ Default</strong> starts here · <strong>Force</strong> allow-lists ·{' '}
        <strong>Excl</strong> skips · none uses the whole pool
      </div>

      {/* Always shown — "which account is actually in force" is the question this pane exists
          to answer, and the no-default answer (the box's own login) is a real state, not the
          absence of one. */}
      <div className="pclsb-acct__dflt" role="status">
        {defaultAccountId ? (
          <>
            <span className="pclsb-acct__chip is-default">★ {defaultAccountId}</span>
            <span>is the default — everything starts here, then fails over.</span>
          </>
        ) : (
          <span>
            No default — using this machine&rsquo;s own Claude login (<code>~/.claude</code>).
          </span>
        )}
      </div>

      {overrideActive && (
        <div className="pclsb-acct__ovr" role="status">
          <div className="pclsb-acct__ovrtext">
            <strong>Session steering active</strong>
            {forced.size > 0 && (
              <>
                <span>Only</span> {[...forced].map((id) => <span key={id} className="pclsb-acct__chip is-force">{id}</span>)}{' '}
              </>
            )}
            {excluded.size > 0 && (
              <>
                <span>Exclude</span> {[...excluded].map((id) => <span key={id} className="pclsb-acct__chip is-excl">{id}</span>)}
              </>
            )}
          </div>
          <button type="button" className="pclsb-acct__clear" disabled={overrideBusy} onClick={clearOverride}>
            Clear
          </button>
        </div>
      )}

      {loading && accounts.length === 0 ? (
        <div className="pclsb-panel__empty">Loading accounts…</div>
      ) : accounts.length === 0 ? (
        <div className="pclsb-panel__empty">No accounts in the pool yet.</div>
      ) : (
        <ul className="pclsb-acct__list">
          {accounts.map((a) => {
            const provider = accountProvider(a);
            const isForced = forced.has(a.id);
            const isExcluded = excluded.has(a.id);
            const isDefault = defaultAccountId === a.id;
            const isOpen = expanded === a.id;
            const paused = a.rate.pausedUntil > now;
            const statusKind = paused ? 'paused' : a.available ? 'ok' : 'off';
            const StatusIcon = paused ? Pause : a.available ? CircleCheck : CircleSlash;
            const statusLabel = paused
              ? `Paused · resets ${fmtCountdown(a.rate.pausedUntil - now)}`
              : a.available
                ? 'Available'
                : 'Unavailable';
            const statusShort = paused ? `pause ${fmtCountdown(a.rate.pausedUntil - now)}` : a.available ? 'avail' : 'off';
            const reset5h =
              a.rate.windowResetAt && a.rate.windowResetAt > now ? ` · resets ${fmtCountdown(a.rate.windowResetAt - now)}` : '';
            const reset7d =
              a.rate.windowResetAt7d && a.rate.windowResetAt7d > now ? ` · resets ${fmtCountdown(a.rate.windowResetAt7d - now)}` : '';
            return (
              <li key={a.id} className={`pclsb-acct__row pclsb-acct__row--${statusKind}${isForced ? ' is-forced' : ''}${isExcluded ? ' is-excluded' : ''}`}>
                <Collapsible.Root open={isOpen} onOpenChange={(open) => void setExpanded(open ? a.id : null)}>
                  <div className="pclsb-acct__top">
                    <Collapsible.Trigger asChild>
                      <button type="button" className="pclsb-acct__name">
                        <span className="pclsb-acct__labelrow">
                          <span className={`pclsb-acct__dot pclsb-acct__dot--${statusKind}`} aria-hidden />
                          <span className="pclsb-acct__label">{a.label || a.id}</span>
                          <span className={`pclsb-acct__provider pclsb-acct__provider--${provider}`}>{providerLabel(provider)}</span>
                        </span>
                        <span className="pclsb-acct__id">{a.id}</span>
                      </button>
                    </Collapsible.Trigger>
                    <span className={`pclsb-acct__statuspill pclsb-acct__statuspill--${statusKind}`} aria-label={statusLabel}>{statusShort}</span>
                    <div className="pclsb-acct__btns">
                      {/* Every provider, not just Claude
                          (inference-rename-and-provider-agnostic-default-2026-08-09 P-003). A
                          default now fronts ITS OWN provider's resolution, so a Codex row has a
                          real default to set and the server accepts it. */}
                      <button
                        type="button"
                        className={`pclsb-acct__b${isDefault ? ' is-default' : ''}`}
                        disabled={overrideBusy}
                        aria-pressed={isDefault}
                        aria-label={
                          isDefault
                            ? `Clear ${a.id} as the default account`
                            : `Make ${a.id} the default ${accountProvider(a) === 'codex' ? 'Codex/OpenAI' : 'Claude'} account`
                        }
                        /* No `title`: a title-only tooltip on a button is blocked by
                           lint:design-primitives (invisible to keyboard + touch). The
                           aria-label above already states the action, the sibling
                           Force/Exclude buttons carry no tooltip either, and the banner
                           at the top of this tab explains what a default DOES. */
                        onClick={() => setDefaultAccount(isDefault ? null : a.id)}
                      >
                        {isDefault ? '★ Default' : '☆ Default'}
                      </button>
                      <button
                        type="button"
                        className={`pclsb-acct__b${isForced ? ' is-force' : ''}`}
                        disabled={overrideBusy}
                        aria-pressed={isForced}
                        aria-label={isForced ? `Stop forcing ${a.id}` : `Force only ${a.id}`}
                        onClick={() => toggleForce(a.id)}
                      >
                        {isForced ? '✓ Force' : 'Force'}
                      </button>
                      <button
                        type="button"
                        className={`pclsb-acct__b${isExcluded ? ' is-excl' : ''}`}
                        disabled={overrideBusy}
                        aria-pressed={isExcluded}
                        aria-label={isExcluded ? `Stop excluding ${a.id}` : `Exclude ${a.id}`}
                        onClick={() => toggleExclude(a.id)}
                      >
                        {isExcluded ? '✓ Excl' : 'Excl'}
                      </button>
                      <Collapsible.Trigger asChild>
                        <button
                          type="button"
                          className="pclsb-acct__expand"
                          aria-label={isOpen ? 'Collapse' : 'Expand'}
                        >
                          {isOpen ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                        </button>
                      </Collapsible.Trigger>
                    </div>
                  </div>

                  <div className="pclsb-acct__usage">
                    <UsageMeter label={primaryUsageLabel(provider)} value={a.rate.utilization} reset={reset5h} />
                    <UsageMeter label={secondaryUsageLabel(provider)} value={a.rate.utilization7d} reset={reset7d} />
                  </div>

                  <div className="pclsb-acct__facts">
                    <span>{providerLabel(provider)}</span>
                    <span>{maskRef(a.credentialRef)}</span>
                    <span>{a.boundTo.length ? `${a.boundTo.length} bound` : 'unbound'}</span>
                    <span>{a.liveBuckets.length ? `${a.liveBuckets.length} bucket${a.liveBuckets.length === 1 ? '' : 's'}` : 'no buckets'}</span>
                    {a.egress && (a.egress.proxyUrl || a.egress.localAddress) ? <span>egress</span> : null}
                    {paused && <span className="pclsb-acct__chip is-excl">paused</span>}
                    {isForced && <span className="pclsb-acct__chip is-force">forced</span>}
                    {isExcluded && <span className="pclsb-acct__chip is-excl">excluded</span>}
                    {a.sustainedlyLimited && <span className="pclsb-acct__chip is-excl">limited</span>}
                    {a.edgeThrottled && <span className="pclsb-acct__chip is-excl">edge throttle</span>}
                    {a.rate.penaltyCount > 0 && (
                      <span className="pclsb-acct__chip">{a.rate.penaltyCount} penalt{a.rate.penaltyCount === 1 ? 'y' : 'ies'}</span>
                    )}
                  </div>

                  <Collapsible.Content className="pclsb-acct__detail">
                    <div className={`pclsb-acct__status pclsb-acct__status--${statusKind}`}>
                      <StatusIcon size={12} aria-hidden />
                      <span>{statusLabel}</span>
                    </div>
                    <dl className="pclsb-acct__meta">
                      <div>
                        <dt>{provider === 'codex' ? 'OpenAI window' : '5h window'}</dt>
                        <dd>
                          {pct(a.rate.utilization)}
                          {reset5h && <span className="pclsb-acct__umute">{reset5h}</span>}
                          {a.rate.utilizationAt ? <span className="pclsb-acct__umute"> · as of {fmtAgo(a.rate.utilizationAt, now)}</span> : null}
                        </dd>
                      </div>
                      <div>
                        <dt>{provider === 'codex' ? 'Long window' : '7d window'}</dt>
                        <dd>
                          {pct(a.rate.utilization7d)}
                          {reset7d && <span className="pclsb-acct__umute">{reset7d}</span>}
                        </dd>
                      </div>
                      <div>
                        <dt>Bound to</dt>
                        <dd>
                          {a.boundTo.length ? (
                            <span className="pclsb-acct__bound">
                              {a.boundTo.map((m) => <span key={m} className="pclsb-acct__chip">{m}</span>)}
                            </span>
                          ) : (
                            <span className="pclsb-acct__umute">unbound</span>
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Cred</dt>
                        <dd><code className="pclsb-acct__cred">{maskRef(a.credentialRef)}</code></dd>
                      </div>
                      {a.egress && (a.egress.proxyUrl || a.egress.localAddress) ? (
                        <div>
                          <dt><Network size={10} aria-hidden /> Egress</dt>
                          <dd><code className="pclsb-acct__cred">{a.egress.proxyUrl || a.egress.localAddress}</code></dd>
                        </div>
                      ) : null}
                    </dl>

                    {a.liveBuckets.length > 0 && (
                      <ul className="pclsb-acct__buckets">
                        {a.liveBuckets.map((b) => (
                          <li key={b.key}>
                            <code>{b.provider}/{b.modelClass}</code>
                            <span className={`pclsb-acct__chip${b.paused ? ' is-excl' : ''}`}>
                              {b.paused ? `paused · ${fmtCountdown(b.pausedUntil - now)}` : 'live'}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}

                    <button
                      type="button"
                      className="pclsb-acct__reset"
                      disabled={resetBusyId === a.id}
                      onClick={() => void resetRate(a.id)}
                      aria-label={`Clear projected pause and penalty state for ${a.id}`}
                    >
                      <RotateCcw size={11} aria-hidden /> {resetBusyId === a.id ? 'Resetting…' : 'Reset rate state'}
                    </button>
                  </Collapsible.Content>
                </Collapsible.Root>
              </li>
            );
          })}
        </ul>
      )}

      <Link to="/settings/deploy-accounts" className="pclsb-acct__manage">
        <SettingsIcon size={12} aria-hidden /> Add / remove accounts…
      </Link>
      <p className="pclsb-acct__foot">
        Usage is the last observed provider limit signal from the inference gateway. Claude rows show Max 5h + 7d windows;
        Codex rows show OpenAI-compatible route usage when available.
      </p>
    </div>
  );
}
