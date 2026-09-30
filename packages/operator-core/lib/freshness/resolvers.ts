/**
 * freshness/resolvers — the DOMAIN half of the freshness axis (P-007, D-013).
 *
 * `./index.ts` is the pure algorithm (zero imports, extraction-ready). This file
 * is deliberately the only domain-coupled part: it turns a declared dependency tag
 * into a VERSION TOKEN read from the live world.
 *
 * ## The design rule for a token
 *
 * A token must change **iff** the dependency materially changed, and it must be
 * derivable from state that already exists. Every kind below reuses a version the
 * system already maintains — a file's bytes, `work_items.updated_ts`,
 * `harness_plans.version` — which is what lets this whole axis skip generation
 * counters and stay correct across process restarts (D-013).
 *
 * Tokens are also kept HUMAN-LEGIBLE where cheap (`open@1737…` rather than a bare
 * number), because they are rendered into a stale verdict's `was → now` diff that
 * an agent reads.
 *
 * ## Adding a kind
 *
 * Add one entry to {@link DEP_RESOLVERS}. Resolvers are BATCHED — each receives
 * every ref of its kind so N dependencies cost one query, not N.
 *
 * ## Failure discipline
 *
 * A resolver returns `null` for a ref it cannot resolve and NEVER throws: the pure
 * layer reports those as `unresolvable` and does not count them as changed. A
 * transient PG error or a temporarily-absent file must not manufacture a stale
 * verdict — the point of this axis is to stop crying stale without cause.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { detectPapercupRoot } from '../harness/register-papercusp';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../harness-registry';
import { selectUnambiguousEvidenceRoot } from '../evidence-root-selection';

/** Context a resolver needs to scope its lookups. */
export interface FreshnessResolverCtx {
  workspaceId: string;
  /** The harness the declaring note belongs to; `null` for a harness-null item. */
  harness: string | null;
  /** Repo root for `file:` refs. Defaults to the detected papercusp root. */
  repoRoot?: string | null;
}

/** Batched: given every ref of one kind, return ref → token (or null). */
export type DepResolver = (
  refs: readonly string[],
  ctx: FreshnessResolverCtx,
) => Promise<Map<string, string | null>>;

/** Split `kind:ref` on the FIRST colon — a ref may itself contain colons. */
export function splitDep(dep: string): { kind: string; ref: string } | null {
  const idx = dep.indexOf(':');
  if (idx <= 0 || idx === dep.length - 1) return null;
  return { kind: dep.slice(0, idx), ref: dep.slice(idx + 1) };
}

/**
 * Normalize the bare work-item ids agents commonly use in checkpoint calls.
 *
 * The freshness substrate stores typed dependency tags (`work-item:WI-123`),
 * while work-item tools conventionally accept bare ids (`WI-123`, `EI-123`,
 * or a feature-shaped `F-...` id). Keeping this repair at the dependency write
 * boundary makes the stored token canonical and leaves arbitrary untyped strings
 * invalid rather than guessing that a file path or other ref is a work-item.
 */
export function normalizeDep(dep: string): string {
  const trimmed = dep.trim();
  if (splitDep(trimmed)) return trimmed;

  const match = /^(WI|EI|F)-([A-Za-z0-9][A-Za-z0-9_-]*)$/i.exec(trimmed);
  if (!match) return trimmed;
  return `work-item:${match[1]!.toUpperCase()}-${match[2]}`;
}

function allNull(refs: readonly string[]): Map<string, string | null> {
  return new Map(refs.map((r) => [r, null]));
}

/**
 * `file:<repo-relative path>` → `sha256:<first 16 hex>` of the file's bytes.
 *
 * The highest-value kind: it is the ONLY signal that catches a dependency changed
 * by a PEER, which every existing time heuristic is structurally blind to (they
 * all key on the note author's own activity).
 *
 * Content-hashed rather than mtime'd on purpose — a git-sync checkout, a rebase, or
 * a touch moves mtime without changing meaning, and a false stale here would train
 * agents to ignore the verdict.
 */
type FreshnessFileRootSource = 'harness-root' | 'canonical-repo';

function containedFilePath(root: string, ref: string): string | null {
  // Preserve the existing containment contract: absolute and ../-escaping refs
  // remain unresolvable at every root, including the canonical fallback.
  if (isAbsolute(ref) || normalize(ref).startsWith('..')) return null;
  const rootResolved = resolve(root);
  const full = resolve(join(rootResolved, ref));
  if (full !== rootResolved && !full.startsWith(rootResolved + sep)) return null;
  return full;
}

function fileRefsResolveAtRoot(refs: readonly string[], root: string, allowDirectories = false): boolean {
  return refs.every((ref) => {
    const full = containedFilePath(root, ref);
    if (!full || !existsSync(full)) return false;
    try {
      const stat = statSync(full);
      return stat.isFile() || (allowDirectories && stat.isDirectory());
    } catch {
      return false;
    }
  });
}

/**
 * Select one checkout for a complete set of `file:` dependency refs.
 *
 * A registry-derived harness root stays authoritative while it resolves every
 * file. A phantom root may fall back to the canonical repo only when that repo
 * resolves the complete set. When neither does, preserve the harness root so the
 * existing per-file resolver returns null and the checkpoint writer drops those
 * stamps loudly instead of manufacturing freshness evidence.
 */
export function selectFreshnessFileRoot(
  refs: readonly string[],
  harnessRoot: string | null,
  canonicalRepoRoot: string | null,
  options: { allowDirectories?: boolean } = {},
): string | null {
  const allowDirectories = options.allowDirectories ?? false;
  if (!harnessRoot) {
    return canonicalRepoRoot && fileRefsResolveAtRoot(refs, canonicalRepoRoot, allowDirectories)
      ? canonicalRepoRoot
      : null;
  }
  const preferred = { root: harnessRoot, source: 'harness-root' as const };
  const selected = selectUnambiguousEvidenceRoot<FreshnessFileRootSource>({
    preferred,
    ...(canonicalRepoRoot
      ? { fallback: { root: canonicalRepoRoot, source: 'canonical-repo' as const } }
      : {}),
    resolvesEvery: (root) => fileRefsResolveAtRoot(refs, root, allowDirectories),
  });
  return selected?.root ?? preferred.root;
}

async function resolveHarnessRepoRoots(
  ctx: FreshnessResolverCtx,
): Promise<{ preferred: string | null; canonical: string | null }> {
  // An explicit override is a caller-owned test/embedding contract, not an ambient
  // registry guess. Keep it authoritative and do not escape to another checkout.
  if (ctx.repoRoot !== undefined && ctx.repoRoot !== null) {
    return { preferred: ctx.repoRoot, canonical: null };
  }

  // A checkpoint's file dependencies belong to the item's harness, not to the
  // operator process's current/release checkout. Keep the detected root as a
  // compatibility fallback for unscoped items and for installs where the
  // registry cannot be read.
  if (ctx.harness) {
    try {
      const registry = await loadHarnessRegistry(ctx.workspaceId);
      const harnessRoot = resolveHarnessContentPath(registry, ctx.harness);
      if (harnessRoot) {
        return { preferred: harnessRoot, canonical: detectPapercupRoot() };
      }
    } catch {
      // Registry reads are best-effort here; an unavailable registry must not
      // make the freshness resolver throw or change its existing fallback.
    }
  }
  const canonical = detectPapercupRoot();
  return { preferred: canonical, canonical: null };
}

const resolveFiles = async (refs: readonly string[], ctx: FreshnessResolverCtx, allowDirectories = false) => {
  const out = new Map<string, string | null>();
  const roots = await resolveHarnessRepoRoots(ctx);
  const root = selectFreshnessFileRoot(refs, roots.preferred, roots.canonical, { allowDirectories });
  if (!root) return allNull(refs);
  await Promise.all(
    refs.map(async (ref) => {
      const full = containedFilePath(root, ref);
      if (!full) {
        out.set(ref, null);
        return;
      }
      try {
        const stat = allowDirectories ? statSync(full) : null;
        if (stat?.isDirectory()) {
          out.set(ref, 'present:directory');
          return;
        }
        const buf = await readFile(full);
        out.set(ref, `sha256:${createHash('sha256').update(buf).digest('hex').slice(0, 16)}`);
      } catch {
        out.set(ref, null); // absent/unreadable ⇒ unresolvable, never "changed"
      }
    }),
  );
  return out;
};

/**
 * EI-22169368425533789: the multi-checkout workspace (`~/papercupai-workspace/`)
 * holds ~50 independent repos side by side. A repo-relative `file:` ref is only
 * meaningful WITH its repo, and nothing forces a citation to say which one — so an
 * accurate cross-repo pointer fails every same-repo probe (`ls`, `find`, `grep`)
 * exactly like a fabricated one would, and reads as a hallucination to the next
 * agent. Mirrors the workspace-root convention `resolveHostWorkspaceRoot()`
 * (p2p/foreign-workspaces.ts) resolves for the P2P foreign-workspace registry —
 * duplicated here as one env read rather than imported, to keep this hot
 * checkpoint-write path out of that module's unrelated DB-backed import graph.
 *
 * Best-effort and NEVER throws: an unreadable workspace root, or any individual
 * stat failure, is silently skipped. This only ever adds a HINT to an already-
 * unresolved dependency — it never blocks or changes the checkpoint write itself.
 */
export function findFileInSiblingCheckouts(ref: string, opts: { workspaceRoot?: string } = {}): string | null {
  // Same containment contract as containedFilePath: no absolute/escaping refs.
  if (isAbsolute(ref) || normalize(ref).startsWith('..')) return null;
  const workspaceRoot =
    opts.workspaceRoot ?? process.env.PAPERCUSP_WORKSPACE_ROOT ?? `${process.env.HOME ?? ''}/papercupai-workspace`;
  let entries: Dirent[];
  try {
    entries = readdirSync(workspaceRoot, { withFileTypes: true });
  } catch {
    return null; // no such workspace root on this host ⇒ nothing to probe
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = containedFilePath(resolve(workspaceRoot, entry.name), ref);
    if (!full) continue;
    try {
      if (statSync(full).isFile()) return entry.name;
    } catch {
      // absent in this sibling ⇒ keep scanning the rest
    }
  }
  return null;
}

/**
 * Compose the `depsWarnings` line for one unresolvable `file:` dependency,
 * enriched with the sibling-checkout hint above when it finds a hit — turning
 * "could not be resolved" (a dead end indistinguishable from a typo or a
 * fabrication) into "wrong repo" (an actionable, corrected citation). Falls back
 * to the original bare message when no sibling has the file either — the honest
 * "may not exist anywhere in this workspace" case.
 */
export function describeUnresolvedFileDep(
  dep: string,
  opts: { workspaceRoot?: string; harness?: string | null } = {},
): string {
  const parts = splitDep(dep);
  const ref = parts?.ref ?? dep;
  const sibling = findFileInSiblingCheckouts(ref, { workspaceRoot: opts.workspaceRoot });
  if (!sibling) return `"${dep}" could not be resolved right now and was not stamped`;
  const here = opts.harness ? `harness "${opts.harness}"` : 'this harness';
  return (
    `"${dep}" not found in ${here}, but exists in sibling checkout "${sibling}" ` +
    `(same workspace, different repo) — repo-qualify the citation so the next agent doesn't read it as fabricated`
  );
}

/**
 * `work-item:<id>` → `<status>@<updated_ts>`.
 *
 * Covers both families in one pass: feature-family rows live in
 * `harness_shared.work_items` (keyed by `feature_id`), issue-family EI/bug/change
 * rows in `harness_shared.engineer_issues` (keyed by `issue_id`). A checkpoint
 * routinely cites either, so resolving only one family would silently report the
 * other as unresolvable forever.
 *
 * Scoped by `workspace_id` — the multi-tenant footgun CLAUDE.md warns about: a
 * bare filter on the id alone can hit another tenant's row and read as a spurious
 * change. Harness is deliberately NOT part of the filter: a work-item id is unique
 * within a workspace, and a note may legitimately depend on an item in another
 * harness.
 */
const resolveWorkItems: DepResolver = async (refs, ctx) => {
  const out = allNull(refs);
  if (!ctx.workspaceId) return out;
  const ids = [...new Set(refs)];
  try {
    const { sql } = getOrgPg();
    const featureRows = await sql<{ feature_id: string; status: string | null; updated_ts: string | number | null }[]>`
      SELECT feature_id, status, updated_ts
        FROM harness_shared.work_items
       WHERE workspace_id = ${ctx.workspaceId} AND feature_id = ANY(${ids})`;
    for (const row of featureRows) {
      out.set(row.feature_id, `${row.status ?? 'unknown'}@${row.updated_ts ?? 0}`);
    }
    const missing = ids.filter((id) => out.get(id) == null);
    if (missing.length > 0) {
      const issueRows = await sql<{ issue_id: string; state: string | null; updated_at: Date | null }[]>`
        SELECT issue_id, state, updated_at
          FROM harness_shared.engineer_issues
         WHERE workspace_id = ${ctx.workspaceId} AND issue_id = ANY(${missing})`;
      for (const row of issueRows) {
        out.set(row.issue_id, `${row.state ?? 'unknown'}@${row.updated_at ? row.updated_at.getTime() : 0}`);
      }
    }
  } catch {
    /* leave unresolved — warn-only */
  }
  return out;
};

/**
 * `plan:<slug>` → `v<version>` from `harness_plans`.
 *
 * `version` is a monotonic bigint the plan store already bumps on every revision,
 * so it needs no derivation. Keyed on the full `(workspace_id, harness_slug,
 * plan_slug)` tenant triple — a raw filter on `plan_slug` alone can silently read
 * another tenant's plan (the exact trap the repo-conventions insight documents).
 */
const resolvePlans: DepResolver = async (refs, ctx) => {
  const out = allNull(refs);
  if (!ctx.workspaceId || !ctx.harness) return out;
  const slugs = [...new Set(refs)];
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ plan_slug: string; version: string | number | null }[]>`
      SELECT plan_slug, version
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${ctx.workspaceId}
         AND harness_slug = ${ctx.harness}
         AND plan_slug = ANY(${slugs})`;
    for (const row of rows) out.set(row.plan_slug, `v${row.version ?? 0}`);
  } catch {
    /* leave unresolved — warn-only */
  }
  return out;
};

/** The registry. Adding a dependency kind is one entry here. */
export const DEP_RESOLVERS: Readonly<Record<string, DepResolver>> = Object.freeze({
  file: resolveFiles,
  'work-item': resolveWorkItems,
  plan: resolvePlans,
});

/** The kinds a caller may declare — surfaced in tool guidance + validation errors. */
export const SUPPORTED_DEP_KINDS = Object.freeze(Object.keys(DEP_RESOLVERS));

/**
 * Validate a declared dependency tag. Returns an error string, or `null` when ok.
 * Used at the WRITE seam so a typo'd kind fails loudly at declaration time rather
 * than silently resolving to `unresolvable` forever after (a dep that can never
 * resolve is worse than no dep — it looks declared but can never invalidate).
 */
export function validateDep(dep: string): string | null {
  const parts = splitDep(dep);
  if (!parts) return `"${dep}" is not a valid dependency — expected "<kind>:<ref>"`;
  if (!(parts.kind in DEP_RESOLVERS)) {
    return `"${dep}" declares unknown kind "${parts.kind}" — supported: ${SUPPORTED_DEP_KINDS.join(', ')}`;
  }
  return null;
}

/**
 * Resolve every declared dependency to its current token, batched per kind.
 * Never throws: an unknown kind or a failing resolver yields `null` for its refs,
 * which the pure layer reports as `unresolvable`.
 */
export async function resolveCurrentTokens(
  deps: readonly string[],
  ctx: FreshnessResolverCtx,
  options: { allowDirectories?: boolean } = {},
): Promise<Map<string, string | null>> {
  const byKind = new Map<string, string[]>();
  const out = new Map<string, string | null>();

  for (const dep of deps) {
    const parts = splitDep(dep);
    if (!parts || !(parts.kind in DEP_RESOLVERS)) {
      out.set(dep, null);
      continue;
    }
    const list = byKind.get(parts.kind);
    if (list) list.push(parts.ref);
    else byKind.set(parts.kind, [parts.ref]);
  }

  await Promise.all(
    [...byKind.entries()].map(async ([kind, refs]) => {
      let resolved: Map<string, string | null>;
      try {
        resolved =
          kind === 'file'
            ? await resolveFiles(refs, ctx, options.allowDirectories ?? false)
            : await DEP_RESOLVERS[kind]!(refs, ctx);
      } catch {
        resolved = allNull(refs);
      }
      // Re-key from bare ref back to the full `kind:ref` tag the stamps use.
      for (const ref of refs) out.set(`${kind}:${ref}`, resolved.get(ref) ?? null);
    }),
  );

  return out;
}
