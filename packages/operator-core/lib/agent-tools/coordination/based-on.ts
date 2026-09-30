/**
 * based-on.ts — P-008's last leg (unified-agent-state-plane-2026-07-27, D-084):
 * the sender's information provenance, AUTO-DERIVED from what it actually read.
 *
 * ── WHAT THIS CLOSES ─────────────────────────────────────────────────────────
 *
 * D-002 rules that a declaration is authored only at COMMITMENTS and derived
 * everywhere else; D-011 names this particular one — *"`basedOn` (sender's
 * information provenance) is likewise auto-derived from recent reads, not
 * authored"*; D-064 puts it on the ENVELOPE (a property of the session, not of a
 * paragraph). All three were satisfied on paper: the field was TYPED, threaded
 * through the send stamp and the reader projection, and rendered by the pui —
 * and never once written, because the `deriveEvidence` seam its own doc-comment
 * promised did not exist anywhere in the tree. This module is that seam.
 *
 * ── WHY INVOCATIONS AND NOT CELL READS (D-084 R3) ────────────────────────────
 *
 * The obvious reading of "what the sender READ" is `state:read`. Measured before
 * building: `state:read` was called FOUR times in seven days by two agents, and
 * the cell registry holds five cells, all resolving through one tool. A
 * cell-scoped derivation would therefore have been empty on ~100% of sends —
 * the same defect it was written to fix, rebuilt deliberately.
 *
 * What agents DO read is logged already: `work_items:get` (1982 calls / 2d),
 * `plans:get` (1359), `plans:items`, `plans:get-item`, `capability:read` — each
 * with the ref sitting in `args_json`, on a table indexed exactly the way this
 * query needs (`tool_invocations_coord_owner_idx` on `(coord_owner_id,
 * invoked_at DESC)`). So the trace is READ off the invocation log at send time:
 * no new table, no new write on any hot path, and nothing for an agent to
 * remember to do.
 *
 * ── ONE GRAMMAR, ONE VERSIONER ───────────────────────────────────────────────
 *
 * Refs are emitted as the `kind:ref` dependency tags `freshness/resolvers.ts`
 * already defines (`work-item:` · `plan:` · `file:`), and versioned through the
 * SAME batched `DEP_RESOLVERS` a work-item checkpoint's `dependsOn` uses. That is
 * D-038 axis 5 applied to provenance: a receiver asking "has what they based this
 * on moved?" runs the comparison this repo already has, rather than a second
 * staleness engine that can disagree with the first (and D-041's rule that a
 * near-synonym grammar is how two subsystems drift apart).
 *
 * ⚠ `versionAtSend`, never `version`. The token is resolved when the message is
 * SENT, not when the ref was read, so a change inside the read→send gap is
 * invisible to it. Calling it `version` would claim to be the value the sender
 * saw — which we did not keep, and cannot reconstruct.
 *
 * ── FAIL-SOFT, AND NEVER FABRICATE ───────────────────────────────────────────
 *
 * Every failure mode here degrades to LESS information, never to wrong
 * information: no rows ⇒ no field (an empty trace is not a false one), an
 * unresolvable ref ⇒ an entry with no `versionAtSend` rather than a guessed one,
 * a PG error ⇒ `[]`. A send must never fail because its provenance could not be
 * derived.
 */

import { getOrgPg } from '@papercusp/db-org';
import { DEP_RESOLVERS, type FreshnessResolverCtx } from '../../freshness/resolvers';
import type { BasedOnEntry } from './message-fields';

/**
 * How far back a send looks for reads. 30 minutes covers "I read the item, I
 * thought about it, I wrote the message" without reaching back into a previous
 * unit of work — a trace that spans two tasks describes neither.
 */
export const BASED_ON_WINDOW_MS = 30 * 60_000;

/** Max entries stamped. The trace is a pointer set for a reader who wants to
 *  audit, not a transcript: past a handful it stops being read at all. */
export const BASED_ON_MAX_ENTRIES = 8;

/** Max invocation rows examined. Bounds the query independently of the window,
 *  so a burst-reading agent costs the same as a quiet one. */
const BASED_ON_SCAN_ROWS = 200;

/** One read as the pure mapper sees it — deliberately not the DB row shape, so
 *  every mapping rule below is unit-testable without PG. */
export interface ReadInvocation {
  tool: string;
  args: unknown;
  /** ISO timestamp. */
  readAt: string;
}

/** A ref the sender read, before version resolution. */
export interface ReadRef {
  /** `kind:ref` — a tag `freshness/resolvers.ts` can version. */
  ref: string;
  /** The tool call it was read through. */
  via: string;
  readAt: string;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Collect a scalar arg and/or its plural sibling into one list of strings. */
function scalarsAt(args: Record<string, unknown>, keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const v = args[key];
    const one = str(v);
    if (one) out.push(one);
    if (Array.isArray(v)) {
      for (const entry of v) {
        const s = str(entry);
        if (s) out.push(s);
      }
    }
  }
  return out;
}

/**
 * The mapping table: which tool calls are READS, and which ref each one read.
 *
 * ⚠ ARGS-DERIVABLE ONLY. A tool earns a row here when the thing it read is
 * unambiguous from its ARGUMENTS — `work_items:get { id }` read that item. A
 * QUERY (`work_items:list`, `facts:list`, `search:*`) read a result set nobody
 * can name from the args, and a ref invented for it would be a claim about
 * something the sender may never have seen. Those are omitted rather than
 * approximated: the trace's whole value is that every line in it is true.
 *
 * `dev:pipeline_position` is deliberately absent (D-084): the pipeline POSITION
 * of a file is not the file's bytes, so a `file:` token for it would report a
 * change the sender never looked at.
 */
export const READ_REF_MAPPERS: Readonly<
  Record<string, (args: Record<string, unknown>) => string[]>
> = Object.freeze({
  'work_items:get': (a) => scalarsAt(a, ['id', 'ids']).map((id) => `work-item:${id}`),
  'plans:get': (a) => scalarsAt(a, ['slug', 'slugs']).map((s) => `plan:${s}`),
  'plans:get-item': (a) => scalarsAt(a, ['slug']).map((s) => `plan:${s}`),
  'plans:items': (a) => scalarsAt(a, ['slug']).map((s) => `plan:${s}`),
  // Rubrics are persisted as rubric-template plans. Keep the canonical
  // `plan:` dependency kind so the existing plan freshness resolver can
  // version the read without adding a parallel rubric resolver.
  'rubrics:get': (a) => {
    // Mirror rubrics:get's boundary precedence: canonical rubricRef first,
    // then the existing generic ref alias, then caller-natural slug. Keep the
    // plural form alongside whichever single key won, so every accepted read
    // remains represented without recording a losing alias as a second basis.
    const single = str(a.rubricRef) ?? str(a.ref) ?? str(a.slug);
    return (single ? [single, ...scalarsAt(a, ['rubricRefs'])] : scalarsAt(a, ['rubricRefs'])).map(
      (s) => `plan:${s}`,
    );
  },
  // A repo-relative path only. An absolute path names a file in SOME tree, and
  // `file:` refs are repo-root-relative by contract — stamping one would produce
  // a ref that can never resolve, which is worse than no ref (it looks declared).
  'capability:read': (a) => {
    const p = str(a.file_path);
    return p && !p.startsWith('/') && !p.startsWith('..') ? [`file:${p}`] : [];
  },
});

/** The tools worth selecting for — the query's `IN` list. */
export const READ_TOOL_NAMES: readonly string[] = Object.freeze(Object.keys(READ_REF_MAPPERS));

/**
 * PURE. Invocation rows (NEWEST FIRST) → the refs to stamp, most-recent read
 * first, de-duplicated by ref.
 *
 * De-dup keeps the FIRST occurrence, which — given newest-first input — is the
 * most recent read of that ref. An agent that re-reads one work-item eleven
 * times has one basis, not eleven, and the cap must not be spent describing it.
 */
export function refsFromInvocations(
  rows: readonly ReadInvocation[],
  limit: number = BASED_ON_MAX_ENTRIES,
): ReadRef[] {
  const seen = new Set<string>();
  const out: ReadRef[] = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    const map = READ_REF_MAPPERS[row.tool];
    if (!map) continue;
    const args = row.args && typeof row.args === 'object' ? (row.args as Record<string, unknown>) : {};
    let refs: string[];
    try {
      refs = map(args);
    } catch {
      continue; // a malformed args bag is not worth failing a send over
    }
    for (const ref of refs) {
      if (out.length >= limit) break;
      if (seen.has(ref)) continue;
      seen.add(ref);
      out.push({ ref, via: row.tool, readAt: row.readAt });
    }
  }
  return out;
}

/**
 * Resolve each ref's version token through the SAME batched resolvers a
 * checkpoint's `dependsOn` uses. One query per KIND, not per ref.
 *
 * Fail-soft per the module header: a resolver that returns null (or throws)
 * leaves the entry unversioned rather than blocking or guessing.
 */
export async function versionRefs(
  refs: readonly ReadRef[],
  ctx: FreshnessResolverCtx,
): Promise<BasedOnEntry[]> {
  const byKind = new Map<string, string[]>();
  for (const r of refs) {
    const idx = r.ref.indexOf(':');
    if (idx <= 0) continue;
    const kind = r.ref.slice(0, idx);
    if (!(kind in DEP_RESOLVERS)) continue;
    const list = byKind.get(kind) ?? [];
    list.push(r.ref.slice(idx + 1));
    byKind.set(kind, list);
  }

  const tokens = new Map<string, string>();
  await Promise.all(
    [...byKind.entries()].map(async ([kind, kindRefs]) => {
      try {
        const resolved = await DEP_RESOLVERS[kind]!(kindRefs, ctx);
        for (const [ref, token] of resolved) {
          if (token) tokens.set(`${kind}:${ref}`, token);
        }
      } catch {
        /* unversioned beats wrongly-versioned */
      }
    }),
  );

  return refs.map((r) => ({
    ref: r.ref,
    via: r.via,
    readAt: r.readAt,
    ...(tokens.has(r.ref) ? { versionAtSend: tokens.get(r.ref)! } : {}),
  }));
}

/**
 * Derive the sender's read trace. Returns `[]` — never throws, never a partial
 * lie — when there is nothing to say or anything at all goes wrong.
 */
export async function deriveBasedOn(opts: {
  ownerId: string;
  workspaceId: string;
  harness: string | null;
  windowMs?: number;
  limit?: number;
}): Promise<BasedOnEntry[]> {
  if (!opts.ownerId || !opts.workspaceId) return [];
  const windowMs = opts.windowMs ?? BASED_ON_WINDOW_MS;
  const limit = opts.limit ?? BASED_ON_MAX_ENTRIES;
  try {
    const { sql } = getOrgPg();
    const since = new Date(Date.now() - windowMs);
    const rows = await sql<{ tool_name: string; args_json: unknown; invoked_at: Date }[]>`
      SELECT tool_name, args_json, invoked_at
        FROM harness_shared.tool_invocations
       WHERE workspace_id = ${opts.workspaceId}
         AND coord_owner_id = ${opts.ownerId}
         AND invoked_at >= ${since}
         AND status = 'ok'
         AND tool_name = ANY(${[...READ_TOOL_NAMES]})
       ORDER BY invoked_at DESC
       LIMIT ${BASED_ON_SCAN_ROWS}`;
    const refs = refsFromInvocations(
      rows.map((r) => ({
        tool: r.tool_name,
        args: r.args_json,
        readAt: (r.invoked_at instanceof Date ? r.invoked_at : new Date(r.invoked_at)).toISOString(),
      })),
      limit,
    );
    if (!refs.length) return [];
    return await versionRefs(refs, { workspaceId: opts.workspaceId, harness: opts.harness });
  } catch {
    return [];
  }
}
