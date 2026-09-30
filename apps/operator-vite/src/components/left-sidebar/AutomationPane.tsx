/**
 * AutomationPane — the shared body behind the Agents and System tabs.
 *
 * WHY (owner ask 2026-07-25): cron-spawned agents were consuming the owner's
 * weekly Claude limit with no surface to see or stop them. They are EPHEMERAL —
 * spawn, take a few turns, exit — so the agents-running roster reads empty while
 * spend is continuous, and there was nothing to click. This pane is that surface.
 *
 * WHY IT LOOKS LIKE THIS (owner ask 2026-07-26, mockup C): the pane rendered 877
 * rows in one flat list and the owner could not read it — "the whole list is much
 * too confusing … the loops also shows loops that havent been active in weeks".
 * Three things were wrong, and the fix for each lives in a different layer:
 *
 *   1. It mixed models with plumbing. "Is everything in the agents tab an LLM?" —
 *      no: 55 of 140 non-loop schedules spawn a model, 85 are git commits, GC and
 *      probes. That split is now the TAB split (`lens`), derived from `target_role`
 *      in lib/automation/routine-classification.
 *   2. It listed per-pot fan-out as peer rows — `git-sync` ×19, `hive-wake` ×16.
 *      Collapsed upstream by `collapseFanOut`; a row now carries `installs[]`.
 *   3. It sorted by taxonomy, so the ~90 live rows were buried under 750 dead loop
 *      rows. This file's job: sort by STATE, not subject. Needs-you first, then
 *      what is running, and everything dormant folded behind one line with a count.
 *
 * NOTHING IS HIDDEN, only folded — the owner mandate ("WE NEED ALL ROUTINES
 * SURFACED TO THE USER … THERE CAN BE NO ROUTINES THAT DONT GET SURFACED THERE",
 * 2026-07-25) holds: every bucket shows its count and opens in one click, and the
 * two lenses partition every row by construction.
 *
 * The browse-by-family view (the old subject grouping) is still here, one click
 * away in the header — the same Working/Runs pattern the /adv Agents panel uses.
 *
 * Writes go through the audited run-tool bridge, and — like every other pane in
 * this rail — the pane INVALIDATES ITS OWN READ after its own write rather than
 * waiting for the server's SSE push (see OverwatchTab's header for what depending
 * on that push costs).
 *
 * ⚠ THERE IS NO SPEND SECTION HERE, deliberately (owner correction 2026-07-25:
 * "Why is the spend tab inside blender? is that showing only blender related
 * spend? It looks like not."). It wasn't — and could not be. Spend is recorded per
 * agent ROLE with no FK back to the routine that spawned the agent, so any
 * per-routine cost number is a guess rendered as fact. Cost lives in exactly one
 * honest place, the workspace-wide SpendTab. See lib/automation/catalog.ts.
 */
import { useMemo, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { parseAsArrayOf, parseAsString, parseAsStringLiteral, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import {
  AlertTriangle,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Coins,
  Layers,
  ListTree,
  Lock,
  Pause,
  Play,
  Shield,
  ShieldOff,
  Zap,
} from 'lucide-react';
import { Tooltip } from '@/app/harness/Tooltip';
import {
  AGENT_FAMILY_ORDER,
  armedStateLabel,
  FAMILY_LABEL,
  SYSTEM_FAMILY_ORDER,
  type RoutineFamily,
} from '@papercusp/operator-core/lib/automation/routine-classification';
import type {
  AutomationCatalog,
  AutomationGymArm,
  AutomationLaneArm,
  AutomationRoutine,
} from '@papercusp/operator-core/lib/automation/catalog';

/** budgetEdit key for the workspace-ceiling row (not a pot/lane arm — its own save path). */
const SCOUT_CEILING_KEY = 'scout/workspace-ceiling';

/**
 * Which half of the split a pane renders.
 *
 * `llm` claims every row that can bill a model, PLUS `unknown` — an unclassified
 * `target_role` must never quietly land in the free pane. `system` claims the rest.
 * Together they are a total partition of the catalog, which is what replaced the
 * old category-per-pane wiring (where `infra` was in nobody's list and 40 routines
 * were surfaced nowhere).
 */
export type PaneLens = 'llm' | 'system';

export function rowsForLens(rows: readonly AutomationRoutine[], lens: PaneLens): AutomationRoutine[] {
  return rows.filter((r) => (lens === 'llm' ? r.spend !== 'none' : r.spend === 'none'));
}

const VIEWS = ['attention', 'family'] as const;
type PaneView = (typeof VIEWS)[number];

type BucketId = 'attention' | 'running' | 'dormant';

interface Bucket {
  id: BucketId;
  label: string;
  rows: AutomationRoutine[];
  /** Folded buckets render as ONE summary line until opened. */
  foldedByDefault: boolean;
  tone: 'warn' | 'spend' | 'good' | 'mute';
}

/** Fire a routine/flag control through the gated + audited run-tool bridge. */
async function runControlTool(
  name: 'routines:set' | 'flags:set' | 'gym:arm' | 'governor:arm' | 'learning:set-scout-budget',
  args: Record<string, unknown>,
): Promise<void> {
  const res = await fetch('/api/agent-mcp/run-tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, args, confirmed: true }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    message?: string;
    result?: { content?: Array<{ text?: string }> };
  };
  if (!res.ok || !body.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  const text = body.result?.content?.[0]?.text;
  if (text) {
    const payload = JSON.parse(text) as { ok?: boolean; message?: string };
    if (payload.ok === false) throw new Error(payload.message ?? `${name} refused`);
  }
}

export function agoLabel(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  if (ms < 0) return 'now';
  const min = ms / 60000;
  if (min < 1) return 'just now';
  if (min < 90) return `${Math.round(min)}m ago`;
  const hr = min / 60;
  if (hr < 36) return `${Math.round(hr)}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

/**
 * `su-a0e1afb5-a7f3-…` → `su-a0e1a`. A loop's name is `loop-<ownerId>`, i.e. a raw
 * UUID, and the owner named one verbatim when asking for this change — a row you
 * cannot say out loud is a row you cannot act on.
 */
export function shortOwner(ownerId: string): string {
  const m = /^([a-z]+)-([0-9a-f]{5})/i.exec(ownerId);
  return m ? `${m[1]}-${m[2]}` : ownerId.slice(0, 12);
}

/** What the row calls itself: a loop by its owning session, everything else by name. */
export function rowLabel(r: AutomationRoutine): string {
  if (r.kind === 'loop' && r.ownerId) {
    const pot = r.installs[0];
    return pot ? `${shortOwner(r.ownerId)} · ${pot}` : shortOwner(r.ownerId);
  }
  return r.name;
}

/**
 * The row's second line — cadence, or the honest substitute.
 *
 * A `triggered` row names its TRIGGER ("after each git-sync") rather than showing
 * a cadence it does not have; a stalled loop explains itself with its owner's last
 * activity, which is almost always the reason it stalled.
 */
export function rowMeta(r: AutomationRoutine): string {
  if (r.kind === 'triggered') return withArmedState(r, r.triggerLabel ?? 'on an event');
  if (r.liveness === 'stalled') {
    if (r.kind === 'loop') {
      return r.ownerLastActiveAt
        ? `stalled · owner last active ${agoLabel(r.ownerLastActiveAt)}`
        : 'stalled · owner gone';
    }
    return `stalled · last ran ${agoLabel(r.lastFiredAt)}`;
  }
  return withArmedState(r, r.cadence ?? 'event-driven');
}

/**
 * Append the armed state to a row's meta line when it is anything other than
 * plainly armed.
 *
 * WI-6447 (owner ask 2026-07-27, "can you make whether its enabled or not
 * visible in the display"): a cadence alone — "every 1m" — reads as a schedule
 * that IS running every minute. Most in-process sweeps report `armed: false`
 * (not armed in this process) and rendered identically to live ones, so the pane
 * listed sweeps whose state the owner could not see. The external-process rows
 * are worse: their arm state is genuinely UNKNOWN (live fire-state needs P-014
 * federation), and the old boolean funnel made unknown read as on.
 *
 * `armed` adds nothing — a running schedule showing its cadence is already the
 * unsurprising case, and suffixing every row would just add noise. The two
 * states that CHANGE what the owner should believe are the ones that get said
 * out loud. A stalled row is left alone: it already explains itself, and
 * "stalled · not armed" would be two ways of saying the same thing.
 */
function withArmedState(r: AutomationRoutine, base: string): string {
  if (r.armedState === 'armed') return base;
  return `${base} · ${armedStateLabel(r.armedState)}`;
}

/**
 * The header's headline status: how many of this pane's rows can spend money right
 * now.
 *
 * ⚠ This counter is about MONEY, not running-ness — it only looks at spenders. The
 * zero case must NOT say "All paused": seen live on the Docs pane (2026-07-25) it
 * read "All paused" while two routines were genuinely running, neither a spender.
 * "None can spend" keeps the column's single money meaning.
 */
export function scheduleLaneValue(rows: readonly AutomationRoutine[]): string {
  if (rows.length === 0) return 'None scheduled';
  const spending = rows.filter((r) => r.active && r.spawnsAgent).length;
  if (spending > 0) return `${spending} can spend`;
  const spenders = rows.filter((r) => r.spawnsAgent).length;
  return spenders > 0 ? 'None can spend' : `${rows.length} scheduled`;
}

/** The lane value for a deterministic pane — health, not money. */
export function systemLaneValue(rows: readonly AutomationRoutine[]): string {
  if (rows.length === 0) return 'None scheduled';
  const attention = rows.filter((r) => r.needsAttention).length;
  if (attention > 0) return `${attention} need${attention === 1 ? 's' : ''} you`;
  return `${rows.filter((r) => r.liveness === 'running').length} running`;
}

/**
 * The Arming section's headline — how many spend gates are OPEN right now.
 * Distinct from `scheduleLaneValue` on purpose: that counts schedules that can
 * fire, this counts pots/lanes allowed to SPEND when something fires.
 */
export function armingLaneValue(
  gymPots: readonly AutomationGymArm[],
  lanes: readonly AutomationLaneArm[],
): string {
  const total = gymPots.length + lanes.length;
  if (total === 0) return 'None registered';
  const armed = gymPots.filter((g) => g.enabled).length + lanes.filter((l) => l.enabled).length;
  return armed > 0 ? `${armed} armed` : 'All disarmed';
}

/**
 * "$12.89 of $50" / "$500 · $1/cycle" / "$0 · no budget" — one honest money label per arming row.
 *
 * `budgetKind` is REQUIRED, deliberately. A per-cycle cap bounds ONE run and never the accumulating
 * total: `remainingLoopBudgetUsd` returns the cap unchanged for 'per-cycle'
 * (operator-core/lib/learning-governor/core.ts:83-87), so `spentUsd` climbs past `budgetUsd` in
 * normal healthy operation. Rendering that with "of" read a $500 total under a $1-per-run cap as a
 * 500x overrun. Giving this parameter a default would let a new call site silently reintroduce
 * exactly that, so callers must state the kind — gym rows pass the literal 'lifetime' because
 * gym_autoloop_config has no budget_kind column and the gym pattern IS the accumulating one.
 *
 * The fix is to make the label kind-AWARE, never to clamp spend to the cap: clamping would hide a
 * real lifetime overrun, which is the strictly worse failure.
 */
export function armBudgetLabel(
  spentUsd: number,
  budgetUsd: number | null,
  budgetKind: 'lifetime' | 'per-cycle',
): string {
  const money = (n: number) => `$${n >= 100 ? Math.round(n) : n.toFixed(2).replace(/\.00$/, '')}`;
  if (budgetUsd === null) return `${money(spentUsd)} · no budget`;
  return budgetKind === 'per-cycle'
    ? `${money(spentUsd)} · ${money(budgetUsd)}/cycle`
    : `${money(spentUsd)} of ${money(budgetUsd)}`;
}

/**
 * Sort rows into the three state buckets the pane renders.
 *
 * The one asymmetry between lenses is whether RUNNING is expanded. In the Agents
 * pane every running row costs money and there are ~20 of them, so each is worth a
 * line. In the System pane there are ~30 and they are free — the owner only cares
 * that they are fine, so they collapse to a single "✓ N running" line and promote
 * themselves into Needs-you the moment one breaks. That is the whole reason a
 * separate System tab earns its place: not a room of its own, but a room you never
 * have to enter.
 */
export function bucketRows(rows: readonly AutomationRoutine[], lens: PaneLens): Bucket[] {
  const byName = (a: AutomationRoutine, b: AutomationRoutine) => a.name.localeCompare(b.name);
  const attention = rows.filter((r) => r.needsAttention).sort(byName);
  const running = rows
    .filter((r) => !r.needsAttention && r.liveness === 'running')
    .sort((a, b) => Number(b.spawnsAgent) - Number(a.spawnsAgent) || byName(a, b));
  const dormant = rows.filter((r) => !r.needsAttention && r.liveness === 'dormant').sort(byName);

  return [
    { id: 'attention', label: 'Needs you', rows: attention, foldedByDefault: false, tone: 'warn' },
    {
      id: 'running',
      label: lens === 'llm' ? 'Spending now' : 'Running',
      rows: running,
      foldedByDefault: lens === 'system',
      tone: lens === 'llm' ? 'spend' : 'good',
    },
    { id: 'dormant', label: 'Dormant', rows: dormant, foldedByDefault: true, tone: 'mute' },
  ];
}

/**
 * The pane's ONE pause/start control. Every start/stop switch in this pane —
 * per-routine and per-arming-row — renders through here, so there is a single place
 * to get the transport idiom right (rounds 2 and 3 each restyled only the control in
 * front of them and left the other looking like something else).
 *
 * Two rules live in this component rather than in CSS, because both are easy to
 * undo by accident:
 *
 *  • THE GLYPH IS SOLID. lucide draws Play/Pause stroke-only, which at 13px is a
 *    hollow triangle and two hairline bars — it reads as a faint mark, not a
 *    transport glyph, and that is the single biggest reason the owner has now
 *    asked four times for these to "look like pause/start buttons". `fill` +
 *    a low `strokeWidth` make the fill define the shape. Do not drop the fill.
 *  • LAYOUT LIVES ON THE INNER SPAN. The <button> is display:block and
 *    .pc-auto__glyph does the centring, because WebKitGTK (the Tauri webview
 *    this actually ships in) IGNORES flex set on a <button> element — centring
 *    declared on the button is silently dropped on the real desktop while
 *    looking perfect in Chromium (EI-18135716653974462 / WI-5581).
 *
 * `on` means the thing is currently RUNNING (or ARMED), so the button offers the
 * STOP verb. The glyph always shows the ACTION THE CLICK PERFORMS, never the
 * current state — the row's own tint already carries state.
 */
function TransportToggle({
  on,
  busy,
  disabled,
  label,
  testId,
  kind = 'transport',
  onClick,
}: {
  on: boolean;
  busy: boolean;
  disabled: boolean;
  label: string;
  testId: string;
  /** 'transport' → play/pause (schedules). 'shield' → arm/disarm (spend gates). */
  kind?: 'transport' | 'shield';
  onClick: () => void;
}) {
  const glyph = kind === 'shield' ? (on ? 'disarm' : 'arm') : on ? 'pause' : 'play';
  return (
    <button
      type="button"
      className={`pc-auto__toggle${on ? ' is-on' : ''}`}
      data-glyph={glyph}
      disabled={disabled}
      aria-pressed={on}
      aria-label={label}
      onClick={onClick}
      data-testid={testId}
    >
      <span className="pc-auto__glyph">
        {busy ? (
          <span className="pc-auto__spinner" data-testid={`${testId}-busy`} aria-hidden />
        ) : kind === 'shield' ? (
          // Shields stay stroke-only: they are not transport glyphs, they read
          // fine as outlines at this size, and the amber/green tint already says
          // which way the switch is thrown.
          on ? (
            <ShieldOff size={13} aria-hidden />
          ) : (
            <Shield size={13} aria-hidden />
          )
        ) : on ? (
          <Pause size={13} fill="currentColor" strokeWidth={1.5} aria-hidden />
        ) : (
          <Play size={13} fill="currentColor" strokeWidth={1.5} aria-hidden />
        )}
      </span>
    </button>
  );
}

export interface AutomationPaneProps {
  active: boolean;
  /** Which half of the split this pane renders. */
  lens: PaneLens;
  title: string;
  /** One-line identity beside the title (the Mug bar's subtitle slot). */
  subtitle: string;
  /** lucide icon for the header bar. */
  icon: ComponentType<{ size?: number | string; 'aria-hidden'?: boolean }>;
  blurb: string;
  /**
   * Optional pane-scoped content rendered directly under the blurb, ABOVE the
   * view switch and the schedule rows (P-077). It exists because a tab built on
   * this pane may own one surface that is NOT a schedule row — today that is the
   * System tab's `PotFederationStatus`, re-homed here when the Pots tab was
   * removed. Putting it in a slot the pane owns (rather than as a sibling of the
   * pane inside `.pclsb__body`) is what keeps it inside the pane's own column
   * flow and above ~85 folded rows, instead of stranded at the bottom of the
   * scroll or floating above the tab's own header.
   */
  children?: ReactNode;
}

export default function AutomationPane({
  active,
  lens,
  title,
  subtitle,
  icon: Icon,
  blurb,
  children,
}: AutomationPaneProps) {
  const cat = useSyncQuery<AutomationCatalog>({
    queryName: 'automation.catalog',
    args: {},
    staleTime: 20_000,
    enabled: active,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Budget click-to-edit: which arming row is being edited, and the draft text.
  // Draft state is render-local (mid-edit), so useState is correct here, not nuqs.
  const [budgetEdit, setBudgetEdit] = useState<{ key: string; value: string } | null>(null);

  // Which view, and which folds are open — both user-meaningful, so both in the URL
  // (and therefore agent-driveable via ui:get_state / ui:dispatch). Namespaced by
  // lens so the two panes do not fight over one param.
  const [view, setView] = useQueryState(
    `${lens}View`,
    parseAsStringLiteral(VIEWS).withDefault('attention'),
  );
  const [open, setOpen] = useQueryState(
    `${lens}Open`,
    parseAsArrayOf(parseAsString).withDefault([]),
  );

  // useSyncQuery always yields an ARRAY (SyncQueryResult<T>.data is T[]); the
  // resolver returns a single catalog row, so unwrap it.
  const data = cat.data?.[0] ?? null;

  const rows: AutomationRoutine[] = useMemo(
    () => (data ? rowsForLens(data.routines, lens) : []),
    [data, lens],
  );

  const buckets = useMemo(() => bucketRows(rows, lens), [rows, lens]);
  const families = lens === 'llm' ? AGENT_FAMILY_ORDER : SYSTEM_FAMILY_ORDER;

  /**
   * Stalled LOOPS are collapsed into one summary row inside Needs-you.
   *
   * Measured against live data (2026-07-26): 19 of the Agents pane's 19 needs-you
   * rows were stalled loops — armed, never firing again, owning session long gone.
   * Rendered individually they push "Spending now" off the first screen, which
   * recreates in miniature the exact problem this pane was rebuilt to fix. They are
   * a homogeneous class with ONE remedy, so they read better as a single line that
   * expands than as nineteen near-identical rows.
   *
   * Everything else in Needs-you stays individually listed — those are distinct
   * problems with distinct fixes.
   */
  const attentionSplit = useMemo(() => {
    const attn = buckets.find((b) => b.id === 'attention')?.rows ?? [];
    const stalledLoops = attn.filter((r) => r.kind === 'loop' && r.liveness === 'stalled');
    const others = attn.filter((r) => !(r.kind === 'loop' && r.liveness === 'stalled'));
    return { stalledLoops, others, grouped: stalledLoops.length > 2 };
  }, [buckets]);
  const loopsExpanded = open.includes('attn-loops');

  const isOpen = (b: Bucket) => (b.foldedByDefault ? open.includes(b.id) : !open.includes(`-${b.id}`));
  const toggleBucket = (b: Bucket) => {
    const key = b.foldedByDefault ? b.id : `-${b.id}`;
    void setOpen(open.includes(key) ? open.filter((x) => x !== key) : [...open, key]);
  };

  // What "Pause all" can ACTUALLY stop. Counting uncontrollable schedules would put
  // a number on the button the click cannot deliver — the pane must never again
  // promise an action it can't perform.
  const activeSpawning = rows.filter((r) => r.active && r.spawnsAgent && r.controllable).length;

  async function toggleRoutine(r: AutomationRoutine) {
    const key = `${r.installSlug}/${r.name}`;
    const nextActive = !r.active;
    setBusy(key);
    setErr(null);
    try {
      if (r.control === 'flag') {
        // The row's switch IS a feature flag (doc-steward-dispatch →
        // papercusp-doc-steward). Before this it rendered a padlock, so the one
        // control that genuinely existed was the one the pane refused to offer.
        const flagKey = r.flagKey;
        if (!flagKey) throw new Error(`${r.name} is flag-controlled but carries no flag key`);
        await runControlTool('flags:set', {
          key: flagKey,
          enabled: nextActive,
          reason: `Toggled from the ${title} pane`,
        });
      } else {
        // Fan-out: one row can stand for many installs (git-sync ×19), so the
        // click has to reach every one of them or the button lies about its scope.
        for (const installSlug of r.installs) {
          await runControlTool('routines:set', {
            name: r.name,
            installSlug,
            active: nextActive,
            // routines:set requires `reason` when pausing (EI-18654017982759582 — an
            // unattributed pause has twice stayed silently off for days). This pane's
            // whole point is a ONE-CLICK pause, so a text prompt would defeat the
            // design — attribute it to the pane itself instead of leaving the click
            // to structurally fail every time (EI-18680916805234639).
            ...(nextActive ? {} : { reason: `Paused via the ${title} pane` }),
          });
        }
      }
      cat.invalidate?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function pauseAll(nextActive: boolean) {
    setBusy('__all__');
    setErr(null);
    try {
      // Pausing each member by name is the only way the button does exactly what
      // its label says, and it never touches a row outside this pane. The
      // `controllable` guard matters: a non-routine schedule has no switch this
      // tool can throw, so including it would throw on a row it can never change
      // and abort the rest of the batch.
      for (const r of rows.filter((x) => x.controllable && x.spawnsAgent && x.active !== nextActive)) {
        for (const installSlug of r.installs) {
          await runControlTool('routines:set', {
            name: r.name,
            installSlug,
            active: nextActive,
            ...(nextActive ? {} : { reason: `Paused via "Pause all" in the ${title} pane` }),
          });
        }
      }
      cat.invalidate?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // ── Arming (spend gates) — the LLM pane only ───────────────────────────────
  // The schedule rows gate WHEN things fire; these gate whether a fire may SPEND.
  // Moved here from the retired Blender tab: a spend gate belongs beside the things
  // that spend, and it has no meaning at all in the deterministic pane.
  const showArming = lens === 'llm';
  const arming = data?.arming ?? null;

  async function runArm(
    key: string,
    tool: 'gym:arm' | 'governor:arm' | 'learning:set-scout-budget',
    args: Record<string, unknown>,
  ): Promise<void> {
    setBusy(key);
    setErr(null);
    try {
      await runControlTool(tool, args);
      cat.invalidate?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  /** Commit a budget draft: '' clears the budget (null), otherwise a finite ≥0 number. */
  async function saveBudget(row: {
    key: string;
    tool: 'gym:arm' | 'governor:arm';
    idArgs: Record<string, unknown>;
  }): Promise<void> {
    if (!budgetEdit || budgetEdit.key !== row.key) return;
    const raw = budgetEdit.value.trim();
    const budgetUsd = raw === '' ? null : Number(raw);
    if (budgetUsd !== null && (!Number.isFinite(budgetUsd) || budgetUsd < 0)) {
      setErr(`"${raw}" is not a valid budget — enter a dollar amount, or clear to remove the cap`);
      return;
    }
    setBudgetEdit(null);
    await runArm(row.key, row.tool, { ...row.idArgs, budgetUsd });
  }

  /** Commit the workspace-ceiling draft: '' clears the override, otherwise a finite ≥0 number sets it. */
  async function saveScoutCeiling(): Promise<void> {
    if (!budgetEdit || budgetEdit.key !== SCOUT_CEILING_KEY) return;
    const raw = budgetEdit.value.trim();
    if (raw !== '' && (!Number.isFinite(Number(raw)) || Number(raw) < 0)) {
      setErr(`"${raw}" is not a valid ceiling — enter a dollar amount, or clear to revert to the default`);
      return;
    }
    setBudgetEdit(null);
    await runArm(
      SCOUT_CEILING_KEY,
      'learning:set-scout-budget',
      raw === '' ? { op: 'clear' } : { op: 'set', workspaceCeilingUsd: Number(raw) },
    );
  }

  if (!active) return null;

  const renderRow = (r: AutomationRoutine) => {
    const key = `${r.kind}/${r.name}`;
    /*
     * Brightness keys on the ARMED state, not on `active` (WI-6447).
     *
     * `active` is a boolean the unknown case gets folded into (`row.armed !==
     * false`), so an unverifiable row used to render at full opacity — the row
     * VISUALLY asserting "on" while its own meta line says "arm state unknown".
     * Three states, three weights: armed reads live, unknown reads unconfirmed,
     * not-armed reads off. For a routines row `armedState` is derived from
     * `active`, so nothing about those changes.
     */
    const armedClass =
      r.armedState === 'armed' ? ' is-active' : r.armedState === 'unknown' ? ' is-unverified' : '';
    return (
      <div
        key={key}
        role="listitem"
        className={`pc-auto__row${armedClass}${r.needsAttention ? ' is-attention' : ''}`}
        data-testid={`automation-row-${r.name}`}
      >
        <div className="pc-auto__row-main">
          <span className="pc-auto__name" title={`${r.name} · ${r.installs.join(', ')}`}>
            {rowLabel(r)}
          </span>
          <span className="pc-auto__meta">
            {rowMeta(r)}
            {r.installs.length > 1 && (
              <Tooltip label={`Installed on ${r.installs.length} pots: ${r.installs.join(', ')}`}>
                <span className="pc-auto__pill" data-testid={`automation-installs-${r.name}`}>
                  <Layers size={9} aria-hidden /> ×{r.installs.length}
                </span>
              </Tooltip>
            )}
            {r.kind === 'triggered' && (
              <Tooltip label="Fires on an event, not a clock — it has no schedule to pause">
                <span className="pc-auto__pill pc-auto__pill--trigger">
                  <Zap size={9} aria-hidden /> triggered
                </span>
              </Tooltip>
            )}
            {r.spend === 'llm' && (
              <Tooltip label={r.spendWhy ?? 'Spawns a model-backed agent — it costs tokens when it fires'}>
                <span className="pc-auto__tokenflag">
                  <Coins size={10} aria-hidden /> tokens
                </span>
              </Tooltip>
            )}
            {r.spend === 'unknown' && (
              <Tooltip label="No handler is registered for this routine's target_role — it fires and silently does nothing. Filed as a bug.">
                <span className="pc-auto__pill pc-auto__pill--unknown">no handler</span>
              </Tooltip>
            )}
          </span>
          <span className="pc-auto__when">last {agoLabel(r.lastFiredAt)}</span>
        </div>
        {r.controllable || r.control === 'flag' ? (
          <TransportToggle
            on={r.active}
            busy={busy === `${r.installSlug}/${r.name}`}
            disabled={busy !== null}
            label={`${r.active ? 'Pause' : 'Start'} ${r.name}`}
            testId={`automation-toggle-${r.name}`}
            onClick={() => void toggleRoutine(r)}
          />
        ) : (
          /* Listed for visibility, but genuinely not switchable from here. The
             marker names WHY — the old padlock meant four different things at
             once ("it's a DBOS workflow" / "a managed timer" / "a git-sync hook" /
             "its switch is a flag"), and the flag case has now been given a real
             control above, so what remains here is only the truly uncontrollable.

             The copy comes from `controlWhy` (catalog.ts → routineControl), NOT
             from a string built here: "paused from its own subsystem" named a
             limitation and pointed nowhere, which is why the owner had to ask a
             human what it meant rather than reading the row (WI-6313). A watchdog
             and a per-connection keepalive are uncontrollable for completely
             different reasons, and the row should say which. */
          <Tooltip
            label={
              r.kind === 'triggered'
                ? `Runs on its trigger (${r.triggerLabel ?? 'an event'}) — there is no schedule to pause`
                : r.controlWhy
            }
          >
            <span
              className="pc-auto__nocontrol"
              data-testid={`automation-nocontrol-${r.name}`}
              aria-label={`${r.name} cannot be paused from this pane`}
            >
              <Lock size={11} aria-hidden />
            </span>
          </Tooltip>
        )}
      </div>
    );
  };

  return (
    <TooltipPrimitive.Provider delayDuration={250}>
      <div className="pc-auto" data-testid={`automation-pane-${title.toLowerCase()}`}>
        {/* 1 — header bar (mirrors pc-queen__bar) */}
        <header className="pc-auto__bar">
          <Icon size={14} aria-hidden />
          <span className="pc-auto__identity">
            <span className="pc-auto__title">{title}</span>
            <span className="pc-auto__subtitle">{subtitle}</span>
          </span>
          {/* These are SCHEDULES, not per-pot agents — say so, for the same reason
              the Mug + Kettle headers now do (owner question 2026-07-25: "what do
              those pot labels mean if they operate at the workspace level?"). */}
          <Tooltip label="Scheduled work runs for the whole workspace, not one pot">
            <span className="pc-auto__scope">workspace</span>
          </Tooltip>
          <span className="pc-auto__spacer" />
          {showArming && activeSpawning > 0 ? (
            <Tooltip label={`Pause all ${activeSpawning} token-spending ${title} agent${activeSpawning === 1 ? '' : 's'}`}>
              <button
                type="button"
                className="pc-auto__action pc-auto__action--stop"
                disabled={busy !== null}
                onClick={() => void pauseAll(false)}
                data-testid="automation-pause-all"
              >
                {/* Inner span carries the icon/label row — WebKitGTK ignores
                    flex on the <button> itself (see TransportToggle's note). */}
                <span className="pc-auto__action-inner">
                  <span className="pc-auto__action-dot">
                    <Pause size={9} fill="currentColor" strokeWidth={1.5} aria-hidden />
                  </span>
                  Pause all
                </span>
              </button>
            </Tooltip>
          ) : (
            showArming &&
            rows.some((r) => r.spawnsAgent && r.controllable) && (
              <Tooltip label={`Resume the scheduled ${title} agents`}>
                <button
                  type="button"
                  className="pc-auto__action pc-auto__action--go"
                  disabled={busy !== null}
                  onClick={() => void pauseAll(true)}
                  data-testid="automation-resume-all"
                >
                  <span className="pc-auto__action-inner">
                    <span className="pc-auto__action-dot">
                      <Play size={9} fill="currentColor" strokeWidth={1.5} aria-hidden />
                    </span>
                    Resume all
                  </span>
                </button>
              </Tooltip>
            )
          )}
        </header>

        {err && (
          <div className="pc-auto__err" role="alert">
            <AlertTriangle size={12} aria-hidden /> {err}
          </div>
        )}
        {cat.error && <div className="pc-auto__err" role="alert">{String(cat.error)}</div>}

        <div className="pc-auto__panel">
          <p className="pc-auto__blurb">{blurb}</p>

          {/* Pane-scoped non-schedule content (P-077) — see the `children` prop.
              Rendered before the view switch so it cannot be pushed below the
              fold by the row list. */}
          {children}

          {/* View switch — state-ordered by default, subject-ordered on request. */}
          <div className="pc-auto__views" role="tablist" aria-label={`${title} view`}>
            {VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                className="pc-auto__viewbtn"
                onClick={() => void setView(v)}
                data-testid={`automation-view-${v}`}
              >
                {v === 'attention' ? (
                  <>
                    <CalendarClock size={10} aria-hidden /> By state
                  </>
                ) : (
                  <>
                    <ListTree size={10} aria-hidden /> By family
                  </>
                )}
              </button>
            ))}
          </div>

          {cat.loading && !data && <div className="pc-auto__placeholder">Loading…</div>}

          {data && rows.length === 0 && (
            <div className="pc-auto__placeholder">
              {lens === 'llm'
                ? 'No scheduled agents. Nothing here is consuming tokens.'
                : 'No system schedules registered.'}
            </div>
          )}

          {data && rows.length > 0 && view === 'attention' && (
            <>
              {buckets.map((b) => {
                const opened = isOpen(b);
                if (b.rows.length === 0 && b.id !== 'attention') return null;
                return (
                  <section
                    key={b.id}
                    className={`pc-auto__section pc-auto__section--${b.tone}`}
                    data-testid={`automation-bucket-${b.id}`}
                  >
                    <button
                      type="button"
                      className="pc-auto__section-head pc-auto__section-head--btn"
                      aria-expanded={opened}
                      onClick={() => toggleBucket(b)}
                      data-testid={`automation-bucket-toggle-${b.id}`}
                    >
                      <span className="pc-auto__section-inner">
                        {opened ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
                        <span className="pc-auto__section-title">{b.label}</span>
                        <span className="pc-auto__count" data-testid={`automation-bucket-count-${b.id}`}>
                          {b.id === 'attention' && b.rows.length === 0
                            ? 'all clear'
                            : b.id === 'running' && !opened
                              ? `${b.rows.length} running · last ${agoLabel(
                                  b.rows.map((r) => r.lastFiredAt).filter(Boolean).sort().at(-1) ?? null,
                                )}`
                              : b.rows.length}
                        </span>
                      </span>
                    </button>
                    {opened && b.rows.length > 0 && (
                      <div className="pc-auto__list" role="list">
                        {b.id === 'attention' && attentionSplit.grouped ? (
                          <>
                            {attentionSplit.others.map(renderRow)}
                            {/* The stalled-loop roll-up. One line, one remedy, and
                                the count is the point — see attentionSplit. */}
                            <div role="listitem" className="pc-auto__row is-attention">
                              <button
                                type="button"
                                className="pc-auto__rollup"
                                aria-expanded={loopsExpanded}
                                onClick={() =>
                                  void setOpen(
                                    loopsExpanded
                                      ? open.filter((x) => x !== 'attn-loops')
                                      : [...open, 'attn-loops'],
                                  )
                                }
                                data-testid="automation-stalled-loops-rollup"
                              >
                                <span className="pc-auto__rollup-inner">
                                  {loopsExpanded ? (
                                    <ChevronDown size={11} aria-hidden />
                                  ) : (
                                    <ChevronRight size={11} aria-hidden />
                                  )}
                                  <span className="pc-auto__name">
                                    {attentionSplit.stalledLoops.length} stalled loops
                                  </span>
                                  <span className="pc-auto__meta">
                                    armed but never firing — owning sessions gone
                                  </span>
                                </span>
                              </button>
                            </div>
                            {loopsExpanded && attentionSplit.stalledLoops.map(renderRow)}
                          </>
                        ) : (
                          b.rows.map(renderRow)
                        )}
                      </div>
                    )}
                  </section>
                );
              })}
            </>
          )}

          {data && rows.length > 0 && view === 'family' && (
            <>
              {families.map((fam: RoutineFamily) => {
                const famRows = rows.filter((r) => r.family === fam);
                if (famRows.length === 0) return null;
                const opened = !open.includes(`-fam:${fam}`);
                const attention = famRows.filter((r) => r.needsAttention).length;
                return (
                  <section key={fam} className="pc-auto__section" data-testid={`automation-family-${fam}`}>
                    <button
                      type="button"
                      className="pc-auto__section-head pc-auto__section-head--btn"
                      aria-expanded={opened}
                      onClick={() =>
                        void setOpen(
                          opened ? [...open, `-fam:${fam}`] : open.filter((x) => x !== `-fam:${fam}`),
                        )
                      }
                    >
                      <span className="pc-auto__section-inner">
                        {opened ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
                        <span className="pc-auto__section-title">{FAMILY_LABEL[fam]}</span>
                        <span className="pc-auto__count">
                          {attention > 0
                            ? `${attention} need${attention === 1 ? 's' : ''} you`
                            : `${famRows.filter((r) => r.liveness === 'running').length} of ${famRows.length} running`}
                        </span>
                      </span>
                    </button>
                    {opened && (
                      <div className="pc-auto__list" role="list">
                        {famRows
                          .slice()
                          .sort(
                            (a, b) =>
                              Number(b.needsAttention) - Number(a.needsAttention) ||
                              a.name.localeCompare(b.name),
                          )
                          .map(renderRow)}
                      </div>
                    )}
                  </section>
                );
              })}
            </>
          )}

          {/* The Arming section (P-011, LLM pane only): the SPEND gates. A schedule
              row above can be active while its pot/lane here is disarmed — the
              routine fires and spends nothing. */}
          {showArming &&
            arming &&
            (arming.gymPots.length > 0 || arming.lanes.length > 0 || arming.scoutCeiling != null) && (
              <section className="pc-auto__section" data-testid="automation-arming">
                <div className="pc-auto__section-head">
                  <Shield size={12} aria-hidden />
                  <span className="pc-auto__section-title">Arming — spend gates</span>
                  <span className="pc-auto__count" data-testid="automation-arming-status">
                    {armingLaneValue(arming.gymPots, arming.lanes)}
                  </span>
                </div>
                <div className="pc-auto__list" role="list">
                  {arming.scoutCeiling && (
                    <div
                      role="listitem"
                      className="pc-auto__row is-active"
                      data-testid="arming-row-scout-workspace-ceiling"
                    >
                      <div className="pc-auto__row-main">
                        <span
                          className="pc-auto__name"
                          title="Workspace-wide learning spend ceiling — caps ALL Blender/Scout spend above the per-pot and per-lane budgets below. 0 = no learning spend allowed. Empty reverts to the built-in default."
                        >
                          workspace ceiling
                        </span>
                        <span className="pc-auto__meta">
                          {budgetEdit?.key === SCOUT_CEILING_KEY ? (
                            <input
                              className="pc-auto__budget-input"
                              style={{ width: 64, font: 'inherit' }}
                              autoFocus
                              inputMode="decimal"
                              aria-label="Workspace learning spend ceiling (USD; empty reverts to the default)"
                              value={budgetEdit.value}
                              onChange={(e) => setBudgetEdit({ key: SCOUT_CEILING_KEY, value: e.target.value })}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void saveScoutCeiling();
                                if (e.key === 'Escape') setBudgetEdit(null);
                              }}
                              onBlur={() => setBudgetEdit(null)}
                              data-testid="arming-budget-input-scout-workspace-ceiling"
                            />
                          ) : (
                            <Tooltip label="Click to edit the workspace ceiling (Enter saves, Esc cancels; empty reverts to the default)">
                              <button
                                type="button"
                                className="pc-auto__budget"
                                style={{ all: 'unset', cursor: 'pointer' }}
                                disabled={busy !== null}
                                onClick={() =>
                                  setBudgetEdit({
                                    key: SCOUT_CEILING_KEY,
                                    value:
                                      arming.scoutCeiling!.overrideUsd === null
                                        ? ''
                                        : String(arming.scoutCeiling!.overrideUsd),
                                  })
                                }
                                data-testid="arming-budget-scout-workspace-ceiling"
                              >
                                <Coins size={10} aria-hidden /> ${arming.scoutCeiling.effectiveUsd} ceiling
                              </button>
                            </Tooltip>
                          )}
                        </span>
                        <span className="pc-auto__when">
                          {arming.scoutCeiling.overrideUsd === null ? 'default' : 'override'}
                        </span>
                      </div>
                    </div>
                  )}
                  {[
                    ...arming.gymPots.map((g) => ({
                      key: `gym/${g.harnessSlug}`,
                      tool: 'gym:arm' as const,
                      idArgs: { harness: g.harnessSlug },
                      name: `gym · ${g.harnessSlug}`,
                      hint: `Gym autoloop for the ${g.harnessSlug} pot — arming writes the autoloop config AND its governor row together`,
                      enabled: g.enabled,
                      budgetUsd: g.budgetUsd,
                      // gym_autoloop_config has no budget_kind column; the gym pattern IS the
                      // accumulating cap (learning-governor/core.ts:33), so this is a fact, not a fallback.
                      budgetKind: 'lifetime' as const,
                      spentUsd: g.spentUsd,
                      meta: g.status,
                    })),
                    ...arming.lanes.map((l) => ({
                      key: `lane/${l.loopId}`,
                      tool: 'governor:arm' as const,
                      idArgs: { loopId: l.loopId },
                      name: l.displayName,
                      hint: l.loopId + (l.potSlug ? ` · pot ${l.potSlug}` : ''),
                      enabled: l.enabled,
                      budgetUsd: l.budgetUsd,
                      budgetKind: l.budgetKind,
                      spentUsd: l.spentUsd,
                      meta: l.enforcement,
                    })),
                  ].map((row) => (
                    <div
                      key={row.key}
                      role="listitem"
                      className={`pc-auto__row${row.enabled ? ' is-active' : ''}`}
                      data-testid={`arming-row-${row.key.replace(/[^a-zA-Z0-9-]/g, '-')}`}
                    >
                      <div className="pc-auto__row-main">
                        <span className="pc-auto__name" title={row.hint}>
                          {row.name}
                        </span>
                        <span className="pc-auto__meta">
                          {budgetEdit?.key === row.key ? (
                            <input
                              className="pc-auto__budget-input"
                              style={{ width: 64, font: 'inherit' }}
                              autoFocus
                              inputMode="decimal"
                              aria-label={`Budget for ${row.name} (USD; empty clears)`}
                              value={budgetEdit.value}
                              onChange={(e) => setBudgetEdit({ key: row.key, value: e.target.value })}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void saveBudget(row);
                                if (e.key === 'Escape') setBudgetEdit(null);
                              }}
                              onBlur={() => setBudgetEdit(null)}
                              data-testid={`arming-budget-input-${row.key.replace(/[^a-zA-Z0-9-]/g, '-')}`}
                            />
                          ) : (
                            <Tooltip label="Click to edit the budget (Enter saves, Esc cancels; empty clears the cap)">
                              <button
                                type="button"
                                className="pc-auto__budget"
                                style={{ all: 'unset', cursor: 'pointer' }}
                                disabled={busy !== null}
                                onClick={() =>
                                  setBudgetEdit({
                                    key: row.key,
                                    value: row.budgetUsd === null ? '' : String(row.budgetUsd),
                                  })
                                }
                                data-testid={`arming-budget-${row.key.replace(/[^a-zA-Z0-9-]/g, '-')}`}
                              >
                                <Coins size={10} aria-hidden />{' '}
                                {armBudgetLabel(row.spentUsd, row.budgetUsd, row.budgetKind)}
                              </button>
                            </Tooltip>
                          )}
                        </span>
                        <span className="pc-auto__when">{row.meta}</span>
                      </div>
                      {/* kind="shield": these rows ARM/DISARM a spend gate, they do
                          not start or pause a schedule. They used to borrow the
                          play/pause glyph, so ▶ and ⏸ meant two unrelated verbs in
                          one pane. The shield keeps ▶/⏸ meaning exactly one thing
                          here — start or pause a scheduled agent. */}
                      <TransportToggle
                        kind="shield"
                        on={row.enabled}
                        busy={busy === row.key}
                        disabled={busy !== null}
                        label={`${row.enabled ? 'Disarm' : 'Arm'} ${row.name}`}
                        testId={`arming-toggle-${row.key.replace(/[^a-zA-Z0-9-]/g, '-')}`}
                        onClick={() => void runArm(row.key, row.tool, { ...row.idArgs, enabled: !row.enabled })}
                      />
                    </div>
                  ))}
                </div>
              </section>
            )}
        </div>
      </div>
    </TooltipPrimitive.Provider>
  );
}
