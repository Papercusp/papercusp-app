/**
 * useOpenHudConversation — "show me THIS agent's conversation", as one call.
 *
 * resume-in-gui-button-2026-08-09 (owner ask 2026-08-09: a "Resume in GUI" button that
 * resumes a session "in the HUD -> conversation popup" instead of a terminal).
 *
 * The HUD conversation popup is `SessionChatModal`, mounted by `HudView` and addressed
 * ENTIRELY through the URL: it opens on whatever coord owner id sits in `hudsession`,
 * and `HudView` only renders while the /adv shell is on `tab=hud`. So "open the
 * conversation" is a URL write, not a component call — which is exactly what makes it
 * reachable from the agents-running dropdown in the header, three tabs away.
 *
 * It lives here (operator-vite) rather than in `AgentInspectorModal` because the modal
 * is in `apps/operator`, which CANNOT import operator-vite/src — operator-vite's `@`
 * alias resolves the other direction (AGENT-ENV § cross-tree alias trap). The modal
 * therefore takes an `onOpenInGui` callback and the vite-side call sites hand it this
 * hook: the same seam every other cross-tree affordance here uses.
 *
 * Four writes, each load-bearing:
 *   1. `tab=hud` — HudView is not mounted on any other tab, so without this the
 *      `hudsession` we just set would sit in the URL doing nothing.
 *   2. `hudsession=<coordOwnerId>` — the popup's address.
 *   3. `agentsRoster=null` — close the agents-running popover we were launched from.
 *      Radix renders it above the board (WI-35969 raised the modal layer over the
 *      popper floor precisely because these two overlap), so leaving it open would
 *      cover the conversation the click just asked for.
 *   4. `hudfocus*=null` — DROP any stale transcript anchor. Those four params anchor
 *      the popup at a SPECIFIC turn of a SPECIFIC agent from a HUD search; carried
 *      into a different agent's conversation they scroll to a turn that does not exist
 *      in it. HudView clears them the same way when hopping between agents.
 */
import { useCallback } from 'react';
import { parseAsBoolean, parseAsString, useQueryState } from 'nuqs';

/**
 * Returns `openHudConversation(ownerId)` — switches the /adv shell to the HUD tab with
 * that agent's conversation popup open, and closes the agents-running popover.
 *
 * `ownerId` is a COORD owner id (`su-…`), the key `SessionChatModal` resolves against
 * the roster — never an adv_sessions row id.
 */
export function useOpenHudConversation(): (ownerId: string) => void {
  // Same key + parser AdvShell owns for the tab strip. A literal 'hud' is written
  // rather than a typed enum import so this hook stays a leaf module (importing
  // AdvShell would pull the whole shell bundle into the header pill).
  const [, setTab] = useQueryState('tab', parseAsString);
  const [, setHudSession] = useQueryState('hudsession', parseAsString);
  const [, setAgentsRoster] = useQueryState('agentsRoster', parseAsBoolean);
  const [, setHudFocus] = useQueryState('hudfocus', parseAsString);
  const [, setHudFocusTs] = useQueryState('hudfocusts', parseAsString);
  const [, setHudFocusQ] = useQueryState('hudfocusq', parseAsString);
  const [, setHudFocusSid] = useQueryState('hudfocussid', parseAsString);

  return useCallback(
    (ownerId: string) => {
      if (!ownerId) return;
      void setHudFocus(null);
      void setHudFocusTs(null);
      void setHudFocusQ(null);
      void setHudFocusSid(null);
      void setAgentsRoster(null);
      void setTab('hud');
      void setHudSession(ownerId);
    },
    [setTab, setHudSession, setAgentsRoster, setHudFocus, setHudFocusTs, setHudFocusQ, setHudFocusSid],
  );
}

export default useOpenHudConversation;
