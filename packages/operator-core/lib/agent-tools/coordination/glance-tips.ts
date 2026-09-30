/**
 * glance-tips.ts — the contextual-tips engine behind `coord:glance`.
 *
 * A tip is a one-line, actionable nudge derived from live fleet state ("wake
 * mode is manual — here's the slash command to flip it back"), rendered at the
 * bottom of the TUI by the fleet statusline and available to any other glance
 * consumer. The engine is a flat rule registry evaluated against a
 * (audience, state) context:
 *
 *   - `audience` — what KIND of caller is looking (the human statusline, a
 *     queen, a psu engineer, a bee). Rules declare which audiences they speak
 *     to; a bee never sees "release the queen's staged wakes".
 *   - context state — the server-gathered fleet snapshot (wake mode, staged
 *     wakes, bees in flight, governor pauses) plus free-form caller-supplied
 *     `state` pairs, so a client can feed its own situation into the rules
 *     without a server change.
 *
 * Adding a tip = appending a TipRule here. Rules are pure and individually
 * fault-isolated (a throwing rule is skipped, never breaks the glance), and
 * the order of DEFAULT_TIP_RULES is the display priority — the statusline
 * renders tips[0].
 *
 * A tip that resolves via one tool call carries it in TWO forms:
 *   - `command` — the human slash form, as Claude Code actually surfaces the
 *     slash-exposure projection (slash-exposure-tool-catalog-2026-06-12):
 *     `/mcp__<server>__tool:<group>:<verb>`, with `papercusp-su` as the psu
 *     server registration on this box. For a human to type/pick.
 *   - `invoke` — the machine form `{ tool, args }`. An agent consuming the
 *     glance applies a tip by calling the tool directly over its own MCP
 *     session (inheriting its gates/audit) — no slash layer, no typing.
 */

export const GLANCE_AUDIENCES = ['user', 'mug', 'su', 'cup'] as const;
export type GlanceAudience = (typeof GLANCE_AUDIENCES)[number];

export interface GlanceTipContext {
  audience: GlanceAudience;
  /** Effective GLOBAL default wake mode (per-agent overrides not consulted here). */
  wakeDefault: 'auto' | 'manual';
  /** Total staged (manual-mode) wakes across all agents. */
  stagedTotal: number;
  /**
   * The CALLER's own resolved owner id, when resolvable (EI-7696) — null for an
   * audience/context with no single identifiable owner (e.g. an unauthenticated
   * human view). `coord:wake-queue`'s `release_all` REQUIRES an `agent` arg (it
   * drains one agent's queue, never the whole fleet's), so a rule that suggests
   * it must either supply this or omit the ready-made command entirely — never
   * emit a command that's guaranteed to fail with `agent-required`.
   */
  selfOwnerId: string | null;
  /**
   * EI-13229: the CALLER's OWN staged-wake count (0 when `selfOwnerId` is
   * null, or resolvable but has nothing staged) — distinct from `stagedTotal`
   * (fleet-wide). `coord:wake-queue`'s `release_all` drains ONLY the named
   * `agent`'s queue, so a tip that quotes `stagedTotal` while emitting a
   * self-scoped release command can promise a release count the call will
   * never actually deliver (reported: "7 staged wakes" tip, `release_all`
   * found 0 — the fleet total, not the caller's own).
   */
  selfStagedCount: number;
  /** Nursery spawns currently running with a fresh heartbeat. */
  beesRunning: number;
  /** Governor bucket keys currently paused (e.g. 'anthropic:opus'). */
  governorPausedKeys: string[];
  /** Free-form caller-supplied state pairs; rules may match on these. */
  state: Record<string, string>;
}

/** The machine-executable form of a tip's resolving action. */
export interface GlanceTipInvoke {
  tool: string;
  args: Record<string, string>;
}

export interface GlanceTip {
  id: string;
  text: string;
  /** A ready-to-type slash command when one directly resolves the tip, else null. */
  command: string | null;
  /** The same action as a direct tool call, for agent consumers. */
  invoke: GlanceTipInvoke | null;
}

export interface TipRule {
  id: string;
  /** Audiences this rule speaks to. */
  audiences: readonly GlanceAudience[];
  when(ctx: GlanceTipContext): boolean;
  render(ctx: GlanceTipContext): { text: string; command?: string; invoke?: GlanceTipInvoke };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export const DEFAULT_TIP_RULES: readonly TipRule[] = [
  {
    // The founding case (2026-06-11): the queen's autonomous loop silently
    // queued behind a manual wake gate and nothing surfaced it.
    id: 'wake-mode-manual',
    audiences: ['user', 'su', 'mug'],
    when: (c) => c.wakeDefault === 'manual',
    render: (c) => ({
      text:
        c.stagedTotal > 0
          ? `Wake mode is manual — ${plural(c.stagedTotal, 'staged wake')} waiting; agents won't self-drive. Back to auto:`
          : `Wake mode is manual — agents won't self-drive. Back to auto:`,
      command: '/mcp__papercusp-su__tool:coord:wake-mode mode=auto',
      invoke: { tool: 'coord:wake-mode', args: { mode: 'auto' } },
    }),
  },
  {
    // Wakes staged while the default is auto = leftovers from a manual period
    // (or per-agent overrides) — they never fire on their own.
    id: 'staged-wakes-under-auto',
    audiences: ['user', 'su', 'mug'],
    when: (c) => c.wakeDefault === 'auto' && c.stagedTotal > 0,
    render: (c) => {
      // EI-7696: release_all is PER-AGENT (coord:wake-queue rejects it with
      // `agent-required` when omitted) — so the ready-made command can only
      // ever release the CALLER's own queue, never "everyone's". Emit it ONLY
      // when we know who the caller is; a null selfOwnerId (no single
      // identifiable owner) falls back to text-only.
      if (!c.selfOwnerId) {
        return { text: `${plural(c.stagedTotal, 'staged wake')} won't fire by themselves — release:` };
      }
      // EI-13229: the text MUST quote whatever count `release_all agent=<self>`
      // will actually drain — the caller's OWN count, never the fleet-wide
      // `stagedTotal`. Quoting the fleet total here (as this rule used to)
      // produced a tip claiming "7 staged wakes" whose immediate
      // `release_all` found and released 0 (the 7 belonged to OTHER agents),
      // an authoritative-action/status-tip disagreement.
      if (c.selfStagedCount > 0) {
        return {
          text: `${plural(c.selfStagedCount, 'staged wake')} of yours won't fire by themselves — release:`,
          command: `/mcp__papercusp-su__tool:coord:wake-queue action=release_all agent=${c.selfOwnerId}`,
          invoke: { tool: 'coord:wake-queue', args: { action: 'release_all', agent: c.selfOwnerId } },
        };
      }
      // Fleet-wide total is > 0 (the `when` gate) but NONE are the caller's
      // own — say so explicitly instead of implying an actionable command
      // that would release nothing for THIS caller (no command/invoke: there
      // is nothing of the caller's own to release).
      return {
        text: `${plural(c.stagedTotal, 'staged wake')} fleet-wide, none are yours — release_all only drains your own queue.`,
      };
    },
  },
  {
    id: 'governor-paused',
    audiences: ['user', 'su', 'mug', 'cup'],
    when: (c) => c.governorPausedKeys.length > 0,
    render: (c) => ({
      text: `Rate governor paused (${c.governorPausedKeys.join(', ')}) — agent turns queue until reset`,
    }),
  },
];

/**
 * Evaluate the rules for one audience+state. A rule that throws (in `when` or
 * `render`) is skipped — tips are decoration; they must never break the glance.
 */
export function evaluateTips(
  ctx: GlanceTipContext,
  rules: readonly TipRule[] = DEFAULT_TIP_RULES,
): GlanceTip[] {
  const out: GlanceTip[] = [];
  for (const rule of rules) {
    if (!rule.audiences.includes(ctx.audience)) continue;
    try {
      if (!rule.when(ctx)) continue;
      const r = rule.render(ctx);
      out.push({ id: rule.id, text: r.text, command: r.command ?? null, invoke: r.invoke ?? null });
    } catch {
      /* fault-isolated: a broken rule never breaks the glance */
    }
  }
  return out;
}
