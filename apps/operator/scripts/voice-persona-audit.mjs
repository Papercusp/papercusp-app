#!/usr/bin/env node
/**
 * Voice persona drift audit.
 *
 * Per /docs/agents/operator-persona §10e: weekly cron (or run on
 * demand) queries harness_shared.voice_utterances for the last 7
 * days and emits a markdown report at docs/voice-persona-audit.md.
 *
 * Targets:
 *   - mode distribution: ~5% wry, ~80% default
 *   - name-use rate: ≤1 per 5-min window (caller-tracked)
 *   - backstory fires: ≤3/session
 *   - banned-preamble strips: 0 (any > 0 = prompt drift)
 *   - company-name leakage: 0
 *
 * Usage:
 *   node apps/operator/scripts/voice-persona-audit.mjs
 *   PG_URL=postgres://... node ... (override default)
 */

import postgres from 'postgres';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const PG_URL = process.env.PG_URL ?? 'postgres://harness_app:harness_app_pwd@localhost/papercusp';
const REPORT_PATH = process.env.REPORT_PATH ?? 'docs/voice-persona-audit.md';
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS ?? '7');

const sql = postgres(PG_URL);

async function main() {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60_000);
  const total = await sql`
    SELECT count(*)::int AS n FROM harness_shared.voice_utterances WHERE ts >= ${since}
  `;
  const totalCount = total[0]?.n ?? 0;

  if (totalCount === 0) {
    const report = renderEmpty(since);
    await ensureWritten(REPORT_PATH, report);
    console.log(`[voice-audit] no utterances in last ${WINDOW_DAYS} days; report written to ${REPORT_PATH}`);
    await sql.end();
    return;
  }

  const byMode = await sql`
    SELECT mode, count(*)::int AS n
    FROM harness_shared.voice_utterances
    WHERE ts >= ${since}
    GROUP BY mode
    ORDER BY n DESC
  `;
  const bySource = await sql`
    SELECT source, count(*)::int AS n
    FROM harness_shared.voice_utterances
    WHERE ts >= ${since}
    GROUP BY source
    ORDER BY n DESC
  `;
  const nameUse = await sql`
    SELECT
      sum(CASE WHEN name_used THEN 1 ELSE 0 END)::int AS used,
      count(*)::int AS total
    FROM harness_shared.voice_utterances
    WHERE ts >= ${since}
  `;
  const backstory = await sql`
    SELECT
      sum(CASE WHEN had_backstory THEN 1 ELSE 0 END)::int AS used,
      count(*)::int AS total
    FROM harness_shared.voice_utterances
    WHERE ts >= ${since}
  `;
  const modifications = await sql`
    SELECT modifications
    FROM harness_shared.voice_utterances
    WHERE ts >= ${since} AND modifications IS NOT NULL AND jsonb_array_length(modifications) > 0
  `;

  const modCounts = new Map();
  for (const row of modifications) {
    if (!Array.isArray(row.modifications)) continue;
    for (const m of row.modifications) {
      const key = String(m).split(':')[0];
      modCounts.set(key, (modCounts.get(key) ?? 0) + 1);
    }
  }

  const wryCount = byMode.find((r) => r.mode === 'wry')?.n ?? 0;
  const defaultCount = byMode.find((r) => r.mode === 'default')?.n ?? 0;
  const wryPct = totalCount > 0 ? (wryCount / totalCount) * 100 : 0;
  const defaultPct = totalCount > 0 ? (defaultCount / totalCount) * 100 : 0;
  const namePct = nameUse[0].total > 0 ? (nameUse[0].used / nameUse[0].total) * 100 : 0;
  const backstoryPct = backstory[0].total > 0 ? (backstory[0].used / backstory[0].total) * 100 : 0;

  const out = [];
  out.push('# Voice persona drift audit');
  out.push('');
  out.push(`- Generated: ${new Date().toISOString()}`);
  out.push(`- Window: last ${WINDOW_DAYS} days`);
  out.push(`- Total utterances: ${totalCount}`);
  out.push('');
  out.push('## Mode distribution');
  out.push('');
  out.push('| Mode | Count | Percent | Target |');
  out.push('|---|---:|---:|---|');
  for (const r of byMode) {
    const pct = totalCount > 0 ? ((r.n / totalCount) * 100).toFixed(1) : '0.0';
    const target = r.mode === 'wry' ? '~5%' : r.mode === 'default' ? '~80%' : '—';
    out.push(`| ${r.mode ?? '(null)'} | ${r.n} | ${pct}% | ${target} |`);
  }
  out.push('');
  out.push(`**Wry rate:** ${wryPct.toFixed(1)}% ${wryPct > 7 ? '⚠️ above target' : wryPct < 2 ? '⚠️ below target' : '✅ on target'}`);
  out.push(`**Default rate:** ${defaultPct.toFixed(1)}% ${Math.abs(defaultPct - 80) > 15 ? '⚠️ off target' : '✅ on target'}`);
  out.push('');
  out.push('## Source distribution');
  out.push('');
  out.push('| Source | Count |');
  out.push('|---|---:|');
  for (const r of bySource) out.push(`| ${r.source} | ${r.n} |`);
  out.push('');
  out.push(`> Note: \`elevenlabs-conv\` rows require the post-call webhook to be configured on the EL dashboard pointing at \`/api/elevenlabs/post-call\`. \`realtime\` rows aren't wired yet. Low counts in those sources indicate audit-coverage gaps, not actual silence.`);
  out.push('');
  out.push('## Name use');
  out.push('');
  out.push(`- Used: **${nameUse[0].used} / ${nameUse[0].total}** utterances (${namePct.toFixed(1)}%)`);
  out.push('- Target: well under 5%, distributed by mode (apologetic ~80%, default 0%, wry ~15%)');
  out.push('');
  out.push('## Backstory beats');
  out.push('');
  out.push(`- Detected: **${backstory[0].used} / ${backstory[0].total}** utterances (${backstoryPct.toFixed(1)}%)`);
  out.push('- Target: ≤ ~1% (3 fires / ~300 utterances per session)');
  out.push(`- Detector is heuristic (regex on persona-bank language); EL Conv AI utterances are not audited yet.`);
  out.push('');
  out.push('## prepareForTTS modifications');
  out.push('');
  out.push('| Rule | Hits | Notes |');
  out.push('|---|---:|---|');
  for (const [k, v] of [...modCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const note = k === 'preamble' ? '⚠️ prompt drift if > 0' : k === 'company' ? '⚠️ leak if > 0' : '';
    out.push(`| ${k} | ${v} | ${note} |`);
  }
  out.push('');
  out.push('## Action items');
  out.push('');
  const actions = [];
  if ((modCounts.get('preamble') ?? 0) > 0) actions.push('Banned preambles being stripped — tighten persona prompt.');
  if ((modCounts.get('company') ?? 0) > 0) actions.push('Real company names leaking — review backstory bank for additions, audit prompt.');
  if (wryPct > 8) actions.push('Wry rate too high — model is overusing the mode. Tighten the rubric.');
  if (defaultCount > 0 && defaultPct < 60) actions.push('Default mode underused — model may be over-classifying.');
  if (!actions.length) actions.push('Nothing flagged. Persona is on target.');
  for (const a of actions) out.push(`- ${a}`);
  out.push('');

  await ensureWritten(REPORT_PATH, out.join('\n'));
  console.log(`[voice-audit] ${totalCount} utterances analyzed; report → ${REPORT_PATH}`);
  await sql.end();
}

function renderEmpty(since) {
  return [
    '# Voice persona drift audit',
    '',
    `- Generated: ${new Date().toISOString()}`,
    `- Window: since ${since.toISOString()}`,
    '',
    'No utterances logged in the window. Either voice is unused or the',
    'audit pipeline is not wired (EL Conv AI / Realtime rows require a',
    'post-process webhook that is not yet implemented).',
    '',
  ].join('\n');
}

async function ensureWritten(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

main().catch((err) => {
  console.error('[voice-audit] failed:', err?.message ?? err);
  process.exit(1);
});
