import type { Commit } from './graphLayout';

interface Entry {
  data: Commit[] | null;
  ts: number;
  inFlight?: Promise<Commit[]>;
}

const cache = new Map<string, Entry>();

function cacheKey(scope: string, limit: number, ref: string | null) {
  return `${scope}:${limit}:${ref ?? '*'}`;
}
function storageKey(scope: string, limit: number, ref: string | null) {
  return `gitlog.${scope}.${limit}.${(ref ?? '_all').replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

function readStorage(scope: string, limit: number, ref: string | null): Commit[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey(scope, limit, ref));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Commit[];
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function writeStorage(scope: string, limit: number, ref: string | null, commits: Commit[]) {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(storageKey(scope, limit, ref), JSON.stringify(commits)); } catch {}
}

export function getCachedGitLog(scope: string, limit: number, ref: string | null = null): Commit[] | null {
  const k = cacheKey(scope, limit, ref);
  const hit = cache.get(k)?.data;
  if (hit) return hit;
  const persisted = readStorage(scope, limit, ref);
  if (persisted) cache.set(k, { data: persisted, ts: 0 });
  return persisted;
}

/**
 * Fetch git log via the provided URL. The response must shape `{ commits: Commit[] }`
 * or `{ error: string }`.
 */
export function fetchGitLog(
  scope: string,
  limit: number,
  url: string,
  ref: string | null = null,
): Promise<Commit[]> {
  const k = cacheKey(scope, limit, ref);
  const existing = cache.get(k);
  if (existing?.inFlight) return existing.inFlight;

  const p = fetch(url)
    .then((r) => r.json())
    .then((d) => {
      if (d.error) throw new Error(d.error);
      // Defensive normalize: older / drifted backends have shipped `refs`
      // as a comma-separated string instead of `string[]`. Crashing the
      // GitGraphPanel on that shape (string.slice().map is not a function)
      // takes down the whole harness page; coerce here once so every
      // consumer gets a clean array.
      const commits = ((d.commits ?? []) as Commit[]).map((c) => ({
        ...c,
        refs: Array.isArray(c.refs)
          ? c.refs
          : (typeof (c as { refs?: unknown }).refs === 'string'
              ? ((c as unknown as { refs: string }).refs.split(',').map((r) => r.trim()).filter(Boolean))
              : []),
        parents: Array.isArray(c.parents)
          ? c.parents
          : (typeof (c as { parents?: unknown }).parents === 'string'
              ? ((c as unknown as { parents: string }).parents.split(' ').filter(Boolean))
              : []),
      }));
      cache.set(k, { data: commits, ts: Date.now() });
      writeStorage(scope, limit, ref, commits);
      return commits;
    })
    .catch((e) => {
      const cur = cache.get(k);
      if (cur) cache.set(k, { ...cur, inFlight: undefined });
      throw e;
    });

  cache.set(k, { data: existing?.data ?? null, ts: existing?.ts ?? 0, inFlight: p });
  return p;
}

export function preloadGitLog(scope: string, limit: number, url: string, ref: string | null = null) {
  fetchGitLog(scope, limit, url, ref).catch(() => {});
}
