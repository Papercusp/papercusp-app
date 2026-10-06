/**
 * memory:get — read memories BY ID (WI-10004550).
 *
 * Measured 2026-10-01 (tool_invocations, 72h): 185 `unknown_tool` calls to a `memory:get`
 * that did not exist, from 40 distinct owners. The demand is structural, not typo noise:
 * every other family has a by-id `<family>:get` (work_items:get, plans:get, docs:get), and
 * the mid-turn / orient memory injections print `(id=<uuid>) … memory:search the id above
 * for the rest` — an id an agent can only follow with a by-id read, which semantic
 * `memory:search` was never built to answer.
 *
 * Reuse-first: this is a thin wrapper over the backend seam's existing `get(id)` (the same
 * call memory:forget / memory:update use for their preflight) and the shared `toWireRow`
 * wire shape — no new storage, no new backend method.
 *
 * ISOLATION mirrors memory:list's scope construction: a row is returned only when it lives
 * in the caller's OWN user pool or a harness/hive pool (the pools memory:list serves on
 * request). A row in ANOTHER user's pool is reported exactly like an unknown id — `missing`
 * — so the tool is never an existence oracle for someone else's memory.
 *
 * RESPONSE CONTRACT: { ok, reason?, results: [{ id, memory, metadata }], missing: [id] }.
 * Degraded-never-silent: a store problem yields { ok:false, reason, results:[], missing:[] }.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { getMemoryBackend, MemoryUnavailableError, type MemoryEntry } from '../../memory/backend';
import { MemoryTimeoutError, withMemoryToolTimeout } from '../../memory/op-deadline';
import { getSessionUserOrDefault } from '../../auth';
import { loadHarnessRegistry } from '../../harness-registry';
import { hiveScopeKey, narrowHarnessSlugsToSessionHive, potSlugsForHarnesses } from '../../memory/hive-scope';
import { isMemoryWorkspaceScopedRecallOn, keepUserPoolHitForWorkspace } from '../../memory/workspace-scope-recall';
import { systemDistinctId } from '../../flag-distinct-id';
import { toWireRow } from './search';

/**
 * Resolve only the harness and hive pools visible to this session's workspace.
 * A by-id backend lookup is global, so the returned row must be checked against
 * the same registry-derived pool set as workspace memory recall before it is sent.
 */
async function workspaceReadableScopes(
  workspaceId: string | undefined,
  sessionHarness: string | null | undefined,
): Promise<ReadonlySet<string>> {
  if (!workspaceId) return new Set();
  try {
    const registry = await loadHarnessRegistry(workspaceId);
    let harnessSlugs = registry.projects.map((project) => project.slug);
    try {
      if (await getFlag(FLAGS.SCOPED_SUPERUSER_CLAMP, systemDistinctId())) {
        harnessSlugs = narrowHarnessSlugsToSessionHive(registry.projects, harnessSlugs, sessionHarness);
      }
    } catch {
      // Match memory:search's existing fail-open behavior for a flag-service outage.
    }
    return new Set([
      ...harnessSlugs.map((slug) => `harness:${slug}`),
      ...potSlugsForHarnesses(registry.projects, harnessSlugs).map(hiveScopeKey),
    ]);
  } catch {
    // Without the workspace registry, fail closed for shared pools. User-pool
    // rows remain independently checked below.
    return new Set();
  }
}

function isReadableRow(
  row: MemoryEntry,
  userId: string,
  activeWorkspaceId: string | undefined,
  workspaceScopedRecall: boolean,
  workspaceScopes: ReadonlySet<string>,
): boolean {
  if (row.scope === userId) {
    return !workspaceScopedRecall || keepUserPoolHitForWorkspace(row, activeWorkspaceId);
  }
  return workspaceScopes.has(row.scope);
}

function mergeIds(id: string | undefined, ids: string[] | undefined): string[] {
  return [...new Set([...(id ? [id] : []), ...(ids ?? [])])];
}

export default defineTool({
  name: 'memory:get',
  capability: 'memory:read',
  description:
    'Read one or more memories by id (1–50). Returns each memory with its metadata; ids that do not exist (or are not yours) come back in `missing`.',
  guidance: {
    when:
      'You hold a memory id — from a `(id=…)` injection, memory:search/list output, or a work-item — and need its FULL text or metadata (injections truncate bodies). Superseded and soft-forgotten rows are returned too, with `metadata.validity`.',
    notWhen: 'You do not have an id — use memory:search (semantic) or memory:list (filter-only).',
    chaining:
      'memory:search → memory:get { id } for the full body → memory:update / memory:remember { supersede:<id> } / memory:forget.',
    seeAlso: [
      'memory:search (find a memory by meaning)',
      'memory:list (filter-only lookup by kind / harness)',
      'memory:update (amend the memory you read)',
    ],
  },
  // The memory store is cross-workspace by design (scoped by user-id / harness-slug, not by
  // workspace; the handler reads getMemoryBackend, never ctx.tx) — same as memory:list/search.
  crossWorkspace: true,
  args: z
    .object({
      id: z.string().uuid('Memory ID must be a valid UUID').optional().describe('a single memory UUID (n=1 shorthand for ids:[id])'),
      ids: z.array(z.string().uuid('Memory ID must be a valid UUID')).min(1).max(50).optional().describe('memory UUIDs to read (1–50)'),
    })
    .refine((a) => Boolean(a.id) || (a.ids?.length ?? 0) > 0, { message: 'pass `id` (one) or `ids` (many)' }),
  async handler(args, ctx) {
    const user = await getSessionUserOrDefault();
    const backend = getMemoryBackend();
    const activeWorkspaceId = ctx.principal?.workspaceId;
    const ids = mergeIds(args.id, args.ids);
    const reply = (body: Record<string, unknown>) => ({ data: body });

    try {
      const avail = await withMemoryToolTimeout(backend.available(), 'memory:get available');
      if (!avail.ok) return reply({ ok: false, reason: avail.reason, results: [], missing: [] });

      const rows = await Promise.all(ids.map((id) => withMemoryToolTimeout(backend.get(id), 'memory:get get')));
      const hasSharedPoolRows = rows.some((row) => row && row.scope !== user.id);
      const hasUserPoolRows = rows.some((row) => row?.scope === user.id);
      const [sharedScopes, workspaceScopedRecall] = await Promise.all([
        hasSharedPoolRows
          ? workspaceReadableScopes(activeWorkspaceId, ctx.harnessSlug)
          : Promise.resolve(new Set<string>() as ReadonlySet<string>),
        hasUserPoolRows ? isMemoryWorkspaceScopedRecallOn() : Promise.resolve(false),
      ]);
      const results: ReturnType<typeof toWireRow>[] = [];
      const missing: string[] = [];
      rows.forEach((row, i) => {
        if (row && isReadableRow(row, user.id, activeWorkspaceId, workspaceScopedRecall, sharedScopes)) results.push(toWireRow(row));
        else missing.push(ids[i]!);
      });
      return reply({ ok: true, results, missing });
    } catch (err) {
      // Degraded-never-silent, same contract as memory:list/search: a store problem returns
      // the { ok:false, reason } envelope, never a raw 500 and never a silent empty { ok:true }.
      if (err instanceof MemoryTimeoutError) return reply({ ok: false, reason: 'memory_timeout', results: [], missing: [] });
      if (err instanceof MemoryUnavailableError) return reply({ ok: false, reason: err.reason, results: [], missing: [] });
      throw err;
    }
  },
});
