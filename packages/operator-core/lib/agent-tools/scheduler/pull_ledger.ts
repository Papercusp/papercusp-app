/**
 * scheduler:pull_ledger — EI-7014: one queryable view of WHY each get_next call
 * returned what it returned, over a time window.
 *
 * "Validating the new get_next path live, the only way to see what members pulled and
 * why is stitching tool_invocations + work_item_claims + bee_claim_specs by hand" — the
 * originating report. `scheduler:get_next` already writes one durable row per call to
 * `harness_shared.tool_invocations` (P-003's `schedulerDispositionMetadata`, in ./get_next.ts):
 * bee (coord_owner_id), harness, timestamp, duration, and a `{kind:'claimed'|'no-claim', ...}`
 * disposition. EI-7014 additionally enriches that disposition with the `specId@revision` it is
 * attributable to (see specHeadFrom in ./get_next.ts) — sourced from values ALREADY computed on
 * that hot path (a claim's own `claimedUnder`, or a fleet-scoped miss's resolved spec record), so
 * recording it costs nothing extra per call. This tool is a pure read over that existing ledger:
 * no new table, no per-row re-resolution, no extra query on the claim path.
 *
 * SCOPE DECISION (this idea's own triage flagged it needs-design; recorded here rather than left
 * implicit): the originating report's wishlist also named "rank-winning terms", "floors that
 * dropped N candidates", and "tier-2 widenings" per row. Those are deliberately NOT captured here
 * — computing them for every SUCCESSFUL claim would mean an extra diagnostic query on get_next's
 * hot path (the highest-frequency scheduler call; see /internal/docs/performance's anti-patterns on
 * adding hot-path cost), for a benefit only realized when someone later reads the ledger. They stay
 * the miss-diagnosis-only fields they already are: get_next's own `diagnosis`/`floors`/
 * `excludedBreakdown` on a LIVE miss, or work_items:claimable for a standing floor-by-floor count.
 * This tool answers WHO pulled WHAT, WHEN, under WHICH spec, and (for a miss) the compact reason —
 * not a full rank/floor replay of a past pull.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { fleetEverMembers } from '../../fleet-membership-store';
import { formatSpecRef } from '../../scheduler/claim-spec';
import type { SchedulerDispositionMetadata } from './get_next';

const PULL_LEDGER_DEFAULT_LIMIT = 50;
const PULL_LEDGER_MAX_LIMIT = 200;
const PULL_LEDGER_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export type PullLedgerDisposition = 'claimed' | 'no-claim' | 'unrecorded';

export interface PullLedgerRow {
  at: string;
  bee: string | null;
  harness: string;
  disposition: PullLedgerDisposition;
  item: string | null;
  specId: string | null;
  revision: number | null;
  specRef: string | null;
  reason: string | null;
  durationMs: number | null;
  status: string;
}

/** Raw shape of one selected `tool_invocations` row — the columns the query below projects. */
export interface PullLedgerInvocationRow {
  invoked_at: string;
  coord_owner_id: string | null;
  harness_slug: string;
  status: string;
  duration_ms: number | null;
  disposition: unknown;
}

function isSchedulerDisposition(value: unknown): value is SchedulerDispositionMetadata {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    ((value as { kind?: unknown }).kind === 'claimed' || (value as { kind?: unknown }).kind === 'no-claim')
  );
}

/**
 * Pure row-shaper — factored out for a DB-free unit test (the sibling pattern to
 * scheduler/running.ts's `shapeSchedulerRunning`). `disposition` can be `null`/malformed for a
 * `scheduler:get_next` invocation that errored before `ctx.metadata?.()` ran (e.g. an early
 * `harness_required` exit) — reported as `'unrecorded'`, never guessed as claimed or no-claim.
 */
export function pullLedgerRowFromInvocation(row: PullLedgerInvocationRow): PullLedgerRow {
  const d = isSchedulerDisposition(row.disposition) ? row.disposition : null;
  const specId = d && 'specId' in d && typeof d.specId === 'string' ? d.specId : null;
  const revision = d && 'revision' in d && typeof d.revision === 'number' ? d.revision : null;
  return {
    at: row.invoked_at,
    bee: row.coord_owner_id,
    harness: row.harness_slug,
    disposition: d ? d.kind : 'unrecorded',
    item: d?.kind === 'claimed' ? d.workItemId : null,
    specId,
    revision,
    specRef: specId ? formatSpecRef(specId, revision) : null,
    reason: d?.kind === 'no-claim' ? d.reason : null,
    durationMs: row.duration_ms,
    status: row.status,
  };
}

/**
 * Registered response contract. `tools:find` renders THIS in preference to
 * `guidance.returns` (tools/find.ts: `registered-output-schema` wins over
 * `authored-tool-guidance`), so the structural shape callers see is derived
 * here rather than hand-maintained in prose — the rule
 * `guidance-output-schema-live-guard.test.ts` enforces.
 *
 * The guard reads the FIRST `{...}` clause of `guidance.returns` as the
 * TOP-LEVEL shape, so that clause and these top-level keys must agree exactly.
 */
const pullLedgerRowSchema = z.object({
  at: z.string(),
  bee: z.string().nullable(),
  harness: z.string(),
  disposition: z.enum(['claimed', 'no-claim', 'unrecorded']),
  item: z.string().nullable(),
  specId: z.string().nullable(),
  revision: z.number().int().nullable(),
  specRef: z.string().nullable(),
  reason: z.string().nullable(),
  durationMs: z.number().nullable(),
  status: z.string(),
});

const pullLedgerResultSchema = z.object({
  ok: z.boolean(),
  window: z.object({ sinceTs: z.string(), limit: z.number().int() }),
  summary: z.object({
    pulls: z.number().int().nonnegative(),
    claimed: z.number().int().nonnegative(),
    noClaim: z.number().int().nonnegative(),
    // Present only when at least one selected invocation carried no readable
    // disposition — never guessed as claimed or no-claim.
    unrecorded: z.number().int().nonnegative().optional(),
    // Both set together when the row cap was reached.
    truncated: z.boolean().optional(),
    hint: z.string().optional(),
  }),
  rows: z.array(pullLedgerRowSchema),
  // Only on the empty ever-members branch below.
  note: z.string().optional(),
});

export default defineTool({
  name: 'scheduler:pull_ledger',
  profile: 'engineer',
  description:
    'History of scheduler:get_next calls: who pulled what, when, under which spec, and why a pull came up empty. Reads the existing tool_invocations ledger get_next already writes — no new table.',
  guidance: {
    when:
      "After re-steering a fleet's claim spec, or debugging a mis-steer: see what { fleet } (ever-members) or { bee } actually pulled and under which specId@revision. One of fleet|bee is required.",
    notWhen:
      "Live state, not history — scheduler:running. Current floor breakdown — work_items:claimable. A rank/floor REPLAY of one past pull is not carried (would add a query to get_next's hot path) — that stays get_next's own live diagnosis on an actual miss.",
    chaining: 'scheduler:set_claim_spec → scheduler:pull_ledger { fleet } → scheduler:running.',
    returns:
      '{ok, window: {sinceTs, limit}, summary: {pulls, claimed, noClaim, unrecorded?, truncated?, hint?}, rows: [{at, bee, harness, disposition: claimed|no-claim|unrecorded, item, specId, revision, specRef, reason, durationMs, status}], note?}. `note` appears ONLY when a named fleet resolved to an EMPTY ever-members set — it means "no members known", never "this fleet did nothing"; verify the slug. `summary.truncated` means the row cap was reached, so these are the newest `limit` pulls in the window, not every pull in it. A row reads `disposition:"unrecorded"` when its invocation carried no readable disposition (it errored before one was written) — never read that as a no-claim.',
    seeAlso: [
      'scheduler:running (live-execution view, not history)',
      'scheduler:get_claim_spec (current spec for one bee/fleet)',
      'scheduler:set_claim_spec (re-steer)',
      'work_items:claimable (current floor-by-floor claimability breakdown)',
    ],
  },
  result: pullLedgerResultSchema,
  capability: 'work_items:read',
  // Raw getOrgPg() access, like scheduler:get_claim_spec — never reads ctx.tx, so keeping the
  // dispatcher's ambient workspace transaction open here only pins an unused org-app pool slot.
  skipWorkspaceTx: true,
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      fleet: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe(
          'a fleet slug — includes pulls from every EVER member (append-only fleet_membership_events ledger; dead/ended members included), not just currently-live ones',
        ),
      bee: z.string().min(1).max(120).optional().describe('one bee/owner id — its pull history alone'),
      harness: z.string().min(1).max(120).optional().describe('narrow to one harness (default: every harness the matched bees pulled from)'),
      sinceTs: z.string().min(1).max(40).optional().describe('ISO timestamp lower bound (default: 24h ago)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(PULL_LEDGER_MAX_LIMIT)
        .optional()
        .describe(`max rows, newest first (default ${PULL_LEDGER_DEFAULT_LIMIT}, max ${PULL_LEDGER_MAX_LIMIT})`),
      workspace: z.string().max(120).optional(),
    })
    .refine((a) => Boolean(a.fleet) || Boolean(a.bee), {
      message: 'pass at least one of fleet | bee — an unscoped read over every bee is not offered',
    }),
  async handler(args, ctx) {
    // A READ — identity is used only to default the workspace scope, resolved SOFTLY so a
    // bare loopback caller can read without a coord identity (same pattern as scheduler:running).
    let actorWorkspace: string | null = null;
    try {
      actorWorkspace = resolveAgentIdentity(ctx).workspaceId ?? null;
    } catch {
      actorWorkspace = null;
    }
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, actorWorkspace);
    const sinceTs = args.sinceTs ?? new Date(Date.now() - PULL_LEDGER_DEFAULT_WINDOW_MS).toISOString();
    const limit = args.limit ?? PULL_LEDGER_DEFAULT_LIMIT;

    let bees: string[] | null = null;
    if (args.fleet) {
      const members = await fleetEverMembers(args.fleet, { workspaceId });
      if (args.bee) members.add(args.bee);
      bees = [...members];
      if (bees.length === 0) {
        return {
          data: {
            ok: true,
            window: { sinceTs, limit },
            summary: { pulls: 0, claimed: 0, noClaim: 0 },
            rows: [],
            note:
              `fleet '${args.fleet}' has no known members (empty ever-members set) — nothing to show. ` +
              'This means "no members known", never "this fleet did nothing"; verify the fleet slug.',
          },
        };
      }
    } else if (args.bee) {
      bees = [args.bee];
    }

    const { sql } = getOrgPg();
    const rows = await sql<PullLedgerInvocationRow[]>`
      SELECT invoked_at, coord_owner_id, harness_slug, status, duration_ms,
             metadata_json->'schedulerDisposition' AS disposition
        FROM harness_shared.tool_invocations
       WHERE workspace_id = ${workspaceId}
         AND tool_name = 'scheduler:get_next'
         AND invoked_at >= ${sinceTs}::timestamptz
         ${bees ? sql`AND coord_owner_id = ANY(${bees}::text[])` : sql``}
         ${args.harness ? sql`AND harness_slug = ${args.harness}` : sql``}
       ORDER BY invoked_at DESC
       LIMIT ${limit}
    `;

    const ledgerRows = rows.map(pullLedgerRowFromInvocation);
    const claimed = ledgerRows.filter((r) => r.disposition === 'claimed').length;
    const unrecorded = ledgerRows.filter((r) => r.disposition === 'unrecorded').length;
    return {
      data: {
        ok: true,
        window: { sinceTs, limit },
        summary: {
          pulls: ledgerRows.length,
          claimed,
          noClaim: ledgerRows.length - claimed - unrecorded,
          ...(unrecorded > 0 ? { unrecorded } : {}),
          ...(ledgerRows.length === limit
            ? {
                truncated: true,
                hint: 'row cap reached — this is the newest `limit` pulls in the window, not every pull in it; lower sinceTs (a narrower window) to see the tail, or raise limit.',
              }
            : {}),
        },
        rows: ledgerRows,
      },
    };
  },
});
