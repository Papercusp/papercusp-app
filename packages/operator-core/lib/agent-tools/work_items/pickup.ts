/**
 * work_items:pickup — the COMPOUND "pick up this item to work on" flow
 * (code-execution-tool-orchestration B-CX-1B).
 *
 * Measured (harness_shared.tool_invocations, mcp transport, 14d): `work_items:get →
 * work_items:claim` is the #1 consecutive cross-tool agent sequence (146×, 142
 * sessions), and the triples `…→ work_items:get → work_items:claim → capability:*`
 * (start work) recur right behind it — the canonical "I want THIS one: show me its
 * detail and take it" flow. Agents pay 2–3 inference round-trips for what is one fixed
 * action.
 *
 * pickup collapses it into ONE call: fetch the item's full detail, claim it for the
 * caller, and — when an `intent` is given — declare that intent (optionally claiming a
 * plan lane). Round-trips: 2 (get+claim) or 3 (+declare-intent) → 1. It also closes the
 * get→claim TOCTOU race: between a separate get and claim a peer can take the item;
 * pickup claims immediately after the read.
 *
 * Composition is the in-process re-dispatch pattern (see `_compound-dispatch.ts`): each
 * sub-step runs the real dispatcher (gated, quota'd, recordInvocation-logged, audited),
 * so pickup is just a server-side caller of get/claim/declare-intent, never a bypass.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { hardText, LIMITS } from '../limits';
import { COORD_ROLES } from '../coordination/roles';
import { inProcessCall, type InnerCall } from '../_compound-dispatch';

export interface PickupArgs {
  id: string;
  harness?: string;
  detail?: boolean;
  assignee?: string;
  intent?: string;
  plan?: string;
  items?: string[];
}

export interface PickupResult {
  ok: boolean;
  /** Which sub-step failed, when ok=false. */
  step?: 'get' | 'claim' | 'declare-intent' | 'lane';
  error?: string;
  /** The work-item (detailed from get, refreshed by claim when it succeeded). */
  item?: unknown;
  claimed?: boolean;
  /** Omitted when declaration may have committed but no authoritative result returned. */
  intentDeclared?: boolean;
  /** Only present when a plan lane was requested; presence success is not a lane claim. */
  laneClaimed?: boolean;
  /** The declare-intent presence row, when intent was declared. */
  presence?: unknown;
}

/**
 * Pure composition: get(detail) → claim → optional declare-intent, over an injected
 * `call`. Business-level failures (item not found, already claimed) short-circuit with
 * `ok:false` + the failing step. A declaration failure after claim preserves the
 * completed claim in the response, including when the inner dispatcher throws.
 * Retrying uses this SAME id and re-dispatches claim under current authority;
 * a prior success is never permission to skip a gate or create a replacement.
 */
export async function composePickup(args: PickupArgs, call: InnerCall): Promise<PickupResult> {
  // work_items:get is bulk (bulk-endpoint-standardization-2026-06-21): a single
  // id comes back as the one entry of `results` (each self-describes its id).
  const got = (await call('work_items:get', {
    id: args.id,
    ...(args.harness ? { harness: args.harness } : {}),
    detail: args.detail ?? true,
  })) as { ok?: boolean; results?: Array<{ ok?: boolean; workItem?: unknown; error?: string }> } | undefined;
  const gotItem = got?.results?.[0];
  if (!gotItem?.ok || gotItem.workItem == null) {
    return { ok: false, step: 'get', error: gotItem?.error ?? `work_item '${args.id}' not found` };
  }

  // work_items:claim is bulk (bulk-endpoint-standardization-2026-06-21): the
  // envelope's top-level ok is ALWAYS true ("the batch ran"); the real claim
  // outcome (incl. a claim_conflict) is the single entry of `results`.
  const claimRes = (await call('work_items:claim', {
    id: args.id,
    ...(args.harness ? { harness: args.harness } : {}),
    ...(args.assignee ? { assignee: args.assignee } : {}),
  })) as { ok?: boolean; results?: Array<{ ok?: boolean; workItem?: unknown; error?: string }> } | undefined;
  const claimed = claimRes?.results?.[0];
  if (!claimed?.ok) {
    return { ok: false, step: 'claim', item: gotItem.workItem, claimed: false, error: claimed?.error ?? 'claim failed' };
  }

  let presence: unknown;
  let intentDeclared = false;
  const laneRequested = Boolean(args.intent && args.plan && args.items);
  if (args.intent) {
    // `items` is only meaningful with a plan (declare-intent rejects items without
    // current_plan_slug), so only forward the lane when a plan is given.
    try {
      presence = await call('coord:declare-intent', {
        intent: args.intent,
        ...(args.plan ? { current_plan_slug: args.plan } : {}),
        ...(args.plan && args.items ? { items: args.items } : {}),
        ...(args.harness ? { harness: args.harness } : {}),
      });
    } catch (error) {
      return {
        ok: false, step: 'declare-intent',
        error: `intent declaration outcome unknown: ${error instanceof Error ? error.message : String(error)}`,
        item: claimed.workItem ?? gotItem.workItem,
        // A transport/handler throw can happen AFTER writePresence. Do not
        // manufacture either a positive receipt or proof that nothing landed.
        claimed: true,
      };
    }
    const declaration = presence as {
      ok?: unknown;
      error?: string;
      claims?: { claimed?: unknown; alreadyHeld?: unknown; conflicts?: unknown; unknown?: unknown };
    } | undefined;
    if (declaration?.ok !== true) {
      return {
        ok: false, step: 'declare-intent',
        error: declaration?.error ?? 'intent declaration outcome unknown: no authoritative result',
        item: claimed.workItem ?? gotItem.workItem,
        claimed: true,
        ...(declaration?.ok === false ? {
          intentDeclared: false,
          ...(laneRequested ? { laneClaimed: false } : {}),
        } : {}),
        ...(presence != null ? { presence } : {}),
      };
    }
    intentDeclared = true;
    if (laneRequested) {
      // declare-intent deliberately returns ok:true after writing presence even
      // when lane reconciliation reports conflicts/unknown ids. Require positive
      // receipts for EVERY requested id, not merely the absence of an error.
      const claims = declaration.claims;
      const stringList = (value: unknown): value is string[] =>
        Array.isArray(value) && value.every((item) => typeof item === 'string');
      const laneMeasured = claims != null
        && stringList(claims.claimed)
        && stringList(claims.alreadyHeld)
        && Array.isArray(claims.conflicts)
        && (claims.unknown === undefined || stringList(claims.unknown));
      const laneSucceeded = laneMeasured
        && (claims!.conflicts as unknown[]).length === 0
        && (claims!.unknown === undefined || (claims!.unknown as string[]).length === 0)
        && args.items!.every((id) => (claims.claimed as string[]).includes(id)
          || (claims.alreadyHeld as string[]).includes(id));
      if (!laneSucceeded) {
        return {
          ok: false, step: 'lane',
          error: laneMeasured ? 'requested plan lane was not fully claimed' : 'plan lane outcome unknown: no authoritative result',
          item: claimed.workItem ?? gotItem.workItem,
          claimed: true, intentDeclared: true, presence,
          ...(laneMeasured ? { laneClaimed: false } : {}),
        };
      }
    }
  }

  return {
    ok: true,
    item: claimed.workItem ?? gotItem.workItem,
    claimed: true,
    intentDeclared,
    ...(laneRequested ? { laneClaimed: true } : {}),
    ...(presence ? { presence } : {}),
  };
}

export default defineTool({
  name: 'work_items:pickup',
  profile: 'engineer',
  description:
    'Pick up a specific work-item in ONE call: fetch its full detail, claim it for you, ' +
    'and (when `intent` is given) declare your intent / plan lane. Collapses the ' +
    'get→claim(→declare-intent) round-trips into one and closes the get→claim race.',
  guidance: {
    when:
      'You have decided to work a SPECIFIC work-item id — pickup fetches its detail, ' +
      'claims it, and optionally declares your intent in one round-trip instead of ' +
      'work_items:get → work_items:claim → coord:declare-intent.',
    notWhen:
      'You are still deciding whether to take it (inspect first with work_items:get), ' +
      'or you want the oldest unassigned item regardless of which (work_items:claim_next).',
    chaining:
      'work_items:list → work_items:pickup { id, intent } → work → work_items:complete. ' +
      'A failed declaration/lane can leave claimed:true; retry the same id after repair. ' +
      'Retries re-check current authorization — never create, force or rename a replacement.',
  },
  // Claims the item (write). effect:'write' is inferred from the :write capability
  // (B-CX-PRE), so pickup is dry-run-previewable like any mutating tool.
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).describe('The work-item id (WI-/F-/EI-…) to pick up.'),
    harness: z.string().max(80).optional().describe('Harness the item lives in (feature-id disambiguation).'),
    detail: z.boolean().optional().describe('Include topics/comments/links in the returned item (default true).'),
    assignee: z.string().max(120).optional().describe('Claim for this owner instead of you.'),
    intent: hardText(LIMITS.SHORT_TITLE).optional().describe('If set, also declare this one-line intent after claiming.'),
    plan: z.string().max(200).optional().describe('Plan slug for the declared lane (with `items`).'),
    items: z
      .array(z.string().regex(/^P-\d{3,}$/, 'P-NNN form required'))
      .max(40)
      .optional()
      .describe('Plan items to claim as your lane (requires `intent` + `plan`).'),
  }),
  async handler(args, ctx) {
    const result = await composePickup(args, inProcessCall(ctx));
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      ...(result.ok ? {} : { isError: true }),
    };
  },
});
