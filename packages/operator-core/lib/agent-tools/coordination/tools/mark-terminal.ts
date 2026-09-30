/**
 * coord:mark-terminal — visually mark a peer's owned terminal window so a
 * human can FIND / FOCUS it (EI-19948333346987654).
 *
 * ROOT PROBLEM this answers: on GNOME Wayland, wmctrl/xdotool return an
 * EMPTY result with exit 0 when asked to find/focus a window by title or
 * pid — indistinguishable from "no such window exists". Window-manager-level
 * focus is therefore out of reach (a GNOME-extension fix is owner-gated, not
 * something this codebase can land). The fix that IS in reach: retitle the
 * target's terminal with a loud, unmistakable marker so a human visually
 * scanning open windows can pick it out immediately.
 *
 * Two delivery paths, tried in order, each best-effort:
 *
 *  1. recolorViaPty(ownerId, osc) — the existing managed-pty-host IPC path
 *     (the same primitive fleet:recolor uses). Verified ownership via the
 *     live psu-pty socket registry; works whenever the target is currently
 *     hosted by a psu-pty-managed session.
 *
 *  2. Direct OSC write to the target's `coord_presence.tty` device path
 *     (harness_shared.coord_presence.tty — landed for this same work item,
 *     migration 768). Covers a session that owns a real terminal but is not
 *     (or is not currently) registered as a psu-pty host — the gap path 1
 *     alone cannot close. Guarded by the same tty-CLAIM check
 *     psu-launcher/pc_tty.py use for self-retitling (EI-10377): a pty minor
 *     number is recycled once its old holder closes it, so before writing we
 *     confirm the CURRENT claim in ~/.papercusp/tty-claims still names this
 *     exact ownerId — otherwise we could silently retitle a totally
 *     unrelated, currently-live session that happens to have inherited the
 *     same recycled /dev/pts/N path.
 *
 * Purely cosmetic + best-effort throughout: a failed write on both paths is
 * reported, never thrown — marking a terminal must never be able to break a
 * caller's turn.
 */
import { readFile } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getPresence } from '../presence';
import { recolorViaPty } from '../../../events/await/psu-pty-discovery';
import { COORD_ROLES } from '../roles';

/** Drop control chars that could break out of the OSC string (mirrors
 *  status-display.ts's stripControl / pc_tty.py's strip_control — kept as a
 *  tiny local copy rather than exporting a private helper across modules). */
function stripControl(text: string): string {
  return Array.from(text)
    .filter((c) => c.codePointAt(0)! >= 32 && c !== '\x07' && c !== '\x1b')
    .join('');
}

/** OSC 0 (title) escape, BEL-terminated. '' when there's nothing safe to write. */
function oscTitle(title: string): string {
  const clean = stripControl(title);
  return clean ? `\x1b]0;${clean}\x07` : '';
}

function ttyClaimsDir(): string {
  return (process.env.PAPERCUSP_TTY_CLAIMS_DIR ?? '').trim() || join(homedir(), '.papercusp', 'tty-claims');
}

function ttyClaimFilename(ttyPath: string): string {
  return ttyPath.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+/, '');
}

/**
 * Does the CURRENT claim on terminal `ttyPath` name `ownerId`? Mirrors
 * pc_tty.py's tty_owned_by_us, adapted to check a TARGET session's claim
 * (not our own) before we write into its terminal. No claim on record (older
 * psu build, unreadable claims dir) fails OPEN — the claim file is a
 * best-effort safety net layered on top of the direct-write fallback, not a
 * hard gate; the write itself is already best-effort and purely cosmetic.
 */
async function ttyClaimedBy(ttyPath: string, ownerId: string): Promise<boolean> {
  try {
    const claimed = (await readFile(join(ttyClaimsDir(), ttyClaimFilename(ttyPath)), 'utf8')).trim();
    return claimed === ownerId;
  } catch {
    return true; // no claim on record — fail open
  }
}

export default defineTool({
  name: 'coord:mark-terminal',
  // @no-coord-tier A human-affordance utility, not an agent coordination behaviour: it retitles a
  // peer's terminal window so a PERSON can find/focus it where the window manager cannot (GNOME
  // Wayland). D-001's ladder ranks how reliably an AGENT is made to perform a coordination
  // behaviour; nothing should make an agent call this unbidden — it is invoked only when a human
  // asks "where is agent X's window". A tier here would assert enforcement of a behaviour that
  // deliberately has no adoption target.
  description:
    "Visually mark a peer agent's owned terminal window by retitling it with a loud marker. This does NOT focus or raise the window: use coord:focus-window first for an actual focus/foreground request, then use this fallback only when activation fails and a human must find the window manually. Best-effort over a live psu-pty host or the session's recorded terminal device.",
  guidance: {
    when:
      "Actual activation through coord:focus-window failed, and the human wants a loud title marker to locate the already-known terminal manually. Also useful to visually distinguish one agent's window among many open panes.",
    notWhen:
      "Do not use this as success for 'focus/raise/bring forward' — call coord:focus-window. Not a substitute for coord:presence/fleet:assignments to find WHICH agent is doing what. A headless session cannot be marked; the result says so.",
    returns:
      "{ ok: boolean, ownerId, landed: boolean, via: 'psu-pty' | 'tty' | null, title, reason? }. landed:false with reason describes why (no presence row, no tty on record, claim mismatch, write failed).",
    seeAlso: ['coord:focus-window (primary focus/raise action before this title-only fallback)'],
  },
  capability: 'coord:mark-terminal',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    ownerId: z.string().min(1).describe('The target session/agent id (from coord:presence / fleet:assignments).'),
    label: z
      .string()
      .max(60)
      .optional()
      .describe('Optional short text appended to the marker title (e.g. a reason, or your own id).'),
  }),
  result: z
    .object({
      ok: z.boolean(),
      ownerId: z.string(),
      landed: z.boolean(),
      via: z.enum(['psu-pty', 'tty']).nullable(),
      title: z.string().nullable(),
      reason: z.string().optional(),
    })
    .passthrough(),
  async handler(args) {
    const shortId = args.ownerId.length > 12 ? args.ownerId.slice(0, 12) : args.ownerId;
    const title = `🔴🔴 FIND ME · ${shortId}${args.label ? ` · ${args.label}` : ''}`;
    const osc = oscTitle(title);

    // Path 1: the managed-pty-host IPC route (same primitive as fleet:recolor).
    const viaPty = await recolorViaPty(args.ownerId, osc).catch(() => false);
    if (viaPty) {
      return { data: { ok: true, ownerId: args.ownerId, landed: true, via: 'psu-pty', title } };
    }

    // The managed-pty path is independently owner-bound and can succeed even
    // when the target has not written a coord_presence row yet. Only the raw
    // tty fallback needs presence metadata.
    const presence = await getPresence(args.ownerId);
    if (!presence) {
      return { data: { ok: false, ownerId: args.ownerId, landed: false, via: null, title, reason: 'no presence row for that ownerId — see coord:presence' } };
    }

    // Path 2: direct write to the recorded terminal device, guarded by the
    // recorded claim (EI-10377) so a recycled pty can't be mis-marked.
    const ttyPath = presence.tty;
    if (!ttyPath) {
      return { data: { ok: false, ownerId: args.ownerId, landed: false, via: null, title, reason: 'no tty recorded for that session (headless, or a pre-tty-column session that has not re-heartbeat yet)' } };
    }
    const owned = await ttyClaimedBy(ttyPath, args.ownerId);
    if (!owned) {
      return { data: { ok: false, ownerId: args.ownerId, landed: false, via: null, title, reason: `the recorded tty (${ttyPath}) is currently claimed by a different session — refusing to mark a possibly-unrelated window` } };
    }
    try {
      await writeFile(ttyPath, osc);
      return { data: { ok: true, ownerId: args.ownerId, landed: true, via: 'tty', title } };
    } catch (err) {
      return { data: { ok: false, ownerId: args.ownerId, landed: false, via: null, title, reason: `write to ${ttyPath} failed: ${err instanceof Error ? err.message : String(err)}` } };
    }
  },
});
