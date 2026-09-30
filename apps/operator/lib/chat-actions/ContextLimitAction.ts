/**
 * CTX — the context-runway axis: how large a session's context grows before it
 * steers to a stopping point and self-compacts (hud-chat-owner-controls-2026-08-11
 * P-003, WI-6507).
 *
 * [owner 2026-07-27] "add a button to the buttom of the chats to adjust the token
 * limit".
 *
 * ── WHAT "TOKEN LIMIT" TURNED OUT TO MEAN ──
 * NOT a hard token cap and NOT a max-output budget. The only per-session token
 * number a session actually owns is `coord_presence.compaction_limit` — the SOFT
 * compaction limit, which is already on this surface as the `ctx N%` reading in
 * the footer. So this pill adjusts the denominator of a number the owner can
 * already see three inches away, which is exactly the control the ask describes.
 *
 * It is deliberately NOT labelled "token limit": a control named for a hard cap
 * that actually moves a soft self-compaction target would misdescribe itself to
 * every reader after the first. The cap is CTX and the menu says "compact at".
 *
 * ── WHY THE SET PATH IS SHAPED THE WAY IT IS (D-010) ──
 * config:set-compaction-limit answers a REFUSAL inside an HTTP 200 body:
 * `{ ok:false, error:'limit_exceeds_cap', cap }` with NO write performed. A
 * control that treats a 200 as success therefore reports "done" having changed
 * nothing — the lying-control failure D-002/D-008 exist to prevent. So `set`
 * parses the body, distinguishes the two ok:false outcomes, and throws with the
 * REAL ceiling; ChatActionBar renders a thrown message in its error slot.
 *
 * The ceiling is deliberately NOT predicted client-side. It varies by model spec
 * AND fleet role (a fleet member's [1m] cap is 250k where a leader's self-set
 * ceiling is 825k), and EI-19932842496005122 observed 400k where the constants
 * said 825k. Rather than hardcode a number that is wrong for some sessions and
 * silently drifts for the rest, the menu offers the full ladder and lets the
 * REJECTION teach the true cap — which is the one number guaranteed to be
 * current, because the server just computed it.
 */
import { registerChatModeAction } from './registry';
import type { ChatActionContext } from './types';

/**
 * The rungs offered, in tokens.
 *
 * A bounded set, so this axis stays `searchable: false` (D-005): a search box
 * over nine fixed numbers is noise. The ladder spans the floor
 * (MIN_COMPACTION_LIMIT_TOKENS, 20k) to the highest self-set ceiling the
 * constants allow (825k on a [1m] window) so no reachable setting is missing —
 * a session whose role caps it lower simply gets a refusal naming that cap,
 * which is more informative than an option that was never offered.
 */
const RUNGS = [20_000, 60_000, 100_000, 160_000, 200_000, 300_000, 400_000, 600_000, 825_000] as const;

/** `160000` → `"160k"`. The pill has room for a number, not a sentence. */
export function formatTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`;
}

/** The session's current limit, read straight off the roster row ctx carries. */
export function currentLimit(ctx: ChatActionContext): number | null {
  const raw = (ctx as { compactionLimit?: unknown }).compactionLimit;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/**
 * POST one compaction-limit write through the admin proxy route.
 *
 * Exported for tests. Throws a human-readable message on refusal — see the
 * D-010 note above for why a non-throwing 200 is not success here.
 */
export async function postCompactionLimit(agent: string, limit: number): Promise<void> {
  const r = await fetch('/api/admin/config/set-compaction-limit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ limit, ownerId: agent }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`set-compaction-limit → ${r.status}: ${text.slice(0, 200)}`);

  let parsed: {
    ok?: boolean;
    compactionLimit?: number | null;
    cap?: number;
    error?: string;
    message?: string;
  } = {};
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    /* A non-JSON 200 cannot be shown to have refused; treat as success, as
       postModeSet does for the same reason. */
    return;
  }

  if (parsed.ok === false) {
    /* The two ok:false outcomes need DIFFERENT words. `ok` is computed as
       `persisted != null`, so it is false both when the request was refused for
       exceeding the cap and when the write went through but no live presence row
       persisted it (the session ended). Reporting "too high" for a session that
       simply died would send the reader hunting for a ceiling problem that does
       not exist. Filed as EI-20187186554229192. */
    if (parsed.error === 'limit_exceeds_cap' && typeof parsed.cap === 'number') {
      throw new Error(
        `${formatTokens(limit)} is above this session's ceiling of ${formatTokens(parsed.cap)} — nothing was changed. ` +
          `The ceiling depends on the session's model and its fleet role. Pick ${formatTokens(parsed.cap)} or lower.`,
      );
    }
    throw new Error(
      parsed.message ?? `set-compaction-limit refused (${parsed.error ?? 'unknown error'}) — nothing was changed`,
    );
  }
}

registerChatModeAction({
  id: 'mode-context-limit',
  cap: 'CTX',
  /* 'config', NOT 'posture' — matching the ACCT pill (WI-6509, D-006). The
     posture cluster is the four MODE axes (autonomy + overlays): what stance the
     agent is taking. CTX and ACCT are not stances, they are session
     configuration, and the owner asked for these controls to be built coherently
     rather than as unrelated affordances. Grouping them together is what makes
     the footer read as two clusters with a reason, instead of one bag. */
  group: 'config',
  available: (ctx) => Boolean(ctx.sessionOwnerId),
  /* PURE + sync, like every other axis: the limit is already on the roster row
     this pill was rendered from, so the pill can never disagree with the `ctx N%`
     reading in the footer beside it, and opening the popup costs no fetch. */
  current: (ctx) => {
    const limit = currentLimit(ctx);
    if (limit == null) {
      return {
        value: 'auto',
        on: false,
        title:
          'Context runway — how much context this session fills before it wraps up and self-compacts. No explicit limit is set, so it uses the default for its model and fleet role.',
      };
    }
    return {
      value: formatTokens(limit),
      optionId: String(limit),
      on: true,
      title: `Context runway — this session steers toward a stopping point and self-compacts near ${limit.toLocaleString()} tokens. Raise it for wide-context work; lower it to stay sharp on a tight task.`,
    };
  },
  /* Bounded set ⇒ no search box (D-005). */
  options: () =>
    RUNGS.map((n) => ({
      id: String(n),
      label: formatTokens(n),
      hint:
        n === 20_000
          ? 'The floor. Compacts very often — only for a deliberately tiny, tightly-scoped task.'
          : n >= 600_000
            ? 'Very wide. Only reachable on a large-window model, and every turn pays the whole context as a cache read.'
            : undefined,
    })),
  set: async (ctx, optionId) => {
    const limit = Number(optionId);
    if (!Number.isFinite(limit)) throw new Error(`unrecognised context-limit option '${optionId}'`);
    await postCompactionLimit(ctx.sessionOwnerId, limit);
  },
});
