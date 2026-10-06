/**
 * desktop-session-registry — the cross-process DesktopSession inventory
 * (agent-virtual-desktops-2026-08-23 P-003 / WI-40829; D-004, D-005, D-006).
 *
 * READ D-004 BEFORE EXTENDING THIS. The registry is a durable PG RECORD of
 * desktop sessions PLUS the existing in-process handles — it is deliberately NOT
 * a relocation of live desktop state into Postgres:
 *
 *   PG row     = identity, kind, scope, owner, geometry, viewer binding,
 *                lifecycle timestamps, MEASURED host capability.
 *   In-process = the ChildProcess handles and the release() closure, which stay
 *                exactly where they are (desktop-lease.ts, display-allocator.ts).
 *
 * Both of those modules cite the storage policy's carve-out that a per-process
 * resource lease — a live child of THIS loop, which dies when the loop dies — is
 * legitimately non-PG. That reasoning is still correct and is preserved. What the
 * carve-out never covered is a cross-process, cross-machine INVENTORY: today
 * `computer:list_desktops` can only enumerate one process's Map, so a frame-slot
 * display or a VM guest desktop is invisible to it. That gap is what this closes.
 *
 * ⚠ THE ONE INVARIANT THAT MATTERS: a row without a live handle in its owning
 * process is DEAD. LIVENESS IS NEVER INFERRED FROM THE ROW ALONE — a row is a
 * claim about a process, not proof of one. `reconcileLocalDesktopSessions()` is
 * what makes that true again at operator start; see its own doc comment for why
 * it is scoped the way it is.
 *
 * Every function takes an optional `sql` so integration tests can pass a
 * per-file schema, and carries an explicit `workspace_id` predicate (RLS is the
 * backstop, not the guard) — the convention shared with hive-membership-store.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

/**
 * Every desktop kind, as DATA so the set can be walked — the union below is derived
 * from it rather than restated. `desktop-sessions-schema.integration.test.ts` iterates
 * THIS array against the live `desktop_sessions_kind_ck`, which is what makes the PG
 * constraint and the TypeScript set provably the same set instead of two hand-kept
 * copies that agree until they quietly do not.
 *
 * ⚠ Widening it is a THREE-PLACE change and tsc catches only two:
 *   1. `DESKTOP_LIFECYCLE_POLICY` is a `Record<DesktopKind, …>` — fails to compile
 *      until the new kind has D-008 rule-3 freeze/reap thresholds. (Caught.)
 *   2. Any other exhaustive `Record`/`switch` over the union. (Caught.)
 *   3. The PG CHECK constraint, which tsc cannot see. A kind added here with no
 *      migration inserts happily in unit tests (they stub PG) and is REJECTED in
 *      production. Ship the migration in the same change — the schema integration
 *      test is what turns that from a rule into a failure.
 */
export const DESKTOP_KINDS = [
  'xvfb-local',
  'frame-slot',
  'vm-guest',
  'bwrap',
  'microvm',
  'kasmvnc',
] as const;

export type DesktopKind = (typeof DESKTOP_KINDS)[number];
export type DesktopScope = 'pot' | 'agent' | 'workspace';
export type DesktopState = 'provisioning' | 'ready' | 'idle' | 'frozen' | 'released' | 'dead';
export type DesktopViewerMode = 'none' | 'watch' | 'takeover';

/** States in which a session no longer holds its display. Mirrors the SQL CHECK
 *  and the partial-index predicate in migration 900 — see the drift guard in the
 *  registry's integration test, which pins these two definitions together. */
export const TERMINAL_DESKTOP_STATES: readonly DesktopState[] = ['released', 'dead'] as const;

export function isTerminalDesktopState(state: DesktopState): boolean {
  return TERMINAL_DESKTOP_STATES.includes(state);
}

/**
 * D-006: what the AGENT is served, independent of what the X server runs at.
 *
 * Claude meters an image at roughly (w*h)/750 tokens, so 1920x1080 (~2,765) costs
 * about 2.6x 1024x768 (~1,050) for every observation — and a computer-use loop
 * pays that per step, so it compounds. A frame legitimately RUNS at 1920x1080
 * because the human live view wants the real thing; serving those pixels to the
 * model as well is the accidental 2.6x this default exists to stop.
 */
export const DEFAULT_CAPTURE_GEOMETRY = { width: 1024, height: 768 } as const;

export interface DesktopCapabilities {
  gl?: boolean;
  wayland?: boolean;
  kvm?: boolean;
  a11y?: boolean;
  /**
   * P-005 — the display backend the session was BOOTED with, for guest kinds.
   *
   * This exists because of a QEMU property that is easy to discover the expensive
   * way (EI-20504354859682877, measured on QEMU 8.2): `display-update` updates an
   * EXISTING display backend, it cannot CREATE one. A guest booted with `-display
   * none` answers `query-vnc-servers` with `[]` forever, and every attempt to
   * attach a viewer later fails with `Can not find vnc display` — no listener and
   * no guest state changed, so it presents as a viewer bug rather than a boot-time
   * decision made hours earlier and now unfixable without a reboot.
   *
   * So a guest desktop declares its backend at REGISTRATION and registration
   * refuses one that does not: the constraint is enforced where it is still
   * cheap to satisfy, rather than discovered when someone wants to look.
   */
  displayBackend?: 'vnc' | 'spice' | 'gtk' | 'sdl' | 'egl-headless' | 'none';
}

/** Desktop kinds that are a GUEST — a VM whose display backend must be chosen at
 *  boot because it cannot be added later (see `displayBackend`). */
export const GUEST_DESKTOP_KINDS: readonly DesktopKind[] = ['vm-guest', 'microvm'] as const;

/**
 * The EI-20504354859682877 precondition, as a pure function so both the registry
 * and any future guest provisioner (P-011) enforce the same rule from one place.
 *
 * Returns an error message, or null when the input is acceptable.
 */
export function guestDisplayBackendError(
  kind: DesktopKind,
  capabilities: DesktopCapabilities | undefined,
): string | null {
  if (!GUEST_DESKTOP_KINDS.includes(kind)) return null;
  const backend = capabilities?.displayBackend;
  if (!backend) {
    return (
      `desktop-session-registry — a '${kind}' session must declare capabilities.displayBackend at registration. ` +
      'QMP display-update can only update an EXISTING backend, never create one (EI-20504354859682877), ' +
      'so a guest booted without one can never be viewed and cannot be repaired without a reboot.'
    );
  }
  if (backend === 'none') {
    return (
      `desktop-session-registry — refusing to register a '${kind}' session with displayBackend 'none'. ` +
      'A guest booted with no display backend cannot have one attached later (EI-20504354859682877); ' +
      "boot it with 'vnc' or 'egl-headless' if anything will ever need to see it."
    );
  }
  return null;
}

export interface DesktopSessionRecord {
  id: string;
  workspaceId: string;
  harnessSlug: string | null;
  kind: DesktopKind;
  scope: DesktopScope;
  scopeRef: string;
  /** Migration 1386 / D-003: the agent-chosen name of an agent-scoped desktop, unique
   *  per live (workspace, agent). NULL for pot, workspace and deployed-frame rows. */
  name: string | null;
  hostRef: string | null;
  ownerPid: number | null;
  ownerBootId: string | null;
  display: string;
  displayGeometry: { width: number; height: number; depth: number };
  captureGeometry: { width: number; height: number };
  state: DesktopState;
  leaseHolder: string | null;
  viewerMode: DesktopViewerMode;
  viewerActor: string | null;
  capabilities: DesktopCapabilities;
  ttlSec: number | null;
  /** P-005: the task-ledger id of the process subtree backing this desktop — the
   *  freeze/thaw/kill HANDLE. NULL = unenrolled: still reapable (the row closes),
   *  but not freezable, and the governor reports that rather than no-opping. */
  taskId: string | null;
  /** P-005: per-session idle threshold override; NULL takes the per-kind default. */
  idleAfterSec: number | null;
  /** P-005: when the session entered `frozen`; cleared on thaw. */
  frozenAt: Date | null;
  createdAt: Date;
  lastActiveAt: Date;
  releasedAt: Date | null;
}

export interface RegisterDesktopSessionInput {
  workspaceId: string;
  harnessSlug?: string | null;
  kind: DesktopKind;
  scope: DesktopScope;
  scopeRef: string;
  /** Agent-scoped desktops only (the DB CHECK refuses a name on any other scope). */
  name?: string | null;
  display: string;
  displayGeometry: { width: number; height: number; depth?: number };
  /** Omit to take the D-006 default. Raise it deliberately when an agent
   *  genuinely needs the detail and is willing to pay the tokens. */
  captureGeometry?: { width: number; height: number };
  hostRef?: string | null;
  leaseHolder?: string | null;
  capabilities?: DesktopCapabilities;
  ttlSec?: number | null;
  /** P-005 — the task-ledger id backing this desktop, when the caller enrolled
   *  its processes. Omit and the session is reapable but not freezable. */
  taskId?: string | null;
  /** P-005 — per-session idle threshold override; omit to take the per-kind default. */
  idleAfterSec?: number | null;
  /** Defaults to this process. Pass explicitly for a remote-owned session. */
  ownerPid?: number | null;
  ownerBootId?: string | null;
  id?: string;
}

function db(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

let cachedBootId: string | undefined;

/**
 * A per-BOOT identity, so a recycled pid cannot make a stale row alias a live
 * unrelated process. Pids wrap roughly daily on this box under fleet load, which
 * is frequent enough that pid-only ownership would mis-reconcile in practice
 * rather than in theory.
 */
export function currentBootId(): string {
  if (cachedBootId !== undefined) return cachedBootId;
  try {
    cachedBootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    // Non-Linux or a locked-down /proc: fall back to a per-process id. That
    // degrades reconciliation to "this process only", which is SAFE — it never
    // reaps another process's row — rather than wrong.
    cachedBootId = `pid-${process.pid}-${Date.now()}`;
  }
  return cachedBootId;
}

export function _resetBootIdForTests(): void {
  cachedBootId = undefined;
}

/**
 * The canonical client hands `timestamptz` back as TEXT once drizzle has wrapped it
 * (see `restoreRawDateSerializers`), so a raw read cannot promise the `Date` this
 * record declares. Measured 2026-09-23: `lastActiveAt` arrived as a string and the
 * hosted roster's `.toISOString()` threw on the first row, which failed every
 * `desktop.start` on a Papercusp-hosted machine AFTER its desktop was up (D-405).
 */
function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function asNullableDate(value: Date | string | null | undefined): Date | null {
  return value === null || value === undefined ? null : asDate(value);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function toRecord(r: any): DesktopSessionRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    harnessSlug: r.harness_slug ?? null,
    kind: r.kind,
    scope: r.scope,
    scopeRef: r.scope_ref,
    name: r.name ?? null,
    hostRef: r.host_ref ?? null,
    ownerPid: r.owner_pid ?? null,
    ownerBootId: r.owner_boot_id ?? null,
    display: r.display,
    displayGeometry: {
      width: Number(r.display_width),
      height: Number(r.display_height),
      depth: Number(r.display_depth),
    },
    captureGeometry: { width: Number(r.capture_width), height: Number(r.capture_height) },
    state: r.state,
    leaseHolder: r.lease_holder ?? null,
    viewerMode: r.viewer_mode,
    viewerActor: r.viewer_actor ?? null,
    capabilities: (r.capabilities ?? {}) as DesktopCapabilities,
    ttlSec: r.ttl_sec ?? null,
    taskId: r.task_id ?? null,
    idleAfterSec: r.idle_after_sec ?? null,
    frozenAt: asNullableDate(r.frozen_at),
    createdAt: asDate(r.created_at),
    lastActiveAt: asDate(r.last_active_at),
    releasedAt: asNullableDate(r.released_at),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Record a new desktop session. The row starts in `provisioning`: the caller
 * flips it to `ready` via `markDesktopReady` once the display actually answers
 * and its capabilities have been MEASURED. Registering as `ready` up front would
 * publish a session that nothing has yet proven works — exactly the blank-screen
 * class P-002 fixed.
 *
 * Uniqueness is enforced by the database, not here: a second live session for one
 * (workspace, scope, scope_ref), or a second live session on one host+display,
 * raises. Callers that legitimately race (ensureHiveDesktop) should coalesce
 * in-process AND treat the unique violation as "someone else won", not as a bug.
 */
export async function registerDesktopSession(
  input: RegisterDesktopSessionInput,
  sql?: Sql,
): Promise<DesktopSessionRecord> {
  // Enforced BEFORE the insert: a guest without a display backend is not a row to
  // fix up later, it is a boot decision that can no longer be changed.
  const guestErr = guestDisplayBackendError(input.kind, input.capabilities);
  if (guestErr) throw new Error(guestErr);

  const id = input.id ?? randomUUID();
  const capture = input.captureGeometry ?? DEFAULT_CAPTURE_GEOMETRY;
  const rows = await db(sql)`
    INSERT INTO harness_shared.desktop_sessions (
      id, workspace_id, harness_slug, kind, scope, scope_ref, name, host_ref,
      owner_pid, owner_boot_id, display,
      display_width, display_height, display_depth,
      capture_width, capture_height,
      state, lease_holder, capabilities, ttl_sec, task_id, idle_after_sec
    ) VALUES (
      ${id}, ${input.workspaceId}, ${input.harnessSlug ?? null}, ${input.kind},
      ${input.scope}, ${input.scopeRef}, ${input.name ?? null}, ${input.hostRef ?? null},
      ${input.ownerPid ?? process.pid}, ${input.ownerBootId ?? currentBootId()},
      ${input.display},
      ${input.displayGeometry.width}, ${input.displayGeometry.height},
      ${input.displayGeometry.depth ?? 24},
      ${capture.width}, ${capture.height},
      'provisioning', ${input.leaseHolder ?? null},
      ${db(sql).json((input.capabilities ?? {}) as never)}, ${input.ttlSec ?? null},
      ${input.taskId ?? null}, ${input.idleAfterSec ?? null}
    )
    RETURNING *`;
  return toRecord(rows[0]);
}

/**
 * Promote a provisioning session to `ready`, stamping the capabilities that were
 * MEASURED while standing it up (D-004: measured, never assumed — this is what
 * gates the microVM tier per D-001, and where P-002's GL ladder verdict lands so
 * every downstream consumer reads it instead of re-probing).
 */
export async function markDesktopReady(
  id: string,
  patch: { capabilities?: DesktopCapabilities; display?: string } = {},
  sql?: Sql,
): Promise<DesktopSessionRecord | undefined> {
  const client = db(sql);
  const rows = await client`
    UPDATE harness_shared.desktop_sessions
       SET state          = 'ready',
           last_active_at = now(),
           display        = COALESCE(${patch.display ?? null}, display),
           capabilities   = CASE
                              WHEN ${patch.capabilities ? 1 : 0} = 1
                                THEN ${client.json((patch.capabilities ?? {}) as never)}
                              ELSE capabilities
                            END
     WHERE id = ${id}
       AND state NOT IN ('released', 'dead')
    RETURNING *`;
  return rows[0] ? toRecord(rows[0]) : undefined;
}

/**
 * Bump the activity clock — what the idle governor and P-014 cost attribution read.
 *
 * A touch also THAWS the state machine: a session that was demoted to `idle`
 * returns to `ready` the moment someone drives it again. It deliberately does NOT
 * un-freeze a `frozen` session, because the processes really are suspended at the
 * cgroup and only `thawDesktopSession` (which actuates the freezer) can undo that
 * — flipping the row alone would publish a "ready" desktop whose X server cannot
 * answer, which is the blank-screen class P-002 fixed, reintroduced through the
 * back door.
 */
export async function touchDesktopSession(id: string, sql?: Sql): Promise<void> {
  await db(sql)`
    UPDATE harness_shared.desktop_sessions
       SET last_active_at = now(),
           state          = CASE WHEN state = 'idle' THEN 'ready' ELSE state END
     WHERE id = ${id} AND state NOT IN ('released', 'dead')`;
}

/**
 * P-005 — renew a lease: bump the activity clock and, optionally, re-set the TTL.
 *
 * Distinct from `touchDesktopSession` on purpose. A touch says "someone drove
 * this"; a renewal says "the holder still wants it", which is what a lease TTL
 * actually measures. They differ for exactly the case the TTL exists to catch: an
 * agent that crashed mid-loop leaves a desktop whose last screenshot was seconds
 * ago (touched) but whose holder is never coming back to renew it.
 *
 * Returns undefined when the session is gone or terminal — a renewal that silently
 * "succeeded" against a reaped session is how a caller keeps believing it holds a
 * desktop it does not.
 */
export async function renewDesktopLease(
  id: string,
  patch: { ttlSec?: number | null; leaseHolder?: string | null } = {},
  sql?: Sql,
): Promise<DesktopSessionRecord | undefined> {
  // `undefined` means "leave the TTL alone"; an explicit `null` means "clear it".
  // Collapsing those two into one nullable parameter is how a renewal silently
  // turns a TTL'd lease into an immortal one.
  const setTtl = patch.ttlSec !== undefined;
  const rows = await db(sql)`
    UPDATE harness_shared.desktop_sessions
       SET last_active_at = now(),
           state          = CASE WHEN state = 'idle' THEN 'ready' ELSE state END,
           ttl_sec        = CASE WHEN ${setTtl ? 1 : 0} = 1
                                 THEN ${patch.ttlSec ?? null}::integer
                                 ELSE ttl_sec END,
           lease_holder   = COALESCE(${patch.leaseHolder ?? null}, lease_holder)
     WHERE id = ${id} AND state NOT IN ('released', 'dead')
    RETURNING *`;
  return rows[0] ? toRecord(rows[0]) : undefined;
}

/**
 * Bind a session to its task-ledger row. This is what makes a desktop FREEZABLE:
 * `freezeTask(taskId)` freezes the whole cgroup subtree, so a guest that
 * double-forks or reparents to init is still caught.
 *
 * Best-effort at the call site (the desktop works without it) but never silent
 * here: the return value says whether the binding landed, so a caller that cares
 * can log an unenrolled desktop instead of discovering it when a freeze no-ops.
 */
export async function setDesktopTaskId(
  id: string,
  taskId: string | null,
  sql?: Sql,
): Promise<boolean> {
  const rows = await db(sql)`
    UPDATE harness_shared.desktop_sessions
       SET task_id = ${taskId}
     WHERE id = ${id} AND state NOT IN ('released', 'dead')
    RETURNING id`;
  return rows.length > 0;
}

/**
 * Demote a `ready` session to `idle` — a pure bookkeeping transition that
 * actuates nothing. It is the governor's first, cheapest move: it makes the
 * session visible as a freeze candidate without suspending anything, so a short
 * gap in an agent's loop costs a state flip rather than a freeze/thaw round trip.
 *
 * Guarded to `ready` so it can never demote a `frozen` session (which would drop
 * the frozen_at stamp the reaper escalates on) or resurrect a terminal one.
 */
export async function markDesktopIdle(id: string, sql?: Sql): Promise<boolean> {
  const rows = await db(sql)`
    UPDATE harness_shared.desktop_sessions
       SET state = 'idle'
     WHERE id = ${id} AND state = 'ready'
    RETURNING id`;
  return rows.length > 0;
}

/**
 * Record that a session's processes are suspended. Stamps `frozen_at`, which the
 * SQL CHECK requires and the reaper escalates on — a frozen row without one would
 * read as freshly-frozen on every pass and never age out, leaking its display
 * forever.
 *
 * ⚠ THE ROW IS THE RECORD, NOT THE ACT. Call this only AFTER the freezer actually
 * reported success; see `desktop-lifecycle.ts`, which owns that ordering.
 */
export async function markDesktopFrozen(id: string, sql?: Sql): Promise<boolean> {
  const rows = await db(sql)`
    UPDATE harness_shared.desktop_sessions
       SET state = 'frozen', frozen_at = now()
     WHERE id = ${id} AND state IN ('ready', 'idle')
    RETURNING id`;
  return rows.length > 0;
}

/**
 * Record that a session's processes are running again: back to `ready`, stamp
 * cleared, activity clock bumped (a thaw is a use).
 *
 * Same ordering rule as `markDesktopFrozen`, inverted: actuate the thaw FIRST,
 * then write this. A row that says `ready` over a still-frozen cgroup hands an
 * agent a desktop that cannot answer.
 */
export async function markDesktopThawed(id: string, sql?: Sql): Promise<boolean> {
  const rows = await db(sql)`
    UPDATE harness_shared.desktop_sessions
       SET state = 'ready', frozen_at = NULL, last_active_at = now()
     WHERE id = ${id} AND state = 'frozen'
    RETURNING id`;
  return rows.length > 0;
}

/**
 * Mark a session terminal. `released` is an orderly teardown; `dead` is "the
 * owning process is gone". Both stamp released_at, which the SQL CHECK requires —
 * a terminal row without one would read as fresh to the reaper.
 *
 * Idempotent, and deliberately so: teardown races (pot:dissolve firing while an
 * operator shutdown sweeps) must not throw.
 */
export async function closeDesktopSession(
  id: string,
  state: 'released' | 'dead' = 'released',
  sql?: Sql,
): Promise<boolean> {
  const rows = await db(sql)`
    UPDATE harness_shared.desktop_sessions
       SET state = ${state}, released_at = now()
     WHERE id = ${id} AND state NOT IN ('released', 'dead')
    RETURNING id`;
  return rows.length > 0;
}

export interface ListDesktopSessionsFilter {
  workspaceId: string;
  harnessSlug?: string | null;
  scope?: DesktopScope;
  /** With `scope`, narrows to one owner — e.g. scope 'agent' + an ownerId is "my desktops". */
  scopeRef?: string;
  /** Include released/dead rows. Off by default: the common question is "what is
   *  live right now", and a terminal row answering it is the bug this guards. */
  includeTerminal?: boolean;
  limit?: number;
}

/**
 * Enumerate sessions for a tenant — EVERY kind, which is the point: this is what
 * lets `computer:list_desktops` see a frame slot or a VM guest that never existed
 * in the local process Map.
 */
export async function listDesktopSessions(
  filter: ListDesktopSessionsFilter,
  sql?: Sql,
): Promise<DesktopSessionRecord[]> {
  const client = db(sql);
  const rows = await client`
    SELECT * FROM harness_shared.desktop_sessions
     WHERE workspace_id = ${filter.workspaceId}
       ${filter.harnessSlug ? client`AND harness_slug = ${filter.harnessSlug}` : client``}
       ${filter.scope ? client`AND scope = ${filter.scope}` : client``}
       ${filter.scopeRef ? client`AND scope_ref = ${filter.scopeRef}` : client``}
       ${filter.includeTerminal ? client`` : client`AND state NOT IN ('released', 'dead')`}
     ORDER BY created_at DESC
     LIMIT ${Math.min(filter.limit ?? 200, 1000)}`;
  return rows.map(toRecord);
}

/**
 * The live session for one scope, or undefined. This is the resolver
 * capability:computer sits on: `scope:'pot'` keyed by the caller's harness slug
 * reproduces today's behaviour exactly, and `scope:'agent'` keyed by ownerId
 * reproduces the frame path's exclusivity.
 *
 * ⚠ Returns the RECORD, never a liveness verdict (D-004). A caller that needs a
 * drivable display must still hold — or resolve — the in-process handle.
 */
/**
 * P-005 — every live session THIS HOST may govern, oldest activity first.
 *
 * Host-scoped on purpose, and not as an optimisation. The governor's actions are
 * host-local operations on a real cgroup: it can freeze, thaw and kill only
 * processes on the machine it is running on. A sweep that pulled in another
 * host's rows would classify them, "act" on them, and report success having done
 * nothing to the actual processes — while marking the row frozen, which then
 * misreports a busily-spinning guest as suspended. Better to see only what we can
 * touch. Remote hosts govern their own; that is what `host_ref` is for.
 *
 * Not filtered by workspace: a host runs one operator serving whatever tenants it
 * serves, and CPU on the box is shared by all of them.
 */
export async function listGovernableDesktopSessions(
  args: { hostRef?: string | null; limit?: number } = {},
  sql?: Sql,
): Promise<DesktopSessionRecord[]> {
  const rows = await db(sql)`
    SELECT * FROM harness_shared.desktop_sessions
     WHERE COALESCE(host_ref, '') = ${args.hostRef ?? ''}
       AND state NOT IN ('released', 'dead')
     ORDER BY last_active_at ASC
     LIMIT ${Math.min(args.limit ?? 500, 2000)}`;
  return rows.map(toRecord);
}

/**
 * `name` (migration 1386 / D-003): a string selects that agent desktop exactly; an
 * explicit `null` selects the scope's UNNAMED row (pot, workspace, deployed frame);
 * omitted means "any live row for this scope", most recently used first — the D-005
 * default when an agent holds several desktops and names none.
 */
export async function resolveDesktopForScope(
  args: { workspaceId: string; scope: DesktopScope; scopeRef: string; name?: string | null },
  sql?: Sql,
): Promise<DesktopSessionRecord | undefined> {
  const client = db(sql);
  const nameFilter =
    args.name === undefined
      ? client``
      : args.name === null
        ? client`AND name IS NULL`
        : client`AND name = ${args.name}`;
  const rows = await client`
    SELECT * FROM harness_shared.desktop_sessions
     WHERE workspace_id = ${args.workspaceId}
       AND scope        = ${args.scope}
       AND scope_ref    = ${args.scopeRef}
       ${nameFilter}
       AND state NOT IN ('released', 'dead')
     ORDER BY last_active_at DESC
     LIMIT 1`;
  return rows[0] ? toRecord(rows[0]) : undefined;
}

/**
 * One session by id, tenant-scoped. Includes terminal rows only when asked: the
 * common caller is "release / drive this desktop", for which a released row is the
 * same answer as no row.
 */
export async function getDesktopSession(
  args: { workspaceId: string; id: string; includeTerminal?: boolean },
  sql?: Sql,
): Promise<DesktopSessionRecord | undefined> {
  // A malformed id is a miss, not a Postgres `invalid input syntax for type uuid` error.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.id)) return undefined;
  const client = db(sql);
  const rows = await client`
    SELECT * FROM harness_shared.desktop_sessions
     WHERE workspace_id = ${args.workspaceId}
       AND id = ${args.id}
       ${args.includeTerminal ? client`` : client`AND state NOT IN ('released', 'dead')`}
     LIMIT 1`;
  return rows[0] ? toRecord(rows[0]) : undefined;
}

/**
 * Resolve a LOCAL desktop by its X display string (":110") — the admission gate
 * for the local live view (P-004).
 *
 * ⚠ THIS IS A SECURITY BOUNDARY, not a lookup convenience. The local live view
 * spawns `x11vnc -display <n>` on THIS host, and this host also runs the owner's
 * real session on :0/:1. A viewer that could name an arbitrary display number
 * would be handed a video feed of — and in `takeover` mode a keyboard and mouse
 * on — the human's actual desktop. So the local VNC path resolves its display
 * through this function and refuses anything it does not return: only a display
 * that some agent desktop session REGISTERED is viewable.
 *
 * `host_ref IS NULL` is what "local" means in this schema (a remote row names its
 * host), so a remote frame's `:99` can never satisfy a local request even when
 * the display numbers collide — those go over the frame path's SSH hop instead.
 */
export async function resolveLocalDesktopByDisplay(
  args: { workspaceId: string; display: string },
  sql?: Sql,
): Promise<DesktopSessionRecord | undefined> {
  const rows = await db(sql)`
    SELECT * FROM harness_shared.desktop_sessions
     WHERE workspace_id = ${args.workspaceId}
       AND host_ref IS NULL
       AND display     = ${args.display}
       AND state NOT IN ('released', 'dead')
     LIMIT 1`;
  return rows[0] ? toRecord(rows[0]) : undefined;
}

/**
 * Bind (or clear) the human viewer on a session — the cross-process half of the
 * live view's "someone is watching this desktop" indicator (P-004).
 *
 * The in-process `activeVncSessions()` map already answers this for the operator
 * that owns the bridge; the row answers it for everyone else, which is the whole
 * reason the viewer columns are in PG. Pass `mode:'none'` to clear — the actor is
 * dropped with it, so a stale name can never outlive the session that earned it.
 *
 * Returns false when the row is gone or already terminal: a viewer teardown
 * racing a desktop release is normal, not an error.
 */
export async function setDesktopViewer(
  id: string,
  viewer: { mode: DesktopViewerMode; actor?: string | null },
  sql?: Sql,
): Promise<boolean> {
  const actor = viewer.mode === 'none' ? null : (viewer.actor ?? null);
  const rows = await db(sql)`
    UPDATE harness_shared.desktop_sessions
       SET viewer_mode = ${viewer.mode}, viewer_actor = ${actor}, last_active_at = now()
     WHERE id = ${id} AND state NOT IN ('released', 'dead')
    RETURNING id`;
  return rows.length > 0;
}

/**
 * Operator-start reconciliation (D-004). Marks DEAD every non-terminal LOCAL row
 * that this process cannot vouch for with a live handle.
 *
 * SCOPING, and why it is narrow on purpose. It reaps exactly two populations:
 *   1. rows stamped with a DIFFERENT boot id — the machine rebooted, so every
 *      local X server they describe is definitionally gone;
 *   2. rows stamped with THIS boot AND this pid, whose id is not in `liveIds` —
 *      this process owns them and knows it has no handle.
 *
 * It deliberately does NOT reap a row owned by a different pid on the same boot:
 * that may be a SIBLING operator process very much alive, and reaping its
 * sessions would tear down working desktops. Being narrow means a stale row can
 * survive until the next reboot; that is the safe direction of error, because the
 * cost of a surviving stale row is a misleading list entry, while the cost of an
 * over-eager reap is killing a peer's live desktop.
 *
 * Remote-owned rows (host_ref NOT NULL) are never touched here — their owner
 * reconciles them.
 *
 * `soleOwner` widens population 2 to EVERY pid on this boot. Pass it only where
 * the caller is, by construction, the one process that registers local desktops
 * for this workspace — a Papercusp workspace host: one operator unit, and its
 * D-363 desktops die with the socket that operator holds. There, a row it cannot
 * vouch for was left by a previous incarnation of itself, and leaving it `ready`
 * blocks the next desktop on both live-row unique indexes (WI-10002797).
 *
 * `soleOwner` also drops the `workspace_id` predicate (D-439). The live-display
 * index is `(host_ref, display)` with NO workspace column, so a local row left under
 * the workspace id an earlier release used (the host's id moved at registration,
 * WI-10003163) still holds its display — and a per-workspace sweep never sees it.
 * The sole local owner answers for every local row on the machine, whatever
 * workspace it was stamped with.
 */
export async function reconcileLocalDesktopSessions(
  args: { workspaceId: string; liveIds: readonly string[]; bootId?: string; pid?: number; soleOwner?: boolean },
  sql?: Sql,
): Promise<{ reaped: number; reapedIds: string[] }> {
  const bootId = args.bootId ?? currentBootId();
  const pid = args.pid ?? process.pid;
  const soleOwner = args.soleOwner === true;
  // An EMPTY array is the correct value here, not a sentinel: `NOT (id = ANY('{}'))`
  // is true for every row, which is exactly "this process vouches for nothing".
  // A `['']` placeholder instead raises `invalid input syntax for type uuid: ""`,
  // turning the most important reconciliation case (a process that came back
  // holding no handles) into a hard error. Caught by the reconciliation tests.
  const live = [...args.liveIds];
  const rows = await db(sql)`
    UPDATE harness_shared.desktop_sessions
       SET state = 'dead', released_at = now()
     WHERE (${soleOwner}::boolean OR workspace_id = ${args.workspaceId})
       AND host_ref IS NULL
       AND state NOT IN ('released', 'dead')
       AND (
             owner_boot_id IS DISTINCT FROM ${bootId}
             OR ((${soleOwner}::boolean OR owner_pid = ${pid}) AND NOT (id = ANY(${live as string[]}::uuid[])))
           )
    RETURNING id`;
  return { reaped: rows.length, reapedIds: rows.map((r) => r.id as string) };
}
