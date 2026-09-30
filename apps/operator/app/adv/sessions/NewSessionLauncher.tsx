'use client';

/**
 * NewSessionLauncher — the "+ New session" launch control, lifted out of
 * AdvSessionsClient.tsx (hud-consolidation-2026-07-26 P-001) so a second
 * surface (the HUD board header) can offer the same "launch from plan
 * context" affordance without hand-rolling a second launcher.
 *
 * AdvSessionsClient.tsx itself is NOT currently mounted by any live route
 * (the Sessions tab was folded into the Create dock under WI-3045, which
 * uses SessionsRosterView instead) — importing FROM it would drag its whole
 * page bundle (Radix Tabs/Collapsible, @tauri-apps/api/core, the full
 * sessions-history UI) into whatever imports this module, i.e. it would not
 * "import cleanly" per the plan's own escape hatch. So the reusable pieces
 * (the plan-option builder + its constants) are LIFTED here instead, and
 * AdvSessionsClient imports them back from this module — one canonical
 * implementation, not two.
 *
 * This component is fully self-contained (own plan list fetch, own
 * plan/model selection state, own launch call via `launchAgent` — the same
 * single launch entry point every backend goes through, per launch-agent.ts).
 * Selection state is local `useState`, not nuqs: it is a mid-edit draft (the
 * in-progress choice before a session is actually created), not a durable or
 * shareable "current view" concept — see the repo's nuqs-vs-useState split.
 */
import { useCallback, useMemo, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Button } from '@/app/harness/Button';
import { Combobox, type ComboboxEntry, type ComboboxOption } from '@/app/harness/Combobox';
import { useLexicon } from '@/lib/useLexicon';
import { launchAgent, OWNER_LAUNCH_HEADLESS } from '@papercusp/operator-core/lib/launch-agent';
// WI-6300: the canonical model/effort vocabulary psu itself launches with. This
// module is deliberately client-safe (no node/server imports) — see its header —
// so the renderer can read it without dragging the PG/fs subtree into the bundle.
import {
  composeLaunchModelSpec,
  SU_CONTEXT_SIZES,
  SU_CONTEXT_TOKEN_ESTIMATES,
} from '@papercusp/operator-core/lib/agent-config-constants';
// P-042 / D-067: the launch-MODE vocabulary, from the modes registry itself —
// the same list launch-su validates against, so the picker cannot offer a mode
// the launcher would refuse. Client-safe for the same reason the module above
// is: registry.ts has ZERO imports (pure data + pure functions), so reading it
// here drags no node/server subtree into the renderer bundle.
import { launchableModes } from '@papercusp/operator-core/lib/modes/registry';
import { useIdentityLaunchCatalog, useSuLaunchOptions, type IdentityLaunchCatalog } from './use-su-launch-options';
import {
  ACCOUNT_SELECT_DEFAULT,
  EFFORT_OPTIONS,
  EFFORT_SELECT_DEFAULT,
  MODEL_SELECT_DEFAULT,
  OMP_MODEL_OPTIONS,
  buildAccountOptions,
  buildEffortOptions,
  buildModelOptions,
  modelBackend,
} from './su-launch-option-entries';
export {
  ACCOUNT_SELECT_DEFAULT,
  EFFORT_OPTIONS,
  EFFORT_SELECT_DEFAULT,
  MODEL_SELECT_DEFAULT,
  OMP_MODEL_OPTIONS,
  buildAccountOptions,
  buildEffortOptions,
  buildModelOptions,
  modelBackend,
} from './su-launch-option-entries';
import {
  formatAbsoluteUpdated,
  formatRelativeUpdated,
} from '@papercusp/operator-core/lib/format/relative-time';
import { usePlanList, type PlanListRow } from '@/app/admin/plans/plans-api';

export const PLAN_SELECT_PLACEHOLDER = '__select_plan__';
/**
 * WI-6321 (owner ask 2026-07-27: the GUI "should share the same code for getting
 * the options"): this used to be a THIRD private copy of spec composition, and it
 * disagreed with the others — given an effort but no model it returned the model
 * (i.e. `null`) and DROPPED the effort silently, so a human who picked "xhigh"
 * with the default model launched at the backend's default effort and was never
 * told. `composeLaunchModelSpec` is the one implementation; it THROWS on that
 * case, and `launch` below turns the throw into a visible message.
 *
 * Kept as a named wrapper (not an import rename) because the null-for-empty
 * return is what this component's callers and tests expect.
 */
export function composeModelSpec(model: string, effort: string): string | null {
  return composeLaunchModelSpec(model, effort) ?? null;
}

// ── psu-parity option families (WI-6321) ────────────────────────────────────
// Each mirrors a picker `psu` shows at launch. The LIVE ones (fleet, account)
// read psu's own options endpoint via useSuLaunchOptions; the static ones derive
// from agent-config-constants, which the psu-launcher parity suite pins.

export const FLEET_SELECT_NONE = '__no_fleet__';
export const FLEET_SELECT_NEW = '__new_fleet__';
export const CONTEXT_SELECT_NATIVE = '__native_context__';
export const MODE_SELECT_NONE = '__no_mode__';
export const IDENTITY_SELECT_DEFAULT = 'su';
const IDENTITY_SELECT_MORE = '__more_identities__';

export function buildIdentityLaunchOptions(catalog: Pick<IdentityLaunchCatalog,
  'identities' | 'unreadable' | 'nextAfter'>): ComboboxOption[] {
  const options: ComboboxOption[] = [{ value: IDENTITY_SELECT_DEFAULT, label: 'SU',
    detail: 'Default identity composition' }];
  for (const identity of catalog.identities) {
    if (identity.slots.length === 0 && identity.launchCompatibility?.eligible) {
      options.push({ value: `composition:${identity.id}`, label: identity.id,
        detail: `Named composition · ${identity.tier} · ${identity.version || 'unversioned'} · ${identity.sourceRevision.slice(0, 12)}`,
        keywords: [identity.id, identity.tier, 'composition'],
        disabled: !/^[a-f0-9]{64}$/.test(identity.sourceRevision) });
    }
    for (const slot of identity.slots) {
      options.push({ value: `${slot.slot}:${identity.id}`, label: identity.id,
        detail: identity.launchCompatibility?.eligible === false
          ? `${slot.slot} · unavailable: ${identity.launchCompatibility.reason}`
          : `${slot.slot} · ${identity.tier} · ${identity.version || 'unversioned'} · ${identity.sourceRevision.slice(0, 12)}`,
        keywords: [identity.id, identity.tier, slot.slot],
        disabled: identity.launchCompatibility?.eligible === false ||
          !slot.cardinality || !/^[a-f0-9]{64}$/.test(identity.sourceRevision) });
    }
  }
  for (const entry of catalog.unreadable) {
    options.push({ value: `invalid:${entry.id}`, label: entry.id,
      detail: `Invalid: ${entry.error}`, disabled: true });
  }
  if (catalog.nextAfter) options.push({ value: IDENTITY_SELECT_MORE,
    label: 'Load more identities…' });
  return options;
}
/**
 * New-session launches are always headless (WI-37871), so an unbound session
 * needs an actionable posture instead of opening an inert terminal-less agent.
 * Interactive remains available as an explicit opt-out in the picker.
 */
export const NEW_SESSION_DEFAULT_MODE = 'auto';

/** Fleet rows: "no fleet" (psu's own first row + default), "create a new fleet…"
 *  previewing the colour it would get, then every durable fleet with its bound
 *  colour as a swatch — psu's `pickFleet`, rendered.
 *
 *  Pure — exported for unit-test access. */
export function buildFleetOptions(
  fleets: Array<{ slug: string; title: string | null; color?: { name?: string } | null }>,
  nextSchemeName?: string | null,
): ComboboxOption[] {
  return [
    { value: FLEET_SELECT_NONE, label: 'No fleet', detail: 'Run unfleeted (default)' },
    {
      value: FLEET_SELECT_NEW,
      label: '+ Create a new fleet…',
      detail: nextSchemeName ? `New fleet — colour ${nextSchemeName}` : 'This session leads it',
    },
    ...fleets.map((f) => ({
      value: f.slug,
      label: f.title?.trim() || f.slug,
      detail: f.color?.name ? `join · ${f.color.name}` : 'join',
      keywords: [f.slug],
    })),
  ];
}

/** Launch-MODE rows (P-042 / D-067) — "Interactive" (send nothing, the explicit
 * opt-out) then every mode the registry marks `launchable`.
 *
 *  Rendered FROM the registry rather than a local list on purpose: launch-su
 *  validates against that same `LAUNCHABLE_MODE_IDS`, so this picker cannot
 *  drift into offering a mode psu would refuse — a failure that would surface as
 *  a terminal flashing one error line and closing, under a SUCCESS toast.
 *
 *  Pure — exported for unit-test access. */
export function buildModeOptions(): ComboboxOption[] {
  return [
    {
      value: MODE_SELECT_NONE,
      label: 'Interactive',
      detail: 'Explicit opt-out — confirm before acting',
    },
    ...launchableModes().map((m) => ({
      value: m.id,
      // 'AUTO — act, don’t ask' → the em-dash half is the detail line, so the
      // trigger stays short. Falls back to the whole title if it has no dash.
      label: m.title.split('—')[0]?.trim() || m.id.toUpperCase(),
      detail: m.oneLiner,
      keywords: [m.id],
    })),
  ];
}

/** Context-size rows — the twin of psu's SU_CONTEXT_CHOICES. "Native" sends no
 *  flag at all, which is byte-identical to a pre-feature launch.
 *
 *  Pure — exported for unit-test access. */
export function buildContextSizeOptions(): ComboboxOption[] {
  const DETAIL = { trimmed: 'Growable core spine, lazy catalog' } as const;
  return [
    { value: CONTEXT_SELECT_NATIVE, label: 'Native context', detail: "The client's own default" },
    ...SU_CONTEXT_SIZES.map((v) => ({
      value: v,
      label: `Trimmed · ${SU_CONTEXT_TOKEN_ESTIMATES[v]}`,
      detail: DETAIL[v],
    })),
  ];
}

/**
 * Build the grouped + sorted option tree for the "Start from plan
 * context" picker. Per `plans-newbutton-and-subharness-scope-2026-05-25`
 * P-026 / D-011.
 *
 * Pure — exported for unit-test access.
 */
export function buildLaunchPlanOptions(
  plans: PlanListRow[],
  activeHarness: string | null | undefined,
  loading: boolean,
  noHarnessLabel = '(unassigned)',
): ComboboxEntry[] {
  // Kept as a real row rather than folded into the Combobox's `placeholder`
  // prop: since P-005 made the plan optional, "no plan" is a legitimate
  // CHOICE, so the list needs a way to get back to it after one is picked.
  const placeholder: ComboboxOption = {
    value: PLAN_SELECT_PLACEHOLDER,
    label: loading ? 'Loading plans…' : 'Select plan…',
    detail: loading ? undefined : 'Launch with no plan bound',
  };
  if (plans.length === 0) return [placeholder];

  const NO_HARNESS_KEY = '__no-harness__';
  const byHarness = new Map<string, PlanListRow[]>();
  for (const p of plans) {
    const key = p.harness?.trim() || NO_HARNESS_KEY;
    let bucket = byHarness.get(key);
    if (!bucket) {
      bucket = [];
      byHarness.set(key, bucket);
    }
    bucket.push(p);
  }

  // Sort plans within each harness by updated DESC (newest first).
  const updatedMs = (p: PlanListRow): number => {
    if (!p.updated) return 0;
    const t = Date.parse(p.updated);
    return Number.isFinite(t) ? t : 0;
  };
  for (const list of byHarness.values()) {
    list.sort((a, b) => updatedMs(b) - updatedMs(a));
  }

  const allKeys = [...byHarness.keys()];
  const active = activeHarness?.trim() || null;
  const activeFirst = active && byHarness.has(active) ? [active] : [];
  const restKeys = allKeys
    .filter((k) => k !== active && k !== NO_HARNESS_KEY)
    .sort((a, b) => a.localeCompare(b));
  const orderedKeys = [
    ...activeFirst,
    ...restKeys,
    ...(byHarness.has(NO_HARNESS_KEY) ? [NO_HARNESS_KEY] : []),
  ];

  const groups: ComboboxEntry[] = orderedKeys.map((key) => {
    const label = key === NO_HARNESS_KEY ? noHarnessLabel : key;
    return {
      kind: 'group' as const,
      label,
      options: byHarness.get(key)!.map(
        (plan): ComboboxOption => ({
          value: plan.slug,
          label: plan.title?.trim() || plan.slug,
          detail: formatLaunchPlanOptionDetail(plan),
          // The slug is searchable but not shown — titles are what a human
          // scans, slugs are what they half-remember from a plan doc.
          keywords: [plan.slug, plan.harness ?? ''].filter(Boolean),
        }),
      ),
    };
  });

  return [placeholder, ...groups];
}

/**
 * The row's second line: "updated 26 Jul 2026, 14:03 · yesterday".
 *
 * P-007 (owner ask 2026-07-26: "display the full time details not just
 * 'today'"). The absolute stamp leads because that is the information the
 * owner was missing — `formatRelativeUpdated` collapses everything inside
 * 24h to "today", so a plan touched a minute ago and one touched 23 hours
 * ago were indistinguishable. The relative form is kept alongside it as the
 * at-a-glance cue, not as the only answer.
 *
 * Returns undefined (no second line) when the plan has no `updated` field.
 */
function formatLaunchPlanOptionDetail(plan: PlanListRow): string | undefined {
  if (!plan.updated) return undefined;
  const abs = formatAbsoluteUpdated(plan.updated);
  if (!abs) return undefined;
  const rel = formatRelativeUpdated(plan.updated);
  return rel ? `updated ${abs} · ${rel}` : `updated ${abs}`;
}

export interface NewSessionLauncherProps {
  className?: string;
  /** Called after a successful launch — callers whose session list isn't
   *  already sync-driven (e.g. AdvSessionsClient's polled list) can use this
   *  to force a refresh. The HUD board needs no such hook: its roster read
   *  (`advRoster.list`) is SSE-invalidated on any `adv_sessions` write, so
   *  the new session appears on its own.
   *
   *  Owner ask 2026-07-27: it also carries the new session's COORD OWNER ID, so
   *  a caller can OPEN its chat instead of leaving the human to find it on a
   *  board. `launch-su` pre-pins this id (`psu --owner-id=`) and returns it, so
   *  it is known at launch time and stable from then on — it is the same key
   *  the chat surfaces are already keyed by (`hudsession`).
   *
   *  WI-6363: this used to be `advSessionId`, which could never work. On the
   *  terminal path launch-su records NO adv_sessions row (psu self-registers one
   *  asynchronously once it boots), so the response carried no id at all and this
   *  callback always fired with `null` — the chat never opened. Do not "restore"
   *  the row id here: it does not exist yet at this moment.
   *
   *  `null` when the launch reported success without an id (an older operator
   *  that predates the pre-pinned owner id). */
  onLaunched?: (ownerId: string | null) => void;
  /** Move the caller to the live Sessions board after a headless launch. */
  onViewSessions?: () => void;
}

type LaunchReceipt = {
  ownerId: string | null;
  target: string;
};

/**
 * The "+ New session" control: a plan picker, a model picker, and a button —
 * reusing the exact `launchAgent` call AdvSessionsClient's own "Create new
 * session" button makes. Self-contained so it can be dropped into any header
 * (HUD board, Sessions panel, …) with no props beyond an optional
 * post-launch hook.
 */
export default function NewSessionLauncher({
  className,
  onLaunched,
  onViewSessions,
}: NewSessionLauncherProps) {
  const t = useLexicon();
  // The AdvShell-active harness slug — read directly rather than threaded as
  // a prop so this stays a drop-in control. Shared with AdvSessionsClient's
  // own picker via the same `slug` nuqs key (that param is global, not
  // owned by any one tab).
  const [activeHarnessSlug] = useQueryState('slug', parseAsString);
  const [planSlug, setPlanSlug] = useState<string | null>(null);
  const [identityRef, setIdentityRef] = useState(IDENTITY_SELECT_DEFAULT);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [launching, setLaunching] = useState(false);
  // WI-6321 — the psu-parity options. All local useState for the same reason the
  // model/plan picks are: a mid-edit draft of a session that does not exist yet,
  // not a shareable view (see the module header's nuqs-vs-useState note).
  const [fleet, setFleet] = useState(FLEET_SELECT_NONE);
  const [newFleetName, setNewFleetName] = useState('');
  const [fleetScheme, setFleetScheme] = useState('');
  const [account, setAccount] = useState<string>(ACCOUNT_SELECT_DEFAULT);
  const [contextSize, setContextSize] = useState(CONTEXT_SELECT_NATIVE);
  // P-042 — the launch posture. Local useState like its siblings: a mid-edit
  // draft of the next launch, not a shareable view.
  const [mode, setMode] = useState(NEW_SESSION_DEFAULT_MODE);
  // WI-38039: headless launches do not open a terminal, so the short-lived
  // toast cannot be the only acknowledgement. Keep a small receipt shelf in
  // this control; it is deliberately launch history, not a liveness claim —
  // the Sessions board remains authoritative for whether an agent is live.
  const [launchReceipts, setLaunchReceipts] = useState<LaunchReceipt[]>([]);

  // psu's OWN option source — see use-su-launch-options' header. Keyed to the
  // backend the picked model implies, because pool pinning is per-backend.
  const launchOptions = useSuLaunchOptions(null, modelBackend(model) ?? 'claude');
  const identityCatalog = useIdentityLaunchCatalog();
  const identityOptions = useMemo(() => buildIdentityLaunchOptions(identityCatalog),
    [identityCatalog.identities, identityCatalog.unreadable, identityCatalog.nextAfter]);
  const selectedIdentity = identityCatalog.identities.find((identity) =>
    identity.slots.some((slot) => `${slot.slot}:${identity.id}` === identityRef) ||
    (identity.slots.length === 0 && `composition:${identity.id}` === identityRef)) ?? null;
  const modelOptions = useMemo(
    () => buildModelOptions(launchOptions.ompCatalog.models),
    [launchOptions.ompCatalog.models],
  );
  const selectedOmpModel = useMemo(
    () => launchOptions.ompCatalog.models.find((entry) => entry.selector === model) ?? null,
    [launchOptions.ompCatalog.models, model],
  );
  const effortOptions = useMemo(() => buildEffortOptions(selectedOmpModel), [selectedOmpModel]);
  const fleetOptions = useMemo(
    () => buildFleetOptions(launchOptions.fleets, launchOptions.nextScheme?.name),
    [launchOptions.fleets, launchOptions.nextScheme],
  );
  const accountOptions = useMemo(
    () => buildAccountOptions(launchOptions.accounts),
    [launchOptions.accounts],
  );
  const contextOptions = useMemo(() => buildContextSizeOptions(), []);
  const modeOptions = useMemo(() => buildModeOptions(), []);
  const schemeOptions = useMemo(
    () =>
      launchOptions.schemes.map((s) => ({
        value: s.name,
        label: s.name,
        detail: s.bg,
      })),
    [launchOptions.schemes],
  );
  const creatingFleet = fleet === FLEET_SELECT_NEW;

  const planList = usePlanList({ includeArchived: true, includeLegacy: true });
  const selectedPlan = useMemo(
    () => (planList.data?.plans ?? []).find((p) => p.slug === planSlug) ?? null,
    [planSlug, planList.data],
  );
  const planOptions = useMemo(
    () =>
      buildLaunchPlanOptions(
        planList.data?.plans ?? [],
        activeHarnessSlug,
        planList.loading,
        `(no ${t('pot', { lower: true })})`,
      ),
    [planList.data, planList.loading, activeHarnessSlug, t],
  );

  const launch = useCallback(async () => {
    // P-005 (owner ask 2026-07-26): a plan is OPTIONAL. Launching with none
    // selected starts an unbound session — the plan only ever supplied launch
    // CONTEXT, never a requirement, and `launchAgent` already accepts a null
    // planSlug (it takes a null `slug` on this path too).
    if (launching) return;
    if (identityRef !== IDENTITY_SELECT_DEFAULT &&
        (!selectedIdentity || selectedIdentity.launchCompatibility?.eligible === false)) {
      toast.error('The selected identity is no longer available. Choose an identity again.');
      return;
    }
    // WI-6321: creating a fleet needs a name. Caught before the spawn so the
    // human fixes it here rather than getting a terminal that opens and dies.
    if (creatingFleet && !newFleetName.trim()) {
      toast.error('Name the new fleet, or pick "No fleet".');
      return;
    }
    // P-008: effort rides on the model spec as "<model>:<effort>". The shared
    // composer THROWS on effort-without-model (psu has no standalone effort
    // flag). Surfacing that is the point — the old private copy dropped the
    // effort silently, so the session launched at the default and nobody knew.
    let chosenModel: string | null;
    try {
      chosenModel = composeModelSpec(model, effort);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Invalid model/effort combination.');
      return;
    }
    setLaunching(true);
    try {
      const label = selectedPlan
        ? selectedPlan.title?.trim() || selectedPlan.slug
        : selectedIdentity ? `${selectedIdentity.id} session` : 'su session';
      // WI-6321 (owner ask 2026-07-27): the toast used to read `Agent launched for
      // <label>`, and with a plan selected `label` is the plan TITLE — so it rendered as
      // "Agent launched for Arrow-format sync reads, then an mmap'd Arrow read cache."
      // and read like a garbled sentence rather than a plan name. The owner asked what it
      // meant. Name the KIND of thing the label is; quote it so a long descriptive title
      // is visibly a title. `label` itself still goes to launchAgent unchanged.
      const target = selectedPlan ? `on plan “${label}”` : '(su session, no plan)';
      const result = await launchAgent({
        slug: null,
        planSlug: selectedPlan?.slug ?? null,
        stack: selectedIdentity ? [identityRef] : null,
        selectedIdentityRevision: selectedIdentity?.sourceRevision ?? null,
        label,
        model: chosenModel,
        // The model picker offers the WHOLE CLOUD_MODEL_MENU, which spans backends — it
        // even tags each row "claude CLI" / "codex CLI". But this call used to send no
        // `agent`, so launch-su fell back to the configured default (claude) and psu
        // refused the pairing outright:
        //   psu: model `sol` belongs to the `codex` backend, but this launch requested
        //        `--agent=claude`. Pass `--agent=codex`, or omit `--agent` …
        // psu prints that and exits — with status 0, before it records its adv_sessions
        // row. So the terminal window opened, flashed one line and closed, the launch left
        // no trace anywhere, AND the zero exit meant the caller still showed a SUCCESS
        // toast. Picking any of sol / luna / terra could therefore never work.
        // The menu already knows each model's backend; send it (owner bug 2026-07-27).
        agent: modelBackend(model),
        // WI-6321 — psu parity. `fleet` JOINS by slug; `fleetName` CREATES (the
        // server slugifies + allocates the row, so the GUI never invents a slug).
        fleet: creatingFleet || fleet === FLEET_SELECT_NONE ? null : fleet,
        fleetName: creatingFleet ? newFleetName.trim() : null,
        fleetScheme: creatingFleet ? fleetScheme.trim() || null : null,
        // ALWAYS sent: a psu launch with no --account opens an interactive
        // picker, which would hang a GUI-spawned terminal waiting for a human.
        account: account || ACCOUNT_SELECT_DEFAULT,
        contextSize:
          contextSize === CONTEXT_SELECT_NATIVE ? undefined : (contextSize as 'trimmed'),
        // P-042 / D-067 — the launch posture. New sessions default to AUTO because
        // this control is always headless; an inert headless session has no
        // interactive terminal or loop source. "Interactive" sends null, which is
        // byte-identical to a pre-feature launch and remains an explicit opt-out.
        // launch-su maps the rest onto
        // psu's argv and bootstrap-su writes the durable agent_modes row, so a
        // session launched in DRAIN is ALREADY in DRAIN on turn 1 — no one has
        // to type it, and it survives compaction.
        mode: mode === MODE_SELECT_NONE ? null : mode,
        // WI-37871 — NO console window, unconditionally. See
        // OWNER_LAUNCH_HEADLESS for the directive and why this is a flat
        // constant rather than a toggle or a per-circumstance branch.
        headless: OWNER_LAUNCH_HEADLESS,
      });
      if (result.ok && result.warning) {
        // EI-18696184925888288: launch-su's spawn call succeeded but the
        // terminal process exited almost immediately — a likely silent
        // no-op. Say so instead of a flat success toast.
        toast.warning(
          `Agent launch ${target}${chosenModel ? ` (${chosenModel})` : ''} may not have opened a window.`,
          { description: result.warning, duration: 8000 },
        );
        setLaunchReceipts((previous) => [
          { ownerId: result.ownerId ?? null, target },
          ...previous,
        ].slice(0, 5));
        onLaunched?.(result.ownerId ?? null);
      } else if (result.ok) {
        toast.success(
          `Agent launched ${target}${chosenModel ? ` (${chosenModel})` : ''}.`,
          { duration: 3000 },
        );
        setLaunchReceipts((previous) => [
          { ownerId: result.ownerId ?? null, target },
          ...previous,
        ].slice(0, 5));
        // A launch that CREATED a fleet added a row to the very list this
        // picker renders — re-read it so the new fleet is joinable straight
        // away, and drop back to it rather than leaving the create row armed
        // (which would silently create a second fleet on the next launch).
        if (creatingFleet) {
          launchOptions.refresh();
          setFleet(FLEET_SELECT_NONE);
          setNewFleetName('');
          setFleetScheme('');
        }
        onLaunched?.(result.ownerId ?? null);
      } else if (result.installCmd) {
        toast.error(`${result.error ?? 'OMP launch prerequisites are missing.'} Run: ${result.installCmd}`);
      } else {
        toast.error(`Launch failed: ${result.error ?? 'unknown error'}`);
      }
    } finally {
      setLaunching(false);
    }
  }, [
    model,
    effort,
    launching,
    selectedPlan,
    identityRef,
    selectedIdentity,
    onLaunched,
    fleet,
    creatingFleet,
    newFleetName,
    fleetScheme,
    account,
    contextSize,
    launchOptions,
  ]);

  return (
    <div
      className={`pc-new-session-launcher${className ? ` ${className}` : ''}`}
      aria-label="Launch a new agent session"
    >
      {/* Each box shows its DEFAULT as placeholder text (owner ask
          2026-07-26), which is what `emptyValue` buys: while the value is the
          sentinel, the field renders empty with the prompt showing rather than
          echoing the sentinel row's label back as if it were typed. */}
      <Combobox
        triggerClassName="pc-new-session-launcher__select pc-new-session-launcher__select--identity"
        value={identityRef}
        onChange={(value) => {
          if (value === IDENTITY_SELECT_MORE) identityCatalog.loadMore();
          else setIdentityRef(value);
        }}
        ariaLabel="Identity for new session"
        placeholder="SU"
        emptyLabel="No identities match"
        options={identityOptions}
      />
      {identityCatalog.error && <span role="alert">Installed identities unavailable: {identityCatalog.error}</span>}
      <Combobox
        triggerClassName="pc-new-session-launcher__select pc-new-session-launcher__select--plan"
        value={planSlug ?? PLAN_SELECT_PLACEHOLDER}
        emptyValue={PLAN_SELECT_PLACEHOLDER}
        onChange={(value) => setPlanSlug(value === PLAN_SELECT_PLACEHOLDER ? null : value)}
        disabled={planList.loading}
        ariaLabel="Plan for new session"
        placeholder={planList.loading ? 'Loading plans…' : 'Select plan…'}
        emptyLabel="No plans match"
        options={planOptions}
      />
      {/* Owner ask 2026-07-27 (restated): all four controls — plan, model,
          effort, + New session — belong together on ONE row, and that row is
          .hud__launchrow, the launcher's own row in the HUD header (it sat below
          the tab strip when first split out, and moved ABOVE the strip later the
          same day). An earlier pass split the controls across two lines INSIDE the
          launcher, which was a misreading of "the row below": the row in question
          was the tab strip's, not the plan picker's. One line. */}
      <>
        <Combobox
          triggerClassName="pc-new-session-launcher__select pc-new-session-launcher__select--model"
          value={model || MODEL_SELECT_DEFAULT}
          emptyValue={MODEL_SELECT_DEFAULT}
          onChange={(value) => {
            setModel(value === MODEL_SELECT_DEFAULT ? '' : value);
            setEffort('');
          }}
          ariaLabel="Model for new session"
          placeholder="Default"
          emptyLabel="No models match"
          options={modelOptions}
        />
        <Combobox
          triggerClassName="pc-new-session-launcher__select pc-new-session-launcher__select--effort"
          value={effort || EFFORT_SELECT_DEFAULT}
          emptyValue={EFFORT_SELECT_DEFAULT}
          onChange={(value) => setEffort(value === EFFORT_SELECT_DEFAULT ? '' : value)}
          ariaLabel="Effort level for new session"
          placeholder="Default effort"
          emptyLabel="No effort levels match"
          options={effortOptions}
        />
        {/* WI-6321 (owner ask 2026-07-27): "the new session panel should ahve all
            the same options as the psu utility. i.e. fleet selection and the
            abiltiy to create a new fleet and choose the color, and the gateway
            pinning and anything else I may have forgotten about in the psu launch
            menu(s)". Fleet / account / context-size are the three psu pickers the
            GUI could not express; their option lists come from psu's own source
            (useSuLaunchOptions), not a parallel list. */}
        <Combobox
          triggerClassName="pc-new-session-launcher__select pc-new-session-launcher__select--fleet"
          value={fleet}
          emptyValue={FLEET_SELECT_NONE}
          onChange={(value) => setFleet(value)}
          ariaLabel="Fleet for new session"
          placeholder={launchOptions.loading ? 'Loading fleets…' : 'No fleet'}
          emptyLabel="No fleets match"
          options={fleetOptions}
        />
        {/* Only while creating: the name, and the colour psu's own scheme picker
            offers. Rendered inline rather than in a modal so the whole launch
            stays one row, per the owner's one-line constraint above. */}
        {creatingFleet ? (
          <>
            <input
              className="pc-new-session-launcher__input"
              type="text"
              value={newFleetName}
              onChange={(e) => setNewFleetName(e.target.value)}
              placeholder="New fleet name"
              aria-label="New fleet name"
            />
            <Combobox
              triggerClassName="pc-new-session-launcher__select pc-new-session-launcher__select--scheme"
              value={fleetScheme || (launchOptions.nextScheme?.name ?? '')}
              emptyValue=""
              onChange={(value) => setFleetScheme(value)}
              ariaLabel="Colour for the new fleet"
              placeholder={launchOptions.nextScheme?.name ?? 'Colour'}
              emptyLabel="No colours match"
              options={schemeOptions}
            />
          </>
        ) : null}
        <Combobox
          triggerClassName="pc-new-session-launcher__select pc-new-session-launcher__select--account"
          value={account}
          emptyValue={ACCOUNT_SELECT_DEFAULT}
          onChange={(value) => setAccount(value)}
          ariaLabel="Account for new session"
          placeholder="Default account"
          emptyLabel="No accounts match"
          options={accountOptions}
        />
        <Combobox
          triggerClassName="pc-new-session-launcher__select pc-new-session-launcher__select--context"
          value={contextSize}
          emptyValue={CONTEXT_SELECT_NATIVE}
          onChange={(value) => setContextSize(value)}
          ariaLabel="Context size for new session"
          placeholder="Native context"
          emptyLabel="No context sizes match"
          options={contextOptions}
        />
        <Combobox
          triggerClassName="pc-new-session-launcher__select pc-new-session-launcher__select--mode"
          value={mode}
          emptyValue={MODE_SELECT_NONE}
          onChange={(value) => setMode(value)}
          ariaLabel="Mode for new session"
          placeholder="Interactive"
          emptyLabel="No modes match"
          options={modeOptions}
        />
        <Button
          variant="primary"
          size="sm"
          className="pc-new-session-launcher__btn"
          onClick={() => void launch()}
          disabled={launching}
        >
          {launching ? 'Launching…' : '+ New session'}
        </Button>
      </>
      {launchReceipts.length > 0 ? (
        <div
          className="pc-new-session-launcher__receipt"
          role="status"
          aria-live="polite"
          data-testid="new-session-launch-status"
        >
          <strong>Headless launch recorded</strong>
          <span>
            {launchReceipts.length === 1
              ? `Agent launched ${launchReceipts[0].target}.`
              : `${launchReceipts.length} headless agents launched from this control.`}
          </span>
          <span>
            No console window is opened. Use Sessions to inspect live status and stop an agent.
          </span>
          {launchReceipts[0].ownerId ? (
            <span className="pc-new-session-launcher__receipt-id">
              Latest owner: {launchReceipts[0].ownerId}
            </span>
          ) : (
            <span className="pc-new-session-launcher__receipt-id">
              The owner id is still starting; Sessions will show it when registered.
            </span>
          )}
          {onViewSessions ? (
            <Button
              variant="ghost"
              size="mini"
              className="pc-new-session-launcher__receipt-action"
              onClick={onViewSessions}
            >
              View sessions
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
