/**
 * Layer 1 audit — structural anchor validation.
 *
 * Plan: papercusp-su-memory-2026-05-25 (Phase 5, P-019).
 *
 * For each memory anchor extracted at write time (P-014/P-015), check
 * cheaply that the anchor still resolves:
 *   - 'file'      — fs.stat resolves under the configured repoRoot
 *   - 'plan'      — a harness_plans row exists for the slug (PG; plans went
 *                   PG-canonical — plans-pg-canonical-migration-2026-06-03).
 *                   Injected lookup, like 'feature'.
 *   - 'migration' — fs.stat resolves under libs/papercusp/libs/db/sql
 *                   with prefix matching
 *   - 'feature'   — PG row exists in any harness_<slug>.harness_features
 *                   with the matching id (callback supplied)
 *   - 'symbol'    — skipped at this layer (would need a project-wide
 *                   grep; deferred to Layer 3)
 *
 * Pure-logic core: the auditor takes an `AnchorChecker` for each kind
 * and a list of memories. The checker callbacks are injected so this
 * module never depends on `fs` or PG directly; both are testable.
 *
 * The CLI wrapper that wires real fs + PG and runs nightly lives
 * elsewhere (TODO: bin/audit-memory-anchors.ts — schedule once
 * migration 085 lands).
 */

import type { Anchor } from './anchors';

export interface MemoryWithAnchors {
  memoryId: string;
  anchors: Anchor[];
}

export type AnchorCheckResult =
  | { ok: true }
  | { ok: false; reason: string };

export type AnchorChecker = (anchor: Anchor) => Promise<AnchorCheckResult>;

/**
 * The four checkers a real CLI wrapper plugs in.
 */
export interface AuditCheckers {
  file: AnchorChecker;
  plan: AnchorChecker;
  migration: AnchorChecker;
  feature: AnchorChecker;
  /** Optional; default skips symbols (returns ok). */
  symbol?: AnchorChecker;
}

export interface AuditedAnchor {
  memoryId: string;
  anchor: Anchor;
  ok: boolean;
  reason: string | null;
  checkedAt: string; // ISO timestamp
}

export interface AuditedMemory {
  memoryId: string;
  anchors: AuditedAnchor[];
  /** True iff at least one anchor failed (and so memory.state should flip). */
  hasBroken: boolean;
}

export interface AuditReport {
  startedAt: string;
  finishedAt: string;
  memoriesChecked: number;
  anchorsChecked: number;
  anchorsBroken: number;
  memoriesBroken: number;
  broken: AuditedMemory[];
  /** All memories audited (use to write last_checked_at across the board). */
  all: AuditedMemory[];
}

/**
 * Run Layer 1 audit. Pure — no I/O, all checks delegated to callbacks.
 */
export async function runAnchorAudit(opts: {
  memories: MemoryWithAnchors[];
  checkers: AuditCheckers;
  /** Defaults to () => new Date().toISOString(). Test hook. */
  now?: () => string;
}): Promise<AuditReport> {
  const now = opts.now ?? (() => new Date().toISOString());
  const startedAt = now();

  const all: AuditedMemory[] = [];
  let anchorsChecked = 0;
  let anchorsBroken = 0;

  for (const m of opts.memories) {
    const auditedAnchors: AuditedAnchor[] = [];
    let memBroken = false;

    for (const anchor of m.anchors) {
      anchorsChecked++;
      const checker = pickChecker(anchor.kind, opts.checkers);
      let result: AnchorCheckResult;
      try {
        result = await checker(anchor);
      } catch (err) {
        result = { ok: false, reason: `checker_threw:${(err as Error).message}` };
      }

      auditedAnchors.push({
        memoryId: m.memoryId,
        anchor,
        ok: result.ok,
        reason: result.ok ? null : result.reason,
        checkedAt: now(),
      });

      if (!result.ok) {
        anchorsBroken++;
        memBroken = true;
      }
    }

    all.push({
      memoryId: m.memoryId,
      anchors: auditedAnchors,
      hasBroken: memBroken,
    });
  }

  const broken = all.filter((m) => m.hasBroken);

  return {
    startedAt,
    finishedAt: now(),
    memoriesChecked: opts.memories.length,
    anchorsChecked,
    anchorsBroken,
    memoriesBroken: broken.length,
    broken,
    all,
  };
}

function pickChecker(
  kind: Anchor['kind'],
  checkers: AuditCheckers,
): AnchorChecker {
  switch (kind) {
    case 'file': return checkers.file;
    case 'plan': return checkers.plan;
    case 'migration': return checkers.migration;
    case 'feature': return checkers.feature;
    case 'symbol':
      // Default: skip symbols at Layer 1 (would need project-wide grep).
      return checkers.symbol ?? (async () => ({ ok: true }));
    default: {
      // Exhaustive guard — TS will warn if we add a kind without a case
      const _exhaustive: never = kind;
      return async () => ({ ok: false, reason: `unknown_kind:${_exhaustive}` });
    }
  }
}

/* ─── Standard checker factories ─────────────────────────────────────── */
/* These wrap real fs + PG calls. The audit logic above accepts any   */
/* checker, but the standard set is what production should use.        */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * A 'file' anchor that points OUTSIDE the repo BY NATURE — so the repo-root
 * `fs.stat` can never resolve it and flagging it `broken_anchor` is a FALSE
 * positive (the file is real, just not a tracked repo source). Skipped (ok).
 *
 * Covers: absolute / home / parent-escape paths, secrets
 * (`~/.claude/.credentials.json`), `~/.papercusp` runtime state
 * (`endpoint-ipc.json` / `embedded-pg.json`), OS/scratch roots
 * (`usr/` `root/` `tmp/` `proc/` `home/` `cargo/` `omp/`), and the SIBLING
 * repos that git-sync does not own (`papercup-rust-mobile/`, `Restart/`).
 * PURE — unit-testable without fs.
 */
export function isExternalFileAnchor(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('~') ||
    value.startsWith('../') ||
    value.includes('.credentials') ||
    /(^|\/)(endpoint-ipc|embedded-pg)\.json$/.test(value) ||
    /^(usr|root|tmp|proc|home|cargo|omp)\//.test(value) ||
    /^(papercup-rust-mobile|Restart)\//.test(value)
  );
}

export type FileAnchorVerdict =
  | { ok: true; reason?: 'external' | 'resolved_by_basename'; resolved?: string }
  | { ok: false; reason: 'file_not_found' };

/**
 * Resolve a 'file' anchor against the repo. Pure — `exists` + `basenameMatches`
 * are injected (so this tests without fs/git):
 *   1. exact repo-relative path resolves → ok.
 *   2. an external-by-nature path (see {@link isExternalFileAnchor}) → ok (skipped).
 *   3. a package-relative path (the write-path historically stored anchors
 *      package-relative, e.g. `locks/acquire.ts`) whose basename has a UNIQUE
 *      repo file → ok (resolved). >1 match: accept only if a 2-segment suffix
 *      is unique; otherwise leave it broken (ambiguous — needs human context).
 *   4. else → file_not_found (a genuinely stale/deleted anchor — the real signal).
 */
export function classifyFileAnchor(
  value: string,
  deps: { exists: (rel: string) => boolean; basenameMatches: (base: string) => string[] },
): FileAnchorVerdict {
  if (deps.exists(value)) return { ok: true };
  if (isExternalFileAnchor(value)) return { ok: true, reason: 'external' };
  const segs = value.split('/');
  const base = segs[segs.length - 1];
  const matches = deps.basenameMatches(base);
  if (matches.length === 1) return { ok: true, reason: 'resolved_by_basename', resolved: matches[0] };
  if (matches.length > 1) {
    const tail = segs.slice(-2).join('/');
    const suffix = matches.filter((m) => m.endsWith('/' + value) || m.endsWith('/' + tail));
    if (suffix.length === 1) return { ok: true, reason: 'resolved_by_basename', resolved: suffix[0] };
  }
  return { ok: false, reason: 'file_not_found' };
}

/** Memoized basename → repo-relative-paths index (submodule-aware), keyed by
 *  repoRoot. Built from `git ls-files`; if git is unavailable the index is
 *  empty and the checker degrades to literal-path + external-skip only. */
let _repoFileIndex: { root: string; byBase: Map<string, string[]> } | null = null;
function repoBasenameIndex(repoRoot: string): Map<string, string[]> {
  if (_repoFileIndex && _repoFileIndex.root === repoRoot) return _repoFileIndex.byBase;
  const byBase = new Map<string, string[]>();
  try {
    const out = execFileSync('git', ['ls-files', '--recurse-submodules'], {
      cwd: repoRoot,
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'ignore'], // discard git's stderr (e.g. "not a git repository" in a tmp root)
    }).toString();
    for (const f of out.split('\n')) {
      if (!f) continue;
      const b = f.slice(f.lastIndexOf('/') + 1);
      const arr = byBase.get(b);
      if (arr) arr.push(f);
      else byBase.set(b, [f]);
    }
  } catch {
    /* git unavailable (e.g. a tmp test root) → empty index; literal + external only */
  }
  _repoFileIndex = { root: repoRoot, byBase };
  return byBase;
}

export function fileChecker(repoRoot: string): AnchorChecker {
  const byBase = repoBasenameIndex(repoRoot);
  return async (anchor) => {
    const verdict = classifyFileAnchor(anchor.value, {
      exists: (rel) => {
        try {
          fs.statSync(path.join(repoRoot, rel));
          return true;
        } catch {
          return false;
        }
      },
      basenameMatches: (b) => byBase.get(b) ?? [],
    });
    return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
  };
}

/**
 * PG-backed plan anchor checker (plans-pg-canonical-migration-2026-06-03):
 * plans live in `harness_shared.harness_plans`, not on disk, so a `plan` anchor
 * is valid iff a row exists for the slug. The caller injects the existence
 * lookup (so this module stays free of `@papercusp/db-org`), exactly like
 * {@link featureChecker}.
 */
export function planCheckerPg(
  lookup: (planSlug: string) => Promise<boolean>,
): AnchorChecker {
  return async (anchor) => {
    try {
      const exists = await lookup(anchor.value);
      return exists ? { ok: true } : { ok: false, reason: 'plan_not_found' };
    } catch (err) {
      return { ok: false, reason: `plan_lookup_failed:${(err as Error).message}` };
    }
  };
}

export function migrationChecker(sqlDir: string): AnchorChecker {
  return async (anchor) => {
    // Anchor value is the 3-4 digit migration number. The actual file
    // is `<num>-<slug>.sql` — match by prefix.
    let entries: string[];
    try {
      entries = await fs.promises.readdir(sqlDir);
    } catch {
      return { ok: false, reason: 'sql_dir_not_readable' };
    }
    const num = String(anchor.value).padStart(3, '0');
    const found = entries.some(
      (e) => e.startsWith(`${num}-`) && e.endsWith('.sql'),
    );
    return found
      ? { ok: true }
      : { ok: false, reason: 'migration_not_found' };
  };
}

/**
 * featureChecker takes an async lookup that returns true iff the
 * F-NNN id exists in any harness's harness_features table. The
 * caller supplies it (so this module doesn't import @papercusp/db-org).
 */
export function featureChecker(
  lookup: (featureId: string) => Promise<boolean>,
): AnchorChecker {
  return async (anchor) => {
    try {
      const exists = await lookup(anchor.value);
      return exists
        ? { ok: true }
        : { ok: false, reason: 'feature_not_found' };
    } catch (err) {
      return { ok: false, reason: `feature_lookup_failed:${(err as Error).message}` };
    }
  };
}
