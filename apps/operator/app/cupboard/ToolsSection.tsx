'use client';


import { Tooltip } from '@/app/harness/Tooltip';
/**
 * ToolsSection — the Cupboard's tool-level discovery view
 * (tool-distribution-granularity-2026-06-05 P-006 / D-002 / D-005 +
 * tool-distribution-discovery-2026-06-08 P-007).
 *
 * Renders `GET /api/cupboard/tools`: every known tool resolved to its
 * provider — built-ins, installed plugin/pack tools, and Cupboard-installable
 * declarations (`provides_tools`). A tool never installs in isolation (D-005):
 * the install action routes to the PROVIDING listing's detail page, where the
 * existing install-consent flow executes.
 *
 * Discovery (P-007): the shared search box runs capability search (the server
 * relevance-ranks over name/category/capability/provider/description); a status
 * filter (All / Available / Installable) and category facets (the tool
 * namespace, e.g. `coord:*`) narrow the result. Both are URL-backed (the parent
 * owns the nuqs state) so an agent can drive them via `ui:dispatch`.
 *
 * Status semantics mirror the resolver ladder:
 *   available   → usable now (chip: Built-in / Installed · <unit>)
 *   installable → a Cupboard unit provides it (button: Install <unit> → listing)
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Wrench, Plug, Box, AlertTriangle, RefreshCw } from 'lucide-react';
import { COLORS, FONTS, RADIUS, SIZES } from './cupboard-theme';
import { CupboardErrorState, cupboardHttpError } from './CupboardErrorState';

export type ToolStatusFilter = 'all' | 'available' | 'installable';

export interface ToolDiscoveryEntry {
  tool: string;
  status: 'available' | 'installable';
  category: string;
  description?: string | null;
  capability?: string | null;
  provider: { kind: 'builtin' | 'plugin' | 'pack'; name: string; listingId?: string | null };
  unit?: {
    name: string;
    kind: 'plugin' | 'pack';
    source: 'installed' | 'cupboard';
    description?: string | null;
    version?: string | null;
    listingId?: string | null;
  };
}

interface CategoryFacet {
  name: string;
  count: number;
}

interface ToolsPayload {
  tools: ToolDiscoveryEntry[];
  counts: { available: number; installable: number };
  categories: CategoryFacet[];
  cupboardReachable: boolean;
}

const toolRefreshStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--bg-2)',
  border: '1px solid var(--border)',
  borderRadius: 999,
  padding: '7px 10px',
  cursor: 'pointer',
  color: 'var(--fg-mute)',
};

/** Flat filter chip (design HR9): tinted fill when active, colour-not-elevation. */
const chipStyle = (active: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  background: active ? 'color-mix(in oklab, var(--accent), transparent 84%)' : 'var(--bg-2)',
  color: active ? COLORS.text : COLORS.textMuted,
  border: `1px solid ${active ? 'color-mix(in oklab, var(--accent), transparent 55%)' : COLORS.border}`,
  borderRadius: 999,
  padding: '5px 10px',
  cursor: 'pointer',
  fontSize: 11,
  fontFamily: FONTS.ui,
});

const STATUS_FILTERS: { key: ToolStatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'available', label: 'Available' },
  { key: 'installable', label: 'Installable' },
];

function UnitIcon({ kind, size = 11 }: { kind: 'plugin' | 'pack'; size?: number }) {
  return kind === 'pack' ? <Box size={size} /> : <Plug size={size} />;
}

export function ToolsSection({
  q,
  onOpenListing,
  status = 'all',
  category = null,
  onStatusChange,
  onCategoryChange,
}: {
  /** Search text (shared with the storefront search box) — runs capability search. */
  q: string;
  /** Open a providing listing's detail page (the act-on/install surface). */
  onOpenListing: (listingId: string) => void;
  /** Resolution-status filter (URL-backed by the parent). */
  status?: ToolStatusFilter;
  /** Selected category namespace, or null for all (URL-backed by the parent). */
  category?: string | null;
  onStatusChange?: (status: ToolStatusFilter) => void;
  onCategoryChange?: (category: string | null) => void;
}) {
  const [payload, setPayload] = useState<ToolsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchTools = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (status !== 'all') params.set('status', status);
      if (category) params.set('category', category);
      const res = await fetch(`/api/cupboard/tools?${params}`, { signal: ctrl.signal });
      if (!res.ok) throw await cupboardHttpError(res);
      const data = (await res.json()) as ToolsPayload;
      if (!ctrl.signal.aborted) setPayload(data);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError(String(err));
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, [q, status, category]);

  useEffect(() => {
    void fetchTools();
  }, [fetchTools]);

  // The category chips are the server's facets, plus the active one even if the
  // current search filtered it out of the facet set (so it stays clearable).
  const categoryChips = useMemo(() => {
    const facets = payload?.categories ?? [];
    if (category && !facets.some((c) => c.name === category)) {
      return [...facets, { name: category, count: 0 }];
    }
    return facets;
  }, [payload?.categories, category]);

  return (
    <div data-testid="cupboard-tools-section">
      {/* Counts + degraded banner */}
      {payload && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: SIZES.sm, flexWrap: 'wrap',
            marginBottom: SIZES.md,
            padding: 12,
            border: `1px solid ${COLORS.border}`,
            borderRadius: RADIUS.lg,
            background: 'var(--bg-2)',
            fontFamily: FONTS.ui,
            fontSize: 12,
            color: COLORS.textMuted,
          }}
        >
          <span
            data-testid="cupboard-tools-counts"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: COLORS.text }}
          >
            <Wrench size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            {payload.counts.available} available · {payload.counts.installable} installable
          </span>
          {!payload.cupboardReachable && (
            <span
              data-testid="cupboard-tools-degraded"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--warn)' }}
            >
              <AlertTriangle size={12} /> Cupboard unreachable — showing local tools only
            </span>
          )}
          <Tooltip label="Refresh tools"><button
            onClick={fetchTools}
            disabled={loading}

            style={{ ...toolRefreshStyle, marginLeft: 'auto' }}
          >
            <RefreshCw size={12} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
          </button></Tooltip>
        </div>
      )}

      {/* Discovery filters — status (resolution) + category facets (P-007) */}
      {payload && (
        <div
          data-testid="cupboard-tools-filters"
          style={{
            display: 'flex', flexDirection: 'column', gap: 8,
            marginBottom: SIZES.md,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {STATUS_FILTERS.map((s) => (
              <button
                key={s.key}
                data-testid="cupboard-tool-status-filter"
                data-status={s.key}
                aria-pressed={status === s.key}
                onClick={() => onStatusChange?.(s.key)}
                style={chipStyle(status === s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>
          {categoryChips.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <button
                data-testid="cupboard-tool-category"
                data-cat="all"
                aria-pressed={!category}
                onClick={() => onCategoryChange?.(null)}
                style={chipStyle(!category)}
              >
                All categories
              </button>
              {categoryChips.map((c) => (
                <button
                  key={c.name}
                  data-testid="cupboard-tool-category"
                  data-cat={c.name}
                  aria-pressed={category === c.name}
                  onClick={() => onCategoryChange?.(category === c.name ? null : c.name)}
                  style={chipStyle(category === c.name)}
                >
                  <code style={{ fontFamily: FONTS.mono, fontSize: 10 }}>{c.name}</code>
                  <span style={{ color: COLORS.textDim }}>{c.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {error && !loading && (
        <CupboardErrorState raw={error} what="tools" onRetry={() => void fetchTools()} />
      )}

      {!loading && !error && payload && payload.tools.length === 0 && (
        <div style={{ color: COLORS.textMuted, fontSize: 12, textAlign: 'center', padding: '44px 18px', border: `1px dashed ${COLORS.borderStrong}`, borderRadius: RADIUS.lg, background: 'var(--bg-2)' }}>
          No tools found{q ? ` matching "${q}"` : ''}{category ? ` in ${category}` : ''}.
        </div>
      )}

      {/* Tool rows */}
      {payload && payload.tools.length > 0 && (
        <div
          style={{
            border: `1px solid ${COLORS.border}`,
            borderRadius: 14,
            background: 'linear-gradient(180deg, var(--bg-popover), color-mix(in srgb, var(--bg-1), transparent 8%))',
            overflow: 'hidden',
            boxShadow: '0 18px 42px rgba(0,0,0,0.22)',
          }}
        >
          {payload.tools.map((t, i) => (
            <div
              key={t.tool}
              data-testid="cupboard-tool-row"
              data-tool={t.tool}
              data-status={t.status}
              data-category={t.category}
              style={{
                display: 'flex', alignItems: 'center', gap: SIZES.sm, flexWrap: 'wrap',
                padding: '12px 14px',
                borderTop: i === 0 ? 'none' : `1px solid ${COLORS.border}`,
              }}
            >
              <code style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.text, background: 'var(--bg-1)', border: `1px solid ${COLORS.border}`, borderRadius: 999, padding: '3px 8px' }}>{t.tool}</code>

              {/* Provider attribution */}
              {t.provider.kind === 'builtin' ? (
                <span
                  data-testid="cupboard-tool-provider"
                  style={{
                    fontSize: 11, fontFamily: FONTS.ui, color: COLORS.textMuted,
                    border: `1px solid ${COLORS.border}`, borderRadius: 999, padding: '3px 8px',
                    background: 'var(--bg-1)',
                  }}
                >
                  Built-in
                </span>
              ) : (
                <span
                  data-testid="cupboard-tool-provider"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    fontSize: 11, fontFamily: FONTS.ui, color: COLORS.textMuted,
                    border: `1px solid ${COLORS.border}`, borderRadius: 999, padding: '3px 8px',
                    background: 'var(--bg-1)',
                  }}
                  title={t.unit?.description ?? undefined}
                >
                  <UnitIcon kind={(t.unit?.kind ?? t.provider.kind) as 'plugin' | 'pack'} />
                  {t.provider.name}
                  {t.unit?.version ? ` v${t.unit.version}` : ''}
                </span>
              )}

              {/* Status / action */}
              <span style={{ marginLeft: 'auto' }}>
                {t.status === 'available' ? (
                  <span
                    data-testid="cupboard-tool-available"
                    style={{ fontSize: 11, fontFamily: FONTS.ui, color: 'var(--good)', border: '1px solid color-mix(in srgb, var(--good), transparent 76%)', background: 'color-mix(in srgb, var(--good), transparent 88%)', borderRadius: 999, padding: '3px 8px' }}
                  >
                    {t.provider.kind === 'builtin' ? 'Available' : 'Installed'}
                  </span>
                ) : (
                  <button
                    data-testid="cupboard-tool-install"
                    disabled={!(t.provider.listingId ?? t.unit?.listingId)}
                    onClick={() => {
                      const id = t.provider.listingId ?? t.unit?.listingId;
                      if (id) onOpenListing(id);
                    }}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      background: 'var(--accent)',
                      color: 'var(--accent-ink)',
                      border: '1px solid var(--accent-strong)',
                      borderRadius: 8,
                      padding: '5px 10px',
                      cursor: 'pointer',
                      fontSize: 11,
                      fontFamily: FONTS.ui,
                    }}
                  >
                    <Plug size={11} /> Install {t.provider.name}
                  </button>
                )}
              </span>

              {/* Capability description — full-width line under the tool (P-007) */}
              {t.description && (
                <div
                  data-testid="cupboard-tool-desc"
                  style={{
                    flexBasis: '100%',
                    fontSize: 11,
                    lineHeight: 1.45,
                    fontFamily: FONTS.ui,
                    color: COLORS.textMuted,
                    marginTop: 2,
                  }}
                >
                  {t.description}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
