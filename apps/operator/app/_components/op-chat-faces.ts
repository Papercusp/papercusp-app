/**
 * op-chat-faces — the slot contract for EXTRA faces in the Papercup chat
 * sidebar's header row (WI-5162, owner ask 2026-07-17).
 *
 * The sidebar's built-in faces ([📥 Inbox] [🥤 Papercup] [🫖 Pot Health]) live
 * in OperatorChatSidebar itself. The Fleet + Peers faces that join them to the
 * RIGHT of 🫖 render panes (SwarmTab / VoiceTab) that live under
 * `apps/operator-vite/src` and import operator-vite-local modules
 * (`../adv/AgentsRunningPill`, `../voice-video/VideoGrid`, `@tanstack/react-router`).
 *
 * This app tree CANNOT import up-layer into operator-vite — `@` resolves to
 * operatorRoot (AGENT-ENV § "Cross-tree alias trap"), and operator-vite must be
 * able to import US, not the reverse. So the composition runs the other way,
 * exactly as quick-panel's status pills do (quick-panel-status-pills-2026-07-13
 * D-001, `QuickPanelPage({ headerSlot })`): the operator-vite ROUTE composes the
 * panes and passes them DOWN as descriptors, and this tree stays ignorant of
 * what's inside them.
 *
 * A descriptor is deliberately thin — the host owns the URL state (`?opcv`), the
 * pill chrome, the lit/pressed state and the body swap; the provider owns only
 * the id, how the face is labelled, and what the pane renders.
 */
import type { ReactNode } from 'react';

export type OpChatFace = {
  /**
   * The `?opcv` view value this face selects — must be URL-safe, stable
   * (it is deep-linkable + agent-driveable via ui:get_state / ui:dispatch)
   * and must not collide with a built-in view (BUILT_IN_CHAT_VIEWS below).
   */
  id: string;
  /** The pill's visible label, e.g. "Fleet". Already lexicon-resolved by the provider. */
  label: string;
  /** Hover tooltip — the one-line "what is this face for". */
  tip: string;
  /** Leading glyph, rendered at the 🫖/🥤 peers' scale. */
  icon: ReactNode;
  /**
   * The pane body, rendered in place of the chat when this face is lit.
   * A function (not a node) so an inactive face's pane never mounts — the
   * sidebar is boot-critical and these panes open live queries.
   */
  render: () => ReactNode;
};

/** Built-in view values the host owns; an extra face may not shadow one.
 *  `inbox` is the owner-selected Resolution Inbox restored by
 *  owner-inbox-single-pane-2026-07-17 D-009/P-012. Keep it in this parser
 *  contract so `?opcv=inbox` remains a canonical, reload-safe deep link. */
export const BUILT_IN_CHAT_VIEWS = ['chat', 'pot', 'inbox', 'plans'] as const;

/**
 * Drop faces whose id collides with a built-in view or with an earlier face.
 * A colliding id would make `?opcv` ambiguous (two faces lit at once, or an
 * extra face shadowing the chat), so we keep the FIRST and drop the rest
 * rather than render a broken header.
 */
export function dedupeChatFaces(faces: readonly OpChatFace[]): OpChatFace[] {
  const seen = new Set<string>(BUILT_IN_CHAT_VIEWS);
  const out: OpChatFace[] = [];
  for (const face of faces) {
    if (seen.has(face.id)) continue;
    seen.add(face.id);
    out.push(face);
  }
  return out;
}
