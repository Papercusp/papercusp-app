/**
 * List audit log entries for the current workspace.
 *
 * v1 is COARSE high-tier: returns every audit row in the workspace.
 * Per-row capability filtering (where an agent sees only rows whose
 * underlying capability they hold) is deferred to v1.5; it requires a
 * `required_capability` column on every audit producer (substrate +
 * plugins), which is fan-out work. For v1, `audit:read` is gated as
 * high-tier in capability-tiers.ts, so the install-time consent prompt
 * surfaces this as substantial trust.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';

/**
 * Smallest value `sinceTs` will accept as epoch milliseconds (2001-09-09).
 *
 * Exported so the test asserts against the SAME constant the schema enforces
 * rather than a transcribed literal — a hardcoded copy in the test would keep
 * passing if this were ever retuned, which is the failure mode that makes a
 * guard look sound while it silently stops guarding.
 */
export const MS_EPOCH_FLOOR = 1_000_000_000_000;

export default defineTool({
  name: 'audit:list',
  needsWorkspaceTx: true,
  profile: 'engineer',
  capability: 'audit:read',
  guidance: {
    when: 'User asks "what happened recently?", "who did X?", or you need a forensic timeline of agent + user actions.',
    notWhen: 'For ACTIVE / in-flight work, use `harness:status` or `actions:recent`. Audit is a write-log, not a live view.',
  },
  args: z.object({
    detail: z.enum(['summary', 'full']).default('summary'),
    actor: z.string().optional(),
    action: z.string().optional(),
    // EI-20216014898419956: the NAME half of this is already handled — `since`
    // resolves to `sinceTs` through tooldef's edit-distance rung (distance 2,
    // threshold 2), so a caller who guesses the neighbouring tools' spelling is
    // told the right key. What no rung can supply is the SHAPE, and this arg
    // was the bad case for it: epoch seconds is a valid integer, so the wrong
    // unit used to be ACCEPTED and silently match ~every row rather than
    // erroring — a wrong-unit forensic query returned a full result set that
    // reads exactly like a real one. Describing that trap only documented it;
    // the floor below removes it, turning a silent wrong answer into a refusal
    // that names the repair.
    //
    // Why 1e12 specifically: it is 2001-09-09 in ms, and epoch SECONDS does
    // not reach 1e12 until the year ~33658 — so the two units cannot overlap
    // on either side of it. Measured 2026-09-05 against the live table: 65,463
    // rows, min(ts) = 1777081562872, ZERO below 1e12. Nothing real is excluded.
    sinceTs: z
      .number()
      .int()
      .min(
        MS_EPOCH_FLOOR,
        'sinceTs is epoch MILLISECONDS, and this value is far too small to be one — it is almost ' +
          'certainly epoch SECONDS (multiply by 1000). This is refused rather than accepted because ' +
          'as a plain integer it would match essentially every row, returning a full result set that ' +
          'is indistinguishable from a correctly-filtered one.',
      )
      .optional()
      .describe(
        'Lower bound on `ts`, in epoch MILLISECONDS (rows are written with `Date.now()`). ' +
          'Epoch SECONDS is REJECTED rather than silently accepted: values below 1e12 are refused ' +
          'with a message naming the fix, because as plain integers they would match essentially ' +
          'every row and return a full result set instead of an error. ' +
          'Unlike `scheduler:pull_ledger.sinceTs`, this is not an ISO string.',
      ),
    limit: z.number().int().positive().max(500).default(100),
    // EI-61: consumed by the dispatch layer BEFORE the handler runs
    // (effectiveDispatchWorkspace, EI-30 — tx synthesis + ALS pin); the
    // handler itself ignores it. Declared here so the advertised
    // inputSchema (additionalProperties:false) lets unscoped superuser
    // clients discover + pass it instead of dying on workspace_required.
    workspace: z
      .string()
      .optional()
      .describe(
        'Per-call workspace scope for an UNSCOPED superuser session (workspaceId "*") — dispatches under this workspace. Ignored when the session is already workspace-scoped.',
      ),
  }),
  // Output schema (token-efficient-tool-result-formats P-011): the default
  // `summary` shape is a flat array of scalar-only rows → unlocks CSV (the
  // densest format) and the MCP `outputSchema` advertisement. `detail: 'full'`
  // additionally returns a nested `details` per row; the serializer's runtime
  // flatness check downgrades those to TOON gracefully, so declaring the
  // summary shape is correct + lossless for both modes.
  result: z.array(
    z.object({
      id: z.string(),
      ts: z.number(),
      actor: z.string(),
      action: z.string(),
      subject: z.string(),
    }),
  ),
  async handler(args, ctx) {
    const rows: Array<{ id: string; ts: number; actor: string; action: string; subject: string; details: unknown }> = await ctx.tx`
      SELECT id, ts, actor, action, subject, details
        FROM harness_shared.audit_log
       WHERE (${args.actor ?? null}::text IS NULL OR actor = ${args.actor ?? null})
         AND (${args.action ?? null}::text IS NULL OR action = ${args.action ?? null})
         AND (${args.sinceTs ?? null}::bigint IS NULL OR ts >= ${args.sinceTs ?? null})
       ORDER BY ts DESC
       LIMIT ${args.limit}
    `;
    if (args.detail === 'summary') {
      return {
        data: rows.map((r) => ({
          id: r.id,
          ts: r.ts,
          actor: r.actor,
          action: r.action,
          subject: r.subject,
        })),
      };
    }
    return { data: rows };
  },
});
