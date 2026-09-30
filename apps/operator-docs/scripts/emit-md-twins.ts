/**
 * Emit per-page <slug>.md markdown twins next to each <slug>.html in dist/.
 *
 * Restores the per-page-markdown HTTP surface the old fumadocs setup
 * exposed via /llms.mdx/<slug> (a dedicated route) and `Accept:
 * text/markdown` on /internal/docs/<slug> (proxy.ts negotiation).
 * starlight-llms-txt only emits the aggregate llms*.txt; this script
 * fills the per-page gap by walking src/content/docs/**.mdx, stripping
 * JSX with @papercusp/docs-engine's renderMdxToMarkdown, and writing
 * the result with a withPreamble header into dist/<slug>.md. The
 * existing postbuild-copy.sh then mirrors dist/ →
 * apps/operator/public/internal/docs/, so the .md files land alongside
 * their .html twins for static serving. apps/operator/proxy.ts
 * rewrites `Accept: text/markdown` requests to the .md path.
 *
 * Wired into apps/operator-docs/package.json's `build` script, run
 * between `astro build` and `postbuild-copy.sh`.
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMdxToMarkdown, withPreamble } from '@papercusp/docs-engine';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTENT_ROOT = join(HERE, '..', 'src', 'content', 'docs');
const DIST_ROOT = join(HERE, '..', 'dist');
const URL_BASE = '/internal/docs';

interface Frontmatter {
  title?: string;
  description?: string;
}

function parseFrontmatter(raw: string): { data: Frontmatter; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!m) return { data: {}, body: raw };
  const data: Frontmatter = {};
  for (const line of m[1].split(/\r?\n/)) {
    const lm = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
    if (!lm) continue;
    const key = lm[1];
    let val = lm[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key === 'title' || key === 'description') {
      data[key] = val;
    }
  }
  return { data, body: m[2] };
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.mdx') || entry.name.endsWith('.md'))
    ) {
      out.push(full);
    }
  }
  return out;
}

const files = await walk(CONTENT_ROOT);
let n = 0;
for (const file of files) {
  const rel = relative(CONTENT_ROOT, file).replace(/\.(mdx|md)$/, '');
  const isIndex = rel === 'index';
  const slug = isIndex ? '' : rel;
  const url = isIndex ? URL_BASE : `${URL_BASE}/${slug}`;
  const raw = await readFile(file, 'utf-8');
  const { data, body } = parseFrontmatter(raw);
  // Plain .md pages ARE already markdown — pass them through verbatim. Running
  // them through the MDX pipeline mis-parses literal `{`/`<` (Starlight .md has
  // no JSX/expression syntax), which broke the build on the generated
  // reference/ projections (plans-index, agent-insights-index, role-registry).
  const rendered = file.endsWith('.md') ? body : await renderMdxToMarkdown(body, file);
  const text = withPreamble(rendered, {
    title: data.title ?? (isIndex ? 'Index' : slug),
    url,
    ...(data.description ? { description: data.description } : {}),
  });
  const outPath = join(DIST_ROOT, isIndex ? 'index.md' : `${slug}.md`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, text);
  n++;
}
console.log(`emit-md-twins: wrote ${n} .md twins → ${relative(process.cwd(), DIST_ROOT)}/`);
