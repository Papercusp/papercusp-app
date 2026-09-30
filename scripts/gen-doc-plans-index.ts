/**
 * gen-doc-plans-index.ts — project the plans landscape into a Starlight reference
 * page (starlight-projection-generators-2026-06-05 P-005).
 *
 * Source of truth: `harness_shared.harness_plans` (PG), read through the operator's
 * own `readAllPlans` (NOT a filesystem read — plans are PG-canonical, and
 * `lint:plans-pg` forbids FS reads of plan markdown). Emits reference/plans-index.md:
 * the plans grouped by status with item-count histograms + the `## Now` next-action.
 *
 * PG-dependent + high-churn (plans move every few minutes across the fleet) → the
 * `:check` is ADVISORY (D-002), and the generator DEGRADES GRACEFULLY: if PG is
 * unreachable (e.g. CI with no DB) it leaves the committed page untouched and exits
 * 0 — it never fails a build.
 *
 *   npx tsx scripts/gen-doc-plans-index.ts          # write (needs PG)
 *   npx tsx scripts/gen-doc-plans-index.ts --check  # warn (advisory) if drifted
 */
import { readAllPlans, type PlanRow } from '../packages/operator-core/lib/agent-tools/plans/source';
import { emitOrCheck, generatedBanner, frontmatter, cell } from './lib/doc-projection';

/** Plan statuses, in display order; anything else falls into "other". */
const STATUS_ORDER = ['active', 'ready', 'draft', 'shipped', 'superseded'] as const;

const NEXT_MAX = 220;
function truncate(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > NEXT_MAX ? one.slice(0, NEXT_MAX - 1).trimEnd() + '…' : one;
}

function histogram(items: PlanRow['items']): string {
  if (!items || items.length === 0) return '—';
  const counts = new Map<string, number>();
  for (const it of items) counts.set(it.status, (counts.get(it.status) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([s, n]) => `${cell(s)} ${n}`)
    .join(', ');
}

function build(rows: PlanRow[]): string {
  const live = rows.filter((r) => !r.archived);
  const byStatus = new Map<string, PlanRow[]>();
  for (const r of live) {
    const s = r.status ?? 'draft';
    (byStatus.get(s) ?? byStatus.set(s, []).get(s)!).push(r);
  }
  const orderedStatuses = [
    ...STATUS_ORDER.filter((s) => byStatus.has(s)),
    ...[...byStatus.keys()].filter((s) => !STATUS_ORDER.includes(s as (typeof STATUS_ORDER)[number])).sort(),
  ];

  const lines: string[] = [];
  lines.push(
    frontmatter({
      title: 'Plans index',
      description:
        'Every Papercusp plan, grouped by status, with item-count histograms and the current next-action. Generated from the PG plan store (a snapshot — may lag live state).',
      sidebarOrder: 5,
      // EI-10937: 276KB dump of every plan — same lexical black-hole problem as the
      // insights index. Navigation, not an answer.
      searchable: false,
    }),
  );
  lines.push('');
  lines.push(generatedBanner('gen:doc-plans-index'));
  lines.push('');
  lines.push('# Plans index');
  lines.push('');
  lines.push(
    'Plans are the durable record of project history — each `## Decisions` block is the "why". This is a generated snapshot grouped by status; for the live, authoritative view use the `plans:*` tools (`plans:list` / `plans:get { slug }`). Because plans churn constantly, this page is a periodically-regenerated convenience, not a live mirror.',
  );
  lines.push('');
  lines.push(`**${live.length} live plans.** By status: ${orderedStatuses.map((s) => `${cell(s)} (${byStatus.get(s)!.length})`).join(', ')}.`);
  lines.push('');

  for (const status of orderedStatuses) {
    const plans = byStatus.get(status)!.sort((a, b) => (a.planSlug < b.planSlug ? -1 : 1));
    lines.push(`## ${cell(status)} (${plans.length})`);
    lines.push('');
    lines.push('| Plan | Items | Next action |');
    lines.push('|---|---|---|');
    for (const p of plans) {
      const title = p.title ? `${cell(p.title)}<br/>\`${cell(p.planSlug)}\`` : `\`${cell(p.planSlug)}\``;
      lines.push(`| ${title} | ${histogram(p.items)} | ${cell(truncate(p.nowNext || '—'))} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  let rows: PlanRow[];
  try {
    const plans = await readAllPlans({ harnessSlug: 'all', includeArchived: false });
    rows = plans.map((p) => p.row);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      `⚠ plans-index: PG unreachable (${msg.split('\n')[0]}); leaving the committed page untouched (advisory, never gates)\n`,
    );
    process.exit(0);
  }
  emitOrCheck('plans-index.md', build(rows), { advisory: true });
  // readAllPlans opened a PG pool; exit explicitly so the process doesn't hang.
  process.exit(0);
}

void main();
