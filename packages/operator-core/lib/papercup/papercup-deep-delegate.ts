/**
 * sentinel-deep-delegate — the deep-thinking delegation lane
 * (voice-unified-sentinel-pipeline-2026-07-01 P-005/P-006; re-pointed by
 * voice-public-release-readiness-2026-07-12 P-019 per its D-003).
 *
 * The conversational front-end must stay responsive — it cannot disappear into
 * a ten-minute analysis while the voice goes dead. HARD THINKING (analysis /
 * research / comparison where the user expects an ANSWER back in the
 * conversation) is therefore delegated:
 *
 *   PRIMARY (D-003, owner-ratified 2026-07-12): the question goes to the LIVE,
 *   PERSISTENT papercup-deep session (the parked heavy-reasoner dock pane,
 *   D-006) over the modern coord/wake channel — a directed coord message
 *   carrying the brief + an inbox wake. THIS module still mints the durable
 *   claimed `task` work_item first (tagged `deep-delegation`), claimed by the
 *   deep session's ownerId, and the deep session answers by COMPLETING the
 *   item (its completion.summary IS the answer) → the settled-events seam
 *   fires sentinel-deep-watch, which injects `[deep-answer WI-NNN] …` back
 *   into the front-end pane — spoken + written through the same one pipeline.
 *
 *   FALLBACK (the pre-D-003 legacy lane, kept for the no-deep-pane case): when
 *   NO live papercup-deep session exists, spawn an EPHEMERAL background agent
 *   with the question as its brief, one per question — same work_item, same
 *   answer-return seam.
 *
 * Split of lanes (D-003): WORK ("build X") still goes to the Mug via
 * <handoff> (operator-sentinel-handoff.ts) — she PLACES it. THINKING
 * goes here — the user gets the answer back in conversation. The Mug was the
 * wrong tool for cognition: her wake loop is cadenced and placement-shaped.
 *
 * The durable record is a `task` (WI-2874: the old feature-family `research-task`
 * kind was merged into `task` — research/analysis is non-code work), tagged
 * `deep_delegation`, making the delegation visible on the normal work surface.
 * To avoid a create→claim race against the frontier, it lands already
 * claimed (by the deep session's ownerId on the primary lane, or the pre-minted
 * background spawn id on the fallback) in the SAME write; if delivery/launch is
 * refused before the assignee takes over, the claim is released back to `todo`.
 * THE TOOL DELIVERS/SPAWNS, NOT THE SENTINEL — the sentinel's own capability
 * envelope still denies cup:spawn (the SN-H04 no-spawn contract); this module
 * is the accountable indirection. Capacity pressure is handled after durable
 * persistence by the shared spawn/governor path; this layer never drops a
 * question because other deep items are open.
 *
 * Dependency-injected so the core unit-tests without PG/spawn/coord machinery;
 * the real substrate wiring lives in sentinel-deep-delegate-deps.ts.
 */
import { randomUUID } from 'node:crypto';

/** Topic tag stamped on every deep-delegation work_item — the landing gate
 *  (sentinel-deep-watch) and the sentinel's own "how's it going" reads key on it. */
export const DEEP_DELEGATION_LABEL = 'deep-delegation';

/** Bound one deep-analysis child so it cannot squat a deep slot indefinitely. */
export const DEEP_TIMEOUT_MS = 15 * 60_000;

/** Clamp for the work_item title (the question, headline-sized). */
const TITLE_MAX = 180;

export interface DeepDelegateInput {
  /** The user's question, as spoken/typed. */
  question: string;
  /** Optional extra context the sentinel wants to hand along (conversation excerpt). */
  brief?: string | null;
  /** Harness the background agent spawns into (defaults resolved by the deps). */
  harness?: string | null;
  workspaceId: string;
}

export interface DeepDelegateDeps {
  /** Mint the durable claimed work_item (kind `task`, tagged DEEP_DELEGATION_LABEL). */
  createWorkItem(input: {
    assignee: string;
    title: string;
    summary: string;
    harness: string | null;
    workspaceId: string;
  }): Promise<{ id: string; harness: string } | null>;
  /** D-003 primary lane: the LIVE persistent papercup-deep session (fresh
   *  presence row with agentRole 'papercup-deep'), or null when none is
   *  running. Optional so pre-existing deps/tests keep the legacy behavior. */
  findLiveDeepSession?(workspaceId: string): Promise<{ ownerId: string } | null>;
  /** D-003 primary lane: deliver the delegation to that live deep session — a
   *  directed coord message carrying the brief + an inbox wake. Resolve false
   *  when the delivery did not land (the session died since the presence
   *  read / its wake staged), so the caller can degrade. */
  deliverToDeep?(input: {
    ownerId: string;
    workItemId: string;
    harness: string;
    question: string;
    brief: string;
  }): Promise<boolean>;
  /** Release a claimed work_item back to `todo` (delivery-miss cleanup). */
  releaseClaim?(workItemId: string, harness: string): Promise<void>;
  /** FALLBACK lane: spawn the ephemeral background agent, already owning the
   *  claimed item. */
  spawn(input: {
    spawnId: string;
    workItemId: string;
    harness: string;
    brief: string;
    timeoutMs: number;
  }): Promise<{ ok: boolean; spawnId?: string | null; error?: string }>;
  log?(msg: string): void;
}

export type DeepDelegateResult =
  | {
      ok: true;
      workItemId: string;
      /** null when the spawn failed — the item stays in the backlog as the fallback. */
      spawnId: string | null;
      spawned: boolean;
      /** D-003 primary lane: the live papercup-deep session the question was
       *  delivered to (coord message + wake). Absent on the spawn fallback. */
      deliveredTo?: string;
    }
  | { ok: false; error: string };

/** The brief handed to the ephemeral agent. The answer-shape contract matters:
 *  completion.summary is delivered VERBATIM into the conversation (and spoken),
 *  so it must lead with the speakable answer, not process narration. */
export function buildDeepBrief(workItemId: string, question: string, extra?: string | null): string {
  return [
    `You are an EPHEMERAL deep-analysis agent. You exist to answer ONE question, then exit.`,
    ``,
    `QUESTION: ${question}`,
    ...(extra?.trim() ? [``, `CONTEXT FROM THE CONVERSATION:`, extra.trim()] : []),
    ``,
    `Rules:`,
    `- Work ONLY this question. Do not pick up other work, claim other items, or spawn agents.`,
    `- Investigate properly (read code/state/docs as needed) — you were delegated to because this needs real thought.`,
    `- Deliver the answer by completing your work item:`,
    `  work_items:complete { id: '${workItemId}', state: 'resolved', completion: { status: 'done', summary: <THE ANSWER> } }`,
    `- completion.summary IS the answer the user hears: lead with 1-3 direct, speakable sentences,`,
    `  then supporting detail. No process narration, no "I investigated…" preamble.`,
    `- If you genuinely cannot answer, complete with state 'resolved' and a summary saying what`,
    `  you found and what is missing — silence is the only failure.`,
  ].join('\n');
}

/** The delegation message delivered to the LIVE persistent papercup-deep
 *  session (D-003 primary lane). Differs from buildDeepBrief in framing — the
 *  recipient is a PERSISTENT parked reasoner, not an ephemeral one-question
 *  agent — and it must be explicit that the work-item completion is the ONLY
 *  return channel: this delegation originates from the in-process converse
 *  front-end, which is not a coord peer, so a coord reply reaches no one. */
export function buildDeepPaneBrief(workItemId: string, question: string, extra?: string | null): string {
  return [
    `[deep-delegation ${workItemId}] A question from the user's conversation needs deep investigation.`,
    ``,
    `QUESTION: ${question}`,
    ...(extra?.trim() ? [``, `CONTEXT FROM THE CONVERSATION:`, extra.trim()] : []),
    ``,
    `Answer contract:`,
    `- Investigate for real (read code/state/docs as needed), then deliver the answer by completing the work item:`,
    `  work_items:complete { id: '${workItemId}', state: 'resolved', completion: { status: 'done', summary: <THE ANSWER> } }`,
    `- completion.summary IS what the user hears: lead with 1-3 direct, speakable sentences, then supporting detail.`,
    `- The work-item completion is the ONLY return channel for THIS delegation (it came from the in-process`,
    `  converse front-end, not a coord peer) — the settle-watch speaks it back; a coord reply reaches no one.`,
    `- If you genuinely cannot answer, complete with state 'resolved' and a summary saying what you found and`,
    `  what is missing — silence is the only failure.`,
  ].join('\n');
}

function newDeepSpawnId(): string {
  return `s-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

export async function delegateDeep(
  input: DeepDelegateInput,
  deps: DeepDelegateDeps,
): Promise<DeepDelegateResult> {
  const question = input.question.trim();
  if (!question) return { ok: false, error: 'empty question' };

  const title = question.length > TITLE_MAX ? `${question.slice(0, TITLE_MAX - 1)}…` : question;

  // ── D-003 PRIMARY lane: the live persistent papercup-deep session ─────────
  // Resolve BEFORE minting the item so it lands claimed by the right assignee.
  const deep =
    deps.findLiveDeepSession && deps.deliverToDeep
      ? await deps.findLiveDeepSession(input.workspaceId).catch(() => null)
      : null;
  if (deep) {
    const wi = await deps.createWorkItem({
      assignee: deep.ownerId,
      title: `Deep dive: ${title}`,
      summary: buildDeepPaneBrief('<pending>', question, input.brief),
      harness: input.harness ?? null,
      workspaceId: input.workspaceId,
    });
    if (!wi) return { ok: false, error: 'work_item create failed' };
    const delivered = await deps
      .deliverToDeep!({
        ownerId: deep.ownerId,
        workItemId: wi.id,
        harness: wi.harness,
        question,
        brief: buildDeepPaneBrief(wi.id, question, input.brief),
      })
      .catch(() => false);
    if (delivered) {
      return { ok: true, workItemId: wi.id, spawnId: null, spawned: false, deliveredTo: deep.ownerId };
    }
    // The deep session died between the presence read and the wake (rare race).
    // Release the claim so the durable item goes back to the backlog — it stays
    // visible (the Mug's survey sees open issue items), so the ask isn't lost.
    // No ephemeral re-spawn here: the item is already minted with the pane
    // brief, and re-plumbing the claim to a spawn id mid-flight trades a rare
    // slow answer for a claim-ownership mess.
    deps.log?.(`deep-delegate coord delivery missed for ${wi.id} (deep session ${deep.ownerId} gone?) — claim released, item stays in backlog`);
    await deps.releaseClaim?.(wi.id, wi.harness).catch(() => {});
    return { ok: true, workItemId: wi.id, spawnId: null, spawned: false };
  }

  // ── FALLBACK lane: ephemeral background spawn (no live deep session) ───────
  const spawnId = newDeepSpawnId();
  const wi = await deps.createWorkItem({
    assignee: spawnId,
    title: `Deep dive: ${title}`,
    summary: buildDeepBrief('<pending>', question, input.brief),
    harness: input.harness ?? null,
    workspaceId: input.workspaceId,
  });
  if (!wi) return { ok: false, error: 'work_item create failed' };

  const spawn = await deps
    .spawn({
      spawnId,
      workItemId: wi.id,
      harness: wi.harness,
      brief: buildDeepBrief(wi.id, question, input.brief),
      timeoutMs: DEEP_TIMEOUT_MS,
    })
    .catch((err) => ({ ok: false as const, error: (err as Error)?.message ?? String(err) }));
  if (!spawn.ok) {
    // The durable item survives the spawn miss — it stays visible in the backlog
    // (the Mug's survey sees settled/open issue items), so the ask isn't lost.
    deps.log?.(`deep-delegate spawn failed for ${wi.id}: ${spawn.error ?? 'unknown'}`);
    return { ok: true, workItemId: wi.id, spawnId: null, spawned: false };
  }
  return { ok: true, workItemId: wi.id, spawnId: spawn.spawnId ?? null, spawned: true };
}
