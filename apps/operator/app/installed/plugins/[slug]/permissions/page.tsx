'use client';

import { useEffect, useMemo, useState } from 'react';
import { use } from 'react';
import { toast } from 'sonner';
import RouteLink from '../../../../_components/RouteLink';
import { Checkbox } from '../../../../harness/Checkbox';
import { explainCapability, tierBadgeColor } from '@papercusp/operator-core/lib/capability-explain';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import { useLexicon } from '@/lib/useLexicon';
import { useSyncQuery } from '@papercusp/sync';
import { useWorkspaceId } from '@/lib/use-workspace-id';

interface ManifestResp {
  name: string;
  version: string;
  description?: string | null;
  capabilities: string[];
}

interface ProjectRow { slug: string; name?: string }

export default function PluginPermissionsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const t = useLexicon();
  const workspaceId = useWorkspaceId();
  const [manifest, setManifest] = useState<ManifestResp | null>(null);
  const projectsSync = useSyncQuery<ProjectRow>({
    queryName: 'harnessProjects.lite',
    args: { workspaceId },
    staleTime: 30_000,
  });
  const harnesses = useMemo(() => projectsSync.data ?? [], [projectsSync.data]);
  // grants[harnessSlug] = Set<capability>
  const [grants, setGrants] = useState<Record<string, Set<string>>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const mRes = await fetch(`/api/plugins/manifest?slug=${encodeURIComponent(slug)}`, { cache: 'no-store' });
        if (!mRes.ok) {
          toast.error(`Plugin "${slug}" not found`);
          if (!cancelled) setLoading(false);
          return;
        }
        const m = (await mRes.json()) as ManifestResp;
        if (cancelled) return;
        setManifest(m);
        // Fetch grants per harness in parallel
        const gEntries = await Promise.all(
          harnesses.map(async (h) => {
            const r = await fetch(
              `/api/plugins/grants?plugin=${encodeURIComponent(m.name)}&version=${encodeURIComponent(m.version)}&harness=${encodeURIComponent(h.slug)}`,
              { cache: 'no-store' },
            );
            if (!r.ok) return [h.slug, new Set<string>()] as const;
            const d = await r.json();
            const caps: string[] = Array.isArray(d?.capabilities) ? d.capabilities : [];
            return [h.slug, new Set(caps)] as const;
          }),
        );
        if (cancelled) return;
        const map: Record<string, Set<string>> = {};
        for (const [h, s] of gEntries) map[h] = s;
        setGrants(map);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [harnesses, slug]);

  const explained = useMemo(
    () => (manifest?.capabilities ?? []).map(explainCapability),
    [manifest],
  );

  async function toggle(harness: string, cap: string, currentlyGranted: boolean) {
    if (!manifest) return;
    const key = `${harness}:${cap}`;
    setBusy(key);
    try {
      const r = await fetch('/api/plugins/grants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plugin: manifest.name,
          version: manifest.version,
          harness,
          capabilities: [cap],
          action: currentlyGranted ? 'revoke' : 'grant',
          reason: 'permissions ui',
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        toast.error(`Failed to ${currentlyGranted ? 'revoke' : 'grant'}`, { description: d.error ?? 'unknown' });
        return;
      }
      setGrants((prev) => {
        const next = { ...prev };
        const set = new Set(next[harness] ?? []);
        if (currentlyGranted) set.delete(cap); else set.add(cap);
        next[harness] = set;
        return next;
      });
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return <div className="pc-shell pc-marketplace-shell"><div className="pc-card">Loading…</div></div>;
  }
  if (!manifest) {
    return (
      <div className="pc-shell pc-marketplace-shell">
        <div className="pc-card">
          Plugin <code>{slug}</code> isn't installed. <RouteLink href="/installed/plugins">Back to installed plugins</RouteLink>
        </div>
      </div>
    );
  }

  return (
    <div className="pc-shell pc-marketplace-shell">
      <section className="pc-marketplace-pagehead">
        <div>
          <p className="pc-eyebrow"><RouteLink href="/installed/plugins">Installed plugins</RouteLink> / Permissions</p>
          <h1>{manifest.name}</h1>
          <p>{manifest.description ?? 'Per-harness capability grants. The plugin can only use a capability if it is both declared in its manifest AND granted here.'}</p>
        </div>
      </section>

      {explained.length === 0 ? (
        <div className="pc-card">This plugin declares no capabilities.</div>
      ) : harnesses.length === 0 ? (
        <div className="pc-card">No {t('pot', { plural: true, lower: true })} registered. Create a {t('pot', { lower: true })} first to manage grants.</div>
      ) : (() => {
        type CapRow = (typeof explained)[number];
        const columns: ColumnDef<CapRow>[] = [
          {
            key: 'capability', header: 'Capability', width: 3,
            toCopyText: (r) => `${r.label} (${r.cap}) [${r.tier}]`,
            render: ({ row }) => (
              <div>
                <div style={{ fontWeight: 500 }}>{row.label}</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 }}>
                  <code style={{ fontSize: 11, opacity: 0.7 }}>{row.cap}</code>
                  <span style={{
                    fontSize: 10,
                    textTransform: 'uppercase',
                    padding: '1px 6px',
                    borderRadius: 3,
                    background: tierBadgeColor(row.tier),
                    color: 'white',
                  }}>{row.tier}</span>
                </div>
              </div>
            ),
          },
          ...harnesses.map<ColumnDef<CapRow>>((h) => ({
            key: `g:${h.slug}`,
            header: <code>{h.slug}</code>,
            headerText: h.slug,
            width: 1,
            align: 'center',
            toCopyText: (r) => (grants[h.slug]?.has(r.cap) ? '✓' : ''),
            render: ({ row }) => {
              const granted = grants[h.slug]?.has(row.cap) ?? false;
              const key = `${h.slug}:${row.cap}`;
              return (
                <Checkbox
                  checked={granted}
                  disabled={busy === key}
                  onChange={() => toggle(h.slug, row.cap, granted)}
                  ariaLabel={`Grant ${row.cap} to ${h.slug}`}
                />
              );
            },
          })),
        ];
        return (
          <div className="pc-card" style={{ height: Math.min(640, 36 + explained.length * 56 + 4) }}>
            <RichGrid<CapRow>
              columns={columns}
              rows={explained}
              getRowId={(r) => r.cap}
              rowMinHeight={56}
              headerHeight={36}
            />
          </div>
        );
      })()}
    </div>
  );
}
