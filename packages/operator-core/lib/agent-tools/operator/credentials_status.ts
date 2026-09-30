/**
 * operator:credentials_status — return masked credential status for
 * every voice provider (set / not-set + masked tail). Read-only.
 *
 * Writes (storing API keys) intentionally stay on the legacy
 * /api/agent-mcp/operator-credentials PUT route. Letting agents
 * write raw third-party keys via MCP is a bigger security commitment
 * than just exposing read-status; do it via a separate principal-
 * bound built-in if/when that's actually needed.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import {
  maskKey,
  readCartesiaKey,
  readDeepgramKey,
  readElevenLabsKey,
  readOpenAiKey,
  readPicovoiceKey,
} from '../../voice-credentials';
import { maskIntegrationKey, readIntegrationKey } from '../../integration-credentials';

const INTEGRATION_KEY_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

export default defineTool({
  name: 'operator:credentials_status',
  profile: 'engineer',
  description:
    'Masked credential status for voice providers plus an optional encrypted integration credential lookup by name. Read-only — never returns raw keys. Integration lookup distinguishes missing from saved-not-injected.',
  capability: 'secrets:operator-credentials:read',
  guidance: {
    when: `Check which API credentials (EL, OpenAI, etc.) are configured + valid. Used in onboarding + diagnostics.`,
    notWhen: `For SETTING credentials, use the /settings UI directly — agents shouldn't paste secrets.`,
    seeAlso: ['accounts:status (per-account credential / rate status)', 'accounts:list (registered accounts)'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    integration_name: z
      .string()
      .regex(INTEGRATION_KEY_NAME_RE, 'integration_name must be SCREAMING_SNAKE_CASE')
      .nullable()
      .optional()
      .describe('Optional setup:save_integration_key name to inspect without returning its raw value.'),
  }),
  async handler(args) {
    const [el, openai, cartesia, deepgram, picovoice, integration] = await Promise.all([
      // Status is the deliberate raw-reader exception: show a masked legacy
      // value so it can be replaced, while outbound reads stay fail-closed.
      readElevenLabsKey({ allowInvalid: true }),
      readOpenAiKey(),
      readCartesiaKey(),
      readDeepgramKey(),
      readPicovoiceKey(),
      args.integration_name ? readIntegrationKey(args.integration_name) : Promise.resolve(undefined),
    ]);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            elevenlabs: { set: !!el, masked: maskKey(el) },
            openai: { set: !!openai, masked: maskKey(openai) },
            cartesia: { set: !!cartesia, masked: maskKey(cartesia) },
            deepgram: { set: !!deepgram, masked: maskKey(deepgram) },
            picovoice: { set: !!picovoice, masked: maskKey(picovoice) },
            ...(args.integration_name
              ? {
                  integration: {
                    name: args.integration_name,
                    saved: !!integration,
                    masked: maskIntegrationKey(integration),
                    status: integration ? 'saved_not_injected' : 'missing',
                  },
                }
              : {}),
          }),
        },
      ],
    };
  },
});
