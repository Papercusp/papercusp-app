/**
 * Mode registry — the single source of truth for official session modes
 * (modes-and-intake-ux-2026-07-05 P-006/P-008/P-009; owner directive 2026-07-05).
 *
 * Modes were prompt prose; this makes them DATA. Everything derives from here:
 *   - mode:list / mode:get / mode:set read this registry;
 *   - the one-line-per-mode INDEX for always-present prompts is
 *     modeIndexMarkdown() (P-008: the initial prompt carries ONLY the index);
 *   - the FULL binding contract is `contract`, injected on activation
 *     (mode:set returns it; coord:orient re-injects active contracts each
 *     wake — the checkpoint re-injection pattern), so a mode's depth costs
 *     context only while you are IN it.
 *
 * AXES (D-006, corrected by owner 2026-07-05): same-axis modes exclude each
 * other — mode:set AUTO-SWITCHES (replaces the same-axis incumbent, auditing
 * the displacement); everything else STACKS. The ONLY exclusive family is
 * autonomy (auto vs cold-auto — one dial, two positions). Ideate, drain, and
 * grade are overlays, each with its own axis key, stackable with everything —
 * including each other (owner's example: ideate on why the drain isn't
 * working). Absence of a row on an axis = that axis's default posture
 * (manual / no-overlay), deliberately NOT stored.
 */
import { BUILTIN_MODE_COMPONENTS } from '@papercusp/orchestrator/mode-catalog';

export type ModeAxis = 'autonomy' | 'overlay';

export interface ModeDef {
  /** Stable id — what mode:set takes and agent_modes.mode stores. */
  id: string;
  axis: ModeAxis;
  /**
   * Modes this one IMPLIES — entering it enters these too (D-003).
   *
   * This is a WRITE instruction, not a note: `setMode` applies the closure
   * itself, so `mode:set { mode:'goal' }` leaves the agent holding goal + auto +
   * ideate whether or not anyone remembered a follow-up call. It is also the
   * source of `modeImpliesAutonomy` — an overlay is autonomous exactly when it
   * implies a mode on the `autonomy` axis.
   *
   * DERIVING BOTH FROM ONE FIELD IS THE POINT. Until 2026-08-10 these were two
   * declarations: a boolean `impliesAutonomy` that guards read, and a sentence
   * in the contract telling the agent to "also mode:set auto". They could
   * disagree, and they did — every guard counted a GOAL session as autonomous
   * while its autonomy axis was empty, because the only thing that ever wrote
   * the row was an agent remembering to, across weeks and compactions. One
   * field cannot drift from itself.
   *
   * Read the autonomy question through `modeImpliesAutonomy`, never by axis
   * alone (goal-mode-2026-08-07 P-012); read the closure through
   * `resolveImpliedModes`, never by walking this field (it is transitive).
   */
  implies?: readonly string[];
  /**
   * This mode is ABOUT something, and is meaningless without knowing what —
   * so entering it must resolve an `agent_modes.subject` (EI-20015592992797890).
   *
   * Read it through `modeRequiresSubject`, never by matching the mode id, for
   * the reason the sibling flag above exists: the property is what defines
   * membership, and a guard anchored to a spelling silently stops covering the
   * next mode that joins the set.
   *
   * WHY IT IS ENFORCED AT THE DOOR. `subject` is what every downstream consumer
   * joins on — `work_items._create-core` stamps `work_items.goal_id` FROM it and
   * the goal stop attributes sessions BY it — so an unset subject does not fail
   * loudly, it silently zeroes both. A goal-mode session that cannot name its
   * goal defeats the consumers rather than erroring for them.
   */
  requiresSubject?: boolean;
  /**
   * This mode can be requested AT LAUNCH, before the session exists — psu has a
   * flag for it and `bootstrap-su` registers it durably on the way up.
   *
   * Read it through `isLaunchableMode` / `LAUNCHABLE_MODE_IDS`, never by
   * matching ids, for the same reason as the two flags above: the property
   * defines the set, so a guard anchored to a spelling silently stops covering
   * the next mode that joins it.
   *
   * WHY THIS FLAG EXISTS (retire-mug-kettle-su-only-2026-08-09 D-067). The
   * launch-time mode vocabulary was hardcoded in TWO places that cannot see
   * each other — `psu-launcher.mjs` (argv parsing) and `bootstrap-su.ts`
   * (body validation) — and adding the GUI path was about to make it FOUR.
   * Four copies of a list that must agree is a drift generator, and the
   * failure is silent in the worst direction: a GUI offering a mode the
   * launcher refuses produces a terminal that flashes one error line and
   * closes, with a SUCCESS toast (the exact shape of the model/agent-pairing
   * bug at NewSessionLauncher.tsx:467-477).
   *
   * NOT launchable, and deliberately so: `goal` requires a subject and has its
   * own atomic surface (GoalComposer); `ideate` /
   * `cold-auto` have no psu flag, so offering them would promise something the
   * launcher cannot execute.
   *
   * ⚠ AUTO is launchable via psu's BOOLEAN `--auto`, not via `--mode=auto`
   * (which bootstrap-su rejects with a 400). Callers mapping this set onto
   * argv must special-case it — see `launch-su.ts`.
   */
  launchable?: boolean;
  title: string;
  /** The one-liner for the always-present index (P-008). Keep it ONE line. */
  oneLiner: string;
  /** The full binding contract, injected on activation. Markdown. */
  contract: string;
}

/** Compatibility API over trusted declarations and existing enforcement.
 * The allowlist names implemented host policies, never their activation data. */
const SUPPORTED_MODE_POLICIES = new Set(['auto', 'ideate', 'drain', 'grade', 'goal', 'test', 'audit']);
export const MODES: readonly ModeDef[] = BUILTIN_MODE_COMPONENTS.flatMap<ModeDef>((component) => {
  if (!SUPPORTED_MODE_POLICIES.has(component.policyRef) || component.id !== component.policyRef) {
    throw new Error(`built-in mode ${component.id} references unsupported host policy ${component.policyRef}`);
  }
  const declarations = [
    { ...component, contract: component.definitionText },
    ...component.aliases.map((alias) => {
      // cold-auto is the existing AUTO carry mode, with its existing code-backed
      // lifecycle. A new name needs runtime support before it may be advertised.
      if (component.policyRef !== 'auto' || alias.id !== 'cold-auto') {
        throw new Error(`mode alias ${alias.id} has no host carry policy`);
      }
      const start = component.definitionText.indexOf(alias.definitionHeading);
      if (start < 0) throw new Error(`mode alias ${alias.id} has no declared definition heading`);
      return { ...alias, contract: component.definitionText.slice(start).trimEnd() };
    }),
  ];
  return declarations.map((declaration) => ({
    id: declaration.id,
    axis: component.slot === 'autonomy' ? 'autonomy' : 'overlay',
    // Preserve the public optional-field shape for existing discovery clients.
    ...(declaration.implies.length ? { implies: declaration.implies } : {}),
    ...(declaration.requiresSubject ? { requiresSubject: true } : {}),
    ...(declaration.launchable ? { launchable: true } : {}),
    title: declaration.title,
    oneLiner: declaration.oneLiner,
    contract: declaration.contract,
  }));
});
/** Look up a mode by id (case-insensitive). */
export function modeById(id: string): ModeDef | null {
  const key = id.trim().toLowerCase();
  return MODES.find((m) => m.id === key) ?? null;
}

/**
 * The agent_modes.axis_key for a mode: exclusive axes use the axis name
 * (one row per axis ⇒ same-axis auto-switch via PK upsert); each overlay
 * gets its own key ⇒ overlays stack.
 */
export function axisKeyFor(def: ModeDef): string {
  return def.axis === 'overlay' ? `overlay:${def.id}` : def.axis;
}

/**
 * Does this mode id put the session in an AUTONOMY posture — i.e. one that is
 * meant to outlive an owner sitting there?
 *
 * Two ways to qualify, and BOTH must be counted: a mode on the `autonomy` axis
 * (auto, cold-auto) qualifies inherently, and an overlay may IMPLY one (drain,
 * goal — via `implies`). Deriving it here is not tidiness — this question was
 * hardcoded at six call sites and three of them had already drifted apart, each
 * omitting `cold-auto` with no comment saying why. The unguarded-halt sweep was
 * one of them, so the single most autonomy-dependent posture in the system was
 * the one it did not sweep. A registry-derived predicate means a new autonomous
 * mode is counted everywhere the moment its row lands, instead of depending on
 * someone finding all six lists (goal-mode-2026-08-07 P-012).
 *
 * D-003 tightened the second leg: it reads the SAME `implies` field the cascade
 * writes from, so "guards treat this session as autonomous" and "this session
 * actually holds an autonomy row" can no longer be separately true.
 */
export function modeImpliesAutonomy(id: string): boolean {
  const def = modeById(id);
  if (!def) return false;
  if (def.axis === 'autonomy') return true;
  return resolveImpliedModes(id).some((m) => modeById(m)?.axis === 'autonomy');
}

/**
 * The TRANSITIVE closure of `implies` for a mode, excluding the mode itself —
 * the exact set `setMode` enters alongside it (D-003).
 *
 * Transitive because the alternative is a trap: a mode implying an overlay that
 * itself implies `auto` would enter the overlay and silently skip the autonomy
 * row, which is precisely the half-applied state this whole mechanism exists to
 * make impossible. Cycle-safe (a `seen` set) so a mistaken A→B→A pair degrades
 * to a finite set rather than hanging every mode write in the system; the
 * registry test asserts no cycle exists in the first place.
 *
 * Order is breadth-first from the declaration, which is the order the modes are
 * applied and reported in — so a caller reading the result sees `auto` before
 * `ideate` for GOAL, matching how the contract states it. Unknown ids are
 * dropped rather than thrown: a typo must not be able to fail an otherwise-valid
 * mode change, and the registry test is what catches it.
 */
export function resolveImpliedModes(id: string): readonly string[] {
  const root = modeById(id);
  if (!root) return [];
  const seen = new Set<string>([root.id]);
  const out: string[] = [];
  const queue = [...(root.implies ?? [])];
  while (queue.length) {
    const next = modeById(queue.shift() as string);
    if (!next || seen.has(next.id)) continue;
    seen.add(next.id);
    out.push(next.id);
    queue.push(...(next.implies ?? []));
  }
  return out;
}

/**
 * Does entering this mode require an `agent_modes.subject`? — the read half of
 * `ModeDef.requiresSubject`, and the ONE place the question is answered.
 *
 * Deliberately mirrors `modeImpliesAutonomy` above: an unknown id is `false`,
 * so a caller that cannot resolve the mode never blocks on a requirement it
 * could not verify.
 */
export function modeRequiresSubject(id: string): boolean {
  const def = modeById(id);
  if (!def) return false;
  return def.requiresSubject === true;
}

/** Every registered mode id that requires a subject. */
export function subjectRequiringModeIds(): readonly string[] {
  return MODES.filter((m) => m.requiresSubject === true).map((m) => m.id);
}

/**
 * The modes a caller may request AT LAUNCH — see `ModeDef.launchable`.
 *
 * This is the ONE list. `launch-su` validates against it and the GUI picker
 * renders from it, so a mode becoming launchable is a one-line registry change
 * that reaches both, and a mode that is NOT launchable cannot be offered by a
 * surface that forgot to check.
 */
export const LAUNCHABLE_MODE_IDS: readonly string[] = MODES.filter((m) => m.launchable === true).map((m) => m.id);

/** Whether `id` may be requested at launch. The membership test — never match ids. */
export function isLaunchableMode(id: string): boolean {
  const def = modeById(id);
  if (!def) return false;
  return def.launchable === true;
}

/** The launchable modes as full defs, in registry order — for rendering a picker. */
export function launchableModes(): readonly ModeDef[] {
  return MODES.filter((m) => m.launchable === true);
}

/** Every registered mode id that implies an autonomy posture. */
export function autonomousModeIds(): readonly string[] {
  return MODES.filter((m) => modeImpliesAutonomy(m.id)).map((m) => m.id);
}

/**
 * ── UI display helpers ──────────────────────────────────────────────────────
 *
 * The GUI shows standing modes as chips (the HUD session card, the Sessions
 * roster). Both surfaces used to spell their own label + hover text, so only
 * the three modes someone remembered to write ever got an explanation —
 * `cold-auto` and `grade` fell through to a bare "Standing mode: grade".
 *
 * These derive BOTH from this registry, so a new mode is explained in every
 * chip the moment its row lands here. They are pure string functions over pure
 * data (this module imports nothing), which is what makes them safe to import
 * from the SPA bundle — the generated catalog is plain data with no PG or node builtins.
 */

/** Short chip label for a mode id: `cold-auto` → `COLD AUTO`. */
export function modeChipLabel(id: string): string {
  return (modeById(id)?.id ?? id).toUpperCase().replace(/-/g, ' ');
}

/**
 * Hover text for a mode chip: what the mode MEANS, then who armed it.
 *
 * Provenance is the half a human actually needs on a board: "this agent is in
 * AUTO because I put it there" and "this agent put ITSELF in AUTO" call for
 * different reactions, and `agent_modes.owner_directed` already records which.
 */
export function modeChipTitle(id: string, opts?: { ownerDirected?: boolean }): string {
  const def = modeById(id);
  // Newline, not another dash: every registry title already carries its own
  // em-dash ("AUTO — act, don't ask"), so joining with one read as
  // "AUTO — act, don't ask — act on your own judgment…" on the live chip.
  const meaning = def ? `${def.title}\n${def.oneLiner}` : `Standing mode: ${id}`;
  if (opts?.ownerDirected === undefined) return meaning;
  return `${meaning}\n\n${
    opts.ownerDirected
      ? 'Set by the owner — peers cannot override it.'
      : 'The agent set this itself (or a peer did) — an owner instruction overrides it.'
  }`;
}

/** The one-line-per-mode index (P-008) — what always-present prompts carry. */
export function modeIndexMarkdown(): string {
  const lines = MODES.map((m) => `- **${m.id}** (${m.axis}): ${m.oneLiner}`);
  return [
    '### Modes — index (details load when a mode is set)',
    ...lines,
    '_Same-axis modes exclude each other (setting one auto-switches); cross-axis modes stack. mode:set { mode, reason } to enter; { enabled: false } to exit; mode:get to see anyone’s._',
  ].join('\n');
}
