'use client';

/**
 * InstalledPacksSection — the per-pot "what knowledge packs are installed here"
 * overview on the Cupboard storefront's Knowledge Packs tab
 * (cupboard-public-release-2026-07-12 P-016, "the Cupboard is the pack
 * surface"). Reads the selected pot's pack rollups (learning.hive) and lists
 * them; each row deep-links to that pack's listing detail page, where the full
 * install / mute / upgrade / uninstall controls live (KnowledgePackInstall) —
 * so this is a pure overview + navigation surface, never a second copy of the
 * management logic.
 */

import React, { useMemo, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { Brain, BellOff, ArrowUpCircle, ChevronRight, CheckCircle2 } from 'lucide-react';
import type { HarnessListing } from '@papercusp/operator-core/lib/cupboard/types';
import { COLORS, FONTS, RADIUS, SIZES } from './cupboard-theme';
import { useLexicon } from '@/lib/useLexicon';
import { Select } from '@/app/harness/Select';
import { Tooltip } from '@/app/harness/Tooltip';

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

export default function InstalledPacksSection({
  listings,
  onOpen,
}: {
  listings: HarnessListing[];
  onOpen: (id: string | number) => void;
}) {
  const t = useLexicon();
  const potWord = t('pot', { lower: true });

  const hivesQ = useSyncQuery<HiveRow>({ queryName: 'learning.hiveList', args: {}, staleTime: 60_000 });
  const hives = useMemo(() => hivesQ.data ?? [], [hivesQ.data]);
  const [sel, setSel] = useState('');
  const hive = sel || hives[0]?.slug || '';

  const hiveQ = useSyncQuery<HiveLearningsSnapshot>({
    queryName: 'learning.hive',
    args: { hive },
    enabled: hive.length > 0,
    staleTime: 30_000,
  });
  const packs = useMemo(
    () => (hiveQ.data?.[0]?.packs ?? []).filter((p) => p.present > 0),
    [hiveQ.data],
  );

  const listingFor = (packId: string): HarnessListing | null =>
    listings.find((l) => (l.listing_ref ?? '').toLowerCase() === packId.toLowerCase()) ?? null;

  // No pots at all ⇒ nothing to manage; stay out of the way entirely.
  if (!hivesQ.loading && hives.length === 0) return null;

  return (
    <section
      data-testid="cupboard-installed-packs"
      style={{
        marginBottom: SIZES.lg, background: COLORS.surface, border: `1px solid ${COLORS.border}`,
        borderRadius: RADIUS.lg, padding: SIZES.md,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: FONTS.ui, fontWeight: 600, fontSize: 14, color: COLORS.text }}>
          <Brain size={13} /> Installed in
        </span>
        <Select
          testId="cupboard-installed-pot-select"
          ariaLabel="Installed in"
          value={hive}
          onChange={setSel}
          options={hives.map((h) => ({ value: h.slug, label: `${h.slug}${h.remote ? ' (joined)' : ''}` }))}
          triggerStyle={{
            fontFamily: FONTS.ui, fontSize: SIZES.sm, color: COLORS.text,
            background: COLORS.surfaceRaised, border: `1px solid ${COLORS.border}`,
            borderRadius: RADIUS.md, padding: '4px 8px', maxWidth: 240,
          }}
        />
        <span style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted }}>
          {packs.length} pack{packs.length === 1 ? '' : 's'}
        </span>
      </div>

      {packs.length === 0 ? (
        <p style={{ fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted, margin: `${SIZES.sm} 0 0` }}>
          No knowledge packs installed in this {potWord} yet — open a pack below to install it.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: SIZES.sm }}>
          {packs.map((p) => {
            const l = listingFor(p.packId);
            const label = l?.title || p.packId;
            const muted = p.enabled === false;
            const rowInner = (
              <>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                  <CheckCircle2 size={13} style={{ color: COLORS.successText, flexShrink: 0 }} />
                  <span style={{ fontFamily: FONTS.ui, fontSize: 13, color: COLORS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {label}
                  </span>
                  <span style={{ fontFamily: FONTS.mono, fontSize: 11, color: COLORS.textMuted, flexShrink: 0 }}>
                    {p.present}{p.packTotal ? `/${p.packTotal}` : ''}
                  </span>
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  {muted && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontFamily: FONTS.ui, fontSize: 10.5, color: COLORS.textMuted }}>
                      <BellOff size={11} /> muted
                    </span>
                  )}
                  {p.updateAvailable && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontFamily: FONTS.ui, fontSize: 10.5, color: COLORS.accent }}>
                      <ArrowUpCircle size={11} /> update{p.availableVersion ? ` v${p.availableVersion}` : ''}
                    </span>
                  )}
                  {l && <ChevronRight size={14} style={{ color: COLORS.textMuted }} />}
                </span>
              </>
            );
            const rowStyle: React.CSSProperties = {
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
              width: '100%', padding: '7px 10px', textAlign: 'left',
              border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.md, background: COLORS.surfaceRaised,
            };
            return l ? (
              <Tooltip key={p.packId} label={`Manage "${label}" in ${hive}`}>
                <button
                  type="button"
                  data-testid="cupboard-installed-pack-row"
                  onClick={() => onOpen(l.id)}
                  style={{ ...rowStyle, cursor: 'pointer', color: COLORS.text, fontFamily: FONTS.ui }}
                >
                  {rowInner}
                </button>
              </Tooltip>
            ) : (
              <div
                key={p.packId}
                data-testid="cupboard-installed-pack-row"
                style={rowStyle}
                title={`${p.packId} has no Cupboard listing — manage it from the ${potWord}'s Learning tab.`}
              >
                {rowInner}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
