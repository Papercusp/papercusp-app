/**
 * memory:update — edit one OR many memories' content AND/OR patch metadata.
 *
 * Brain calls when the user corrects a stored fact ("actually my name is Daniel,
 * not Dan") → a CONTENT edit. Agents/superusers also call it for METADATA HYGIENE
 * — re-tag a memory's `kind`, fix its `workspaceId`, or move it to the right recall
 * `scope`/pool — without rewriting the text. The metadata patch is a vec-safe merge
 * on the canonical store (no re-embed); before this, metadata was unfixable through
 * any tool (mem0's update is text-only), forcing raw DB surgery (EI-2032). Preserves
 * the memory's id + lifecycle. Storage rides the neutral `MemoryBackend` seam.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): patch ONE inline ({ id, content?,
 * kind?, … }), MANY with the SAME metadata patch (ids:[…] + kind?/scope?/…), or
 * MANY heterogeneous (items:[{ id, content?, kind?, … }]) → { ok, results:[{ ok,
 * id, error? }], counts }. The backend availability probe is a single top-level
 * gate (a wedged store can't serve ANY patch → { ok:false, reason }); per-id
 * patches then run sequentially, each self-describing its id — correlate by id
 * (not position), and one not-found / timed-out id never fails the rest.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getMemoryBackend } from '../../memory/backend';
import { MemoryTimeoutError, withMemoryToolTimeout } from '../../memory/op-deadline';
import { journalPendingWrite, markJournalCommitted } from '../../memory/write-journal';
import { detectPossibleSecrets, possibleSecretWarning } from '../../memory/secret-detect';
import { runBulk, bulkContent } from '../_bulk';
import { hardText, LIMITS } from '../limits';
import { trackDetached } from '../../detached-imports';
import { AGENT_TOOL_ACTOR_ID } from '../../memory/feedback';

/** The per-memory patch fields, shared by the inline single, the homogeneous
 *  `ids` default, and each heterogeneous `items[]` entry. */
const PATCH_FIELDS = {
  content: hardText(LIMITS.CONTENT).optional().describe('replacement fact body (a CONTENT edit)'),
  kind: z
    .enum(['user', 'feedback', 'project', 'reference'])
    .optional()
    .describe('re-tag the memory kind (metadata — no re-embed)'),
  workspaceId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('fix the workspace_id tag (metadata — no re-embed)'),
  scope: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'MOVE the memory to a different recall pool (its user_id/scope, e.g. a user-id or "harness:<slug>"). Changes which queries see it.',
    ),
  supersedes: z
    .string()
    .uuid('supersedes must be a valid memory UUID')
    .optional()
    .describe(
      'Record that THIS memory replaces the given old memory id (temporal-lite): the old one\'s validity window is closed with superseded_by = this id — it drops out of default recall but stays retrievable via include_superseded/as_of. Not a delete.',
    ),
} as const;

const itemSpec = z.object({
  id: z.string().uuid('Memory ID must be a valid UUID'),
  ...PATCH_FIELDS,
});

type PatchInput = z.infer<typeof itemSpec>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** id + at-least-one-of {content, kind, workspaceId, scope, supersedes}. */
function hasAnyField(a: {
  content?: unknown;
  kind?: unknown;
  workspaceId?: unknown;
  scope?: unknown;
  supersedes?: unknown;
}): boolean {
  return (
    a.content !== undefined ||
    a.kind !== undefined ||
    a.workspaceId !== undefined ||
    a.scope !== undefined ||
    a.supersedes !== undefined
  );
}

/** Build the neutral UpdatePatch from a per-item input. */
function toPatch(a: PatchInput): { text?: string; metadata?: Record<string, unknown> } {
  const metadata: Record<string, unknown> = {};
  if (a.kind !== undefined) metadata.kind = a.kind;
  if (a.workspaceId !== undefined) metadata.workspace_id = a.workspaceId;
  if (a.scope !== undefined) metadata.user_id = a.scope; // the canonical store's recall-pool key
  const patch: { text?: string; metadata?: Record<string, unknown> } = {};
  if (a.content !== undefined) patch.text = a.content;
  if (Object.keys(metadata).length > 0) patch.metadata = metadata;
  return patch;
}

export default defineTool({
  name: 'memory:update',
  capability: 'memory:write',
  description:
    'Edit one or many memories in place, preserving ids. Patch content or metadata (`kind`, `workspaceId`, `scope`); metadata-only patches do not re-embed. On the NEW row, `supersedes:<old-id>` records replacement and closes the old row from default recall while preserving history. Single: `{ id, … }`; homogeneous bulk: `{ ids:[…], … }`; heterogeneous bulk: `{ items:[…] }`. Results are per-id; one failure does not fail the batch.',
  guidance: {
    when:
      'CONTENT: when the user corrects the SAME stored fact in place ("actually it\'s Daniel, not Dan") — pass `content`; this preserves its id. SUPERSESSION: when an already-written NEW memory replaces a different old memory, pass the new row as `id` and the old row as `supersedes` so history records the replacement. For a one-call new replacement, use memory:remember { supersede:<old-id> }. METADATA HYGIENE: re-tag `kind`, fix `workspaceId`, or move `scope` without content. Find ids via memory:search / memory:list first. For a content edit, tell the user ("Updating my memory: …").',
    notWhen:
      'To REMOVE a memory, use memory:forget (hard for privacy; soft when historical truth should remain without a replacement). To ADD a new memory, use memory:remember. Do not change `scope` casually — it moves which queries can recall the memory.',
    chaining:
      'memory:search → memory:update { ids:[…], kind } (bulk metadata hygiene). Bulk: single | items[] (or ids) → { ok, results, counts }; correlate by id not position; one failure never fails the rest.',
    seeAlso: [
      'memory:search (find the id to amend)',
      'memory:remember (write a NEW fact instead of amending)',
      'memory:forget (remove entirely rather than correct)',
    ],
  },
  // Principal-gated is defineTool's DEFAULT (unauthed HTTP → 401); the former
  // `requirePrincipal: true` marker was not a declared input property and made
  // every overload fail (memory-taxonomy-and-debt-followups P-004).
  // The memory store is cross-workspace by design (shared tables scoped by
  // user-id / harness-slug, not by workspace; the handler reads getMemoryBackend,
  // never ctx.tx). crossWorkspace:true hands an UNSCOPED superuser session ('*')
  // the admin handle + a synthesized principal, so this works from a psu / fleet
  // session instead of failing `workspace_required` (EI-177/178/210 — the
  // workspace-tx gate was wrongly applied to memory:update; search + remember
  // already carry this).
  crossWorkspace: true,
  // NOTE: agentRoles/rolesQuota are not accepted on principal-gated tools —
  // definePrincipalGatedTool drops them (never copied to the def, never
  // enforced); the all-roles lists + quotas formerly here were dead inputs
  // (memory-taxonomy-and-debt-followups P-004).
  args: z
    .object({
      id: z.string().uuid('Memory ID must be a valid UUID').optional().describe('single-patch shorthand: the memory id'),
      ids: z
        .array(z.string().uuid('Memory ID must be a valid UUID'))
        .min(1)
        .max(200)
        .optional()
        .describe('patch MANY memories with the SAME metadata/content patch (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('patch many memories at once — each { id, content?, kind?, workspaceId?, scope? }'),
      ...PATCH_FIELDS, // the patch applied to the inline `id` / every id in `ids`
    })
    .refine(
      (a) =>
        (a.items?.length ?? 0) > 0 ||
        ((Boolean(a.id) || (a.ids?.length ?? 0) > 0) && hasAnyField(a)),
      {
        message:
          'pass { id, …patch } for one, { ids:[…], …patch } for many of the same patch, or items:[{ id, …patch }] for many; each must carry content, supersedes, and/or at least one metadata field (kind, workspaceId, scope)',
      },
    ),
  async handler(args) {
    // Normalize to a per-item list. items[] is heterogeneous; ids[] / inline id
    // share the top-level patch fields.
    const sharedPatch = {
      content: args.content,
      kind: args.kind,
      workspaceId: args.workspaceId,
      scope: args.scope,
      supersedes: args.supersedes,
    };
    const list: PatchInput[] = args.items?.length
      ? args.items
      : args.ids?.length
        ? args.ids.map((id) => ({ id, ...sharedPatch }))
        : [{ id: args.id as string, ...sharedPatch }];

    const backend = getMemoryBackend();
    // B1: bound the availability probe so a wedged store yields memory_timeout,
    // not a hang. TOP-LEVEL gate — a store that can't answer `available()` can't
    // serve ANY patch, so the whole batch short-circuits.
    try {
      const avail = await withMemoryToolTimeout(backend.available(), 'memory:update available');
      if (!avail.ok) {
        return bulkContent({ ok: false, reason: avail.reason });
      }
    } catch (err) {
      if (err instanceof MemoryTimeoutError) {
        return bulkContent({ ok: false, reason: 'memory_timeout' });
      }
      throw err;
    }

    const env = await runBulk(
      list,
      async (it) => {
        // Per-item validation (the wire schema validates the top-level shape, but
        // homogeneous ids[] + heterogeneous items[] entries — and direct handler
        // callers that bypass the wrapper — are validated here so a bad item is
        // that item's { ok:false }, not a whole-batch reject).
        if (!UUID_RE.test(it.id)) {
          return { ok: false as const, id: it.id, error: 'Memory ID must be a valid UUID' };
        }
        if (!hasAnyField(it)) {
          return {
            ok: false as const,
            id: it.id,
            error: 'provide content, supersedes, and/or at least one metadata field (kind, workspaceId, scope)',
          };
        }
        // Supersession preflight (temporal-lite P-004) — validated BEFORE the
        // patch is applied so a bad supersedes never leaves a half-done item
        // (patch landed, supersession silently skipped).
        const invalidateEntry = backend.invalidateEntry?.bind(backend);
        let replacementBefore: Awaited<ReturnType<typeof backend.get>> = null;
        let supersededBefore: Awaited<ReturnType<typeof backend.get>> = null;
        if (it.supersedes !== undefined) {
          if (!UUID_RE.test(it.supersedes)) {
            return { ok: false as const, id: it.id, error: 'supersedes must be a valid memory UUID' };
          }
          if (it.supersedes === it.id) {
            return { ok: false as const, id: it.id, error: 'a memory cannot supersede itself' };
          }
          if (!invalidateEntry) {
            return {
              ok: false as const,
              id: it.id,
              error: 'supersedes requires a backend with validity-window support (temporal-lite unavailable)',
            };
          }
          [replacementBefore, supersededBefore] = await Promise.all([
            withMemoryToolTimeout(backend.get(it.id), 'memory:update replacement preflight'),
            withMemoryToolTimeout(backend.get(it.supersedes), 'memory:update superseded preflight'),
          ]);
          if (!replacementBefore) {
            return { ok: false as const, id: it.id, error: `Memory with ID ${it.id} not found` };
          }
          if (!supersededBefore) {
            return { ok: false as const, id: it.id, error: `Superseded memory ${it.supersedes} not found` };
          }
          if (replacementBefore.metadata?.entityType || supersededBefore.metadata?.entityType) {
            return { ok: false as const, id: it.id, error: 'entity rows cannot participate in memory supersession' };
          }
          if (!replacementBefore.scope || replacementBefore.scope !== supersededBefore.scope) {
            return { ok: false as const, id: it.id, error: 'supersession requires both memories to belong to the same scope' };
          }
          if (it.scope !== undefined && it.scope !== supersededBefore.scope) {
            return { ok: false as const, id: it.id, error: 'a superseding update cannot move the replacement across scopes' };
          }
          const validity = supersededBefore.metadata?.validity as { status?: unknown; superseded_by?: unknown } | undefined;
          if (validity?.status === 'superseded') {
            return {
              ok: false as const,
              id: it.id,
              error: validity.superseded_by === it.id
                ? 'supersession already converged'
                : 'superseded memory already has a different immutable winner',
            };
          }
        }
        // EI-10371 stage 1: a content EDIT re-checks the new text and re-stamps
        // the flag BOTH ways — editing a secret out must clear the chip, so a
        // clean edit stamps possible_secret:false (vec-safe metadata merge).
        // Metadata-only patches never touch the flag.
        const secrets = it.content !== undefined ? detectPossibleSecrets(it.content) : null;
        const secretFields = secrets?.matched
          ? {
              possible_secret: true as const,
              possible_secret_classes: secrets.classes,
              warning: possibleSecretWarning(secrets.classes),
            }
          : {};
        const patch = toPatch(it);
        const journalId = it.supersedes !== undefined && replacementBefore
          ? await journalPendingWrite({
              scope: replacementBefore.scope,
              content: it.content ?? replacementBefore.text,
              kind: replacementBefore.kind,
              metadata: {
                __journal_update_of: it.id,
                __journal_supersede_of: it.supersedes,
                __journal_update_patch: patch,
              },
              verbatim: true,
            })
          : null;
        const journaledFields = journalId
          ? { journaled: true as const, will_retry: true as const, journal_id: journalId }
          : {};
        try {
          // A supersedes-only item carries no patch — skip the store update
          // and go straight to closing the old memory's window.
          if (secrets) {
            patch.metadata = {
              ...(patch.metadata ?? {}),
              possible_secret: secrets.matched,
              possible_secret_classes: secrets.classes,
            };
          }
          if (patch.text !== undefined || patch.metadata !== undefined) {
            await withMemoryToolTimeout(backend.update(it.id, patch), 'memory:update update');
          }
        } catch (err) {
          // B1: a wedged store yields memory_timeout, not a hang.
          if (err instanceof MemoryTimeoutError) {
            // Write-ahead journal (memory-write-journal-auto-recovery P-002):
            // a TEXT update is embed-synchronous (re-embeds the new text), so
            // an outage here would lose the edit — park it; the drain replays
            // it via backend.update (metadata.__journal_update_of). Metadata-
            // only patches ride the vec-safe merge path and aren't journaled.
            const timeoutJournalId = journalId ?? (it.content !== undefined
              ? await journalPendingWrite({
                  scope: `__update__:${it.id}`,
                  content: it.content,
                  metadata: { __journal_update_of: it.id },
                  verbatim: true,
                })
              : null);
            return {
              ok: false as const, id: it.id, reason: 'memory_timeout' as const,
              ...(timeoutJournalId ? { journaled: true, will_retry: true, journal_id: timeoutJournalId } : {}),
            };
          }
          // A well-formed id that names no existing memory is a clean negative
          // result, not a tool failure — the mem0 backend THROWS ("Memory with
          // ID … not found") for not-found, which escaped as a handler_error and
          // tripped the repeated-tool-error:memory:update:structural watchdog
          // (EI-486). Return a graceful { ok:false, error } instead. Other backend
          // failures (DB down, etc.) surface their message the same way.
          const message = err instanceof Error ? err.message : String(err);
          const notFound = /not\s*found/i.test(message);
          const error = notFound ? `Memory with ID ${it.id} not found` : message;
          // Journal the text edit on infrastructure failures only — a
          // not-found is a clean negative, not a lost write.
          const failureJournalId = journalId ?? (!notFound && it.content !== undefined
            ? await journalPendingWrite({
                scope: `__update__:${it.id}`,
                content: it.content,
                metadata: { __journal_update_of: it.id },
                verbatim: true,
              })
            : null);
          return {
            ok: false as const, id: it.id, error,
            ...(failureJournalId ? { journaled: true, will_retry: true, journal_id: failureJournalId } : {}),
          };
        }
        // Learning signal (learning-system-audit P-050): an agent-driven CONTENT
        // correction feeds the extraction-adaptation loop (memory_feedback).
        // Skipped for a metadata-only patch (no text changed to learn from).
        // Fire-and-forget.
        if (it.content !== undefined) {
          void trackDetached(import('../../memory/feedback'))
            .then(({ recordFeedback }) =>
              recordFeedback({ memId: it.id, userId: AGENT_TOOL_ACTOR_ID, action: 'edit', newText: it.content }),
            )
            .catch(() => { /* best-effort */ });
        }
        // Supersession (temporal-lite P-004): close the OLD memory's validity
        // window with superseded_by = this id. Runs AFTER the patch so the
        // replacing fact exists in its corrected form first. The patch already
        // landed, so a failure here reports honestly instead of failing the item.
        if (it.supersedes !== undefined && invalidateEntry) {
          try {
            const closed = await withMemoryToolTimeout(
              invalidateEntry(it.supersedes, { supersededBy: it.id }),
              'memory:update supersede',
            );
            if (closed) {
              if (journalId) await markJournalCommitted(journalId, it.id);
              return { ok: true as const, id: it.id, superseded: it.supersedes, ...secretFields };
            }
            const after = await withMemoryToolTimeout(backend.get(it.supersedes), 'memory:update supersede reconcile');
            const validity = after?.metadata?.validity as { superseded_by?: unknown } | undefined;
            if (validity?.superseded_by === it.id) {
              if (journalId) await markJournalCommitted(journalId, it.id);
              return { ok: true as const, id: it.id, superseded: it.supersedes, ...secretFields };
            }
            // A concurrent immutable winner beat this replacement. Close the
            // losing replacement so two current facts can never survive.
            await withMemoryToolTimeout(invalidateEntry(it.id), 'memory:update supersede loser cleanup');
            if (journalId) await markJournalCommitted(journalId, it.id);
            return {
              ok: false as const,
              id: it.id,
              error: 'supersession conflict: another replacement won; this losing replacement was closed',
              superseded: false as const,
              ...secretFields,
            };
          } catch (err) {
            const msg =
              err instanceof MemoryTimeoutError
                ? 'memory_timeout'
                : err instanceof Error
                  ? err.message
                  : String(err);
            return {
              ok: false as const,
              id: it.id,
              superseded: false as const,
              error: `patch applied but supersession is pending durable repair: ${msg}`,
              ...journaledFields,
              ...secretFields,
            };
          }
        }
        return { ok: true as const, id: it.id, ...secretFields };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );

    // Live-refresh the settings memory page (userMemory.list sync query) —
    // fire-and-forget, never load-bearing (memory-settings-page-refresh P-008).
    // One invalidate covers the whole batch.
    if (env.counts.ok > 0) {
      void trackDetached(import('../../memory/invalidate-user-memory-views'))
        .then(({ invalidateUserMemoryViews }) => invalidateUserMemoryViews())
        .catch(() => { /* best-effort */ });
    }
    return bulkContent(env);
  },
});
