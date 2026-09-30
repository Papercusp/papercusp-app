/**
 * p2p/foreign-workspaces.ts — the host-local FOREIGN WORKSPACE registry
 * (p2p-work-distribution-2026-07-02 P-109; table: mig 467).
 *
 * One row per claimed offer executing on THIS host. P-104's local-authority
 * spawn REGISTERS (provisioning→active) and BINDS the foreign session; the
 * worktree-guard (leg i), the foreign-git-sync commit lane (leg ii), the
 * quarantine mirror lane (leg iii), and P-106's reaper consume it.
 *
 * DELIBERATELY HOST-LOCAL (M19): root paths / session ids / clone state are
 * machine facts. The federating plane is p2p_peer_grants (grant-store.ts).
 *
 * FAIL-CLOSED CONTRACT (design doc §2/§5): every consumer treats "no row" or
 * "row not in the required state" as DENY — a foreign session with no live
 * registry row edits nothing and commits nothing. Helpers here therefore
 * return null / [] rather than throwing on absence, and NEVER invent rows.
 *
 * Q1 (leader-ratified): the BINDING placement rule is the INVARIANT — root
 * outside the workspace root, not inside any host tree — enforced by
 * assertForeignRootInvariant at registration time; the literal path family is
 * provisional until P-105's quota tier pins the mount root.
 */
import { getOrgPg } from '@papercusp/db-org';
import { isAbsolute, resolve, sep } from 'node:path';
import type { OrgSql } from '../work-items';

export type ForeignWorkspaceState =
  | 'provisioning'
  | 'active'
  | 'winding-down'
  | 'parked'
  | 'reaped';

export interface ForeignWorkspace {
  workspaceId: string;
  offerId: string;
  fleetSlug: string;
  originGithubUserId: number;
  executorDevice: string;
  rootPath: string;
  clonePath: string;
  sessionId: string | null;
  executionEpoch: number;
  state: ForeignWorkspaceState;
  parkReason: string | null;
  /** The canonical sha the clone was provisioned FROM (mig 470) — the publish
   *  admission's range anchor. Null (pre-470 / refused clone) = no anchor:
   *  full-history judgment, the fail-closed direction. */
  baseSha: string | null;
  /** epoch ms — mig 467 `created_at`. The claim/registration floor P-104's
   *  H12 liveness deps seed `lastConfirmedAt` from absent a session-activity
   *  heartbeat (P-407). */
  createdAt: number;
  /** epoch ms — mig 467 `updated_at`, bumped on bind-to-active (P-104) and
   *  every state transition (setForeignWorkspaceState / setForeignWorkspaceBaseSha).
   *  The best available "last confirmed" floor until a real heartbeat lands. */
  updatedAt: number;
}

interface Row {
  workspace_id: string;
  offer_id: string;
  fleet_slug: string;
  origin_github_user_id: string | number;
  executor_device: string;
  root_path: string;
  clone_path: string;
  session_id: string | null;
  execution_epoch: string | number;
  state: string;
  park_reason: string | null;
  base_sha?: string | null;
  created_at?: string | number | Date;
  updated_at?: string | number | Date;
}

/** Coerce a postgres-js timestamptz value (Date, ISO string, or epoch-ms
 *  number depending on the driver's parse config) to epoch ms. */
function toEpochMs(v: string | number | Date | undefined): number {
  if (v == null) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

function fromRow(r: Row): ForeignWorkspace {
  return {
    workspaceId: r.workspace_id,
    offerId: r.offer_id,
    fleetSlug: r.fleet_slug,
    originGithubUserId: Number(r.origin_github_user_id),
    executorDevice: r.executor_device,
    rootPath: r.root_path,
    clonePath: r.clone_path,
    sessionId: r.session_id,
    executionEpoch: Number(r.execution_epoch),
    state: r.state as ForeignWorkspaceState,
    parkReason: r.park_reason,
    baseSha: r.base_sha ?? null,
    createdAt: toEpochMs(r.created_at),
    updatedAt: toEpochMs(r.updated_at),
  };
}

/**
 * The host tree root the Q1 invariant measures against. Exported (WI-6680) so
 * the SEEDING side (ensure-host-routines.ts) resolves the workspace root the
 * exact same way the CHECKING side below does — when the two drifted apart the
 * seeder wrote a config every registration then refused, and nothing caught it
 * because each side was self-consistent.
 */
export function resolveHostWorkspaceRoot(): string {
  return process.env.PAPERCUSP_WORKSPACE_ROOT ?? `${process.env.HOME ?? ''}/papercupai-workspace`;
}

/** Is `child` strictly inside (or equal to) `parent`, path-wise? */
function isWithin(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + sep);
}

/**
 * The Q1 BINDING INVARIANT, checked at registration (loud refusal, never a
 * silent mis-placement): the foreign root must be an absolute path that is
 * NOT inside the workspace root (host trees live there) and NOT inside the
 * given canonical tree. Returns null when valid, else the refusal detail.
 */
export function foreignRootInvariantViolation(
  rootPath: string,
  opts: { workspaceRoot: string; canonicalTree?: string },
): string | null {
  if (!isAbsolute(rootPath)) return `foreign root '${rootPath}' is not absolute`;
  if (isWithin(opts.workspaceRoot, rootPath)) {
    return `foreign root '${rootPath}' is inside the workspace root '${opts.workspaceRoot}' — the Q1 invariant places foreign work OUTSIDE every host tree`;
  }
  if (opts.canonicalTree && isWithin(opts.canonicalTree, rootPath)) {
    return `foreign root '${rootPath}' is inside the canonical tree '${opts.canonicalTree}'`;
  }
  return null;
}

export type RegisterResult =
  | { ok: true; workspace: ForeignWorkspace }
  | { ok: false; refusal: { code: 'invariant' | 'conflict'; detail: string } };

/** Register a foreign workspace (P-104 spawn, state 'provisioning'). */
export async function registerForeignWorkspace(
  input: {
    workspaceId: string;
    offerId: string;
    fleetSlug: string;
    originGithubUserId: number;
    executorDevice: string;
    rootPath: string;
    clonePath: string;
    executionEpoch?: number;
    /** Q1 invariant scope (defaults from env for prod; tests inject). */
    workspaceRoot?: string;
    canonicalTree?: string;
  },
  sql: OrgSql = getOrgPg().sql,
): Promise<RegisterResult> {
  const workspaceRoot = input.workspaceRoot ?? resolveHostWorkspaceRoot();
  const canonicalTree = input.canonicalTree ?? process.env.PAPERCUSP_CANONICAL_TREE ?? undefined;
  const violation = foreignRootInvariantViolation(input.rootPath, { workspaceRoot, canonicalTree });
  if (violation) return { ok: false, refusal: { code: 'invariant', detail: violation } };

  try {
    const rows = (await sql`
      INSERT INTO harness_shared.p2p_foreign_workspaces
        (workspace_id, offer_id, fleet_slug, origin_github_user_id,
         executor_device, root_path, clone_path, execution_epoch, state)
      VALUES
        (${input.workspaceId}, ${input.offerId}, ${input.fleetSlug},
         ${input.originGithubUserId}, ${input.executorDevice}, ${input.rootPath},
         ${input.clonePath}, ${input.executionEpoch ?? 0}, 'provisioning')
      RETURNING *
    `) as unknown as Row[];
    return { ok: true, workspace: fromRow(rows[0]) };
  } catch (e) {
    // Duplicate offer or root_path — a real conflict, refused loudly (M21:
    // the offer id is in the detail so the receipt can name it).
    return {
      ok: false,
      refusal: {
        code: 'conflict',
        detail: `register refused for offer ${input.offerId}: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }
}

/** Fetch one workspace by offer id (null = absent → consumers DENY). */
export async function getForeignWorkspace(
  workspaceId: string,
  offerId: string,
  sql: OrgSql = getOrgPg().sql,
): Promise<ForeignWorkspace | null> {
  const rows = (await sql`
    SELECT * FROM harness_shared.p2p_foreign_workspaces
    WHERE workspace_id = ${workspaceId} AND offer_id = ${offerId}
  `) as unknown as Row[];
  return rows.length ? fromRow(rows[0]) : null;
}

/** Resolve the workspace a SESSION is bound to (guard leg i; null → deny-all). */
export async function getForeignWorkspaceForSession(
  sessionId: string,
  sql: OrgSql = getOrgPg().sql,
): Promise<ForeignWorkspace | null> {
  const rows = (await sql`
    SELECT * FROM harness_shared.p2p_foreign_workspaces
    WHERE session_id = ${sessionId}
    LIMIT 1
  `) as unknown as Row[];
  return rows.length ? fromRow(rows[0]) : null;
}

/** List workspaces by state (commit lane: 'active'; reaper: several). */
export async function listForeignWorkspaces(
  workspaceId: string,
  opts: { state?: ForeignWorkspaceState } = {},
  sql: OrgSql = getOrgPg().sql,
): Promise<ForeignWorkspace[]> {
  const rows = (opts.state
    ? await sql`
        SELECT * FROM harness_shared.p2p_foreign_workspaces
        WHERE workspace_id = ${workspaceId} AND state = ${opts.state}
        ORDER BY created_at`
    : await sql`
        SELECT * FROM harness_shared.p2p_foreign_workspaces
        WHERE workspace_id = ${workspaceId}
        ORDER BY created_at`) as unknown as Row[];
  return rows.map(fromRow);
}

/** Record the provision base (mig 470) once the clone lands (leg iv → iii). */
export async function setForeignWorkspaceBaseSha(
  workspaceId: string,
  offerId: string,
  baseSha: string,
  sql: OrgSql = getOrgPg().sql,
): Promise<void> {
  await sql`
    UPDATE harness_shared.p2p_foreign_workspaces
    SET base_sha = ${baseSha}, updated_at = now()
    WHERE workspace_id = ${workspaceId} AND offer_id = ${offerId}
  `;
}

/** One live foreign root for the guard's host-direction policy (leg i). */
export interface ForeignRootEntry {
  offerId: string;
  rootPath: string;
  workspaceId: string;
  fleetSlug: string;
  state: ForeignWorkspaceState;
}

/**
 * Every non-reaped foreign root on this HOST, across all workspaces (the
 * guard protects the host's filesystem — workspace boundaries don't matter
 * to a stray host edit). Parked/winding-down roots stay foreign ground for
 * hosts; only 'reaped' rows drop out.
 */
export async function listLiveForeignRoots(sql: OrgSql = getOrgPg().sql): Promise<ForeignRootEntry[]> {
  const rows = (await sql`
    SELECT workspace_id, offer_id, fleet_slug, root_path, state
    FROM harness_shared.p2p_foreign_workspaces
    WHERE state <> 'reaped'
    ORDER BY created_at
  `) as unknown as Row[];
  return rows.map((r) => ({
    offerId: r.offer_id,
    rootPath: r.root_path,
    workspaceId: r.workspace_id,
    fleetSlug: r.fleet_slug,
    state: r.state as ForeignWorkspaceState,
  }));
}

/** Cross-workspace lookup by offer id (the guard's foreign-session check —
 *  a session presents only its offer id + token, not a workspace). */
export async function getForeignWorkspaceByOffer(
  offerId: string,
  sql: OrgSql = getOrgPg().sql,
): Promise<ForeignWorkspace | null> {
  const rows = (await sql`
    SELECT * FROM harness_shared.p2p_foreign_workspaces
    WHERE offer_id = ${offerId}
    LIMIT 1
  `) as unknown as Row[];
  return rows.length ? fromRow(rows[0]) : null;
}

/** Bind the spawned foreign session + flip provisioning→active (P-104). */
export async function bindForeignSession(
  workspaceId: string,
  offerId: string,
  sessionId: string,
  sql: OrgSql = getOrgPg().sql,
): Promise<ForeignWorkspace | null> {
  const rows = (await sql`
    UPDATE harness_shared.p2p_foreign_workspaces
    SET session_id = ${sessionId}, state = 'active', updated_at = now()
    WHERE workspace_id = ${workspaceId} AND offer_id = ${offerId}
      AND state IN ('provisioning', 'active')
    RETURNING *
  `) as unknown as Row[];
  return rows.length ? fromRow(rows[0]) : null;
}

/** Transition state (wind-down / park / reap). `parkReason` is the loud
 *  breadcrumb (e.g. 'attestation-unresolvable', 'quota-exhausted').
 *  `fromStates` guards the transition: the update only lands when the row is
 *  currently in one of them (null return = absent OR raced elsewhere) — so a
 *  wind-down sweep can never resurrect a row another actor already reaped. */
export async function setForeignWorkspaceState(
  workspaceId: string,
  offerId: string,
  state: ForeignWorkspaceState,
  opts: { parkReason?: string; fromStates?: readonly ForeignWorkspaceState[] } = {},
  sql: OrgSql = getOrgPg().sql,
): Promise<ForeignWorkspace | null> {
  const rows = (await sql`
    UPDATE harness_shared.p2p_foreign_workspaces
    SET state = ${state},
        park_reason = ${opts.parkReason ?? null},
        updated_at = now()
    WHERE workspace_id = ${workspaceId} AND offer_id = ${offerId}
      AND ${opts.fromStates ? sql`state = ANY(${opts.fromStates as string[]}::text[])` : sql`TRUE`}
    RETURNING *
  `) as unknown as Row[];
  return rows.length ? fromRow(rows[0]) : null;
}
