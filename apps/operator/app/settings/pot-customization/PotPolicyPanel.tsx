'use client';

/**
 * PotPolicyPanel — the minimal owner control surface for a Hive's enforceable policy
 * (shared-hive-owner-enforcement-2026-06-19 EN-1, build step 4).
 *
 * Gated on the SAME authority as the authoring API: only a viewer who is a claimant of a
 * CLAIMED Hive (useHarnessClaimStatus → viewer_is_claimant) sees the editable form; a
 * non-claimant sees a read-only view + the reason. nuqs holds the panel open-state
 * (?hivePolicy=) so it is deep-linkable + agent-driveable (repo convention).
 *
 * Reads GET /api/pot/:id/policy (the owner-signed policy, or null = permissive) and
 * writes POST /api/pot/:id/policy { policy } — the server re-checks the claim gate +
 * signs with the Hive key, so this UI gate is a hint, the real gate is server-side.
 */
import { useCallback, useEffect, useState } from 'react';
import { useQueryState, parseAsBoolean } from 'nuqs';
import { toast } from 'sonner';
import { Checkbox } from '../../harness/Checkbox';
import { Select } from '../../harness/Select';
import { useHarnessClaimStatus } from '../../adv/harnesses/useHarnessClaimStatus';
import { useLexicon } from '@/lib/useLexicon';

type Membership = 'open' | 'approval' | 'allowlist';
interface HivePolicyView {
  rate?: { opsPerMin?: number; rowsPerHour?: number; prsPerDay?: number };
  membership?: Membership;
  allowlist?: string[];
  moderation?: { reportable?: boolean; bannedGithubIds?: string[]; takedownList?: string[] };
  [k: string]: unknown;
}
interface ResolvedPolicy {
  policy: HivePolicyView;
  policyVersion: number;
  ownerPubkey: string;
  updatedAt: number;
}

/** One live EN-2 rate row (mirrors `RateStateRow` from rate-limiter.ts — the owner
 *  "member X at N/cap" observability surface, EN-1 findings "Remaining for full
 *  release" / findings-EN-4.md "fast follow"). */
interface RateStateRowView {
  authorId: number;
  cls: 'ops' | 'rows' | 'prs';
  count: number;
  cap: number | null;
  throttled: boolean;
  suspectedTimestampSkew: boolean;
}
interface RateStateResponse {
  ok: boolean;
  booted: boolean;
  rows: RateStateRowView[];
}

const SECTION: React.CSSProperties = { marginTop: 24 };
const ROW: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 };
const LABEL: React.CSSProperties = { fontSize: 13, color: 'var(--fg-mute)', minWidth: 140 };
const NUM_INPUT: React.CSSProperties = {
  width: 90, fontSize: 12, padding: '4px 8px', background: 'var(--bg-1)',
  border: '1px solid var(--border)', borderRadius: 4, color: 'inherit',
};
const TEXTAREA: React.CSSProperties = {
  width: '100%', minHeight: 70, fontSize: 12, fontFamily: 'monospace', padding: 8,
  background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 4, color: 'inherit',
};
const BTN: React.CSSProperties = { fontSize: 12, padding: '5px 14px', cursor: 'pointer' };

function numOrUndef(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
function linesToList(s: string): string[] {
  return s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
}

export function PotPolicyPanel({ hive }: { hive: string }): React.ReactElement {
  const t = useLexicon();
  const [open, setOpen] = useQueryState('hivePolicy', parseAsBoolean.withDefault(false));
  const { data: claim } = useHarnessClaimStatus(hive);
  const canEdit = claim?.viewer_is_claimant === true;

  const [loaded, setLoaded] = useState<ResolvedPolicy | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rateState, setRateState] = useState<RateStateResponse | null>(null);

  // Draft form state.
  const [membership, setMembership] = useState<Membership | ''>('');
  const [opsPerMin, setOpsPerMin] = useState('');
  const [rowsPerHour, setRowsPerHour] = useState('');
  const [prsPerDay, setPrsPerDay] = useState('');
  const [allowlist, setAllowlist] = useState('');
  const [reportable, setReportable] = useState(false);

  const hydrate = useCallback((p: HivePolicyView | null | undefined) => {
    setMembership((p?.membership as Membership) ?? '');
    setOpsPerMin(p?.rate?.opsPerMin != null ? String(p.rate.opsPerMin) : '');
    setRowsPerHour(p?.rate?.rowsPerHour != null ? String(p.rate.rowsPerHour) : '');
    setPrsPerDay(p?.rate?.prsPerDay != null ? String(p.rate.prsPerDay) : '');
    setAllowlist((p?.allowlist ?? []).join('\n'));
    setReportable(p?.moderation?.reportable === true);
  }, []);

  useEffect(() => {
    if (!open || !hive) return;
    let cancel = false;
    setLoading(true);
    fetch(`/api/pot/${encodeURIComponent(hive)}/policy`)
      .then((r) => (r.ok ? (r.json() as Promise<{ ok: boolean; policy: ResolvedPolicy | null }>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        if (cancel) return;
        setLoaded(j.policy);
        hydrate(j.policy?.policy);
      })
      .catch((e: Error) => {
        if (!cancel) toast.error(`Couldn't load policy: ${e.message}`);
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [open, hive, hydrate]);

  // Live EN-2 "member X at N/cap" observability (WI-253) — a separate, best-effort
  // fetch: absence of live data (not booted on this machine, or the route predates
  // an older release) is normal, not an error worth alarming the owner over.
  useEffect(() => {
    if (!open || !hive) return;
    let cancel = false;
    fetch(`/api/pot/${encodeURIComponent(hive)}/policy/rate`)
      .then((r) => (r.ok ? (r.json() as Promise<RateStateResponse>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        if (!cancel) setRateState(j);
      })
      .catch(() => {
        if (!cancel) setRateState(null);
      });
    return () => {
      cancel = true;
    };
  }, [open, hive]);

  const buildPolicy = useCallback((): HivePolicyView => {
    // Start from the loaded policy to PRESERVE unknown/forward-compat keys + moderation
    // lists this minimal form doesn't edit (bannedGithubIds/takedownList live in EN-3).
    const base: HivePolicyView = { ...(loaded?.policy ?? {}) };
    const rate: HivePolicyView['rate'] = {};
    const om = numOrUndef(opsPerMin); if (om != null) rate.opsPerMin = om;
    const rh = numOrUndef(rowsPerHour); if (rh != null) rate.rowsPerHour = rh;
    const pd = numOrUndef(prsPerDay); if (pd != null) rate.prsPerDay = pd;
    if (Object.keys(rate).length > 0) base.rate = rate; else delete base.rate;
    if (membership) base.membership = membership; else delete base.membership;
    const al = linesToList(allowlist);
    if (al.length > 0) base.allowlist = al; else delete base.allowlist;
    const mod = { ...(base.moderation ?? {}), reportable };
    base.moderation = mod;
    return base;
  }, [loaded, opsPerMin, rowsPerHour, prsPerDay, membership, allowlist, reportable]);

  const save = useCallback(async () => {
    if (!hive || !canEdit) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/pot/${encodeURIComponent(hive)}/policy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ policy: buildPolicy() }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; policy?: ResolvedPolicy } | null;
      if (!res.ok || !body?.ok) {
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      setLoaded(body.policy ?? null);
      toast.success(`Saved ${t('pot')} policy (v${body.policy?.policyVersion ?? '?'})`);
    } catch (e) {
      toast.error(`Couldn't save policy: ${e instanceof Error ? e.message : 'failed'}`);
    } finally {
      setSaving(false);
    }
  }, [hive, canEdit, buildPolicy, t]);

  return (
    <section className="pc-settings-section" aria-label={`${t('pot')} policy`} style={SECTION}>
      <div style={{ ...ROW, marginBottom: open ? 12 : 0 }}>
        <h2 style={{ margin: 0, fontSize: 15 }}>{t('pot')} policy {loaded ? <span style={{ color: 'var(--fg-mute)', fontSize: 12 }}>· v{loaded.policyVersion}</span> : null}</h2>
        <button type="button" style={BTN} onClick={() => void setOpen(!open)}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>

      {open && (
        <>
          <p style={{ fontSize: 12, color: 'var(--fg-mute)', margin: '0 0 12px' }}>
            Enforceable policy a <strong>claimed</strong> {t('pot', { lower: true })} owner sets — rate caps, membership mode,
            allowlist, moderation. Signed with the {t('pot', { lower: true })} key + federated; honest peers enforce it at
            write-admission (EN-2+). An unclaimed {t('pot', { lower: true })} can&rsquo;t set policy.
          </p>

          {claim == null ? (
            <p style={{ fontSize: 13, color: 'var(--fg-mute)' }}>Checking owner authority…</p>
          ) : !canEdit ? (
            <p style={{ fontSize: 13, color: 'var(--fg-mute)' }}>
              Only the claimed {t('pot', { lower: true })} owner can edit policy ({claim.status}).{' '}
              {loaded ? `Current: membership=${loaded.policy.membership ?? 'open'}.` : 'No policy set (permissive).'}
            </p>
          ) : loading ? (
            <p style={{ fontSize: 13, color: 'var(--fg-mute)' }}>Loading policy…</p>
          ) : (
            <div>
              <div style={ROW}>
                <span style={LABEL}>Membership</span>
                <Select
                  value={membership}
                  onChange={(v) => setMembership((v as Membership) || '')}
                  ariaLabel="Membership mode"
                  options={[
                    { value: '', label: 'open (default)' },
                    { value: 'open', label: 'open' },
                    { value: 'approval', label: 'approval' },
                    { value: 'allowlist', label: 'allowlist' },
                  ]}
                />
              </div>
              <div style={ROW}>
                <span style={LABEL}>Rate caps</span>
                <label style={{ fontSize: 12 }}>ops/min <input style={NUM_INPUT} value={opsPerMin} onChange={(e) => setOpsPerMin(e.target.value)} inputMode="numeric" /></label>
                <label style={{ fontSize: 12 }}>rows/hr <input style={NUM_INPUT} value={rowsPerHour} onChange={(e) => setRowsPerHour(e.target.value)} inputMode="numeric" /></label>
                <label style={{ fontSize: 12 }}>PRs/day <input style={NUM_INPUT} value={prsPerDay} onChange={(e) => setPrsPerDay(e.target.value)} inputMode="numeric" /></label>
              </div>
              <p style={{ fontSize: 11, color: 'var(--fg-mute)', margin: '0 0 12px', marginLeft: 150 }}>
                ops/min &amp; rows/hr are enforced at substrate write-admission (EN-2). PRs/day is a
                fork→PR boundary rule (EN-4 P-CONTRIB) — stored + signed now, not yet substrate-enforced.
              </p>
              <div style={{ ...ROW, alignItems: 'flex-start' }}>
                <span style={LABEL}>Live rate state</span>
                <div style={{ fontSize: 12, color: 'var(--fg-mute)' }}>
                  {!rateState || !rateState.booted ? (
                    <span>Not available ({t('pot')} not currently booted on this machine).</span>
                  ) : rateState.rows.length === 0 ? (
                    <span>No members tracked yet this window.</span>
                  ) : (
                    <ul style={{ margin: 0, paddingLeft: 16 }}>
                      {rateState.rows.map((r) => (
                        <li key={`${r.authorId}:${r.cls}`}>
                          member {r.authorId} — {r.cls}: {r.count}/{r.cap ?? '∞'}
                          {r.throttled ? ' (throttled)' : ''}
                          {r.suspectedTimestampSkew ? ' ⚠ suspected clock-skew' : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
              <div style={{ ...ROW, alignItems: 'flex-start' }}>
                <span style={LABEL}>Allowlist (logins)</span>
                <textarea style={TEXTAREA} value={allowlist} onChange={(e) => setAllowlist(e.target.value)} placeholder="one github login per line (used when membership=allowlist)" />
              </div>
              <div style={ROW}>
                <span style={LABEL}>Moderation</span>
                <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Checkbox checked={reportable} onChange={setReportable} ariaLabel="Members can report content" />
                  members can report content
                </label>
              </div>
              <button type="button" style={{ ...BTN, background: 'var(--accent)', color: 'var(--fg)', border: 'none', borderRadius: 4 }} onClick={() => void save()} disabled={saving}>
                {saving ? 'Signing + saving…' : 'Save policy'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
