#!/usr/bin/env tsx
/**
 * One-shot PLUR → mem0 migration helper.
 *
 * Plan: papercusp-su-memory-2026-05-25 (Phase 6 P-026).
 *
 * Reads ~/.plur/engrams.yaml (or --path /custom/engrams.yaml), parses
 * the engrams, classifies each into the mem0 kind taxonomy, and emits
 * one JSON object per line on stdout. The user can pipe to a filter
 * before round-tripping into mem0.
 *
 * Two modes:
 *   --list (default): print each engram as JSONL — fields are
 *     `{ id, kind, content, harness_slug?, tags, ... }`. Non-destructive.
 *   --remember-cmd: print, per engram, the shell command to call
 *     memory:remember via the MCP HTTP transport. User can copy/paste
 *     selected ones to import.
 *
 * Bulk auto-import is NOT supported. PLUR's 400+ engrams include drift
 * (the original motivation for this plan); mass-importing reintroduces
 * the noise we're trying to escape. Triage is intentional.
 *
 * Filtering:
 *   - status: 'active' only by default (skips retired/superseded)
 *   - --include-retired to also emit retired engrams
 *
 * Classification:
 *   - knowledge_type.memory_class=semantic + type=behavioral → 'preference'
 *   - knowledge_type.memory_class=semantic + type=correction → 'correction'
 *   - type=project / domain=software.* → 'project'
 *   - default → 'preference' (safest fallback)
 *
 * Output is deterministic + idempotent — same input always produces
 * the same JSONL.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type EngramKind = 'preference' | 'correction' | 'project';

export interface PlurEngram {
  id: string;
  statement: string;
  rationale?: string;
  status?: string;
  type?: string;
  domain?: string;
  scope?: string;
  tags?: string[];
  knowledge_type?: {
    memory_class?: string;
    cognitive_level?: string;
  };
}

export interface MigratedEntry {
  source_id: string;
  kind: EngramKind;
  content: string;
  harness_slug?: string;
  tags: string[];
  status: string;
}

interface CliOptions {
  path: string;
  includeRetired: boolean;
  rememberCmd: boolean;
  mcpUrl: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    path: path.join(os.homedir(), '.plur', 'engrams.yaml'),
    includeRetired: false,
    rememberCmd: false,
    mcpUrl: 'http://localhost:3070/api/mcp?superuser=1',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--path' && i + 1 < argv.length) { opts.path = argv[++i]; }
    else if (a === '--include-retired') { opts.includeRetired = true; }
    else if (a === '--remember-cmd') { opts.rememberCmd = true; }
    else if (a === '--mcp-url' && i + 1 < argv.length) { opts.mcpUrl = argv[++i]; }
  }
  return opts;
}

/**
 * Parse engrams.yaml. Single-purpose mini-parser keyed to the actual
 * PLUR shape: top-level `engrams:` array of objects with indented
 * scalar fields. Handles the multi-line `statement: >-` form by
 * folding continuation lines.
 *
 * Not a general YAML parser — explicitly tuned to this file.
 */
export function parseEngramsYaml(text: string): PlurEngram[] {
  const lines = text.split('\n');
  const engrams: PlurEngram[] = [];
  let current: Partial<PlurEngram> | null = null;
  let currentField: keyof PlurEngram | null = null;
  let currentFieldBuf: string[] = [];

  const flushField = () => {
    if (current && currentField && currentFieldBuf.length > 0) {
      const value = currentFieldBuf.join(' ').trim();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (current as any)[currentField] = value;
    }
    currentField = null;
    currentFieldBuf = [];
  };

  const flushEngram = () => {
    flushField();
    if (current && current.id && current.statement) {
      engrams.push(current as PlurEngram);
    }
    current = null;
  };

  let inEngramsBlock = false;
  let inTagsList = false;
  let inKnowledgeType = false;
  let knowledgeType: PlurEngram['knowledge_type'] = {};

  for (const line of lines) {
    if (!inEngramsBlock) {
      if (/^engrams:\s*$/.test(line)) inEngramsBlock = true;
      continue;
    }

    // New engram (top-level list item) — indented 2 spaces then `- id:`
    const newEngram = /^  - id:\s*(.+)$/.exec(line);
    if (newEngram) {
      if (current) {
        if (Object.keys(knowledgeType).length > 0) {
          current.knowledge_type = knowledgeType;
          knowledgeType = {};
        }
        flushEngram();
      }
      current = { id: newEngram[1].trim() };
      currentField = null;
      currentFieldBuf = [];
      inTagsList = false;
      inKnowledgeType = false;
      continue;
    }

    if (!current) continue;

    // Field key (4-space indented `key: value`)
    const fieldKey = /^    ([a-z_]+):\s*(.*)$/.exec(line);
    if (fieldKey) {
      flushField();
      const key = fieldKey[1];
      const val = fieldKey[2].trim();
      inTagsList = false;
      inKnowledgeType = false;
      if (key === 'tags' && val === '') {
        inTagsList = true;
        current.tags = [];
      } else if (key === 'knowledge_type') {
        inKnowledgeType = true;
      } else if (val === '>-' || val === '|' || val === '>') {
        currentField = key as keyof PlurEngram;
      } else if (
        key === 'statement' || key === 'rationale' || key === 'status' ||
        key === 'type' || key === 'domain' || key === 'scope'
      ) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (current as any)[key] = val.replace(/^['"]|['"]$/g, '');
      }
      continue;
    }

    if (inTagsList) {
      const tag = /^      - (.+)$/.exec(line);
      if (tag) {
        current.tags!.push(tag[1].trim().replace(/^['"]|['"]$/g, ''));
        continue;
      }
      inTagsList = false;
    }

    if (inKnowledgeType) {
      const kt = /^      ([a-z_]+):\s*(.+)$/.exec(line);
      if (kt) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (knowledgeType as any)[kt[1]] = kt[2].trim().replace(/^['"]|['"]$/g, '');
        continue;
      }
      inKnowledgeType = false;
    }

    // Continuation of a folded scalar (>-)
    if (currentField && /^      /.test(line)) {
      currentFieldBuf.push(line.trim());
    }
  }

  if (current) {
    if (Object.keys(knowledgeType).length > 0) {
      current.knowledge_type = knowledgeType;
    }
    flushEngram();
  }

  return engrams;
}

export function classifyKind(engram: PlurEngram): EngramKind {
  const type = (engram.type ?? '').toLowerCase();
  const cls = (engram.knowledge_type?.memory_class ?? '').toLowerCase();
  if (type === 'correction') return 'correction';
  if (type === 'project' || (engram.domain ?? '').startsWith('software.')) {
    return 'project';
  }
  if (cls === 'semantic' || type === 'behavioral') return 'preference';
  return 'preference';
}

export function migrateEngram(engram: PlurEngram): MigratedEntry {
  const content = engram.rationale
    ? `${engram.statement}\n\nRationale: ${engram.rationale}`
    : engram.statement;
  return {
    source_id: engram.id,
    kind: classifyKind(engram),
    content,
    tags: engram.tags ?? [],
    status: engram.status ?? 'active',
  };
}

function shellEscape(s: string): string {
  // Single-quote escape; replace ' with '\''
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function emitJsonl(entries: MigratedEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n');
}

export function emitRememberCmds(
  entries: MigratedEntry[],
  mcpUrl: string,
): string {
  const lines = entries.map((e) => {
    const args = { content: e.content, kind: e.kind };
    const payload = {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'memory:remember', arguments: args },
    };
    return `# source: ${e.source_id} (${e.kind}) [${e.tags.join(', ')}]\n` +
      `curl -sS -X POST ${shellEscape(mcpUrl)} \\\n` +
      `  -H 'Content-Type: application/json' \\\n` +
      `  -d ${shellEscape(JSON.stringify(payload))}\n`;
  });
  return lines.join('\n');
}

export async function main(opts: CliOptions): Promise<number> {
  let text: string;
  try {
    text = await fs.promises.readFile(opts.path, 'utf8');
  } catch (err) {
    console.error(`migrate-plur-to-mem0: cannot read ${opts.path}: ${(err as Error).message}`);
    return 1;
  }

  const engrams = parseEngramsYaml(text);
  const filtered = engrams.filter((e) => {
    if (opts.includeRetired) return true;
    return (e.status ?? 'active') === 'active';
  });

  const entries = filtered.map(migrateEngram);

  if (opts.rememberCmd) {
    process.stdout.write(emitRememberCmds(entries, opts.mcpUrl) + '\n');
  } else {
    process.stdout.write(emitJsonl(entries) + '\n');
  }
  console.error(
    `migrate-plur-to-mem0: parsed=${engrams.length} kept=${entries.length} ` +
    `(retired-skipped=${engrams.length - entries.length})`,
  );
  return 0;
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  main(opts).then(
    (rc) => process.exit(rc),
    (err) => {
      console.error('migrate-plur-to-mem0: failed', err);
      process.exit(1);
    },
  );
}
