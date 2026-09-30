/**
 * POST /api/agent-mcp/recovery-audit/reconcile
 *
 * Replays the owner-only ~/.papercusp/recovery/audit.jsonl into the canonical
 * workspace audit log after an operator outage. The local file is the offline
 * source of truth; this endpoint is deliberately a thin, idempotent sink.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { isLoopbackRequest, isValidSuperuserBearer } from '../../../superuser-token';

const IdentitySchema = z.object({
  uid: z.number().int().nonnegative().nullable(),
  username: z.string().min(1).max(256),
  hostname: z.string().min(1).max(256),
}).strict();

const ClientSchema = z.object({
  name: z.literal('psu'),
  version: z.string().min(1).max(256),
}).strict();

const CommandSchema = z.object({
  argv: z.array(z.string().max(4_096)).max(64),
  cwd: z.string().max(4_096),
}).strict();

export const RecoveryAuditEventSchema = z.object({
  version: z.literal(1),
  eventId: z.string().uuid(),
  event: z.enum(['authorized', 'execution-started', 'execution-finished', 'execution-refused']),
  at: z.string().datetime({ offset: true }),
  atMs: z.number().int().positive(),
  grantId: z.string().uuid(),
  capability: z.literal('diagnostic-command'),
  identity: IdentitySchema,
  client: ClientSchema,
  reason: z.string().min(1).max(2_000),
  command: CommandSchema,
  outcome: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((event, ctx) => {
  if (Math.abs(Date.parse(event.at) - event.atMs) > 1_000) {
    ctx.addIssue({ code: 'custom', path: ['atMs'], message: 'at and atMs disagree' });
  }
  if (event.event !== 'execution-refused' && event.command.argv.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['command', 'argv'], message: 'executed event requires argv' });
  }
});

const BodySchema = z.object({
  events: z.array(RecoveryAuditEventSchema).min(1).max(100),
}).strict();

export function recoveryAuditRowId(eventId: string): string {
  return `psu-recovery:${eventId}`;
}

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/recovery-audit/reconcile',
  auth: 'loopback',
  async handler(req) {
    const authHeader = req.headers.get('authorization') ?? '';
    const bearer = authHeader.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null;
    if (!isLoopbackRequest(req.headers) || !isValidSuperuserBearer(bearer)) {
      return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json(
        { ok: false, error: 'validation_failed', issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const workspaceId = activeWorkspaceId();
    const { sql } = getOrgPg();
    const reconciledEventIds: string[] = [];
    try {
      for (const event of parsed.data.events) {
        const details = {
          recoveryProtocolVersion: event.version,
          localEventId: event.eventId,
          localAt: event.at,
          identity: event.identity,
          client: event.client,
          reason: event.reason,
          command: event.command,
          ...(event.outcome ? { outcome: event.outcome } : {}),
        };
        await sql`
          INSERT INTO harness_shared.audit_log
            (id, ts, actor, action, subject, details, workspace_id)
          VALUES (
            ${recoveryAuditRowId(event.eventId)},
            ${event.atMs},
            ${`owner:${event.identity.username}`},
            ${`psu.recovery.${event.event}`},
            ${event.grantId},
            ${JSON.stringify(details)}::text::jsonb,
            ${workspaceId}
          )
          ON CONFLICT (id) DO NOTHING
        `;
        // A deterministic id makes an already-present row equivalent to a
        // successful retry. The client checkpoints exactly these ids locally.
        reconciledEventIds.push(event.eventId);
      }
    } catch (error) {
      return Response.json(
        { ok: false, error: 'audit_reconcile_failed', detail: (error as Error)?.message },
        { status: 503 },
      );
    }

    return Response.json({ ok: true, reconciledEventIds });
  },
});
