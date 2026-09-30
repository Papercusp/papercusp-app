/**
 * What the HUD does with the result of a "+ New session" launch.
 *
 * This exists as its own unit for one reason: the null branch is the branch
 * nobody looks at, and it is the branch that produced an owner bug report
 * (WI-38009, 2026-08-11 — "I tried clicking new session in the hud tab but it
 * resumed an existing session"). Inline in HudView's JSX it was a bare
 * `if (!ownerId) return;` with no test able to reach it.
 *
 * The trap it encodes: by the time this runs, NewSessionLauncher has ALREADY
 * fired a success toast. So "do nothing" is not neutral — it leaves the user
 * looking at whichever chat was previously open while every visible signal says
 * the launch worked. A stale pane plus a success toast is indistinguishable
 * from a deliberate resume, which is precisely how it was reported.
 *
 * Reproduced live on an isolated Tauri instance: stub
 * /api/adv/sessions/launch-su to return {status:'ok'} with no ownerId, click
 * "+ New session" with a chat already open, and `hudsession` never moves.
 */
export type HudLaunchOpenDecision =
  | { kind: 'open'; ownerId: string }
  | { kind: 'warn'; message: string };

/**
 * A launch that returns no coord owner id genuinely happened — an agent IS
 * running — we simply have no handle to open it with. Say that rather than
 * guessing an id (a wrong-but-truthy handle would open the WRONG session) and
 * rather than staying silent.
 */
export const HUD_LAUNCH_NO_OWNER_MESSAGE =
  'Session launched, but this operator returned no session id to open — the chat still shows the PREVIOUS session. Find the new one in the board below.';

export function hudLaunchOpenDecision(ownerId: string | null | undefined): HudLaunchOpenDecision {
  // Deliberately falsy-checked, not null-checked: an empty string is just as
  // unusable as null as a chat key, and would otherwise sail through to
  // setOpenOwner('') and blank the pane.
  if (!ownerId) return { kind: 'warn', message: HUD_LAUNCH_NO_OWNER_MESSAGE };
  return { kind: 'open', ownerId };
}
