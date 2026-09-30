/**
 * plans:set-item-blocked-by — set/clear one OR many items' `blocked-by:` dependency
 * list (plan-templates-and-rubric-v2-2026-06-20 P-003).
 *
 * The interface audit found no item-field edit beyond status/importance — to change
 * an item's blocked-by you had to plans:edit string-replace the line. This is the
 * structured, surgical, revisioned setter: it rewrites ONLY the `blocked-by:` keyword
 * on the target item line (every other token — status, text, importance, risk,
 * authority, decision refs — preserved), inside the plan lock. Pass an empty array to
 * clear the dependency (the keyword is removed, like setting importance to `normal`).
 *
 * Mirrors plans:set-importance's setImportanceInBody: anchor on the P-NNN id against
 * the fence-masked body, strip the existing keyword, splice the line back by index.
 *
 * Bulk by default (the house keyed-array contract, bulk-endpoint-standardization-
 * 2026-06-21): single { slug, itemId, blockedBy }, many of one plan to the same list
 * { slug, itemIds:[…], blockedBy }, or heterogeneous items:[{ slug, itemId, blockedBy
 * }] → { ok, results:[{ ok, slug, itemId, from, to | error }], counts }. Correlate by
 * { slug, itemId } not array position. Every resolved (workspace,harness,plan)
 * group is one locked candidate: one bad item aborts that group, while independent
 * plan groups still report and commit independently.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { resolvePlanWriteScope } from './_write-scope';
import { maskFences, NOTE_SUFFIX_RE } from './parser';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';
import { softText, clampText, LIMITS } from '../limits';

const PNN = /P-\d{3,}/g;

/**
 * Add / replace / remove the `blocked-by:` keyword on one item line. Returns the
 * prior dependency list (empty when the line carried no keyword). Mirrors
 * setImportanceInBody: anchor on the id, match against the fence-masked body (the
 * item line is outside any fence, so captured groups equal the real text), splice by
 * index. The new keyword is emitted BEFORE any ` — note: …` suffix, never at line end:
 * the parser is order-agnostic, but set-status's note replacement is NOT — its
 * NOTE_SUFFIX_RE matches to end-of-line, so a keyword after the note is destroyed by
 * the next status write (EI-20577635585381178). Exported for tests.
 */
export function setBlockedByInBody(
  body: string,
  itemId: string,
  blockedBy: string[],
): { newBody: string; found: boolean; oldBlockedBy: string[] } {
  const re = new RegExp(
    String.raw`^(\s*[-*]\s+\*\*\s*` +
      itemId.replace(/-/g, '\\-') +
      String.raw`\s*\*\*\s+\x60[a-z-]+\x60\s+)(.*)$`,
    'm',
  );
  const m = re.exec(maskFences(body));
  if (!m) return { newBody: body, found: false, oldBlockedBy: [] };

  const prefix = m[1] ?? '';
  const rest = m[2] ?? '';

  // Strip every existing clause, not just the first one. Repeated legacy
  // markers otherwise survive a replacement and can shadow the current list
  // when the plan parser rebuilds its structured dependency graph.
  const bbRe = /\s*\bblocked-by\s*:\s*(?:P-\d{3,}(?:\s*,\s*)?)+/gi;
  const oldBlockedBy = Array.from(
    new Set(
      Array.from(rest.matchAll(bbRe), (match) => (match[0].match(PNN) ?? []) as string[]).flat(),
    ),
  );

  let restClean = rest.replace(bbRe, '');
  // Tidy whitespace the removal left behind (keyword is normally at line end; if it
  // was mid-line, collapse the resulting double space).
  restClean = restClean.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/g, '');

  // EI-20577635585381178: insert the keyword BEFORE any ` — note: …` suffix, never at
  // line end. NOTE_SUFFIX_RE matches to END OF LINE, and set-status strips an existing
  // note with `rest.replace(NOTE_MARKER_RE, '')` before re-appending the new one — so a
  // keyword appended AFTER the note is swallowed whole by the next status write,
  // silently destroying the dependency edge this tool exists to set. Measured: plan
  // release-build-vm-dev-parity-audit-2026-08-13 item P-006 had `blocked-by: P-002,
  // P-001` applied and eaten 0.4s later by a set-status note write, re-advertising the
  // item as READY and stalling WI-38602 for 43+ consecutive wakes.
  let newRest: string;
  if (blockedBy.length === 0) {
    newRest = restClean;
  } else {
    const clause = ` blocked-by: ${blockedBy.join(', ')}`;
    const noteM = NOTE_SUFFIX_RE.exec(restClean);
    newRest = noteM
      ? `${restClean.slice(0, noteM.index).replace(/[ \t]+$/g, '')}${clause}${restClean.slice(noteM.index)}`
      : `${restClean}${clause}`;
  }
  const newLine = prefix + newRest;
  const newBody = body.slice(0, m.index) + newLine + body.slice(m.index + m[0].length);
  return { newBody, found: true, oldBlockedBy };
}

const BLOCKED_BY = z
  .array(z.string().regex(/^P-\d{3,}$/, 'P-NNN form required'))
  .max(40)
  .describe(
    'Item IDs that must complete before this one can effectively start. Pass [] to clear the dependency (the keyword is removed). Replaces the existing blocked-by list wholesale.',
  );

const itemSpec = z.object({
  slug: z.string().min(1).describe('Plan slug (filename stem).'),
  item: z.string().regex(/^P-\d{3,}$/, 'P-NNN form required'),
  blockedBy: BLOCKED_BY.optional().describe('per-item blocked-by list (else the batch `blockedBy`)'),
  harness: harnessArg.describe('per-item harness (else the batch `harness` default)'),
  rationale: softText(LIMITS.ANNOTATION).optional().describe('per-item revision rationale (else the batch `rationale`). Auto-truncated to 2000 chars if longer.'),
});

const argsSchema = z
  .object({
    harness: harnessArg,
    slug: z.string().min(1).optional().describe('Plan slug (filename stem).'),
    item: z.string().regex(/^P-\d{3,}$/, 'P-NNN form required').optional(),
    blockedBy: BLOCKED_BY.optional(),
    itemIds: z
      .array(z.string().regex(/^P-\d{3,}$/, 'P-NNN form required'))
      .min(1)
      .max(200)
      .optional()
      .describe('set MANY items of the SAME plan `slug` to the same `blockedBy` (homogeneous)'),
    items: z
      .array(itemSpec)
      .min(1)
      .max(200)
      .optional()
      .describe('set many items at once — each { slug, item, blockedBy, harness?, rationale? }'),
    rationale: softText(LIMITS.ANNOTATION)
      .optional()
      .describe('Optional — why the blockers changed. Stored on the plan revision (D-009). Auto-truncated to 2000 chars if longer.'),
  })
  .refine(
    (a) =>
      (a.items?.length ?? 0) > 0 ||
      (Boolean(a.slug) && a.blockedBy !== undefined && ((a.itemIds?.length ?? 0) > 0 || Boolean(a.item))),
    { message: 'pass { slug, item, blockedBy } for one, { slug, itemIds:[…], blockedBy } for many of one plan, or items:[{ slug, item, blockedBy }] for heterogeneous' },
  );

interface BlockedByItem {
  slug: string;
  itemId: string;
  blockedBy: string[];
  harness?: string;
  rationale?: string;
}

interface ResolvedBlockedByItem extends BlockedByItem {
  inputIndex: number;
  workspaceId: string;
  harnessSlug: string;
}

interface BlockedByGroup {
  key: string;
  workspaceId: string;
  harnessSlug: string;
  slug: string;
  items: ResolvedBlockedByItem[];
}

type SetBlockedByGroupValue =
  | {
      ok: true;
      changes: Array<{ inputIndex: number; itemId: string; from: string[]; to: string[] }>;
    }
  | {
      ok: false;
      code: string;
      missingItemIds?: string[];
      dependencyDiagnostics?: unknown[];
    };

function groupRationale(items: ResolvedBlockedByItem[]): string | undefined {
  const rationales = [
    ...new Set(
      items
        .map((item) => clampText(item.rationale, LIMITS.ANNOTATION))
        .filter((rationale): rationale is string => Boolean(rationale)),
    ),
  ];
  if (rationales.length === 0) return undefined;
  return clampText(rationales.join(' | '), LIMITS.ANNOTATION) ?? undefined;
}

function atomicAbortResults(
  group: BlockedByGroup,
  failedItemIds: ReadonlySet<string>,
  cause: string,
): Array<{ inputIndex: number; result: BulkItemResult }> {
  return group.items.map((item) => ({
    inputIndex: item.inputIndex,
    result: failedItemIds.has(item.itemId)
      ? { ok: false, slug: item.slug, itemId: item.itemId, error: cause }
      : {
          ok: false,
          slug: item.slug,
          itemId: item.itemId,
          error: 'atomic_group_aborted',
          cause,
          failedItemIds: [...failedItemIds],
        },
  }));
}

/**
 * Apply every change for one resolved plan in ONE withPlanLock transaction. The
 * local body is mutated completely before P-008/P-009 evaluates the final graph,
 * so a caller can atomically reorient edges without a rejected/visible
 * intermediate graph. Any bad item or final candidate leaves the whole group
 * untouched.
 */
async function setBlockedByGroup(
  group: BlockedByGroup,
  ctx: UnifiedToolContext,
): Promise<Array<{ inputIndex: number; result: BulkItemResult }>> {
  const selfBlocked = new Set(
    group.items.filter((item) => item.blockedBy.includes(item.itemId)).map((item) => item.itemId),
  );
  if (selfBlocked.size > 0) return atomicAbortResults(group, selfBlocked, 'self_block');

  const rev = planRevisionCapture(
    ctx as PlanRevisionCtx,
    group.slug,
    groupRationale(group.items),
    { workspaceId: group.workspaceId, harnessSlug: group.harnessSlug },
  );

  const result = await withPlanLock<SetBlockedByGroupValue>(
    ctx as never,
    {
      slug: group.slug,
      intent: `plans:set-item-blocked-by atomic batch (${group.items.map((item) => item.itemId).join(', ')})`,
      workspaceId: group.workspaceId,
      harnessSlug: group.harnessSlug,
      afterWrite: rev.afterWrite,
    },
    async (current): Promise<{ newBody: string | null; value: SetBlockedByGroupValue }> => {
      if (current === null) return { newBody: null, value: { ok: false, code: 'not_found' } };

      let candidate = current;
      const changes: Array<{ inputIndex: number; itemId: string; from: string[]; to: string[] }> = [];
      const missingItemIds: string[] = [];
      for (const item of group.items) {
        const mutation = setBlockedByInBody(candidate, item.itemId, item.blockedBy);
        if (!mutation.found) {
          missingItemIds.push(item.itemId);
          continue;
        }
        candidate = mutation.newBody;
        changes.push({
          inputIndex: item.inputIndex,
          itemId: item.itemId,
          from: mutation.oldBlockedBy,
          to: item.blockedBy,
        });
      }
      if (missingItemIds.length > 0) {
        return {
          newBody: null,
          value: { ok: false, code: 'item_not_found', missingItemIds },
        };
      }
      return {
        newBody: bumpUpdatedDate(candidate),
        value: { ok: true, changes },
      };
    },
  );

  if (result.kind === 'busy') {
    const busy = result.busy.map((b) => ({
      path: b.path,
      owner_label: b.owner_label,
      intent: b.intent,
      expires_ts: b.expires_ts,
    }));
    return group.items.map((item) => ({
      inputIndex: item.inputIndex,
      result: { ok: false, slug: item.slug, itemId: item.itemId, error: 'busy', busy },
    }));
  }
  if (!result.value.ok) {
    const failure = result.value;
    if (failure.code === 'item_not_found') {
      return atomicAbortResults(group, new Set(failure.missingItemIds ?? []), 'item_not_found');
    }
    const dependencyDiagnostics =
      result.dependencyDiagnostics ?? failure.dependencyDiagnostics;
    return group.items.map((item) => ({
      inputIndex: item.inputIndex,
      result: {
        ok: false,
        slug: item.slug,
        itemId: item.itemId,
        error: failure.code,
        ...(dependencyDiagnostics?.length ? { dependencyDiagnostics } : {}),
      },
    }));
  }

  // Refresh the per-plan item rail so a blocked-by-derived view updates immediately.
  try {
    const { notifySyncInvalidate } = await import('../../sync-sse');
    await notifySyncInvalidate('planItems.byPlan', { planSlug: group.slug });
  } catch {
    /* best-effort — the next natural refresh picks it up */
  }

  const changes = new Map(result.value.changes.map((change) => [change.inputIndex, change]));
  return group.items.map((item) => {
    const change = changes.get(item.inputIndex)!;
    return {
      inputIndex: item.inputIndex,
      result: {
        ok: true,
        slug: item.slug,
        itemId: item.itemId,
        from: change.from,
        to: change.to,
        filePath: result.filePath,
        revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
        ...(result.dependencyDiagnostics?.length
          ? { dependencyDiagnostics: result.dependencyDiagnostics }
          : {}),
      },
    };
  });
}

export default defineTool({
  name: 'plans:set-item-blocked-by',
  description:
    "Set or clear one OR many items' `blocked-by:` dependency list — surgical (only the target item line's keyword changes; status/text/importance preserved), inside the plan lock, records a revision. Pass blockedBy:[] to clear. Single: { slug, item, blockedBy }. Many of one plan: { slug, itemIds:[…], blockedBy }. Heterogeneous: items:[{ slug, item, blockedBy }]. Every resolved plan group is atomic: all its edits form one validated candidate or none land; independent plan groups still proceed. Returns { ok, results:[{ ok, slug, itemId, from, to | error }], counts } — correlate by { slug, itemId }, not position.",
  guidance: {
    when: "An item's dependencies change — a new prerequisite surfaced, or a blocker cleared (blockedBy:[] to un-block). The structured alternative to a plans:edit on the item line. Set several at once via itemIds:[…] (one plan) or items:[…].",
    notWhen:
      'Flipping lifecycle status (plans:set-status) or importance (plans:set-importance). Moving an item to another phase (plans:set-item-phase).',
    chaining: 'plans:get-item { slug, item } to see current blockers → plans:set-item-blocked-by.',
    seeAlso: [
      'plans:get-item (see the current blockers first)',
      'plans:set-status (mark the item blocked)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const list: BlockedByItem[] = args.items?.length
      ? args.items.map((it) => ({
          slug: it.slug,
          itemId: it.item,
          blockedBy: it.blockedBy ?? (args.blockedBy as string[]),
          harness: it.harness ?? args.harness,
          rationale: it.rationale ?? args.rationale,
        }))
      : args.itemIds?.length
        ? args.itemIds.map((itemId) => ({
            slug: args.slug as string,
            itemId,
            blockedBy: args.blockedBy as string[],
            harness: args.harness,
            rationale: args.rationale,
          }))
        : [
            {
              slug: args.slug as string,
              itemId: args.item as string,
              blockedBy: args.blockedBy as string[],
              harness: args.harness,
              rationale: args.rationale,
            },
          ];
    // Resolve the canonical plan write key before grouping. Grouping on the raw
    // harness arg is incorrect because member harnesses collapse to their Hive
    // home; two syntactically different args can still name the same plan row.
    const scoped = await runBulk(list, async (item, inputIndex) => {
      const sctx = harnessScopedCtx(item.harness, ctx);
      const scope = await resolvePlanWriteScope(sctx);
      return {
        ok: true as const,
        resolved: {
          ...item,
          blockedBy: [...new Set(item.blockedBy)],
          inputIndex,
          workspaceId: scope.workspaceId,
          harnessSlug: scope.harnessSlug,
        } satisfies ResolvedBlockedByItem,
      };
    }, {
      keyOf: (item) => ({ slug: item.slug, itemId: item.itemId }),
    });

    const resultsByIndex = new Map<number, BulkItemResult>();
    const groups = new Map<string, BlockedByGroup>();
    scoped.results.forEach((scopeResult, inputIndex) => {
      if (!scopeResult.ok) {
        resultsByIndex.set(inputIndex, scopeResult);
        return;
      }
      const resolved = (scopeResult as typeof scopeResult & { resolved: ResolvedBlockedByItem }).resolved;
      const key = JSON.stringify([resolved.workspaceId, resolved.harnessSlug, resolved.slug]);
      const group = groups.get(key) ?? {
        key,
        workspaceId: resolved.workspaceId,
        harnessSlug: resolved.harnessSlug,
        slug: resolved.slug,
        items: [],
      };
      group.items.push(resolved);
      groups.set(key, group);
    });

    await runBulk(
      [...groups.values()],
      async (group) => {
        try {
          for (const { inputIndex, result } of await setBlockedByGroup(group, ctx)) {
            resultsByIndex.set(inputIndex, result);
          }
          return { ok: true, group: group.key };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          for (const item of group.items) {
            resultsByIndex.set(item.inputIndex, {
              ok: false,
              slug: item.slug,
              itemId: item.itemId,
              error: message,
            });
          }
          return { ok: false, group: group.key, error: message };
        }
      },
      { keyOf: (group) => ({ group: group.key }) },
    );

    const env = await runBulk(
      list,
      async (item, inputIndex) =>
        resultsByIndex.get(inputIndex) ?? {
          ok: false,
          slug: item.slug,
          itemId: item.itemId,
          error: 'atomic_group_result_missing',
        },
      { keyOf: (item) => ({ slug: item.slug, itemId: item.itemId }) },
    );
    return bulkContent(env);
  },
});
