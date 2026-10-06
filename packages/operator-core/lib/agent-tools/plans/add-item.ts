/**
 * plans:add-item — append one OR many new P-NNN items to a phase.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.2 + §4.4.
 *
 * Allocates the next P-NNN id inside the lock. Two concurrent calls
 * without serialization would produce colliding ids; withPlanLock
 * holds the lock across read → allocate → write.
 *
 * Appends to a phase by its heading text (tolerant match — leading
 * `N. ` numbering stripped). Creates the phase section if it doesn't
 * exist, inserted before `## Decisions` (or at file end).
 *
 * Bulk by default (the house keyed-array contract, bulk-endpoint-standardization-
 * 2026-06-21): single { slug, phase, text, importance }, several to one phase of one
 * plan { slug, phase, importance, items:[{ text, blockedBy? }] }, or fully
 * heterogeneous items:[{ slug, phase, text, importance, … }] → { ok, results:[{ ok,
 * slug, itemId, createdPhase | error }], counts }. Each result embeds the NEWLY
 * ALLOCATED itemId; correlate by { slug, itemId } not array position; one failure
 * never fails the rest. Each item is appended inside its own plan lock so ids never
 * collide.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import {
  findTerminalPlanChildMutations,
  parsePlan,
  maskFences,
  IMPORTANCE_LEVELS,
  type Importance,
  type LegacyReason,
  type TerminalPlanChildMutation,
} from './parser';
import { echoParsedItem } from './item-parse-feedback';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';
import { hardText } from '../limits';

/**
 * EI-8811: normalize a caller-supplied phase heading to satisfy the parser's
 * `/^Phase\b/i` grammar BEFORE the regex below validates it, instead of hard-
 * rejecting a natural phase name (e.g. "Baseline") that doesn't already start
 * with "Phase". Previously a mismatch failed the WHOLE add-item batch (all
 * items share one `phase` arg) — often AFTER a preceding `plans:new` call had
 * already written the plan, leaving it created but itemless. Auto-prefixing
 * ("Baseline" → "Phase — Baseline") means the call succeeds with the caller's
 * intended phase name instead. Exported for reuse by set-item-phase's PHASE
 * (same grammar, same auto-fix) and for direct unit testing.
 */
export function normalizePhaseHeadingInput(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const trimmed = v.trim();
  // A blank/whitespace-only phase is a genuine validation failure, not a
  // naming-convention mismatch — leave it as-is so the schema's `min(1)`
  // still rejects it, instead of silently turning "" into the meaningless
  // "Phase — ".
  if (trimmed.length === 0) return trimmed;
  return /^Phase\b/i.test(trimmed) ? trimmed : `Phase — ${trimmed}`;
}

export const PHASE = z.preprocess(
  normalizePhaseHeadingInput,
  z
    .string()
    .min(1)
    .regex(
      // Fully anchored (^...$, not just a leading ^Phase\b) so the JSON-Schema
      // `pattern` Zod 4 emits is grammar-compilable by strict consumers (Ollama's
      // tool-calling grammar generator 400s the WHOLE catalog on any non-`^...$`
      // pattern: "Pattern must start with '^' and end with '$'" — see
      // packages/agent-mcp/src/tool-schema-sanitize.ts). Semantically identical to
      // the old /^Phase\b/i: only the prefix is constrained, anything may follow.
      /^Phase\b[\s\S]*$/i,
      'Phase heading must start with "Phase" (e.g. "Phase 1 — Tooling") — the plan parser only recognizes /^Phase\\b/i headings as phase sections, so anything else lint-warns as unphased.',
    )
    .describe(
      'Phase heading text without the ## prefix and without numbering, e.g. "Phase 1 — Tooling". If it does not already start with "Phase" it is auto-prefixed (e.g. "Baseline" → "Phase — Baseline", EI-8811) so the call still succeeds using your intended name — the plan parser only recognizes /^Phase\\b/i headings as phase sections.',
    ),
);

const IMPORTANCE = z
  .enum([...IMPORTANCE_LEVELS] as [string, ...string[]])
  .describe(
    'REQUIRED. Item importance — urgent|high|normal|low. urgent = interrupt the human now / pick up first; high = should be seen today; normal = usual cadence; low = safe to defer. No silent default: choose it deliberately from the importance rubric (decide from consequences — "what breaks, and how fast, if this is never seen / picked up last?"). Most routine items are `normal`.',
  );

const BLOCKED_BY = z
  .array(z.string().regex(/^P-\d{3,}$/))
  .describe('Item IDs that must complete before this one can effectively start.');

/**
 * tool-contract-repair-2026-09-05 P-006. `title` and `body` are the names a
 * caller reaches for when adding an item — the plan's own author hit this while
 * FILING that plan ("plans:add-item rejects `title`/`body`, wants `text`").
 *
 * Each name ALONE has exactly one reading here: this tool stores a single item
 * string, so a lone `title` or a lone `body` can only mean that string. Both
 * TOGETHER do not: joining them would invent a separator and a field order the
 * caller never asked for, which is precisely the "fuse two meanings" case the
 * plan's ALIAS-vs-BETTER-ERROR rule reserves for a rejection. So one aliases,
 * two are refused with a message that names the fix. `text` always wins.
 */
const TEXT_ALIAS = z
  .string()
  .optional()
  .describe('Compatibility alias for `text`; `text` wins when both are supplied. Passing BOTH `title` and `body` without `text` is refused — combine them into `text` yourself rather than have this tool guess a separator.');

export function resolveItemText(spec: {
  text?: unknown;
  title?: unknown;
  body?: unknown;
}): { ok: true; text?: string } | { ok: false; reason: 'title-and-body' } {
  if (typeof spec.text === 'string' && spec.text.length > 0) return { ok: true, text: spec.text };
  const hasTitle = typeof spec.title === 'string' && spec.title.length > 0;
  const hasBody = typeof spec.body === 'string' && spec.body.length > 0;
  if (hasTitle && hasBody) return { ok: false, reason: 'title-and-body' };
  if (hasTitle) return { ok: true, text: spec.title as string };
  if (hasBody) return { ok: true, text: spec.body as string };
  return { ok: true };
}

/** The resolved item string, or undefined when absent OR ambiguously specified. */
export function itemTextOrUndefined(spec: {
  text?: unknown;
  title?: unknown;
  body?: unknown;
}): string | undefined {
  const resolved = resolveItemText(spec);
  return resolved.ok ? resolved.text : undefined;
}

const itemSpec = z.object({
  slug: z.string().min(1).optional().describe('per-item plan slug (else the batch `slug`)'),
  phase: PHASE.optional().describe('per-item phase (else the batch `phase`)'),
  text: hardText(4000).optional(),
  title: TEXT_ALIAS,
  body: TEXT_ALIAS,
  blockedBy: BLOCKED_BY.optional(),
  importance: IMPORTANCE.optional().describe('per-item importance (else the batch `importance`)'),
  harness: harnessArg.describe('per-item harness (else the batch `harness` default)'),
  rationale: z.string().optional().describe('per-item revision rationale (else the batch `rationale`)'),
});

// Exported (back-compat name) — the SINGLE-item arg shape, now folded into a
// dual-arity schema that also accepts items:[…].
export const argsSchema = z
  .object({
    slug: z.string().min(1).optional(),
    harness: harnessArg,
    phase: PHASE.optional(),
    text: hardText(4000).optional(),
    title: TEXT_ALIAS,
    body: TEXT_ALIAS,
    blockedBy: BLOCKED_BY.optional(),
    importance: IMPORTANCE.optional(),
    items: z
      .array(itemSpec)
      .min(1)
      .max(200)
      .optional()
      .describe('add many items at once — each { text, importance, phase?, slug?, blockedBy?, harness? }; phase/slug/importance fall back to the batch values'),
    rationale: z
      .string()
      .optional()
      .describe(
        'Optional — a short why for adding this item, if non-obvious. Stored on the plan revision (D-009); routine additions can omit it.',
      ),
  })
  // `title`/`body` alias `text`, but only ONE of them at a time — refuse the
  // ambiguous pair before anything is written (tool-contract-repair P-006).
  .refine(
    (a) =>
      ((a.items?.length ?? 0) > 0 ? a.items! : [a]).every((it) => resolveItemText(it).ok),
    {
      message:
        'pass the item string as `text`. `title` and `body` are each accepted as an alias for it, but not BOTH at once — this tool stores ONE item string, so combine them into `text` yourself rather than have this tool guess a separator and an order you did not specify.',
    },
  )
  // Every item must RESOLVE a slug, phase, text and importance (its own or the batch
  // fallback). The handler dereferences the resolved phase (`as string` casts), so an
  // unresolvable field used to escape validation and crash inside the plan lock with
  // "Cannot read properties of undefined (reading 'slice')".
  //
  // This is a superRefine emitting ONE path-addressed issue per unresolved field, NOT a
  // boolean refine with one static message (EI-23745289035139187): a single message
  // cannot say WHICH of the four fields is still unresolved, so a caller who satisfied
  // one of them got the byte-identical refusal back and had no signal to converge on.
  // Per-field issues make the refusal SHRINK as the input improves, and name the
  // field's type/domain on the FIRST refusal (including that `phase: null` is not
  // accepted — `plans:items` reports phase:null for existing items, which invites it).
  .superRefine((a, ctx) => {
    const bulk = (a.items?.length ?? 0) > 0;
    const targets: Array<{ it: z.infer<typeof itemSpec>; path: Array<string | number> }> = bulk
      ? a.items!.map((it, i) => ({ it, path: ['items', i] }))
      : [{ it: a as z.infer<typeof itemSpec>, path: [] }];
    const where = bulk ? ' (per-item, or once at batch level)' : '';
    for (const { it, path } of targets) {
      if (!(it.slug ?? a.slug)) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'slug'],
          message: `required${where} — the plan slug (string), e.g. "my-plan-2026-01-01".`,
        });
      }
      if (!(it.phase ?? a.phase)) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'phase'],
          message: `required${where} — a phase heading string such as "Phase 1 — Tooling". A name not starting with "Phase" is auto-prefixed ("Baseline" → "Phase — Baseline"); null/"" are not accepted.`,
        });
      }
      // title+body together is already refused by the alias refine above, with its own
      // message — don't pile a misleading "text is missing" on top of it.
      if (resolveItemText(it).ok && !itemTextOrUndefined(it)) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'text'],
          message: `required${where} — the item string, as \`text\` (or its \`title\`/\`body\` alias).`,
        });
      }
      if (!(it.importance ?? a.importance)) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'importance'],
          message: `required${where} — one of ${[...IMPORTANCE_LEVELS].join('|')}; there is no default, choose it deliberately (most routine items are \`normal\`).`,
        });
      }
    }
  });

interface NewItem {
  slug: string;
  phase: string;
  text: string;
  importance: Importance;
  blockedBy?: string[];
  harness?: string;
  rationale?: string;
}

function formatPadded(n: number): string {
  return n.toString().padStart(3, '0');
}

// Matches the `## Decisions` heading (optionally numbered, "## 5. Decisions")
// but not a suffixed variant such as "## Decisions (settled)". Item labels in
// this section are intentionally reserved even when they are prose references:
// a decision can name a not-yet-materialized P-NNN, and allocating that same
// label later makes status/coordination text ambiguous.
const DECISIONS_HEADING_RE = /^##\s+(?:\d+(?:\.\d+)?\.\s+)?Decisions\s*$/m;

function findDecisionsSectionBody(maskedBody: string): string | null {
  const headingMatch = DECISIONS_HEADING_RE.exec(maskedBody);
  if (!headingMatch) return null;
  const after = headingMatch.index + headingMatch[0].length;
  const restAfter = maskedBody.slice(after);
  const nextHeadingMatch = /^##\s/m.exec(restAfter);
  return nextHeadingMatch ? restAfter.slice(0, nextHeadingMatch.index) : restAfter;
}

const DECISION_ITEM_REF_RE = /\bP-(\d{3,})\b/g;

/**
 * Allocate the next P-NNN considering real parsed items AND labels used in the
 * Decisions prose. The scan is limited to the Decisions section and masks
 * fenced examples, so ordinary prose elsewhere (or a worked example) cannot
 * consume the plan's item-number space.
 */
export function allocateNextItemId(body: string): string {
  const parsed = parsePlanLazy(body);
  let max = 0;
  for (const it of parsed.items) {
    const m = /^P-(\d+)$/.exec(it.id);
    if (m) {
      const n = parseInt(m[1] ?? '0', 10);
      if (n > max) max = n;
    }
  }
  const decisionsBody = findDecisionsSectionBody(maskFences(body));
  if (decisionsBody) {
    for (const match of decisionsBody.matchAll(DECISION_ITEM_REF_RE)) {
      const n = parseInt(match[1] ?? '0', 10);
      if (n > max) max = n;
    }
  }
  return `P-${formatPadded(max + 1)}`;
}

// Lazy import-of-parser via a separate name to avoid a circular import
// hazard if parser ever imports add-item helpers in the future.
function parsePlanLazy(body: string): ReturnType<typeof parsePlan> {
  return parsePlan(body);
}

export function buildItemLine(
  itemId: string,
  text: string,
  blockedBy: string[],
  importance: Importance = 'normal',
): string {
  const bbSuffix = blockedBy.length > 0 ? ` blocked-by: ${blockedBy.join(', ')}` : '';
  // Emit the importance keyword only when it departs from the parser
  // default (`normal`) — keeps routine lines clean, mirrors blocked-by.
  const impSuffix = importance !== 'normal' ? ` importance: ${importance}` : '';
  // Grammar guard (WI-3447): an item is ONE physical line — ITEM_LINE_RE's
  // `(.*)$` does not span newlines. A newline in `text` (e.g. a multi-line
  // paste) would split the line, truncating the item and orphaning the rest as
  // stray prose. Collapse any newline-bearing whitespace run to a single space
  // so the built line always parses back to the intended item. Single-line text
  // is unaffected (no newline → no-op).
  const singleLineText = text.trim().replace(/\s*[\r\n]+\s*/g, ' ');
  // Single-line form — preserves the ASCII-canonical examples in the spec.
  return `- **${itemId}** \`todo\` ${singleLineText}${bbSuffix}${impSuffix}`;
}

/**
 * Insert an item line under a named phase heading.
 *
 * If the phase exists: append to the end of that section's items.
 * If it doesn't exist: create the section just before `## Decisions`
 * (or at file end if no Decisions section), and put the item under it.
 */
export function appendItemToBody(
  body: string,
  phase: string,
  itemLine: string,
): { newBody: string; createdPhase: boolean } {
  const trimmedPhase = phase.trim();
  // The `\b` guards "Phase 1" from matching "Phase 10" — but a word boundary
  // only exists next to a word char, so after a phase ending in `)` / `.` / `"`
  // it can NEVER match and every add silently duplicated the section.
  // Apply the boundary only when the phase ends in a word char.
  const boundary = /\w$/.test(trimmedPhase) ? String.raw`\b` : '';
  const phaseRe = new RegExp(
    String.raw`^##\s+(?:\d+(?:\.\d+)?\.\s+)?` +
      trimmedPhase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      boundary +
      String.raw`[^\n]*$`,
    'm',
  );

  // Locate headings against the fence-masked body so a `## Phase`
  // heading inside a worked-example fence is skipped; splice the real
  // body by index (maskFences preserves length). The backward
  // whitespace scan below deliberately stays on the real body.
  const masked = maskFences(body);
  const phaseMatch = phaseRe.exec(masked);
  if (phaseMatch) {
    const after = phaseMatch.index + phaseMatch[0].length;
    const restAfter = masked.slice(after);
    const nextHeadingRe = /^##\s/m;
    const nextHeadingMatch = nextHeadingRe.exec(restAfter);
    const insertAt =
      nextHeadingMatch !== null ? after + nextHeadingMatch.index : body.length;

    // Walk backward from insertAt to skip trailing whitespace lines.
    let scan = insertAt;
    while (scan > after && (body[scan - 1] === '\n' || body[scan - 1] === ' ')) scan--;
    // Ensure exactly one blank line between previous content and new item.
    const prefix = body.slice(0, scan);
    const suffix = body.slice(scan);
    const sep = prefix.endsWith('\n') ? '' : '\n';
    return {
      newBody: prefix + sep + itemLine + '\n' + suffix,
      createdPhase: false,
    };
  }

  // Phase missing — create the section just before `## Decisions`.
  const decisionsRe = /^##\s+(?:\d+(?:\.\d+)?\.\s+)?Decisions\b[^\n]*$/m;
  const decisionsMatch = decisionsRe.exec(masked);
  const newSection = `\n## ${phase.trim()}\n\n${itemLine}\n`;
  if (decisionsMatch) {
    return {
      newBody: body.slice(0, decisionsMatch.index) + newSection + '\n' + body.slice(decisionsMatch.index),
      createdPhase: true,
    };
  }
  let withTrailingNL = body;
  if (!withTrailingNL.endsWith('\n')) withTrailingNL += '\n';
  return { newBody: withTrailingNL + newSection, createdPhase: true };
}

/** Explicit result payload so `withPlanLock`'s `T` is fixed by the type
 *  argument, not inferred from a union-returning mutator. */
type AddItemValue =
  | { ok: true; itemId: string; createdPhase: boolean; slug: string }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'legacy_plan'; reason?: LegacyReason }
  | {
      ok: false;
      code: 'terminal_parent_child_mutation';
      parentStatus: string;
      changes: TerminalPlanChildMutation[];
      reason: string;
    };

/** Append ONE item, returning the self-describing bulk result. PRESERVES the
 *  in-lock allocate → build → append → bump, the revision capture, the plan-event
 *  emit, and the not_found / legacy_plan / busy error mapping per item. The newly
 *  allocated itemId rides the result (CREATE → result embeds what the single call
 *  returned). */
async function addItemOne(it: NewItem, ctx: UnifiedToolContext): Promise<BulkItemResult> {
  const sctx = harnessScopedCtx(it.harness, ctx);
  const harnessSlug = resolveCtxHarnessSlug(sctx);
  const rev = planRevisionCapture(
    ctx as PlanRevisionCtx,
    it.slug,
    it.rationale,
    harnessSlug ? { harnessSlug } : {},
  );
  // Capture the written body so we can echo the parsed item back (WI-3363).
  let writtenBody: string | null = null;
  const result = await withPlanLock<AddItemValue>(
    ctx as never,
    {
      slug: it.slug,
      intent: `plans:add-item to "${it.phase.slice(0, 40)}"`,
      ...(harnessSlug ? { harnessSlug } : {}),
      afterWrite: rev.afterWrite,
    },
    async (current): Promise<{ newBody: string | null; value: AddItemValue }> => {
      if (current === null) {
        return { newBody: null, value: { ok: false, code: 'not_found' } };
      }
      const parsed = parsePlan(current, { filePath: it.slug + '.md' });
      if (parsed.isLegacy) {
        return {
          newBody: null,
          value: { ok: false, code: 'legacy_plan', reason: parsed.legacyReason ?? undefined },
        };
      }
      const itemId = allocateNextItemId(current);
      const currentItems = parsed.items.map((item) => ({ id: item.id, status: item.storedStatus }));
      const changes = findTerminalPlanChildMutations(
        parsed.frontmatter.status,
        currentItems,
        [...currentItems, { id: itemId, status: 'todo' }],
      );
      if (parsed.frontmatter.status && changes.length > 0) {
        return {
          newBody: null,
          value: {
            ok: false,
            code: 'terminal_parent_child_mutation',
            parentStatus: parsed.frontmatter.status,
            changes,
            reason:
              'the parent plan is still ' +
              parsed.frontmatter.status +
              '; transition it explicitly with plans:set-plan-status before adding a live child',
          },
        };
      }
      const itemLine = buildItemLine(itemId, it.text, it.blockedBy ?? [], it.importance);
      const { newBody, createdPhase } = appendItemToBody(current, it.phase, itemLine);
      const final = bumpUpdatedDate(newBody);
      writtenBody = final;
      return {
        newBody: final,
        value: { ok: true, itemId, createdPhase, slug: it.slug },
      };
    },
  );

  if (result.kind === 'busy') {
    return {
      ok: false,
      slug: it.slug,
      error: 'busy',
      busy: result.busy.map((b) => ({
        path: b.path,
        owner_label: b.owner_label,
        intent: b.intent,
        expires_ts: b.expires_ts,
      })),
    };
  }

  if (!result.value.ok) {
    const value = result.value;
    return {
      ok: false,
      slug: it.slug,
      error: value.code,
      ...('reason' in value && value.reason ? { reason: value.reason } : {}),
      ...('parentStatus' in value ? { parentStatus: value.parentStatus, changes: value.changes } : {}),
    };
  }

  // `result.value` is narrowed to the ok-variant by the guard above.
  await emitPlanEventForCaller(ctx, {
    planSlug: it.slug,
    event: 'item_added',
    detail: result.value.itemId,
    after: it.text.slice(0, 200),
  });

  // Echo the parsed item back (WI-3363) so the caller confirms exactly what
  // registered without a follow-up plans:get — and, in the edge where multi-line
  // or grammar-breaking text silently corrupts the built line, the item fails to
  // parse back and we surface a warning instead of a clean-looking success.
  const item = writtenBody ? echoParsedItem(writtenBody, result.value.itemId) : null;
  return {
    ...result.value,
    ...(item
      ? { item }
      : {
          warning: `the added item ${result.value.itemId} did not parse back as an item — check the text for newlines or grammar-breaking characters`,
        }),
    filePath: result.filePath,
    revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
  };
}

export default defineTool({
  name: 'plans:add-item',
  description:
    "Append one OR many new items to a phase. Allocates the next P-NNN id inside a lock. Creates the phase section if it doesn't exist. Auto-bumps frontmatter updated:. Single: { slug, phase, text, importance }. Many to one phase: { slug, phase, importance, items:[{ text, blockedBy? }] }. Heterogeneous: items:[{ slug, phase, text, importance }]. Returns { ok, results:[{ ok, slug, itemId, createdPhase | error }], counts } — each result embeds the NEW itemId; correlate by { slug, itemId }, not position; one failure never fails the rest.",
  guidance: {
    when: 'New work surfaces — a chunk to do, a verification step, a follow-up. Pick the right phase (or name a new one). Add several at once via items:[…] (the new ids come back per result).',
    notWhen:
      "Updating an existing item — that's a direct edit, not an assisted write (the format is stable). Or status flip — plans:set-status.",
    chaining:
      'plans:add-item → plans:set-status to flip newly added items off `todo` when work starts.',
    seeAlso: [
      'plans:set-status (advance an item you just added off todo)',
      'plans:set-importance (re-rank the new item vs its siblings)',
      'plans:set-item-blocked-by (record a dependency on another item)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  // withPlanLock opens the short transaction that owns the advisory lock and
  // read-modify-write. The bulk handler can run several items and its revision /
  // federation hooks run after commit, so an ambient dispatcher transaction would
  // sit idle across that work and hit idle_in_transaction_session_timeout.
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const list: NewItem[] = args.items?.length
      ? args.items.map((it) => ({
          slug: (it.slug ?? args.slug) as string,
          phase: (it.phase ?? args.phase) as string,
          text: itemTextOrUndefined(it) as string,
          importance: (it.importance ?? args.importance) as Importance,
          blockedBy: it.blockedBy ?? args.blockedBy,
          harness: it.harness ?? args.harness,
          rationale: it.rationale ?? args.rationale,
        }))
      : [
          {
            slug: args.slug as string,
            phase: args.phase as string,
            text: itemTextOrUndefined(args) as string,
            importance: args.importance as Importance,
            blockedBy: args.blockedBy,
            harness: args.harness,
            rationale: args.rationale,
          },
        ];
    const env = await runBulk(list, (it) => addItemOne(it, ctx), {
      keyOf: (it) => ({ slug: it.slug }),
    });
    return bulkContent(env);
  },
});
