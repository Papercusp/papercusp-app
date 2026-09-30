/**
 * Production `CoordOpCaps` — wires the coord-op capability bag to the shipped
 * coordination singletons (`coordination-ops-as-blueprint-primitives-2026-06-04`
 * D-001 / D-004: wrap existing primitives, don't rebuild). Each capability is a
 * thin adapter onto exactly one surface:
 *
 *   openThread / postThread / listPosts / readAnswer → conversations.ts
 *   escalate                                          → escalations.openEscalation
 *   subscribe                                         → PgEntitySubscriptionStore
 *   notify                                            → messages.sendMessage
 *   spawnRoles                                        → the injected spawn runner
 *   runProgram                                        → runProgramCore (inline recursion)
 *
 * `spawnRoles` is an injected seam (`setCoordSpawnRunner`) like the orchestrator's
 * `setPipelineInvokeRunner`: the operator wires the real agent-spawn (resolve the
 * project dir + spawn one agent per spec + await), tests/headless use fake caps.
 * `runProgram` rebuilds a sub-ctx (depth + callerId from the recursion input) over
 * the SAME stateless caps and runs the sub-blueprint inline — that is how
 * `deliberate`'s `coord:vote` step composes the `vote` program (D-008).
 */
import { getOrgPg } from '@papercusp/db-org';
import { PgEntitySubscriptionStore } from '@papercusp/coordination/capabilities';
import { loadBuiltinBlueprint, type Blueprint } from '@papercusp/orchestrator/blueprint';
import {
  openConversation,
  postReply,
  getConversation,
  supersedeConversation,
} from '../agent-tools/coordination/conversations.js';
import { openEscalation } from '../agent-tools/coordination/escalations.js';
import { sendMessage } from '../agent-tools/coordination/messages.js';
import type { AgentIdentity } from '../agent-tools/coordination/identity.js';
import type { CoordOpCaps, CoordOpCtx, ResolvedSpawn, SpawnRolesResult } from './types.js';
import { runProgramCore, inlineRunOp } from './program-runner.js';

/** Identity + scoping a caps instance is built for. */
export interface CoordOpEnvBase {
  workspaceId?: string;
  harnessSlug?: string;
  identity: { ownerId: string; ownerLabel?: string };
}

// ── spawn runner seam (wired by the operator; like setPipelineInvokeRunner) ────

export type CoordSpawnRunner = (
  specs: ResolvedSpawn[],
  opts: { harnessSlug?: string; workspaceId?: string },
) => Promise<SpawnRolesResult>;

let _spawnRunner: CoordSpawnRunner | null = null;
export function setCoordSpawnRunner(fn: CoordSpawnRunner | null): void {
  _spawnRunner = fn;
}

// ── program-blueprint resolver seam (default = built-in vote/deliberate) ───────

export type ProgramBlueprintResolver = (
  id: string,
  opts: { workspaceId?: string; harnessSlug?: string },
) => Promise<Blueprint>;

let _bpResolver: ProgramBlueprintResolver | null = null;
/** Override how `runProgram` resolves a blueprint by id (PG cache / forked). */
export function setProgramBlueprintResolver(fn: ProgramBlueprintResolver | null): void {
  _bpResolver = fn;
}
async function resolveProgramBlueprint(id: string, opts: { workspaceId?: string; harnessSlug?: string }): Promise<Blueprint> {
  if (_bpResolver) return _bpResolver(id, opts);
  return loadBuiltinBlueprint(id).blueprint;
}

function fullIdentity(base: CoordOpEnvBase): AgentIdentity {
  return {
    ownerId: base.identity.ownerId,
    ownerLabel: base.identity.ownerLabel ?? base.identity.ownerId,
    source: 'principal',
    workspaceId: base.workspaceId ?? null,
    userId: null,
  };
}

/** Build a production caps bag bound to the given identity + scope. */
export function buildCoordOpCaps(base: CoordOpEnvBase): CoordOpCaps {
  const identity = fullIdentity(base);
  const subStore = new PgEntitySubscriptionStore({ getSql: () => getOrgPg().sql, ensureSchema: async () => {} });

  const caps: CoordOpCaps = {
    async openThread(input) {
      const body = input.body ?? input.title ?? 'Coordination thread';
      if (input.supersedes_conversation_id) {
        const r = await supersedeConversation(identity, {
          conversation_id: input.supersedes_conversation_id,
          replacement: {
            kind: input.kind ?? 'discussion',
            body,
            title: input.title,
            topics: input.topics,
          },
        });
        if ('error' in r) {
          throw new Error(`coord-op openThread: cannot supersede ${input.supersedes_conversation_id} (${r.error})`);
        }
        return {
          thread_id: r.replacement.thread_id,
          conversation_id: r.replacement.conversation.id,
          ...(r.replacement.interestWatch ? { interest_watch: r.replacement.interestWatch } : {}),
        };
      }
      const r = await openConversation(identity, {
        kind: input.kind ?? 'discussion',
        producer: input.producer,
        body,
        title: input.title,
        topics: input.topics,
        harness_slug: input.harness,
      });
      return {
        thread_id: r.thread_id,
        conversation_id: r.conversation.id,
        ...(r.interestWatch ? { interest_watch: r.interestWatch } : {}),
      };
    },

    async postThread(input) {
      const r = await postReply(identity, { conversation_id: input.conversation_id, body: input.body });
      // The error is no longer only not_found — the P-004 consult kind gate
      // refuses untyped posts here too (consult_requires_typed_verb); name it.
      if ('error' in r) throw new Error(`coord-op postThread: ${r.error} (conversation ${input.conversation_id})`);
      return { post_id: r.post.id };
    },

    // Reads pass `identity` so they resolve the SAME workspace partition the
    // writes above land in (WI-1571 read side): without it, a workspace-scoped
    // asker's readAnswer polled the 'default' partition — the conversation its
    // own openThread just created was never found, so coord:ask-owner's bounded
    // wait ALWAYS timed out with { answered:false } even when the owner answered.
    async listPosts(conversationId) {
      const detail = await getConversation(conversationId, identity);
      if (!detail) return [];
      return detail.posts.map((p) => ({ id: p.id, author_id: p.author_id, body: p.body, created_ts: p.created_ts }));
    },

    async readAnswer({ conversationId, askerId }) {
      const detail = await getConversation(conversationId, identity);
      if (!detail) return { answered: false, answer: null };
      const accepted = detail.conversation.accepted_answer;
      if (accepted) return { answered: true, answer: accepted };
      // Latest reply by someone other than the asker counts as an answer.
      const replies = detail.posts.filter((p) => p.author_id && p.author_id !== askerId);
      const last = replies[replies.length - 1];
      return last ? { answered: true, answer: last.body } : { answered: false, answer: null };
    },

    async spawnRoles(specs) {
      if (!_spawnRunner) {
        throw new Error('[coord-ops] spawn runner not wired — call setCoordSpawnRunner() first');
      }
      return _spawnRunner(specs, { harnessSlug: base.harnessSlug, workspaceId: base.workspaceId });
    },

    async escalate(input) {
      const rec = await openEscalation(identity, {
        severity: input.severity,
        summary: input.summary,
        body: input.body,
        options: input.options,
        plan_slug: input.plan_slug,
        ...(input.meta ? { meta: input.meta } : {}),
      });
      return { msg_id: rec.msg_id };
    },

    async subscribe(input) {
      await subStore.subscribe({
        subscriber_id: identity.ownerId,
        target_kind: input.target_kind,
        target_ref: input.target_ref,
        delivery_mode: input.mode ?? 'full',
        created_ts: new Date().toISOString(),
      });
      return { ok: true };
    },

    async notify(input) {
      await sendMessage(identity, { to: input.to, summary: input.summary, body: input.body });
    },

    async runProgram(input) {
      const bp = await resolveProgramBlueprint(input.blueprintId, { workspaceId: base.workspaceId, harnessSlug: base.harnessSlug });
      let seq = 0;
      const subCtx: CoordOpCtx = {
        identity: base.identity,
        workspaceId: base.workspaceId,
        harnessSlug: base.harnessSlug,
        callerId: input.callerId,
        depth: input.depth,
        now: () => new Date().toISOString(),
        newId: (p) => `${p}-${Date.now().toString(36)}-${++seq}`,
        caps,
      };
      return runProgramCore({ blueprint: bp, payload: input.payload, ctx: subCtx, runOp: inlineRunOp });
    },

    async sleep(ms) {
      await new Promise((res) => setTimeout(res, ms));
    },
  };

  return caps;
}

/** Build a full prod CoordOpCtx (caps + identity + clock + ids). */
export function buildCoordOpCtx(base: CoordOpEnvBase & { depth?: number; callerId?: string; workItemId?: string }): CoordOpCtx {
  let seq = 0;
  return {
    identity: base.identity,
    workspaceId: base.workspaceId,
    harnessSlug: base.harnessSlug,
    callerId: base.callerId,
    workItemId: base.workItemId,
    depth: base.depth ?? 0,
    now: () => new Date().toISOString(),
    newId: (p) => `${p}-${Date.now().toString(36)}-${++seq}`,
    caps: buildCoordOpCaps(base),
  };
}
