/**
 * ChatAction registry — Map-based lookup, same pattern as
 * lib/chat-cards/registry.ts (tool-name → card renderer).
 *
 * A concrete action module calls `registerChatAction` at import time;
 * lib/chat-actions/index.ts side-effect-imports every known action module
 * so consumers (ChatActionBar) see them all by importing once.
 */
import type { ChatAction, ChatActionContext, ChatModeAction } from './types';

const REGISTRY = new Map<string, ChatAction>();

/**
 * Register an action. Re-registering the same id replaces the prior
 * descriptor (lets HMR work in dev, same as registerCard).
 */
export function registerChatAction(action: ChatAction): void {
  REGISTRY.set(action.id, action);
}

export function getChatAction(id: string): ChatAction | undefined {
  return REGISTRY.get(id);
}

/**
 * Actions available right now for `ctx`, in registration order. A throwing
 * `available()` is treated as "not available" (logged, not fatal) — one
 * broken action must not blank the whole bar.
 */
export function listChatActions(ctx: ChatActionContext): ChatAction[] {
  const out: ChatAction[] = [];
  for (const action of REGISTRY.values()) {
    let ok: boolean;
    try {
      ok = action.available(ctx);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[chat-actions] ${action.id}.available threw`, e);
      continue;
    }
    if (ok) out.push(action);
  }
  return out;
}

/** All registered ids, regardless of availability. Test/debug use. */
export function listAllChatActionIds(): string[] {
  return [...REGISTRY.keys()];
}

/* ── Mode-actions (P-005) ──────────────────────────────────────────────────
 * A SEPARATE map, not a `kind` field on the one above. The two shapes have
 * different contracts (a verb vs a value + its setter) and the bar renders
 * them as different shapes in different clusters, so every consumer would
 * immediately have to re-split a merged list — and a merged list is one
 * missed narrowing away from rendering a mode as a button, which is the exact
 * confusion this item exists to remove.
 * ────────────────────────────────────────────────────────────────────────── */

const MODE_REGISTRY = new Map<string, ChatModeAction>();

/** Register a mode-action. Re-registering the same id replaces it (HMR). */
export function registerChatModeAction(action: ChatModeAction): void {
  MODE_REGISTRY.set(action.id, action);
}

export function getChatModeAction(id: string): ChatModeAction | undefined {
  return MODE_REGISTRY.get(id);
}

/**
 * Mode-actions available right now for `ctx`, in registration order. Same
 * fail-soft contract as `listChatActions`: a throwing `available()` drops that
 * one axis rather than blanking the band.
 */
export function listChatModeActions(ctx: ChatActionContext): ChatModeAction[] {
  const out: ChatModeAction[] = [];
  for (const action of MODE_REGISTRY.values()) {
    let ok: boolean;
    try {
      ok = action.available(ctx);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[chat-actions] mode ${action.id}.available threw`, e);
      continue;
    }
    if (ok) out.push(action);
  }
  return out;
}

/** All registered mode ids, regardless of availability. Test/debug use. */
export function listAllChatModeActionIds(): string[] {
  return [...MODE_REGISTRY.keys()];
}

/** Test-only — flush both registries between specs. */
export function _resetChatActionsForTests(): void {
  REGISTRY.clear();
  MODE_REGISTRY.clear();
}
