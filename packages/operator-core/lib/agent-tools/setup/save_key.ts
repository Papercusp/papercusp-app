import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { maskSecret, readCredentials, writeCredentials } from '../../credentials';
import { clearOpenAiEmbedHardExhaustion } from '../../memory/configure';

/**
 * setup:save_key — save a pay-per-use provider API key to the credentials
 * store (agent-first-onboarding-2026-07-03 P-004). Same merge semantics as
 * the POST /credentials route; the same allowlisted keys.
 */
const KEYS = ['openai_api_key', 'anthropic_api_key', 'zeroentropy_api_key', 'github_pat'] as const;

export default defineTool({
  name: 'setup:save_key',
  profile: 'engineer',
  description:
    'Save one provider API key (openai_api_key — also used for embeddings —, anthropic_api_key, zeroentropy_api_key, or github_pat) into the operator credentials store. Returns the key MASKED.',
  capability: 'operator:write',
  guidance: {
    when: `Onboarding/tutorial: the user pasted a key for a provider (the OpenAI key notably powers embeddings — better search + agent memory). Never echo the raw key back; the result is already masked.`,
    notWhen: `Agent-CLI sign-ins (claude/codex/omp OAuth) — those run their own login flows in the terminal, not the credentials store.`,
    seeAlso: ['setup:status (keys flips to ok once one is saved)'],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'debugger'],
  args: z.object({
    key: z.enum(KEYS),
    value: z.string().min(8).max(4096).describe('The raw secret; stored, never logged'),
  }),
  async handler(args) {
    const current = await readCredentials();
    const saved = await writeCredentials({ ...current, [args.key]: args.value.trim() });
    // WI-3615: a re-saved openai_api_key is a real reason to believe embeddings might work
    // again — clear the sticky hard-exhaustion latch so 'auto' re-tries OpenAI once instead of
    // staying pinned to local forever (the latch only ever clears on this signal).
    if (args.key === 'openai_api_key') clearOpenAiEmbedHardExhaustion();
    return {
      data: { ok: true, key: args.key, masked: maskSecret(saved[args.key]) },
    };
  },
});
