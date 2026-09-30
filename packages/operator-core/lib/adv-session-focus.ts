/**
 * Shared focus service for tracked advanced sessions.
 *
 * Both the operator GUI endpoint and the agent-facing coordination tool use
 * this module. Keeping resolution and activation here prevents the two entry
 * points from drifting into subtly different definitions of “focused”.
 */
import type { AdvSessionRow } from './adv-sessions';
import { setAdvSessionWindowId } from './adv-sessions';
import {
  focusWindowId,
  resolveWindowIdForPid,
  resolveWindowIdForTitleFragment,
} from './adv-session-windows';

export interface SessionWindowControlInput {
  id?: number;
  pid?: number;
  windowId?: string | null;
}

export interface SessionFocusDeps {
  resolveByPid?: typeof resolveWindowIdForPid;
  resolveByTitle?: typeof resolveWindowIdForTitleFragment;
  rememberWindowId?: typeof setAdvSessionWindowId;
  focus?: typeof focusWindowId;
}

export type SessionFocusResult =
  | { focused: true; windowId: string }
  | {
      focused: false;
      windowId: string | null;
      code: 'no_window' | 'focus_failed';
      reason: string;
    };

/**
 * Resolve the window for a session-control action, cheapest source first.
 *
 * The final owner-title fallback is what makes psu/fleet sessions focusable:
 * those terminals have no per-window pid (gnome-terminal shares one server)
 * and often no recorded window id, but their title contains the short
 * coordination owner id. Resolved ids are cached on the adv row for the next
 * click/call.
 */
export async function resolveSessionWindowId(
  body: SessionWindowControlInput,
  latestRow: AdvSessionRow | null,
  deps: SessionFocusDeps = {},
): Promise<string | null> {
  const resolveByPid = deps.resolveByPid ?? resolveWindowIdForPid;
  const resolveByTitle = deps.resolveByTitle ?? resolveWindowIdForTitleFragment;
  const rememberWindowId = deps.rememberWindowId ?? setAdvSessionWindowId;

  let windowId = body.windowId ?? null;
  if (!windowId && latestRow?.windowId) windowId = latestRow.windowId;
  if (!windowId && typeof body.pid === 'number') windowId = await resolveByPid(body.pid);
  if (!windowId && latestRow?.id) {
    windowId = await resolveByTitle(`[adv:${latestRow.id}]`);
    if (windowId) await rememberWindowId(latestRow.id, windowId);
  }
  if (!windowId && latestRow?.coordOwnerId) {
    const shortId = latestRow.coordOwnerId.slice(0, 8);
    if (shortId.length >= 6) {
      windowId = await resolveByTitle(shortId);
      if (windowId && latestRow.id) await rememberWindowId(latestRow.id, windowId);
    }
  }
  return windowId;
}

/** Resolve and observably activate one tracked session window. */
export async function focusSessionWindow(
  body: SessionWindowControlInput,
  latestRow: AdvSessionRow | null,
  deps: SessionFocusDeps = {},
): Promise<SessionFocusResult> {
  const windowId = await resolveSessionWindowId(body, latestRow, deps);
  if (!windowId) {
    return {
      focused: false,
      windowId: null,
      code: 'no_window',
      reason: 'could not resolve a window id (headless session, missing desktop metadata, or no matching window)',
    };
  }

  try {
    const focused = await (deps.focus ?? focusWindowId)(windowId);
    return focused
      ? { focused: true, windowId }
      : {
          focused: false,
          windowId,
          code: 'focus_failed',
          reason: 'the desktop did not report the target window as active',
        };
  } catch (error) {
    return {
      focused: false,
      windowId,
      code: 'focus_failed',
      reason: `focus failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
