/**
 * status-display.ts — the SINGLE-SOURCE status render behind every TUI's
 * fleet display (tui-status-parity-single-source-2026-07-05, owner ask
 * 2026-07-05: "do it in a generic way so that there is a single place to
 * update the information and that feeds into something that updates all
 * tuis that we support").
 *
 * History: each CLI used to embed its OWN copy of the render — the Claude
 * statusline (`statusline-fleet.sh`), the Codex/OMP title hook
 * (`posttooluse-objective-title.sh`), and the OMP coord-hook — held
 * byte-identical only by a drift-guard test (objective-title-parity.test.ts).
 * That inverted the maintenance burden: every new chip meant N synchronized
 * edits. This module inverts it back: `coord:glance` calls
 * `renderStatusDisplay` server-side and ships the RESULT as a `display`
 * block; every client hook is a dumb pipe that prints it verbatim. Adding a
 * chip = one edit here; every TUI (current and future) picks it up on the
 * next glance tick.
 *
 * The shapes:
 *   - `title`      — the OS terminal-title string (window/tab bar): the
 *                    compact full-fleet identity. Codex + OMP have NO bottom
 *                    status pane (title is their only owned pixel surface),
 *                    so the title carries the whole chip set in compact form.
 *   - `statusline` — logical lines for a bottom status pane (Claude Code
 *                    today; any future TUI with a statusline). Line 1 is the
 *                    chip row; a 💡 tip line + the ⋯ glance affordance follow
 *                    when the tips engine has something to say. Lines are
 *                    UNCLIPPED to terminal width — width fitting (clip/wrap to
 *                    COLUMNS) is presentation, so it stays client-side.
 *   - `notice`     — the top tip as an injectable one-liner (id for
 *                    client-side dedup cursors). Codex/OMP surface it through
 *                    their per-turn context-injection channel so tip-parity
 *                    doesn't depend on having a statusline.
 *
 * PURE: no I/O — the glance handler gathers state, this renders strings.
 * Every field is optional + fail-open (a missing field drops its chip, never
 * throws) so an older/partial payload renders a smaller display, not none.
 */

/** Clip so a verbose objective can't swallow the statusline chip row. */
const OBJECTIVE_MAX = 48;
/** Tighter clip for the OS title (tab bars truncate hard). */
const TITLE_OBJECTIVE_MAX = 40;
/** ctx gauge ⚠ threshold — mirrors CONTEXT_GAUGE_LOUD_PCT (agent-managed-compaction P-015). */
const CONTEXT_LOUD_PCT = 80;
/** The slash-command prefix Claude Code uses for tool exposure — stripped for the
 *  agent-facing notice (codex/omp agents call the tool directly, no slash layer). */
const SLASH_TOOL_PREFIX = '/mcp__papercusp-su__tool:';

export interface StatusDisplayGlance {
  wake?: { default?: string | null; stagedTotal?: number | null; stagedOwners?: number | null } | null;
  /**
   * `running` = host-process alive (what the ☕ chip counts). `working` is the
   * confirmed-active subset glance also ships (EI-3226); declared here because
   * glance assigns it, and an undeclared field is an excess-property error at
   * that call site rather than an honest optional.
   */
  bees?: { running?: number | null; working?: number | null } | null;
  governor?: { anyPaused?: boolean | null; paused?: Array<{ key?: string | null }> | null } | null;
  activity?: Array<{ owner_id?: string | null; summary?: string | null }> | null;
  tips?: Array<{ id?: string | null; text?: string | null; command?: string | null }> | null;
  self?: {
    objective?: string | null;
    /**
     * The owner-keyed MANUAL session name (harness_shared.agent_display_names),
     * when the human has set one. Absent/blank ⇒ the display name falls back
     * through the objective to the short handle (D-001).
     */
    displayName?: string | null;
    loop?: { active?: boolean; intervalSec?: number | null; reachable?: boolean | null } | null;
    fleets?: Array<{ slug?: string | null; label?: string | null; role?: string | null; square?: string | null }> | null;
    /** `pct` is what the renderer consumes; `tokens`/`limit` are carried for
     *  callers building the coord-inject `context: N/LIMIT (X%)` line (see
     *  inbox-context-usage.ts / fleet-monitor-delta.ts) and test fixtures. */
    context?: { pct?: number | null; tokens?: number | null; limit?: number | null } | null;
    modes?: string[] | null;
  } | null;
}

export interface StatusDisplay {
  /** OS terminal-title string — the compact full-fleet identity. '' when nothing meaningful. */
  title: string;
  /** Bottom-pane lines (unclipped; clients fit to width). Empty when nothing meaningful. */
  statusline: string[];
  /** Top tip as an injectable one-liner (id for dedup), or null when no tip applies. */
  notice: { id: string; text: string } | null;
}

/** Shorthand id matching the coord ownerLabel form (su-9859ea5e-… → su-9859e). */
export function selfShort(ownerId: string | null | undefined): string {
  const owner = String(ownerId ?? '').trim();
  if (!owner || owner === 'fixture') return '';
  const bits = owner.split('-');
  if (bits.length >= 2 && bits[1]) return `${bits[0]}-${bits[1].slice(0, 5)}`;
  return owner.slice(0, 8);
}

/**
 * Where a session's display name came from. Carried alongside the name so a
 * surface can tell whether the headline it just rendered IS the objective or
 * IS the short handle, and therefore skip printing that same string a second
 * time (the HUD card's reason-line suppression, R3; the title's identity and
 * objective chips below).
 *
 * `none` is the genuinely-empty case — no manual name, no objective, and no
 * usable ownerId (a fixture / unidentified payload). Callers render nothing
 * rather than an empty headline.
 */
export type SessionDisplayNameSource = 'manual' | 'objective' | 'handle' | 'none';

export interface SessionDisplayNameInput {
  /** Owner-keyed manual name a human typed (harness_shared.agent_display_names). */
  manualName?: string | null;
  /** In-flight work-item title, falling back to the declared coord intent. */
  objective?: string | null;
  /** The coord ownerId — the last-resort identity, shortened via `selfShort`. */
  ownerId?: string | null;
  /**
   * A pre-rendered short id to use as the last resort instead of
   * `selfShort(ownerId)`.
   *
   * The CHAIN is shared; the id FORMAT is presentation, and the two surfaces
   * genuinely differ — the terminal title uses `selfShort` (`su-9859e`, 5 hex
   * chars, matching the coord ownerLabel form) while the HUD card uses its own
   * `shortHandle` (`su-709bb0d6`, the leading uuid segment) and prints that same
   * string on the card's secondary row. Forcing one format on both would make
   * the HUD's headline disagree with the id printed directly beneath it. Blank
   * or absent falls back to `selfShort`.
   */
  shortHandle?: string | null;
}

export interface SessionDisplayName {
  /** Trimmed but UNCLIPPED — width fitting is presentation, so each surface clips its own. */
  name: string;
  source: SessionDisplayNameSource;
}

/**
 * THE display-name resolver — `manualName ?? objective ?? shortHandle` (D-001).
 *
 * D-003 makes this the ONE implementation of that chain in the tree: the
 * terminal title (via `renderStatusDisplay` below) and the HUD board model
 * both call it, so a session cannot be named one thing in a tab bar and
 * another on its card. A surface that grows its own private fallback chain is
 * the regression that decision exists to prevent.
 *
 * Pure and fail-open like the rest of this module: every field is optional and
 * a non-string is treated as absent, so a partial payload resolves a shorter
 * name rather than throwing (R9).
 */
export function sessionDisplayName(input: SessionDisplayNameInput = {}): SessionDisplayName {
  const manual = typeof input.manualName === 'string' ? input.manualName.trim() : '';
  if (manual) return { name: manual, source: 'manual' };
  const objective = typeof input.objective === 'string' ? input.objective.trim() : '';
  if (objective) return { name: objective, source: 'objective' };
  const handle = normalizeObjective(input.shortHandle) ?? selfShort(input.ownerId);
  if (handle) return { name: handle, source: 'handle' };
  return { name: '', source: 'none' };
}

/**
 * Coerce a candidate objective/name string to a non-empty trimmed value, or null.
 *
 * The fallback chains below MUST treat a blank as absent: `coord_presence.intent`
 * is a NOT-NULL text column defaulting to '', so an undeclared intent reads back
 * as '' — falsy but NOT nullish — and a bare `?? null` would render an empty
 * `🔭  · ` segment in every client status line.
 */
export function normalizeObjective(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Where a session's objective came from — the in-flight work-item, or the declared intent. */
export type SessionObjectiveSource = 'work-item' | 'intent' | 'none';

export interface SessionObjective {
  objective: string | null;
  source: SessionObjectiveSource;
}

/**
 * THE objective chain — in-flight work-item title ?? declared coord intent
 * (session-objective-display-2026-06-22).
 *
 * Lives here beside `sessionDisplayName` for the same reason D-003 gives for
 * that one: `coord:glance` (OS terminal title) and `adv-roster` (HUD cards)
 * both resolve it, and R1 requires them to agree — the roster's objective must
 * be "the SAME chain and the SAME source the terminal title bar's objective
 * segment uses today". Two `title ?? intent` expressions in two files is
 * exactly how that guarantee rots.
 *
 * `source` is what lets the HUD decide whether it has a work-item ref worth
 * printing on the card's secondary row, without re-deriving which branch won.
 */
export function sessionObjective(
  input: { workItemTitle?: string | null; intent?: string | null } = {},
): SessionObjective {
  const title = normalizeObjective(input.workItemTitle);
  if (title) return { objective: title, source: 'work-item' };
  const intent = normalizeObjective(input.intent);
  if (intent) return { objective: intent, source: 'intent' };
  return { objective: null, source: 'none' };
}

/** Compact interval label: 120→'2m', 30→'30s', 3600→'1h', 5400→'1h30m'. */
export function fmtInterval(sec: unknown): string {
  const s = typeof sec === 'number' && Number.isFinite(sec) ? Math.trunc(sec) : NaN;
  if (Number.isNaN(s)) return '?';
  if (s < 60) return `${s}s`;
  const m = Math.trunc(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.trunc(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h${rm}m`;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Strip control chars that could break out of an OSC title escape (defensive). */
function stripControl(text: string): string {
  return [...text].filter((c) => (c.codePointAt(0) ?? 0) >= 32 && c !== '\x07' && c !== '\x1b').join('');
}

function objectivePart(g: StatusDisplayGlance, max: number): string | null {
  const obj = g.self?.objective;
  if (typeof obj !== 'string') return null;
  const trimmed = obj.trim();
  if (!trimmed) return null;
  return clip(trimmed, max);
}

/**
 * The ⟳ loop chip — ALWAYS shows loop-armed state when the operator supplies
 * `self.loop` (owner ask 2026-07-05): '⟳ <interval>' armed, '⟳ off' not,
 * '⚠unreachable' suffix for a black-holed loop (WI-655). null when the field
 * is absent entirely (unknown ⇒ stay quiet).
 */
function loopPart(g: StatusDisplayGlance): string | null {
  const self = g.self;
  if (!self || typeof self !== 'object' || !('loop' in self)) return null;
  const lp = self.loop;
  if (!lp || typeof lp !== 'object' || !lp.active) return '⟳ off';
  if (lp.reachable === false) return `⟳ ${fmtInterval(lp.intervalSec)} ⚠unreachable`;
  return `⟳ ${fmtInterval(lp.intervalSec)}`;
}

/** Compact title form of the loop chip: '⟳5m', '⟳5m!' unreachable, null when off/unknown. */
function loopTitleTag(g: StatusDisplayGlance): string | null {
  const lp = g.self?.loop;
  if (!lp || typeof lp !== 'object' || !lp.active) return null;
  return `⟳${fmtInterval(lp.intervalSec)}${lp.reachable === false ? '!' : ''}`;
}

/** ▣ auto+ideate — the session's OFFICIAL standing modes (EI-7626). */
function modesPart(g: StatusDisplayGlance): string | null {
  const m = g.self?.modes;
  if (!Array.isArray(m)) return null;
  const names = m.filter((x): x is string => typeof x === 'string' && x.length > 0);
  if (names.length === 0) return null;
  return `▣ ${names.slice(0, 4).join('+')}`;
}

/** ctx N% — the ambient context-usage gauge, ⚠-prefixed at the loud band. */
function contextPart(g: StatusDisplayGlance): string | null {
  const pct = g.self?.context?.pct;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  const p = Math.trunc(pct);
  return p >= CONTEXT_LOUD_PCT ? `⚠ ctx ${p}%` : `ctx ${p}%`;
}

/** ▶ auto / ⏸ manual (+ ✉N staged) — the wake-gate chip. */
function wakePart(g: StatusDisplayGlance): string | null {
  const mode = g.wake?.default;
  if (mode !== 'auto' && mode !== 'manual') return null;
  const staged = g.wake?.stagedTotal ?? 0;
  const glyph = mode === 'auto' ? '▶ auto' : '⏸ manual';
  return staged ? `${glyph} ✉${staged}` : glyph;
}

/** Compact title form: '▶' / '⏸' + '✉N' when staged (e.g. '⏸ ✉4'). */
function wakeTitleTag(g: StatusDisplayGlance): string | null {
  const mode = g.wake?.default;
  if (mode !== 'auto' && mode !== 'manual') return null;
  const staged = g.wake?.stagedTotal ?? 0;
  const glyph = mode === 'auto' ? '▶' : '⏸';
  return staged ? `${glyph} ✉${staged}` : glyph;
}

/** (peerCount, latestPeerChip) from newest-first activity rows, excluding self. */
function peerGlance(
  g: StatusDisplayGlance,
  ownerId: string,
): { count: number; latest: string | null } {
  const others: string[] = [];
  let latest: string | null = null;
  for (const row of g.activity ?? []) {
    const owner = row?.owner_id;
    if (!owner || owner === ownerId) continue;
    if (!others.includes(owner)) others.push(owner);
    if (latest === null) {
      const short = owner.length > 6 ? owner.slice(-6) : owner;
      const summ = (row.summary ?? '').trim();
      latest = summ ? clip(`◆ ${short} ${summ}`, 60) : null;
    }
  }
  return { count: others.length, latest };
}

/** One chip per named fleet: 👑/👤 + name + bound colour square, capped at 4 (+N overflow). */
function fleetsPart(g: StatusDisplayGlance): string {
  const fleets = g.self?.fleets;
  if (!Array.isArray(fleets) || fleets.length === 0) return '';
  const chips: string[] = [];
  for (const f of fleets.slice(0, 4)) {
    if (!f || typeof f !== 'object') continue;
    let label = String(f.label ?? f.slug ?? '').trim();
    if (!label) continue;
    if (label.length > 16) label = `${label.slice(0, 15)}…`;
    const glyph = f.role === 'leader' ? '👑' : '👤';
    const square = String(f.square ?? '').trim();
    chips.push(`${glyph} ${label}${square ? ` ${square}` : ''}`);
  }
  if (chips.length === 0) return '';
  let seg = chips.join(' · ');
  const more = fleets.length - chips.length;
  if (more > 0) seg += ` +${more}`;
  return seg;
}

/**
 * Render the full status display for one session. `account` is the pool
 * account that served the session's most-recent turn (gateway read-back),
 * when the caller knows it — rendered as the ⇢ chip.
 */
export function renderStatusDisplay(
  g: StatusDisplayGlance,
  opts: { ownerId?: string | null; account?: string | null } = {},
): StatusDisplay {
  const ownerId = String(opts.ownerId ?? '').trim();
  const meShort = selfShort(ownerId);
  const { count: peerCount, latest: latestPeer } = peerGlance(g, ownerId);
  const display = sessionDisplayName({
    manualName: g.self?.displayName,
    objective: g.self?.objective,
    ownerId,
  });

  // ── statusline line 1 — the chip row (order mirrors the historical Claude render) ──
  const parts: string[] = [];
  // A human-given name leads the row. The 🔭 objective and ◇ id chips below are
  // untouched, so naming a session ADDS identity rather than hiding either (D-001).
  if (display.source === 'manual') parts.push(`✎ ${clip(display.name, OBJECTIVE_MAX)}`);
  const obj = objectivePart(g, OBJECTIVE_MAX);
  if (obj) parts.push(`🔭 ${obj}`);
  if (meShort) parts.push(`◇ ${meShort}`);
  const account = String(opts.account ?? '').trim();
  if (account) parts.push(`⇢ ${account}`);
  const loop = loopPart(g);
  if (loop) parts.push(loop);
  const modes = modesPart(g);
  if (modes) parts.push(modes);
  const ctx = contextPart(g);
  if (ctx) parts.push(ctx);
  const wake = wakePart(g);
  if (wake) parts.push(wake);
  const bees = g.bees?.running ?? 0;
  if (bees) parts.push(`☕${bees}`);
  const paused = g.governor?.anyPaused ? (g.governor?.paused ?? []) : [];
  if (paused.length > 0) {
    parts.push(clip(`⏳ ${paused.map((p) => p?.key ?? '?').join(',')}`, 40));
  }
  parts.push(peerCount ? `${peerCount} peer${peerCount === 1 ? '' : 's'}` : 'solo');
  if (latestPeer) parts.push(latestPeer);

  const statusline: string[] = [];
  if (parts.length > 0) statusline.push(parts.join(' · '));

  // ── 💡 tip + ⋯ affordance rows + the injectable notice ──
  let notice: { id: string; text: string } | null = null;
  const tip = (g.tips ?? [])[0];
  const tipText = (tip?.text ?? '').trim();
  if (tip && tipText) {
    const cmd = (tip.command ?? '').trim();
    statusline.push(`💡 ${tipText}${cmd ? ` ${cmd}` : ''}`.trimEnd());
    statusline.push('⋯ run /mcp__papercusp-su__tool:coord:glance for detail');
    // The notice strips the Claude slash prefix — a codex/omp agent calls the
    // tool directly (coord:wake-mode mode=auto), no slash layer.
    const bare = cmd.startsWith(SLASH_TOOL_PREFIX) ? cmd.slice(SLASH_TOOL_PREFIX.length) : cmd;
    notice = {
      id: String(tip.id ?? 'tip'),
      text: `💡 ${tipText}${bare ? ` ${bare}` : ''}`.trimEnd(),
    };
  }

  // ── OS title — compact full-fleet identity (codex/omp's ONLY pixel surface) ──
  // LEADS with the session's display name (D-001): a tab bar truncates hard, so
  // the first thing a human reads should be what this session IS, not the
  // fleet-wide chrome that is byte-identical on every session's title.
  const titleBits: string[] = [];
  if (display.name) {
    const named = clip(display.name, TITLE_OBJECTIVE_MAX);
    titleBits.push(
      display.source === 'manual' ? `✎ ${named}` : display.source === 'objective' ? `🔭 ${named}` : named,
    );
  }
  const fleets = fleetsPart(g);
  if (fleets) titleBits.push(fleets);
  const loopTag = loopTitleTag(g);
  if (loopTag) titleBits.push(loopTag);
  const wakeTag = wakeTitleTag(g);
  if (wakeTag) titleBits.push(wakeTag);
  if (bees) titleBits.push(`☕${bees}`);
  if (paused.length > 0) titleBits.push(`⏳${paused.length}`);
  if (peerCount) titleBits.push(`${peerCount}p`);
  // The short id STAYS on the title (D-001 — it is how a human correlates a
  // session with logs and --resume lines), but never twice: it is dropped here
  // only when it is already the headline. Same for the objective chip.
  if (meShort && display.source !== 'handle') titleBits.push(meShort);
  const titleObj = objectivePart(g, TITLE_OBJECTIVE_MAX);
  if (titleObj && display.source !== 'objective') titleBits.push(`🔭 ${titleObj}`);
  const title = stripControl(titleBits.join(' · '));

  return { title, statusline, notice };
}
