/**
 * Per-harness-project docs viewer.
 *
 * Renders markdown files from `<projectPath>/docs/` for the harness named
 * in the `?harness=<slug>` query string. Sidebar lists every .md file under
 * `docs/` so authors can navigate between features, guides, etc. The active
 * file is selected via `?path=<rel>`; default loads `index.md` (or the
 * shallowest readable file).
 *
 * This is the iframe target for the @papercupai/starlight plugin's per-
 * harness Docs tab (successor to the retired @papercupai/fumadocs plugin). It is intentionally separate from the operator's own
 * /docs route (which serves the Papercusp specification — operator-owned
 * content, not harness-owned).
 */
import { promises as fs, existsSync } from 'node:fs';
import { join, normalize, relative, resolve as resolvePath, sep } from 'node:path';
import { Suspense } from 'react';
import { MarkdownPreview } from '@/app/_components/MarkdownEditor';
import Link from '@/lib/router-compat/link';
import { loadHarnessRegistry } from '@papercusp/operator-core/lib/harness-registry';
import { term } from '@papercusp/operator-core/lib/lexicon';

export const dynamic = 'force-dynamic';

async function resolveProjectPath(slug: string): Promise<string | null> {
  return (await loadHarnessRegistry()).projects.find((p) => p.slug === slug)?.path ?? null;
}

async function listDocs(docsRoot: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && /\.(md|mdx)$/i.test(e.name)) {
        out.push(relative(docsRoot, full));
      }
    }
  }
  await walk(docsRoot);
  return out.sort();
}

function safeJoinUnderRoot(root: string, rel: string): string | null {
  const resolved = resolvePath(root, rel);
  const safeRoot = resolvePath(root) + sep;
  if (resolved !== resolvePath(root) && !resolved.startsWith(safeRoot)) return null;
  return resolved;
}

function chooseDefaultPath(files: string[]): string | null {
  if (files.length === 0) return null;
  const preferred = files.find((f) => /^index\.(md|mdx)$/i.test(f))
    ?? files.find((f) => /^README\.(md|mdx)$/i.test(f));
  return preferred ?? files[0];
}

async function ProjectDocs({
  searchParams,
}: {
  searchParams: Promise<{ harness?: string; path?: string }>;
}) {
  const sp = await searchParams;
  const slug = sp.harness?.trim() ?? '';
  if (!slug) {
    return <Empty title="Missing ?harness=<slug>" body={`Open this view via the ${term('pot', { lower: true })} Docs tab — it provides the slug.`} />;
  }
  const projectPath = await resolveProjectPath(slug);
  if (!projectPath) return <Empty title={`Unknown ${term('pot', { lower: true })} "${slug}"`} body="No matching entry in the projects registry." />;

  const docsRoot = join(projectPath, 'docs');
  if (!existsSync(docsRoot)) {
    return (
      <Empty
        title="No docs/ directory"
        body={`This ${term('pot', { lower: true })} has no project-level documentation yet. Add markdown files under ${normalize(docsRoot)} to populate this tab.`}
      />
    );
  }

  const files = await listDocs(docsRoot);
  if (files.length === 0) {
    return <Empty title="docs/ is empty" body="Drop a markdown file under the project's docs directory and it'll show up here." />;
  }

  const requestedPath = sp.path?.trim();
  const activeRel = (requestedPath && files.includes(requestedPath))
    ? requestedPath
    : chooseDefaultPath(files);

  const activeAbs = activeRel ? safeJoinUnderRoot(docsRoot, activeRel) : null;
  const content = activeAbs && existsSync(activeAbs)
    ? await fs.readFile(activeAbs, 'utf8')
    : '*No file selected.*';

  const linkBase = `/project-docs?harness=${encodeURIComponent(slug)}&path=`;
  const grouped = groupByDir(files);

  return (
    <div style={layout} className="project-docs-shell">
      <style>{projectDocsCss}</style>
      <aside style={sidebar} className="project-docs-sidebar">
        <div style={projectHeader} className="project-docs-project-header">
          <strong>{slug}</strong>
          <div style={{ color: 'var(--fg-mute, #999)', fontSize: 11 }}>{normalize(projectPath)}</div>
        </div>
        {grouped.map((g) => (
          <section key={g.dir} style={{ marginBottom: 12 }}>
            <div style={dirHeader}>{g.dir || '/'}</div>
            <ul style={list}>
              {g.files.map((f) => {
                const isActive = f === activeRel;
                return (
                  <li key={f} style={listItem}>
                    <Link
                      href={`${linkBase}${encodeURIComponent(f)}`}
                      className={isActive ? 'project-docs-nav-link active' : 'project-docs-nav-link'}
                      aria-current={isActive ? 'page' : undefined}
                      style={isActive ? linkActive : linkIdle}
                    >
                      {basenameNoExt(f)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </aside>
      <main style={article} className="project-docs-article">
        <div style={breadcrumb} className="project-docs-breadcrumb">{activeRel}</div>
        <MarkdownPreview value={content} outline="left" />
      </main>
    </div>
  );
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
    .map(([dir, files]) => ({ dir, files: files.sort() }));
}

function basenameNoExt(p: string): string {
  const last = p.split('/').pop() ?? p;
  return last.replace(/\.(md|mdx)$/i, '');
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="project-docs-empty" style={{ padding: '32px 24px', maxWidth: 640, margin: '0 auto', color: 'var(--fg-mute, #999)' }}>
      <h2 className="project-docs-empty-title" style={{ margin: '0 0 8px', color: 'var(--fg, #ddd)' }}>{title}</h2>
      <p className="project-docs-empty-body">{body}</p>
    </div>
  );
}

const layout: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(220px, 248px) minmax(0, 1fr)',
  height: '100vh',
  background: 'linear-gradient(180deg, color-mix(in srgb, var(--bg-1), transparent 2%), var(--bg-1, var(--bg-1)))',
  color: 'var(--fg, #ddd)',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
};
const sidebar: React.CSSProperties = {
  borderRight: '1px solid var(--border, #2a2a2a)',
  overflowY: 'auto',
  padding: '14px 0',
  background: 'linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.025))',
};
const projectHeader: React.CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 2,
  background: 'color-mix(in srgb, var(--bg-popover), transparent 4%)',
  padding: '0 16px 14px',
  borderBottom: '1px solid var(--border, #2a2a2a)',
  marginBottom: 10,
};
const dirHeader: React.CSSProperties = {
  padding: '8px 16px 5px', fontSize: 10.5, textTransform: 'uppercase', color: 'var(--fg-mute, #999)',
};
const list: React.CSSProperties = { listStyle: 'none', margin: 0, padding: 0 };
const listItem: React.CSSProperties = { margin: 0 };
const linkBaseStyle: React.CSSProperties = {
  display: 'block',
  padding: '6px 16px',
  fontSize: 13,
  lineHeight: 1.25,
  textDecoration: 'none',
  borderLeft: '2px solid transparent',
};
const linkIdle: React.CSSProperties = { ...linkBaseStyle, color: 'var(--fg-dim, #b9d4e8)' };
const linkActive: React.CSSProperties = {
  ...linkBaseStyle,
  color: 'var(--accent-strong, #7dd3fc)',
  background: 'color-mix(in srgb, var(--accent), transparent 90%)',
  borderLeftColor: 'var(--accent, #38bdf8)',
};
const article: React.CSSProperties = {
  overflowY: 'auto',
  overflowX: 'auto',
  scrollPaddingTop: 24,
  padding: '28px clamp(20px, 2.4vw, 32px) 48px',
  maxWidth: 'none',
  margin: 0,
  width: '100%',
  boxSizing: 'border-box',
};
const breadcrumb: React.CSSProperties = {
  fontSize: 11, color: 'var(--fg-mute, #999)', marginBottom: 18,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};
const projectDocsCss = `
  .project-docs-sidebar { scrollbar-color: color-mix(in srgb, var(--accent-strong), transparent 70%) transparent; }
  .project-docs-sidebar,
  .project-docs-article {
    scrollbar-gutter: stable;
    overscroll-behavior: contain;
  }
  .project-docs-sidebar section + section {
    padding-top: 4px;
    border-top: 1px solid color-mix(in srgb, var(--accent-strong), transparent 93%);
  }
  .project-docs-project-header { backdrop-filter: blur(10px); }
  .project-docs-project-header strong { display: block; font-size: 14px; letter-spacing: 0; }
  .project-docs-project-header div {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .project-docs-breadcrumb {
    display: inline-flex;
    align-items: center;
    width: fit-content;
    padding: 2px 8px;
    border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 88%);
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent-strong), transparent 94.5%);
    max-width: min(100%, 72ch);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .project-docs-nav-link {
    margin: 0 8px;
    border-radius: 6px;
    transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
  }
  .project-docs-nav-link.active {
    font-weight: 600;
    box-shadow: inset 1px 0 0 color-mix(in srgb, var(--accent-cool), transparent 84%);
  }
  .project-docs-nav-link:hover,
  .project-docs-nav-link:focus-visible {
    color: var(--accent-cool, #d7f3ff) !important;
    background: color-mix(in srgb, var(--accent-strong), transparent 92%);
    outline: none;
  }
  .project-docs-nav-link:focus-visible { box-shadow: inset 3px 0 0 var(--accent, #38bdf8); }
  .project-docs-article { scrollbar-color: color-mix(in srgb, var(--accent-strong), transparent 70%) transparent; }
  .project-docs-article > div:not(.project-docs-breadcrumb) {
    display: block !important;
    width: 100%;
    max-width: none;
  }
  .project-docs-article .pc-md-outline {
    position: static !important;
    width: 100% !important;
    max-height: none !important;
    margin: 0 0 18px !important;
    padding: 0 0 10px !important;
    border-right: 0 !important;
    border-bottom: 1px solid color-mix(in srgb, var(--accent-strong), transparent 88%);
  }
  .project-docs-article .pc-md-outline ul {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    padding-left: 0 !important;
  }
  .project-docs-article .pc-md-preview {
    width: 100% !important;
    max-width: none;
  }
  .project-docs-article .vditor-reset {
    color: var(--fg-dim, #b9d4e8);
    line-height: 1.62;
  }
  .project-docs-article .vditor-reset > :first-child { margin-top: 0; }
  .project-docs-article .vditor-reset > :last-child { margin-bottom: 0; }
  .project-docs-article .vditor-reset ::selection {
    background: color-mix(in srgb, var(--accent), transparent 72%);
    color: var(--fg, #e7f7ff);
  }
  .project-docs-article :where(h1, h2, h3) {
    color: var(--fg, #e7f7ff);
    letter-spacing: 0;
    line-height: 1.08;
    text-wrap: balance;
    scroll-margin-top: 28px;
  }
  .project-docs-article h1 {
    margin: 0 0 16px;
    font-size: 2.6rem;
    max-width: none;
  }
  .project-docs-article h2 {
    margin: 30px 0 12px;
    padding-top: 2px;
    font-size: 1.85rem;
    border-bottom: 1px solid color-mix(in srgb, var(--accent-strong), transparent 82%);
    padding-bottom: 8px;
  }
  .project-docs-article h3 { margin: 22px 0 10px; font-size: 1.25rem; }
  .project-docs-article :where(h1, h2, h3):target {
    border-radius: 8px;
    background: linear-gradient(90deg, color-mix(in srgb, var(--accent), transparent 90%), transparent 68%);
    outline: 1px solid color-mix(in srgb, var(--accent-strong), transparent 84%);
    outline-offset: 4px;
  }
  .project-docs-article :where(h1, h2, h3) a {
    color: inherit;
    text-decoration: none;
  }
  .project-docs-article :where(h1, h2, h3) a:hover,
  .project-docs-article :where(h1, h2, h3) a:focus-visible {
    color: var(--accent-cool, #d7f3ff);
  }
  .project-docs-article :where(h1, h2, h3) :where(.vditor-anchor, .anchor) {
    opacity: 0.5;
    margin-left: 0.35rem;
    font-size: 0.72em;
  }
  .project-docs-article p {
    max-width: none;
    color: var(--fg-dim, #b9d4e8);
    line-height: 1.7;
  }
  .project-docs-article hr {
    margin: 10px 0 16px;
    border: 0;
    border-top: 1px solid var(--border-strong, color-mix(in srgb, var(--accent-strong), transparent 68%));
  }
  .project-docs-article table {
    width: 100%;
    min-width: 100%;
    margin: 16px 0 28px;
    border-collapse: separate;
    border-spacing: 0;
    border: 1px solid var(--border, color-mix(in srgb, var(--accent-strong), transparent 85%));
    border-radius: 10px;
    overflow: hidden;
    background: rgba(255,255,255,0.025);
    font-size: 13px;
    box-shadow: 0 14px 34px rgba(0, 0, 0, 0.14);
    font-variant-numeric: tabular-nums;
    caption-side: bottom;
  }
  .project-docs-article th,
  .project-docs-article td {
    padding: 7px 12px;
    border: 0;
    border-bottom: 1px solid color-mix(in srgb, var(--accent-strong), transparent 90%);
    vertical-align: top;
    line-height: 1.45;
    text-align: left;
  }
  .project-docs-article th + th,
  .project-docs-article td + td {
    border-left: 1px solid color-mix(in srgb, var(--accent-strong), transparent 92%);
  }
  .project-docs-article th {
    color: var(--fg, #e7f7ff);
    font-size: 11px;
    letter-spacing: 0;
    background: color-mix(in srgb, var(--accent-strong), transparent 92.5%);
    position: sticky;
    top: 0;
    z-index: 1;
    backdrop-filter: blur(8px);
  }
  .project-docs-article caption {
    padding-top: 8px;
    color: var(--fg-mute, #7f9bb4);
    font-size: 12px;
    line-height: 1.45;
    text-align: left;
  }
  .project-docs-article tbody tr:last-child td { border-bottom: 0; }
  .project-docs-article tbody tr { transition: background-color 120ms ease; }
  .project-docs-article tbody tr:hover { background: color-mix(in srgb, var(--accent-strong), transparent 95.5%); }
  .project-docs-article tbody tr:nth-child(even) { background: rgba(255, 255, 255, 0.012); }
  .project-docs-article th:first-child,
  .project-docs-article td:first-child,
  .project-docs-article th:nth-child(3),
  .project-docs-article td:nth-child(3),
  .project-docs-article th:nth-child(4),
  .project-docs-article td:nth-child(4) {
    white-space: nowrap;
  }
  .project-docs-article td:first-child {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--fg, #e7f7ff);
    font-size: 12px;
  }
  .project-docs-article th:first-child,
  .project-docs-article td:first-child {
    width: 76px;
  }
  .project-docs-article th:nth-child(3),
  .project-docs-article td:nth-child(3) {
    width: 72px;
  }
  .project-docs-article th:nth-child(4),
  .project-docs-article td:nth-child(4) {
    width: 72px;
  }
  .project-docs-article td:nth-child(2) {
    color: var(--fg-dim, #b9d4e8);
    overflow-wrap: anywhere;
  }
  .project-docs-article td:nth-child(4) a {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    display: inline-flex;
    align-items: center;
    padding: 1px 4px;
    border-radius: 4px;
  }
  .project-docs-article a { text-underline-offset: 0.16em; }
  .project-docs-article td:nth-child(4) a:hover,
  .project-docs-article td:nth-child(4) a:focus-visible {
    background: color-mix(in srgb, var(--accent-strong), transparent 92%);
    text-decoration: none;
  }
  .project-docs-article a { color: var(--accent-strong, #7dd3fc); }
  .project-docs-article a:hover,
  .project-docs-article a:focus-visible {
    color: var(--accent-cool, #d7f3ff);
    text-decoration: underline;
    outline: none;
  }
  .project-docs-article a:focus-visible {
    border-radius: 4px;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent), transparent 80%);
  }
  .project-docs-article :not(pre) > code {
    padding: 0.08rem 0.28rem;
    border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 86%);
    border-radius: 5px;
    background: color-mix(in srgb, var(--accent-strong), transparent 92%);
    color: #d9f3ff;
    white-space: nowrap !important;
  }
  .project-docs-article strong {
    color: var(--fg, #e7f7ff);
    font-weight: 750;
  }
  .project-docs-article em {
    color: color-mix(in oklab, var(--fg-dim, #b9d4e8), white 10%);
  }
  .project-docs-article del {
    color: var(--fg-mute, #7f9bb4);
    text-decoration-color: rgba(251, 113, 133, 0.55);
  }
  .project-docs-article ins {
    color: var(--fg, #e7f7ff);
    text-decoration-color: rgba(52, 211, 153, 0.65);
    text-underline-offset: 0.16em;
  }
  .project-docs-article small,
  .project-docs-article time {
    color: var(--fg-mute, #7f9bb4);
  }
  .project-docs-article kbd {
    display: inline-block;
    padding: 0.08rem 0.34rem;
    border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 80%);
    border-bottom-color: color-mix(in srgb, var(--accent-strong), transparent 68%);
    border-radius: 5px;
    background: color-mix(in srgb, var(--bg-deeper), transparent 38%);
    color: var(--fg, #e7f7ff);
    box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.045);
  }
  .project-docs-article mark {
    padding: 0.04rem 0.22rem;
    border-radius: 4px;
    background: rgba(251, 191, 36, 0.18);
    color: var(--fg, #e7f7ff);
  }
  .project-docs-article abbr[title] {
    text-decoration: underline dotted color-mix(in srgb, var(--accent-strong), transparent 45%);
    text-underline-offset: 0.18em;
    cursor: help;
  }
  .project-docs-article :where(ul, ol) {
    max-width: none;
    color: var(--fg-dim, #b9d4e8);
    line-height: 1.68;
  }
  .project-docs-article li + li { margin-top: 0.28rem; }
  .project-docs-article dl {
    max-width: none;
    margin: 18px 0;
    color: var(--fg-dim, #b9d4e8);
  }
  .project-docs-article dt {
    color: var(--fg, #e7f7ff);
    font-weight: 700;
  }
  .project-docs-article dd {
    margin: 4px 0 12px 16px;
    padding-left: 12px;
    border-left: 1px solid color-mix(in srgb, var(--accent-strong), transparent 86%);
  }
  .project-docs-article input[type="checkbox"] {
    accent-color: var(--accent, #38bdf8);
    margin-right: 0.45em;
    transform: translateY(1px);
  }
  .project-docs-article blockquote {
    max-width: none;
    margin: 18px 0;
    padding: 10px 14px;
    border-left: 2px solid var(--accent, #38bdf8);
    border-radius: 0 8px 8px 0;
    background: color-mix(in srgb, var(--accent-strong), transparent 94%);
    color: var(--fg-dim, #b9d4e8);
  }
  .project-docs-article pre {
    max-width: 100%;
    margin: 18px 0 22px;
    padding: 12px 14px;
    border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 84%);
    border-radius: 10px;
    background: color-mix(in srgb, var(--bg-deeper), transparent 42%);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
    overflow-x: auto;
  }
  .project-docs-article pre > code {
    display: block;
    padding: 0;
    border: 0;
    background: transparent !important;
    color: inherit !important;
    white-space: pre;
    line-height: 1.55;
    tab-size: 2;
  }
  .project-docs-article .vditor-yml-front-matter {
    background: color-mix(in srgb, var(--accent-strong), transparent 95.5%);
    border-color: color-mix(in srgb, var(--accent-strong), transparent 84%);
  }
  .project-docs-article figure {
    max-width: 100%;
    margin: 22px 0;
  }
  .project-docs-article img {
    max-width: 100%;
    height: auto;
    border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 84%);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.03);
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.16);
  }
  .project-docs-article figcaption {
    margin-top: 7px;
    color: var(--fg-mute, #7f9bb4);
    font-size: 12px;
    line-height: 1.45;
  }
  .project-docs-article sup,
  .project-docs-article sub {
    line-height: 0;
  }
  .project-docs-article .footnotes,
  .project-docs-article section.footnotes {
    max-width: none;
    margin-top: 34px;
    padding-top: 14px;
    border-top: 1px solid color-mix(in srgb, var(--accent-strong), transparent 84%);
    color: var(--fg-mute, #7f9bb4);
    font-size: 13px;
  }
  .project-docs-article .footnotes ol {
    padding-left: 1.35rem;
  }
  .project-docs-article a[data-footnote-ref],
  .project-docs-article .footnote-ref a {
    padding: 0 0.2rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent-strong), transparent 92%);
    text-decoration: none;
  }
  .project-docs-article a[data-footnote-backref] {
    margin-left: 0.35rem;
    color: var(--fg-mute, #7f9bb4);
    text-decoration: none;
  }
  .project-docs-article details {
    max-width: none;
    margin: 18px 0;
    border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 86%);
    border-radius: 10px;
    background: color-mix(in srgb, var(--accent-strong), transparent 95.5%);
    overflow: hidden;
  }
  .project-docs-article summary {
    padding: 10px 12px;
    color: var(--fg, #e7f7ff);
    cursor: pointer;
    font-weight: 650;
  }
  .project-docs-article details[open] summary {
    border-bottom: 1px solid color-mix(in srgb, var(--accent-strong), transparent 88%);
  }
  .project-docs-article details > :not(summary) {
    margin-left: 12px;
    margin-right: 12px;
  }
  @media print {
    .project-docs-shell { display: block !important; height: auto; background: white; color: black; }
    .project-docs-sidebar,
    .project-docs-breadcrumb { display: none !important; }
    .project-docs-article { max-width: none; padding: 0 !important; overflow: visible; }
    .project-docs-article table { min-width: 0; box-shadow: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .project-docs-nav-link,
    .project-docs-article tbody tr { transition: none; }
  }
  @media (max-width: 760px) {
    .project-docs-shell { grid-template-columns: 1fr !important; }
    .project-docs-sidebar { max-height: 34vh; border-right: 0; border-bottom: 1px solid var(--border, #2a2a2a); }
    .project-docs-article table { min-width: 620px; }
    .project-docs-article :not(pre) > code { white-space: normal !important; }
    .project-docs-article { padding: 24px 20px 40px !important; }
  }
`;

export default function Page(props: { searchParams: Promise<{ harness?: string; path?: string }> }) {
  return (
    <Suspense fallback={<div className="project-docs-loading" style={{ padding: 24, color: '#888' }}>Loading project docs…</div>}>
      <ProjectDocs searchParams={props.searchParams} />
    </Suspense>
  );
}
