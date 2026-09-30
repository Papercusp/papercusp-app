'use client';

// Locally-installed harnesses — i.e. projects scaffolded into this
// workspace via marketplace install or `papercusp scaffold`. Distinct
// from the marketplace catalog view; this is "what do I have here?".
//
// Source of truth: /api/installed returns { projects, harnesses,
// staleCount }. Each project corresponds to one installed harness.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import RouteLink from '../../_components/RouteLink';
import { Button } from '../../harness/Button';
import { useLexicon } from '@/lib/useLexicon';
import { useRouter } from '@/lib/router-compat/navigation';
import { CreateHarnessPicker } from '../../harness/CreateHarnessPicker';
import { toast } from 'sonner';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import { Select } from '../../harness/Select';

interface ProjectRow {
  slug: string;
  path: string;
  harness_kind?: string;
  exists: boolean;
  addedAt?: string;
}

interface HarnessRow {
  slug: string;
  version: string | null;
  description: string | null;
}

interface InstalledResponse {
  projects: ProjectRow[];
  harnesses: HarnessRow[];
  staleCount: number;
}

const KIND_FILTERS = ['all', 'coding', 'org', 'department'] as const;
type KindFilter = (typeof KIND_FILTERS)[number];
const SORTS = ['recent', 'alpha', 'kind'] as const;
type SortMode = (typeof SORTS)[number];

function ProjectsGrid({ projects, allProjects }: { projects: ProjectRow[]; allProjects: ProjectRow[] }) {
  const router = useRouter();
  const openHarness = useCallback(
    (row: ProjectRow) => {
      if (!row.exists) return;
      router.push(`/harness?project=${encodeURIComponent(row.slug)}`);
    },
    [router],
  );
  const columns: ColumnDef<ProjectRow>[] = useMemo(() => [
    {
      key: 'slug',
      header: 'Slug',
      width: 1.4,
      render: ({ row }) => {
        const parent = parentSlugFor(row, allProjects);
        return (
          <span
            className="pc-installed-harness-slug"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              paddingLeft: parent ? 18 : 0,
              fontWeight: parent ? 520 : 650,
              opacity: row.exists ? 1 : 0.5,
            }}
          >
            {parent && <span aria-hidden style={{ color: 'var(--fg-dim)' }}>--</span>}
            {row.slug}
          </span>
        );
      },
    },
    {
      key: 'kind',
      header: 'Kind',
      width: 1.2,
      render: ({ row }) => (
        <span className="pc-installed-harness-kind" style={kindChipStyle(row.harness_kind, row.exists)}>
          {row.harness_kind ?? '—'}
        </span>
      ),
    },
    {
      key: 'path',
      header: 'Path',
      width: 2.4,
      render: ({ row }) => (
        <span
          className="pc-installed-harness-path"
          title={row.path}
          style={{ color: 'var(--fg-dim)', fontFamily: 'monospace', fontSize: 12, opacity: row.exists ? 1 : 0.5 }}
        >
          {displayPath(row)}
        </span>
      ),
    },
    {
      key: 'state',
      header: 'Activity',
      width: 1,
      render: ({ row }) => (
        row.exists ? (
          <span className="pc-installed-harness-state live" style={{ color: 'var(--good)' }}>● ready</span>
        ) : (
          <span className="pc-installed-harness-state stale" style={{ color: 'var(--fg-mute)' }} title="Project directory missing on disk">○ missing</span>
        )
      ),
    },
    {
      key: 'added',
      header: 'Added',
      width: 1.2,
      render: ({ row }) => (
        <span style={{ color: 'var(--fg-dim)', opacity: row.exists ? 1 : 0.5 }}>{fmtDate(row.addedAt)}</span>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: 0.8,
      align: 'right',
      render: ({ row }) => (
        row.exists ? (
          <Button asChild size="lg" variant="accent" className="pc-installed-harness-open">
            <RouteLink href={`/harness?project=${encodeURIComponent(row.slug)}`} style={{ padding: '4px 10px' }} onClick={(e) => e.stopPropagation()}>
              Open
            </RouteLink>
          </Button>
        ) : null
      ),
    },
  ], [allProjects]);

  return (
    <div className="pc-installed-harness-grid">
      <RichGrid<ProjectRow>
        columns={columns}
        rows={projects}
        getRowId={(p) => p.slug}
        inline
        onRowClick={(row) => openHarness(row)}
        rowProps={({ row }) => ({
          role: 'link',
          tabIndex: row.exists ? 0 : -1,
          'aria-label': row.exists ? `Open ${row.slug}` : `${row.slug} is missing on disk`,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              openHarness(row);
            }
          },
        })}
        empty={<div style={{ color: 'var(--fg-mute)', padding: 16 }}>No matching harnesses.</div>}
      />
    </div>
  );
}

function fmtDate(s?: string): string {
  if (!s) return '—';
  try { return new Date(s).toLocaleString(); } catch { return s; }
}

function displayPath(row: ProjectRow): string {
  const marker = '/.papercusp/projects/';
  const idx = row.path.indexOf(marker);
  if (idx >= 0) return `.papercusp/projects/${row.path.slice(idx + marker.length).split('/')[0]}`;
  return row.path;
}

function parentSlugFor(row: ProjectRow, projects: ProjectRow[]): string | null {
  if (row.harness_kind !== 'department') return null;
  const candidates = projects
    .filter((p) => p.slug !== row.slug && row.slug.startsWith(`${p.slug}-`))
    .sort((a, b) => b.slug.length - a.slug.length);
  return candidates[0]?.slug ?? null;
}

function kindChipStyle(kind: string | undefined, exists: boolean): React.CSSProperties {
  const tone = kind === 'coding'
    ? 'var(--accent)'
    : kind === 'org'
      ? 'var(--accent-strong)'
      : kind === 'department'
        ? 'var(--fg-mute)'
        : 'var(--fg-dim)';
  return {
    display: 'inline-flex',
    alignItems: 'center',
    minHeight: 22,
    padding: '2px 8px',
    borderRadius: 999,
    border: `1px solid color-mix(in srgb, ${tone}, transparent 72%)`,
    background: `color-mix(in srgb, ${tone}, transparent 90%)`,
    color: tone,
    fontSize: 12,
    fontWeight: 650,
    opacity: exists ? 1 : 0.5,
  };
}

export default function InstalledHarnessesPage() {
  const t = useLexicon();
  const [data, setData] = useState<InstalledResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useQueryState('q', parseAsString.withDefault(''));
  const [kindFilter, setKindFilter] = useQueryState('kind', parseAsStringEnum<KindFilter>([...KIND_FILTERS]).withDefault('all'));
  const [sort, setSort] = useQueryState('sort', parseAsStringEnum<SortMode>([...SORTS]).withDefault('recent'));

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      const res = await fetch('/api/installed', { cache: 'no-store', signal });
      if (!res.ok) throw new Error(`/api/installed returned ${res.status}`);
      const json: InstalledResponse = await res.json();
      setData(json);
    } catch (e: any) {
      if ((e as Error).name === 'AbortError') return;
      setError(String(e?.message ?? e));
      toast.error(`failed to load ${t('pot', { plural: true, lower: true })}: ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const handleCreated = useCallback((_slug: string) => {
    void load();
  }, [load]);

  const filteredProjects = useMemo(() => {
    const rows = data?.projects ?? [];
    const needle = query.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      const matchesKind = kindFilter === 'all' || row.harness_kind === kindFilter;
      const haystack = `${row.slug} ${row.harness_kind ?? ''} ${row.path}`.toLowerCase();
      return matchesKind && (!needle || haystack.includes(needle));
    });
    return [...filtered].sort((a, b) => {
      if (sort === 'alpha') return a.slug.localeCompare(b.slug);
      if (sort === 'kind') return `${a.harness_kind ?? ''}:${a.slug}`.localeCompare(`${b.harness_kind ?? ''}:${b.slug}`);
      return (Date.parse(b.addedAt ?? '') || 0) - (Date.parse(a.addedAt ?? '') || 0) || a.slug.localeCompare(b.slug);
    });
  }, [data?.projects, kindFilter, query, sort]);

  return (
    <div className="pc-installed-ops-shell pc-installed-harnesses-shell" style={{ maxWidth: 1100, margin: '0 auto', padding: '32px 24px' }}>
      <header className="pc-installed-ops-header pc-installed-harnesses-header" style={{ marginBottom: 24, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ margin: 0 }}>{t('pot', { plural: true })}</h1>
          <p style={{ color: 'var(--fg-mute)', marginTop: 8 }}>
            Locally-installed {t('pot', { plural: true, lower: true })}. Each is a project scaffolded into this workspace.
            Click a {t('pot', { lower: true })} to open it in mission control.
          </p>
        </div>
        <Button
          size="lg"
          variant="primary"
          className="pc-installed-harnesses-add-btn"
          onClick={() => setPickerOpen(true)}
          style={{ whiteSpace: 'nowrap', marginTop: 4 }}
        >
          + Add {t('pot')}
        </Button>
      </header>
      <CreateHarnessPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onCreated={handleCreated}
      />

      {loading && <p className="pc-installed-ops-loading" style={{ color: 'var(--fg-mute)' }}>Loading…</p>}
      {error && <p className="pc-installed-ops-error" style={{ color: 'var(--warn)' }}>Error: {error}</p>}

      {data && data.projects.length === 0 && !loading && (
        <div className="pc-installed-ops-empty pc-installed-harnesses-empty" style={{ padding: 32, border: '1px dashed var(--border)', borderRadius: 8, textAlign: 'center' }}>
          <p style={{ color: 'var(--fg-mute)' }}>No {t('pot', { plural: true, lower: true })} installed yet.</p>
          <p>
            <Button asChild size="lg" variant="accent">
              <RouteLink href="/cupboard">Browse the {t('cupboard')}</RouteLink>
            </Button>
          </p>
        </div>
      )}

      {data && data.projects.length > 0 && (
        <>
          <div
            className="pc-installed-harnesses-controls"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              marginBottom: 12,
            }}
          >
            <input
              className="pc-input"
              aria-label={`Filter ${t('pot', { plural: true, lower: true })}`}
              placeholder={`Filter ${t('pot', { plural: true, lower: true })}...`}
              value={query}
              onChange={(event) => void setQuery(event.target.value)}
              style={{ minWidth: 240, maxWidth: 360 }}
            />
            <div role="group" aria-label="Filter by kind" style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
              {KIND_FILTERS.map((kind) => (
                <Button
                  key={kind}
                  aria-pressed={kindFilter === kind}
                  size="lg"
                  onClick={() => void setKindFilter(kind)}
                  style={{
                    padding: '6px 10px',
                    borderColor: kindFilter === kind ? 'color-mix(in srgb, var(--accent-strong), transparent 56%)' : 'var(--border)',
                    background: kindFilter === kind ? 'color-mix(in srgb, var(--accent), transparent 86%)' : 'var(--bg-2)',
                    color: kindFilter === kind ? 'var(--accent-soft)' : 'var(--fg-mute)',
                  }}
                >
                  {kind === 'all' ? 'All' : kind}
                </Button>
              ))}
            </div>
            <Select
              value={sort}
              onChange={(value) => void setSort(value as SortMode)}
              ariaLabel="Sort harnesses"
              triggerStyle={{ minWidth: 170 }}
              options={[
                { value: 'recent', label: 'Recent activity' },
                { value: 'alpha', label: 'Alphabetical' },
                { value: 'kind', label: 'Kind' },
              ]}
            />
          </div>
          <ProjectsGrid projects={filteredProjects} allProjects={data.projects} />
        </>
      )}

      {data && data.staleCount > 0 && (
        <p className="pc-installed-harnesses-stale" style={{ marginTop: 16, color: 'var(--fg-mute)', fontSize: 13 }}>
          {data.staleCount} stale entr{data.staleCount === 1 ? 'y' : 'ies'} — project directory missing on disk.
        </p>
      )}
    </div>
  );
}
