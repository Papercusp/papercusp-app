'use client';

// adv:docs — renders a harness's project docs INLINE, now over the MERGED model
// (harness-docs-integration-2026-06-05 P-008): generated · manual · augmented docs
// coexist with source badges, drift freshness ("⚠ may be out of date" /
// "not drift-tracked"), the human augmented overlay, and regenerate / re-verify
// actions. Supersedes the FS-only /project-docs read.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { pinModuleState } from '@papercusp/module-singleton';
import { useLexicon } from '@/lib/useLexicon';
import { MarkdownPreview } from '@/app/_components/MarkdownEditor';

type DocSource = 'generated' | 'manual' | 'augmented';
type DocStatus = 'fresh' | 'stale' | 'review' | 'untracked' | 'unknown';

interface MergedDocEntry {
  docId: string;
  source: DocSource;
  status: DocStatus;
  statusDetail: string | null;
  subjectLabel: string;
  hasOverlay: boolean;
  title: string | null;
  bodyMissing: boolean;
  tracked: boolean;
}

interface MergedDocsResponse {
  ok: boolean;
  reason?: 'unknown_harness' | 'no_docs_dir' | 'empty';
  files: string[];
  entries: MergedDocEntry[];
  activePath: string | null;
  content: string | null;
  activeEntry: (MergedDocEntry & { overlay: string | null }) | null;
}

function basenameNoExt(p: string): string {
  return (p.split('/').pop() ?? p).replace(/\.(md|mdx)$/i, '');
}

function groupByDir(files: string[]): Array<{ dir: string; files: string[] }> {
  const m = new Map<string, string[]>();
  for (const f of files) {
    const slash = f.lastIndexOf('/');
    const dir = slash < 0 ? '' : f.slice(0, slash);
    const arr = m.get(dir) ?? [];
    arr.push(f);
    m.set(dir, arr);
  }
  return Array.from(m.entries())
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([dir, fs]) => ({ dir, files: fs.sort() }));
}

const SOURCE_LABEL: Record<DocSource, string> = { generated: 'Generated', manual: 'Manual', augmented: 'Augmented' };
const STATUS_LABEL: Record<DocStatus, string> = {
  fresh: 'Up to date',
  stale: '⚠ May be out of date',
  review: '⚠ Needs re-verify',
  untracked: 'Not drift-tracked',
  unknown: 'Unknown',
};

function SourceBadge({ source }: { source: DocSource }) {
  return <span className={`pc-doc-badge pc-doc-badge--src-${source}`}>{SOURCE_LABEL[source]}</span>;
}
function StatusBadge({ status, detail }: { status: DocStatus; detail?: string | null }) {
  if (status === 'fresh') return null;
  return (
    <span className={`pc-doc-badge pc-doc-badge--st-${status}`} title={detail ?? undefined}>
      {STATUS_LABEL[status]}
    </span>
  );
}
/** Tiny coloured dot in the nav for at-a-glance freshness. */
function StatusDot({ status }: { status: DocStatus }) {
  if (status === 'fresh') return null;
  const cls =
    status === 'stale' || status === 'review' ? 'is-warn' : status === 'unknown' ? 'is-unknown' : 'is-untracked';
  return <span className={`pc-doc-dot ${cls}`} aria-hidden />;
}

// Stale-while-revalidate cache (perf rule A18 — realm-pinned) for the
// per-(harness, selected-doc) docs payload. The /adv body re-mounts the active
// panel on every tab switch (D-002); without this, each Docs visit blanked to
// "Loading docs…" and refetched the no-store endpoint (~3.8s warm switch,
// app-impersonation-e2e round6 D-002/P-021). A revisit now renders the cached
// tree instantly and refreshes in the background; `recompute=1` keeps that
// refresh git-accurate, so freshness is preserved.
// Pinned through the primitive rather than a hand-rolled globalThis key: the
// pinning semantics are identical, but a hand-rolled key is INVISIBLE to
// listModuleDuplications(), so a split of this module would leave two caches
// serving different tabs while the realm-wide report answered a clean [].
// Module scope, once — pinModuleState counts every call as an evaluation.
type AdvDocsCache = Map<string, MergedDocsResponse>;
const advDocsCache = pinModuleState<AdvDocsCache>(
  '@papercusp/web.adv-docs-cache',
  () => new Map(),
);

export default function AdvDocsTab({ slug }: { slug: string }) {
  const t = useLexicon();
  // ?docpath= is the selected doc — URL-backed (nuqs) so it deep-links + is agent-driveable.
  const [docPath, setDocPath] = useQueryState('docpath', parseAsString);
  const [data, setData] = useState<MergedDocsResponse | null>(
    () => advDocsCache.get(`${slug}\x00${docPath ?? ''}`) ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) {
      setData({ ok: true, files: [], entries: [], activePath: null, content: null, activeEntry: null });
      return;
    }
    let cancel = false;
    const cacheKey = `${slug} ${docPath ?? ''}`;
    // Stale-while-revalidate: render the cached tree immediately; only blank to
    // "Loading docs…" for a (harness, doc) we have never fetched.
    const cached = advDocsCache.get(cacheKey) ?? null;
    setData(cached);
    setError(null);
    const params = new URLSearchParams();
    if (docPath) params.set('path', docPath);
    params.set('recompute', '1'); // git-accurate freshness for the doc being viewed
    fetch(`/api/harness/${encodeURIComponent(slug)}/docs?${params.toString()}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: MergedDocsResponse) => {
        if (cancel) return;
        advDocsCache.set(cacheKey, j);
        setData(j);
      })
      .catch((e: unknown) => {
        // Keep showing the stale tree if we have one; only surface the error on a
        // cold visit with nothing cached.
        if (!cancel && !cached) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancel = true;
    };
  }, [slug, docPath, reloadKey]);

  const entryById = useMemo(() => {
    const m = new Map<string, MergedDocEntry>();
    for (const e of data?.entries ?? []) m.set(e.docId, e);
    return m;
  }, [data?.entries]);
  const grouped = useMemo(() => groupByDir(data?.files ?? []), [data?.files]);

  const runAction = useCallback(
    async (action: 'regenerate' | 'verify', docId: string) => {
      setBusy(action);
      try {
        await fetch(`/api/harness/${encodeURIComponent(slug)}/docs/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ docId }),
        });
      } finally {
        setBusy(null);
        setReloadKey((k) => k + 1);
      }
    },
    [slug],
  );

  if (error) return <div className="pc-adv-harness-panel__empty">Could not load docs: {error}</div>;
  if (!data) return <div className="pc-adv-harness-panel__empty">Loading docs…</div>;
  if (data.reason === 'unknown_harness') {
    return <div className="pc-adv-harness-panel__empty">Unknown {t('pot', { lower: true })} “{slug}”.</div>;
  }
  if (!data.files.length) {
    return (
      <div className="pc-adv-harness-panel__empty">
        No project docs yet. Add markdown under <code>docs/</code> in this {t('pot', { lower: true })}’s repo to populate this tab.
      </div>
    );
  }

  const activeRel = data.activePath;
  const active = data.activeEntry;
  const canRegen = active && (active.source === 'generated' || active.source === 'augmented') && active.status === 'stale';
  const canVerify = active && active.source === 'manual' && (active.status === 'review' || active.status === 'untracked');

  return (
    <div className="pc-adv-docs">
      <aside className="pc-adv-docs__nav">
        {grouped.map((g) => (
          <section key={g.dir} className="pc-adv-docs__navgroup">
            <div className="pc-adv-docs__navdir">{g.dir || '/'}</div>
            <ul>
              {g.files.map((f) => {
                const e = entryById.get(f);
                return (
                  <li key={f}>
                    <button
                      type="button"
                      className={`pc-adv-docs__navlink${f === activeRel ? ' is-active' : ''}`}
                      aria-current={f === activeRel ? 'page' : undefined}
                      onClick={() => void setDocPath(f)}
                    >
                      {e && <StatusDot status={e.status} />}
                      <span className="pc-adv-docs__navlabel">{basenameNoExt(f)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </aside>
      <main className="pc-adv-docs__article">
        {activeRel && (
          <header className="pc-adv-docs__head">
            <div className="pc-adv-docs__crumb">{activeRel}</div>
            {active && (
              <div className="pc-adv-docs__meta">
                <SourceBadge source={active.source} />
                <StatusBadge status={active.status} detail={active.statusDetail} />
                {active.subjectLabel && (
                  <span className="pc-adv-docs__subject" title="What this doc documents (drift anchor)">
                    documents: <code>{active.subjectLabel}</code>
                  </span>
                )}
                {canRegen && (
                  <button
                    type="button"
                    className="pc-doc-action pc-doc-action--regen"
                    disabled={busy !== null}
                    onClick={() => void runAction('regenerate', active.docId)}
                  >
                    {busy === 'regenerate' ? 'Requesting…' : 'Regenerate'}
                  </button>
                )}
                {canVerify && (
                  <button
                    type="button"
                    className="pc-doc-action pc-doc-action--verify"
                    disabled={busy !== null}
                    onClick={() => void runAction('verify', active.docId)}
                  >
                    {busy === 'verify' ? 'Verifying…' : 'Re-verify'}
                  </button>
                )}
              </div>
            )}
          </header>
        )}
        {active?.overlay && (
          <div className="pc-adv-docs__overlay">
            <div className="pc-adv-docs__overlay-label">Human note (augmented · survives regeneration)</div>
            <MarkdownPreview value={active.overlay} />
          </div>
        )}
        <MarkdownPreview value={data.content ?? '*No file selected.*'} outline="left" />
      </main>

      <style>{`
        .pc-adv-docs {
          flex: 1; min-height: 0; height: 100%;
          display: grid; grid-template-columns: minmax(200px, 240px) minmax(0, 1fr);
        }
        .pc-adv-docs__nav {
          overflow-y: auto; padding: 12px 0;
          border-right: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
          background: color-mix(in srgb, var(--bg-2, #0b1220), transparent 30%);
        }
        .pc-adv-docs__navgroup { margin-bottom: 12px; }
        .pc-adv-docs__navgroup + .pc-adv-docs__navgroup {
          padding-top: 4px;
          border-top: 1px solid color-mix(in srgb, var(--accent-strong), transparent 93%);
        }
        .pc-adv-docs__navdir {
          padding: 6px 14px 4px; font-size: 10.5px; text-transform: uppercase;
          letter-spacing: 0; color: var(--fg-mute, #7f9bb4);
        }
        .pc-adv-docs__nav ul { list-style: none; margin: 0; padding: 0; }
        .pc-adv-docs__navlink {
          display: flex; align-items: center; gap: 7px; width: 100%; text-align: left;
          padding: 6px 14px; margin: 0 8px; font-size: 13px; line-height: 1.25;
          border: 0; border-left: 2px solid transparent; border-radius: 6px;
          background: transparent; color: var(--fg-dim, #b9d4e8); cursor: pointer;
          transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
        }
        .pc-adv-docs__navlabel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pc-adv-docs__navlink:hover {
          color: var(--accent-cool, #d7f3ff);
          background: color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 92%);
        }
        .pc-adv-docs__navlink.is-active {
          color: var(--accent-strong, #7dd3fc); font-weight: 600;
          background: color-mix(in srgb, var(--accent, #38bdf8), transparent 90%);
          border-left-color: var(--accent, #38bdf8);
        }
        .pc-doc-dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 999px; }
        .pc-doc-dot.is-warn { background: #f59e0b; }
        .pc-doc-dot.is-untracked { background: #64748b; }
        .pc-doc-dot.is-unknown { background: #a78bfa; }
        .pc-adv-docs__article {
          overflow: auto; padding: 22px clamp(18px, 2.2vw, 30px) 40px; min-width: 0;
        }
        .pc-adv-docs__head { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
        .pc-adv-docs__crumb {
          display: inline-flex; align-items: center; width: fit-content; padding: 2px 8px; border-radius: 999px;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
          color: var(--fg-mute, #7f9bb4);
          border: 1px solid color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 88%);
          background: color-mix(in srgb, var(--accent-strong, #7dd3fc), transparent 94.5%);
        }
        .pc-adv-docs__meta { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
        .pc-adv-docs__subject {
          font-size: 11px; color: var(--fg-mute, #7f9bb4);
        }
        .pc-adv-docs__subject code { font-size: 11px; color: var(--fg-dim, #b9d4e8); }
        .pc-doc-badge {
          display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px;
          font-size: 10.5px; font-weight: 700; letter-spacing: 0; white-space: nowrap;
          border: 1px solid transparent;
        }
        .pc-doc-badge--src-generated { color: var(--accent-strong, var(--accent)); background: color-mix(in oklab, var(--accent, #38bdf8), transparent 86%); border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 62%); }
        .pc-doc-badge--src-manual { color: #cbd5e1; background: rgba(100,116,139,.16); border-color: rgba(100,116,139,.4); }
        .pc-doc-badge--src-augmented { color: #c4b5fd; background: rgba(167,139,250,.16); border-color: rgba(167,139,250,.4); }
        .pc-doc-badge--st-stale, .pc-doc-badge--st-review { color: #fbbf24; background: rgba(245,158,11,.14); border-color: rgba(245,158,11,.4); }
        .pc-doc-badge--st-untracked { color: #94a3b8; background: rgba(100,116,139,.14); border-color: rgba(100,116,139,.34); }
        .pc-doc-badge--st-unknown { color: #c4b5fd; background: rgba(167,139,250,.12); border-color: rgba(167,139,250,.32); }
        .pc-doc-action {
          display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; font-size: 11px; font-weight: 700;
          letter-spacing: 0; border-radius: 6px; cursor: pointer; border: 1px solid transparent;
        }
        .pc-doc-action:disabled { opacity: .55; cursor: default; }
        .pc-doc-action--regen { color: #c4b5fd; background: rgba(167,139,250,.16); border-color: rgba(167,139,250,.4); }
        .pc-doc-action--regen:hover:not(:disabled) { background: rgba(167,139,250,.28); color: #e7f7ff; }
        .pc-doc-action--verify { color: #86efac; background: rgba(34,197,94,.16); border-color: rgba(34,197,94,.4); }
        .pc-doc-action--verify:hover:not(:disabled) { background: rgba(34,197,94,.28); color: #e7f7ff; }
        .pc-adv-docs__overlay {
          margin-bottom: 18px; padding: 10px 14px; border-radius: 8px;
          border: 1px solid rgba(167,139,250,.32); background: rgba(167,139,250,.07);
        }
        .pc-adv-docs__overlay-label {
          font-size: 10.5px; text-transform: uppercase; letter-spacing: 0; font-weight: 700;
          color: #c4b5fd; margin-bottom: 6px;
        }
        @media (max-width: 760px) {
          .pc-adv-docs { grid-template-columns: 1fr; }
          .pc-adv-docs__nav { max-height: 32vh; border-right: 0; border-bottom: 1px solid var(--border, #2a2a2a); }
        }
      `}</style>
    </div>
  );
}
