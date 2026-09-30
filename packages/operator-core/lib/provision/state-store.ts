/**
 * Provision state — PG-backed (migration 026).
 *
 * For each (workspace, harness, plugin) tuple we maintain a single row
 * in `harness_shared.provision_state` whose JSONB payload is the full
 * ProvisionState shape. The previous layout used:
 *
 *   <workspace>/harnesses/<slug>/provision/<plugin>/
 *     ├── state.json           authoritative
 *     ├── resources.wal.jsonl  crash-safety shim around state.json
 *     └── audit.log            see audit-log.ts
 *
 * The WAL existed solely to recover a SIGKILL'd setup script's
 * record-of-what-it-created. PG transactions give us the same guarantee
 * natively: each `recordResource` / `setOutput` is a single
 * read-modify-write inside a transaction. No WAL, no compaction, no
 * .tmp + rename dance.
 *
 * `provisionDir` is preserved as a display-path helper (UI surfaces
 * "stored as <path>" without leaking the PG implementation).
 *
 * Spec: /docs/snapshots/build-scripts#partial-failure-rollback.
 */

import { join } from 'node:path';
import { getOrgPg, generated } from '@papercusp/db-org';
import { and, eq, sql as dsql } from 'drizzle-orm';

const t = generated.provisionStateInHarnessShared;

import { papercuspPath } from '../papercusp-root';
import { activeWorkspaceId } from '../workspace-registry';

export interface RecordedResource {
  kind: string;
  externalId: string;
  recordedAt: string; // ISO
  metadata?: Record<string, unknown>;
}

export interface ProvisionState {
  schemaVersion: 1;
  hashes: {
    configHash: string;
    scriptHash: string;
    pluginVersion: string;
  } | null;
  createdResources: RecordedResource[];
  outputs: Record<string, unknown>;
  /** ISO timestamp of the last successful setup. Null if never. */
  lastSetupAt: string | null;
  /** ISO timestamp of the last verify pass. */
  lastVerifyAt: string | null;
  /** True when the last setup attempt failed; UI shows banner. */
  setupFailed: boolean;
  setupError?: string;
}

/**
 * Display path — kept for UI surfaces that show "stored as <path>".
 * Pure path math; no I/O. Real persistence is in PG.
 */
export function provisionDir(harness: string, plugin: string): string {
  return join(papercuspPath('harnesses'), harness, 'provision', plugin);
}

const EMPTY_STATE: ProvisionState = {
  schemaVersion: 1,
  hashes: null,
  createdResources: [],
  outputs: {},
  lastSetupAt: null,
  lastVerifyAt: null,
  setupFailed: false,
};

function emptyState(): ProvisionState {
  return { ...EMPTY_STATE, createdResources: [], outputs: {} };
}

async function readRow(harness: string, plugin: string): Promise<ProvisionState | null> {
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  const rows = await db
    .select({ payload: t.payload })
    .from(t)
    .where(and(eq(t.workspaceId, ws), eq(t.harnessSlug, harness), eq(t.pluginSlug, plugin)))
    .limit(1);
  return (rows[0]?.payload as ProvisionState | undefined) ?? null;
}

async function upsertRow(harness: string, plugin: string, state: ProvisionState): Promise<void> {
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  const now = Date.now();
  await db
    .insert(t)
    .values({ workspaceId: ws, harnessSlug: harness, pluginSlug: plugin, payload: state, updatedAt: now })
    .onConflictDoUpdate({
      target: [t.workspaceId, t.harnessSlug, t.pluginSlug],
      set: { payload: dsql`EXCLUDED.payload`, updatedAt: dsql`EXCLUDED.updated_at` },
    });
}

/**
 * Apply one state mutation while holding the row lock. The insert-before-lock
 * step is required for first writers: SELECT ... FOR UPDATE cannot lock a row
 * that does not exist, so two concurrent first writes would otherwise both
 * start from EMPTY_STATE and one would overwrite the other.
 */
async function updateState(
  harness: string,
  plugin: string,
  mutate: (current: ProvisionState) => ProvisionState,
): Promise<void> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO harness_shared.provision_state
        (workspace_id, harness_slug, plugin_slug, payload, updated_at)
      VALUES (${ws}, ${harness}, ${plugin}, ${JSON.stringify(EMPTY_STATE)}::text::jsonb, ${Date.now()})
      ON CONFLICT (workspace_id, harness_slug, plugin_slug) DO NOTHING
    `;
    const rows = await tx<{ payload: ProvisionState }[]>`
      SELECT payload
        FROM harness_shared.provision_state
       WHERE workspace_id = ${ws} AND harness_slug = ${harness} AND plugin_slug = ${plugin}
       FOR UPDATE
    `;
    const current = rows[0]?.payload ? { ...EMPTY_STATE, ...rows[0].payload } : emptyState();
    const next = mutate(current);
    await tx`
      UPDATE harness_shared.provision_state
         SET payload = ${JSON.stringify(next)}::text::jsonb, updated_at = ${Date.now()}
       WHERE workspace_id = ${ws} AND harness_slug = ${harness} AND plugin_slug = ${plugin}
    `;
  });
}

/**
 * Read state for (harness, plugin), returning the empty state when no
 * row exists. WAL-folding is gone — the row IS the authoritative state.
 */
export async function readState(harness: string, plugin: string): Promise<ProvisionState> {
  const row = await readRow(harness, plugin);
  if (!row) return emptyState();
  return { ...EMPTY_STATE, ...row };
}

export async function writeState(
  harness: string,
  plugin: string,
  state: ProvisionState,
): Promise<void> {
  await upsertRow(harness, plugin, state);
}

/**
 * Append a single resource record to (harness, plugin)'s state. Idempotent
 * on (kind, externalId) — duplicates collapse. Replaces the prior
 * append-to-WAL behavior; the read-modify-write happens inside one row-locked
 * transaction so concurrent writers cannot lose each other's resources.
 */
export async function appendWalEntry(
  harness: string,
  plugin: string,
  entry: RecordedResource,
): Promise<void> {
  await updateState(harness, plugin, (cur) => {
    const k = `${entry.kind}\0${entry.externalId}`;
    const map = new Map<string, RecordedResource>();
    for (const r of cur.createdResources) map.set(`${r.kind}\0${r.externalId}`, r);
    const existing = map.get(k);
    if (existing) {
      map.set(k, { ...existing, ...entry, recordedAt: existing.recordedAt });
    } else {
      map.set(k, entry);
    }
    return { ...cur, createdResources: [...map.values()] };
  });
}

/**
 * Set a key in `state.outputs`. Replaces the prior `state_set` WAL op.
 */
export async function appendStateOutput(
  harness: string,
  plugin: string,
  key: string,
  value: unknown,
): Promise<void> {
  await updateState(harness, plugin, (cur) => ({
    ...cur,
    outputs: { ...cur.outputs, [key]: value },
  }));
}

/**
 * Drop the row for (harness, plugin). Called after teardown completes.
 */
export async function clearState(harness: string, plugin: string): Promise<void> {
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  await db
    .delete(t)
    .where(and(eq(t.workspaceId, ws), eq(t.harnessSlug, harness), eq(t.pluginSlug, plugin)));
}

/**
 * Compatibility shim — the prior in-process plugin host kept a long-lived
 * stream open to the WAL file for high-throughput resource recording. PG's
 * single-call upsert is fast enough that we don't need the streaming
 * abstraction; calls fan out to `appendWalEntry`.
 */
export class WalWriter {
  constructor(private harness: string, private plugin: string) {}
  async open(): Promise<void> {
    /* no-op: PG client is shared and managed elsewhere */
  }
  async write(entry: RecordedResource): Promise<void> {
    await appendWalEntry(this.harness, this.plugin, entry);
  }
  async close(): Promise<void> {
    /* no-op */
  }
}
