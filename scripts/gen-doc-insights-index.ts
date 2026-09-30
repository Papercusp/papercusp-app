/**
 * gen-doc-insights-index.ts — project the agent-insights library into a single
 * sortable index page (starlight-projection-generators-2026-06-05 P-003).
 *
 * Source of truth: the frontmatter (title/description/tags/status/discovered) of
 * every `apps/operator-docs/src/content/docs/agent-insights/*.md(x)`. The insights
 * are the fleet's runbook — written one-per-page but with no landing index. This
 * emits reference/agent-insights-index.md: one row per insight, linking to it.
 *
 * ADVISORY, not CI-gated (D-002, revised): though the read is deterministic, the
 * SOURCE churns — the fleet adds insights continuously (measured: the index went
 * stale within ~25 min of first generation), so a gating check would flap across
 * ~16 agents exactly like the docs-and-memory D-009 tool-catalog flap. Drift
 * surfaces in the CI log; any `gen:doc-projections` run refreshes it.
 *
 *   npx tsx scripts/gen-doc-insights-index.ts          # write
 *   npx tsx scripts/gen-doc-insights-index.ts --check  # fail if drifted
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { normalizeDocStatus } from '@papercusp/docs-engine';
import { REPO_ROOT, emitOrCheck, generatedBanner, frontmatter, cell } from './lib/doc-projection';

const INSIGHTS_DIR = join(REPO_ROOT, 'apps', 'operator-docs', 'src', 'content', 'docs', 'agent-insights');
/** The served URL prefix (operator mounts the Starlight output at /internal/docs). */
const URL_PREFIX = '/internal/docs/agent-insights';

interface Insight {
  slug: string;
  title: string;
  description: string;
  tags: string[];
  status: string;
  discovered: string;
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  try {
    const fm = parseYaml(m[1]);
    return fm && typeof fm === 'object' ? (fm as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function loadInsights(): Insight[] {
  const files = readdirSync(INSIGHTS_DIR).filter((f) => f.endsWith('.md') || f.endsWith('.mdx'));
  const out: Insight[] = [];
  for (const file of files) {
    const slug = file.replace(/\.mdx?$/, '');
    if (slug === 'index') continue; // a directory landing page, not an insight
    const fm = parseFrontmatter(readFileSync(join(INSIGHTS_DIR, file), 'utf8'));
    const tags = Array.isArray(fm.tags) ? fm.tags.map((t) => String(t)) : [];
    out.push({
      slug,
      title: typeof fm.title === 'string' ? fm.title : slug,
      description: typeof fm.description === 'string' ? fm.description : '',
      tags,
      status: typeof fm.status === 'string' ? normalizeDocStatus(fm.status) ?? '' : '',
      discovered: typeof fm.discovered === 'string' ? fm.discovered : String(fm.discovered ?? ''),
    });
  }
  return out.sort((a, b) => (a.title.toLowerCase() < b.title.toLowerCase() ? -1 : a.title.toLowerCase() > b.title.toLowerCase() ? 1 : 0));
}

function build(): string {
  const insights = loadInsights();

  // Tag histogram (top tags first) for an at-a-glance map.
  const tagCounts = new Map<string, number>();
  for (const i of insights) for (const t of i.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 25);

  const statusCounts = new Map<string, number>();
  for (const i of insights) if (i.status) statusCounts.set(i.status, (statusCounts.get(i.status) ?? 0) + 1);

  const lines: string[] = [];
  lines.push(
    frontmatter({
      title: 'Agent insights index',
      description:
        'A sortable index of every agent-insights runbook page — title, tags, status, and one-line description. Generated from the insight frontmatter.',
      sidebarOrder: 3,
      // EI-10937: this page is a 304KB dump of every insight's title+description —
      // it lexically matched every docs:search query and buried the real answer.
      // Navigation, not an answer. Still browsable; just not a search hit.
      searchable: false,
    }),
  );
  lines.push('');
  lines.push(generatedBanner('gen:doc-insights-index'));
  lines.push('');
  lines.push('# Agent insights index');
  lines.push('');
  lines.push(
    'The **agent-insights** are the fleet\'s procedural runbook — one short page per hard-won, non-obvious fact (a confusing failure\'s root cause, a subtle invariant, a library quirk). Written one-per-page; this is the generated landing index.',
  );
  lines.push('');
  lines.push(`**${insights.length} insights.**${statusCounts.size > 0 ? ` By status: ${[...statusCounts.entries()].sort().map(([s, n]) => `${cell(s)} (${n})`).join(', ')}.` : ''}`);
  lines.push('');
  if (topTags.length > 0) {
    lines.push('**Top tags:** ' + topTags.map(([t, n]) => `\`${cell(t)}\` ${n}`).join(' · '));
    lines.push('');
  }

  lines.push('## All insights');
  lines.push('');
  lines.push('| Insight | Tags | Status | Discovered | What it is |');
  lines.push('|---|---|---|---|---|');
  for (const i of insights) {
    const link = `[${cell(i.title)}](${URL_PREFIX}/${i.slug})`;
    const tags = i.tags.length > 0 ? i.tags.map((t) => `\`${cell(t)}\``).join(' ') : '—';
    lines.push(`| ${link} | ${tags} | ${cell(i.status || '—')} | ${cell(i.discovered || '—')} | ${cell(i.description)} |`);
  }
  lines.push('');

  return lines.join('\n');
}

emitOrCheck('agent-insights-index.md', build(), { advisory: true });
