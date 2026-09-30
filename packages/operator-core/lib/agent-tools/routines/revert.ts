/**
 * routines:revert — restore a routine from the durable audit row emitted by
 * routines:set. The audit row is the serializable replacement for the
 * in-process closure that cannot cross the MCP boundary.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { activeWorkspaceId } from '../../workspace-registry';
import { runControlMutation } from '../../gateway-control/control-harness';
import {
  parseRoutineSnap,
  readRoutineSnap,
  stableJson,
  writeRoutineSnap,
  type RoutineSnap,
} from './routine-snapshot';

const ROUTINES_SET_AUDIT_ACTION = 'gateway-control.routines:set';

interface AuditRow {
  action: string;
  subject: string;
  details: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const MISSING = Symbol('missing');
const BLOCKED = Symbol('blocked');
type Path = readonly string[];
type PathValue = unknown | typeof MISSING | typeof BLOCKED;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathValuesEqual(left: PathValue, right: PathValue): boolean {
  if (left === MISSING || right === MISSING || left === BLOCKED || right === BLOCKED) {
    return left === right;
  }
  return JSON.stringify(stableJson(left)) === JSON.stringify(stableJson(right));
}

/**
 * Return the paths owned by the audited mutation. A routines:set audit stores
 * complete snapshots, but health writers may advance unrelated metadata between
 * the set and its revert. Diffing recursively lets revert guard and restore only
 * fields the source mutation actually changed instead of treating that metadata
 * churn as a conflicting config write.
 */
function collectOwnedPaths(
  before: PathValue,
  after: PathValue,
  path: string[],
  out: string[][],
): void {
  if (before === MISSING || after === MISSING) {
    const present = before === MISSING ? after : before;
    if (isRecord(present)) {
      const keys = Object.keys(present);
      if (keys.length === 0) {
        out.push(path);
      } else {
        for (const key of keys) collectOwnedPaths(MISSING, present[key], [...path, key], out);
      }
      return;
    }
    out.push(path);
    return;
  }

  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const beforeHas = Object.prototype.hasOwnProperty.call(before, key);
      const afterHas = Object.prototype.hasOwnProperty.call(after, key);
      collectOwnedPaths(
        beforeHas ? before[key] : MISSING,
        afterHas ? after[key] : MISSING,
        [...path, key],
        out,
      );
    }
    return;
  }

  if (isRecord(before) || isRecord(after)) {
    out.push(path);
    return;
  }

  if (!pathValuesEqual(before, after)) out.push(path);
}

function ownedPathsBetween(before: RoutineSnap, after: RoutineSnap): string[][] {
  const paths: string[][] = [];
  collectOwnedPaths(before, after, [], paths);
  return paths;
}

function valueAtPath(root: unknown, path: Path): PathValue {
  let current: unknown = root;
  for (const key of path) {
    if (!isRecord(current)) return BLOCKED;
    if (!Object.prototype.hasOwnProperty.call(current, key)) return MISSING;
    current = current[key];
  }
  return current;
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneJson(entry)]));
  }
  return value;
}

function setPath(root: Record<string, unknown>, path: Path, value: unknown): void {
  if (path.length === 0) return;
  let current = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]!;
    if (!isRecord(current[key])) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[path[path.length - 1]!] = value;
}

function deletePath(root: Record<string, unknown>, path: Path): void {
  if (path.length === 0) return;
  let current: unknown = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    if (!isRecord(current)) return;
    if (!Object.prototype.hasOwnProperty.call(current, path[index]!)) return;
    current = current[path[index]!];
  }
  if (!isRecord(current)) return;
  delete current[path[path.length - 1]!];

  // Do not leave empty containers created solely by an owned nested field
  // deletion, but retain the required top-level snapshot objects.
  for (let index = path.length - 2; index >= 1; index -= 1) {
    const node = valueAtPath(root, path.slice(0, index + 1));
    if (!isRecord(node) || Object.keys(node).length !== 0) break;
    const parent = valueAtPath(root, path.slice(0, index));
    if (!isRecord(parent)) break;
    delete parent[path[index]!];
  }
}

function ownedFieldsEqual(
  left: RoutineSnap,
  right: RoutineSnap,
  ownedPaths: readonly Path[],
): boolean {
  return ownedPaths.every((path) => pathValuesEqual(valueAtPath(left, path), valueAtPath(right, path)));
}

function mergeOwnedFields(
  current: RoutineSnap,
  restore: RoutineSnap,
  ownedPaths: readonly Path[],
): RoutineSnap {
  const merged = cloneJson(current) as RoutineSnap;
  const mutable = merged as unknown as Record<string, unknown>;
  for (const path of ownedPaths) {
    const value = valueAtPath(restore, path);
    if (value === MISSING || value === BLOCKED) {
      deletePath(mutable, path);
    } else {
      setPath(mutable, path, cloneJson(value));
    }
  }
  return merged;
}

/** Reconcile a possibly completed/partially restored mutation without reverting
 * unrelated writes. A third value on any owned path remains a real conflict. */
export function reconcileRoutineRestore(current: RoutineSnap, restore: RoutineSnap, auditedNext: RoutineSnap): RoutineSnap {
  const paths = ownedPathsBetween(restore, auditedNext);
  for (const path of paths) {
    const value = valueAtPath(current, path);
    if (!pathValuesEqual(value, valueAtPath(auditedNext, path)) &&
        !pathValuesEqual(value, valueAtPath(restore, path))) {
      throw new Error(`routine changed after audit at ${path.join('.')}; refusing to overwrite the newer state`);
    }
  }
  return mergeOwnedFields(current, restore, paths);
}

/** Shared audited operation for the tool and a standalone driver's cleanup.
 * The driver must be able to restore even while the operator HTTP host is down. */
export async function revertRoutineAudit(
  args: { auditId: string; dryRun?: boolean },
  deps: { sql: Sql; workspaceId: string; actor: string },
) {
  const { sql, workspaceId } = deps;
  const rows = await sql<AuditRow[]>`
    SELECT action, subject, details FROM harness_shared.audit_log
     WHERE workspace_id = ${workspaceId} AND id = ${args.auditId} LIMIT 1`;
  const row = rows[0];
  if (!row) throw new Error(`routines:set audit not found: ${args.auditId}`);
  if (row.action !== ROUTINES_SET_AUDIT_ACTION) throw new Error(`audit ${args.auditId} is not a routines:set mutation`);
  const subject = splitRoutineSubject(row.subject);
  if (!subject) throw new Error(`routines:set audit ${args.auditId} has an invalid subject`);
  const details = asRecord(row.details);
  const restore = parseRoutineSnap(details?.prev);
  const auditedNext = parseRoutineSnap(details?.next);
  if (!restore || !auditedNext) throw new Error(`routines:set audit ${args.auditId} has no valid complete routine snapshot`);
  const ownedPaths = ownedPathsBetween(restore, auditedNext);
  const readSnap = () => readRoutineSnap(sql, workspaceId, subject.installSlug, subject.name);
  const writeSnap = (snap: RoutineSnap) => writeRoutineSnap(sql, workspaceId, subject.installSlug, subject.name, snap);
  const outcome = await runControlMutation<RoutineSnap>({
    action: 'routines:set:revert', subject: row.subject, actor: deps.actor, revertOf: args.auditId,
    capturePrev: readSnap,
    apply: async () => {
      const merged = reconcileRoutineRestore(await readSnap(), restore, auditedNext);
      await writeSnap(merged);
      return merged;
    },
    revertTo: async (prev) => { await writeSnap(mergeOwnedFields(await readSnap(), prev, ownedPaths)); },
    verify: async (next) => {
      const ok = ownedFieldsEqual(await readSnap(), next, ownedPaths);
      return { ok, detail: ok ? undefined : 'routine row did not reflect the restored snapshot' };
    },
    describe: (current) => ({ auditId: args.auditId, current, restore, proposed: reconcileRoutineRestore(current, restore, auditedNext) }),
  }, { dryRun: args.dryRun });
  return {
    ok: true, routine: row.subject, sourceAuditId: args.auditId, dryRun: outcome.dryRun,
    applied: outcome.applied, reverted: outcome.reverted, preview: outcome.preview,
    verify: outcome.verify, auditId: outcome.auditId,
  };
}

function splitRoutineSubject(subject: string): { installSlug: string; name: string } | null {
  const slash = subject.indexOf('/');
  if (slash <= 0 || slash === subject.length - 1) return null;
  return { installSlug: subject.slice(0, slash), name: subject.slice(slash + 1) };
}

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

export default defineTool({
  name: 'routines:revert',
  profile: 'engineer',
  description:
    'Restore a routine exactly to the prior state captured by a routines:set audit id. Pass the serializable handle returned by routines:set (or its auditId). Refuses malformed/non-routines:set audit rows and refuses to overwrite a newer routine change.',
  capability: 'operator:write',
  guidance: {
    when: 'Undo a routines:set mutation using its returned revertHandle or auditId, restoring trigger_config, payload_template, active, next_fire_at, group, and metadata together.',
    notWhen: 'To make a new routine change use routines:set. Do not use a stale audit id after another routine change; this tool refuses when the current row no longer matches the audited next snapshot.',
    chaining: 'Use the revertHandle returned by routines:set; routines:list confirms the exact routine state after the revert.',
    seeAlso: ['routines:set (make a new audited routine change)', 'routines:list (confirm the restored state)'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.object({
    auditId: z.string().min(1).max(200).describe('Audit id or revertHandle.args.auditId returned by routines:set.'),
    dryRun: z.boolean().optional().describe('Preview the exact restore without applying it or writing a new audit row.'),
  }),
  async handler(args, ctx) {
    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('routines:revert requires operator, architect, or mug role');
    }

    return json(await revertRoutineAudit(args, {
      sql: getOrgPg().sql, workspaceId: activeWorkspaceId(), actor: `role:${ctx.role}`,
    }));
  },
});
