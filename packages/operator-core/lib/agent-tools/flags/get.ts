/**
 * flags:get - resolve one OR many Papercusp feature flags for this host.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21 P-006): pass `key` for one or `keys`
 * for several → { ok, results:[{ ok, key, enabled | error }], counts }. Each
 * result self-describes its key; one unresolvable key never poisons the rest.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

import { ALL_FLAG_KEYS, type FlagKey } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { resolveDistinctId } from '../../flag-distinct-id';
import { mergeIds, runBulk, bulkContent } from '@papercusp/agent-mcp/_bulk';
import './_register-backend';

// EI-1168: NOT a z.enum(ALL_FLAG_KEYS) anymore. A zod enum bakes the key list into
// this TOOL'S SCHEMA at whatever moment this module was last loaded in THIS process —
// a flag added to libs/flags/src/types.ts after that moment is REJECTED at the
// argument-validation layer even though it's already resolvable server-side (flags:list
// reads the same ALL_FLAG_KEYS, so it can disagree with a not-yet-refreshed flags:get/set
// process). Plain string + a runtime membership check (assertKnownFlagKey) still catches
// a genuinely-unknown key, but per-item, through the existing bulk error contract — so a
// key this process's ALL_FLAG_KEYS doesn't (yet) know about fails with a clear message
// instead of a bare zod "invalid enum value", and the schema itself is never stale.
const FlagKeySchema = z.string().min(1).describe('a Papercusp flag key (libs/flags/src/types.ts)');

/** Throws with the current known-key list when `key` isn't a live flag (EI-1168). */
function assertKnownFlagKey(key: string): asserts key is FlagKey {
  if (!(ALL_FLAG_KEYS as readonly string[]).includes(key)) {
    throw new Error(
      `Unknown flag key "${key}" — not in this process's flag registry (libs/flags/src/types.ts). ` +
        `If this flag was just added, the operator process may need a restart to pick it up; ` +
        `check flags:list for the current known set.`,
    );
  }
}

export default defineTool({
  name: 'flags:get',
  profile: 'engineer',
  description:
    'Resolve one OR many Papercusp feature flags to booleans for this host. This is a host-global read; scope selectors are not supported. Pass `key` for one or `keys` for several. Returns { ok, results:[{ ok, key, enabled | error }], counts } — correlate each result by its key, not by position.',
  capability: 'intel:read',
  guidance: {
    when: 'Read the current host-wide value of one or more feature flags before diagnosing or executing gated work.',
    notWhen: 'Do not pass a `scope` selector: this tool accepts only `key` or `keys`, and its read is host-global.',
    seeAlso: [
      'flags:list (all flags + resolved values)',
      'flags:set (flip a flag)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z
    .object({
      key: FlagKeySchema.optional().describe('a single flag key (n=1 shorthand for keys:[key])'),
      keys: z.array(FlagKeySchema).min(1).max(100).optional().describe('flag keys to resolve (1–100)'),
    })
    .refine((a) => Boolean(a.key) || (a.keys?.length ?? 0) > 0, {
      message: 'pass `key` (one) or `keys` (many)',
    })
    .strict(),
  async handler(args) {
    const fakeReq = new Request('http://localhost/agent-tool');
    const distinctId = resolveDistinctId(fakeReq);
    const keys = mergeIds(args.key, args.keys);
    const env = await runBulk(
      keys,
      async (key) => {
        assertKnownFlagKey(key);
        const enabled = await getFlag(key, distinctId);
        return { ok: true as const, key, enabled };
      },
      { keyOf: (key) => ({ key }) },
    );
    return bulkContent(env);
  },
});
