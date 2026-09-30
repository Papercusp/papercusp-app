/**
 * Harness "memory map" — the registry of artifacts that function as
 * harness memory (SPEC.md, config.json, durable memory files, …), plus
 * the path/tier/liveness helpers the Memory-tab routes need.
 *
 * Relocated from `_hono/harness.ts` (endpoint-hono-elimination-2026-05-21
 * A4 batch 23). `MEMORY_MAP` + `MEMORY_ATTRIBUTION_META` were shared
 * between the memory routes and a boot-time fail-closed validation IIFE;
 * that validation now runs on import of THIS module (which the memory
 * route file imports), so it survives `_hono/harness.ts` deletion.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isHarnessDriverCmdline } from './harness-core';
import { getKnownRoles } from './known-roles';
import type { ProjectEntry } from './harness-registry';

export type MemoryTier = 'green' | 'yellow' | 'red';

export interface MemoryFileMeta {
  path: string;           // relative to projectPath (e.g. 'SPEC.md' or '.papercusp/features.json')
  purpose: string;
  writtenBy: string[];
  readBy: string[];
  tier: MemoryTier;       // enforcement level for edits
  language: 'markdown' | 'json' | 'text' | 'jsonl';
  optional?: boolean;     // file may legitimately not exist
}

export const MEMORY_MAP: MemoryFileMeta[] = [
  // Project-root, human-authored
  // (SPEC.md removed — deprecated by plans (D-004); no agent reads it.)
  { path: 'AGENTS.md',                            purpose: 'Project conventions',                      writtenBy: ['human'],                     readBy: ['scoper', 'worker', 'validator', 'architect'], tier: 'green',  language: 'markdown', optional: true },

  // Harness state
  { path: '.papercusp/config.json',                 purpose: 'Models, timeouts, cost cap, memory map',   writtenBy: ['human'],                     readBy: ['run.sh'],                                       tier: 'green',  language: 'json' },
  // (validation-contract.md removed — deprecated by inline VAL-* assertions, D-005.)

  // NOTE: features.json, issues.md, issues.json, pending-issues.jsonl all
  // moved to Postgres in the 2026-04-26 → 2026-04-27 FS→PG migration arc.

  // Durable memory
  { path: '.papercusp/memory/MEMORY.md',            purpose: 'Curated durable memory (seed)',            writtenBy: ['curator', 'human'],          readBy: ['scoper', 'worker', 'orchestrator', 'reviewer'], tier: 'green',  language: 'markdown' },
  { path: '.papercusp/memory/raw.md',               purpose: 'Append-only observations from agents',     writtenBy: ['all'],                       readBy: ['curator'],                                     tier: 'yellow', language: 'markdown' },
  { path: '.papercusp/memory/summary.md',           purpose: 'One-line run summaries',                   writtenBy: ['curator'],                   readBy: ['UI'],                                          tier: 'green',  language: 'markdown' },

  // Human loop
  { path: '.papercusp/supervisor-notes.md',         purpose: 'Human/architect guidance to orchestrator', writtenBy: ['human', 'architect'],        readBy: ['orchestrator', 'architect'],                   tier: 'green',  language: 'markdown', optional: true },
  // (escalation.md removed — escalations are needs-human plan items now, D-003/P-014.)

  // Scratch / user-authored
  { path: '.papercusp/worker-log.md',               purpose: 'Worker scratchpad',                        writtenBy: ['worker'],                    readBy: ['worker'],                                      tier: 'yellow', language: 'markdown', optional: true },
  { path: '.papercusp/knowledge.md',                purpose: 'Long-term domain notes for workers',       writtenBy: ['human'],                     readBy: ['worker'],                                      tier: 'green',  language: 'markdown', optional: true },
  { path: '.papercusp/brainstorm.md',               purpose: 'Freeform user brainstorm',                 writtenBy: ['human'],                     readBy: [],                                              tier: 'green',  language: 'markdown', optional: true },
];

/** Non-role attributions allowed in MEMORY_MAP.writtenBy / readBy. */
export const MEMORY_ATTRIBUTION_META = new Set(['human', 'all', 'run.sh', 'UI']);

export function resolveMemoryPath(project: ProjectEntry, rel: string): { abs: string } | null {
  // Sanitize: normalize, reject .., only allow within projectPath.
  const normalized = rel.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '');
  if (normalized.includes('..')) return null;
  if (normalized.length === 0) return null;
  const abs = join(project.path, normalized);
  const root = resolve(project.path);
  const target = resolve(abs);
  if (target !== root && !target.startsWith(root + '/')) return null;
  return { abs: target };
}

export function detectTier(rel: string): { tier: MemoryTier; meta: MemoryFileMeta | null } {
  const norm = rel.replace(/^\.\//, '').replace(/\\/g, '/');
  const exact = MEMORY_MAP.find((m) => m.path === norm);
  if (exact) return { tier: exact.tier, meta: exact };
  // Unknown files default to yellow (soft-warn) under .harness, else green.
  if (norm.startsWith('.papercusp/')) return { tier: 'yellow', meta: null };
  return { tier: 'green', meta: null };
}

export function isHarnessAlive(project: ProjectEntry): boolean {
  // Liveness probe — run.sh procs with cwd inside project.path.
  try {
    const procs = readdirSync('/proc').filter((d) => /^\d+$/.test(d));
    for (const pid of procs) {
      try {
        const cwd = readFileSync(`/proc/${pid}/cwd`, 'utf8').trim();
        if (!cwd.startsWith(project.path)) continue;
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (isHarnessDriverCmdline(cmdline)) return true;
      } catch {}
    }
  } catch {}
  return false;
}

/**
 * Fail-closed guard: every role in MEMORY_MAP.writtenBy/readBy must be a
 * registered role (`AGENT_ROLES`, via getKnownRoles) or a meta-actor in
 * MEMORY_ATTRIBUTION_META — otherwise the operator refuses to boot.
 * Runs once on module import.
 *
 * blueprint-role-bundling-2026-06-15 Phase 0 (EI-621): this was a *prompt-file-
 * on-disk* existence check (the FS was the registry). It now validates against
 * the `AGENT_ROLES` const so it survives deleting the global `prompts/` dir
 * (Phase 5) — same integrity guarantee (a typo'd attribution still fails boot),
 * decoupled from the filesystem.
 */
(function validateMemoryMapAttributions() {
  const validRoles = new Set(getKnownRoles());
  const offenders: { path: string; field: 'writtenBy' | 'readBy'; role: string }[] = [];
  for (const entry of MEMORY_MAP) {
    for (const field of ['writtenBy', 'readBy'] as const) {
      for (const role of entry[field]) {
        if (validRoles.has(role) || MEMORY_ATTRIBUTION_META.has(role)) continue;
        offenders.push({ path: entry.path, field, role });
      }
    }
  }
  if (offenders.length > 0) {
    const lines = offenders.map((o) => `  - ${o.path} ${o.field}: '${o.role}'`).join('\n');
    throw new Error(
      `MEMORY_MAP references roles not in the AGENT_ROLES registry (${offenders.length} bad reference${offenders.length === 1 ? '' : 's'}):\n${lines}\n` +
      `Either add the role to AGENT_ROLES (packages/agent-mcp/src/role-config.ts), ` +
      `remove the attribution, or add the value to MEMORY_ATTRIBUTION_META if it's a non-role meta-actor.`,
    );
  }
})();
