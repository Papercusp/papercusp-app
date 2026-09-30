/**
 * claude-import.ts — one-shot idempotent import of the ~/.claude topic-file
 * memories into the canonical PG store (memory-pg-lexical-own-injection-2026-07-13
 * P-004, the D-008 verbatim/infer:false seam).
 *
 * The topic-file store is TWO populations (measured 2026-07-13: 1,807 active
 * files):
 *
 *  1. **Write-through projections** (~1,655): stamped `extra.link_id` = the
 *     canonical row's id by HybridBackend.remember. Their data ALREADY lives
 *     in `memory_canonical` — importing them would duplicate the store. They
 *     are SKIPPED. A projection whose link_id no longer resolves (the
 *     canonical row was forgotten/deleted; projections are reconciled by
 *     re-projection, not per-delete) is a GHOST — also skipped (the deletion
 *     was intentional; resurrecting it via import would undo a forget), but
 *     counted + reported separately.
 *  2. **Native/hand-curated files** (~152): no link_id — written by Claude
 *     Code's own file memory or by hand. These are the real import set.
 *
 * Scope mapping: a stored `metadata.scope` imports verbatim; an UNSCOPED file
 * imports under the OWNER'S USER POOL id — NOT 'local' — because the live
 * memory:search fan-out queries `[user.id, harness:*...]` (search.ts:196) and
 * a 'local' pool would never be queried again (the claude-file backend's
 * visibility-first "unscoped matches any scope" trick does not survive the
 * migration; the user pool is the honest home for the owner's own notes).
 *
 * Idempotency: every imported row carries `imported_from:
 * 'claude-file:<basename>'` in its payload; the planner pre-reads the
 * existing set and re-runs become no-ops. An exact-duplicate body already in
 * the target scope is also skipped (near-dup SEMANTIC merge stays with the
 * existing dedup machinery — run it after import, not during).
 *
 * Index files (MEMORY.md / MEMORY-overflow.md), archive/ (deliberate
 * forgets) and skills/ are never imported.
 */
import fs from 'node:fs';
import path from 'node:path';

import { parseTopicFile, type TopicFile } from '@papercusp/memory';

/** One parsed candidate file. */
export interface TopicFileCandidate {
  /** Basename incl. .md — the idempotency key suffix. */
  file: string;
  tf: TopicFile;
}

export interface ImportPlanInput {
  candidates: TopicFileCandidate[];
  /** Canonical ids that EXIST in memory_canonical (for link_id resolution). */
  existingCanonicalIds: ReadonlySet<string>;
  /** `imported_from` values already present in the store (re-run no-op). */
  alreadyImported: ReadonlySet<string>;
  /** Exact-dup guard: `${scope}\0${text}` keys already in the store. */
  existingBodies?: ReadonlySet<string>;
  /** Scope for files with no stored scope (the owner's user-pool id). */
  defaultScope: string;
}

export interface PlannedImport {
  file: string;
  scope: string;
  kind?: string;
  text: string;
  metadata: Record<string, unknown>;
}

export interface ImportPlan {
  imports: PlannedImport[];
  /** link_id resolves to a live canonical row — already in the store. */
  skippedLinked: number;
  /** link_id present but the canonical row is GONE — a deliberate forget; not resurrected. */
  ghosts: string[];
  /** imported_from already present — a prior run imported it. */
  skippedImported: number;
  /** identical body already in the target scope. */
  skippedExactDup: number;
  /** empty body AND empty description — nothing to store. */
  skippedEmpty: number;
}

export const IMPORTED_FROM_PREFIX = 'claude-file:';

export function importedFromKey(file: string): string {
  return `${IMPORTED_FROM_PREFIX}${file}`;
}

/** The text a candidate stores — body, falling back to the description. */
export function importText(tf: TopicFile): string {
  return tf.body.trim() || tf.description.trim();
}

export function bodyKey(scope: string, text: string): string {
  return `${scope}\0${text}`;
}

/**
 * Pure import planner — every skip/import decision in one testable place.
 * Does NO I/O; the CLI feeds it parsed files + the store's current state.
 */
export function planImport(input: ImportPlanInput): ImportPlan {
  const plan: ImportPlan = {
    imports: [],
    skippedLinked: 0,
    ghosts: [],
    skippedImported: 0,
    skippedExactDup: 0,
    skippedEmpty: 0,
  };
  for (const { file, tf } of input.candidates) {
    const linkId = typeof tf.extra?.link_id === 'string' ? tf.extra.link_id : undefined;
    if (linkId) {
      if (input.existingCanonicalIds.has(linkId)) plan.skippedLinked += 1;
      else plan.ghosts.push(file);
      continue;
    }
    if (input.alreadyImported.has(importedFromKey(file))) {
      plan.skippedImported += 1;
      continue;
    }
    const text = importText(tf);
    if (!text) {
      plan.skippedEmpty += 1;
      continue;
    }
    const scope = tf.scope?.trim() || input.defaultScope;
    if (input.existingBodies?.has(bodyKey(scope, text))) {
      plan.skippedExactDup += 1;
      continue;
    }
    // Carry the file's identity into the payload: `name` + `description`
    // feed the P-002 field-weighted lexical scoring; `type`/`kind` + extra
    // survive as filter/display metadata; `imported_from` is the
    // idempotency key.
    const { link_id: _drop, ...extraRest } = tf.extra ?? {};
    const metadata: Record<string, unknown> = {
      ...extraRest,
      ...(tf.name ? { name: tf.name } : {}),
      ...(tf.description ? { description: tf.description } : {}),
      ...(tf.type ? { type: tf.type } : {}),
      imported_from: importedFromKey(file),
    };
    plan.imports.push({
      file,
      scope,
      ...(tf.kind ?? tf.type ? { kind: tf.kind ?? tf.type } : {}),
      text,
      metadata,
    });
  }
  return plan;
}

/** Files never read as entries — mirrors ClaudeFileMemoryBackend.collect(). */
const INDEX_FILES = new Set(['MEMORY.md', 'MEMORY-overflow.md']);

/** Read + parse the top-level topic files (never index/archive/skills). */
export function readTopicFiles(memoryDir: string): TopicFileCandidate[] {
  const out: TopicFileCandidate[] = [];
  for (const d of fs.readdirSync(memoryDir, { withFileTypes: true })) {
    if (!d.isFile() || !d.name.endsWith('.md') || INDEX_FILES.has(d.name)) continue;
    try {
      out.push({ file: d.name, tf: parseTopicFile(fs.readFileSync(path.join(memoryDir, d.name), 'utf8')) });
    } catch {
      /* unreadable/unparseable file — skipped, reported by count diff */
    }
  }
  return out;
}
