import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

/**
 * voice:delegate_deep — the deep-thinking delegation lane
 * (voice-unified-sentinel-pipeline-2026-07-01 P-005/P-006; re-pointed by
 * voice-public-release-readiness-2026-07-12 P-019 per its D-003; made the chat
 * papercup role's tool on BOTH hosts by papercup-chat-one-component-one-
 * contract-2026-09-06 P-005, D-007 §3).
 *
 * HARD THINKING (analysis / research / comparison where the user expects an
 * ANSWER back in the conversation) must not block the conversational pane, and
 * must not go to the Queen (she orchestrates; her wake loop is placement-shaped,
 * not an answer channel). This tool mints a durable `deep-delegation` work_item
 * and routes the question to the LIVE persistent papercup-deep session (the
 * parked heavy-reasoner pane, D-006) over coord/wake — falling back to an
 * EPHEMERAL background agent when no deep session is running (capped at 2 in
 * flight).
 *
 * TWO return legs, chosen by `wait`:
 *   - `wait:false` (default; the PANE papercup): the completion.summary is
 *     injected back into the pane as `[deep-answer WI-NNN] …` — spoken + written
 *     through the one pipeline (papercup-deep-watch.ts).
 *   - `wait:true` (the CONVERSE chat surfaces — desktop + portal, D-007 §3): the
 *     call BLOCKS (bounded) until the item settles and returns the answer as the
 *     tool result, so the quick chat model presents it in the SAME turn — exactly
 *     like chat:ask_choice blocking on the user's pick. A converse turn ends when
 *     the model stops, so a later pane push would reach no one.
 *
 * NOTE for the PANE papercup (psu --role=papercup): you hold the coord tools —
 * prefer asking the deep brain DIRECTLY (coord:send { wake: 'required' } per
 * your playbook, replies threaded back to YOU); this tool is the lane for the
 * converse/EL surfaces, where no coord session exists to receive a reply.
 *
 * THE TOOL DELIVERS/SPAWNS, NOT THE SENTINEL: the sentinel role still holds no
 * cup:spawn capability (the SN-H04 no-spawn contract); this is the
 * accountable, capped indirection. Split of lanes: buildable WORK still goes to
 * the Queen via handoff; THINKING comes here.
 */

/** Default same-turn wait budget (seconds) when `wait:true` omits `waitSec`. */
export const DEEP_ANSWER_WAIT_DEFAULT_SEC = 240;
/** Hard cap on the same-turn wait — under the converse brain's 600s idle cap
 *  (converse.ts idleTimeoutSec) with headroom for the model to present it. */
export const DEEP_ANSWER_WAIT_MAX_SEC = 540;

export default defineTool({
  name: 'voice:delegate_deep',
  profile: 'engineer',
  description:
    'Delegate a HARD-THINKING question (analysis/research/deep comparison) to the deep brain (the live papercup-deep session; ephemeral agent fallback). With wait:true (the chat surfaces) the call blocks until the deep brain answers and returns `answer` in this same turn — present it. Without wait, the answer comes back later as `[deep-answer WI-NNN] …` pane input. Capped at 2 in flight.',
  capability: 'operator:read',
  guidance: {
    when: `The user asked something that needs REAL investigation (minutes of reading code/state/docs) and expects an ANSWER back in conversation. In a CHAT turn (converse — desktop or portal): call it with wait:true and present the returned \`answer\` in the same reply (lead with the speakable core, then the detail); if it comes back pending, say the dive is in flight — never invent the answer. In the PANE: delegate without wait, voice:say a short ack ("digging into that — I'll come back to you"), and present the [deep-answer WI-NNN] message when it arrives.`,
    notWhen: `Trivia you can answer now (just answer). Buildable WORK ("build X", "fix Y") — that's a Mug handoff, not a deep dive. More than 2 in flight — the tool refuses; tell the user one is already cooking.`,
    chaining: `Chat: voice:delegate_deep { question, brief, wait:true } → present result.answer. Pane: voice:delegate_deep { question } → voice:say the ack → (later) the [deep-answer] arrives as pane input → voice:say the answer. Check progress via work_items:get on the returned workItemId.`,
    seeAlso: ['voice:say (speak the ack + the answer)', 'work_items:get (progress on a delegation)'],
  },
  requirePrincipal: false,
  // The pane Sentinel is the primary caller; the operator persona may delegate too.
  agentRoles: ['papercup', 'operator'],
  rolesQuota: { sentinel: { perRun: 50 }, papercup: { perRun: 50 }, operator: { perRun: 50 } }, // papercup: pot-rename dual-accept twin of sentinel (P1 MIGRATE)
  // A `wait:true` call blocks up to DEEP_ANSWER_WAIT_MAX_SEC while the deep brain
  // works; the per-tool default (dispatch-stack: 60s) would abort it mid-wait and
  // the brain would present a dead result. Mirror chat:ask_choice's caps.
  timeoutSec: 600,
  idleTimeoutSec: 600,
  args: z.object({
    question: z.string().min(1).describe("The user's question, as asked — the whole ask, not a fragment."),
    brief: z
      .string()
      .optional()
      .describe('Optional context the agent needs (recent conversation excerpt, constraints, refs).'),
    harness: z
      .string()
      .optional()
      .describe('Harness the background agent spawns into (default: the pot home).'),
    wait: z
      .boolean()
      .optional()
      .describe(
        'Block until the deep brain answers and return `answer` in this call (the chat surfaces). Default false: the answer is pushed to the pane later.',
      ),
    waitSec: z
      .number()
      .int()
      .min(5)
      .max(DEEP_ANSWER_WAIT_MAX_SEC)
      .optional()
      .describe(`With wait:true — how long to block, seconds (default ${DEEP_ANSWER_WAIT_DEFAULT_SEC}, max ${DEEP_ANSWER_WAIT_MAX_SEC}).`),
  }),
  async handler(args, ctx) {
    // Lazy imports keep the spawn/DBOS chain off the tool-mount path (the same
    // reason fleet/spawn.ts dynamic-imports operator-spawn).
    const [{ delegateDeep }, { defaultDeepDelegateDeps }, { activeWorkspaceId }] =
      await Promise.all([
        import('../../papercup/papercup-deep-delegate'),
        import('../../papercup/papercup-deep-delegate-deps'),
        import('../../workspace-registry'),
      ]);
    const workspaceId =
      ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : activeWorkspaceId();
    const result = await delegateDeep(
      {
        question: args.question,
        brief: args.brief ?? null,
        harness: args.harness ?? null,
        workspaceId,
      },
      defaultDeepDelegateDeps(),
    );
    if (!args.wait || !result.ok) {
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }

    // Same-turn return leg (D-007 §3): poll the delegation item until it settles
    // or the budget runs out. The completion.summary the deep brain recorded IS
    // the answer (terminalCompletionRef).
    const [{ awaitDeepAnswer, renderDeepAnswerPending }, { getWorkItem }, { isTerminalStateInput }] =
      await Promise.all([
        import('../../papercup/papercup-deep-answer-wait'),
        import('../../work-items'),
        import('../../work-item-dispatch-states'),
      ]);
    const waitSec = Math.min(args.waitSec ?? DEEP_ANSWER_WAIT_DEFAULT_SEC, DEEP_ANSWER_WAIT_MAX_SEC);
    const outcome = await awaitDeepAnswer({
      workItemId: result.workItemId,
      harness: null,
      waitMs: waitSec * 1000,
      signal: ctx.signal,
      read: async (id) => {
        const wi = await getWorkItem(id);
        if (!wi) return null;
        return {
          state: wi.state,
          terminalCompletionRef:
            (wi as { terminalCompletionRef?: string | null }).terminalCompletionRef ?? null,
          title: wi.title,
        };
      },
      isTerminal: isTerminalStateInput,
    });
    const payload = outcome.settled
      ? { ...result, waited: true, settled: true, state: outcome.state, answer: outcome.answer }
      : {
          ...result,
          waited: true,
          settled: false,
          pending: true,
          state: outcome.state,
          answer: null,
          note: renderDeepAnswerPending(result.workItemId, outcome.waitedMs),
        };
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  },
});
