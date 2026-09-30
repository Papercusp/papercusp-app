/**
 * Substrate-context assembler. Fetches Tier 2 neighbor data via the
 * operator's read APIs and produces the markdown block prepended to every
 * role's prompt by buildPrompt.
 *
 * Best-effort: any fetch failure → empty section. Tier 1 (preamble) and
 * Tier 3 (capabilities list) are static text; Tier 2 (neighbor view)
 * requires live data.
 *
 * (The bounded supervisor-inbox section this file used to render — sourced
 * from the now-retired work-item mail surface's inbox route — was removed;
 * see retire-work-item-mail-surface-2026-07-26.)
 */

const TIER_1_PREAMBLE = `## About Papercusp

You are an agent inside a Papercusp harness — an autonomous-harness framework
where role-based agent crews ("harnesses") build features.

- Each harness has a SPEC, a feature backlog, and a role crew (orchestrator,
  scoper, worker, validator, ...). Yours is below.
- Harnesses can have a parent and/or children, related via \`parent_slug\`.
  Yours is shown below if applicable.
- The substrate is the same for every harness — yours and everyone else's.
- You can inspect any other harness on demand via the read APIs listed in
  "Available read capabilities" below. Use them when relevant.`;

const TIER_3_CAPABILITIES_TEMPLATE = (operatorBase: string) => `## Available read capabilities

You can curl any of these to inspect the system; the response is returned
to you. Only do so when relevant to the current task.

- \`curl ${operatorBase}/api/harness/projects\`                       — full registry
- \`curl ${operatorBase}/api/harness/<slug>/status\`                  — full state of any harness
- \`curl ${operatorBase}/api/harness/<slug>/supervisor-notes\`        — any harness's supervisor notes
- \`curl ${operatorBase}/api/harness/all/recent-activity?limit=N\`    — global audit feed
- \`curl ${operatorBase}/api/marketplace/spawnable\`                  — templates you can spawn`;

interface ProjectRow {
  slug: string;
  path: string;
  parent_slug?: string | null;
  harness_kind?: string;
  hasState?: boolean;
}

interface HarnessStatusFeatureCounts { [status: string]: number }
interface HarnessStatus {
  feature_counts?: HarnessStatusFeatureCounts;
  feature_total?: number;
  recent_features?: { id: string; status: string; title: string }[];
  spawned_count?: number;
}

async function fetchJson<T>(url: string, timeoutMs = 5000): Promise<T | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) return null;
      return (await r.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

interface HarnessSummary {
  slug: string;
  feature_total: number;
  passed: number;
  in_progress: number;
  todo: number;
  failed: number;
  spawned: number;
  last_activity_iso: string | null;
}

async function summarizeHarness(operatorBase: string, slug: string, allProjects: ProjectRow[]): Promise<HarnessSummary> {
  const status = await fetchJson<HarnessStatus>(`${operatorBase}/api/harness/${encodeURIComponent(slug)}/status?phase=staging`);
  const counts = status?.feature_counts ?? {};
  const total = status?.feature_total ?? 0;
  const recent = status?.recent_features ?? [];
  const spawned = allProjects.filter((p) => p.parent_slug === slug).length;
  const lastActIso = recent.length > 0 ? null : null; // No reliable "last activity ts" wired yet
  return {
    slug,
    feature_total: total,
    passed: counts.passed ?? 0,
    in_progress: counts.in_progress ?? 0,
    todo: counts.todo ?? 0,
    failed: counts.failed ?? 0,
    spawned,
    last_activity_iso: lastActIso,
  };
}

function summaryLine(s: HarnessSummary): string {
  const parts: string[] = [];
  parts.push(`${s.feature_total} features`);
  if (s.passed > 0) parts.push(`${s.passed} passed`);
  if (s.in_progress > 0) parts.push(`${s.in_progress} in_progress`);
  if (s.todo > 0) parts.push(`${s.todo} todo`);
  if (s.failed > 0) parts.push(`${s.failed} failed`);
  parts.push(`spawned ${s.spawned}`);
  return parts.join(', ');
}

async function buildNeighborSection(
  operatorBase: string,
  selfSlug: string,
  parentSlug: string | null,
  allProjects: ProjectRow[],
): Promise<string> {
  const lines: string[] = ['## Neighbor harnesses'];

  // Parent
  if (parentSlug) {
    const parent = await summarizeHarness(operatorBase, parentSlug, allProjects);
    lines.push(`\n### Parent: ${parentSlug}`);
    lines.push(`- ${summaryLine(parent)}`);
  }

  // Children
  const children = allProjects.filter((p) => p.parent_slug === selfSlug);
  if (children.length > 0) {
    const summaries = await Promise.all(children.map((c) => summarizeHarness(operatorBase, c.slug, allProjects)));
    const agg = summaries.reduce(
      (a, s) => ({
        feature_total: a.feature_total + s.feature_total,
        passed: a.passed + s.passed,
        in_progress: a.in_progress + s.in_progress,
        todo: a.todo + s.todo,
        failed: a.failed + s.failed,
      }),
      { feature_total: 0, passed: 0, in_progress: 0, todo: 0, failed: 0 },
    );
    lines.push(`\n### Children (${children.length}) — aggregate: ${agg.feature_total} features, ${agg.passed} passed, ${agg.in_progress} in_progress, ${agg.todo} todo${agg.failed ? `, ${agg.failed} failed` : ''}`);
    for (const s of summaries) {
      lines.push(`- ${s.slug}: ${summaryLine(s)}`);
    }
  }

  // Siblings
  if (parentSlug) {
    const siblings = allProjects.filter((p) => p.parent_slug === parentSlug && p.slug !== selfSlug);
    if (siblings.length > 0) {
      const summaries = await Promise.all(siblings.map((s) => summarizeHarness(operatorBase, s.slug, allProjects)));
      lines.push(`\n### Siblings (${siblings.length}, share parent ${parentSlug})`);
      for (const s of summaries) {
        lines.push(`- ${s.slug}: ${summaryLine(s)}`);
      }
    }
  }

  if (lines.length === 1) return ''; // No relations to show
  return lines.join('\n');
}

export interface SubstrateContextInput {
  selfSlug: string;
  parentSlug: string | null;
  operatorBase?: string;
}

/**
 * Top-level assembler. Returns a markdown block ready to prepend to a role's
 * prompt. Returns '' on total failure (no operator, no PG, etc.) — the
 * caller's prompt is still complete without it.
 */
export async function fetchSubstrateContext(input: SubstrateContextInput): Promise<string> {
  const operatorBase = input.operatorBase ?? process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
  const sections: string[] = [];

  sections.push(TIER_1_PREAMBLE);

  // Self description (slug + parent)
  const selfBlock: string[] = ['## Your harness'];
  selfBlock.push(`- slug: \`${input.selfSlug}\``);
  if (input.parentSlug) {
    selfBlock.push(`- parent: \`${input.parentSlug}\``);
  }
  sections.push(selfBlock.join('\n'));

  // Tier 2: neighbor view
  try {
    const proj = await fetchJson<{ projects: ProjectRow[] }>(`${operatorBase}/api/harness/projects`);
    const all = proj?.projects ?? [];
    // Backfill parent_slug from projects rows we know are stored in PG (not the file registry).
    // The file registry doesn't carry parent_slug, but for now we trust the operator's response.
    const neighbor = await buildNeighborSection(operatorBase, input.selfSlug, input.parentSlug, all);
    if (neighbor) sections.push(neighbor);
  } catch { /* skip */ }

  // Tier 3: capabilities
  sections.push(TIER_3_CAPABILITIES_TEMPLATE(operatorBase));

  return sections.join('\n\n');
}
