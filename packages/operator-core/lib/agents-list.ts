/**
 * Cross-harness agent enumeration. Server-side implementation shared
 * between the registry query (agents.across-workspace) and the HTTP
 * endpoint that serves it to the delegate's MCP tool.
 *
 * Reads from the agent-chats Hono store via the same internal HTTP
 * surface clients use — keeps the query responsive to chat-store
 * schema changes without re-implementing them here.
 */

import { pinModuleState } from '@papercusp/module-singleton';
import { loopbackFetch, readJsonBody } from './loopback-fetch';

interface AgentRow {
  slug: string;
  role: string;
  chat_count: number;
  last_active: string | null;
}

// Use the operator's own base URL. Was hardcoded to :3155 (a since-retired
// papercup-main worktree port); production on :3070 was hitting ECONNREFUSED
// and returning 500. PAPERCUSP_OPERATOR_BASE is the same env var every other
// internal-fetch site uses. Fall back to PORT (Next sets it to whatever port
// the server bound on) before defaulting to dev's 3055.
function operatorBase(): string {
  if (process.env.INTERNAL_API_BASE) return process.env.INTERNAL_API_BASE;
  if (process.env.PAPERCUSP_OPERATOR_BASE) return process.env.PAPERCUSP_OPERATOR_BASE;
  const port = process.env.PORT ?? '3055';
  return `http://localhost:${port}`;
}

// Cache the slug-less result (the heavy case). Per-slug calls are already
// fast (~1 fetch); the no-slug variant fetches /agent-chats for every
// registered project and was doing it SERIALLY — 70 round-trips per call,
// dragging it to >8 s. Cache for 10 s; data is only used by tooling +
// audit views, doesn't need sub-second freshness.
interface AgentsCacheEntry {
  expires: number;
  inflight: Promise<AgentRow[]> | null;
  value: AgentRow[] | null;
}
// Pinned through @papercusp/module-singleton rather than a hand-rolled
// `globalThis[Symbol.for(...)]` pair: hand-rolling still fixes correctness, but
// the key is invisible to listModuleDuplications(), which then reports a
// confident `[]` while this module is split (EI-19479108855357092).
const __agentsCache = pinModuleState<AgentsCacheEntry>(
  '@papercusp/operator-core.agentsAcrossWorkspaceCache',
  () => ({ expires: 0, inflight: null, value: null }),
);

/**
 * Reset the cache between tests THROUGH the module's own seam.
 *
 * Do not reach for `globalThis[Symbol.for(...)]` in a test: that targets the
 * storage LOCATION rather than this module's state, so it keeps compiling and
 * silently resets NOTHING once the state moves (EI-19479108855357092).
 */
export function resetAgentsListCacheForTest(): void {
  __agentsCache.expires = 0;
  __agentsCache.inflight = null;
  __agentsCache.value = null;
}

/**
 * Bounded-concurrency map — caps in-flight work at `limit`, preserving input
 * order. Used so the no-slug agent walk doesn't fan out to ~70 simultaneous
 * loopback round-trips (F-C2 of app-wide-load-traps): an unbounded
 * `Promise.all` over every registered harness opened them all at once, each
 * triggering an `agent_chats:list` query. Mirrors the worker-pool helper in
 * external-bench/competitor-live.ts.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

/** Max simultaneous loopback fetches in the no-slug fan-out (F-C2). */
const AGENTS_FANOUT_CONCURRENCY = 8;

async function fetchOneSlug(slug: string, base: string): Promise<AgentRow[]> {
  const cr = await loopbackFetch(`${base}/api/harness/${encodeURIComponent(slug)}/agent-chats`).catch(() => null);
  if (!cr || !cr.ok) return [];
  const cd = (await cr.json().catch(() => null)) as { chats?: Array<any> } | null;
  const chats = Array.isArray(cd?.chats) ? cd!.chats : [];
  const byRole = new Map<string, AgentRow>();
  for (const c of chats) {
    const role = c?.role ?? 'unknown';
    const existing = byRole.get(role) ?? { slug, role, chat_count: 0, last_active: null };
    existing.chat_count += 1;
    if (!existing.last_active || String(c?.updated_at ?? '') > existing.last_active) {
      existing.last_active = c?.updated_at ?? null;
    }
    byRole.set(role, existing);
  }
  return Array.from(byRole.values());
}

async function computeAllAgents(base: string): Promise<AgentRow[]> {
  const projR = await loopbackFetch(`${base}/api/harness/projects`);
  if (!projR.ok) return [];
  // readJsonBody (not bare .json()) so an empty/truncated body during a host
  // restart rethrows an ATTRIBUTABLE error naming this URL — not the frame-less
  // `SyntaxError: Unexpected end of JSON input` that fatal-exited :3070 (EI-20).
  const projData = await readJsonBody<{ projects?: Array<{ slug: string }> }>(projR);
  const slugs = (projData.projects ?? []).map((p) => p.slug);
  // Bounded fan-out (F-C2): was a serial for-loop (70 round-trips back-to-back),
  // then an unbounded `Promise.all` (70 simultaneous loopback fetches, each
  // running an agent_chats:list query). Cap at AGENTS_FANOUT_CONCURRENCY so a
  // big registry can't saturate the event loop / PG pool in one burst.
  const perSlug = await mapWithConcurrency(slugs, AGENTS_FANOUT_CONCURRENCY, (s) =>
    fetchOneSlug(s, base),
  );
  return perSlug.flat();
}

export async function listAgentsAcrossWorkspace(opts: {
  slug?: string;
  limit?: number;
}): Promise<AgentRow[]> {
  const limit = opts.limit ?? 40;
  const base = operatorBase();

  // Single-slug case: no cache, just one fetch.
  if (opts.slug) {
    const rows = await fetchOneSlug(opts.slug, base);
    rows.sort((a, b) => String(b.last_active ?? '').localeCompare(String(a.last_active ?? '')));
    return rows.slice(0, limit);
  }

  // No-slug case: cache + in-flight dedup. The full walk is heavy.
  const now = Date.now();
  const TTL_MS = 10_000;
  let value = __agentsCache.value;
  if (!(value && __agentsCache.expires > now)) {
    if (!__agentsCache.inflight) {
      __agentsCache.inflight = (async () => {
        const all = await computeAllAgents(base);
        all.sort((a, b) => String(b.last_active ?? '').localeCompare(String(a.last_active ?? '')));
        __agentsCache.value = all;
        __agentsCache.expires = Date.now() + TTL_MS;
        __agentsCache.inflight = null;
        return all;
      })();
    }
    value = await __agentsCache.inflight;
  }
  return value!.slice(0, limit);
}
