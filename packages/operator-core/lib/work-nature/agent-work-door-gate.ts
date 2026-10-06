/**
 * The agent-work gate at the work_items WRITE doors (enterprise-data-sources-2026-10-01
 * D-035, WI-10005358).
 *
 * D-024 made the by-id claim refuse a row that is not agent work by CATEGORY (nature
 * 'work' AND audience 'agent'). The two other doors that act on a row by id —
 * work_items:set_state and work_items:complete — never checked it, so an agent holding a
 * record, document, event or human-audience row's id could work that row without ever
 * claiming it. A real-model run of the S36 drain scenario did exactly that (test_runs
 * 20493622).
 *
 * This is the ONE place both doors ask the question, and it asks it with the claim's own
 * lookup ({@link readNonAgentWorkCategory}, which applies the same SQL function as the
 * claim UPDATE). So the doors and the claim cannot disagree about what agent work is.
 *
 * There is deliberately no override argument: the refusal is a category fact about the row
 * that waiting or retrying cannot change. If a legitimate agent-door caller of non-agent
 * rows turns up, raise it to the plan leader before adding any bypass (D-035).
 *
 * The ONE exemption (D-038, WI-10005369): the human owner acting through the desktop UI.
 * The owner's Queue actions (plans-api.ts closeWorkItem / clearWorkItemOwnerGate) reach
 * work_items:set_state through the palette bridge, and a human-audience row is exactly the
 * row its owner acts on. The exemption keys ONLY on caller identity the SERVER derived
 * ({@link isOwnerUiCaller}), never on a tool argument, a request header or `uiClientId`,
 * all of which a caller can supply. Every agent caller is still refused.
 *
 * Failure semantics: a read failure THROWS. The bulk runner turns it into a per-item
 * `ok:false`, so an outage never becomes a silent grant and never fabricates a refusal.
 */
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { getWorkItem, readNonAgentWorkCategory } from '../work-items';
import { notAgentWorkDoorHint } from './not-agent-work-hint';

/** The caller fields the gate reads. A narrow Pick so tests can build one without a full ctx. */
export type AgentWorkDoorCaller = Pick<UnifiedToolContext, 'spawnId' | 'isSuperuser' | 'principal'>;

/**
 * True only for the human owner acting through the desktop UI: the palette bridge
 * (`capabilities/invoke.ts` invokeServerCapability), which is the sole place that stamps
 * `spawnId: 'palette'` and runs as the fixed `loopback` system principal with
 * `authMethod: 'process-internal'` and no superuser bit. All three come from server code.
 * The MCP transport mints its own random spawnId and sets `isSuperuser` for an su bearer, so
 * an agent session cannot produce this shape through any argument.
 *
 * Deliberately NOT `classifyCallOrigin(...).origin === 'ui'`: that verdict honours a
 * caller-DECLARED `ui` origin header, so it is spoofable by design (it is telemetry).
 *
 * Residual, disclosed: the palette route is loopback-only, so a local process that POSTs to
 * /api/agent-mcp/run-tool directly gets the palette identity. That is the palette's own trust
 * boundary for every operator tool it can run, not something this gate can narrow.
 */
export function isOwnerUiCaller(caller: AgentWorkDoorCaller | null | undefined): boolean {
  if (!caller) return false;
  if (caller.spawnId !== 'palette') return false;
  if (caller.isSuperuser === true) return false;
  const p = caller.principal;
  return !!p && p.kind === 'system' && p.slug === 'loopback' && p.authMethod === 'process-internal';
}

export const NOT_AGENT_WORK = 'not_agent_work' as const;

/** The write doors that gate on the category half of the agent-work predicate. */
export type AgentWorkDoor = 'work_items:set_state' | 'work_items:complete';

/**
 * A type ALIAS, not an interface, on purpose: both doors return this through `runBulk`,
 * whose item type is `BulkItemResult` with an index signature. An interface is not
 * implicitly assignable to an index signature; an object type alias is.
 */
export type NotAgentWorkRefusal = {
  ok: false;
  id: string;
  error: typeof NOT_AGENT_WORK;
  door: AgentWorkDoor;
  nature: string;
  audience: string | null;
  hint: string;
};

/**
 * Returns the typed refusal when `id` resolves to a row that is not agent work by
 * category, else null. An absent row yields null: the door's own write path reports
 * not-found, so the gate does not invent a second spelling of that error.
 *
 * `caller` is the dispatch ctx (REQUIRED, so a door cannot forget to pass it and silently
 * lose the owner exemption or, worse, gain one). Only {@link isOwnerUiCaller} admits.
 */
export async function refuseNonAgentWorkAtDoor(
  door: AgentWorkDoor,
  id: string,
  harness: string | null | undefined,
  caller: AgentWorkDoorCaller | null,
): Promise<NotAgentWorkRefusal | null> {
  // D-038: the owner's own UI action on their own human-audience row. Checked before the
  // read so the owner path costs nothing; it never reads anything the caller supplied.
  if (isOwnerUiCaller(caller)) return null;
  const current = await getWorkItem(id, harness ?? undefined);
  if (!current) return null;
  // Scope the category read to the harness the row ACTUALLY resolved in: a bare WI-<n> id
  // is not globally unique, so the requested harness can name a different row.
  const rowHarness = current.harness ?? harness ?? null;
  if (!rowHarness) return null;
  const category = await readNonAgentWorkCategory(id, rowHarness);
  if (!category) return null;
  return {
    ok: false,
    id,
    error: NOT_AGENT_WORK,
    door,
    nature: category.nature,
    audience: category.audience,
    hint: notAgentWorkDoorHint(door, category.nature, category.audience),
  };
}
