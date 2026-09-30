/**
 * Registers `goals:propose` with the chat-card registry, so a GOAL-mode
 * agent's proposal renders as the pre-filled confirm card instead of four
 * values narrated in prose (goal-mode-2026-08-07 P-022, ruling D-024).
 *
 * Imported for its side effect by `apps/operator/lib/chat-cards/index.ts`.
 *
 * ── Why a WRAPPER COMPONENT rather than rendering the card directly ─────────
 * `CardRenderProps` carries only `{ args, answered, onAnswer }` — by design,
 * since the registry is a pure name→renderer map with no app context. But the
 * write needs the ACTIVE WORKSPACE, and threading it through the registry would
 * force every card to know about it. So the renderer returns a tiny component
 * that resolves the workspace from the same hook every other goal surface uses
 * (`useWorkspaceId`, the one GoalTab's header comment insists on) — hooks are
 * legal here because this function runs during the consumer's render.
 *
 * Getting that wrong is not cosmetic: a hardcoded or omitted workspace would
 * write the goal into the wrong tenant, which is the exact failure GoalTab
 * documents (WI-5125 — 181 rows invisible because a read was pointed at the
 * wrong tenant and looked merely empty). The route refuses an unknown workspace
 * rather than defaulting, so a bad value fails loudly instead of landing
 * somewhere plausible.
 *
 * ── `onAnswer` is deliberately UNUSED ──────────────────────────────────────
 * This card does not answer the agent — its button performs the create itself
 * (D-024: a registry card in a session transcript has no answer channel at all,
 * so a card that depended on one would be dead exactly where goal kickoff
 * happens). The prop stays in the signature because the registry supplies it.
 */

import { GoalProposalCard, type GoalProposalArgs } from '@/app/_components/chat/GoalProposalCard';
import { useWorkspaceId } from '@/lib/use-workspace-id';
import { registerCard } from './registry';

/**
 * Shape-guard the tool args before rendering.
 *
 * The card is fed the model's RAW tool input off the transcript, so a
 * half-formed call must fall through to the default tool chip rather than
 * render a card with blank required fields — a blank confirm card is precisely
 * the blank form P-022 exists to remove.
 */
export function isGoalProposalArgs(v: unknown): v is GoalProposalArgs {
  if (!v || typeof v !== 'object') return false;
  const a = v as Partial<GoalProposalArgs>;
  if (typeof a.title !== 'string' || a.title.trim() === '') return false;
  if (typeof a.killCriterion !== 'string' || a.killCriterion.trim() === '') return false;
  if (typeof a.budgetCents !== 'number' || !Number.isFinite(a.budgetCents)) return false;
  if (!a.relationship || typeof a.relationship !== 'object') return false;
  if (typeof a.relationship.kind !== 'string') return false;
  return true;
}

function GoalProposalCardHost({ args }: { args: GoalProposalArgs }) {
  const workspaceId = useWorkspaceId();
  return <GoalProposalCard args={args} workspaceId={workspaceId} />;
}

registerCard<unknown>('goals:propose', ({ args }) => {
  if (!isGoalProposalArgs(args)) return null;
  return <GoalProposalCardHost args={args} />;
});
