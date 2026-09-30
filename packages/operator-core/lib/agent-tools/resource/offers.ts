/**
 * resource:offers — a READ-ONLY chat-reachable list of open standing agent-seat
 * offers (pot-seat-pools-prose-ux-2026-07-18 P-013).
 *
 * P-013's text explicitly anticipated this gap: the inventory `resource:delegate`
 * publishes is sourced from the same offer-store `remote-seat-inventory.ts` reads
 * for the one-shot routing-gate kickoff text, but that text only fires at plan
 * LAUNCH time (AUTO-off branch) — a user asking "what agent seats does this pot
 * have?" at any OTHER point in a chat conversation had no tool to answer with
 * (the /res board is a human-facing UI page, not chat-reachable). This tool is
 * the "expose an offers read on the chat surface" half of P-013's parenthetical.
 *
 * Read-only: no store mutation. `resource:delegate` stays the ONE write path.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolveWorkspaceHiveScope, resolveSharedHiveDisambiguation } from '../coordination/federation-scope';
import { listOffers, type StoredWorkOffer } from '../../p2p/offer-store';

export interface SeatOfferSummaryRow {
  offerId: string;
  /** null when the donor never set one — never invented. */
  hostLabel: string | null;
  model: string;
  effort: string;
  count: number;
  /** Fleet-scoped offer's target, or null for a pot-wide offer. */
  fleetSlug: string | null;
  /** Pot-wide offer's audience gate, or null for a fleet-scoped offer. */
  audience: 'trusted-members' | 'whole-pot' | null;
}

export function toSummaryRow(row: StoredWorkOffer): SeatOfferSummaryRow | null {
  if (!row.record || row.record.kind !== 'seat' || !row.record.seat) return null;
  return {
    offerId: row.offerId,
    hostLabel: row.record.seat.hostLabel,
    model: row.record.seat.model,
    effort: row.record.seat.effort,
    count: row.record.seat.count,
    fleetSlug: row.fleetSlug,
    audience: row.record.seat.audience,
  };
}

export default defineTool({
  name: 'resource:offers',
  profile: 'engineer',
  description:
    'Read-only: list OPEN standing agent-seat offers visible to this workspace — pot-wide (any fleet in the pot may spend) by default, or scoped to one `fleetSlug` / pot-scoped `potSlug`. On a workspace with MORE THAN ONE shared Hive, pass `hive` to pick which one — without it those workspaces get potShared:false + a `candidates` list. Each row: offerId, hostLabel (donor\'s friendly name, or null if unset), model, effort, count, audience. Returns {ok, potShared, rows, candidates?, hiveError?}; potShared:false + no candidates means no shared Hive at all (nothing to list); potShared:false + candidates means MULTIPLE shared hives exist and `hive` is required. Never mutates — `resource:delegate` is the one write path.',
  guidance: {
    when:
      "\"what agent seats are available?\" / \"who has donated seats to this pot?\" / checking before `fleet:request_remote_spawn` whether an offer actually exists yet. Pass `fleetSlug` to scope to one fleet's donated seats, `potSlug` to scope to one pot-scoped grantee, or `hive` to disambiguate which shared hive to read on a multi-hive workspace (see the `candidates` field on a potShared:false response).",
    notWhen:
      'Donating or revoking a seat (resource:delegate). Spending an existing offer (fleet:request_remote_spawn). Reading inference-GATEWAY capacity for spawn sizing (fleet:capacity — a different axis entirely).',
    chaining:
      'resource:offers (check what exists) → fleet:request_remote_spawn (spend it) or resource:delegate (donate more if the pot is short).',
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    fleetSlug: z.string().min(1).optional().describe('scope to one fleet\'s donated seats instead of the whole pot'),
    potSlug: z.string().min(1).optional().describe('scope to offers granted to one pot-scoped grantee (mutually exclusive in practice with fleetSlug)'),
    hive: z
      .string()
      .min(1)
      .optional()
      .describe(
        'which shared hive\'s offers to read, when this workspace hosts MORE THAN ONE shared hive (resource:delegate\'s own `hive` param names the same disambiguator on the publish side). Validated against the workspace\'s actual shared-hive set.',
      ),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    if (!ident.workspaceId) return { data: { ok: true, potShared: false, rows: [] } };
    const scope = await resolveWorkspaceHiveScope(ident.workspaceId).catch(() => ({ kind: 'none' as const }));
    const picked = resolveSharedHiveDisambiguation(scope, args.hive, null);
    if (!picked.ok) {
      return {
        data: {
          ok: true,
          potShared: false,
          rows: [],
          hiveError: picked.error,
          ...(picked.candidates.length ? { candidates: picked.candidates } : {}),
        },
      };
    }
    const rows = await listOffers(ident.workspaceId, picked.homeSlug, {
      kind: 'seat',
      status: 'open',
      ...(args.fleetSlug ? { fleetSlug: args.fleetSlug } : {}),
      ...(args.potSlug ? { potSlug: args.potSlug } : {}),
    }).catch(() => [] as StoredWorkOffer[]);
    const summary = rows.map(toSummaryRow).filter((r): r is SeatOfferSummaryRow => r !== null);
    return { data: { ok: true, potShared: true, rows: summary } };
  },
});
