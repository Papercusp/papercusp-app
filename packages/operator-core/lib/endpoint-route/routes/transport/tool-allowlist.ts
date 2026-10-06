/**
 * Opt-in tool-allowlist for the agent-mcp HTTP transport's `tools/list`.
 *
 * The shared `/api/mcp` endpoint exposes the FULL projected catalog — for a
 * role-`operator` (or superuser) caller that's ~300 tools, because most tools
 * declare no `agentRoles` restriction and are therefore visible to every role.
 * Claude Code DEFERS a surface that large (every tool must be `ToolSearch`-
 * activated before it can be called), which makes a persona brain — the
 * operator — flail: it fires multiple `ToolSearch`es per turn, guesses
 * colon/underscore name variants, and occasionally loops to the wall-clock cap.
 * Root cause + fix: `voice-persona-production-readiness-2026-06-02` P-009.
 *
 * The fix is an OPT-IN `?tools=a:b,c:d` query param. A caller that knows its
 * small working set (operator:converse passes the ~50 `ALL_AGENT_MCP_TOOLS`)
 * gets ONLY those tools in `tools/list`. Shrinking the surface is half the fix;
 * the other half is the spawn-side `ENABLE_TOOL_SEARCH=false` lever
 * (`RunAgentChatOptions.disableToolSearch`) that loads the now-small set
 * DIRECTLY instead of deferring it. (The per-tool MCP `_meta.anthropic/
 * alwaysLoad` marker was tried and is NOT honored over the HTTP transport on
 * claude-code 2.1.x — verified — so the env lever does the non-deferral.)
 *
 * Absent / empty `?tools=` → no filtering at all, so every other spawn
 * (worker / scoper / validator / a bare probe) keeps its full role surface.
 * Names are matched against the MCP catalog name (the colon form the registry
 * exposes, e.g. `harness:status`). A legacy `mcp__<server>__...` name from a
 * Claude resume transcript is accepted only when it normalizes to one catalog
 * entry; unknown names are simply ignored (a stale name never hides the rest
 * of the set). This is a LISTING
 * hint only — it does NOT gate `tools/call`. The operator is superuser and the
 * role-allowlist already governs what is callable; the allowlist exists purely
 * to shrink the deferred surface, so a tool omitted from `?tools=` that gets
 * called anyway still dispatches normally.
 */
import { normalizeMcpName } from '@papercusp/tooldef';

/**
 * Parse the `?tools=` query value into a name set, or `null` when absent/empty
 * (the "no filtering" signal). Comma-separated; whitespace trimmed; blanks
 * dropped.
 */
export function parseToolsAllowlist(raw: string | null | undefined): Set<string> | null {
  if (raw == null) return null;
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (names.length === 0) return null;
  return new Set(names);
}

/**
 * Filter MCP tool listings to the allowlist. `null` allowlist → return every
 * listing untouched (the worker/scoper/probe path). Matches on `listing.name`
 * (the colon MCP name).
 */
export function filterListingsByAllowlist<T extends { name: string }>(
  listings: readonly T[],
  allow: Set<string> | null,
): T[] {
  if (!allow) return [...listings];
  // Resume transcripts can contain Claude's client-mangled name from a prior
  // MCP surface, e.g. `mcp__papercusp-su__plans_audit`. Treat that spelling as
  // an alias for the current colon-form MCP listing so the new process restores
  // the tool definition before Claude replays its `tool_reference` block.
  // Keep canonical allowlist entries exact, and only accept an alias when its
  // normalized identity resolves to ONE listing; separator collisions fail
  // closed instead of exposing the wrong tool.
  const aliases = new Set(
    [...allow]
      .filter((name) => /^mcp__/.test(name))
      .map((name) => normalizeMcpName(name)),
  );
  if (aliases.size === 0) return listings.filter((t) => allow.has(t.name));

  const normalizedCounts = new Map<string, number>();
  for (const tool of listings) {
    const normalized = normalizeMcpName(tool.name);
    normalizedCounts.set(normalized, (normalizedCounts.get(normalized) ?? 0) + 1);
  }
  return listings.filter((tool) => {
    if (allow.has(tool.name)) return true;
    const normalized = normalizeMcpName(tool.name);
    return aliases.has(normalized) && normalizedCounts.get(normalized) === 1;
  });
}

/* ── COMPACT delivery tier (deterministic-tool-definition-delivery-2026-09-21) ─
 *
 * `?tools=` answers WHICH tools are advertised. It cannot answer HOW MUCH of
 * each one ships, and that second axis is where the bytes are: the advertised
 * definition is dominated by `inputSchema`, and the seed had to drop seven
 * high-demand heavies outright (work_items:complete 44 KB, coord:send 39 KB, …)
 * purely because admission was all-or-nothing.
 *
 * `?tools_compact=` makes it a THREE-way decision — full / compact / deferred —
 * so demand and cost stop competing. A named tool is still advertised and still
 * callable; only the prose is removed from its definition (`compactInputSchema`
 * keeps every element a model needs to form a VALID call: property names,
 * types, the required set, enum members, bounds, oneOf/anyOf discriminators,
 * nested shape and `$defs`/`$ref` structure).
 *
 * Which names land here is NOT a hand-maintained list — it is resolved by
 * `resolveToolDelivery()` from measured per-tool demand × measured per-tier
 * bytes and emitted into `apps/operator/scripts/tool-delivery.generated.mjs`,
 * which the launcher passes through as `PAPERCUSP_TOOLS_COMPACT`.
 *
 * Absent/empty ⇒ nothing is compacted (byte-identical to the pre-change
 * behaviour for every other client). A name here that is NOT advertised is
 * simply never reached — the filter runs first.
 */

/**
 * Parse the `?tools_compact=` query value into a name set, or `null` when
 * absent/empty (the "compact nothing" signal). Same shape as
 * `parseToolsAllowlist` on purpose: the two params are read together and a
 * caller that builds one builds the other the same way.
 */
export function parseCompactToolNames(raw: string | null | undefined): Set<string> | null {
  return parseToolsAllowlist(raw);
}

/**
 * Project the named listings onto their COMPACT form. Non-named listings are
 * returned by reference, untouched.
 *
 * The compact form must match what the delivery policy BUDGETED, or the
 * generated artifact's `spentBytes` is a fiction: `compactWireBytes` measures
 * `{ name, description: summaryGuidanceDescription(...), inputSchema:
 * compactInputSchema(...) }`, so this SUMMARISES the description and compacts
 * the schema — nothing else. `_meta`, `outputSchema` and `resultFormats` are
 * left alone because they are protocol fields, not prose, and a client that
 * negotiated on them would break.
 *
 * ⚠ P-010 CHANGED THIS SEAM AND ITS MEASUREMENT TOGETHER. Compact used to ship
 * `description: ''` — a bare name plus a schema, for 67 of the 71 advertised
 * tools. Measured catalog-wide, summarising instead of deleting costs 113 B per
 * tool (7,559 B across the seed) and retains the lead sentence plus EVERY hard
 * refusal/safety clause. If you change one side of this pair, change the other
 * in the same commit.
 *
 * ⚠ This is a LISTING projection only. `tools/call` is untouched: a compact
 * tool validates against the SAME server-side schema as a full one, so a model
 * that forms a valid call from the compact definition is never refused for
 * having been told less.
 */
export function applyCompactTier<
  T extends { name: string; description?: string; inputSchema?: unknown },
>(
  listings: readonly T[],
  compact: Set<string> | null,
  compactSchema: (s: unknown) => unknown,
  summariseDescription: (d: string | undefined) => string,
): T[] {
  if (!compact || compact.size === 0) return [...listings];
  return listings.map((t) =>
    compact.has(t.name)
      ? ({
          ...t,
          description: summariseDescription(t.description),
          inputSchema: compactSchema(t.inputSchema ?? {}),
        } as T)
      : t,
  );
}

/* ── Per-session MUTABLE tool surface (dynamic-tool-surface-2026-07-01) ────────
 *
 * The `?tools=` allowlist above is a SEED, not a hard cap: a seeded session can
 * GROW its advertised surface at runtime via `ctx.activateTools` (fired by
 * `tools:find`), and the transport emits `notifications/tools/list_changed` so a
 * `listChanged`-capable client (omp, codex) re-fetches `tools/list` and can call
 * the surfaced tools. This dissolves the focus/token/reachability trilemma into
 * "small seed + expand on demand": the seed keeps token cost + focus tight, and
 * on-intent activation keeps the long tail reachable — no ~140k-token full
 * catalog up front. Claude is unaffected: it launches with NO `?tools=` seed
 * (it self-defers via ToolSearch), so no surface is ever created for it and no
 * `list_changed` is ever fired at it.
 *
 * This is ephemeral per-CONNECTION state (it dies with the session), so an
 * in-memory Map keyed by the su session identity (`uiClientId`) is the correct
 * home per the storage policy (per-connection state is the explicit
 * not-Postgres exception). It is bounded by a lazy TTL sweep on access (no
 * bespoke timer to keep visible) plus a hard entry cap as a runaway backstop.
 */

interface SessionSurface {
  /** The live advertised set: seed ∪ everything activated so far. */
  tools: Set<string>;
  /** Last touch (ms) — recency for the TTL sweep. */
  touched: number;
}

const sessionSurfaces = new Map<string, SessionSurface>();

interface SessionToolRegistryRevision {
  /** The projected contract revision the MCP connection last listed or refreshed. */
  revision: string;
  /** Last touch (ms) — shares the session surface's lazy lifetime. */
  touched: number;
}

const sessionToolRegistryRevisions = new Map<string, SessionToolRegistryRevision>();

/** Idle sessions older than this are swept lazily on the next access. */
const SESSION_SURFACE_TTL_MS = 6 * 60 * 60 * 1000; // 6h ≫ any single agent session
/** Hard backstop against unbounded growth (a runaway or key explosion). */
const SESSION_SURFACE_MAX = 4096;

/** Exported for tests only — reset the module-scoped store between cases. */
export function __resetSessionSurfaces(): void {
  sessionSurfaces.clear();
  sessionToolRegistryRevisions.clear();
}

function sweepSessionSurfaces(nowMs: number): void {
  // Cheap TTL pass — drop idle sessions.
  for (const [k, v] of sessionSurfaces) {
    if (nowMs - v.touched > SESSION_SURFACE_TTL_MS) sessionSurfaces.delete(k);
  }
  if (sessionSurfaces.size <= SESSION_SURFACE_MAX) return;
  // Still over the cap after TTL → evict oldest-touched down to 90%.
  const entries = [...sessionSurfaces.entries()].sort((a, b) => a[1].touched - b[1].touched);
  const target = Math.floor(SESSION_SURFACE_MAX * 0.9);
  for (const [k] of entries) {
    if (sessionSurfaces.size <= target) break;
    sessionSurfaces.delete(k);
  }
}

function sweepSessionToolRegistryRevisions(nowMs: number): void {
  for (const [sessionKey, entry] of sessionToolRegistryRevisions) {
    if (nowMs - entry.touched > SESSION_SURFACE_TTL_MS) sessionToolRegistryRevisions.delete(sessionKey);
  }
  if (sessionToolRegistryRevisions.size <= SESSION_SURFACE_MAX) return;
  const entries = [...sessionToolRegistryRevisions.entries()].sort((a, b) => a[1].touched - b[1].touched);
  const target = Math.floor(SESSION_SURFACE_MAX * 0.9);
  for (const [sessionKey] of entries) {
    if (sessionToolRegistryRevisions.size <= target) break;
    sessionToolRegistryRevisions.delete(sessionKey);
  }
}

function isUsableToolRegistryRevision(revision: string): boolean {
  return revision.length > 0 && revision !== 'unknown';
}

/** Record the contract revision actually returned by this session's tools/list. */
export function rememberSessionToolRegistryRevision(
  sessionKey: string | null | undefined,
  revision: string,
  nowMs: number = Date.now(),
): void {
  if (!sessionKey || !isUsableToolRegistryRevision(revision)) return;
  sweepSessionToolRegistryRevisions(nowMs);
  sessionToolRegistryRevisions.set(sessionKey, { revision, touched: nowMs });
}

export type SessionToolRegistryRevisionState =
  | { status: 'unavailable' | 'missing' }
  | { status: 'current' | 'stale'; revision: string };

/** Inspect a session's real tools/list baseline without seeding or advancing it. */
export function sessionToolRegistryRevisionState(
  sessionKey: string | null | undefined,
  revision: string,
  nowMs: number = Date.now(),
): SessionToolRegistryRevisionState {
  if (!sessionKey || !isUsableToolRegistryRevision(revision)) return { status: 'unavailable' };
  sweepSessionToolRegistryRevisions(nowMs);
  const previous = sessionToolRegistryRevisions.get(sessionKey);
  if (!previous) return { status: 'missing' };
  previous.touched = nowMs;
  return previous.revision === revision
    ? { status: 'current', revision: previous.revision }
    : { status: 'stale', revision: previous.revision };
}

/**
 * Compare the live serving generation with a session's last real tools/list.
 * An absent baseline is stale and remains absent; only tools/list may seed or
 * advance it. Notifications tell the client to fetch that list but never count
 * as proof that it did.
 */
export function sessionToolRegistryRevisionChanged(
  sessionKey: string | null | undefined,
  revision: string,
  nowMs: number = Date.now(),
): boolean {
  const state = sessionToolRegistryRevisionState(sessionKey, revision, nowMs);
  return state.status === 'missing' || state.status === 'stale';
}

/**
 * Resolve the LIVE listing allowlist for a session — the mutable equivalent of
 * `parseToolsAllowlist`, used by `tools/list`.
 *
 * - `seed === null` (no `?tools=`) → returns `null`: full catalog, unchanged.
 *   No surface entry is created (so `activateTools` stays a no-op for this
 *   session — exactly the full-catalog / Claude path).
 * - `sessionKey === null` (no stable session id) → returns the raw `seed`:
 *   static behaviour, since growth can't be tracked without a stable key.
 * - otherwise → returns the session's mutable set, created (seeded) on first
 *   access and re-seeded defensively (the seed is the invariant floor) on
 *   every subsequent `tools/list`.
 *
 * The FIRST `tools/list` of a connection is what creates the entry; every real
 * MCP client lists before it calls, so the entry exists by the time
 * `tools:find` → `activateSessionTools` runs.
 */
export function getSessionSurface(
  sessionKey: string | null | undefined,
  seed: Set<string> | null,
  nowMs: number = Date.now(),
): Set<string> | null {
  if (!seed) return null; // no seed ⇒ full catalog ⇒ nothing to track
  if (!sessionKey) return seed; // no stable key ⇒ static (pre-dynamic behaviour)
  sweepSessionSurfaces(nowMs);
  let e = sessionSurfaces.get(sessionKey);
  if (!e) {
    e = { tools: new Set(seed), touched: nowMs };
    sessionSurfaces.set(sessionKey, e);
  } else {
    for (const t of seed) e.tools.add(t); // seed is the floor — re-add defensively
    e.touched = nowMs;
  }
  return e.tools;
}

/**
 * Grow a seeded session's surface by `toolNames` (the server-side half of
 * `ctx.activateTools`). Returns true iff at least one genuinely-new name was
 * added — the caller fires `notifications/tools/list_changed` only then, so a
 * no-op activation doesn't spam re-fetches.
 *
 * Only grows an ALREADY-SEEDED session (an entry created by `getSessionSurface`
 * on the connection's first `tools/list`). A session with no entry is either a
 * full-catalog session (nothing to expand — it already sees everything) or a
 * pre-list race; both correctly no-op.
 */
export function activateSessionTools(
  sessionKey: string | null | undefined,
  toolNames: readonly string[],
  nowMs: number = Date.now(),
): boolean {
  if (!sessionKey) return false;
  const e = sessionSurfaces.get(sessionKey);
  if (!e) return false; // only grow a seeded session
  let added = false;
  for (const n of toolNames) {
    if (typeof n === 'string' && n.length > 0 && !e.tools.has(n)) {
      e.tools.add(n);
      added = true;
    }
  }
  if (added) e.touched = nowMs;
  return added;
}
