import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  maskIntegrationKey,
  readIntegrationCredentials,
  writeIntegrationCredentials,
} from '../../integration-credentials';

/**
 * setup:save_integration_key — save a THIRD-PARTY integration API key (one
 * that is NOT one of the 4 closed platform keys `setup:save_key` handles)
 * into the PG-backed `operator_integration_credentials` store, encrypted at
 * rest. Storage policy: a secret NEVER goes into a tree file.
 *
 * Example: a user hands over a WeatherAPI key for a future weather widget
 * (owner-ask-batch-2026-07-06 P-002) — this is where it goes, keyed by a
 * caller-chosen name like `WEATHERAPI_API_KEY`.
 */
const NAME_RE = /^[A-Z][A-Z0-9_]+$/;
export const INTEGRATION_KEY_NAME_MAX_LENGTH = 255;
export const INTEGRATION_KEY_VALUE_MAX_LENGTH = 16 * 1024;

export const saveIntegrationKeyArgsSchema = z.object({
  name: z
    .string()
    .min(3)
    .max(INTEGRATION_KEY_NAME_MAX_LENGTH)
    .regex(NAME_RE, 'SCREAMING_SNAKE_CASE, 3-255 chars, starting with a letter')
    .describe('Stable key name the consuming feature will look up, e.g. WEATHERAPI_API_KEY'),
  value: z
    .string()
    .min(4)
    .max(INTEGRATION_KEY_VALUE_MAX_LENGTH)
    .describe('The raw secret; stored encrypted, never logged'),
});

export default defineTool({
  name: 'setup:save_integration_key',
  profile: 'engineer',
  description:
    'Save a third-party integration API key (anything OTHER than the 4 platform keys openai/anthropic/zeroentropy/github_pat — e.g. a weather-widget provider key) into the encrypted operator_integration_credentials store, keyed by a caller-chosen SCREAMING_SNAKE_CASE name. Returns the key MASKED.',
  capability: 'operator:write',
  guidance: {
    when: 'The user hands over an API key/secret for a third-party integration or widget that is not one of the 4 platform provider keys. Choose a stable, descriptive name (e.g. WEATHERAPI_API_KEY) so the feature that consumes it can read it back by the same name.',
    notWhen:
      'The 4 platform provider keys (openai/anthropic/zeroentropy/github_pat) — use setup:save_key for those. Never write ANY secret into a repo file.',
    seeAlso: ['setup:save_key (the 4 platform keys only)'],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'debugger'],
  args: saveIntegrationKeyArgsSchema,
  async handler(args) {
    await writeIntegrationCredentials({ [args.name]: args.value });
    const all = await readIntegrationCredentials();
    return {
      data: { ok: true, name: args.name, masked: maskIntegrationKey(all[args.name]) },
    };
  },
});
