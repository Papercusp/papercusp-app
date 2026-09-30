/**
 * Live-editable memory-backend selection (mem0-revive-or-retire / Brief 30).
 *
 * Which `MemoryBackend` `getMemoryBackend()` serves, persisted as an
 * operator-wide key/value setting (`harness_shared.operator_settings`,
 * key `memory_backend`) and read LIVE — the operator passes
 * `() => currentMemoryBackendChoice()` as the memory host's `backend`
 * thunk (see ./configure), so a UI flip on the settings memory page takes
 * effect on the next memory call with NO restart. This lets the owner
 * switch to `'claude-file'` (the real ~/.claude topic-file store, which is
 * populated) to *see* real data and inform the pending revive-vs-retire
 * decision (docs-and-memory-as-projections P-006).
 *
 * Resolution order: persisted setting → `PAPERCUSP_MEMORY_BACKEND` → `'mem0'`.
 * Operator-wide (not per-workspace): it's an infra choice over the whole
 * store.
 *
 * MULTI-PROCESS CONVERGENCE (WI-4484): the dev box runs SEVERAL operator
 * processes against one PG (:3070 release, :3170 staging, per-desktop
 * sidecars, isolated verify shells), so a boot-once in-process cache made a
 * UI flip apply ONLY to the process that handled the POST — every other
 * process kept serving the old store until its next restart (silent drift;
 * the "one operator process" assumption this file was written under is long
 * false). The sync thunk now does a stale-while-revalidate: past a short
 * TTL it kicks ONE background PG re-read (piggybacked on a real memory
 * call — no timer, no poll loop) so peers converge within ~15s of their
 * next memory use. PG stays the cross-process source of truth.
 */
import { getOrgPg, generated } from '@papercusp/db-org';
import { eq } from 'drizzle-orm';
import { activeWorkspaceId } from '../workspace-registry';

const SETTING_KEY = 'memory_backend';
const osTable = generated.operatorSettingsInHarnessShared;

/**
 * The operator's DEFAULT backend when nothing is persisted and no env override
 * is set — i.e. what a brand-new install gets.
 *
 * `hybrid-pg`, not `mem0` (memory-declaude-and-defaults-2026-07-28 D-002). Both
 * read and write the SAME `harness_shared.memory_canonical` rows, so this picks
 * a RANKING, never a storage location — but the ranking difference is large:
 * the live 40-pair A/B measured recall@10 39/40 (98%) for hybrid-pg vs 21/40
 * (53%) for mem0, because hybrid-pg fuses a lexical leg that wins exact-identifier
 * recall with the cosine leg that wins paraphrase. Cost is ~+265ms p50.
 * `mem0` was the default only because it came first; nothing re-evaluated it
 * after hybrid-pg won the A/B.
 *
 * ⚠ This name MUST be registered by the time a memory call resolves it — an
 * unregistered name makes `getMemoryBackend()` throw by design. `hybrid-pg` is
 * registered in ./configure (operator-side), NOT by @papercusp/memory itself,
 * whose own built-ins are only `mem0` + `noop`. That is why the LIB's fallback
 * in backend-registry.ts stays `'mem0'`: it must name something the lib can
 * always resolve for hosts that register nothing. `default-backend.test.ts`
 * pins this invariant.
 */
export const DEFAULT_MEMORY_BACKEND = 'hybrid-pg';

/**
 * Backends that were REGISTERED once and are not anymore
 * (memory-declaude-and-defaults-2026-07-28 P-004): the two ~/.claude-backed
 * stores. See ./configure for why they went.
 *
 * This set exists because unregistering a backend is not a code-only change —
 * its NAME can still be sitting in a live `operator_settings` row written months
 * ago, or in someone's `PAPERCUSP_MEMORY_BACKEND` env. `getMemoryBackend()`
 * throws loud on an unknown name (deliberately — it stops a typo'd env var from
 * masquerading as "memory is just empty"), and that behavior is right for a typo
 * but catastrophic here: the operator would throw on EVERY memory call, for a
 * value the user chose legitimately before we removed it.
 *
 * So a retired name degrades to the default rather than failing. That is a
 * migration, not a compatibility shim — nothing keeps the retired backend
 * working, the stale VALUE is simply retired too. The store is unaffected either
 * way: every backend here reads and writes the same `memory_canonical` rows.
 */
export const RETIRED_MEMORY_BACKENDS: ReadonlySet<string> = new Set(['claude-file', 'hybrid']);

/** Warn once per retired name so a stale setting is visible in the log without spamming it. */
const warnedRetired = new Set<string>();

/**
 * Map a raw choice (persisted row or env) to one that can actually resolve.
 * A retired name becomes the default; anything else passes through untouched
 * (an unknown-but-not-retired name must still throw at `getMemoryBackend()` —
 * that is the typo guard, and swallowing it here would defeat it).
 */
function coerceRetired(choice: string): string {
  if (!RETIRED_MEMORY_BACKENDS.has(choice)) return choice;
  if (!warnedRetired.has(choice)) {
    warnedRetired.add(choice);
    console.warn(
      `[memory] backend '${choice}' is retired (it stored memories in ~/.claude, which stopped ` +
      `being load-bearing on 2026-07-13) — using '${DEFAULT_MEMORY_BACKEND}' instead. ` +
      `Your memories are unaffected: every backend reads the same canonical Postgres store. ` +
      `Pick a current backend on the memory settings page to clear this.`,
    );
  }
  return DEFAULT_MEMORY_BACKEND;
}

/** The env fallback, evaluated live (tests may set it per-case). */
function envDefault(): string {
  return coerceRetired(process.env.PAPERCUSP_MEMORY_BACKEND || DEFAULT_MEMORY_BACKEND);
}

// undefined = not yet loaded from PG → fall back to env/default.
let cached: string | undefined;
let booted = false;
// Stale-while-revalidate freshness (WI-4484): when the cache is older than
// this, the next sync read kicks ONE background PG re-read so a flip made by
// a PEER process converges here without a restart.
const CACHE_TTL_MS = 15_000;
let loadedAtMs = 0;
let refreshing = false;

function refreshInBackground(): void {
  if (refreshing) return;
  refreshing = true;
  void readSetting()
    .then((stored) => {
      // null = no persisted row → keep the env/default fallback (never
      // overwrite a live cache with "unset"; an explicit write always sets).
      if (stored) cached = stored;
      loadedAtMs = Date.now();
    })
    .catch(() => {
      // PG hiccup — try again after the next TTL window.
      loadedAtMs = Date.now();
    })
    .finally(() => {
      refreshing = false;
    });
}

async function readSetting(): Promise<string | null> {
  try {
    const { db } = getOrgPg();
    const rows = await db
      .select({ value: osTable.value })
      .from(osTable)
      .where(eq(osTable.key, SETTING_KEY))
      .limit(1);
    return rows.length > 0 ? rows[0].value : null;
  } catch {
    return null; // PG not up yet / table absent → fall back to env
  }
}

async function writeSetting(value: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.operator_settings (key, value, description, updated_at, workspace_id)
    VALUES (${SETTING_KEY}, ${value}, 'Active MemoryBackend (mem0-revive-or-retire / Brief 30)', ${Date.now()}, ${activeWorkspaceId()})
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `;
}

/**
 * The synchronous live choice the memory host thunk reads on every
 * `getMemoryBackend()`. Persisted setting (once loaded) → env → 'mem0'.
 * Past the TTL it also kicks a background PG re-read (WI-4484) so a flip
 * made by a peer process converges here without a restart — the CURRENT
 * call still returns the cached value (sync contract unchanged).
 */
export function currentMemoryBackendChoice(): string {
  if (booted && Date.now() - loadedAtMs > CACHE_TTL_MS) refreshInBackground();
  // Coerced on READ, not on write: the persisted row may predate a retirement,
  // and rewriting the user's stored preference as a side effect of reading it
  // would silently discard a choice they may want to see reflected in the UI.
  return coerceRetired(cached ?? envDefault());
}

/**
 * Load the persisted selection into the in-process cache. Idempotent;
 * best-effort (a PG miss leaves the env/default fallback in place). Fire
 * once at operator boot — but it is also safe to never call (the thunk
 * just stays on the env default until a write happens).
 */
export async function initMemoryBackendSelection(): Promise<void> {
  if (booted) return;
  booted = true;
  const stored = await readSetting();
  if (stored) cached = stored;
  loadedAtMs = Date.now();
}

/** Read the persisted choice (independent of the cache); env/default if unset. */
export async function readMemoryBackendChoice(): Promise<string> {
  const stored = await readSetting();
  return coerceRetired(stored ?? envDefault());
}

/**
 * Persist + apply the choice live (this process sees it on the next
 * `getMemoryBackend()`). The caller MUST validate `backend` against
 * `registeredMemoryBackends()` first — an unknown name makes
 * `getMemoryBackend()` throw loud by design.
 */
export async function writeMemoryBackendChoice(backend: string): Promise<string> {
  cached = backend;
  booted = true;
  loadedAtMs = Date.now();
  await writeSetting(backend);
  return backend;
}

/** Test hook — drop the cache + boot latch (does not touch PG). */
export function __resetMemoryBackendSelectionForTest(): void {
  cached = undefined;
  booted = false;
  loadedAtMs = 0;
  refreshing = false;
  // The retired-name warn-once latch is module state too. Leaving it set would
  // make "does it warn?" depend on which test ran first — the warning fires on
  // the FIRST case to touch a given name and silently not on the rest.
  warnedRetired.clear();
}
