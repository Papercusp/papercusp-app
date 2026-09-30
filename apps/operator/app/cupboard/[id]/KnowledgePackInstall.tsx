'use client';

/**
 * KnowledgePackInstall — install a Cupboard knowledge pack INTO a pot, in place,
 * with the per-item conflict review (cupboard-public-release-2026-07-12 P-016,
 * owner ruling 2026-07-12 "the Cupboard is the pack surface"). This REPLACES the
 * old detail-page "fetched — now go to the Learning tab" dead-end toast: pick a
 * pot, install (stage-from-Comb + classify), resolve any duplicate/conflict
 * clashes, then manage the installed pack (mute / upgrade / uninstall) — all
 * from the listing page.
 *
 * The install contract is the SAME one the knowledge_packs:* MCP verbs and the
 * /api/knowledge-packs/* routes serve (packages/operator-core/lib/knowledge-
 * packs/manage.ts, endpoint-route/routes/knowledge-packs.ts): install/upgrade
 * return `review_required` + a per-item report when a non-empty pool clashes,
 * and re-submit with explicit resolutions. This component is a thin driver over
 * those routes + the learning.hiveList / knowledgePacks.list / learning.hive
 * sync reads — no UI-side re-derivation of the review.
 */

import React, { useMemo, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { toast } from 'sonner';
import {
  Loader2, Plug, ArrowUpCircle, Trash2, BellOff, Bell, CheckCircle2, Package,
} from 'lucide-react';
import type { HarnessListing } from '@papercusp/operator-core/lib/cupboard/types';
import { COLORS, FONTS, RADIUS, SIZES } from '../cupboard-theme';
import { useLexicon } from '@/lib/useLexicon';
import { Select } from '@/app/harness/Select';

// ── Contract mirror (UI-local; server types live in operator-core/lib/knowledge-
//    packs/manage.ts — kept as plain interfaces so the client bundle never pulls
//    the server module). ──────────────────────────────────────────────────────
type InstallAction = 'install' | 'skip' | 'replace' | 'keep-both';
interface InstallClassification {
  itemId: string;
  title: string;
  incoming: string;
  status: 'present' | 'clean' | 'duplicate' | 'conflict';
  existing?: { id: string; text: string; organic: boolean; packId?: string; score?: number };
  summary?: string;
  defaultAction: InstallAction;
}
interface InstallReview {
  packId: string;
  packVersion: string;
  items: InstallClassification[];
  clean: number;
  duplicates: number;
  conflicts: number;
  present: number;
}
interface ApplyResult {
  ok: boolean;
  packId: string;
  packVersion: string;
  installed: number;
  skipped: number;
  replaced: number;
  failed: number;
  error?: string;
}
interface PackSummary {
  id: string;
  title: string;
  description: string;
  version: string;
  author?: string;
  itemCount: number;
  source: string;
}
interface HivePackRollup {
  packId: string;
  packVersion?: string;
  present: number;
  modified: number;
  notPresent: number;
  packTotal?: number;
  enabled?: boolean;
  updateAvailable?: boolean;
  availableVersion?: string;
}
interface HiveLearningsSnapshot {
  hive: string;
  packs: HivePackRollup[];
  unavailable?: boolean;
}
interface HiveRow { slug: string; remote: boolean }

type ReviewSource = 'install' | 'upgrade';

const ACTION_LABEL: Record<InstallAction, string> = {
  install: 'Add',
  skip: 'Skip — keep existing',
  replace: 'Replace existing',
  'keep-both': 'Keep both',
};

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

const btn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5,
  padding: '6px 12px', fontFamily: FONTS.ui, fontSize: SIZES.sm, fontWeight: 600,
  border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.md,
  background: COLORS.surfaceRaised, color: COLORS.text, cursor: 'pointer',
};
const btnPrimary: React.CSSProperties = {
  ...btn, border: `1px solid ${COLORS.accent}`,
  background: 'color-mix(in srgb, var(--accent), transparent 82%)', color: COLORS.text,
};
const btnDanger: React.CSSProperties = {
  ...btn, border: `1px solid ${COLORS.danger}`, color: COLORS.dangerText,
  background: 'color-mix(in srgb, var(--bad), transparent 90%)',
};

/** The install/upgrade panel for a knowledge-pack listing. */
export default function KnowledgePackInstall({ listing }: { listing: HarnessListing }) {
  const t = useLexicon();
  const potWord = t('pot', { lower: true });

  const hivesQ = useSyncQuery<HiveRow>({ queryName: 'learning.hiveList', args: {}, staleTime: 60_000 });
  const hives = useMemo(() => hivesQ.data ?? [], [hivesQ.data]);
  const [hiveSel, setHiveSel] = useState<string>('');
  const hive = hiveSel || hives[0]?.slug || '';

  const catalogQ = useSyncQuery<PackSummary>({ queryName: 'knowledgePacks.list', args: {}, staleTime: 60_000 });
  const [stagedPackId, setStagedPackId] = useState<string | null>(null);
  // A pack must be staged locally before it can install into any pot, so a
  // locally-installed pack is always in this catalog — match the listing to it
  // to reflect install state without a network probe. The pack id === the
  // listing's `listing_ref` (the pack lives at knowledge-packs/<listing_ref>/;
  // `slug` is null on knowledge-pack rows), with slug/title as fallbacks.
  const catalogMatch = useMemo<PackSummary | null>(() => {
    const rows = catalogQ.data ?? [];
    const ref = norm(listing.listing_ref);
    return (
      (ref ? rows.find((r) => norm(r.id) === ref) : undefined) ??
      (listing.slug ? rows.find((r) => norm(r.id) === norm(listing.slug)) : undefined) ??
      rows.find((r) => norm(r.title) === norm(listing.title)) ??
      null
    );
  }, [catalogQ.data, listing.listing_ref, listing.slug, listing.title]);
  const packId = stagedPackId ?? catalogMatch?.id ?? null;

  const hiveQ = useSyncQuery<HiveLearningsSnapshot>({
    queryName: 'learning.hive',
    args: { hive },
    enabled: hive.length > 0,
    staleTime: 30_000,
  });
  const rollup = useMemo<HivePackRollup | null>(() => {
    if (!packId) return null;
    return (hiveQ.data?.[0]?.packs ?? []).find((p) => p.packId === packId) ?? null;
  }, [hiveQ.data, packId]);
  const installedHere = rollup !== null && rollup.present > 0;
  const enabledHere = rollup?.enabled !== false;

  const [busy, setBusy] = useState<string | null>(null);
  const [review, setReview] = useState<InstallReview | null>(null);
  const [reviewSource, setReviewSource] = useState<ReviewSource>('install');
  const [resolutions, setResolutions] = useState<Record<string, InstallAction>>({});
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState(false);

  const refresh = () => { hiveQ.invalidate(); catalogQ.invalidate(); };

  async function stageIfNeeded(): Promise<string | null> {
    if (packId) return packId;
    const r = await fetch('/api/knowledge-packs/fetch-from-comb', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listingId: listing.id }),
    });
    const d = (await r.json().catch(() => ({}))) as {
      ok?: boolean; pack?: { id: string; title: string; version: string; itemCount: number };
      error?: string; detail?: string;
    };
    if (!r.ok || !d.ok || !d.pack) {
      toast.error(`Couldn't fetch the pack: ${d.error ?? `HTTP ${r.status}`}${d.detail ? ` — ${d.detail}` : ''}`);
      return null;
    }
    setStagedPackId(d.pack.id);
    catalogQ.invalidate();
    return d.pack.id;
  }

  async function postPackAction(
    endpoint: ReviewSource,
    id: string,
    res?: Array<{ itemId: string; action: InstallAction }>,
  ): Promise<void> {
    const r = await fetch(`/api/knowledge-packs/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hive, pack: id, ...(res ? { resolutions: res } : {}) }),
    });
    const d = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (d.reason === 'review_required' && d.review) {
      const rev = d.review as InstallReview;
      setReview(rev);
      setReviewSource(endpoint);
      setResolutions(
        Object.fromEntries(
          rev.items
            .filter((it) => it.status === 'duplicate' || it.status === 'conflict')
            .map((it) => [it.itemId, it.defaultAction]),
        ),
      );
      return;
    }
    if (d.upToDate === true) {
      toast.success(`Already up to date in ${hive}.`);
      setReview(null);
      refresh();
      return;
    }
    if (typeof d.installed !== 'number' || d.ok === false) {
      toast.error(
        `${endpoint === 'upgrade' ? 'Upgrade' : 'Install'} failed: ` +
          `${(d.error as string) ?? `HTTP ${r.status}`}${d.detail ? ` — ${d.detail as string}` : ''}`,
      );
      return;
    }
    const applied = d as unknown as ApplyResult;
    setResult(applied);
    setReview(null);
    refresh();
    toast.success(
      `${endpoint === 'upgrade' ? 'Upgraded' : 'Installed'} into ${hive}: ` +
        `${applied.installed} added, ${applied.replaced} replaced, ${applied.skipped} skipped` +
        (applied.failed ? `, ${applied.failed} failed` : '') + '.',
    );
  }

  async function doInstall() {
    if (!hive || busy) return;
    setBusy('install');
    setResult(null);
    try {
      const id = await stageIfNeeded();
      if (!id) return;
      await postPackAction('install', id);
    } catch (e) {
      toast.error(`Install crashed: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function applyReview() {
    if (!review || !packId || busy) return;
    setBusy('apply');
    try {
      const res = review.items
        .filter((it) => it.status === 'duplicate' || it.status === 'conflict')
        .map((it) => ({ itemId: it.itemId, action: resolutions[it.itemId] ?? it.defaultAction }));
      await postPackAction(reviewSource, packId, res);
    } catch (e) {
      toast.error(`Apply crashed: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function doUpgrade() {
    if (!packId || busy) return;
    setBusy('upgrade');
    setResult(null);
    try {
      await postPackAction('upgrade', packId);
    } catch (e) {
      toast.error(`Upgrade crashed: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function doSetEnabled(next: boolean) {
    if (!packId || busy) return;
    setBusy('mute');
    try {
      const r = await fetch('/api/knowledge-packs/set-enabled', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hive, pack: packId, enabled: next }),
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok || !d.ok) { toast.error(`Couldn't ${next ? 'unmute' : 'mute'}: ${d.error ?? `HTTP ${r.status}`}`); return; }
      toast.success(
        next
          ? `Unmuted in ${hive} — its learnings are recalled again.`
          : `Muted in ${hive} — its learnings stay stored but stop being recalled.`,
      );
      refresh();
    } catch (e) {
      toast.error(`Crashed: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function doUninstall() {
    if (!packId || busy) return;
    setBusy('uninstall');
    try {
      const r = await fetch('/api/knowledge-packs/uninstall', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hive, pack: packId }),
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; removed?: number; kept?: number; error?: string };
      if (!r.ok || !d.ok) { toast.error(`Uninstall failed: ${d.error ?? `HTTP ${r.status}`}`); return; }
      toast.success(`Uninstalled from ${hive}: ${d.removed ?? 0} removed${d.kept ? `, ${d.kept} edited row(s) kept` : ''}.`);
      setConfirmUninstall(false);
      setResult(null);
      refresh();
    } catch (e) {
      toast.error(`Uninstall crashed: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  const noHives = !hivesQ.loading && hives.length === 0;
  const reviewItems = review?.items.filter((it) => it.status === 'duplicate' || it.status === 'conflict') ?? [];

  return (
    <div
      data-testid="cupboard-kp-install"
      style={{
        marginTop: SIZES.md, background: COLORS.surface, border: `1px solid ${COLORS.border}`,
        borderRadius: RADIUS.lg, padding: SIZES.md,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Package size={14} style={{ color: COLORS.accent }} />
        <strong style={{ fontFamily: FONTS.ui, fontSize: SIZES.md, color: COLORS.text }}>
          Add to a {potWord}
        </strong>
      </div>
      <p style={{ fontFamily: FONTS.ui, fontSize: 11.5, color: COLORS.textMuted, margin: '4px 0 0' }}>
        Installs this pack&rsquo;s learnings into a {potWord}&rsquo;s shared memory. Anything that clashes with the {potWord}&rsquo;s
        existing learnings is held for a per-item conflict review — nothing is written until you resolve it.
      </p>

      {noHives ? (
        <p style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted, marginTop: SIZES.sm }}>
          No {t('pot', { plural: true, lower: true })} yet — create one, then install this pack into it.
        </p>
      ) : (
        <>
          {/* Pot picker + primary action */}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: SIZES.sm }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: FONTS.ui, fontSize: SIZES.sm, color: COLORS.textMuted }}>
              {potWord}
              <Select
                testId="cupboard-kp-pot-select"
                ariaLabel={potWord}
                value={hive}
                onChange={setHiveSel}
                disabled={busy !== null}
                options={hives.map((h) => ({ value: h.slug, label: `${h.slug}${h.remote ? ' (joined)' : ''}` }))}
                triggerStyle={{
                  fontFamily: FONTS.ui, fontSize: SIZES.sm, color: COLORS.text,
                  background: COLORS.surfaceRaised, border: `1px solid ${COLORS.border}`,
                  borderRadius: RADIUS.md, padding: '4px 8px', maxWidth: 220,
                }}
              />
            </span>

            {installedHere ? (
              <span
                data-testid="cupboard-kp-installed-badge"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: FONTS.ui, fontSize: 11.5, color: COLORS.successText }}
              >
                <CheckCircle2 size={13} /> Installed{rollup?.packTotal ? ` · ${rollup.present}/${rollup.packTotal}` : ''}
                {!enabledHere ? ' · muted' : ''}
              </span>
            ) : (
              <button
                type="button"
                data-testid="cupboard-kp-install-btn"
                onClick={() => void doInstall()}
                disabled={busy !== null || !hive}
                style={{ ...btnPrimary, opacity: busy || !hive ? 0.7 : 1 }}
              >
                {busy === 'install' ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Plug size={13} />}
                Install into {potWord}
              </button>
            )}
          </div>

          {/* Manage row — only once the pack is installed in the selected pot */}
          {installedHere && !review && (
            <div data-testid="cupboard-kp-manage" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: SIZES.sm }}>
              {rollup?.updateAvailable && (
                <button
                  type="button"
                  data-testid="cupboard-kp-upgrade"
                  onClick={() => void doUpgrade()}
                  disabled={busy !== null}
                  style={btnPrimary}
                >
                  {busy === 'upgrade' ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <ArrowUpCircle size={13} />}
                  Upgrade{rollup.availableVersion ? ` → v${rollup.availableVersion}` : ''}
                </button>
              )}
              <button
                type="button"
                data-testid="cupboard-kp-mute"
                onClick={() => void doSetEnabled(!enabledHere)}
                disabled={busy !== null}
                style={btn}
              >
                {busy === 'mute' ? (
                  <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
                ) : enabledHere ? <BellOff size={13} /> : <Bell size={13} />}
                {enabledHere ? 'Mute' : 'Unmute'}
              </button>
              {confirmUninstall ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <button
                    type="button"
                    data-testid="cupboard-kp-uninstall-confirm"
                    onClick={() => void doUninstall()}
                    disabled={busy !== null}
                    style={btnDanger}
                  >
                    {busy === 'uninstall' ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Trash2 size={13} />}
                    Confirm uninstall
                  </button>
                  <button type="button" onClick={() => setConfirmUninstall(false)} disabled={busy !== null} style={btn}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  data-testid="cupboard-kp-uninstall"
                  onClick={() => setConfirmUninstall(true)}
                  disabled={busy !== null}
                  style={btn}
                >
                  <Trash2 size={13} /> Uninstall
                </button>
              )}
            </div>
          )}
        </>
      )}

      {/* Conflict review — the per-item merge decisions (D-003). */}
      {review && (
        <div data-testid="cupboard-kp-review" style={{ marginTop: SIZES.md, borderTop: `1px solid ${COLORS.border}`, paddingTop: SIZES.md }}>
          <div style={{ fontFamily: FONTS.ui, fontSize: SIZES.sm, fontWeight: 600, color: COLORS.text }}>
            Review {reviewItems.length} clash{reviewItems.length === 1 ? '' : 'es'} before adding
          </div>
          <p style={{ fontFamily: FONTS.ui, fontSize: 11.5, color: COLORS.textMuted, margin: '4px 0 10px' }}>
            {review.clean} clean learning{review.clean === 1 ? '' : 's'} will be added automatically. Existing content is
            preselected to win — override per item below.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {reviewItems.map((it) => (
              <div
                key={it.itemId}
                style={{ border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.md, padding: SIZES.sm, background: COLORS.surfaceRaised }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontFamily: FONTS.ui, fontSize: 12, fontWeight: 600, color: COLORS.text }}>
                    {it.title || it.itemId}
                  </span>
                  <span
                    style={{
                      fontFamily: FONTS.ui, fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
                      color: it.status === 'conflict' ? COLORS.dangerText : COLORS.textMuted,
                      border: `1px solid ${it.status === 'conflict' ? COLORS.danger : COLORS.border}`,
                      borderRadius: 999, padding: '1px 7px',
                    }}
                  >
                    {it.status}
                  </span>
                </div>
                <div style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.textMuted, marginTop: 5, whiteSpace: 'pre-wrap' }}>
                  <span style={{ color: COLORS.accent }}>incoming:</span> {it.incoming}
                </div>
                {it.existing && (
                  <div style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.textMuted, marginTop: 3, whiteSpace: 'pre-wrap' }}>
                    <span style={{ color: COLORS.textMuted }}>existing:</span> {it.existing.text}
                    {typeof it.existing.score === 'number' ? ` (${Math.round(it.existing.score * 100)}% match)` : ''}
                  </div>
                )}
                {it.summary && (
                  <div style={{ fontFamily: FONTS.ui, fontSize: 11, color: COLORS.textMuted, marginTop: 3, fontStyle: 'italic' }}>
                    {it.summary}
                  </div>
                )}
                <Select
                  ariaLabel={`Resolution for ${it.title || it.itemId}`}
                  value={resolutions[it.itemId] ?? it.defaultAction}
                  onChange={(v) => setResolutions((cur) => ({ ...cur, [it.itemId]: v as InstallAction }))}
                  disabled={busy !== null}
                  options={(['install', 'skip', 'replace', 'keep-both'] as InstallAction[]).map((a) => ({ value: a, label: ACTION_LABEL[a] }))}
                  triggerStyle={{
                    marginTop: 7, fontFamily: FONTS.ui, fontSize: SIZES.sm, color: COLORS.text,
                    background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.md, padding: '4px 8px',
                  }}
                />
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: SIZES.md }}>
            <button
              type="button"
              data-testid="cupboard-kp-apply"
              onClick={() => void applyReview()}
              disabled={busy !== null}
              style={btnPrimary}
            >
              {busy === 'apply' ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <CheckCircle2 size={13} />}
              Apply &amp; add
            </button>
            <button type="button" onClick={() => setReview(null)} disabled={busy !== null} style={btn}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Applied summary */}
      {result && !review && (
        <p data-testid="cupboard-kp-result" style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.successText, marginTop: SIZES.sm }}>
          <CheckCircle2 size={12} style={{ verticalAlign: '-2px' }} /> Done: {result.installed} added, {result.replaced} replaced,{' '}
          {result.skipped} skipped{result.failed ? `, ${result.failed} failed` : ''}.
        </p>
      )}
    </div>
  );
}
