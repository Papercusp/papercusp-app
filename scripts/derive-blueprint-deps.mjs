#!/usr/bin/env node
/**
 * Derive each built-in blueprint's `dependencies.{tools,plugins}` candidates
 * from its role personas (official-blueprints-cupboard-publish-2026-06-05
 * P-002 / D-002: "derive the tool list from each blueprint's role personas —
 * what they call").
 *
 * For every blueprint under libs/papercusp/packages/harness/blueprints/:
 *   roles = declared roles[] ∪ spine.decider ∪ roles referenced by spine edges
 *           ∪ reactive[].role
 *   personas = the same leaf-first extends-chain used by prompt-resolve.ts:
 *            blueprints/<id>/prompts/<role>.md
 *            ∪ each ancestor's prompt
 *            ∪ blueprints/base/prompts/<role>.md (always)
 *            ∪ apps/operator/prompts/<role>.{tools,persona}.md (operator-side)
 *   mentions = backtick-wrapped `group:verb` tokens (the tools-md-sync regex)
 *   program ops (steps/gate) are listed separately — only ones that are REAL
 *   catalog tools are dep candidates.
 *
 * The static tool catalog is built the same way tools-md-sync.test.ts builds
 * it: defineTool `name:` fields + plugin-manifest tool entries (which also
 * give the tool→plugin mapping for `plugins` deps).
 *
 * OUTPUT IS A REVIEW AID, not an auto-writer: a human curates the final
 * `dependencies:` block per blueprint (dep accuracy is a plan risk — a wrong
 * dep is a runtime failure or a spurious install prompt).
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BLUEPRINTS = join(REPO, 'libs/papercusp/packages/harness/blueprints');
const OPERATOR_PROMPTS = join(REPO, 'apps/operator/prompts');

// ── static tool catalog (mirrors tools-md-sync.test.ts) ─────────────────────
const catalogBuiltin = new Set(); // defineTool names (built-in / operator catalog)
const pluginToolOwner = new Map(); // tool name → plugin name

function walkToolFiles(dir, onFile) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkToolFiles(full, onFile);
    else if (entry.endsWith('.ts') && !entry.includes('.test.') && !entry.startsWith('index.')) onFile(full);
  }
}
// Walk ALL of agent-mcp + operator-core lib — defineTool calls live outside
// lib/agent-tools too (e.g. lib/coord-ops/agent-tools.ts defines coord:vote /
// coord:thread-post; lib/endpoint-route defines named tools).
for (const root of ['packages/agent-mcp/src', 'packages/operator-core/lib']) {
  walkToolFiles(join(REPO, root), (file) => {
    const src = readFileSync(file, 'utf8');
    if (!src.includes('defineTool(')) return;
    for (const m of src.matchAll(/name:\s*['"]([a-zA-Z0-9_]+[:.][a-zA-Z0-9_:.\-]+)['"]/g)) {
      catalogBuiltin.add(m[1]);
    }
  });
}
function walkManifests(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkManifests(full);
    else if (entry === 'papercusp.json') {
      try {
        const json = JSON.parse(readFileSync(full, 'utf8'));
        const plugin = String(json.name ?? '').replace(/^@[^/]+\//, '');
        for (const tool of json.tools ?? []) {
          const mcpName = tool.expose?.mcp?.name ?? `${plugin}.${tool.name}`;
          pluginToolOwner.set(mcpName, plugin);
        }
      } catch { /* skip unparseable */ }
    }
  }
}
walkManifests(join(REPO, 'libs/papercusp/plugins'));

// ── persona mention extraction (the tools-md-sync regex) ────────────────────
const FILE_SUFFIX = /\.(md|ts|tsx|js|jsx|mjs|cjs|json|sh|py|css|html|toml|yaml|yml)$/i;
function mentionsIn(md) {
  const out = new Set();
  // Bare `tool:verb` mentions (the tools-md-sync regex) PLUS the leading
  // tool token of an arg-bearing span (`plans:items {actionable:true}`).
  for (const m of md.matchAll(/`([a-zA-Z0-9_]+[:.][a-zA-Z0-9_:.\-\/]+)`/g)) {
    const c = m[1];
    if (FILE_SUFFIX.test(c) || c.includes('/')) continue;
    out.add(c);
  }
  for (const m of md.matchAll(/`([a-zA-Z0-9_]+:[a-zA-Z0-9_.\-]+) [^`]*`/g)) {
    out.add(m[1]);
  }
  // CLI bridge usage: `harness-features <verb>` is the features/work-items
  // surface reached over the CLI instead of MCP — map to the canonical read
  // pair so the dep travels with the listing.
  if (/harness-features\s+(list|all|get|count)/.test(md)) {
    out.add('features:get');
    out.add('work_items:list');
  }
  return out;
}

function blueprintExtends(id) {
  const path = join(BLUEPRINTS, id, 'blueprint.yaml');
  if (!existsSync(path)) return [];
  try {
    const parsed = parseYaml(readFileSync(path, 'utf8'));
    if (parsed?.extends == null) return [];
    return Array.isArray(parsed.extends) ? parsed.extends.map(String) : [String(parsed.extends)];
  } catch {
    return [];
  }
}

// Keep this chain calculation structurally aligned with prompt-resolve.ts:
// leaf first, cycle guarded, and always terminated by the universal base library.
function resolveBlueprintChain(blueprintId) {
  const chain = [];
  const seen = new Set();
  const walk = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    chain.push(id);
    for (const parent of blueprintExtends(id)) walk(parent);
  };
  walk(blueprintId);
  if (!chain.includes('base')) chain.push('base');
  return chain;
}

export function personaFilesFor(blueprintId, role) {
  const files = [];
  for (const id of resolveBlueprintChain(blueprintId)) {
    const f = join(BLUEPRINTS, id, 'prompts', `${role}.md`);
    if (existsSync(f)) files.push(f);
  }
  for (const f of [join(OPERATOR_PROMPTS, `${role}.tools.md`), join(OPERATOR_PROMPTS, `${role}.persona.md`)]) {
    if (existsSync(f)) files.push(f);
  }
  return files;
}

// ── per-blueprint derivation ─────────────────────────────────────────────────
const report = {};
for (const id of readdirSync(BLUEPRINTS).sort()) {
  const bpFile = join(BLUEPRINTS, id, 'blueprint.yaml');
  if (!existsSync(bpFile)) continue;
  const bp = parseYaml(readFileSync(bpFile, 'utf8'));

  const roles = new Set();
  for (const r of bp.roles ?? []) if (r?.id) roles.add(r.id);
  if (bp.spine?.decider) roles.add(bp.spine.decider);
  for (const edge of Object.values(bp.spine?.edges ?? {})) {
    if (edge && typeof edge === 'object' && edge.role) roles.add(edge.role);
  }
  for (const r of bp.reactive ?? []) if (r?.role) roles.add(r.role);

  const programOps = new Set();
  for (const s of bp.spine?.steps ?? []) if (s?.op && s.op !== 'resolve') programOps.add(s.op);
  for (const g of bp.spine?.gate ?? []) if (g?.op && g.op !== 'resolve') programOps.add(g.op);

  const mentioned = new Set();
  const personaFiles = [];
  const rolesWithoutPersona = [];
  for (const role of [...roles].sort()) {
    const files = personaFilesFor(id, role);
    if (files.length === 0) rolesWithoutPersona.push(role);
    for (const f of files) {
      personaFiles.push(f.replace(REPO + '/', ''));
      for (const m of mentionsIn(readFileSync(f, 'utf8'))) mentioned.add(m);
    }
  }

  const tools = [...mentioned].filter((t) => catalogBuiltin.has(t)).sort();
  const viaPlugins = [...mentioned].filter((t) => pluginToolOwner.has(t)).sort();
  const plugins = [...new Set(viaPlugins.map((t) => pluginToolOwner.get(t)))].sort();
  const opsInCatalog = [...programOps].filter((t) => catalogBuiltin.has(t)).sort();
  const opsNotTools = [...programOps].filter((t) => !catalogBuiltin.has(t)).sort();
  const unmatched = [...mentioned]
    .filter((t) => !catalogBuiltin.has(t) && !pluginToolOwner.has(t))
    .sort();

  report[id] = {
    declared: bp.dependencies ?? null,
    roles: [...roles].sort(),
    rolesWithoutPersona,
    personaFiles,
    candidates: { tools, plugins, pluginTools: viaPlugins, programOpsInCatalog: opsInCatalog },
    programOpsNotCatalogTools: opsNotTools,
    unmatchedMentions: unmatched,
  };
}

console.log(JSON.stringify({ catalogSize: catalogBuiltin.size, pluginTools: pluginToolOwner.size, blueprints: report }, null, 2));
