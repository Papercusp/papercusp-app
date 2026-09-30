/**
 * Owner-desktop-notification lockout for agent sessions
 * (owner directive 2026-07-14: agents were hand-firing `notify-send` popups at
 * the owner's desktop — "they are annoying, turn them back off … I just don't
 * want to make this an easy to access path").
 *
 * Agents run with full shell access, so this is deliberately an EASY-PATH
 * REMOVAL, not a sandbox (the owner's framing): the harness-level Bash deny
 * below removes the obvious `notify-send` invocations from every claude agent
 * session's toolset, and it LAYERS with two other legs:
 *   - the PATH shim at `~/.papercusp/bin/notify-send` (prepended to PATH for
 *     every psu launch, all backends) — swallows + logs bare-name calls,
 *     including the compound forms (`x && notify-send …`) prefix rules can't
 *     see, and covers omp/codex sessions this claude flag never reaches;
 *   - the standing rule in root CLAUDE.md — route human-facing alerts through
 *     `coord:escalate` / notifyAttention (which respect the owner's
 *     notification settings) instead of the desktop bus.
 *
 * Applied UNCONDITIONALLY to every claude agent launch (headless invoke
 * spawns, wake-executor resumes, interactive psu su/role panes) — mirrors the
 * subagent deny's posture, incl. under an operator-supplied deny list: claude
 * UNIONS repeated `--disallowedTools` occurrences (verified live, see
 * no-subagent-deny.ts), so this composes rather than overrides.
 *
 * Flag form: single `=` token (D-002 in native-scheduler-deny.ts — the space
 * form greedily eats following tokens). Entries stay space-free so the join
 * survives. psu-launcher.mjs (plain-node, can't import TS) duplicates the
 * rendered literal as OWNER_DESKTOP_NOTIFY_DENY_FLAG; the lockstep test in
 * apps/operator/lib/psu-launcher.test.ts pins the two copies together.
 */

/** `Bash(<cmd>:*)` deny patterns: the bare name + the absolute paths that make
 *  bypassing the PATH shim a one-token edit. */
export const OWNER_DESKTOP_NOTIFY_BASH_DENY = [
  'Bash(notify-send:*)',
  'Bash(/usr/bin/notify-send:*)',
  'Bash(/bin/notify-send:*)',
] as const;

/** The ready-to-append argv token (claude CLI). Single `=` token — see header. */
export function ownerDesktopNotifyDenyFlag(): string {
  return `--disallowedTools=${OWNER_DESKTOP_NOTIFY_BASH_DENY.join(',')}`;
}
