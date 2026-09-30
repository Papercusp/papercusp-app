/**
 * work_items:tag — Taggable (D-003). Add/remove a topic tag (coord_links rel='tagged')
 * so the work-item routes to that area's subscribers.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): tag ONE item inline
 * ({ id, topic, remove? }), MANY with the SAME topic (ids:[…] + topic), or MANY
 * heterogeneous (items:[{ id, topic, harness?, remove? }]) → { ok, results:[{ ok,
 * id, topic? | error }], counts }. Each result self-describes its id; one not-found
 * item never fails the rest. The rationale-reproject reaction fires per item (D-007).
 *
 * THIS IS ALSO HOW YOU POPULATE THE CLAIM-SPEC `tags` FILTER FIELD (EI-18654138087054247,
 * work-item-topic-tags.ts): every call here ALSO mirrors the topic into the exact tag
 * field each claim-spec evaluator reads (the `tags` jsonb column for feature-family,
 * `payload.tags` for issue-family — see syncTopicTagToClaimTags). So `scheduler:set_claim_spec`
 * `{ field:"tags", op:"contains", value:"<topic>" }` DOES admit an item after you call
 * `work_items:tag { id, topic:"<topic>" }` on it — verified live 2026-07-26. If you land
 * here believing "nothing writes `tags`" (this exact belief was independently filed 9x in
 * 19h as WI-6102/EI-18730476010072570/…): re-verify against a real write+read before
 * re-filing — the mechanism has worked since 2026-07-25 18:21 (commit 8fb140cc).
 * `work_items:update` rejects a `tags` key on purpose; this tool is the writer.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { tagWorkItem, untagWorkItem } from '../../work-items';
import { runBulk, bulkContent } from '../_bulk';

const itemSpec = z.object({
  id: z.string().min(1),
  topic: z.string().min(1).max(80),
  harness: z.string().max(80).optional().describe('per-item harness (else the batch `harness` default)'),
  remove: z.boolean().optional().describe('untag instead of tag'),
});

export default defineTool({
  name: 'work_items:tag',
  profile: 'engineer',
  description:
    'Tag one OR many work-items with a topic (or untag with remove:true) — routes the item to that topic\'s subscribers, AND mirrors the topic into the claim-spec-visible `tags` field (a `scheduler:set_claim_spec` view.filter on `tags` reads exactly what this call writes). Single: { id, topic }. Many same topic: { ids:[…], topic }. Many heterogeneous: items:[{ id, topic, harness?, remove? }]. Returns { ok, results:[{ ok, id, topic, mirrored, mirrorOutcome, warning? | error }], counts } — correlate by id; a not-found item never fails the rest. ⚠ Read `mirrored`, not just `ok`: `mirrored:false` (e.g. mirrorOutcome "remote-origin") means the topic landed but the claim-spec `tags` field was NOT written, so a `tags` filter will not match that item.',
  guidance: {
    when: 'You want a work-item visible to agents following an area (topics:list to see topics), OR you want it to match a claim-spec filter on `tags` (this is the only writer for that field — work_items:update deliberately rejects a `tags` key). Tag several at once via ids:[…]+topic or items:[…].',
    chaining: 'topics:list → work_items:tag { topic } (or { ids, topic }). For claim-spec lane-scoping: work_items:tag { id, topic:"<lane-tag>" } → CHECK each result\'s `mirrored` → scheduler:set_claim_spec { …filter: { field:"tags", op:"contains", value:"<lane-tag>" } }. Any row that came back mirrored:false is NOT covered by that leg — scope it by id.',
    // EI-18825410151745437: a caller naturally reaches for `tags:[…]` here.
    // The strict rejection used to list this tool's args without saying that
    // `topic` is the one-at-a-time writer for the claim-spec-visible tags field,
    // reinforcing the false belief that no public writer exists. Put the
    // correction on the failure path where that belief is formed. The generic
    // argRedirects renderer owns the error shape and structured correction
    // metadata; this tool contributes only its domain-specific fact.
    argRedirects: {
      tags: {
        tool: 'work_items:tag',
        args: { id: '<work-item-id>', topic: '<topic>' },
        note: 'pass `topic`; it mirrors that topic into the claim-spec-visible `tags` field. Check `mirrored` in the result, not just `ok`',
      },
    },
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-tag shorthand: the work-item id (use with `topic`)'),
      topic: z.string().min(1).max(80).optional().describe('the topic slug applied to the inline id / every id in `ids`'),
      remove: z.boolean().optional().describe('untag instead of tag (applies to the inline id / every id in `ids`)'),
      ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('tag MANY items with the same `topic` (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('tag many work-items at once — each { id, topic, harness?, remove? }'),
      harness: z.string().max(80).optional().describe('default harness for the inline id / ids / items that omit one'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.topic) && ((a.ids?.length ?? 0) > 0 || Boolean(a.id))), {
      message: 'pass { id, topic } for one, { ids:[…], topic } for many of the same topic, or items:[{ id, topic }] for many',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const list = args.items?.length
      ? args.items
      : args.ids?.length
        ? args.ids.map((id) => ({ id, topic: args.topic as string, harness: args.harness, remove: args.remove }))
        : [{ id: args.id as string, topic: args.topic as string, harness: args.harness, remove: args.remove }];
    const env = await runBulk(
      list,
      async (it) => {
        const opts = { harness: it.harness ?? args.harness };
        const res = it.remove
          ? await untagWorkItem(it.id, it.topic, opts)
          : await tagWorkItem(it.id, it.topic, { ...opts, by: ident.ownerId });
        if ('error' in res) return { ok: false as const, id: it.id, error: res.error };
        // EI-18810823481386446: the topic landed, but on a federated row the
        // claim-visible mirror is refused — say so IN THE ROW. A bare ok:true here
        // is what let an agent build a claim-spec `tags` leg on a tag that never
        // persisted and read the resulting mis-serve as "the spec isn't evaluated".
        return {
          ok: true as const,
          id: it.id,
          topic: it.topic,
          mirrored: res.mirrored,
          mirrorOutcome: res.mirrorOutcome,
          ...(res.mirrored
            ? {}
            : {
                warning:
                  res.mirrorOutcome === 'remote-origin'
                    ? `topic recorded, but '${it.id}' is remote-authored (origin=remote) so the claim-spec-visible \`tags\` field was NOT written — its authoring peer owns the row. A claim-spec filter on \`tags\` will NOT match this item; scope it by id instead.`
                    : `topic recorded, but the claim-spec-visible \`tags\` field was NOT written (${res.mirrorOutcome}) — a claim-spec filter on \`tags\` will NOT match this item.`,
              }),
        };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
