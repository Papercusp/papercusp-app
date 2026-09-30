#!/usr/bin/env node
/**
 * papercup status — one-screen briefing shown when the user opens a
 * native console via the operator's `+` button.
 *
 * Reads:
 *   - PAPERCUSP_API_BASE (default http://127.0.0.1:3070)
 *   - PAPERCUSP_WORKSPACE (default 'default')
 *   - PAPERCUSP_HARNESS_SLUG (optional)
 *
 * The real capability of the launched terminal isn't this CLI — it's
 * that the user can type `claude` / `codex` / `omp` and have full
 * superuser MCP access (145+ tools per the tool catalog). This greeting
 * just orients them.
 *
 * All endpoint calls are best-effort; any failure prints a degraded
 * line rather than throwing. The console launch should never fail
 * because the operator endpoint flaked.
 */

const baseUrl = (process.env.PAPERCUSP_API_BASE ?? 'http://127.0.0.1:3070').replace(/\/$/, '');
const slug = process.env.PAPERCUSP_HARNESS_SLUG ?? null;
const workspace = process.env.PAPERCUSP_WORKSPACE ?? 'default';

const lines = [];
lines.push(`papercup — workspace '${workspace}'` + (slug ? ` · harness '${slug}'` : ''));

async function safeJson(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

if (slug) {
  const [health, scanRes, esc] = await Promise.all([
    safeJson(`${baseUrl}/api/harness/${encodeURIComponent(slug)}/health`),
    safeJson(`${baseUrl}/api/agent-mcp/operator-scans?limit=1`),
    safeJson(`${baseUrl}/api/harness/${encodeURIComponent(slug)}/escalation`),
  ]);

  if (health) {
    if (health.alive === false) {
      lines.push('  • harness is not running');
    } else if (typeof health.failing === 'number' && health.failing > 0) {
      lines.push(`  • ${health.failing} failing feature${health.failing === 1 ? '' : 's'}`);
    }
    if (health.escalated) lines.push('  • escalated');
  }

  const latestScan = scanRes?.scans?.[0];
  if (latestScan?.suggestionCount > 0) {
    lines.push(`  • ${latestScan.suggestionCount} pending suggestion${latestScan.suggestionCount === 1 ? '' : 's'}`);
  }

  if (esc?.escalation) {
    const first = String(esc.escalation).split('\n').find((l) => l.trim()) ?? '';
    if (first) lines.push(`  • escalation: ${first.slice(0, 80)}`);
  }
}

lines.push('');
lines.push('  papercup status            this summary');
lines.push('  claude / codex / omp       full MCP access (145+ tools) via .mcp.json');
lines.push('');

console.log(lines.join('\n'));
