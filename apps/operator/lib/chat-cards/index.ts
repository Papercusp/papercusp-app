/**
 * Chat-card registry — public surface.
 *
 * Import once from this module; the side-effect imports below
 * register every known card tool. Future card-tool authors add a
 * line here (and ship an Entry module beside this one).
 *
 *   import { renderCard } from '@/lib/chat-cards';
 *   …
 *   const card = renderCard(toolCall.name, { args, answered, onAnswer });
 *   if (card) return card;            // matched a registered tool
 *   return renderToolChip(toolCall);  // fall through to default chip
 *
 * Plan ref: phase-4-endpoint-system-2026-05-12.md § T2.1.
 */

export { registerCard, renderCard, type CardRenderProps, type CardRenderer } from './registry';

// Side-effect: registers chat:ask_choice. Future cards add a line.
import './AskChoiceCardEntry';
// Side-effect: registers goals:propose — the GOAL-mode kickoff confirm card
// (goal-mode-2026-08-07 P-022 / D-024).
import './GoalProposalCardEntry';
