/**
 * Shared `updated`-timestamp formatters — the coarse relative one
 * (`formatRelativeUpdated`) and the precise absolute one
 * (`formatAbsoluteUpdated`). They live together because callers routinely
 * want both of the same value, and a caller that finds one should find the
 * other. Pure; no I/O.
 *
 * Shared relative-time formatter used by PlanRail row cards, the
 * /adv/sessions "Start from plan context" picker, and any future
 * caller that wants "today / yesterday / Nd ago / YYYY-MM-DD"
 * formatting. Pure; no I/O.
 *
 * Per `plans-newbutton-and-subharness-scope-2026-05-25` P-027 / D-011.
 *
 * Input is either an ISO date string (frontmatter `updated` field) or
 * an epoch-ms number. Returns the input string verbatim if it can't
 * be parsed, so a malformed value renders something instead of
 * "undefined".
 */
/** Pure: render an idle-age in seconds as the compact human string a reader
 *  actually thinks in — "42s", "9m", "2h41m", "3d2h" (two units max; sub-unit
 *  remainders drop past the hour scale). Raw seconds ("9641") read as noise
 *  next to a present-tense intent string — EI-9696: a roster reader took ~20
 *  hours-idle agents for active editors because the staleness signals sat in
 *  adjacent numeric/boolean columns — so the emitted prefix carries this form.
 *
 *  Lives HERE, with the other pure formatters, rather than beside its original
 *  caller in presence-tier1.ts: that module imports `getOrgPg`, so a browser
 *  component reaching for this one pure function would have dragged Postgres
 *  into the SPA bundle. presence-tier1 re-exports it, so every existing
 *  importer (and its own test) is unaffected. */
export function formatIdleAge(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m ? `${h}h${m}m` : `${h}h`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return h ? `${d}d${h}h` : `${d}d`;
}

export function formatRelativeUpdated(updated: string | number | null | undefined): string {
  if (updated == null) return '';
  const t = typeof updated === 'number' ? updated : Date.parse(updated);
  if (!Number.isFinite(t)) return typeof updated === 'string' ? updated : '';
  const ageMs = Date.now() - t;
  const day = 86_400_000;
  if (ageMs < 0) return 'in the future';
  if (ageMs < day) return 'today';
  if (ageMs < day * 2) return 'yesterday';
  if (ageMs < day * 30) return `${Math.floor(ageMs / day)}d ago`;
  if (typeof updated === 'string') return updated.slice(0, 10);
  return new Date(t).toISOString().slice(0, 10);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Absolute, to-the-minute rendering in the viewer's LOCAL timezone —
 * "26 Jul 2026, 14:03".
 *
 * Added for `hud-session-launcher-and-board-tabs-2026-07-26` P-007 (owner ask
 * 2026-07-26: "display the full time details not just 'today'").
 * `formatRelativeUpdated` deliberately collapses anything inside 24h to
 * "today", which is exactly the information loss the owner hit — a plan
 * touched a minute ago and one touched 23 hours ago read identically.
 *
 * Hand-composed rather than `toLocaleString` on purpose: locale-dependent
 * output would render differently per machine and make assertions on it
 * either non-deterministic or tautological. Same lenient contract as its
 * sibling — an unparseable value comes back verbatim rather than as
 * "Invalid Date".
 */
export function formatAbsoluteUpdated(updated: string | number | null | undefined): string {
  if (updated == null) return '';
  const t = typeof updated === 'number' ? updated : Date.parse(updated);
  if (!Number.isFinite(t)) return typeof updated === 'string' ? updated : '';
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * DURATION SINCE a past instant — "42s", "9m", "2h41m", "3d2h" — the third
 * member of this family, and the one a WAITING surface needs.
 *
 * Its two siblings answer different questions and neither can stand in here:
 * `formatRelativeUpdated` is a CALENDAR reading that collapses everything
 * inside 24h to "today" (a wait opened 2 minutes ago and one opened 23 hours
 * ago render identically — the exact loss that made the HUD popup unable to
 * say how long an agent had been stuck), and `formatAbsoluteUpdated` is a
 * WALL-CLOCK reading the reader must subtract from "now" by hand.
 *
 * `''` — not "0s", not "just now" — when the input is absent or unparseable.
 * A duration we could not compute must render as NOTHING: "0s" is a number a
 * reader would act on, and it would be a number we never measured.
 *
 * `nowMs` is injectable so a test can assert an exact string without freezing
 * the clock; production callers omit it.
 * Per `popup-agent-state-coverage-2026-08-18` P-009.
 */
export function formatElapsedSince(
  since: string | number | null | undefined,
  nowMs: number = Date.now(),
): string {
  if (since == null) return '';
  const t = typeof since === 'number' ? since : Date.parse(since);
  if (!Number.isFinite(t)) return '';
  return formatIdleAge((nowMs - t) / 1000);
}

/**
 * TIME REMAINING until a future instant — "<1m left", "19m left", "2h41m left",
 * "3d2h left", or "expired" once it has passed.
 *
 * Lives here rather than beside its first caller (a local `expiresIn` in
 * AgentDossier.tsx) because a SECOND surface — the conversation popup's status
 * band — now renders the same kind of value for an `events:await` timeout, and
 * two hand-rolled countdown formatters is how the same expiry comes to read two
 * different ways on two panes of one popup.
 *
 * Minute-scale rounding (not truncation) is deliberate and load-bearing: a
 * 19-minute lock read a few milliseconds later is "19m left", not "18m".
 *
 * `''` for an absent or unparseable input, for the same reason as
 * `formatElapsedSince` — and emphatically NOT "expired", which is a claim about
 * a deadline we never read.
 * Per `popup-agent-state-coverage-2026-08-18` P-009.
 */
export function formatTimeLeft(
  until: string | number | null | undefined,
  nowMs: number = Date.now(),
): string {
  if (until == null) return '';
  const t = typeof until === 'number' ? until : Date.parse(until);
  if (!Number.isFinite(t)) return '';
  const ms = t - nowMs;
  if (ms <= 0) return 'expired';
  const min = Math.round(ms / 60_000);
  if (min < 1) return '<1m left';
  if (min < 60) return `${min}m left`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? `${h}h${m}m left` : `${h}h left`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d${rh}h left` : `${d}d left`;
}
