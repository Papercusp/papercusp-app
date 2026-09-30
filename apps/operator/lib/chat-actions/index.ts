/**
 * ChatAction registry — public surface.
 *
 * Import once from this module; the side-effect imports below register
 * every known action. Future action authors add a line here (and ship an
 * Entry module beside this one) — see lib/chat-cards/index.ts for the exact
 * same pattern one level over.
 *
 *   import { listChatActions } from '@/lib/chat-actions';
 *   const actions = listChatActions(ctx);
 *
 * No concrete actions are registered yet — this is the substrate
 * (gui-chat-session-controls-2026-07-25 P-002). Posture (P-004), grade
 * (P-005), and session actions (P-006) each add an Entry module + a line
 * below without touching the bar or the registry.
 */

export {
  registerChatAction,
  getChatAction,
  listChatActions,
  listAllChatActionIds,
  registerChatModeAction,
  getChatModeAction,
  listChatModeActions,
  listAllChatModeActionIds,
  _resetChatActionsForTests,
} from './registry';
export type {
  ChatAction,
  ChatActionContext,
  ChatActionConfirm,
  ChatModeAction,
  ChatModeOption,
  ChatModeState,
} from './types';

// Side-effect: registers concrete actions.
//
// There is deliberately no `GradeAction` here. It was a 'Grade session…' button
// that opened a rubric picker and then set grade mode ON — i.e. the same
// mode:set the GRADE pill (PostureActions' overlay pills) already performs, so
// the two read as one duplicated control. Removed [owner 2026-08-03]:
// "remove the grade session button next to focus window, we dont need it if we
// have the grade on off toggle right above it".
//
// What went with it: the rubric CHOICE. The pill turned grade mode on without
// naming a rubric, and the rubric only ever rode in mode:set's free-text
// `reason`, never as structured state.
//
// RESOLVED 2026-08-03 (WI-7471) — [owner] "I want the rubric picker back, add
// that to the grade on/off toggle." The choice is back, in the shape this note
// predicted: the GRADE pill itself now offers Off + one row per active rubric
// (PostureActions' own `mode-grade` registration, no longer one of the
// boolean overlays). The blocker this note recorded is gone too —
// `ChatModeAction.options()` may now return a promise, and ChatActionBar
// resolves it lazily on menu open, so the fetch costs nothing on a popup where
// nobody opens GRADE.
//
// So there is still deliberately no `GradeAction` module: the rubric picker
// exists, it just is not a second button.
import './PostureActions';
import './SessionActions';
// CTX — the context-runway pill (WI-6507). Registration happens through this
// side-effect import; WI-6450 is the standing reminder of what a missing line
// here costs (the whole bar once shipped DEAD because nothing imported this
// barrel), so do not "tidy" these into anything lazier.
import './ContextLimitAction';
// The ACCOUNT pill (WI-6509 / hud-chat-owner-controls-2026-08-11 P-003). This
// line is not optional bookkeeping: registration happens by SIDE EFFECT, so an
// axis module nothing imports is tree-shaken out and the pill simply never
// appears — the WI-6450 failure, which looked like a broken bar rather than a
// missing import.
import './AccountAction';
// The MODEL pill (WI-6510 / hud-chat-owner-controls-2026-08-11 P-002). Same
// side-effect registration as the two above, and the same WI-6450 consequence if
// this line is ever "tidied" away: the axis module would be tree-shaken out and
// the pill would simply never render — which looks like a broken bar rather than
// a missing import.
import './ModelActions';
