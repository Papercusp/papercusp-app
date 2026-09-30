#!/usr/bin/env node
/**
 * Phase 4 — route audit signal collector.
 *
 * Walks apps/operator/app/api/** route.ts files and emits a table that
 * scores each one along the four axes from host-architecture v2 §6.1:
 *
 *   (a) non-transport state in handler   — persistence / cost / locks
 *   (b) pre/post handler work that's not transport-agnostic
 *   (c) cookies / cost-caps / feature-locks
 *   (d) wire-contract stability (heuristic: file size + endpoint-system substrate use)
 *
 * The output is consumed by `apps/operator/docs/plans/route-audit-2026-05-20.md`.
 * Heuristic, not authoritative — the doc's recommendation column is the
 * human judgment call; the script's "hint" column is the starting point.
 *
 * Run:
 *   node apps/operator/scripts/route-audit.mjs
 *   node apps/operator/scripts/route-audit.mjs --family admin
 *   node apps/operator/scripts/route-audit.mjs --json > audit.json
 */

import { readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';

const REPO_ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const API_ROOT = join(REPO_ROOT, 'apps/operator/app/api');

const argv = process.argv.slice(2);
const familyFilter = pickArg('--family');
const asJson = argv.includes('--json');

function pickArg(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

/* ─── signal probes ─────────────────────────────────────────────────── */

function usesEndpointSystem(text) {
  return /from ['"]@papercusp\/agent-mcp/.test(text) ||
         /defineTool\s*\(/.test(text) ||
         /dispatchProjectedTool/.test(text);
}

function usesNextHeaders(text) {
  return /from ['"]next\/headers['"]/.test(text);
}

function usesCookies(text) {
  // A handler that reads/writes the session cookie is transport-coupled
  // by definition. cookies() from next/headers is one signal; the
  // bare `req.cookies.get(...)` shape from NextRequest is another.
  return /\bcookies\(\)/.test(text) ||
         /req\.cookies\.|request\.cookies\./.test(text);
}

function usesLoopbackGate(text) {
  return /isLoopback\s*\(/.test(text) ||
         /isLoopbackRequest|isLoopbackIp/.test(text);
}

function usesRequirePrincipal(text) {
  // The Principal RFC's consolidated auth gate. A route that calls
  // requirePrincipal has already been swept; no further consolidation work.
  return /requirePrincipal\s*\(/.test(text);
}

function usesCostCap(text) {
  return /recordSpend|enforceCostCap|checkBudget|costCap/.test(text);
}

function usesFeatureLock(text) {
  return /featureLock|requireCapability|acquireFeatureLock/.test(text);
}

function usesPersistence(text) {
  // Any direct PG access from a route is non-transport state.
  return /getOrgPg|getHarnessPg|getWorkspacePg|drizzle/.test(text) ||
         /INSERT INTO|UPDATE \w+ SET|DELETE FROM/.test(text);
}

function usesPluginHost(text) {
  return /getPluginHost|loadPlugin|pluginRuntime/.test(text);
}

function declaresStream(text) {
  // SSE responses + ReadableStream returns indicate streaming wire shape.
  return /text\/event-stream/.test(text) ||
         /new ReadableStream/.test(text);
}

function loc(text) {
  return text.split(/\r?\n/).length;
}

/* ─── classification heuristic ──────────────────────────────────────── */

function classify(signals) {
  // A1-class — keep as a shim. The plan's §6.1 rule: any single "yes" on
  // (a)-(c) bumps the route into A1.
  if (signals.usesCostCap || signals.usesFeatureLock || signals.usesPluginHost) return 'A1';
  // Cookie auth without substrate: route is transport-coupled.
  if (signals.usesCookies && !signals.usesEndpointSystem) return 'A1';
  // Large file with persistence + streaming = likely A1 (the agent-chats
  // precedent — 419 LoC, transcript persistence).
  if (signals.loc > 200 && signals.usesPersistence) return 'A1';
  // Already endpoint-system → no migration needed; mark separately.
  if (signals.usesEndpointSystem) return 'substrate';
  // Principal RFC sweep already applied — auth gate migrated to
  // requirePrincipal(). No further consolidation work.
  if (signals.usesRequirePrincipal) return 'consolidated-already';
  // Loopback-gated + nothing else complex = consolidation target for
  // the Principal RFC sweep, not endpoint-system migration.
  if (signals.usesLoopbackGate && signals.loc < 100 && !signals.usesPersistence) return 'consolidate';
  // Small read-only PG-touching route — typically migratable as a
  // defineTool projection.
  if (signals.usesPersistence && signals.loc < 100 && !signals.declaresStream) return 'migrate';
  // Streaming route without cost-cap/lock — could be migrated to the
  // endpoint system's events: contract.
  if (signals.declaresStream && !signals.usesCostCap && !signals.usesFeatureLock) return 'migrate';
  // Fallback: needs a manual look.
  return 'review';
}

/* ─── walk ──────────────────────────────────────────────────────────── */

function walk(dir, out) {
  const fs = require('node:fs');
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.next' || entry.name === 'node_modules') continue;
      walk(path, out);
    } else if (entry.name === 'route.ts') {
      out.push(path);
    }
  }
}

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const routes = [];
walk(API_ROOT, routes);
routes.sort();

const rows = [];
for (const path of routes) {
  const rel = relative(REPO_ROOT, path);
  const family = rel.replace(/^apps\/operator\/app\/api\//, '').split('/')[0];
  if (familyFilter && family !== familyFilter) continue;
  const text = readFileSync(path, 'utf8');
  const signals = {
    loc: loc(text),
    usesEndpointSystem: usesEndpointSystem(text),
    usesNextHeaders: usesNextHeaders(text),
    usesCookies: usesCookies(text),
    usesLoopbackGate: usesLoopbackGate(text),
    usesRequirePrincipal: usesRequirePrincipal(text),
    usesCostCap: usesCostCap(text),
    usesFeatureLock: usesFeatureLock(text),
    usesPersistence: usesPersistence(text),
    usesPluginHost: usesPluginHost(text),
    declaresStream: declaresStream(text),
  };
  const hint = classify(signals);
  rows.push({ family, route: rel, signals, hint });
}

/* ─── output ────────────────────────────────────────────────────────── */

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  // Summary
  const summary = {};
  for (const r of rows) {
    summary[r.hint] = (summary[r.hint] ?? 0) + 1;
  }
  console.error(`\nRoutes audited: ${rows.length}`);
  console.error(`Hints: ${JSON.stringify(summary)}\n`);

  // Per-family breakdown
  const byFamily = {};
  for (const r of rows) {
    byFamily[r.family] = byFamily[r.family] ?? { migrate: 0, consolidate: 0, 'consolidated-already': 0, A1: 0, substrate: 0, review: 0 };
    byFamily[r.family][r.hint]++;
  }
  const families = Object.keys(byFamily).sort();
  console.error('Family                        migrate consol  done  A1  subst  review  total');
  for (const fam of families) {
    const s = byFamily[fam];
    const total = s.migrate + s.consolidate + s['consolidated-already'] + s.A1 + s.substrate + s.review;
    console.error(
      `${fam.padEnd(28)}  ${String(s.migrate).padStart(7)}  ${String(s.consolidate).padStart(6)}  ${String(s['consolidated-already']).padStart(4)}  ${String(s.A1).padStart(2)}  ${String(s.substrate).padStart(5)}  ${String(s.review).padStart(6)}  ${String(total).padStart(5)}`,
    );
  }
  console.error('');

  // Detail rows for the family-filtered case (otherwise too noisy)
  if (familyFilter) {
    console.log('| route | LoC | hint | sub | nextH | cook | loop | req | cost | lock | pers | plug | strm |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of rows) {
      const s = r.signals;
      console.log(
        `| \`${r.route}\` | ${s.loc} | ${r.hint} | ${b(s.usesEndpointSystem)} | ${b(s.usesNextHeaders)} | ${b(s.usesCookies)} | ${b(s.usesLoopbackGate)} | ${b(s.usesRequirePrincipal)} | ${b(s.usesCostCap)} | ${b(s.usesFeatureLock)} | ${b(s.usesPersistence)} | ${b(s.usesPluginHost)} | ${b(s.declaresStream)} |`,
      );
    }
  }
}

function b(v) { return v ? '✓' : ''; }
