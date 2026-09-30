/**
 * fleet:invariant — register / list / remove a leader's CUSTOM fleet invariant
 * (fleet-leadership-continuity-and-actuation-2026-08-01 P-014, migration 713).
 *
 * The registry surface for the checks evaluated by fleet:leader-brief. See
 * ./invariants.ts for the contract (rows == violated), the safety envelope
 * (pgReadQuery's READ ONLY transaction), and why SQL rather than a predicate
 * DSL. This file is only the tool wrapper.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity, deriveFleetMembership } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import {
  listFleetInvariants,
  registerFleetInvariant,
  removeFleetInvariant,
  INVARIANT_MAX_PER_FLEET,
} from './invariants';

export default defineTool({
  name: 'fleet:invariant',
  profile: 'engineer',
  description:
    'Register a CUSTOM invariant your fleet:leader-brief evaluates on every read, so an ad-hoc ' +
    'check outlives the turn that wrote it. The check is read-only SQL and the contract is ' +
    'ROWS RETURNED == VIOLATED (zero rows == satisfied); the rows come back as the evidence. ' +
    'REGISTER: { name, sql, falsifier?, description?, severity? } — re-registering a name replaces it. ' +
    'LIST: { list: true }. REMOVE: { remove: name }. Use {{fleet}} / {{workspace}} in the SQL ' +
    'rather than hardcoding a slug, so a copied invariant checks the fleet it now belongs to — ' +
    'they substitute ALREADY-QUOTED, so write `= {{fleet}}`, never `= \'{{fleet}}\'`. ' +
    `Capped at ${INVARIANT_MAX_PER_FLEET} per fleet; each runs read-only, row-capped and ` +
    'timeout-bounded, and one that errors is reported as errored — never silently as passing.',
  guidance: {
    when:
      'You notice a fleet-health condition no built-in brief field surfaces and you want the ' +
      'NEXT brief (and the next leader) to catch it automatically — e.g. cross-referencing ' +
      "members' parked event keys against the assignee of the items named in them.",
    notWhen:
      'A one-off question — just run dev:pg_query. A condition a built-in alert already covers ' +
      '(stranded / spec-starved / idle-with-claimable / floor-starved / dormant). Anything ' +
      'needing a write, a schedule, or a wake — invariants are evaluated only when a brief is read.',
    chaining:
      'fleet:invariant { name, sql } → fleet:leader-brief (summary.customInvariantAlert + ' +
      'customInvariants[] with the offending rows) → fleet:invariant { remove: name } when it stops earning its keep.',
    seeAlso: [
      'fleet:leader-brief (evaluates these; carries the results)',
      'dev:pg_query (the same read-only envelope, for a one-off check you do not want to persist)',
      'watch:create (fires on an EVENT; an invariant is evaluated on a brief read)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    list: z.boolean().optional().describe('Query mode: return this fleet\'s registered invariants.'),
    remove: z.string().max(120).optional().describe('Remove the invariant with this name.'),
    name: z.string().max(120).optional().describe('(register) Stable name — re-registering replaces.'),
    sql: z
      .string()
      .max(4000)
      .optional()
      .describe(
        '(register) A single read-only SELECT. Rows returned == VIOLATED. May reference {{fleet}} and {{workspace}}.',
      ),
    falsifier: z
      .string()
      .max(4000)
      .optional()
      .describe(
        '(register) Proof this check CAN fire: a single read-only SELECT — usually `sql` with its pin ' +
          'negated — that MUST return >=1 row. Zero rows refuses registration, because zero rows is ' +
          'this contract\'s SAFE reading, so a dead check reports "satisfied" forever. Not persisted.',
      ),
    description: z
      .string()
      .max(500)
      .optional()
      .describe('(register) What a violation MEANS and what to do about it — read by whoever sees it fire.'),
    severity: z
      .enum(['warn', 'critical'])
      .optional()
      .describe("(register) 'critical' additionally counts into the brief's critical tally. Default 'warn'."),
    active: z.boolean().optional().describe('(register) Set false to keep the definition but stop evaluating it.'),
    fleet: z.string().max(120).optional().describe("Fleet slug. Defaults to the caller's own fleet."),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    // Resolved defensively, mirroring fleet:bench / fleet:leader-brief: a
    // read-mostly fleet tool should still answer `list` when identity resolution
    // fails — only the created_by stamp genuinely needs ownerId.
    let actorWorkspace: string | null = null;
    let ownerId: string | undefined;
    try {
      const identity = resolveAgentIdentity(ctx);
      actorWorkspace = identity.workspaceId ?? null;
      ownerId = identity.ownerId;
    } catch {
      actorWorkspace = null;
    }

    const fleet = args.fleet ?? deriveFleetMembership().fleetSlug;
    if (!fleet) {
      return {
        data: {
          ok: false,
          error: 'no_fleet',
          hint: "No fleet resolvable — pass { fleet: '<slug>' } explicitly.",
        },
      };
    }
    // EI-13820: '*' is the unscoped-su sentinel and must never reach a workspace filter.
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, actorWorkspace);

    if (args.remove) {
      const { removed } = await removeFleetInvariant({ workspaceId, fleetSlug: fleet, name: args.remove });
      return {
        data: {
          ok: true,
          fleet,
          removed,
          ...(removed ? {} : { note: `no invariant named '${args.remove}' on this fleet` }),
        },
      };
    }

    if (args.list || (!args.name && !args.sql)) {
      const invariants = await listFleetInvariants({ workspaceId, fleetSlug: fleet, includeInactive: true });
      return {
        data: {
          ok: true,
          fleet,
          count: invariants.length,
          invariants: invariants.map((i) => ({
            name: i.name,
            severity: i.severity,
            active: i.active,
            ...(i.description ? { description: i.description } : {}),
            sql: i.querySql,
          })),
        },
      };
    }

    if (!args.name || !args.sql) {
      return {
        data: {
          ok: false,
          error: 'missing_args',
          hint: 'Register needs { name, sql }. Pass { list: true } to query, { remove: name } to delete.',
        },
      };
    }

    const result = await registerFleetInvariant({
      workspaceId,
      harnessSlug: null,
      fleetSlug: fleet,
      name: args.name,
      description: args.description ?? null,
      querySql: args.sql,
      falsifierSql: args.falsifier ?? null,
      severity: args.severity ?? 'warn',
      active: args.active ?? true,
      createdBy: ownerId ?? null,
    });
    if (!result.ok) {
      return { data: { ok: false, error: 'invalid_invariant', hint: result.error } };
    }
    return {
      data: {
        ok: true,
        fleet,
        registered: args.name,
        id: result.id,
        ...(result.falsifierRows === undefined
          ? {}
          : { falsifierRows: result.falsifierRows, provenAbleToFire: true }),
        note:
          'evaluated on every fleet:leader-brief for this fleet — rows returned means VIOLATED' +
          (result.falsifierRows === undefined
            ? '. No falsifier was supplied, so this check is NOT proven able to fire: zero rows will read as satisfied whether the fleet is healthy or the check is dead.'
            : ''),
      },
    };
  },
});
