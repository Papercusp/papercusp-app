/**
 * local-backend-store — durable PG registry for the LOCAL inference-backend pool
 * (local-concurrent-inference-2026-07-02 P-004, D-002). Mirrors the account-pool's
 * "DB is the source of truth, the gateway hot-reloads from it" model
 * (harness_shared.local_backends, migration 445) so a `llama-server` / `vllm` /
 * `ollama` backend registered here applies to the RUNNING gateway via
 * gateway:reload — no restart, same mechanism a Claude/Codex account uses.
 *
 * This module owns ONLY the durable registry (CRUD). Live state — health,
 * in-flight counts, least-loaded selection — is process-local gateway state
 * owned by local-backend-pool.ts, which is fed FROM this store's `list()` on
 * startup + every hot-reload tick.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';

export const LOCAL_BACKEND_KINDS = ['llama-server', 'vllm', 'ollama'] as const;
export type LocalBackendKind = (typeof LOCAL_BACKEND_KINDS)[number];

export const LOCAL_BACKEND_LIFECYCLES = ['always-on', 'on-demand'] as const;
/** How a backend's PROCESS is managed (migration 843, plan D-005).
 *  - 'always-on': start it and leave it resident. The pre-843 behaviour, and the default.
 *  - 'on-demand': the idle-reaper may stop it once idle past `idleTtlSec`; the gateway starts
 *                 it again on a request routed to it. */
export type LocalBackendLifecycle = (typeof LOCAL_BACKEND_LIFECYCLES)[number];

export interface LocalBackendRecord {
  id: string;
  kind: LocalBackendKind;
  baseUrl: string;
  models: string[];
  maxConcurrent: number;
  enabled: boolean;
  lifecycle: LocalBackendLifecycle;
  /** Idle seconds before an on-demand backend is reapable. `null` ⇒ the reaper's own default. */
  idleTtlSec: number | null;
  /** The systemd --user unit that OWNS this backend's process, e.g. `llama-ornith.service`.
   *
   *  ⚠ This is NOT derivable from `baseUrl`, and assuming it is will stop the wrong process.
   *  Measured on this box: `ornith-llamaserver` has baseUrl `http://127.0.0.1:11435`, which is
   *  the always-on `ollama-schema-proxy.service`; the GPU-resident llama-server it forwards to
   *  is `llama-ornith.service` on :11436. "Stop whatever serves baseUrl" would kill the cheap
   *  proxy and leave the 19.8GB process resident. */
  unitName: string | null;
  /** Idle-reaper watermark (migration 845): the most recent moment this backend was OBSERVED
   *  doing work, or was started/registered. The reaper stops a backend when
   *  `now - lastBusyAt > idleTtlSec` — never on a single idle sample, which would stop a
   *  backend in the gap between two requests. */
  lastBusyAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterLocalBackendInput {
  id: string;
  kind: LocalBackendKind;
  baseUrl: string;
  models: string[];
  maxConcurrent?: number;
  enabled?: boolean;
  /** Defaults to 'always-on' — so a caller written before migration 843 registers exactly the
   *  behaviour it always did, and no backend becomes reapable by accident. */
  lifecycle?: LocalBackendLifecycle;
  idleTtlSec?: number | null;
  unitName?: string | null;
  workspaceId?: string;
}

function sqlOf(inject?: Sql): Sql {
  return inject ?? getOrgPg().sql;
}

/** Validate register input. Returns an error string or null (pure — no I/O). */
export function validateLocalBackendInput(input: {
  id?: string;
  kind?: string;
  baseUrl?: string;
  models?: unknown;
  maxConcurrent?: number;
  lifecycle?: string;
  idleTtlSec?: number | null;
  unitName?: string | null;
}): string | null {
  if (!input.id?.trim()) return 'id is required';
  if (!input.kind || !(LOCAL_BACKEND_KINDS as readonly string[]).includes(input.kind)) {
    return `kind must be one of ${LOCAL_BACKEND_KINDS.join('|')}`;
  }
  if (!input.baseUrl?.trim()) return 'baseUrl is required';
  try {
    const u = new URL(input.baseUrl);
    if (!/^https?:$/.test(u.protocol)) return `baseUrl must be http(s) — got '${u.protocol}'`;
  } catch {
    return `baseUrl is not a valid URL: '${input.baseUrl}'`;
  }
  if (!Array.isArray(input.models) || input.models.length === 0 || !input.models.every((m) => typeof m === 'string' && m.trim())) {
    return 'models must be a non-empty array of model id strings';
  }
  if (input.maxConcurrent !== undefined && (!Number.isFinite(input.maxConcurrent) || input.maxConcurrent <= 0)) {
    return 'maxConcurrent must be a positive number';
  }
  // The three rules below mirror migration 843's CHECK constraints. They are duplicated here on
  // purpose: the DB is the real enforcement (nothing can write around it), but a caller that hits
  // a raw PG constraint violation gets a stack trace instead of a sentence, and the third rule in
  // particular describes a mistake worth naming explicitly.
  if (input.lifecycle !== undefined && !(LOCAL_BACKEND_LIFECYCLES as readonly string[]).includes(input.lifecycle)) {
    return `lifecycle must be one of ${LOCAL_BACKEND_LIFECYCLES.join('|')}`;
  }
  if (
    input.idleTtlSec !== undefined &&
    input.idleTtlSec !== null &&
    (!Number.isFinite(input.idleTtlSec) || input.idleTtlSec <= 0)
  ) {
    return 'idleTtlSec must be a positive number of seconds';
  }
  if (input.lifecycle === 'on-demand' && !input.unitName?.trim()) {
    return "lifecycle 'on-demand' requires unitName — the systemd unit to stop and start. Without it the backend would be marked reapable while the reaper has nothing to act on, which looks armed and silently does nothing.";
  }
  return null;
}

/** Upsert a backend registration by id. */
export async function registerLocalBackend(input: RegisterLocalBackendInput, inject?: Sql): Promise<LocalBackendRecord> {
  const err = validateLocalBackendInput(input);
  if (err) throw new Error(`local-backend-store: ${err}`);
  const sql = sqlOf(inject);
  const ws = input.workspaceId ?? activeWorkspaceId();
  const id = input.id.trim();
  const baseUrl = input.baseUrl.trim().replace(/\/$/, '');
  const models = input.models.map((m) => m.trim()).filter(Boolean);
  const maxConcurrent = input.maxConcurrent && input.maxConcurrent > 0 ? Math.floor(input.maxConcurrent) : 4;
  const enabled = input.enabled ?? true;
  const lifecycle = input.lifecycle ?? 'always-on';
  const idleTtlSec = input.idleTtlSec ?? null;
  const unitName = input.unitName?.trim() || null;
  const rows = await sql<LocalBackendRow[]>`
    INSERT INTO harness_shared.local_backends
      (id, workspace_id, kind, base_url, models, max_concurrent, enabled, lifecycle, idle_ttl_sec, unit_name)
    VALUES
      (${id}, ${ws}, ${input.kind}, ${baseUrl}, ${JSON.stringify(models)}::text::jsonb, ${maxConcurrent}, ${enabled},
       ${lifecycle}, ${idleTtlSec}, ${unitName})
    ON CONFLICT (id) DO UPDATE SET
      workspace_id   = EXCLUDED.workspace_id,
      kind           = EXCLUDED.kind,
      base_url       = EXCLUDED.base_url,
      models         = EXCLUDED.models,
      max_concurrent = EXCLUDED.max_concurrent,
      enabled        = EXCLUDED.enabled,
      lifecycle      = EXCLUDED.lifecycle,
      idle_ttl_sec   = EXCLUDED.idle_ttl_sec,
      unit_name      = EXCLUDED.unit_name,
      updated_at     = now()
    RETURNING id, kind, base_url, models, max_concurrent, enabled,
              lifecycle, idle_ttl_sec, unit_name, last_busy_at::text,
              created_at::text, updated_at::text`;
  return rowToRecord(rows[0]);
}

/** List backends for a workspace (default: the active workspace). Includes disabled ones —
 *  callers that need only the live/routable set should filter on `.enabled`. */
export async function listLocalBackends(opts: { workspaceId?: string } = {}, inject?: Sql): Promise<LocalBackendRecord[]> {
  const sql = sqlOf(inject);
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const rows = await sql<LocalBackendRow[]>`
    SELECT id, kind, base_url, models, max_concurrent, enabled,
           lifecycle, idle_ttl_sec, unit_name, last_busy_at::text,
           created_at::text, updated_at::text
      FROM harness_shared.local_backends
     WHERE workspace_id = ${ws}
     ORDER BY id`;
  return rows.map(rowToRecord);
}

/** The enabled on-demand backends — the idle-reaper's working set (P-007). Served by the
 *  `local_backends_on_demand` partial index. Deliberately a store-level query rather than
 *  `listLocalBackends().filter(...)`: the reaper polls, and the filtered set is normally a
 *  handful of rows out of a table every gateway hot-reload reads in full. */
export async function listOnDemandLocalBackends(
  opts: { workspaceId?: string } = {},
  inject?: Sql,
): Promise<LocalBackendRecord[]> {
  const sql = sqlOf(inject);
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const rows = await sql<LocalBackendRow[]>`
    SELECT id, kind, base_url, models, max_concurrent, enabled,
           lifecycle, idle_ttl_sec, unit_name, last_busy_at::text,
           created_at::text, updated_at::text
      FROM harness_shared.local_backends
     WHERE workspace_id = ${ws} AND enabled AND lifecycle = 'on-demand'
     ORDER BY id`;
  return rows.map(rowToRecord);
}

/**
 * Stamp a backend's idle watermark to now — "this backend was observed doing work" (P-007).
 *
 * Called by the idle-reaper on every poll that finds a slot processing, and by the
 * ensure-running path when it starts a backend (so a cold-started backend is not reapable
 * before it has had the chance to serve anything).
 *
 * Deliberately does NOT touch `updated_at`: that column means "the registration changed", and a
 * backend merely being busy is not a change to its registration. Conflating them would make
 * `updated_at` useless for spotting real config drift, and would churn a row every poll.
 *
 * Returns whether a row was stamped — `false` means no such backend in this workspace, which a
 * caller iterating a list it just read should treat as a row deleted underneath it, not an error.
 */
export async function markLocalBackendBusy(
  id: string,
  opts: { workspaceId?: string; at?: Date } = {},
  inject?: Sql,
): Promise<boolean> {
  const sql = sqlOf(inject);
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const rows = await sql<{ id: string }[]>`
    UPDATE harness_shared.local_backends
       SET last_busy_at = ${opts.at ?? new Date()}
     WHERE id = ${id.trim()} AND workspace_id = ${ws}
    RETURNING id`;
  return rows.length > 0;
}

/** Remove a backend registration by id. Returns whether a row was deleted. */
export async function removeLocalBackend(id: string, opts: { workspaceId?: string } = {}, inject?: Sql): Promise<boolean> {
  const sql = sqlOf(inject);
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const rows = await sql<{ id: string }[]>`
    DELETE FROM harness_shared.local_backends
     WHERE id = ${id.trim()} AND workspace_id = ${ws}
    RETURNING id`;
  return rows.length > 0;
}

/** Enable/disable a backend without touching its other fields (a soft take-out-of-rotation,
 *  distinct from removing it — e.g. parking ollama's registry row while llama-server serves). */
export async function setLocalBackendEnabled(
  id: string,
  enabled: boolean,
  opts: { workspaceId?: string } = {},
  inject?: Sql,
): Promise<LocalBackendRecord | null> {
  const sql = sqlOf(inject);
  const ws = opts.workspaceId ?? activeWorkspaceId();
  const rows = await sql<LocalBackendRow[]>`
    UPDATE harness_shared.local_backends
       SET enabled = ${enabled}, updated_at = now()
     WHERE id = ${id.trim()} AND workspace_id = ${ws}
    RETURNING id, kind, base_url, models, max_concurrent, enabled,
              lifecycle, idle_ttl_sec, unit_name, last_busy_at::text,
              created_at::text, updated_at::text`;
  return rows[0] ? rowToRecord(rows[0]) : null;
}

interface LocalBackendRow {
  id: string;
  kind: LocalBackendKind;
  base_url: string;
  models: unknown;
  max_concurrent: number;
  enabled: boolean;
  lifecycle: string;
  idle_ttl_sec: number | null;
  unit_name: string | null;
  last_busy_at: string;
  created_at: string;
  updated_at: string;
}

function rowToRecord(r: LocalBackendRow): LocalBackendRecord {
  const models = Array.isArray(r.models) ? (r.models as unknown[]).filter((m): m is string => typeof m === 'string') : [];
  return {
    id: r.id,
    kind: r.kind,
    baseUrl: r.base_url,
    models,
    maxConcurrent: r.max_concurrent,
    enabled: r.enabled,
    // Narrow defensively rather than casting: the CHECK constraint makes an out-of-domain value
    // unreachable through this store, but a hand-run UPDATE or a future migration could still
    // widen it, and 'always-on' is the safe reading — it makes a backend NOT reapable.
    lifecycle: (LOCAL_BACKEND_LIFECYCLES as readonly string[]).includes(r.lifecycle)
      ? (r.lifecycle as LocalBackendLifecycle)
      : 'always-on',
    idleTtlSec: r.idle_ttl_sec ?? null,
    unitName: r.unit_name ?? null,
    lastBusyAt: r.last_busy_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
