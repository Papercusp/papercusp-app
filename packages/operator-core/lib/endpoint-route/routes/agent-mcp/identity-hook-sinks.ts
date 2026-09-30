/**
 * POST /api/agent-mcp/tool-guard
 * POST /api/agent-mcp/stop-context
 * POST /api/agent-mcp/compaction-context
 *
 * The three identity hook ports (portable-identity-packages-2026-09-26 P-011,
 * plan Decisions D-023 + D-024). The client half is the one shared dispatcher
 * (apps/operator/scripts/hooks/inject/, ports.mjs `pre-tool` / `stop` /
 * `compaction`); every response is `{ ok, text }`, and an empty text means the
 * hook emits nothing.
 *
 * ── THE GUARD IS THE ONLY PORT THAT VOTES, AND IT ONLY VOTES NO ──
 * tool-guard's text is a refusal reason, rendered by the adapters ONLY as a deny
 * for the one pending call. Where it fails is decided by what failed (D-023 §3):
 *   - a guard that cannot EVALUATE (a throw, input over the bound, a worn pin
 *     that no longer parses) refuses, naming the identity and rule — that is
 *     `evaluatePreToolGuards`, which is pure and fail-closed;
 *   - the applied artifact being UNREADABLE fails open: no rule can be named,
 *     and closing there would deny every tool call fleet-wide on a DB hiccup.
 *
 * Turn-start and post-tool rules ride the two original ports
 * (turn-start-memory.ts, mid-turn-context.ts); these three cover the sinks
 * those cannot reach.
 */

import { defineTool } from '@papercusp/agent-mcp';
import {
  evaluateHookContextSink,
  evaluatePreToolGuards,
  pgHookTurnStore,
  readAppliedWornRules,
  type GuardVerdict,
  type HookTurnStore,
  type PendingToolCall,
  type WornSyncRules,
} from '../../../agent-identities/sync-hook-rules';

/** Stop and compaction sinks get this long, inside the hook's own 2.5s wall. */
const CONTEXT_SINK_BUDGET_MS = 2000;

/** The SessionStart sources whose context is fresh without question. */
const ALWAYS_FRESH_SOURCES = new Set(['compact', 'clear']);

interface HookBody {
  owner?: string;
  workspace?: string;
  client?: string;
  // pre-tool
  tool?: string;
  input?: unknown;
  inputTruncated?: boolean;
  // compaction
  source?: string;
}

async function readBody(req: Request): Promise<HookBody | null> {
  try {
    const body = (await req.json()) as unknown;
    return body && typeof body === 'object' ? (body as HookBody) : null;
  } catch {
    return null;
  }
}

async function resolveWorkspace(body: HookBody): Promise<string> {
  const workspace = (body.workspace ?? '').trim();
  if (workspace && workspace !== '*') return workspace;
  const { activeWorkspaceId } = await import('../../../workspace-registry');
  return activeWorkspaceId();
}

const empty = (): Response => Response.json({ ok: true, text: '' });

/**
 * One context sink under the port's wall. The wall covers the wearer and
 * worn-rule reads too, not only the evaluation the signal reaches, so a slow
 * read degrades to no text inside the hook's own timeout.
 */
async function boundedContextSinkText(input: { ownerId: string; workspaceId: string; sink: 'stop' | 'compaction' }): Promise<string> {
  const { withBoundedTimeout } = await import('../../../bounded-timeout');
  const bounded = await withBoundedTimeout(
    (signal) => evaluateHookContextSink({ ...input, signal }),
    { fallback: { text: '', result: null }, timeoutMs: CONTEXT_SINK_BUDGET_MS, label: `identity-hook:${input.sink}` },
  );
  return bounded.value.text;
}

/** The refusal a client shows for a deny verdict; empty for no verdict. */
export function guardRefusalText(verdict: GuardVerdict): string {
  if (verdict.decision !== 'deny') return '';
  return `Refused by identity ${verdict.identityId} rule ${verdict.ruleId}: ${verdict.reason}`;
}

/**
 * The guard verdict for one pending call. Never throws: an unreadable applied
 * artifact is no verdict (fail open), while a guard that cannot evaluate is
 * already a named refusal inside `evaluatePreToolGuards`.
 */
export async function toolGuardText(
  input: { ownerId: string; workspaceId: string; call: PendingToolCall },
  readWornRules: (ownerId: string, workspaceId: string) => Promise<WornSyncRules | null> = readAppliedWornRules,
): Promise<string> {
  let worn: WornSyncRules | null;
  try {
    worn = await readWornRules(input.ownerId, input.workspaceId);
  } catch {
    return '';
  }
  if (!worn) return '';
  return guardRefusalText(evaluatePreToolGuards(worn, input.call));
}

/**
 * Whether a SessionStart opens a fresh context the compaction rules should
 * re-seed. compact and clear always do. startup does only for an owner that has
 * taken a hook turn before — a respawned session on a carry document — never a
 * first launch (D-024 §3). An unreadable turn store is no signal.
 */
export async function compactionSinkDue(
  input: { ownerId: string; workspaceId: string; source: string },
  turns: Pick<HookTurnStore, 'exists'> = pgHookTurnStore(),
): Promise<boolean> {
  if (ALWAYS_FRESH_SOURCES.has(input.source)) return true;
  if (input.source !== 'startup') return false;
  try {
    return await turns.exists(input.ownerId, input.workspaceId);
  } catch {
    return false;
  }
}

const toolGuard = defineTool({
  method: 'POST',
  path: '/agent-mcp/tool-guard',
  auth: 'loopback',
  async handler(req) {
    const body = await readBody(req);
    const ownerId = (body?.owner ?? '').trim();
    const tool = typeof body?.tool === 'string' ? body.tool : '';
    if (!body || !ownerId || !tool) return empty();
    const text = await toolGuardText({
      ownerId,
      workspaceId: await resolveWorkspace(body),
      call: {
        tool,
        input: body.inputTruncated === true ? null : body.input ?? null,
        client: typeof body.client === 'string' ? body.client : '',
        ...(body.inputTruncated === true ? { inputTruncated: true } : {}),
      },
    });
    return Response.json({ ok: true, text });
  },
});

const stopContext = defineTool({
  method: 'POST',
  path: '/agent-mcp/stop-context',
  auth: 'loopback',
  async handler(req) {
    const body = await readBody(req);
    const ownerId = (body?.owner ?? '').trim();
    if (!body || !ownerId) return empty();
    const text = await boundedContextSinkText({ ownerId, workspaceId: await resolveWorkspace(body), sink: 'stop' });
    return Response.json({ ok: true, text });
  },
});

const compactionContext = defineTool({
  method: 'POST',
  path: '/agent-mcp/compaction-context',
  auth: 'loopback',
  async handler(req) {
    const body = await readBody(req);
    const ownerId = (body?.owner ?? '').trim();
    const source = typeof body?.source === 'string' ? body.source : '';
    if (!body || !ownerId || !source) return empty();
    const workspaceId = await resolveWorkspace(body);
    if (!(await compactionSinkDue({ ownerId, workspaceId, source }))) return empty();
    const text = await boundedContextSinkText({ ownerId, workspaceId, sink: 'compaction' });
    return Response.json({ ok: true, text });
  },
});

export default [toolGuard, stopContext, compactionContext];
