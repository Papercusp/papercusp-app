/**
 * POST /api/auth/workos/webhook — signed WorkOS lifecycle event intake.
 *
 * `auth: 'public'` opts out of Papercusp principal authentication because the
 * raw-body WorkOS signature is this endpoint's authentication mechanism.
 */

import { defineTool } from '@papercusp/agent-mcp';
import {
  intakeWorkOsWebhook,
  WorkOsWebhookIntakeError,
  type WorkOsWebhookReceiptResult,
} from '../../../auth/hosted/workos-webhook-intake';

type WorkOsWebhookIntake = (input: Parameters<typeof intakeWorkOsWebhook>[0]) => Promise<WorkOsWebhookReceiptResult>;

export interface WorkOsWebhookLogger {
  info(message: string, details: Record<string, unknown>): void;
  warn(message: string, details: Record<string, unknown>): void;
}

export interface WorkOsWebhookRouteDependencies {
  intake?: WorkOsWebhookIntake;
  secret?: () => string | undefined | Promise<string | undefined>;
  signatureKeyRef?: () => string | undefined;
  logger?: WorkOsWebhookLogger;
}

const defaultLogger: WorkOsWebhookLogger = {
  info: (message, details) => console.info(message, details),
  warn: (message, details) => console.warn(message, details),
};

export function createWorkOsWebhookRoute(dependencies: WorkOsWebhookRouteDependencies = {}) {
  const intake = dependencies.intake ?? intakeWorkOsWebhook;
  const secret = dependencies.secret ?? (() => process.env.WORKOS_WEBHOOK_SECRET);
  const signatureKeyRef = dependencies.signatureKeyRef ?? (() => process.env.WORKOS_WEBHOOK_SECRET_KEY_REF);
  const logger = dependencies.logger ?? defaultLogger;

  return defineTool({
    method: 'POST',
    path: '/auth/workos/webhook',
    auth: 'public',
    async handler(request) {
      try {
        const result = await intake({
          request,
          secret: await secret(),
          signatureKeyRef: signatureKeyRef(),
        });
        logger.info('[auth/workos-webhook] accepted', {
          code: 'accepted',
          eventId: result.eventId,
          eventType: result.eventType,
          deduplicated: result.deduplicated,
        });
        return Response.json({
          ok: true,
          event_id: result.eventId,
          event_type: result.eventType,
          deduplicated: result.deduplicated,
        });
      } catch (error) {
        const known =
          error instanceof WorkOsWebhookIntakeError
            ? error
            : new WorkOsWebhookIntakeError('enqueue_failed', 503, true, 'Webhook intake is temporarily unavailable.');
        logger.warn('[auth/workos-webhook] rejected', {
          code: known.code,
          retryable: known.retryable,
        });
        return Response.json(
          { ok: false, error: { code: known.code, retryable: known.retryable } },
          { status: known.status },
        );
      }
    },
  });
}

export default createWorkOsWebhookRoute();
