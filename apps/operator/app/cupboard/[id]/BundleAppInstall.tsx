'use client';

/**
 * BundleAppInstall — install a Cupboard BUNDLE app (delivery_type: 'bundle')
 * into this workspace, with the one-shot conflict review
 * (cupboard-app-distribution-2026-07-14 P-008, generalizing the P-016
 * knowledge-pack install pattern — see KnowledgePackInstall.tsx).
 *
 * Unlike a knowledge pack's per-item resolution (a pack can have dozens of
 * clashing learnings), a bundle app's units are few and its `installBundleApp`
 * core already does review+install in ONE call: clean + duplicate units
 * install automatically, and any unresolved conflict BLOCKS the whole install
 * (nothing partial) unless the caller opts in. So the UI here is simpler than
 * KnowledgePackInstall's per-item resolver: click Install; on a conflict, show
 * what collided and offer "Install anyway" (re-submits with
 * `allowConflicts: true`) rather than a per-item picker.
 */

import React, { useState } from 'react';
import { Loader2, Plug, CheckCircle2, AlertTriangle, Package } from 'lucide-react';
import type { HarnessListing } from '@papercusp/operator-core/lib/cupboard/types';
import { COLORS, FONTS, RADIUS, SIZES } from '../cupboard-theme';
import { toast } from 'sonner';

interface BundleUnitClassification {
  kind: 'datatype' | 'pack' | 'plugin' | 'blueprint';
  ref: string;
  status: 'clean' | 'duplicate' | 'conflict';
  detail?: string;
}
interface BundleInstallReview {
  clean: BundleUnitClassification[];
  duplicates: BundleUnitClassification[];
  conflicts: BundleUnitClassification[];
}
interface BundleAppInstallResponse {
  manifest?: { name: string; description?: string };
  ok?: boolean;
  review?: BundleInstallReview;
  blockedByConflicts?: boolean;
  deps?: { installed?: Array<{ name: string; kind: string }> } | null;
  datatypes?: Array<{ id: string; ok: boolean; error?: string }>;
  blueprint?: { id: string; ok: boolean; error?: string } | null;
  error?: string;
  detail?: string;
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

function unitLabel(u: BundleUnitClassification): string {
  return `${u.kind}: ${u.ref}${u.detail ? ` — ${u.detail}` : ''}`;
}

export default function BundleAppInstall({ listing }: { listing: HarnessListing }) {
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<BundleAppInstallResponse | null>(null);

  async function doInstall(allowConflicts: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/cupboard/install-app', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ listingId: listing.id, allowConflicts }),
      });
      const d = (await r.json().catch(() => ({}))) as BundleAppInstallResponse;
      if (!r.ok && !d.review) {
        toast.error(`Install failed: ${d.error ?? `HTTP ${r.status}`}${d.detail ? ` — ${d.detail}` : ''}`);
        setResponse(null);
        return;
      }
      setResponse(d);
      if (d.blockedByConflicts) {
        toast.error(`${d.review?.conflicts.length ?? 0} conflict(s) blocked the install — review below.`);
      } else if (d.ok) {
        toast.success(`"${d.manifest?.name ?? listing.title}" installed.`);
      } else {
        toast.error('Install completed with failures — see the summary below.');
      }
    } catch (e) {
      toast.error(`Install crashed: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const review = response?.review;
  const installedUnits = response?.deps?.installed ?? [];
  const okDatatypes = (response?.datatypes ?? []).filter((d) => d.ok);
  const failedDatatypes = (response?.datatypes ?? []).filter((d) => !d.ok);

  return (
    <div
      data-testid="cupboard-bundle-app-install"
      style={{
        marginTop: SIZES.md, background: COLORS.surface, border: `1px solid ${COLORS.border}`,
        borderRadius: RADIUS.lg, padding: SIZES.md,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Package size={14} style={{ color: COLORS.accent }} />
        <strong style={{ fontFamily: FONTS.ui, fontSize: SIZES.md, color: COLORS.text }}>
          Install this bundle app
        </strong>
      </div>
      <p style={{ fontFamily: FONTS.ui, fontSize: 11.5, color: COLORS.textMuted, margin: '4px 0 0' }}>
        Installs this bundle&rsquo;s declared datatypes, packs, plugins, and blueprint into this workspace, through the
        same installers each kind normally uses. Anything that clashes with what&rsquo;s already installed blocks the
        whole install until you confirm.
      </p>

      {!response?.blockedByConflicts && (
        <div style={{ marginTop: SIZES.sm }}>
          <button
            type="button"
            data-testid="cupboard-bundle-app-install-btn"
            onClick={() => void doInstall(false)}
            disabled={busy}
            style={{ ...btnPrimary, opacity: busy ? 0.7 : 1 }}
          >
            {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Plug size={13} />}
            Install
          </button>
        </div>
      )}

      {/* Conflict block — mirrors KnowledgePackInstall's review styling, but a
          single "install anyway" action instead of a per-item resolver (the
          core blocks the WHOLE install on any conflict, not per-unit). */}
      {response?.blockedByConflicts && review && (
        <div data-testid="cupboard-bundle-app-review" style={{ marginTop: SIZES.md, borderTop: `1px solid ${COLORS.border}`, paddingTop: SIZES.md }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: FONTS.ui, fontSize: SIZES.sm, fontWeight: 600, color: COLORS.dangerText }}>
            <AlertTriangle size={14} />
            {review.conflicts.length} conflict{review.conflicts.length === 1 ? '' : 's'} blocked the install
          </div>
          <p style={{ fontFamily: FONTS.ui, fontSize: 11.5, color: COLORS.textMuted, margin: '4px 0 10px' }}>
            {review.clean.length} clean + {review.duplicates.length} already-present unit(s) were ready to go, but nothing was
            installed — a bundle install is all-or-nothing unless you confirm.
          </p>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {review.conflicts.map((c) => (
              <li
                key={`${c.kind}:${c.ref}`}
                style={{
                  fontFamily: FONTS.mono, fontSize: 11.5, color: COLORS.text,
                  border: `1px solid ${COLORS.danger}`, borderRadius: RADIUS.md, padding: '6px 10px',
                  background: 'color-mix(in srgb, var(--bad), transparent 92%)',
                }}
              >
                {unitLabel(c)}
              </li>
            ))}
          </ul>
          <div style={{ display: 'flex', gap: 8, marginTop: SIZES.md }}>
            <button
              type="button"
              data-testid="cupboard-bundle-app-install-anyway"
              onClick={() => void doInstall(true)}
              disabled={busy}
              style={{ ...btnDanger, opacity: busy ? 0.7 : 1 }}
            >
              {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <AlertTriangle size={13} />}
              Install anyway
            </button>
            <button type="button" onClick={() => setResponse(null)} disabled={busy} style={btn}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Applied summary */}
      {response && !response.blockedByConflicts && (response.ok || installedUnits.length > 0 || okDatatypes.length > 0) && (
        <div data-testid="cupboard-bundle-app-result" style={{ marginTop: SIZES.md, borderTop: `1px solid ${COLORS.border}`, paddingTop: SIZES.sm }}>
          <p style={{ fontFamily: FONTS.ui, fontSize: 12, color: response.ok ? COLORS.successText : COLORS.dangerText, margin: 0 }}>
            <CheckCircle2 size={12} style={{ verticalAlign: '-2px' }} />{' '}
            {response.ok ? 'Installed: ' : 'Completed with failures: '}
            {installedUnits.length} pack/plugin unit(s), {okDatatypes.length} datatype(s)
            {response.blueprint ? `, blueprint "${response.blueprint.id}" ${response.blueprint.ok ? 'ok' : 'FAILED'}` : ''}.
          </p>
          {failedDatatypes.length > 0 && (
            <p style={{ fontFamily: FONTS.ui, fontSize: 11.5, color: COLORS.dangerText, margin: '4px 0 0' }}>
              Failed datatypes: {failedDatatypes.map((d) => `${d.id} (${d.error})`).join(', ')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
