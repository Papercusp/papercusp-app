/**
 * SU-S27 — woke to a DIRECTED dispatch → CLAIM + WORK it, never read-and-repark.
 * (fleet-dispatch-wake-clarity-2026-06-22 P-003.)
 *
 * The BEHAVIORAL leg of P-003. The presence test (prompt-build / playbook-shape) asserts the
 * "Woke to a DIRECTED assignment? CLAIM + WORK it" directive is IN the su playbook; THIS asserts
 * the agent BEHAVES on it. Motivating real failure (the plan's own dogfood): two agents were woken
 * with a directed dispatch in their inbox — su-3be8 woke→claimed→worked, but su-6ef6
 * woke→read→reparked. A reparked dispatch silently black-holes: the coordinator saw `woken:1` and
 * assumed pickup, but nothing happened.
 *
 * Setup (tool world): the su agent has just been woken. Its coord:orient shows a DIRECTED dispatch
 * from a coordinator (su-815e2) assigning it fleet-dispatch P-001..P-004, and those items sit in
 * its plan_items:my_items / claimable lane. SUCCESS = it CLAIMS the lane this turn (plan_items:convert
 * / work_items:claim / coord:declare-intent { items } / plans:set-status wip) and starts working it.
 * FAILURE = it reads the assignment, acknowledges, and re-parks (coord:await-inbox / ends the turn)
 * without claiming — the su-6ef6 read-and-repark.
 *
 * Load-bearing assert (ERROR): a claim verb fired. The text-forbids is a NARROW guard on the
 * explicit "I'll just wait / await further instructions / re-parking" repark language; the
 * SU_RUBRIC + description carry the behavioral judgment.
 */
import { PASS_THROUGH } from '@papercusp/testing-shell/llm';
import type { Scenario, ToolCallEvent, ToolDispatchOverride } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertTextForbids, assertToolCalledWithin, assertToolMatch } from './_asserts';

function canonical(name: string): string {
  return name.replace(/^mcp__agentmcp__/, '').replace(/^mcp__[a-z0-9-]+__/i, '');
}

const DISPATCH_PLAN_SLUG = 'fleet-dispatch-wake-clarity-2026-06-22';
const DISPATCH_ITEMS = [
  {
    planItemId: 'P-001',
    workItemId: 'WI-501',
    title: 'Presence wake is independently verifiable',
    acceptance: 'Document which coord:presence field and follow-up read prove that a recipient actually took a turn.',
  },
  {
    planItemId: 'P-002',
    workItemId: 'WI-502',
    title: 'coord:dispatch assigns, delivers, and wakes atomically',
    acceptance: 'Document the assignment/delivery/wake receipt and the targeted retry when only the real-time wake misses.',
  },
  {
    planItemId: 'P-003',
    workItemId: 'WI-503',
    title: 'Directed wake requires immediate claim and work',
    acceptance: 'Document claim-now behavior plus the narrow claim-conflict and genuine-block exceptions.',
  },
  {
    planItemId: 'P-004',
    workItemId: 'WI-504',
    title: 'Pickup confirmation distinguishes delivery from execution',
    acceptance: 'Document separate evidence for delivered, woken, claimed, started, and completed.',
  },
] as const;

const DISPATCH_PLAN_ITEM_IDS = DISPATCH_ITEMS.map((item) => item.planItemId);
const DISPATCH_WORK_ITEM_IDS = DISPATCH_ITEMS.map((item) => item.workItemId);

/**
 * A directed wake is a system/coord event, not prose the simulator should
 * improvise. In v3 the simulator spoke from the worker's perspective
 * ("Claiming ... setting WIP now"), then treated the status flip as success
 * and ended both arms before the concrete work could start.
 */
export const S27_SCRIPTED_WAKE = [
  '⟦turn-origin:coord-wake⟧ You have just been re-invoked after a directed dispatch from su-815e2.',
  `Re-orient on ${DISPATCH_PLAN_SLUG} P-001 through P-004, claim the assigned lane, and continue it now.`,
  'The concrete first deliverable is the consolidated “Fleet dispatch wake clarity” runbook built from the existing fleet-dispatch and wake-semantics pages.',
  'Do not stop at WIP, ask which item to start, or re-park.',
].join(' ');

const EXISTING_DISPATCH_DOCS = [
  {
    slug: 'playbook/fleet-dispatch',
    title: 'Fleet dispatch',
    body:
      'coord:dispatch assigns a lane and sends a message. The current page calls any woken:1 response ' +
      '"pickup confirmed" and does not distinguish durable delivery from execution.',
  },
  {
    slug: 'playbook/wake-semantics',
    title: 'Wake semantics',
    body:
      'A sender may request wake:"required". This page does not say which coord:presence transition ' +
      'independently proves a turn ran, or what to do for recipient_alive_not_wakeable versus recipient_dead.',
  },
] as const;

function jsonResult(value: unknown) {
  return { content: [{ text: JSON.stringify(value) }] };
}

function validPlanItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === 'string' && DISPATCH_PLAN_ITEM_IDS.includes(item as typeof DISPATCH_PLAN_ITEM_IDS[number]),
  );
}

/** A claim-shaped call only counts when it names a real item from this dispatch.
 *  This prevents an empty coord:declare-intent (or a status read) from satisfying
 *  the behavioral gate merely because it used a claim-capable tool name. */
function startsClaimingDispatch(tc: ToolCallEvent): boolean {
  const name = canonical(tc.name);
  const input = (tc.input ?? {}) as Record<string, unknown>;
  if (name === 'coord:orient') {
    return input.planSlug === DISPATCH_PLAN_SLUG && validPlanItems(input.planItems).length > 0;
  }
  if (name === 'coord:declare-intent') {
    return input.current_plan_slug === DISPATCH_PLAN_SLUG && validPlanItems(input.items).length > 0;
  }
  if (name === 'work_items:claim') {
    const id = typeof input.row === 'string' ? input.row.split(',')[0]?.trim() : '';
    return DISPATCH_WORK_ITEM_IDS.includes(id as typeof DISPATCH_WORK_ITEM_IDS[number]);
  }
  if (name === 'plan_items:claim') {
    return input.plan === DISPATCH_PLAN_SLUG && DISPATCH_PLAN_ITEM_IDS.includes(input.item as typeof DISPATCH_PLAN_ITEM_IDS[number]);
  }
  if (name === 'plans:set-status') {
    return input.slug === DISPATCH_PLAN_SLUG && input.status === 'wip' &&
      DISPATCH_PLAN_ITEM_IDS.includes(input.itemId as typeof DISPATCH_PLAN_ITEM_IDS[number]);
  }
  if (name === 'plan_items:convert') {
    return validPlanItems(input.items).length > 0 ||
      DISPATCH_PLAN_ITEM_IDS.includes(input.item as typeof DISPATCH_PLAN_ITEM_IDS[number]);
  }
  return false;
}

/** Deterministic world: a wake whose orient/inbox carries a directed dispatch + the dispatched
 *  items as a claimable lane. The claim verbs all succeed; coord:await-inbox is offered (so
 *  re-parking is a real, tempting alternative the agent must NOT take instead of claiming).
 *
 * V5 is intentionally STATEFUL and factory-backed. V4 returned success from
 * claim/author writes but every later read reset to the initial world. That
 * forced an honest SUT to choose between the write result and a contradictory
 * read, producing both a missing-artifact recovery loop and false retractions.
 */
export function makeS27DispatchWorld(): ToolDispatchOverride {
  type PlanState = 'todo' | 'wip' | 'done';
  type WorkState = 'open' | 'wip' | 'done';
  type DispatchDoc = {
    slug: string;
    title: string;
    body: string;
    status?: string;
    version?: number;
    verified?: boolean;
  };

  const planStates = new Map<string, PlanState>(DISPATCH_ITEMS.map((item) => [item.planItemId, 'todo']));
  const workStates = new Map<string, WorkState>(DISPATCH_ITEMS.map((item) => [item.workItemId, 'open']));
  const activeClaims = new Set<string>();
  let authoredDoc: DispatchDoc | null = null;
  let authoredVersion = 0;

  const itemForPlan = (planItemId: string) => DISPATCH_ITEMS.find((item) => item.planItemId === planItemId);
  const itemForWork = (workItemId: string) => DISPATCH_ITEMS.find((item) => item.workItemId === workItemId);

  function setPlanState(planItemId: string, state: PlanState): void {
    const item = itemForPlan(planItemId);
    if (!item) return;
    planStates.set(planItemId, state);
    workStates.set(item.workItemId, state === 'todo' ? 'open' : state);
    if (state === 'wip') activeClaims.add(planItemId);
    else activeClaims.delete(planItemId);
  }

  function setWorkState(workItemId: string, state: WorkState): void {
    const item = itemForWork(workItemId);
    if (!item) return;
    workStates.set(workItemId, state);
    planStates.set(item.planItemId, state === 'open' ? 'todo' : state);
    if (state === 'wip') activeClaims.add(item.planItemId);
    else activeClaims.delete(item.planItemId);
  }

  function claimPlanItems(planItemIds: readonly string[]): { claimed: string[]; alreadyHeld: string[] } {
    const claimed: string[] = [];
    const alreadyHeld: string[] = [];
    for (const planItemId of planItemIds) {
      if (activeClaims.has(planItemId)) alreadyHeld.push(planItemId);
      else claimed.push(planItemId);
      setPlanState(planItemId, 'wip');
    }
    return { claimed, alreadyHeld };
  }

  function allDocs(): DispatchDoc[] {
    const seeded = EXISTING_DISPATCH_DOCS.map((doc) => ({ ...doc }));
    return authoredDoc ? [...seeded, authoredDoc] : seeded;
  }

  return {
    override(name, args) {
      const canon = canonical(name);
      const input = (args ?? {}) as Record<string, unknown>;
      if (canon === 'coord:orient') {
        const requested = input.planSlug === DISPATCH_PLAN_SLUG ? validPlanItems(input.planItems) : [];
        const claimResult = claimPlanItems(requested);
        const claims = [...activeClaims];
        return jsonResult({
          ok: true,
          me: {
            summary: { claims: claims.length, work_item_load: claims.length },
            agents: [{ agentId: 'su-self', claims, queued: DISPATCH_WORK_ITEM_IDS }],
          },
          claimable: DISPATCH_ITEMS.map((item) => ({
            id: item.workItemId,
            kind: 'feature',
            title: item.title,
            state: workStates.get(item.workItemId),
            assignee: activeClaims.has(item.planItemId) ? 'su-self' : null,
            payload: {
              plan_item: {
                item_id: item.planItemId,
                plan_slug: DISPATCH_PLAN_SLUG,
                harness_slug: 'papercusp',
              },
            },
          })),
          inbox: {
            summary: { total: 1, returned: 1 },
            recent: [{
              from: 'su-815e2',
              kind: 'dispatch',
              summary:
                `DISPATCH → you: take ${DISPATCH_PLAN_SLUG} P-001..P-004 and work them now. ` +
                'Begin by consolidating playbook/fleet-dispatch and playbook/wake-semantics into the Fleet dispatch wake clarity runbook.',
              planSlug: DISPATCH_PLAN_SLUG,
              planItems: DISPATCH_PLAN_ITEM_IDS,
            }],
          },
          intentDeclared: typeof input.intent === 'string' && input.intent.length > 0,
          claims: { ...claimResult, conflicts: [], released: [] },
        });
      }
      if (canon === 'plan_items:my_items') {
        return jsonResult({
          items: DISPATCH_ITEMS.map((item) => ({
            plan: DISPATCH_PLAN_SLUG,
            item: item.planItemId,
            workItemId: item.workItemId,
            assignee: 'su-self',
            assignedBy: 'su-815e2',
            status: planStates.get(item.planItemId),
          })),
        });
      }
      if (canon === 'plans:get') {
        return jsonResult({
          slug: DISPATCH_PLAN_SLUG,
          frontmatter: { title: 'Fleet dispatch wake clarity', status: 'active' },
          now: {
            state: 'P-001 through P-004 are assigned to su-self and ready to start.',
            next:
              'Claim the four-item lane, read playbook/fleet-dispatch and playbook/wake-semantics, ' +
              'and author the consolidated Fleet dispatch wake clarity runbook now.',
          },
          items: DISPATCH_ITEMS.map((item) => ({
            id: item.planItemId,
            text: item.title,
            acceptanceCriteria: item.acceptance,
            status: planStates.get(item.planItemId),
            workItemId: item.workItemId,
            assignee: 'su-self',
          })),
          decisions: [],
        });
      }
      if (canon === 'plans:list' || canon === 'plans:search') {
        return jsonResult({
          plans: [{
            slug: DISPATCH_PLAN_SLUG,
            title: 'Fleet dispatch wake clarity',
            status: 'active',
            itemCount: DISPATCH_ITEMS.length,
          }],
        });
      }
      if (canon === 'work_items:get' || canon === 'work_items:list') {
        const selectedIds = typeof input.id === 'string'
          ? [input.id]
          : Array.isArray(input.ids)
            ? input.ids.filter((id): id is string => typeof id === 'string')
            : DISPATCH_WORK_ITEM_IDS;
        const workItems = DISPATCH_ITEMS
          .filter((item) => selectedIds.includes(item.workItemId))
          .map((item) => ({
            id: item.workItemId,
            kind: 'feature',
            title: item.title,
            state: workStates.get(item.workItemId),
            assignee: activeClaims.has(item.planItemId) ? 'su-self' : null,
            payload: {
              plan_item: {
                item_id: item.planItemId,
                plan_slug: DISPATCH_PLAN_SLUG,
                harness_slug: 'papercusp',
              },
              acceptance: item.acceptance,
            },
          }));
        if (canon === 'work_items:list') return jsonResult({ ok: true, items: workItems });
        return jsonResult({
          ok: true,
          results: workItems.map((workItem) => ({ ok: true, id: workItem.id, workItem })),
        });
      }
      if (canon === 'docs:search') {
        return jsonResult({
          ok: true,
          results: allDocs().map((doc) => ({ slug: doc.slug, title: doc.title, excerpt: doc.body })),
        });
      }
      if (canon === 'docs:outline') {
        return jsonResult({
          ok: true,
          documents: allDocs().map((doc) => ({ slug: doc.slug, title: doc.title })),
        });
      }
      if (canon === 'docs:get') {
        const requested = Array.isArray(input.slugs)
          ? input.slugs.filter((slug): slug is string => typeof slug === 'string')
          : typeof input.slug === 'string'
            ? [input.slug]
            : [];
        const documents = allDocs().filter((doc) =>
          requested.some((slug) => slug === doc.slug || slug.endsWith(doc.slug.split('/').at(-1)!)),
        );
        return jsonResult({ ok: true, documents, count: documents.length });
      }
      if (canon === 'docs:author') {
        const rawSlug = typeof input.slug === 'string' ? input.slug : 'fleet-dispatch-wake-clarity';
        const section = typeof input.section === 'string' ? input.section.replace(/^\/+|\/+$/g, '') : '';
        const slug = section && !rawSlug.includes('/') ? `${section}/${rawSlug}` : rawSlug;
        authoredVersion += 1;
        authoredDoc = {
          slug,
          title: typeof input.title === 'string' ? input.title : 'Fleet dispatch wake clarity',
          body: typeof input.body === 'string' ? input.body : '',
          status: typeof input.status === 'string' ? input.status : 'active',
          version: authoredVersion,
          verified: input.verify === true,
        };
        return jsonResult({ ok: true, ...authoredDoc });
      }
      // The claim/pickup verbs all succeed and persist into every later read.
      if (canon === 'work_items:claim') {
        const workItemId = typeof input.row === 'string' ? input.row.split(',')[0]?.trim() ?? '' : '';
        const item = itemForWork(workItemId);
        if (item) setWorkState(workItemId, 'wip');
        return jsonResult({
          ok: true,
          id: workItemId,
          workItem: { id: workItemId, state: workStates.get(workItemId) ?? 'open', assignee: item ? 'su-self' : null },
        });
      }
      if (canon === 'plan_items:claim') {
        const planItemId = typeof input.item === 'string' ? input.item : '';
        claimPlanItems(validPlanItems([planItemId]));
        return jsonResult({
          ok: true,
          claim_id: `cl-${planItemId.toLowerCase()}`,
          item: planItemId,
          lease_expires_in_sec: 1800,
        });
      }
      if (canon === 'coord:declare-intent') {
        const requested = input.current_plan_slug === DISPATCH_PLAN_SLUG ? validPlanItems(input.items) : [];
        const claimResult = claimPlanItems(requested);
        return jsonResult({
          ok: true,
          presence: { ownerId: 'su-self', intent: input.intent ?? '' },
          claims: { ...claimResult, conflicts: [], released: [] },
        });
      }
      if (canon === 'plans:set-status') {
        const planItemId = typeof input.itemId === 'string' ? input.itemId : '';
        const oldStatus = planStates.get(planItemId) ?? 'todo';
        const newStatus = input.status === 'done' ? 'done' : input.status === 'wip' ? 'wip' : 'todo';
        setPlanState(planItemId, newStatus);
        return jsonResult({
          ok: true,
          itemId: planItemId,
          oldStatus,
          newStatus,
          ...(newStatus === 'wip' ? { claim: { holder: 'su-self', lease_sec: 1800 } } : {}),
        });
      }
      if (canon === 'plan_items:convert') {
        const requested = validPlanItems(Array.isArray(input.items) ? input.items : [input.item]);
        claimPlanItems(requested);
        return jsonResult({ ok: true, claimed: requested });
      }
      if (canon === 'work_items:set_state') {
        const selectedIds = Array.isArray(input.ids)
          ? input.ids.filter((id): id is string => typeof id === 'string')
          : typeof input.id === 'string'
            ? [input.id]
            : [];
        const state: WorkState = input.state === 'done' ? 'done' : input.state === 'wip' ? 'wip' : 'open';
        for (const workItemId of selectedIds) setWorkState(workItemId, state);
        return jsonResult({ ok: true, ids: selectedIds, state });
      }
      if (canon === 'work_items:complete') {
        const workItemId = typeof input.id === 'string' ? input.id : '';
        setWorkState(workItemId, 'done');
        return jsonResult({ ok: true, id: workItemId, state: 'done' });
      }
      if (canon === 'work_items:checkpoint') return jsonResult({ ok: true });
      // The tempting repark alternative — available, but taking it INSTEAD of claiming is the failure.
      if (canon === 'coord:await-inbox') return jsonResult({ ok: true, watching: true });
      return PASS_THROUGH;
    },
  };
}

/** Back-compatible fixture export for direct tests; live scenario runs use the
 * getter below so every matrix arm receives an isolated state machine. */
export const S27_DISPATCH_WORLD = makeS27DispatchWorld();

export const SU_S27_WOKE_TO_DISPATCH_CLAIMS: Scenario = {
  id: 'su-S27-woke-to-dispatch-claims',
  version: 5,
  target: 'su',
  transport: 'in-process',
  description:
    'The su engineer has just been WOKEN from idle. When it orients, it finds a DIRECTED dispatch: a ' +
    'coordinator (su-815e2) assigned it the fleet-dispatch-wake-clarity lane P-001..P-004, and those ' +
    'items are in its claimable assignments / plan_items:my_items. SUCCESS: the engineer CLAIMS the ' +
    'dispatched lane THIS turn — plan_items:convert / work_items:claim / coord:declare-intent { items } ' +
    '/ plans:set-status wip — and starts working it (it does not just acknowledge and go back to sleep). ' +
    'FAILURE: it reads the dispatch, says it will get to it / awaits further instruction / re-parks via ' +
    'coord:await-inbox or ends the turn WITHOUT claiming — the read-and-repark that silently black-holes ' +
    'the dispatch (the coordinator saw woken:1 and assumes pickup). Reward claiming + working the ' +
    'directed lane decisively; penalize reading-then-reparking without taking the claim.',
  persona: {
    id: 'coordinator-dispatch',
    description:
      'A fleet coordinator who just dispatched a lane to this agent and woke it. Terse, factual; it ' +
      'confirms the lane was assigned and to pick it up, but never tells the agent WHICH tool to claim with.',
    traits: {
      verbosity: 'terse',
      politeness: 'neutral',
      clarification: 'never_clarifies',
      goalClarity: 'precise',
      interrupts: false,
      modality: 'text',
      domain: 'admin',
    },
  },
  // Follow-up simulation must stay in the coordinator role and must not treat
  // a bare claim/status flip as task completion. The scripted first turn below
  // is what the SUT receives; this context governs only later sim-user turns.
  simUserContext:
    'You are coordinator su-815e2, not the worker. You dispatched fleet-dispatch-wake-clarity P-001..P-004 ' +
    'to the engineer and woke it. Never say that you are claiming or setting WIP yourself. The assignment ' +
    'is not satisfied when the engineer merely claims or changes status: it must begin the concrete ' +
    'consolidated Fleet dispatch wake clarity runbook before you declare success.',
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 2, variancePolicy: 'flag-if-disagreement' },
  triggers: [{ on: 'after_turn', param: 0, fire: 'user_message', text: S27_SCRIPTED_WAKE }],
  get toolOverride() {
    return makeS27DispatchWorld();
  },
  asserts: [
    assertToolMatch(startsClaimingDispatch, {
      name: 'claims-the-dispatched-lane',
      claim:
        'The agent woke to a DIRECTED dispatch (fleet-dispatch P-001..P-004 assigned to it) but never claimed it ' +
        '— no claim-capable call named an actual dispatched item. That is ' +
        'the read-and-repark that black-holes a dispatch the coordinator already counted as woken:1.',
      suggestion:
        "su-power/su-engineer playbook 'Woke to a DIRECTED assignment? CLAIM + WORK it': orient → see the lane → " +
        'claim it (coord:orient { planSlug, planItems }, work_items:claim, plan_items:claim, ' +
        'coord:declare-intent { current_plan_slug, items }, or plans:set-status wip) and work it THIS turn.',
    }),
    assertToolCalledWithin(['docs:author'], 2, {
      name: 'starts-the-dispatched-doc-work-without-reparking',
      claim:
        'The agent claimed the clarity lane but did not begin its concrete deliverable within the first two ' +
        'turns. A claim followed by repeated reads and a menu question is still read-and-repark behavior.',
      suggestion:
        'Use the plan acceptance criteria and existing two playbook pages, then author the consolidated ' +
        'fleet-dispatch-wake-clarity page immediately.',
    }),
    assertTextForbids(
      /\b(i'?ll\s+(get to|pick (it|this) up|start)\b[^.?!]{0,40}\b(later|next turn|soon|after)|await(ing)?\s+(further|more)\s+(instruction|direction|detail)|going back to (sleep|idle|park)|re-?park(ing)?|let me know\b[^.?!]{0,40}\bwhen\b)/i,
      {
        name: 'no-read-and-repark',
        claim:
          'The agent acknowledged the dispatch but deferred / re-parked / awaited more instruction instead of ' +
          'claiming + working it now — the exact su-6ef6 read-and-repark P-003 guards against.',
        suggestion:
          'A directed dispatch is a turn to ACT: claim the lane and work it this turn; only repark if the lane is ' +
          'genuinely blocked (record it blocked first) or a live peer already holds the claim.',
      },
    ),
    { kind: 'cost_under', usd: 2.0 },
  ],
  rubric: SU_RUBRIC,
};

export default SU_S27_WOKE_TO_DISPATCH_CLAIMS;
