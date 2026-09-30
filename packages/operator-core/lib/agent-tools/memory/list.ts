/**
 * memory:list — browse all entries for the current user.
 *
 * Mostly used by the /settings/user/memory UI and the TUI Memory tab.
 * Brain can call it for filter-only queries (e.g. "show me all
 * corrections") that don't benefit from semantic search.
 *
 * Storage rides the neutral `MemoryBackend` seam. RESPONSE CONTRACT
 * (byte-stable — the TUI Memory tab consumes it): { ok, reason?,
 * results: [{ id, memory, metadata }] }.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getMemoryBackend, MemoryUnavailableError } from '../../memory/backend';
import { MemoryTimeoutError, withMemoryToolTimeout } from '../../memory/op-deadline';
import { getSessionUserOrDefault } from '../../auth';
import { toWireRow } from './search';

// `ephemeral` retired (docs-and-memory-as-projections D-006) — the store holds
// only stable facts. Filter enum unified on the Claude-file taxonomy
// (memory-taxonomy-and-debt-followups D-001); the live store's legacy mem0
// rows were migrated in the same pass, so no legacy kinds linger.
const KINDS = ['user', 'feedback', 'project', 'reference'] as const;

export default defineTool({
  name: 'memory:list',
  capability: 'memory:read',
  description:
    'List all memories for the current user. Supports filtering by kind and harness scope.',
  guidance: {
    when:
      'When the user asks to inspect their memory ("what have you stored about me?") or you need a filter-only query. Default listing returns only facts CURRENT now. Pass `as_of:<ISO timestamp>` for the rows valid at a historical instant, or `include_superseded:true` for the full lifecycle; temporal rows carry `metadata.validity`.',
    notWhen:
      'For semantic lookup ("what did I say about X?"), use memory:search instead.',
    chaining:
      'Use the returned ids with memory:remember { supersede:<old-id> } when a NEW fact replaces an old one, memory:update for an in-place correction, or memory:forget { soft:true } when a fact stopped being true but should remain in history.',
    seeAlso: [
      'memory:search (semantic recall instead of a metadata filter)',
      'memory:update (amend a memory you found)',
      'memory:forget (drop one that is wrong)',
    ],
  },
  // Principal-gated is defineTool's DEFAULT (unauthed HTTP → 401); the former
  // `requirePrincipal: true` marker was not a declared input property and made
  // every overload fail (memory-taxonomy-and-debt-followups P-004).
  // The memory store is cross-workspace by design (shared tables scoped by
  // user-id / harness-slug, not by workspace; the handler reads getMemoryBackend,
  // never ctx.tx). crossWorkspace:true hands an UNSCOPED superuser session ('*')
  // the admin handle + a synthesized principal, so this works from a psu / fleet
  // session instead of failing `workspace_required` (EI-210 — the workspace-tx
  // gate was wrongly applied to memory:list; search + remember already carry this).
  crossWorkspace: true,
  // NOTE: agentRoles/rolesQuota are not accepted on principal-gated tools —
  // definePrincipalGatedTool drops them (never copied to the def, never
  // enforced); the all-roles lists + quotas formerly here were dead inputs
  // (memory-taxonomy-and-debt-followups P-004).
  args: z.object({
    kind: z.enum(KINDS).optional(),
    harness_slug: z.string().optional(),
    hive_slug: z.string().optional()
      .describe("Also list the Pot's shared pool (seeded learnings + recorded conventions — knowledge-packs P-004)."),
    as_of: z.string().max(64)
      .refine((v) => Number.isFinite(new Date(v).getTime()), 'as_of must be a parseable ISO 8601 timestamp')
      .optional()
      .describe('TEMPORAL (temporal-lite): point-in-time listing — only memories whose UTC half-open validity window covers this ISO timestamp (valid_at <= as_of < invalid_at). When combined with include_superseded, this window remains authoritative. Entries carry metadata.validity.'),
    include_superseded: z.boolean().optional()
      .describe('TEMPORAL (temporal-lite): without as_of, include superseded/soft-forgotten memories across the full lifecycle. With as_of, the UTC point-in-time window is authoritative. Superseded entries carry metadata.validity { status:"superseded", superseded_by }.'),
  }),
  async handler(args) {
    const user = await getSessionUserOrDefault();
    const backend = getMemoryBackend();

    // B1: bound both backend calls with a deadline so a wedged store returns a
    // degraded `memory_timeout` envelope instead of hanging the handler forever.
    try {
      const avail = await withMemoryToolTimeout(backend.available(), 'memory:list available');
      if (!avail.ok) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: avail.reason, results: [] }) }],
        };
      }

      // User pool + (when requested) one harness pool + one hive pool. Kind
      // filtering and the per-pool fan-out are the backend's concern.
      const entries = await withMemoryToolTimeout(
        backend.list({
          scope: [
            user.id,
            ...(args.harness_slug ? [`harness:${args.harness_slug}`] : []),
            ...(args.hive_slug ? [`hive:${args.hive_slug}`] : []),
          ],
          kind: args.kind,
          ...(args.as_of !== undefined ? { asOf: args.as_of } : {}),
          ...(args.include_superseded ? { includeSuperseded: true } : {}),
        }),
        'memory:list list',
      );

      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, results: entries.map(toWireRow) }) }],
      };
    } catch (err) {
      // Degraded-never-silent: a read path returns the { ok:false, reason, results:[] }
      // envelope on a store problem — it never throws a raw 500 at the caller (the TUI
      // Memory tab / settings page render the envelope). memory:search catches BOTH of
      // these; memory:list only caught the timeout, so a mid-flight MemoryUnavailableError
      // (the store going down BETWEEN the available() probe and the list() call) escaped
      // as an unhandled throw. Mirror search's contract.
      if (err instanceof MemoryTimeoutError) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'memory_timeout', results: [] }) }],
        };
      }
      if (err instanceof MemoryUnavailableError) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: err.reason, results: [] }) }],
        };
      }
      throw err;
    }
  },
});
