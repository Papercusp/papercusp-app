/**
 * Durable acceptance for SU owner turns. The existing conversation transcript
 * owns the user text and its source id; the receipt travels on that same turn.
 * A row lock serializes reservations across hosts. No provider is called until
 * the transaction commits, and an unsettled receipt is never executed again.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { SuSessionCommand } from '@papercusp/chat-protocol';
import type { Sql } from 'postgres';
import type { SuSessionCommandOutcome } from './su-session-host';

export type SuOwnerTurn = Extract<SuSessionCommand, { type: 'owner_turn' }>;

export interface SuSessionCommandReceipt {
  fingerprint: string;
  command: SuOwnerTurn;
  acceptedAt: string;
  /** Missing means delivery is uncertain after a host replacement. */
  outcome?: SuSessionCommandOutcome;
}

export interface SuSessionCommandStore {
  reserve(command: SuOwnerTurn, fingerprint: string): Promise<{
    created: boolean;
    receipt: SuSessionCommandReceipt;
  }>;
  finish(command: SuOwnerTurn, fingerprint: string, outcome: SuSessionCommandOutcome): Promise<void>;
}

function receiptKey(command: SuOwnerTurn): string {
  return `su:${command.target.advSessionId}:${command.commandId}`;
}

/** Inject SQL only in tests; production always uses the scoped organization DB. */
export function pgSuSessionCommandStore(options: { sql?: Sql } = {}): SuSessionCommandStore {
  const db = () => options.sql ?? getOrgPg().sql;
  return {
    async reserve(command, fingerprint) {
      const target = command.target;
      const sourceId = receiptKey(command);
      return db().begin(async (sql) => {
        const rows = await sql<{ id: string }[]>`
          SELECT c.id
            FROM harness_shared.agent_chats_consolidated c
           WHERE c.workspace_id = ${target.workspaceId}
             AND c.harness_slug IS NOT DISTINCT FROM ${target.harnessSlug}
             AND c.id = ${target.agentChatId}
             AND c.su_runtime_class = 'su-session'
             AND c.archived_at IS NULL
             AND EXISTS (
               SELECT 1 FROM harness_shared.adv_sessions a
                WHERE a.workspace_id = c.workspace_id AND a.id = ${target.advSessionId}
                  AND a.su_agent_chat_id = c.id AND a.coord_owner_id = ${target.ownerId}
                  AND a.agent = ${target.backend}
                  AND COALESCE(a.session_id, a.su_session_descriptor->'identity'->>'nativeSessionId') = ${target.nativeSessionId}
             )
           FOR UPDATE OF c`;
        if (!rows[0]) throw new Error('SU command target has no writable, identity-bound conversation');
        // Read after acquiring the row lock, so a concurrent reservation sees
        // the committed winner even when its first statement waited for it.
        const previous = await sql<{ receipt: SuSessionCommandReceipt | null }[]>`
          SELECT turn->'su_command' AS receipt
            FROM harness_shared.agent_chats_consolidated c,
                 LATERAL jsonb_array_elements(COALESCE(c.transcript, '[]'::jsonb)) AS turn
           WHERE c.workspace_id = ${target.workspaceId}
             AND c.harness_slug IS NOT DISTINCT FROM ${target.harnessSlug}
             AND c.id = ${target.agentChatId} AND turn->>'source_id' = ${sourceId}
           LIMIT 1`;
        if (previous[0]) {
          if (!previous[0].receipt?.fingerprint) throw new Error('SU command receipt is corrupt; delivery must be reconciled');
          return { created: false, receipt: previous[0].receipt };
        }
        const receipt: SuSessionCommandReceipt = {
          fingerprint, command, acceptedAt: new Date().toISOString(),
        };
        const turn = {
          role: 'user', content: command.content, ts: receipt.acceptedAt,
          source: 'su-session', source_id: sourceId, su_command: receipt,
        };
        await sql`
          UPDATE harness_shared.agent_chats_consolidated
             SET transcript = COALESCE(transcript, '[]'::jsonb) || ${JSON.stringify([turn])}::jsonb,
                 updated_at = ${Date.now()}
           WHERE workspace_id = ${target.workspaceId}
             AND harness_slug IS NOT DISTINCT FROM ${target.harnessSlug}
             AND id = ${target.agentChatId}`;
        return { created: true, receipt };
      });
    },
    async finish(command, fingerprint, outcome) {
      const target = command.target;
      const sourceId = receiptKey(command);
      const rows = await db()`
        UPDATE harness_shared.agent_chats_consolidated c
           SET transcript = jsonb_set(c.transcript, ARRAY[
                 (SELECT (position - 1)::text
                    FROM jsonb_array_elements(c.transcript) WITH ORDINALITY AS turns(turn, position)
                   WHERE turn->>'source_id' = ${sourceId}
                     AND turn->'su_command'->>'fingerprint' = ${fingerprint}
                   LIMIT 1), 'su_command', 'outcome'
               ], ${JSON.stringify(outcome)}::jsonb),
               updated_at = ${Date.now()}
         WHERE c.workspace_id = ${target.workspaceId}
           AND c.harness_slug IS NOT DISTINCT FROM ${target.harnessSlug}
           AND c.id = ${target.agentChatId}
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(c.transcript) AS turn
              WHERE turn->>'source_id' = ${sourceId}
                AND turn->'su_command'->>'fingerprint' = ${fingerprint}
                AND turn->'su_command'->'outcome' IS NULL
           )
         RETURNING c.id`;
      if (rows.length !== 1) throw new Error('SU command receipt was missing, changed, or already settled');
    },
  };
}
