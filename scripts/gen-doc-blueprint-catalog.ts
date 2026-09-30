/**
 * gen-doc-blueprint-catalog.ts — project the built-in harness blueprints into a
 * Starlight reference page (starlight-projection-generators-2026-06-05 P-001).
 *
 * Source of truth: the `blueprint.yaml` files under
 * libs/papercusp/packages/harness/blueprints/<id>/. Each declares a harness shape
 * (work-item kind + spine decider + roles + dispatch policy + gates). This reads
 * them straight off disk and emits reference/blueprint-catalog.md — a summary table
 * plus a per-blueprint detail block. Deterministic fs read of a low-churn source →
 * CI-gated (D-002).
 *
 *   npx tsx scripts/gen-doc-blueprint-catalog.ts          # write the page
 *   npx tsx scripts/gen-doc-blueprint-catalog.ts --check  # fail if the page drifted
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { REPO_ROOT, emitOrCheck, generatedBanner, frontmatter, cell } from './lib/doc-projection';

const BLUEPRINTS_DIR = join(REPO_ROOT, 'libs', 'papercusp', 'packages', 'harness', 'blueprints');

interface RoleEntry {
  id: string;
  reactive?: boolean;
  description?: string;
}

interface Blueprint {
  id: string;
  extends?: string;
  version?: string;
  description?: string;
  workItem?: { kind?: string; idPrefix?: string };
  dispatch?: { concurrency?: number; priority?: string };
  spine?: { decider?: string; maxTurns?: number };
  planner?: { kind?: string };
  roles?: Array<string | { id: string; reactive?: boolean; description?: string }>;
  gates?: {
    finalize?: {
      onDone?: Array<string | { role: string; extras?: string[] }>;
      onEscalate?: Array<string | { role: string; extras?: string[] }>;
    };
  };
}

/** The role/step name of a raw-YAML finalize entry (plain string, or `{role,extras}`). */
function finalizeEntryRoleName(entry: string | { role: string; extras?: string[] }): string {
  return typeof entry === 'string' ? entry : entry.role;
}

function normalizeRoles(roles: Blueprint['roles']): RoleEntry[] {
  if (!Array.isArray(roles)) return [];
  return roles.map((r) => (typeof r === 'string' ? { id: r } : { id: r.id, reactive: r.reactive, description: r.description }));
}

/** Read + parse every <id>/blueprint.yaml, sorted by id. */
function loadBlueprints(): Blueprint[] {
  const ids = readdirSync(BLUEPRINTS_DIR).filter((name) => {
    try {
      return statSync(join(BLUEPRINTS_DIR, name)).isDirectory();
    } catch {
      return false;
    }
  });
  const out: Blueprint[] = [];
  for (const id of ids) {
    const file = join(BLUEPRINTS_DIR, id, 'blueprint.yaml');
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue; // a dir without a blueprint.yaml — skip
    }
    const parsed = parseYaml(raw) as Blueprint;
    if (!parsed || typeof parsed !== 'object' || !parsed.id) continue;
    out.push(parsed);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function dispatchCell(bp: Blueprint): string {
  if (!bp.dispatch) return 'inherited';
  const c = bp.dispatch.concurrency;
  const p = bp.dispatch.priority;
  return cell([c !== undefined ? `concurrency ${c}` : null, p ? p : null].filter(Boolean).join(', ') || 'inherited');
}

function build(): string {
  const blueprints = loadBlueprints();
  const concrete = blueprints.filter((b) => b.workItem?.kind);
  const abstract = blueprints.filter((b) => !b.workItem?.kind);

  const lines: string[] = [];
  lines.push(
    frontmatter({
      title: 'Blueprint catalog',
      description:
        'The built-in harness blueprints — each a declarative harness shape (work-item kind, spine decider, roles, dispatch policy, gates). Generated from the blueprint.yaml source of truth.',
      sidebarOrder: 1,
    }),
  );
  lines.push('');
  lines.push(generatedBanner('gen:doc-blueprint-catalog'));
  lines.push('');
  lines.push('# Blueprint catalog');
  lines.push('');
  lines.push(
    'A **blueprint** is a harness\'s declarative shape — its work-item kind, the role spine the engine routes work through (`deriveNext`), its dispatch/concurrency policy, and its finalize gates. Concrete blueprints `extends: base`. The operator instantiates a harness from one of these (`harness:create` / `blueprint:extend`).',
  );
  lines.push('');
  lines.push(`Source: \`libs/papercusp/packages/harness/blueprints/<id>/blueprint.yaml\` (${concrete.length} concrete + ${abstract.length} abstract).`);
  lines.push('');

  // Summary table.
  lines.push('## Built-in blueprints');
  lines.push('');
  lines.push('| Blueprint | Extends | Work item | Decider | Dispatch | Roles | Description |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const bp of concrete) {
    const wi = bp.workItem?.kind ? `${cell(bp.workItem.kind)} (\`${cell(bp.workItem.idPrefix ?? '?')}\`)` : '—';
    const roles = normalizeRoles(bp.roles);
    lines.push(
      `| \`${cell(bp.id)}\` | ${cell(bp.extends ?? '—')} | ${wi} | ${cell(bp.spine?.decider ?? '—')} | ${dispatchCell(bp)} | ${roles.length} | ${cell(bp.description)} |`,
    );
  }
  lines.push('');

  if (abstract.length > 0) {
    lines.push('### Abstract (not directly runnable)');
    lines.push('');
    lines.push('| Blueprint | Description |');
    lines.push('|---|---|');
    for (const bp of abstract) lines.push(`| \`${cell(bp.id)}\` | ${cell(bp.description)} |`);
    lines.push('');
  }

  // Per-blueprint detail.
  lines.push('## Details');
  lines.push('');
  for (const bp of blueprints) {
    const roles = normalizeRoles(bp.roles);
    lines.push(`### \`${cell(bp.id)}\``);
    lines.push('');
    if (bp.description) {
      lines.push(cell(bp.description));
      lines.push('');
    }
    const facts: string[] = [];
    if (bp.extends) facts.push(`- **Extends:** \`${cell(bp.extends)}\``);
    if (bp.version) facts.push(`- **Version:** ${cell(bp.version)}`);
    if (bp.workItem?.kind) facts.push(`- **Work item:** \`${cell(bp.workItem.kind)}\` (id prefix \`${cell(bp.workItem.idPrefix ?? '?')}\`)`);
    if (bp.spine?.decider) facts.push(`- **Spine decider:** \`${cell(bp.spine.decider)}\`${bp.spine.maxTurns ? ` (maxTurns ${bp.spine.maxTurns})` : ''}`);
    if (bp.planner?.kind) facts.push(`- **Planner:** ${cell(bp.planner.kind)}`);
    if (bp.dispatch) facts.push(`- **Dispatch:** ${dispatchCell(bp)}`);
    if (bp.gates?.finalize) {
      const onDone = bp.gates.finalize.onDone?.map(finalizeEntryRoleName).join(' → ');
      const onEscalate = bp.gates.finalize.onEscalate?.map(finalizeEntryRoleName).join(' → ');
      const g = [onDone ? `done: ${onDone}` : null, onEscalate ? `escalate: ${onEscalate}` : null].filter(Boolean).join('; ');
      if (g) facts.push(`- **Finalize gates:** ${cell(g)}`);
    }
    if (roles.length > 0) {
      const roleList = roles
        .map((r) => `\`${cell(r.id)}\`${r.reactive ? ' (reactive)' : ''}`)
        .join(', ');
      facts.push(`- **Roles (${roles.length}):** ${roleList}`);
    }
    lines.push(...facts);
    lines.push('');
  }

  return lines.join('\n');
}

emitOrCheck('blueprint-catalog.md', build(), { advisory: false });
