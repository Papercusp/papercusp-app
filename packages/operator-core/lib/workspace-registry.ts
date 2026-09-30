/**
 * Workspace registry helpers — read/write ~/.papercusp-workspaces/registry.json.
 *
 * Adds the `companyId` field per spec/workspace-scoping. Existing
 * registries without companyId continue to work. (The hindsight:recall
 * consumer of companyId was removed — audit P-047.)
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface WorkspaceEntry {
  id: string;
  name: string;
  createdAt: number;
  /** Paperclip company id for Hindsight bank derivation. */
  companyId?: string | null;
}

export interface WorkspaceRegistry {
  current?: string;
  workspaces: WorkspaceEntry[];
}

/**
 * Absolute path to the workspaces root (`~/.papercusp-workspaces`).
 *
 * This directory holds the registry + every per-workspace dir, and it
 * lives ABOVE the per-workspace isolation boundary. In the packaged
 * desktop the operator sidecar runs with `HOME` remapped to the *active
 * workspace dir*, so `homedir()` points INSIDE a workspace — resolving
 * the root via `homedir()` would land in a nested per-workspace registry
 * that disagrees with the one the Rust shell owns (the cause of the
 * "switch failed: workspace dir ... missing" class of bug). The desktop
 * passes the real root as `PAPERCUSP_WORKSPACES_ROOT`; prefer it. The
 * `homedir()` fallback is correct in dev, where HOME is not remapped.
 */
export function workspacesRoot(): string {
  const env = process.env.PAPERCUSP_WORKSPACES_ROOT;
  if (env && env.trim()) return env;
  return join(homedir(), '.papercusp-workspaces');
}

function registryPath(): string {
  return join(workspacesRoot(), 'registry.json');
}

/**
 * The registry exists but could not be read or parsed. Distinct from "no
 * registry yet" ON PURPOSE — see {@link readRegistry}.
 */
export class WorkspaceRegistryUnreadableError extends Error {
  constructor(
    readonly path: string,
    readonly cause: unknown,
  ) {
    super(
      `workspace registry at ${path} is present but could not be read or parsed — refusing to report it as EMPTY, ` +
        `because an empty registry resolves activeWorkspaceId() to the legacy '${DEFAULT_WORKSPACE_ID}' ` +
        `partition and every scoped read then answers a confident false NOT-FOUND (WI-6734). ` +
        `Cause: ${String(cause)}`,
    );
    this.name = 'WorkspaceRegistryUnreadableError';
  }
}

/**
 * Read the registry.
 *
 * ⚠ A CORRUPT REGISTRY IS NOT AN EMPTY ONE — that conflation is a silent
 * wrong-scope bug, not a tidy default (WI-6734). `activeWorkspaceId()` resolves
 * `reg.current ?? reg.workspaces[0]?.id ?? DEFAULT_WORKSPACE_ID`, so returning
 * `{ workspaces: [] }` for an unreadable file silently scopes the caller to the
 * legacy `'default'` partition — which the COORD_PER_WORKSPACE cutover retired
 * (measured 2026-08-01: 104 rows, none since 2026-07-27, against 115,179 live
 * ones in `papercusp-workspace`). Every lookup made under that scope returns
 * zero rows, and the tool surface renders zero rows as an authoritative
 * "does not exist" rather than "I could not determine where to look".
 *
 * So: a MISSING file is legitimately empty (first run); an UNREADABLE one
 * throws {@link WorkspaceRegistryUnreadableError}. Failing loudly is the whole
 * point — any answer we could invent here is a guess wearing a valid-looking
 * workspace id.
 *
 * `writeRegistry` makes a reader-races-a-writer torn read impossible on POSIX
 * (temp file + fsync + atomic `rename`, unique per WRITE). Even so, this
 * retries a BOUNDED handful of times with a short backoff rather than once —
 * EI-21148378726402614: two concurrent MCP calls both hit "Unexpected end of
 * JSON input" against this file, and it "self-recovered and [was] valid"
 * seconds later, meaning the transient window can outlast a short fixed retry
 * burst (heavy concurrent-write load on this fleet, another process's OS-level
 * read scheduling, a filesystem this file happens to sit on — the exact
 * producer doesn't matter). A bounded progressive backoff keeps the first
 * retries fast while giving a longer transient window up to 635ms to settle.
 * This costs nothing on the happy path (it only runs once the first read has
 * already failed to parse); a GENUINELY corrupt registry still exhausts the
 * budget and throws — this is resilience against a transient read, never a
 * license to treat real corruption as empty (WI-6734).
 */
const REGISTRY_READ_RETRY_DELAYS_MS = [5, 10, 20, 40, 80, 160, 320] as const;

/**
 * Bounded synchronous sleep for the read-retry backoff below. Blocks the
 * event loop briefly, which is acceptable here because it runs ONLY on the
 * rare exception path (a read/parse failure), never on the happy path.
 * Mirrors the Atomics.wait sync-sleep idiom already used elsewhere in this
 * repo (scripts/pg-autotune.ts, tools/perf-test/wdio/wdio.conf.ts).
 */
function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function readRegistry(): WorkspaceRegistry {
  const p = registryPath();
  if (!existsSync(p)) return { workspaces: [] };

  let firstErr: unknown;
  for (let attempt = 0; ; attempt++) {
    let raw: string;
    try {
      raw = readFileSync(p, 'utf8');
    } catch (err) {
      // ABSENT is not CORRUPT. The file can vanish between the existsSync check
      // and this read (a workspace switch racing us, a torn-down temp root in
      // tests) — that is the legitimately-empty case, same as never having had a
      // registry. Only a file we cannot read *while it is there* (EACCES, EIO) is
      // the dangerous one, because then we genuinely do not know what it says.
      if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { workspaces: [] };
      if (firstErr === undefined) firstErr = err;
      const delayMs = REGISTRY_READ_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined) throw new WorkspaceRegistryUnreadableError(p, firstErr);
      sleepSyncMs(delayMs);
      continue;
    }

    try {
      return JSON.parse(raw) as WorkspaceRegistry;
    } catch (err) {
      // A torn/garbage read: we got bytes, but not a whole document. Retry
      // against a freshly re-read (not re-parsed-from-cache) file before
      // declaring it corrupt — see the retry-budget rationale above.
      if (firstErr === undefined) firstErr = err;
      const delayMs = REGISTRY_READ_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined) throw new WorkspaceRegistryUnreadableError(p, firstErr);
      sleepSyncMs(delayMs);
    }
  }
}

/**
 * Write the registry ATOMICALLY (temp file + `rename`).
 *
 * A plain `writeFileSync` truncates-then-writes, so a concurrent reader on this
 * heavily-parallel fleet can observe a PARTIAL file, fail to parse it, and — before
 * the guard above — silently resolve to the retired `'default'` partition. `rename`
 * is atomic on POSIX, so a reader sees either the whole old file or the whole new
 * one, never a torn one.
 *
 * ⚠ The temp path must be UNIQUE PER WRITE, not just per process. `rename` being
 * atomic only guarantees the reader sees a whole *file* — it says nothing about
 * that file's CONTENT. Two concurrent `writeRegistry()` calls in one process
 * sharing a `<path>.<pid>.tmp` name interleave truncate-then-write on the SAME
 * temp file, and whichever renames first publishes whatever bytes happened to be
 * there — including zero of them, which a reader then sees as
 * "Unexpected end of JSON input" on a file that looks fine by the time anyone
 * inspects it. The Rust shell hit this and fixed it the same way (a pid +
 * REGISTRY_WRITE_SEQUENCE temp name, `workspaces.rs`); a UUID is used here
 * instead of a module-scoped counter because module-scoped state in this package
 * can split across duplicate module records and hand two writers the same
 * sequence, reintroducing exactly the collision this removes.
 *
 * `fsync`s the temp file's contents before the rename, mirroring the Rust
 * writer's `file.sync_all()` (`workspaces.rs`). `writeFileSync` alone already
 * makes the write fully visible to concurrent READERS on this host the moment
 * it returns (same page cache); the fsync's job is DURABILITY — a crash or
 * host restart between rename and disk flush must not resurrect the OLD
 * content or leave the new one only half-written to storage. Keeping both
 * writers' on-disk contract identical also removes any doubt when diagnosing
 * a future registry incident: neither implementation is the odd one out.
 */
export function writeRegistry(reg: WorkspaceRegistry): void {
  const p = registryPath();
  mkdirSync(workspacesRoot(), { recursive: true });
  const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
  const data = JSON.stringify(reg, null, 2);
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, p);
}

/**
 * The literal 'default' workspace id — fallback when no registry exists
 * or no workspace is selected. Re-exported from the client-safe module
 * so legacy importers from this path keep working; new client code
 * should import from './workspace-id-constant' directly to avoid
 * pulling node:fs into client chunks.
 */
// Import the local binding (used by `activeWorkspaceId` below) AND re-export
// it, so legacy importers from this path keep working. A bare
// `export { X } from './y'` re-export does NOT create a local binding, which
// left `activeWorkspaceId`'s fallback referencing an undefined name.
import { DEFAULT_WORKSPACE_ID } from './workspace-id-constant';
export { DEFAULT_WORKSPACE_ID };
import { currentRequestWorkspaceId, isInRequestScope } from './workspace-als';

// P-021 diagnostic dedupe — warn once per call site so a hot path can't flood
// the dev console. Module-global; reset in tests via the export below.
const warnedRequestFallbackSites = new Set<string>();

/** Test-only: clear the P-021 fall-through warning dedupe set. */
export function __resetWorkspaceFallbackWarnings(): void {
  warnedRequestFallbackSites.clear();
}

function warnGlobalFallbackInRequest(global: string): void {
  // Frame [3] of the stack is the caller of activeWorkspaceId() (the site that
  // resolved the global inside a request) — [0]=Error [1]=this [2]=activeWorkspaceId.
  const site = (new Error().stack ?? '').split('\n')[3]?.trim() ?? 'unknown';
  if (warnedRequestFallbackSites.has(site)) return;
  warnedRequestFallbackSites.add(site);
   
  console.warn(
    `[workspace] activeWorkspaceId() fell back to the global '${global}' INSIDE a ` +
      `request scope — the request carried no x-papercusp-workspace/?ws=, so it resolved ` +
      `the process-global workspace, not the window's. This is the silent-wrong-workspace ` +
      `mode per-window-workspace-context exists to kill (P-021). Site: ${site}`,
  );
}

/**
 * EI-21412168682953521 — three work_items partitions were created under workspace ids
 * that were never real identities: an unexpanded `'${PAPERCUSP_WORKSPACE}'` env template,
 * a JSON-double-quoted `'"papercusp-workspace"'`, and a filesystem path. All trace to
 * ambient sources (PAPERCUSP_WORKSPACE_ID / request scope / registry.current) carrying
 * raw environment strings into this function, which every writer uses to resolve the
 * tenant it partitions under. Validate at the single chokepoint: a malformed id falls
 * through to the next precedence level instead of poisoning every write that resolves
 * through it. Real ids are slug-like (`papercusp-workspace`, `default`), so the shape
 * test is deliberately narrow: unexpanded `${...}` templates, surrounding quotes, and
 * anything containing a path separator.
 */
function isMalformedWorkspaceId(id: string): boolean {
  const v = id.trim();
  if (v !== v.replace(/^["'`]+|["'`]+$/g, '')) return true; // wrapped in quotes
  if (/\$\{[^}]*\}/.test(v)) return true; // unexpanded ${...} template
  if (v.includes('/') || v.includes('\\')) return true; // filesystem path
  return false;
}

/**
 * P-525 (p2p-join-catchup-speed D-013): the registry's global default, memoized on the
 * file's identity. activeWorkspaceId() runs once per sync trigger event on a hot fold,
 * and re-reading plus re-parsing the file on every call was ~3% of the main thread
 * (measured on the P-007 VM). writeRegistry publishes by rename, so every write is a
 * new inode; size and mtime cover an in-place write. Only the derived id is kept, never
 * the registry object, which callers may mutate.
 */
let registryGlobalMemo: { key: string; global: string } | null = null;

function registryGlobalWorkspaceId(): string {
  const p = registryPath();
  let key: string;
  try {
    const s = statSync(p);
    key = `${p}|${s.ino}|${s.size}|${s.mtimeMs}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      const reg = readRegistry();
      return reg.current ?? reg.workspaces[0]?.id ?? DEFAULT_WORKSPACE_ID;
    }
    key = `${p}|absent`;
  }
  if (registryGlobalMemo?.key === key) return registryGlobalMemo.global;
  const reg = readRegistry();
  const global = reg.current ?? reg.workspaces[0]?.id ?? DEFAULT_WORKSPACE_ID;
  registryGlobalMemo = { key, global };
  return global;
}

export function activeWorkspaceId(): string {
  // Precedence (per-window-workspace-context-2026-05-31, D-002/D-005):
  // 1. The request-scoped workspace — a browser window stamped its workspace on
  //    the request (`x-papercusp-workspace` header → ALS). Most specific; this is
  //    what makes one shared sidecar serve many windows on different workspaces
  //    without following the process-global `reg.current`.
  const req = currentRequestWorkspaceId();
  if (req && req.trim() && !isMalformedWorkspaceId(req)) return req.trim();
  // 2. Process pin — a dedicated single-workspace process (orchestrator agent,
  //    durable-pipeline dispatcher) that must not follow the desktop UI's
  //    volatile switches. Mirrors the orchestrator's `activeWorkspaceId()`.
  //    EI-21412168682953521: an ambient value that is not a real workspace identity
  //    (unexpanded template / quoted / a path) falls through instead of partitioning
  //    writes under garbage.
  const env = process.env.PAPERCUSP_WORKSPACE_ID;
  if (env && env.trim() && !isMalformedWorkspaceId(env)) return env.trim();
  // 3. Global default — the workspace a new window opens into / background work
  //    uses when not told otherwise. No longer authoritative for request work.
  const global = registryGlobalWorkspaceId();
  if (!global || isMalformedWorkspaceId(global)) return DEFAULT_WORKSPACE_ID;
  // P-021: if we landed here while INSIDE a request/tool scope, the request
  // failed to carry its workspace. Surface it when developing (NODE_ENV
  // 'development', or an explicit opt-in) — never in 'test' (would trip
  // fail-on-console) or 'production' (no log spam).
  const warnEnabled =
    process.env.NODE_ENV === 'development' || process.env.PAPERCUSP_DEBUG_WORKSPACE === '1';
  if (warnEnabled && isInRequestScope()) {
    warnGlobalFallbackInRequest(global);
  }
  return global;
}

/**
 * Resolve a CONCRETE workspace id from a precedence list of candidates, treating the
 * `'*'` wildcard — the unscoped-superuser READ sentinel (`ctx.workspaceId` for a
 * `?superuser=1` session that chose no workspace, per _mcp-handler's `workspaceId || '*'`
 * fallback) — AND empty/blank as "not concrete". Returns the first concrete candidate,
 * else `activeWorkspaceId()`. NEVER returns `'*'`.
 *
 * Use this for ANY operation that PERSISTS or filters a concrete `workspace_id` — above
 * all WRITES. `'*'` is a read-scoping wildcard, never a storable workspace value:
 * persisting it (EI-3409 / WI-892) stamps a row that no concrete-workspace read can ever
 * see, silently diverging the operator's view from the table. For `harness_shared.pot_members`
 * that means the membership guard, epoch-key grant, and cross-member content federation —
 * all keyed off `WHERE workspace_id = '<concrete>'` — never see the row, breaking shared-hive
 * federation. This replaces the copy-pasted `x && x !== '*' ? x : activeWorkspaceId()` idiom;
 * the buggy `x ?? ctx.workspaceId ?? … ?? activeWorkspaceId()` form lets a truthy `'*'` win
 * and the fallback never fires.
 */
export function resolveConcreteWorkspaceId(
  ...candidates: Array<string | null | undefined>
): string {
  return concreteWorkspaceIdOrNull(...candidates) ?? activeWorkspaceId();
}

/**
 * The concreteness rule of {@link resolveConcreteWorkspaceId} WITHOUT its ambient
 * fallback: the first candidate that is a real workspace identity, or `null` when
 * none of them is.
 *
 * Reach for this — never `resolveConcreteWorkspaceId` — when the caller must be able
 * to tell "no concrete workspace was supplied" apart from "here is one". The
 * resolver's `activeWorkspaceId()` fallback MANUFACTURES an answer from process
 * state, so its result is never falsy: a `if (!resolveConcreteWorkspaceId(x))` guard
 * is unreachable code, and the operation it was meant to protect proceeds against a
 * GUESSED namespace instead of refusing (EI-19470389781357111 — the loop carry-note's
 * declared-dependency stamp shipped with exactly that dead branch).
 *
 * That guess is only safe where any workspace will do. It is NOT safe where the
 * value scopes a lookup on behalf of a caller whose own workspace is unknown — a
 * `?superuser=1` session sends the `'*'` sentinel, and resolving its refs under the
 * sidecar's process-global workspace silently answers about a DIFFERENT tenant's
 * rows rather than reporting that it could not answer.
 */
export function concreteWorkspaceIdOrNull(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      // EI-21412168682953521: same malformed-shape rejection as activeWorkspaceId() —
      // a placeholder/quoted/path candidate is not a workspace identity.
      if (trimmed && trimmed !== '*' && !isMalformedWorkspaceId(trimmed)) return trimmed;
    }
  }
  return null;
}

export function workspaceById(id: string): WorkspaceEntry | undefined {
  return readRegistry().workspaces.find((w) => w.id === id);
}

/**
 * The workspace set a BACKGROUND job must cover — per-window-workspace-context
 * P-020. A background reader (interval sweeper, boot-time re-registration,
 * scheduled dispatcher) has no request to scope it, so it must decide which
 * workspaces it serves instead of silently following the global:
 *   1. `PAPERCUSP_WORKSPACE_ID` pin → just that one (a dedicated
 *      single-workspace process — orchestrator agent, durable dispatcher).
 *   2. Shared-operator model (`PAPERCUSP_SHARED_OPERATOR=1`, set only by the
 *      desktop shell, D-008) → EVERY registered workspace; wrap each unit of
 *      work in `runWithWorkspace(ws, …)` so nested `activeWorkspaceId()`
 *      reads resolve that workspace.
 *   3. Dev / legacy single-active model → the one global active workspace —
 *      today's behavior, unchanged (D-009).
 * Canonical policy shared by the DBOS dispatcher (`orchestratorWorkspaceIds`),
 * the await-event sweeper, and the pot wake-rule boot registration.
 */
export function backgroundWorkspaceIds(): string[] {
  const pin = process.env.PAPERCUSP_WORKSPACE_ID?.trim();
  if (pin) return [pin];
  if (process.env.PAPERCUSP_SHARED_OPERATOR === '1') {
    const ids = readRegistry()
      .workspaces.map((w) => w.id)
      .filter(Boolean);
    if (ids.length) return ids;
  }
  return [activeWorkspaceId()];
}

/**
 * Is `id` a workspace this host knows about? Used by the request-scope
 * middleware to distinguish a *missing* header (→ global fallback) from a
 * *present-but-unknown* one (→ hard error, D-007). The literal 'default' id
 * is always treated as known, even if a sparse registry hasn't listed it —
 * a defensive fallback for legacy pre-WI-5321 installs (whose real workspace
 * really is id "default") and tests. Since WI-5321 a FRESH install mints a
 * real, unique, non-'default' workspace id (workspaces.rs `ensure_initialized`)
 * specifically because the literal string collides with
 * `DEFAULT_COORD_WORKSPACE` — the p2p/allotment layer's coordination-shared
 * partition sentinel (WI-1564) — so "the desktop guarantees it exists" no
 * longer holds for new installs; this fallback exists for the legacy case,
 * not as a promise every install has one.
 *
 * A process PINNED to a workspace via PAPERCUSP_WORKSPACE_ID (the P-020
 * single-workspace model — orchestrator agents, hermetic gym operators) knows
 * its own pin even when the desktop-owned FILE registry doesn't list it:
 * the gym boots a synthetic workspace that exists only in its isolated PG, so
 * every `?ws=` request inside the rig — including the scheduled blueprint-run
 * decider fire — was rejected unknown_workspace/400 (EI-212). The pin is set
 * by the process's own launcher, so honoring it cannot widen what a CALLER
 * can claim.
 */
export function isKnownWorkspace(id: string): boolean {
  if (!id || !id.trim()) return false;
  if (id === DEFAULT_WORKSPACE_ID) return true;
  const pinned = process.env.PAPERCUSP_WORKSPACE_ID?.trim();
  if (pinned && id === pinned) return true;
  return !!workspaceById(id);
}

/**
 * Absolute path to a workspace's data dir — the directory the desktop
 * sidecar is spawned with as HOME (see papercusp-desktop workspaces.rs
 * `workspace_dir`). Mirrors the Rust layout: `<root>/<id>`.
 */
export function workspaceDir(id: string): string {
  return join(workspacesRoot(), id);
}

/**
 * Ensure a workspace's data dir exists on disk. The desktop `switch()`
 * guard refuses to switch to a registered workspace whose directory is
 * missing, so any code path that adds a registry entry MUST also provision
 * the directory. Idempotent. Returns the dir path.
 */
export function ensureWorkspaceDir(id: string): string {
  const dir = workspaceDir(id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Ensure `id` is a REGISTERED workspace entry (idempotent) and provision its
 * data dir. Adds `{ id, name, createdAt }` to `reg.workspaces` if absent;
 * leaves an existing entry untouched. Returns the (possibly updated) registry.
 *
 * The auto-join path (joinCanonicalPapercuspHive → setHome) used to set
 * `reg.current = papercusp-workspace` WITHOUT adding that id to
 * `reg.workspaces[]`, leaving the registry in a `current`-points-at-unlisted
 * state. The UI then resolved a current workspace it couldn't find in the list
 * → `unknown_workspace` on git-identity save + a greyed-out GitHub sign-in
 * button on a fresh clean install (the workspace context was invalid). Any code
 * that makes a workspace "current" MUST first register it — that is what this
 * helper guarantees.
 */
export function ensureWorkspaceEntry(id: string, name?: string): WorkspaceRegistry {
  const reg = readRegistry();
  if (!reg.workspaces.some((w) => w.id === id)) {
    reg.workspaces.push({ id, name: name ?? id, createdAt: Date.now() });
    writeRegistry(reg);
  }
  ensureWorkspaceDir(id);
  return reg;
}

/**
 * Register `id` (idempotent; provisions its data dir) and make it the registry's
 * `current` workspace. Registration comes FIRST on purpose: a `current` that names an
 * unlisted id makes `isKnownWorkspace(current)` false, and the workspace-context
 * middleware then answers `unknown_workspace` 400 to every /api call stamped with it
 * (the 2026-07-07 packaged-.deb onboarding hang). No write when `id` is already current.
 *
 * The single register-then-make-current primitive: the dogfood home hive
 * (`defaultSetHomeWorkspace`) and a hosted workspace host's bound customer workspace
 * (WI-10003163) both route through it.
 */
export function ensureCurrentWorkspace(id: string, name?: string): WorkspaceRegistry {
  const reg = ensureWorkspaceEntry(id, name);
  if (reg.current !== id) {
    reg.current = id;
    writeRegistry(reg);
  }
  return reg;
}

export function setCompanyId(workspaceId: string, companyId: string | null): void {
  const reg = readRegistry();
  const ws = reg.workspaces.find((w) => w.id === workspaceId);
  if (!ws) {
    throw new Error(`unknown workspace ${workspaceId}`);
  }
  if (companyId == null) {
    delete (ws as any).companyId;
  } else {
    ws.companyId = companyId;
  }
  writeRegistry(reg);
}

export function companyIdFor(workspaceId: string): string | null {
  return workspaceById(workspaceId)?.companyId ?? null;
}
