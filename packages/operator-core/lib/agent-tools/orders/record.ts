/**
 * orders:record — file an explicit OWNER DIRECTIVE, verbatim, into the
 * first-class owner-directives store (EI-11484).
 *
 * Since owner-directive-delivery-redesign-2026-09-22 D-001 the UserPromptSubmit
 * hook captures EVERY owner turn automatically (orders:capture) and tells the
 * session "YOUR owner directive #N". This verb is now the fallback for an order
 * that arrived without that notice. When a sourceTurnRef is supplied, the store's
 * exact per-turn key makes recovery idempotent; only calls without that key use the
 * recent same-session text-twin fallback (directive-ownership-clarity-2026-09-23 P-004).
 * What the agent files here is not demoted to checkpoint
 * prose: an open row
 * renders ABOVE the loop agenda in every wake, every orient, and every
 * post-compaction anchor until orders:disposition closes it — the re-injection
 * surface fresh owner directives lacked (the priority inversion that buried
 * the 2026-07-13 resume-sessions order).
 *
 * PROVENANCE: the verbatim text is verified server-side against the caller's
 * own transcript's HUMAN turns (the relay-provenance tier-3 machinery). A miss
 * still records — refusing would re-create the drop — but the result carries a
 * loud `unverified` so a paraphrase can't masquerade as owner words.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  recordOwnerDirective,
  countOpenOwnerDirectives,
  findCapturedTwin,
  OWNER_DIRECTIVE_DEFAULT_OWNER,
  OWNER_DIRECTIVE_VERBATIM_MAX,
} from '../../owner-directives';

export default defineTool({
  name: 'orders:record',
  profile: 'engineer',
  description:
    "Record an explicit OWNER DIRECTIVE verbatim into the durable owner-directives store. The open row renders ABOVE your loop agenda in every wake, orient, and post-compaction anchor — across session death — until orders:disposition closes it. A supplied sourceTurnRef is the exact idempotency key; without one, the tool can match a recent same-session capture by text. The verbatim text is verified against your transcript's human turns (a miss records loudly as unverified).",
  guidance: {
    when:
      "An owner order reached you WITHOUT a 'YOUR owner directive #N' notice (capture failed, or it came by another channel) — record it verbatim before starting the work.",
    notWhen:
      "The turn already carries 'YOUR owner directive #N': it is recorded; use #N (a re-record returns #N). Notes-to-self, peer requests, standing conclusions. Never paraphrase.",
    chaining:
      'orders:record when the order lands → work it → orders:disposition { id, status, note } when done or declined. orders:list { open: true } shows what you still owe.',
    seeAlso: ['orders:disposition (close one)', 'orders:list (open set)', 'orders:get (full verbatim)'],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    verbatim: z
      .string()
      .min(4)
      .max(OWNER_DIRECTIVE_VERBATIM_MAX)
      .describe("The owner's directive VERBATIM — their literal words, never your paraphrase."),
    sourceTurnRef: z
      .string()
      .max(300)
      .optional()
      .describe('Optional pointer to the OWNER (interactive) turn it came from (session id / turn ts / msg id).'),
    ownerName: z
      .string()
      .max(120)
      .optional()
      .describe("Deprecated, ignored: every row is stored under the single workspace owner ('owner') so one message never splits across two owner labels."),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId() ?? 'default';

    // Tier-3 provenance: does this exact text appear as a HUMAN turn in the
    // caller's own transcript? Best-effort — an IO miss degrades the stamp,
    // never blocks the record (a dropped record is the failure this tool fixes).
    let provenance = 'unverified';
    let sessionRef: string | null = null;
    let verifiedTurnRef: string | null = null;
    try {
      const { resolveRelayProvenance } = await import('../coordination/relay-provenance-resolve');
      const { stamp } = await resolveRelayProvenance(identity, { relayQuote: args.verbatim });
      if (stamp?.tier === 'owner-verified-transcript' || stamp?.tier === 'owner-verified-turn') {
        provenance = stamp.tier;
        sessionRef = stamp.sessionId ?? null;
        verifiedTurnRef = [stamp.sessionId, 'turnTs' in stamp ? stamp.turnTs : null].filter(Boolean).join('@') || null;
      }
    } catch {
      /* stamp stays unverified */
    }

    const sourceTurnRef = args.sourceTurnRef ?? verifiedTurnRef;

    // P-004: preserve the legacy same-session text recovery unless the caller
    // explicitly supplied an exact turn key. A provenance-derived key alone must
    // not bypass that recovery, while an explicit key must not collapse a later,
    // identical owner turn through a text match.
    if (args.sourceTurnRef === undefined) {
      const twin = await findCapturedTwin({ workspaceId, recordedBy: identity.ownerId, verbatimText: args.verbatim })
        .catch(() => null);
      if (twin) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                id: twin.id,
                deduplicated: true,
                state: twin.dispositionStatus ?? 'open',
                note: `Already captured automatically as your directive #${twin.id}; no second row was created. Refer to it as #${twin.id}.`,
              }),
            },
          ],
        };
      }
    }

    const row = await recordOwnerDirective({
      workspaceId,
      // D-004: one owner label for every row, whichever path wrote it.
      ownerId: OWNER_DIRECTIVE_DEFAULT_OWNER,
      sessionRef,
      sourceTurnRef,
      verbatimText: args.verbatim,
      recordedBy: identity.ownerId,
    });

    if (sourceTurnRef && row.sourceTurnRef === sourceTurnRef && row.verbatimText !== args.verbatim) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'source_turn_ref_conflict',
              hint: 'This sourceTurnRef already belongs to a different verbatim owner turn; no duplicate was created.',
            }),
          },
        ],
      };
    }

    if (sourceTurnRef && row.capturedByHook && row.sourceTurnRef === sourceTurnRef) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              id: row.id,
              deduplicated: true,
              state: row.dispositionStatus ?? 'open',
              note: `Already captured automatically as your directive #${row.id}; no second row was created. Refer to it as #${row.id}.`,
            }),
          },
        ],
      };
    }
    const openCount = await countOpenOwnerDirectives(workspaceId).catch(() => null);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            id: row.id,
            provenance,
            ...(openCount != null ? { openCount } : {}),
            note:
              provenance === 'unverified'
                ? 'RECORDED, but the text was NOT found as a human turn in your transcript — confirm these are the owner\'s literal words, not your paraphrase. It renders above your agenda every wake until orders:disposition.'
                : 'Recorded (owner-turn verified). It renders above your agenda every wake until orders:disposition closes it.',
          }),
        },
      ],
    };
  },
});
