/**
 * Shared user-memory list projection (memory-settings-page-refresh P-007).
 *
 * One implementation behind BOTH read surfaces:
 *  - the REST route `GET /api/user/memory` (settings page fallback), and
 *  - the `userMemory.list` sync resolver (the audited @papercusp/sync path).
 *
 * Rows are the neutral entry shape (generalize-memory-backend-swappable
 * D-003) enriched with canonical audit state + timestamps where the mem0
 * canonical store exists. The enrichment is best-effort BY CONTRACT: any
 * failure (pre-085 schema, non-uuid ids from another backend, PG down)
 * degrades to un-enriched rows and can never break the list.
 */
import { getMemoryBackend, type MemoryEntry } from './backend';
import { activeWorkspaceId } from '../workspace-registry';
import { loadHarnessRegistry } from '../harness-registry';
import { getOrgPg } from '@papercusp/db-org';

export interface UserMemoryAudit {
  state: string;
  last_validated_at: string | null;
  last_surfaced_at: string | null;
  broken_anchors: Array<{ kind: string; value: string; reason: string | null }>;
}

export interface UserMemoryRow {
  id: string;
  text: string;
  kind?: string;
  metadata?: Record<string, unknown>;
  scope: 'user' | 'harness' | 'workspace';
  harness_slug?: string;
  created_at?: string | null;
  updated_at?: string | null;
  audit?: UserMemoryAudit;
}

interface AuditEnrichment extends UserMemoryAudit {
  created_at: string | null;
  updated_at: string | null;
}

// Normalize PG timestamps to ISO here: Node's Date.parse handles the
// driver's '2026-06-09 16:08:51.83-04' string form, but the WebKit
// webview's does not — the client must only ever see ISO.
const iso = (v: unknown): string | null => {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? v : new Date(ms).toISOString();
  }
  return null;
};

/**
 * Enrichment over the mem0 canonical tables — audit state + anchors +
 * timestamps. The uuid columns are compared as text (`id::text = ANY(...)`)
 * because entry ids are opaque backend strings, not guaranteed uuids.
 */
async function loadAuditEnrichment(
  ids: string[],
): Promise<Map<string, AuditEnrichment>> {
  const out = new Map<string, AuditEnrichment>();
  if (ids.length === 0) return out;
  try {
    const { sql } = getOrgPg();

    type CanonRow = {
      id: string;
      state: string | null;
      last_validated_at: Date | string | null;
      last_surfaced_at: Date | string | null;
      created_at: Date | string | null;
      updated_at: Date | string | null;
    };
    const canon = await sql<CanonRow[]>`
      SELECT id::text AS id, state, last_validated_at, last_surfaced_at,
             created_at, updated_at
      FROM harness_shared.memory_canonical
      WHERE id::text = ANY(${ids})`;
    for (const r of canon) {
      out.set(r.id, {
        state: r.state ?? 'active',
        last_validated_at: iso(r.last_validated_at),
        last_surfaced_at: iso(r.last_surfaced_at),
        created_at: iso(r.created_at),
        updated_at: iso(r.updated_at),
        broken_anchors: [],
      });
    }

    // Pull broken anchors so the UI can surface a per-row reason.
    try {
      type AnchorRow = {
        memory_id: string;
        kind: string;
        value: string;
        last_check_ok: boolean | null;
      };
      const anchors = await sql<AnchorRow[]>`
        SELECT memory_id::text AS memory_id, kind, value, last_check_ok
        FROM harness_shared.memory_anchors
        WHERE memory_id::text = ANY(${ids}) AND last_check_ok = false`;
      for (const a of anchors) {
        const e = out.get(a.memory_id);
        if (!e) continue;
        e.broken_anchors.push({
          kind: a.kind,
          value: a.value,
          reason: a.last_check_ok === false ? 'check_failed' : null,
        });
      }
    } catch { /* memory_anchors absent → leave list empty */ }
  } catch { /* canonical store absent / unreachable → no enrichment */ }
  return out;
}

/**
 * Map a neutral entry's opaque scope string onto the display grouping
 * the settings page renders: the session user's pool → 'user',
 * `harness:<slug>` → 'harness' (+ slug), legacy `workspace:<id>` →
 * 'workspace', anything else → 'user' (still the user's own view).
 */
function displayScope(e: MemoryEntry, userId: string): {
  scope: 'user' | 'harness' | 'workspace';
  harness_slug?: string;
} {
  if (e.scope.startsWith('harness:')) {
    return { scope: 'harness', harness_slug: e.scope.slice('harness:'.length) };
  }
  if (e.scope.startsWith('workspace:')) return { scope: 'workspace' };
  return e.scope === userId ? { scope: 'user' } : { scope: 'user' };
}

/**
 * The full enriched, newest-first list for one user: their personal pool
 * plus one pool per harness in the active workspace. Throws if the
 * backend is unavailable — callers that need the availability envelope
 * (the REST route) check `backend.available()` first.
 *
 * `opts.limit` (EI-12937): the settings Memory page shipped the ENTIRE corpus
 * unpaginated on every load (measured live: 2.02MB / 1,140 rows / avg 1,860
 * bytes/row) — a real, growing cost (2MB of JSON parse on the render thread),
 * squarely in the /internal/docs/performance anti-pattern space. Applied as a
 * FINAL slice, after the full sort — "most recent N" — so the ordering
 * contract is unchanged; omitted (the default) preserves today's exact
 * behavior for every OTHER caller (memory:search, the REST route's full-export
 * path, …). Deliberately NOT a per-row content cap ("memory rows are
 * user-authored long text — a per-row cap is not appropriate" per EI-12937) —
 * pagination is the lever, not truncation.
 */
/**
 * The scope set one user's Memory page reads: their personal pool + one pool
 * per harness in the active workspace. The deprecated workspace-shared pool
 * was drained (docs-and-memory-as-projections D-005).
 *
 * Shared by `listUserMemories` and `countUserMemories` so the denominator the
 * page shows and the rows it lists can never describe different corpora — a
 * total computed over a different scope set than the list is worse than no
 * total, because "300 of 2,465" invites arithmetic that would be wrong.
 */
async function userMemoryScopes(userId: string): Promise<string[]> {
  const ws = activeWorkspaceId();
  let harnessSlugs: string[] = [];
  try {
    const reg = await loadHarnessRegistry(ws);
    harnessSlugs = reg.projects.map((p) => p.slug);
  } catch { /* leave empty — section will just be empty */ }
  return [userId, ...harnessSlugs.map((slug) => `harness:${slug}`)];
}

/**
 * How many memories the page COULD show for `userId` — the denominator beside
 * its bounded window (WI-39540).
 *
 * Skips the audit enrichment (two PG round-trips over every id) and the sort,
 * because a count needs neither. Deliberately counts the same entries
 * `listUserMemories` would return before its limit slice, via the shared
 * scope helper above.
 *
 * ⚠ Do NOT reimplement this as a `SELECT count(*) FROM memory_canonical`.
 * That table also holds ~50k `row_kind='entity'` graph nodes, and the
 * canonical store is an ENRICHMENT of whatever backend is active, not the
 * backend itself — a raw table count answers a different question and
 * overstates the total by an order of magnitude.
 */
export async function countUserMemories(userId: string): Promise<number> {
  const backend = getMemoryBackend();
  const entries = await backend.list({ scope: await userMemoryScopes(userId) });
  return entries.length;
}

export async function listUserMemories(
  userId: string,
  opts: { limit?: number } = {},
): Promise<UserMemoryRow[]> {
  const backend = getMemoryBackend();

  const entries = await backend.list({ scope: await userMemoryScopes(userId) });

  const combined = entries.map((e) => ({
    id: e.id,
    text: e.text,
    kind: e.kind,
    metadata: e.metadata,
    ...displayScope(e, userId),
  }));

  const audit = await loadAuditEnrichment(combined.map((r) => r.id));
  const enriched: UserMemoryRow[] = combined.map((r) => {
    const e = audit.get(r.id);
    if (!e) return r;
    return {
      ...r,
      created_at: e.created_at,
      updated_at: e.updated_at,
      audit: {
        state: e.state,
        last_validated_at: e.last_validated_at,
        last_surfaced_at: e.last_surfaced_at,
        broken_anchors: e.broken_anchors,
      },
    };
  });

  // Newest first. Canonical timestamps where the store has them; the
  // legacy metadata.turn_at epoch for backends without a canonical row.
  const sortKey = (r: UserMemoryRow): number => {
    const ts = r.updated_at ?? r.created_at;
    if (ts) {
      const ms = Date.parse(ts);
      if (!Number.isNaN(ms)) return ms;
    }
    const turn = (r.metadata as Record<string, unknown> | undefined)?.turn_at;
    return typeof turn === 'number' ? turn : 0;
  };
  enriched.sort((a, b) => sortKey(b) - sortKey(a));
  if (typeof opts.limit === 'number' && opts.limit >= 0 && opts.limit < enriched.length) {
    return enriched.slice(0, opts.limit);
  }
  return enriched;
}
