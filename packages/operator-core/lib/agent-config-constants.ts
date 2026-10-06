/**
 * Client-safe agent-backend / surface constants + types.
 *
 * Why this file exists: `agent-config.ts` imports `node:fs/promises` and the
 * PG state layer (`operator-state-pg` → `db-encryption` → `postgres`) at module
 * scope. Pulling ANY export from there — even a plain string-tuple const like
 * `SURFACE_KEYS` — drags that whole server subtree into the consumer's chunk.
 * The operator-vite renderer has no Node built-ins, so that leak caused
 * "homedir is not a function" / postgres-in-the-browser crashes.
 *
 * Extracted so client modules (e.g. `app/settings/agent/page.tsx`) can import
 * these constants/types without triggering the cascade. `agent-config.ts`
 * re-exports them for backward compat. Mirrors the `workspace-id-constant.ts`
 * pattern. Keep this module free of any Node/server imports.
 */

import type {
  BulkAutomationMode,
  BulkConfidence,
} from './attention/bulk-dispositions';
import {
  BULK_AUTOMATION_MODES,
  BULK_CONFIDENCE_LEVELS,
  DEFAULT_BULK_AUTOMATION_POLICY,
  isBulkAutomationMode,
  isBulkConfidence,
} from './attention/bulk-dispositions';

/**
 * Canonical subprocess-spawn backend set (operator side). Kept in sync with the
 * orchestrator's `AGENT_BACKENDS` (`@papercusp/orchestrator` types.ts) and the
 * spawn-capable subset of `@papercusp/papercusp-shared` chat-stream's
 * `AgentBackend` (which additionally has `anthropic-direct`, a stateless brains-only
 * HTTP backend — not a subprocess). The submodule boundary rules out a single
 * literal import; `agent-backend-sync.test.ts` guards the three against drift.
 */
export const AGENT_BACKENDS = ['claude-code', 'omp', 'codex'] as const;
export type AgentBackend = (typeof AGENT_BACKENDS)[number];

/**
 * The in-app brain surfaces that support a per-surface backend override. Keep in
 * sync with the call sites that pass `surfaceBackend('<key>')` and the
 * /settings/agent per-surface table.
 */
export const SURFACE_KEYS = [
  'operator',
  'scanner',
  'delegate',
  'oracle',
  'architect',
  'brainstorm',
  'agent_chats',
  'plans',
  // The hosted web portal's own brain surface — which agent/model answers
  // "Ask Papercup" from the portal's universal bar. It is a real registry
  // member rather than a passthrough BECAUSE the /agent-config POST leg is
  // strict: an unknown surface key is rejected 422, so a portal settings page
  // could not persist this preference at all until the key exists here
  // (portal-universal-bar-and-agent-roster-2026-08-31 P-015 → P-016).
  'portal',
] as const;
export type SurfaceKey = (typeof SURFACE_KEYS)[number];

/**
 * The committed public-portal baseline. The portal is browser-reachable and
 * must never inherit whichever model/backend the operator process happens to
 * boot with: that would make quality, cost, and even model compatibility drift
 * across CLI upgrades. A stored `surfaceModels.portal` + `backends.portal`
 * pair may override this baseline, but the runtime uses these two values
 * together when neither override exists and refuses a half-configured pair.
 *
 * `sonnet[1m]:high` matches the committed Papercup role floor in
 * orchestrator/role-models.ts. Keep the model and backend in one object so a
 * caller cannot import or update one without making the pairing visible.
 */
export const PUBLIC_PORTAL_AGENT_BASELINE = {
  model: 'sonnet[1m]:high',
  backend: 'claude-code',
} as const satisfies { model: string; backend: AgentBackend };

/**
 * The chat `papercup` role's QUICK-model pin (papercup-chat-one-component-one-
 * contract-2026-09-06 P-005, D-007 §3). The Papercup chat is a quick model with
 * the deep-delegation tool in its toolset; hard questions route to a
 * papercup-deep session. Testing pin per the owner (2026-09-06, confirmed
 * verbatim "gpt-5.6-luna:low (codex)"): the luna tier on the codex backend at
 * LOW effort. The backend is PART of the pin — a bare luna id handed to a
 * claude-CLI-backed role hard-downs it (WI-4623) — so, like the portal baseline
 * above, model and backend live in one object and are consumed together
 * (lib/papercup/papercup-chat-model.ts). Overridable per the usual ladder:
 * PAPERCUP_CHAT_MODEL / PAPERCUP_CHAT_BACKEND env, then agent-config
 * models['papercup'] / roleBackends['papercup'].
 */
export const PAPERCUP_CHAT_MODEL_PIN = {
  model: 'gpt-5.6-luna:low',
  backend: 'codex',
} as const satisfies { model: string; backend: AgentBackend };

/**
 * Where the chat `papercup` role goes for its retry when the backend it ran on
 * reports that its ACCOUNT is dead for this turn — a usage cap or a revoked /
 * expired credential (WI-10003608). Measured on hosted workspace avi-test
 * 2026-09-26..28: the codex account capped until Oct 3 and the Claude copy 401'd,
 * and because the retry re-ran the SAME backend, every portal turn died twice.
 *
 * Keyed by the backend that failed; each alternate is a full model+backend pair
 * for the same reason the pin is (a bare model id on the wrong CLI hard-downs the
 * role — WI-4623). `omp` has no entry: it routes to codex or anthropic
 * internally, so there is no alternate that is known to use a different account.
 * `sonnet:low` is the quick Claude tier the avi-test hand mitigation ran on.
 */
export const PAPERCUP_CHAT_FAILOVER: Readonly<
  Partial<Record<AgentBackend, Readonly<{ model: string; backend: AgentBackend }>>>
> = {
  codex: { model: 'sonnet:low', backend: 'claude-code' },
  'claude-code': { model: PAPERCUP_CHAT_MODEL_PIN.model, backend: PAPERCUP_CHAT_MODEL_PIN.backend },
};

// ── Model tiers (queen-model-tier-selection-2026-06-11) ──────────────────────

/** Reasoning-effort levels a model spec's `:<effort>` suffix may carry —
    mirrors the `claude --effort` flag values (same set as
    harness-invoke-once's EFFORT_LEVELS; client-safe copy lives here). */
export const MODEL_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ModelEffort = (typeof MODEL_EFFORT_LEVELS)[number];

/**
 * One entry in the user-defined model-tier menu. `spec` is the same
 * `<modelId>[:<effort>]` shape `AGENT_MODELS` values take, so it flows through
 * the existing parsers (applyRoleModel / resolveModel) unchanged.
 */
export interface ModelTier {
  /** Tier name the queen picks by — short, lowercase (e.g. 'standard'). */
  name: string;
  /** Model spec this tier resolves to (e.g. 'opus:high'). */
  spec: string;
  /** Backend this tier runs on. Absent = inherit the host's agent command
      (the usual case). When set and different from the host backend, the
      spawn's base command is swapped to this backend's default
      (DEFAULT_BACKEND_CMDS) before the model spec is applied — so a tier can
      be e.g. quick-on-omp while deep stays on claude. */
  backend?: AgentBackend;
  /** USER-AUTHORED guidance: when the queen should pick this tier (one
      line, e.g. 'ambiguous or architectural work; repeat failures'). Injected
      verbatim into the queen's launch prompt as her live tier menu — this is
      the owner's instruction channel for per-tier judgment. */
  when?: string;
  /** Backend-catalog context window captured for specs whose launch syntax
      cannot encode the window (notably provider-qualified OMP selectors).
      It is a validated snapshot tied to `spec`, not a second model id. */
  contextWindow?: number;
  /** Soft compaction limit (tokens) for sessions spawned on this tier — the
      context size at which the agent should reach a clean stopping point and
      self-compact (agent-managed-compaction-2026-07-01). Absent = the
      model-derived default, `defaultCompactionLimitForSpec(spec)`
      (context-trimming-tiers D-001/D-002). That default is also the CEILING:
      agents may overshoot the soft limit by ~20%, so `parseTiers` clamps a
      stored value to keep `limit × 1.2 ≤ window − margin`. */
  compactionLimit?: number;
}

/** Default agent command per backend — used when a per-tier backend swap
    needs a base command for a backend the host's AGENT_CMD doesn't drive.
    Mirrors the /settings/agent placeholders + run.sh defaults. */
export const DEFAULT_BACKEND_CMDS: Record<AgentBackend, string> = {
  'claude-code': 'claude -p',
  omp: 'omp -p',
  codex: 'codex exec',
};

/**
 * The default tier menu when the user hasn't defined one — ordered WEAKEST →
 * STRONGEST (the order IS the strength ranking the floor/ceiling clamp uses).
 * Mirrors the fleet's implicit haiku/sonnet/opus tiering (ROLE_MODEL_DEFAULTS).
 * The `when` lines are the default placement rubric — the user's own menu
 * replaces them wholesale.
 *
 * The sonnet/opus specs carry `[1m]` AT THE SOURCE (owner directive
 * 2026-07-02): every spawn path — psu-normalized or a direct `claude --model
 * <spec>` exec (orchestrator invoke) — then launches the 1M auto-compact
 * window. A BARE `sonnet`/`opus` spec runs a 200k auto-compact window in CC
 * 2.1.198 (live-verified via /context 2026-07-02 — auto-fires ~167k), which is
 * what killed a wave of sonnet fleet members; do not strip the marker.
 */
export const DEFAULT_MODEL_TIERS: readonly ModelTier[] = [
  { name: 'quick', spec: 'haiku', when: 'trivial / mechanical work (renames, single-file fixes, mechanical sweeps)' },
  {
    name: 'standard',
    spec: 'sonnet[1m]',
    when: 'spec-bounded normal features and bugs — the usual pick; omitting tier is equivalent',
  },
  {
    name: 'deep',
    spec: 'opus[1m]:high',
    when: 'ambiguous or architectural work, cross-cutting changes, repeat failures on a lower tier',
  },
  // ⚠ HISTORICAL, NOT the current floor (WI-4495-adjacent staleness caught while
  // resolving WI-4334, 2026-07-26): this tier was ADDED as the committed floor for
  // the autonomous-loop/gym judgment roles (mug/cup/kettle/queen/bee/overwatch/
  // sentinel/papercup/blender/judge/scanner — autonomous-loop-prod-audit-2026-07-02
  // P-020, WI-4640). That migration was REVERTED per owner decision WI-4623
  // (2026-07-16): those roles' committed floor in role-models.ts ROLE_MODEL_DEFAULTS
  // is now the bare `sonnet[1m]:high` (Claude, via the gateway), NOT this tier — the
  // luna floor broke production at runtime (a claude-CLI-backed role handed
  // `--model gpt-5.6-luna` hard-downed; kettle@papercusp 2026-07-16). See
  // role-models.ts's own history comment for the full account.
  //
  // The `luna` entry is kept in this MENU (not deleted) only so it stays a valid,
  // rankable `tierCeilings`/`modelOverrides` OPTION for anyone who deliberately opts
  // a role back onto it — deleting it would silently drop `tierRankOfSpec`/
  // `roleHomeTier` ranking for any live override still pointing at it (the
  // EI-7/EI-286 class of bug this menu exists to prevent: an unranked spec's
  // never-downgrade floor-clamp disappears, letting a pick fall all the way to
  // `quick`/haiku with no clamp). Do NOT read its presence here as "gpt-5.6 Luna is
  // the active judgment floor" — it isn't, unless a role's OWN committed default
  // (role-models.ts) or a live override says so. Bare `gpt-5.6-luna:high` (no `[1m]`
  // marker) — that marker is a Claude/CC auto-compact-window signal
  // (`modelWindowForSpec`) with no meaning on the codex backend this tier runs.
  {
    name: 'luna',
    spec: 'gpt-5.6-luna:high',
    backend: 'codex',
    when: 'NOT the current autonomous-loop floor (reverted WI-4623) — an available opt-BACK-in option only; do not pick this for a pipeline execution role',
  },
  {
    name: 'max',
    spec: 'opus[1m]:xhigh',
    when: 'security-sensitive, migration, or deploy-adjacent work where a mistake is expensive',
  },
] as const;

/** Validate a `<modelId>[:<effort>]` spec string (loose on the model id —
    provider ids vary — strict on the effort suffix). */
export function isValidModelSpec(spec: string): boolean {
  if (!spec || /\s/.test(spec)) return false;
  const lastColon = spec.lastIndexOf(':');
  if (lastColon <= 0) return spec.length > 0;
  const suffix = spec.slice(lastColon + 1);
  // A colon-bearing id whose suffix is NOT an effort level is treated as a
  // plain model id (same rule applyRoleModel uses when splitting).
  return suffix.length > 0 && spec.slice(0, lastColon).length > 0;
}

// ── Compaction limits (context-trimming-tiers-2026-07-01) ────────────────────

/** 1M-window models — a spec carrying the `[1m]` marker. */
export const MODEL_WINDOW_1M = 1_000_000;
/** The conservative default window: any spec WITHOUT the `[1m]` marker —
    haiku, sonnet ≤4.x, unknown/null specs, AND un-normalized default-1M-family
    specs (a bare `sonnet`/`opus` launch really does run a 200k auto-compact
    window in CC — see `isDefault1mModelSpec`). */
export const MODEL_WINDOW_DEFAULT = 200_000;

/**
 * Hard context window for a CC-hosted model spec. The `[1m]` marker on the
 * spec IS the window signal — live-verified via `/context` on CC 2.1.198
 * (2026-07-02): bare `sonnet` reports "Auto-compact window: 200k tokens" and
 * auto-compacts ~167k (killed a wave of sonnet fleet members at preTokens
 * 167-170k), while `sonnet[1m]` reports "Auto-compact window: 967k tokens".
 * So: `[1m]` → 1M; anything else (including an unknown/null spec and a bare
 * default-1M-family name that skipped launch normalization) → the conservative
 * 200k. Fail-safe direction matters: a low limit on a 1M session is just
 * deliberate leanness (agent-managed-compaction D-006); a high limit on a 200k
 * session means papercusp never preempts and CC auto-compacts MID-TASK — the
 * exact 2026-07-02 failure. OMP/local models resolve via their own registry
 * (follow-up, context-trimming D-003).
 */
export function modelWindowForSpec(spec?: string | null): number {
  if (spec == null) return MODEL_WINDOW_DEFAULT;
  if (spec.includes('[1m]')) return MODEL_WINDOW_1M;
  if (isCodexExtendedWindowSpec(spec)) return MODEL_WINDOW_CODEX_EXTENDED;
  return MODEL_WINDOW_DEFAULT;
}

/** Resolve the hard window for one tier. Provider-backed tiers may carry the
 * exact window resolved from their backend catalog; legacy/Claude/Codex rows
 * continue through the established spec-only policy. */
export function modelWindowForTier(tier: Pick<ModelTier, 'spec' | 'contextWindow'>): number {
  const catalogWindow = tier.contextWindow;
  if (typeof catalogWindow === 'number' && Number.isFinite(catalogWindow) && catalogWindow > 0) {
    return Math.floor(catalogWindow);
  }
  return modelWindowForSpec(tier.spec);
}

/**
 * Codex families papercusp LAUNCHES at an extended window (plan
 * codex-1m-context-window-2026-08-17 D-002 — the launch side lives in
 * model-context-budget.mjs `codexContextWindowConfig`, which reads the installed
 * registry; this is the pure, fs-free twin the spec-derived seed needs).
 *
 * DELIBERATELY EXCLUDED, because their `max_context_window` equals their default
 * and there is no bigger window to request: `gpt-5.5`, `gpt-5.4-mini`,
 * `gpt-5.3-codex-spark`. Note `gpt-5.4` IS extended (1M) while `gpt-5.4-mini` is
 * not — the anchors are what keep those apart, so do not loosen them to a
 * substring test. `gpt-6-astra` is also an extended family: its launch window
 * comes from the direct Codex registry when present, while this predicate keeps
 * the conservative role-cap derivation safe when the registry is absent.
 */
export const CODEX_EXTENDED_WINDOW_FAMILY_RE =
  /^(?:gpt-6\.1-sol|gpt-6-(?:astra|sol|luna)|gpt-5\.6-(?:sol|terra|luna)|gpt-5\.4|sol|terra|luna)(?:\[[^\]]*\])?(?::[a-z0-9]+)?$/i;

export function isCodexExtendedWindowSpec(spec?: string | null): boolean {
  return spec != null && CODEX_EXTENDED_WINDOW_FAMILY_RE.test(spec.trim());
}

/**
 * The window an extended-window Codex spec is SEEDED against. Plan D-003 makes
 * the officially documented 1.05M families use the guide's exact 1,000,000
 * configured window even when an installed registry still reports 872,000.
 *
 * It exists mainly to clear the role cap: `defaultCompactionLimitForWindow(1_000_000)`
 * derives 825,000, which the 450k su/leader and 250k fleet-member caps then bind.
 * So the exact value below never reaches a session — the ROLE CAP does, which is
 * the whole point of D-001 (papercusp's soft limits are unchanged; codex sessions
 * simply become able to reach them instead of being pinned at 158,000 by a
 * fabricated 200k window).
 *
 * FAIL-SAFE NOTE — the direction that matters. A spec-derived seed is a CLAIM
 * about a window this process cannot observe: on a codex CLI too old to honour
 * `model_context_window`, the session really would run 258,400 and a 450k limit
 * would mean papercusp never pre-empts. That is caught, not assumed away: the
 * compaction watchdog reads the window Codex REPORTS in every token_count event
 * and lowers a stored limit that sits above the safe derivation
 * UNCONDITIONALLY (see its D-011 note). So the worst case self-heals on the
 * first sweep, while the common case is correct from the first turn.
 */
export const MODEL_WINDOW_CODEX_EXTENDED = 1_000_000;

/**
 * Model FAMILIES papercusp launches at the FULL 1M window: `opus`, `fable`
 * (owner directive 2026-07-02), and `sonnet-5` (incl. the bare `sonnet` alias,
 * which CC resolves to the latest sonnet = sonnet-5). This is the FAMILY
 * predicate the launch normalizer keys on — psu-launcher `normalizeModelSpec`
 * injects `[1m]` into these specs at launch — NOT a claim that a bare spec
 * already runs 1M. REVERSAL of the P-031 note (2026-07-02, live-verified via
 * `/context` the same day): a bare `sonnet` session runs a 200k AUTO-COMPACT
 * window in CC 2.1.198; the 967k default in CC's model table sits behind a
 * staged-rollout gate (statsig `tengu_amber_moleskin`, OFF here), so only the
 * `[1m]` marker reliably buys the big window. Window/limit math must therefore
 * key on the marker (`modelWindowForSpec`), never on this family predicate.
 * Sonnet ≤4.x (`claude-sonnet-4-6` etc.) stays outside the family — the regex
 * deliberately does not match `sonnet-4-5`.
 */
export const DEFAULT_1M_FAMILY_RE = /fable|opus|sonnet-?5|^sonnet(\[1m\])?(:[a-z0-9]+)?$/i;

/**
 * Inject the `[1m]` window marker into a default-1M-family spec (idempotent;
 * a no-op outside the families or when the marker is already present). The TS
 * twin of psu-launcher `normalizeModelSpec` — psu covers its own launches;
 * THIS one is applied at the operator exec boundary (`applyRoleModel`) so a
 * direct `claude --model <spec>` spawn (committed role default, AGENT_MODELS,
 * or a per-spawn pin) also gets the 1M auto-compact window. Kept in lockstep
 * via DEFAULT_1M_FAMILY_RE.
 */
export function normalizeModelSpec(spec: string): string {
  if (!spec || /\[1m\]/i.test(spec) || !DEFAULT_1M_FAMILY_RE.test(spec)) return spec;
  const c = spec.lastIndexOf(':');
  const suffix = c > 0 ? spec.slice(c + 1) : '';
  if (c > 0 && /^(low|medium|high|xhigh|max)$/i.test(suffix)) return `${spec.slice(0, c)}[1m]${spec.slice(c)}`;
  return `${spec}[1m]`;
}

export function isDefault1mModelSpec(spec?: string | null): boolean {
  if (spec == null) return false;
  if (/fable|opus|sonnet-?5/i.test(spec)) return true;
  // The bare `sonnet` alias (whole spec, optional [1m] marker / :effort suffix)
  // resolves to the LATEST sonnet in Claude Code — claude-sonnet-5 today
  // (live-verified 2026-07-02: a `--model sonnet:medium` member's transcript
  // reports "model":"claude-sonnet-5"). Versioned sonnet ≤4.x ids don't hit
  // this branch (they carry the version digits and fail the anchor).
  return /^sonnet(\[1m\])?(:[a-z0-9]+)?$/i.test(spec);
}

// ── Cloud model-spec validation (WI-1979 / WI-1993 defense-in-depth) ─────────
//
// The TS TWIN of psu-launcher `validateModelSpec` (+ its KNOWN_CLOUD_ALIASES /
// damerauDistance / nearestCloudAlias helpers). psu-launcher.mjs is exec'd
// DIRECTLY by node (never bundled/tsx-compiled), so it cannot import this TS
// module and vice-versa — the same submodule/build boundary that already forces
// `normalizeModelSpec` / `DEFAULT_1M_FAMILY_RE` to be kept in lockstep by
// convention. This copy exists so the `fleet:launch-on-plan` tool can reject a
// malformed CLOUD spec at the TOOL BOUNDARY (before opening N doomed desktop
// windows that each die at psu boot), instead of only catching it per-member at
// launch. The message text + result shape are kept byte-identical to the
// launcher's so the parity test (apps/operator/lib/psu-launcher.test.ts) can
// assert the two agree across a shared vector table and CATCH DRIFT.

/** The canonical BARE cloud model aliases psu recognizes. Short + lowercase. The
    CLI/gateway own the full OPEN set of ids, so this list is used ONLY to spot an
    obviously-misspelled short alias — never to gate full/provider ids. The TS twin
    of psu-launcher `KNOWN_CLOUD_ALIASES`. Includes Anthropic (opus/sonnet/haiku/fable)
    and OpenAI GPT-5.6 (sol/terra/luna) families. */
export const KNOWN_CLOUD_ALIASES = ['opus', 'sonnet', 'haiku', 'fable', 'sol', 'terra', 'luna'] as const;

/** One selectable base model in a model-picker menu: the bare alias, a human
    label, and the CLI backend that alias launches on. */
export interface CloudModelChoice {
  /** The bare alias sent as the `--model` spec (before any `:<effort>` suffix). */
  value: (typeof KNOWN_CLOUD_ALIASES)[number];
  /** Display label for a UI picker. */
  label: string;
  /** Which CLI actually launches this family (`cloudModelBackendHint`). A RESUME
      is hard-bound to the session's own backend, so a resume menu filters on this;
      a NEW session may pick either, so a new-session picker offers all rows. */
  backend: 'claude' | 'codex';
}

/**
 * The canonical selectable base-model menu — the client-safe TS twin of
 * psu-launcher `RESUME_MODEL_MENU` (owner directives WI-4889 / WI-4891).
 *
 * WHY A TWIN AND NOT A SHARED IMPORT: `psu-launcher.mjs` is exec'd DIRECTLY by
 * node and can neither import this TS module nor be imported by the browser
 * bundle (it pulls node built-ins + inquirer). That is the same boundary that
 * already forces `normalizeModelSpec` / `KNOWN_CLOUD_ALIASES` / `validateModelSpec`
 * to exist here as twins. The pairing is NOT left to convention: the parity test
 * in `apps/operator/lib/psu-launcher.test.ts` — which CAN import the .mjs — asserts
 * this array matches `RESUME_MODEL_MENU` value-for-value, so adding a model family
 * to psu without adding it here FAILS THE BUILD.
 *
 * This exists because the HUD's new-session launcher previously hand-maintained
 * its own four-entry list, which silently fell behind psu (missing fable / sol /
 * terra / luna, and offering a stale `gpt-5.2` that is not a recognized alias) —
 * owner-reported 2026-07-27. UI pickers must derive from THIS, never re-declare.
 *
 * Labels are the psu menu's text minus the redundant leading `<alias> — ` prefix
 * (a UI picker already shows the value); the parity test pins that relationship.
 */
export const CLOUD_MODEL_MENU: readonly CloudModelChoice[] = [
  { value: 'opus', label: 'Anthropic Claude Opus (1M, strongest)', backend: 'claude' },
  { value: 'sonnet', label: 'Anthropic Claude Sonnet (1M, balanced)', backend: 'claude' },
  { value: 'fable', label: 'Anthropic Claude Fable (1M)', backend: 'claude' },
  { value: 'haiku', label: 'Anthropic Claude Haiku (fast, cheap)', backend: 'claude' },
  { value: 'sol', label: 'OpenAI GPT-5.6 “Sol” (codex)', backend: 'codex' },
  { value: 'luna', label: 'OpenAI “Luna” (codex)', backend: 'codex' },
  { value: 'terra', label: 'OpenAI “Terra” (codex)', backend: 'codex' },
] as const;

/** Damerau optimal-string-alignment distance: Levenshtein PLUS adjacent
    transpositions as a single edit — so a swap typo (`fabel`↔`fable`) is distance 1,
    without widening the substitution radius (`o3`/`gpt4`/`grok` stay far from every
    alias). Tiny; only ever run over the ~4 known aliases. */
function damerauDistance(a: string, b: string): number {
  const al = a.length;
  const bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  const d: number[][] = Array.from({ length: al + 1 }, () => new Array<number>(bl + 1).fill(0));
  for (let i = 0; i <= al; i++) d[i][0] = i;
  for (let j = 0; j <= bl; j++) d[0][j] = j;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // adjacent transposition
      }
    }
  }
  return d[al][bl];
}

/** Nearest known cloud alias to a (letters-only) token, with its Damerau distance. */
function nearestCloudAlias(letters: string): { alias: string | null; dist: number } {
  const t = String(letters || '').toLowerCase();
  let alias: string | null = null;
  let dist = Infinity;
  for (const a of KNOWN_CLOUD_ALIASES) {
    const dd = damerauDistance(t, a);
    if (dd < dist) {
      dist = dd;
      alias = a;
    }
  }
  return { alias, dist };
}

/** Effort-suffix matcher, built from the single MODEL_EFFORT_LEVELS source so the
    peel + the error message stay identical to psu-launcher's inline `low|…|max`. */
const EFFORT_SUFFIX_RE = new RegExp(`^(${MODEL_EFFORT_LEVELS.join('|')})$`, 'i');

/**
 * Compose psu's `--model` wire value from a model id + a SEPARATE effort choice.
 *
 * THE one implementation (WI-6321, owner ask 2026-07-27: "the options in the gui
 * should match the exact same options that the psu utility uses because it should
 * share the same code for getting the options"). There were three, and they did not
 * agree: `agent-launch-core.composeModelSpec` threw on effort-without-model, while
 * NewSessionLauncher's copy returned the model and DROPPED the effort silently — so
 * the GUI could send a launch whose reasoning-effort choice simply evaporated. This
 * module is the client-safe one (see the file header), so it can be the single home
 * both a server launcher and the renderer import.
 *
 * psu has no standalone effort flag — effort rides the spec as `<model>:<effort>` —
 * so an effort with no model has nowhere to go and is an ERROR, never a silent drop.
 * An explicit effort REPLACES a recognized effort tail already on the spec.
 */
export function composeLaunchModelSpec(model?: string | null, effort?: string | null): string | undefined {
  const m = model?.trim() || undefined;
  const e = effort?.trim() || undefined;
  if (!e) return m;
  if (!m) {
    throw new Error(
      `effort ${JSON.stringify(e)} needs a model — psu carries effort only as a ` +
        `\`<model>:<effort>\` spec, so an effort with no model would be dropped. Set model too, or drop effort.`,
    );
  }
  if (!(MODEL_EFFORT_LEVELS as readonly string[]).includes(e)) {
    throw new Error(`unrecognized effort ${JSON.stringify(e)} — psu accepts ${MODEL_EFFORT_LEVELS.join('|')}.`);
  }
  const colon = m.lastIndexOf(':');
  const base =
    colon > 0 && (MODEL_EFFORT_LEVELS as readonly string[]).includes(m.slice(colon + 1).toLowerCase())
      ? m.slice(0, colon)
      : m;
  return `${base}:${e}`;
}

/**
 * The `<model>[:<effort>]` spec a session was LAUNCHED on, read out of its
 * recorded launch argv. Pure, synchronous, client-safe — which is the whole
 * point (WI-6510).
 *
 * This loop was inline in `compaction-usage.resolveModelSpecForOwner`, whose
 * source 1 is exactly this parse. That function is async and server-only (it
 * hits Postgres, then the session config dir), so a renderer that needed the
 * same answer had no way to reuse it and would have grown a second copy —
 * precisely the three-disagreeing-composers history recorded above
 * `composeLaunchModelSpec`. Extracted instead: `resolveModelSpecForOwner`
 * calls this, and so does the chat MODEL control, which reads the argv the
 * roster entry already carries (`RosterEntry.launchArgv`) rather than paying a
 * fetch. That is what lets `ChatModeAction.current()` stay pure and sync as
 * its contract requires.
 *
 * `unknown` in, because the argv arrives as a jsonb column: a non-array, or an
 * array with non-string members, is data to survive rather than a type error
 * to throw on.
 *
 * Returns null when no `--model` was recorded — which means "launched on the
 * backend default", NOT "unknown model". Callers that must distinguish the two
 * cannot do it from argv alone; `resolveModelSpecForOwner`'s settings.json
 * fallback is the server-side second source.
 */
export function modelSpecFromArgv(argv: unknown): string | null {
  return flagValueFromArgv(argv, 'model');
}

/**
 * Read a `--<flag>=<value>` launch flag off a recorded argv, across BOTH shapes
 * `adv_sessions.launch_argv` actually stores. Generalized out of `modelSpecFromArgv` so a second
 * flag cannot ship with a copy of pass 1 alone and inherit the exact bug pass 2 exists to fix
 * (`--account` was the second caller; see `accountFromArgv`).
 *
 * `flag` is a bare name (`'model'`, `'account'`) and is interpolated into a regex, so keep it to
 * literal identifiers — it is not a user-supplied pattern.
 *
 * Returns null when the flag was not recorded. That means "launched without it", NOT "unknown":
 * a caller that must distinguish those two cannot do it from argv alone (an EMPTY argv is the
 * unknown case, and it is the CALLER's job to check for it — see `readModelSpec`).
 */
export function flagValueFromArgv(argv: unknown, flag: string): string | null {
  if (!Array.isArray(argv)) return null;
  // PASS 1 — argv as TOKENS. The shape every psu/fleet launch records:
  // ["psu", "--no-picker", "--model=sonnet[1m]:high", …]. Authoritative, so it
  // runs first and its answer is never second-guessed by pass 2.
  const eq = `--${flag}=`;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string') continue;
    if (a.startsWith(eq)) {
      const v = a.slice(eq.length).trim();
      if (v) return unquoteArgValue(v);
    }
    if (a === `--${flag}` && typeof argv[i + 1] === 'string') {
      const v = (argv[i + 1] as string).trim();
      if (v) return unquoteArgValue(v);
    }
  }
  // PASS 2 — argv as a recorded SHELL COMMAND. `adv_sessions.launch_argv` has a
  // SECOND shape, and it is the one this control's own writes produce: the
  // console-launch route records `[terminal, greetingCmd]` (console-launch.ts),
  // so the whole command lands in ONE element —
  //   ["gnome-terminal", "echo \"resuming …\"; exec psu --resume=<id> --model='opus[1m]:high'"]
  // — where `--model=` is embedded in a string rather than being a token of its
  // own. Verified against live rows, not assumed.
  //
  // Without this pass the failure is a CONTROL THAT LIES rather than one that
  // breaks: the fork launches on the right model, the new session records this
  // shape, and the pill then reads null and reports "default" — the session is
  // on opus and the UI says otherwise (D-002/D-009 §B). It also silently
  // mis-sized `resolveModelSpecForOwner`'s compaction budget for every
  // console-resumed session, which shares this parser.
  //
  // The value may be QUOTED, because the greeting is shell text and the emitter
  // single-quotes it (console-launcher's `shellSafeModelSpec`).
  const embedded = new RegExp(`--${flag}[=\\s]+('[^']*'|"[^"]*"|[^\\s;'"]+)`);
  for (const a of argv) {
    if (typeof a !== 'string') continue;
    const m = embedded.exec(a);
    if (m) {
      const v = unquoteArgValue(m[1].trim());
      if (v) return v;
    }
  }
  return null;
}

/**
 * The `--account=` a session was LAUNCHED with, read off its recorded argv.
 *
 * Exists because the ACCT chat pill was telling the owner it could not know this ("a static
 * --account= pin set at spawn, which this control cannot read") while `launchArgv` sat in the very
 * same context object the MODEL pill parses. Worse than the missing information: a
 * `--account=default` session bypasses the inference gateway entirely, so a dynamic pool pin
 * CANNOT reach it — and the pill was still offering every pool account as a clickable row. That
 * click reports success (the durable pin really is written) while the session keeps routing exactly
 * as before, which is the false-reassurance shape this plan exists to remove.
 *
 * Returns the raw value — a LAUNCH_ACCOUNT_MODES member (`'default'` / `'auto'`) or a pool id — or
 * null when no `--account` was recorded, which for psu means the launch opened the interactive
 * picker rather than that any particular account was chosen.
 */
export function accountFromArgv(argv: unknown): string | null {
  return flagValueFromArgv(argv, 'account');
}

/** Strip one layer of matching shell quotes from a recorded argument value.
 *  A launch argv is sometimes raw tokens and sometimes recorded shell text, so a
 *  value can arrive already quoted; the spec itself never contains quotes. */
function unquoteArgValue(v: string): string {
  if (v.length >= 2 && ((v[0] === "'" && v.endsWith("'")) || (v[0] === '"' && v.endsWith('"')))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Split a `<model>[:<effort>]` spec back into its two parts for DISPLAY.
 *
 * The inverse of {@link composeLaunchModelSpec}, and deliberately as
 * conservative: only a RECOGNIZED effort tail is split off, so a model id that
 * merely contains a colon keeps its full name instead of losing its last
 * segment to a wrong guess. `effort` is null when the spec carries none —
 * meaning the backend default, not "unknown".
 */
export function splitModelSpec(spec?: string | null): { model: string | null; effort: string | null } {
  const s = spec?.trim();
  if (!s) return { model: null, effort: null };
  const colon = s.lastIndexOf(':');
  if (colon > 0) {
    const tail = s.slice(colon + 1).toLowerCase();
    if ((MODEL_EFFORT_LEVELS as readonly string[]).includes(tail)) {
      return { model: s.slice(0, colon), effort: tail };
    }
  }
  return { model: s, effort: null };
}

// ── psu launch option vocabularies (WI-6321) ────────────────────────────────
// The client-safe twins of psu-launcher's own picker menus, so the GUI launcher
// offers EXACTLY what `psu` offers. Held to the launcher value-for-value by the
// parity suite in apps/operator/lib/psu-launcher.test.ts — the same discipline
// CLOUD_MODEL_MENU / MODEL_EFFORT_LEVELS already carry (WI-6300). Add an option
// to psu and the parity test fails until it is surfaced here too.

/** Initial-context size variants — psu `--context-size=`. `null` (Native) means
 *  send no flag at all, byte-identical to a pre-feature launch. Twin of
 *  psu-launcher's SU_CONTEXT_CHOICES. */
export type SuContextSizeValue = 'trimmed';
export type LegacySuContextSizeValue = 'full' | SuContextSizeValue;
/** User-facing launch choices are trimmed-only. */
export const SU_CONTEXT_SIZES: readonly SuContextSizeValue[] = ['trimmed'];

/** Static measured baseline estimates shown beside each variant. Twin of
 *  psu-launcher's SU_CONTEXT_TOKEN_ESTIMATES. */
export const SU_CONTEXT_TOKEN_ESTIMATES: Record<SuContextSizeValue, string> = {
  trimmed: '~70k',
};

/** psu's picker default (highlighted row). Twin of SU_CONTEXT_DEFAULT. */
export const SU_CONTEXT_DEFAULT: SuContextSizeValue = 'trimmed';

/**
 * The two non-pool account modes psu's `--account=` accepts, alongside a concrete
 * pool-account id (the account-routing-3-options grammar):
 *   default — the system/CLI login, no gateway pin
 *   auto    — gateway-routed with failover across the pool
 * A launch with NO `--account` opens psu's INTERACTIVE picker, which would block a
 * GUI-spawned session forever — so the GUI always sends one.
 */
export const LAUNCH_ACCOUNT_MODES = ['default', 'auto'] as const;
export type LaunchAccountMode = (typeof LAUNCH_ACCOUNT_MODES)[number];

/**
 * The `--account=` spellings that make a session BYPASS the inference gateway entirely
 * (WI-42439). `default` is the one psu's own grammar documents, but the resolver accepts
 * three more names for the same route, and they are NOT interchangeable at the type level
 * — they are four literal strings that happen to mean one thing.
 *
 * ⚠ THIS IS THE SET, AND IT MUST HAVE EXACTLY ONE COPY. It is duplicated the moment a
 * reader writes `x === 'default'`: that test is right about the documented spelling and
 * silently wrong about the other three, and NOTHING FAILS when it is — the session simply
 * keeps bypassing the gateway while a control reports it re-routed. That is how WI-42439
 * shipped: `resolveAccountPin` (bootstrap-su.ts) tested all of them, the ACCOUNT chat pill
 * tested only `'default'`, and 25 live `--account=system` sessions rendered every pool
 * account as a clickable pin target whose click writes a durable pin, returns ok, and
 * changes no routing at all.
 *
 * A gateway-free session cannot be re-pinned LIVE by anything — `accounts:pin` writes the
 * pin durably and the gateway never sees the traffic — so it must be RESPAWNED to change
 * accounts. Any surface offering a live re-pin has to ask this question, not its own.
 */
export const GATEWAY_FREE_ACCOUNT_SPELLINGS = ['default', 'none', 'system'] as const;

/**
 * True when an `--account=` value routes AROUND the inference gateway (the system / CLI
 * login) rather than through it.
 *
 * `null`/`undefined`/`''` — no `--account` recorded — is deliberately NOT gateway-free
 * here. The implied-default case resolves to whatever account the workspace has nominated
 * and is only the local login while none is set (see `resolveAccountPin`), so a caller
 * that cannot read that nomination must not guess; and an EMPTY launch argv means UNKNOWN,
 * which is a third answer again. Callers that genuinely need "unspecified" folded in must
 * say so at their own call site rather than widening this predicate.
 */
export function isGatewayFreeAccount(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  const lower = value.trim().toLowerCase();
  return (GATEWAY_FREE_ACCOUNT_SPELLINGS as readonly string[]).includes(lower);
}

/** Shape of an `--account=` value: a mode above, or a pool account id. Mirrors the
 *  value guard in agent-launch-core's injectAccountArg so the GUI cannot compose a
 *  value the scripted path would refuse. */
export function isLaunchAccountValue(v: string): boolean {
  return /^[A-Za-z0-9._:-]{1,120}$/.test(v);
}

// ── Bulk-resolver launch profiles ──────────────────────────────────────────

/**
 * The two pane-owned resolver defaults stored in `operator_agent_config`.
 *
 * This intentionally mirrors the generalized bulk-run kinds without importing
 * `attention/bulk-run-store`: that module imports Node + Postgres at module
 * scope, while this file is the browser-safe launch vocabulary. The focused
 * config tests pin both keys so a third run kind cannot silently become
 * unconfigurable.
 */
export const BULK_RESOLVER_PROFILE_KINDS = ['inbox-resolve', 'plan-cleanup'] as const;
export type BulkResolverProfileKind = (typeof BULK_RESOLVER_PROFILE_KINDS)[number];

/** Carry is an editable advanced axis; fresh/headless/su remain fixed launch
 * invariants and therefore do not belong in the stored profile. */
export const BULK_RESOLVER_CARRY_MODES = ['warm', 'cold'] as const;
export type BulkResolverCarryMode = (typeof BULK_RESOLVER_CARRY_MODES)[number];

/**
 * One pane's saved defaults for its NEXT resolver run. `null` model/effort
 * means inherit the launcher's default, preserving the pre-configuration
 * behavior. The compatible backend is DERIVED from `model`, never stored as a
 * second independently editable truth.
 */
export interface BulkResolverLaunchProfile {
  model: string | null;
  effort: ModelEffort | null;
  account: string;
  carry: BulkResolverCarryMode;
  /** Optional for legacy config documents; absent means `safe-high`. */
  automationMode?: BulkAutomationMode;
  /** Optional for legacy config documents; absent means `high`. */
  minConfidence?: BulkConfidence;
}

export type BulkResolverLaunchProfiles = Record<BulkResolverProfileKind, BulkResolverLaunchProfile>;

export const DEFAULT_BULK_RESOLVER_LAUNCH_PROFILE: Readonly<BulkResolverLaunchProfile> = {
  model: null,
  effort: null,
  account: 'default',
  carry: 'warm',
};

/** Fresh objects: callers may edit one pane's draft without mutating the other
 * pane or the module-level default. */
export function defaultBulkResolverLaunchProfiles(): BulkResolverLaunchProfiles {
  return {
    'inbox-resolve': { ...DEFAULT_BULK_RESOLVER_LAUNCH_PROFILE },
    'plan-cleanup': { ...DEFAULT_BULK_RESOLVER_LAUNCH_PROFILE },
  };
}

export type LaunchAgentBackend = 'claude' | 'codex' | 'omp';

/**
 * Canonical Codex model ids that are NOT a `gpt-5.6-<menu alias>` expansion, so
 * the menu derivation below cannot reach them. Without this list a configured
 * `gpt-6.1-sol` (CODEX_SAFE_DEFAULT_MODEL, owner directive #1111) resolved to NO
 * backend and every bulk-resolver start refused it — the Plans Clean-up button and
 * the scheduled sweep both (WI-10004814). This module must stay client-safe, so it
 * cannot import the server-side gateway lineup; instead
 * `agent-config-constants.test.ts` pins every `CODEX_GATEWAY_FALLBACK_LINEUP` slug
 * to resolve to `codex` here, so a model the gateway offers cannot be unlaunchable.
 */
export const CODEX_CANONICAL_MODEL_IDS = [
  'gpt-6.1-sol',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
] as const;

/**
 * Infer the CLI backend from the SAME model vocabulary the launch selectors
 * render. A host-local OMP selector is always `provider/id`; the native aliases
 * carry their backend on `CLOUD_MODEL_MENU`. Codex also exposes the canonical
 * `gpt-5.6-{sol,terra,luna}` ids in settings/launch records, so those known
 * expansions must resolve to the same backend as their bare aliases. Unknown
 * full ids deliberately return null so the start-route validator can refuse
 * ambiguity instead of pairing a model with a guessed CLI.
 */
export function launchAgentBackendForModel(model?: string | null): LaunchAgentBackend | null {
  const split = splitModelSpec(model);
  const base = split.model?.replace(/\[[^\]]+\]$/, '') ?? null;
  if (!base) return null;
  if (base.includes('/')) return 'omp';
  const normalizedBase = base.toLowerCase();
  const bareChoice = CLOUD_MODEL_MENU.find((choice) => choice.value === normalizedBase);
  if (bareChoice) return bareChoice.backend;
  if ((CODEX_CANONICAL_MODEL_IDS as readonly string[]).includes(normalizedBase)) return 'codex';

  // Codex's native model ids are the canonical expansion of the same three
  // selectable aliases. Keep the mapping derived from the menu so adding a
  // codex family cannot create another unlaunchable canonical id.
  const codexAlias = normalizedBase.match(/^gpt-5\.6-(.+)$/)?.[1];
  if (!codexAlias) return null;
  return CLOUD_MODEL_MENU.find((choice) => choice.value === codexAlias && choice.backend === 'codex')?.backend ?? null;
}

/** How `backendForModelSpec` reached its answer, weakest rule last. Carried into
    `resolveRoleLaunch`'s readout so a surprising pairing names the rule that made
    it instead of being an unattributable guess. */
export type ModelBackendEvidence = 'model-catalog' | 'model-shape';

/**
 * Which CLI actually runs `spec` — the SPAWN-side backend vocabulary
 * (`AgentBackend`), derived from the model catalog rather than re-guessed per
 * call site. `null` = the catalog does not recognize the id, so the caller must
 * fall back to a configured backend instead of pairing a model with a guessed
 * CLI (role-model-one-answer-2026-09-03 P-003: "backend rides with the model").
 *
 * Two rules, and the result says which one fired so the weaker one is visible:
 *
 *   - `model-catalog` — the id is IN a vocabulary: a `provider/id` OMP selector,
 *     a `CLOUD_MODEL_MENU` bare alias (`opus`, `sol`, …), or a canonical
 *     `gpt-5.6-*` expansion. This is the authoritative leg.
 *   - `model-shape`   — the id is not in any menu but its SHAPE is unambiguous:
 *     Codex-only prefixes (`openai-codex/`, `chatgpt:`, `gpt-<digit>`) and
 *     Anthropic's versioned `claude-*` ids (`claude-opus-5`, `claude-haiku-4-5-…`),
 *     which the menus deliberately do not enumerate because the CLI owns that
 *     open set. Kept explicit and labelled: shape-matching a model id is exactly
 *     the mechanism P-003 indicts, so it may run LAST and must never be silent.
 *
 * Codex is tested BEFORE the `provider/id` rule on purpose: `openai-codex/<id>`
 * contains a slash but is a Codex spec, not an OMP selector.
 */
export function backendForModelSpec(
  spec?: string | null,
): { backend: AgentBackend; evidence: ModelBackendEvidence } | null {
  const base = splitModelSpec(spec).model?.replace(/\[[^\]]+\]$/, '')?.toLowerCase() ?? null;
  if (!base) return null;

  // Codex-only shapes first — `openai-codex/…` would otherwise read as OMP's
  // provider/id form. Mirrors harness-invoke-once's `inferBackendFromModelSpec`,
  // which is the narrower "does this FORCE a backend swap" question.
  if (base.startsWith('openai-codex/') || base.startsWith('chatgpt:') || /^gpt-\d/.test(base)) {
    // `gpt-5.6-sol` and friends ARE menu rows; everything else gpt-shaped is shape-only.
    const known = launchAgentBackendForModel(base) === 'codex';
    return { backend: 'codex', evidence: known ? 'model-catalog' : 'model-shape' };
  }

  const fromMenu = launchAgentBackendForModel(base);
  if (fromMenu) {
    return {
      backend: fromMenu === 'claude' ? 'claude-code' : fromMenu,
      evidence: 'model-catalog',
    };
  }

  // Anthropic's versioned ids (`claude-opus-5`, `claude-fable-5-1`, …). The bare
  // aliases above are the menu; these full ids are the open set the CLI owns, and
  // they are what `models[role]` actually holds after a /settings/agent edit.
  if (/^claude-/.test(base)) return { backend: 'claude-code', evidence: 'model-shape' };

  return null;
}

/**
 * Most members one `fleet:launch-on-plan` call may open — opening more than this
 * in one go is heavy and almost always a mistake (mirrors capability:terminal's
 * MAX_TERMINALS).
 *
 * Lives HERE, in the client-safe module, rather than in launch-on-plan.ts, so the
 * GUI's member-count control can bound its input against the SAME number the tool
 * enforces. Importing it from the tool would drag that module's server subtree
 * (node:fs, the PG state layer, the promotion graph) into the renderer chunk —
 * the exact cascade this file's header exists to prevent. launch-on-plan.ts
 * imports it back from here, so there is one definition, not two.
 */
export const FLEET_MAX_MEMBERS = 12;
/** Persisted fleet targets may span several capacity-clamped launch waves. */
export const FLEET_MAX_TARGET_MEMBERS = 64;

/** Result of {@link validateCloudModelSpec}: ok, plus a corrective `message` on reject. */
export interface CloudModelSpecResult {
  ok: boolean;
  message?: string;
}

/**
 * Validate a hand-typed CLOUD `--model` spec, catching the malformed-alias
 * classes that otherwise reach the CLI as an unrunnable model and fail the launch
 * with NO useful hint (WI-1979):
 *   (1) a psu-INTERNAL `[1m]` 1M-window marker typed as INPUT on a bare non-family
 *       alias (`fabel5[1m]`) — psu APPENDS `[1m]` (see normalizeModelSpec); it is
 *       never something you type;
 *   (2) a bare short cloud alias that is a CLOSE misspelling of a known one
 *       (`fabel`→fable, `sonet`, `sonnet5`, `opus4`);
 *   (3) a known alias glued or dash/dot-separated to a version — `sonnet-5`,
 *       `opus-4.8`, `haiku-4` — the marketing name typed instead of the bare alias
 *       (or a full `claude-…` id). The single most common agent typo.
 * Deliberately LENIENT — cloud model ids are an OPEN set (the CLI/gateway own the
 * canonical list). It only inspects values that unambiguously look like a bare short
 * alias (pure letters, or letters+digits). A dashed/dotted/slashed/versioned id
 * (`claude-fable-5`, `anthropic.claude-3-5-…`, and legit `[1m]` round-trips like
 * `claude-fable-5[1m]`) is a plausible full id and PASSES UNCHECKED; so does a
 * plausible non-alias short id (`o3`, `gpt4`) that is NOT a close typo of a known
 * alias, and any LOCAL/ollama id (validated separately by fuzzyEnum on the tool arg).
 * The TS twin of psu-launcher `validateModelSpec` — kept byte-identical (parity test).
 */
export function validateCloudModelSpec(spec?: string | null): CloudModelSpecResult {
  if (!spec) return { ok: true };
  const s = String(spec).trim();
  if (!s) return { ok: true };
  if (/^ollama(-cc)?\//i.test(s) || /\bornith\b/i.test(s)) return { ok: true }; // local — not ours to check
  // Peel a recognized :effort tail so we inspect the model BASE (an unrecognized ':x' —
  // bedrock's '…-v2:0' — stays on the base, which then contains ':' → not alias-shaped → passes).
  const c = s.lastIndexOf(':');
  const effort = c > 0 && EFFORT_SUFFIX_RE.test(s.slice(c + 1)) ? s.slice(c + 1) : null;
  const base = effort ? s.slice(0, c) : s;
  // Peel a trailing [..] window marker: 'fable[1m]' → core 'fable', hadMarker true.
  const mk = base.match(/^(.*?)(\[[^\]]*\])$/);
  const core = mk ? mk[1] : base;
  const hadMarker = !!mk;
  const isPure = /^[a-z]+$/i.test(core); // opus, fabel
  const isLettersDigits = /^[a-z]+[0-9]+$/i.test(core); // fabel5, sonnet5, o3
  if (isPure && (KNOWN_CLOUD_ALIASES as readonly string[]).includes(core.toLowerCase())) return { ok: true };
  // (3) a known alias glued or dash/dot-separated to a version — `sonnet-5`, `opus-4.8`, `haiku-4`,
  //     `sonnet5` — the marketing name typed instead of the BARE alias (or a full id). The single most
  //     common malformed spec agents produce: psu resolves the bare alias to the latest generation and
  //     appends [1m], so `sonnet-5` reaches the CLI as an unrunnable id. A genuine full id starts with a
  //     VENDOR prefix (`claude-…`, `anthropic.…`), never a bare alias, so it is unaffected — checked HERE,
  //     BEFORE the dash/version passthrough below that would otherwise wave `sonnet-5` through as a full id.
  const aliasVer = core.toLowerCase().match(/^(opus|sonnet|haiku|fable|sol|terra|luna)(?=[-.]?[0-9])/);
  if (aliasVer) {
    const fam = aliasVer[1];
    const prefix = /^(sol|terra|luna)$/i.test(fam) ? 'gpt-5.6-' : 'claude-';
    return {
      ok: false,
      message:
        `\`${s}\` is not a recognized model spec. Did you mean \`${effort ? `${fam}:${effort}` : fam}\`? ` +
        `Type the BARE alias (${KNOWN_CLOUD_ALIASES.join('/')}) — psu resolves it to the latest generation, appending the [1m] 1M-context window — ` +
        `not a versioned shorthand; pin a specific generation only as a full id (e.g. ${prefix}${fam}-5).`,
    };
  }
  // A full/provider id (dashes/dots/slashes/version) is NOT alias-shaped → open set, pass —
  // including a legit '[1m]' round-trip on a full id (e.g. 'claude-fable-5[1m]').
  if (!isPure && !isLettersDigits) return { ok: true };
  // Bare short token that is NOT a known alias. Reject only when it is either wearing a [1m]
  // marker (never valid on a non-family bare token) OR a CLOSE typo (Damerau ≤ 1) of a known
  // alias — so genuinely-unknown ids like `o3` / `gpt4` pass untouched.
  const near = nearestCloudAlias(core.replace(/[0-9]+$/, ''));
  const closeTypo = near.alias != null && near.dist <= 1;
  if (!hadMarker && !closeTypo) return { ok: true };
  const suggestion = closeTypo
    ? ` Did you mean \`${effort ? `${near.alias}:${effort}` : `${near.alias}:xhigh`}\`?`
    : '';
  const markerTip = hadMarker ? ' The `[1m]` 1M-context marker is appended AUTOMATICALLY by psu — do not type it.' : '';
  return {
    ok: false,
    message:
      `\`${s}\` is not a recognized model spec.${suggestion}${markerTip} ` +
      `Cloud models: \`<alias>[:<effort>]\` — aliases ${KNOWN_CLOUD_ALIASES.join('/')}, ` +
      `effort ${MODEL_EFFORT_LEVELS.join('|')} (e.g. \`fable:xhigh\`) — or a full id (e.g. claude-fable-5, anthropic.claude-…).`,
  };
}

/** The exact settings a resolver run was launched with, after preflight. Every
 *  field is resolved — no "inherit the default" remains — so the run row records
 *  what ACTUALLY ran and the launcher needs no second opinion. Structurally
 *  assignable to `attention/bulk-run-store`'s `BulkRunLaunchSnapshot`, which is
 *  where it is persisted; this module deliberately does not import that one. */
export interface EffectiveBulkResolverLaunch {
  model: string | null;
  effort: ModelEffort | null;
  account: string;
  carry: BulkResolverCarryMode;
  /** DERIVED from `model` (D-002), never a separately editable truth. */
  backend: LaunchAgentBackend;
  /** Effective owner policy; optional to preserve the legacy launch shape. */
  automationMode?: BulkAutomationMode;
  minConfidence?: BulkConfidence;
}

/** {@link resolveBulkResolverLaunch}: the effective settings, or a corrective
 *  message naming the ONE control the owner has to change. */
export interface BulkResolverLaunchResolution {
  ok: boolean;
  message?: string;
  /** Which control the message is about, so a pane can mark that field rather
   *  than reddening the whole popover. */
  field?: 'model' | 'effort' | 'account' | 'carry' | 'automationMode' | 'minConfidence';
  effective?: EffectiveBulkResolverLaunch;
}

/**
 * Preflight a pane's click-time resolver launch settings — at the start route,
 * BEFORE a run row exists.
 *
 * This is NOT a second copy of `bulkResolverLaunchProfilesProblem`. That guards
 * the stored config DOCUMENT and answers a per-field SYNTAX question: is each
 * value well-formed for its own type. This answers the COMPATIBILITY question
 * the launch actually depends on — does the chosen model resolve to exactly one
 * CLI backend, is the spec one psu can really run, does the effort have a model
 * to ride on. The two are genuinely different questions: `sonnet-5` is a
 * well-formed non-empty ≤120-char string, so it is a VALID stored profile, and
 * it is also a model id psu cannot resolve. Only this function catches that.
 *
 * It runs before `createRun` on purpose. `buildAgentLaunchCommand` composes the
 * spec through `composeModelSpec`, which THROWS on an impossible combination —
 * and that throw would land inside the launcher's catch, recording a run that
 * was created and then immediately failed. A setting the owner fixes by
 * retyping one field belongs in a 400 with no run row at all, not in their run
 * history as a failure.
 *
 * Every rule is delegated to the helper that already owns it
 * (`composeLaunchModelSpec` for effort composition, `validateCloudModelSpec` for
 * spec shape, `launchAgentBackendForModel` for backend inference,
 * `isLaunchAccountValue` for account syntax) so there is one statement of each,
 * not a second that can drift.
 */
export function resolveBulkResolverLaunch(
  profile?: Partial<BulkResolverLaunchProfile> | null,
): BulkResolverLaunchResolution {
  const p = profile ?? {};

  const automationMode =
    p.automationMode === undefined
      ? undefined
      : isBulkAutomationMode(p.automationMode)
        ? p.automationMode
        : null;
  if (automationMode === null) {
    return {
      ok: false,
      field: 'automationMode',
      message: `automationMode must be one of ${BULK_AUTOMATION_MODES.join('|')}.`,
    };
  }
  const minConfidence =
    p.minConfidence === undefined
      ? undefined
      : isBulkConfidence(p.minConfidence)
        ? p.minConfidence
        : null;
  if (minConfidence === null) {
    return {
      ok: false,
      field: 'minConfidence',
      message: `minConfidence must be one of ${BULK_CONFIDENCE_LEVELS.join('|')}.`,
    };
  }

  const rawCarry = p.carry ?? DEFAULT_BULK_RESOLVER_LAUNCH_PROFILE.carry;
  if (!(BULK_RESOLVER_CARRY_MODES as readonly unknown[]).includes(rawCarry)) {
    return {
      ok: false,
      field: 'carry',
      message: `carry must be ${BULK_RESOLVER_CARRY_MODES.join(' or ')} — got ${JSON.stringify(rawCarry)}.`,
    };
  }
  const carry = rawCarry as BulkResolverCarryMode;

  const rawAccount = typeof p.account === 'string' ? p.account.trim() : DEFAULT_BULK_RESOLVER_LAUNCH_PROFILE.account;
  if (!rawAccount || !isLaunchAccountValue(rawAccount)) {
    return {
      ok: false,
      field: 'account',
      message:
        `account ${JSON.stringify(p.account)} is not a valid launch account value — ` +
        `use a pool account id, \`auto\` (gateway routing with failover), or \`default\` (the system credential).`,
    };
  }

  const trimmedModel = typeof p.model === 'string' ? p.model.trim() : '';
  const model = trimmedModel.length > 0 ? trimmedModel : null;
  if (model && model.length > 120) {
    return { ok: false, field: 'model', message: 'model must be at most 120 characters.' };
  }

  const trimmedEffort = typeof p.effort === 'string' ? p.effort.trim().toLowerCase() : '';
  const effort = trimmedEffort.length > 0 ? trimmedEffort : null;

  // composeLaunchModelSpec owns BOTH "effort needs a model" and "unrecognized
  // effort", and throws them as prose. Converting the throw into a structured
  // refusal keeps those rules stated exactly once.
  let composed: string | undefined;
  try {
    composed = composeLaunchModelSpec(model, effort);
  } catch (e) {
    return { ok: false, field: 'effort', message: e instanceof Error ? e.message : String(e) };
  }

  // No model ⇒ inherit the launcher default, which is the pre-configuration
  // behavior and the `claude` backend the resolver has always launched on.
  let backend: LaunchAgentBackend = 'claude';
  if (model) {
    const spec = validateCloudModelSpec(composed ?? model);
    if (!spec.ok) return { ok: false, field: 'model', message: spec.message };
    const inferred = launchAgentBackendForModel(model);
    if (!inferred) {
      return {
        ok: false,
        field: 'model',
        message:
          `\`${model}\` does not resolve to a single CLI backend, so the resolver cannot be paired with one. ` +
          `Pick a model from the launcher menu (${CLOUD_MODEL_MENU.map((c) => c.value).join('/')}), ` +
          `or a host-local \`provider/id\`.`,
      };
    }
    backend = inferred;
  }

  const effective: EffectiveBulkResolverLaunch = {
    model,
    effort: effort as ModelEffort | null,
    account: rawAccount,
    carry,
    backend,
  };
  // Preserve the compact legacy launch shape when no policy fields were posted;
  // the run store's dedicated automation_policy column supplies the default.
  if (automationMode !== undefined || minConfidence !== undefined) {
    effective.automationMode = automationMode ?? DEFAULT_BULK_AUTOMATION_POLICY.mode;
    effective.minConfidence = minConfidence ?? DEFAULT_BULK_AUTOMATION_POLICY.minConfidence;
  }
  return { ok: true, effective };
}

/** Output-reservation + startup-attachment headroom subtracted from the hard
    window before deriving the soft limit. */
export const COMPACTION_WINDOW_MARGIN_TOKENS = 10_000;
/** Agents may run ~20% past their SOFT limit before the hard window threatens
    (owner rule, context-trimming-tiers D-001) — the derived default keeps
    `limit × OVERSHOOT ≤ window − margin`. */
export const COMPACTION_OVERSHOOT_FACTOR = 1.2;
/** Floor for any stored/self-set compaction limit (mirrors
    config:set-compaction-limit's arg minimum). */
export const MIN_COMPACTION_LIMIT_TOKENS = 20_000;

/**
 * Preemptive compaction cap for `[1m]`-window sessions that are NOT named-fleet
 * members — i.e. ad-hoc/solo su sessions and fleet LEADERS. They run on the full
 * 1M window but papercusp compacts them below it to bound token spend.
 *
 * Current policy is 450k (owner directive 2026-09-21, interactive: "increase the
 * default context limit for ad-hoc su sessions and fleet leaders from 400 to
 * 450"). The ×1.2 overshoot (540k) stays well under the 1M − margin ceiling.
 * Fleet MEMBERS are governed by the separate, leaner
 * {@link COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP} and are unaffected.
 *
 * History: 500k (2026-07-02) → 400k (2026-07-03) → current. Keep the outgoing
 * value in {@link SUPERSEDED_1M_LEADER_CAPS} whenever this changes, or every
 * already-live session pinned at the old number is stranded — see that constant.
 */
export const COMPACTION_LIMIT_DEFAULT_1M_CAP = 450_000;

/** Leader/solo 1M-window role caps this platform has PREVIOUSLY derived — the
 * exact counterpart of {@link SUPERSEDED_1M_FLEET_MEMBER_CAPS} for the
 * non-fleet-member population, and it exists for the identical reason
 * (EI-22241751831038573): the watchdog's upward heal raises a stored limit only
 * when it equals the current derived seed or one of these, so raising the cap
 * without appending the outgoing value strands every already-live leader/solo
 * session at the old number. It no longer equals the new default, so it reads as
 * a deliberate override, and the lower-only branch cannot reach it because the
 * stale value sits BELOW the correct one.
 *
 * The member-side list was added when the 200k → 250k member raise produced
 * fifteen consecutive carry-respawns of one member; that fix was scoped to the
 * member cap and left this identical hole open for leaders and ad-hoc sessions.
 * The 400k → 450k raise of 2026-09-21 is the first change to exercise it.
 *
 * History: 500_000 (2026-07-02) → 400_000 (2026-07-03) → current
 * {@link COMPACTION_LIMIT_DEFAULT_1M_CAP}. APPEND the outgoing value here
 * whenever that cap changes; the current value is filtered out automatically. */
export const SUPERSEDED_1M_LEADER_CAPS: readonly number[] = [500_000, 400_000];

/**
 * Leaner `[1m]` DEFAULT for named-fleet MEMBERS: a member runs short
 * pull-item→work→complete loops whose state is cheap to reconstruct (it lives on
 * the work-item / carry-note), so more-frequent compactions cost little — while
 * every wake re-reads the whole context, so a smaller window directly cuts
 * per-turn cache spend. LEADERS keep the full COMPACTION_LIMIT_DEFAULT_1M_CAP:
 * long-lived supervision state is expensive to re-derive after compaction.
 *
 * The current 250k member policy is owner-directed, reversible headroom
 * (2026-09-02, WI-2142006) and was retained after the matched context-policy
 * comparison (measured-agent-productivity-2026-09-06 D-009). Keep historical
 * rationale in those decisions; this source comment describes only the policy
 * the constant enforces now. Previous derived values that the watchdog must
 * recognize remain encoded in SUPERSEDED_1M_FLEET_MEMBER_CAPS.
 *
 * This shapes the seeded DEFAULT (and, as the fleet-member ceiling in
 * clampCompactionLimit, caps a member's self-set) — a promotion to LEADER re-seeds
 * to COMPACTION_LIMIT_DEFAULT_1M_CAP (reseedLeaderCompactionLimit / P-009).
 *
 * SECOND-ORDER EFFECT, deliberate: the role cap only binds when it is LOWER than
 * the window derivation, so raising it un-pins backends whose real window derives
 * between 200k and 250k. A Codex member on the measured 258_400 window now seeds
 * 207_000 (its own derivation) instead of being held at 200_000 by this cap.
 */
export const COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP = 250_000;

/** Derive the maximum safe limit for a DELIBERATE runtime override from a
 * measured effective model window. Unlike the seeded default, this deliberately
 * does not impose the 450k leader/solo role cap: a self-set may use the wider
 * measured runway, while fleet members remain bounded by their current role cap. */
/**
 * The purely WINDOW-DERIVED limit, before any role cap or floor:
 * `floor((window − margin) / overshoot)`, floored to 1k for stable display.
 *
 * This is the only number the claim "the cap keeps limit × 1.2 under the model
 * window" is ever about. A ROLE cap ({@link COMPACTION_LIMIT_DEFAULT_1M_CAP})
 * is a separate, deliberate COST bound that sits far below it on a 1M window
 * (400,000 vs 825,000), so describing the two interchangeably states a
 * derivation that is arithmetically false: 400,000 × 1.2 = 480,000, nowhere
 * near 1,000,000. Callers that render a cap to a human MUST ask
 * {@link compactionCapBindingForWindow} which constraint actually bound
 * (EI-19914665525338044).
 */
function windowDerivedCompactionLimit(window: number): number {
  const finiteWindow = Number.isFinite(window) && window > 0 ? Math.floor(window) : MODEL_WINDOW_DEFAULT;
  const raw = (finiteWindow - COMPACTION_WINDOW_MARGIN_TOKENS) / COMPACTION_OVERSHOOT_FACTOR;
  return Math.floor(raw / 1000) * 1000;
}

export function selfSetCeilingForWindow(window: number, opts?: { fleetMember?: boolean }): number {
  const derived = windowDerivedCompactionLimit(window);
  const roleCap = opts?.fleetMember ? COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP : Number.POSITIVE_INFINITY;
  return Math.max(MIN_COMPACTION_LIMIT_TOKENS, Math.min(roleCap, derived));
}

/** Derive a safe seeded soft limit from a LIVE effective model window. This is
 * the backend-neutral twin of the spec-based resolver below and is load-bearing
 * for Codex, whose rollout reports 258400 after applying the CLI's 95% effective
 * window to the installed 272k model record. The role cap still wins when it is
 * lower than the window-derived limit. */
export function defaultCompactionLimitForWindow(window: number, opts?: { fleetMember?: boolean }): number {
  const roleCap = opts?.fleetMember ? COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP : COMPACTION_LIMIT_DEFAULT_1M_CAP;
  const derived = windowDerivedCompactionLimit(window);
  return Math.max(MIN_COMPACTION_LIMIT_TOKENS, Math.min(roleCap, derived));
}

/**
 * Which constraint actually produced {@link defaultCompactionLimitForWindow} —
 * so a caller rendering that cap to a human or an agent can state the TRUE
 * reason instead of assuming the window derivation always bound.
 *
 * - `model-window` — the `floor((window − margin) / 1.2)` derivation bound, so
 *   "the cap keeps limit × 1.2 under the model window" is accurate.
 * - `role-cap`     — a deliberate COST cap bound well below that derivation
 *   (450k leader/solo, 250k fleet member on a 1M window). The window sentence
 *   is FALSE here; the honest reason is spend, and a single session may still
 *   go higher via `config:set-compaction-limit` (see {@link selfSetCeilingForSpec}).
 * - `minimum`      — the window is so small that {@link MIN_COMPACTION_LIMIT_TOKENS}
 *   is what the caller actually gets.
 *
 * Derived from the same inputs as the cap itself rather than restated, so the
 * two cannot drift apart (EI-19914665525338044).
 */
export type CompactionCapBinding = 'model-window' | 'role-cap' | 'minimum';

export function compactionCapBindingForWindow(
  window: number,
  opts?: { fleetMember?: boolean },
): CompactionCapBinding {
  const roleCap = opts?.fleetMember ? COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP : COMPACTION_LIMIT_DEFAULT_1M_CAP;
  const derived = windowDerivedCompactionLimit(window);
  if (Math.min(roleCap, derived) < MIN_COMPACTION_LIMIT_TOKENS) return 'minimum';
  return roleCap < derived ? 'role-cap' : 'model-window';
}

/**
 * The model-derived default soft compaction limit for a spec — and the CEILING
 * a user/agent-set limit is clamped to (context-trimming-tiers D-001):
 * `floor((window − margin) / 1.2)`, floored to 1k for stable display.
 * 200k window → 158,000. EXCEPTION: a `[1m]`-carrying spec is capped at
 * {@link COMPACTION_LIMIT_DEFAULT_1M_CAP} — {@link COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP}
 * when `opts.fleetMember` (read the constants for current policy and
 * SUPERSEDED_1M_FLEET_MEMBER_CAPS for values live sessions may still carry) —
 * so it compacts preemptively despite the 1M window. Keyed on the `[1m]`
 * MARKER, not the family name: a bare `sonnet` / `opus` launch that skipped
 * normalization really runs a 200k auto-compact window in CC (live-verified
 * 2026-07-02), so its soft limit must be 158k — below CC's own ~167k auto
 * trigger — or papercusp never compacts cleanly and CC compacts mid-task
 * instead. `opts.fleetMember` (fleet_role != 'leader' on a named-fleet
 * presence row) shapes only the [1m] leg — role never changes a real-window
 * derivation.
 *
 * UNRESOLVABLE spec (null / empty) → the SAME [1m] default (450k leader/solo,
 * the current fleet-member cap),
 * NOT the conservative 200k → 158k (owner directive 2026-07-08, WI-3383). On
 * this fleet the default model is opus[1m], and a genuine small-window model is
 * ALWAYS explicitly specced (so it resolves to a real spec and derives its 158k
 * below). A truly-unknown spec is therefore an opus[1m] session — it must seed
 * 450k, never the haiku-sized 158k that mis-seeded manually-launched su sessions
 * (resolveModelSpecForOwner returns null when neither a `--model` in launch_argv
 * nor a settings.json model is found). Only null/empty lifts: a NON-null bare
 * `opus`/`sonnet` still derives 158k (the un-normalized 200k-window hazard above).
 */
export function defaultCompactionLimitForSpec(spec?: string | null, opts?: { fleetMember?: boolean }): number {
  if (derivesFrom1mWindow(spec)) {
    return defaultCompactionLimitForWindow(MODEL_WINDOW_1M, opts);
  }
  return defaultCompactionLimitForWindow(modelWindowForSpec(spec), opts);
}

/** Whether a spec derives its compaction limit from the 1M window: the `[1m]`
 * marker, or an absent/blank spec (which {@link defaultCompactionLimitForSpec}
 * treats as 1M rather than guessing a narrower one).
 *
 * Extracted so {@link supersededDerivedCompactionLimits} tests the SAME condition
 * the derivation uses instead of restating it — a second copy of this predicate is
 * exactly the drift that stranded the sessions EI-22241751831038573 documents. */
export function derivesFrom1mWindow(spec?: string | null): boolean {
  return spec == null || spec.trim() === '' || spec.includes('[1m]');
}

/** Fleet-member 1M-window role caps this platform has PREVIOUSLY derived, so the
 * watchdog's upward heal can still recognise a live session seeded under an older
 * policy as carrying a DERIVED value rather than a deliberate override.
 *
 * Why this list has to exist (EI-22241751831038573, measured 2026-09-03): the heal
 * raises a stored limit only when it equals the current derived seed or one of
 * these. Raising the cap therefore strands every already-live session at the old
 * number — it no longer equals the new default, so it reads as an override, and the
 * lower-only branch cannot reach it because the stale value sits BELOW the correct
 * one. Fifteen consecutive carry-respawns of one fleet member were traced to exactly
 * this: pinned at 200_000 against a true 1M window while the cap had moved to
 * 250_000, so every successor crossed the line within ~8 minutes and was cut again.
 *
 * History: 300_000 (2026-07-03) → 200_000 (owner directive 2026-07-19) → current
 * {@link COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP}. APPEND the outgoing value
 * here whenever that cap changes; the current value is filtered out automatically. */
export const SUPERSEDED_1M_FLEET_MEMBER_CAPS: readonly number[] = [300_000, 200_000];

/** Backend-aware twin of `defaultCompactionLimitForSpec` for a tier row. */
export function defaultCompactionLimitForTier(
  tier: Pick<ModelTier, 'spec' | 'contextWindow'>,
  opts?: { fleetMember?: boolean },
): number {
  return defaultCompactionLimitForWindow(modelWindowForTier(tier), opts);
}

/** Backend-aware twin of {@link compactionCapBindingForWindow} for a tier row —
 * why `defaultCompactionLimitForTier` landed where it did. */
export function compactionCapBindingForTier(
  tier: Pick<ModelTier, 'spec' | 'contextWindow'>,
  opts?: { fleetMember?: boolean },
): CompactionCapBinding {
  return compactionCapBindingForWindow(modelWindowForTier(tier), opts);
}

/**
 * Limits a SUPERSEDED policy once derived for this spec — numbers the SYSTEM
 * chose, not a human. Empty for a spec whose derivation never moved.
 *
 * WHY THIS EXISTS. The compaction watchdog's raise gate uses value-equality as a
 * provenance proxy: it heals a stored limit that is still exactly "the number
 * nobody chose", and leaves anything else alone as a deliberate override (D-006
 * leanness). That proxy silently breaks whenever a derivation CHANGES — every
 * live session still carrying the OLD derived value stops matching the new one,
 * so it reads as deliberate and becomes unraisable. The lower-only branch cannot
 * reach it either, because the stale value is BELOW the correct one.
 *
 * That is not hypothetical: it is exactly what WI-38347's own comment describes
 * ("a repair that only runs downhill converts a GOOD input into the unfixable
 * one"), and codex-1m-context-window-2026-08-17 reintroduced it sideways —
 * moving the extended-codex derivation 158,000 → the leader/solo role cap orphaned 13
 * live sessions at 158,000 (measured 2026-08-18). So a derivation change must
 * declare its previous value HERE, next to the policy that supersedes it, rather
 * than leaving the watchdog to hardcode a number whose meaning it cannot see.
 *
 * The risk this deliberately accepts is the one the raise gate already accepts:
 * a human who hand-set exactly this value is treated as un-chosen. Explicit
 * `--compaction-limit` / per-tier limits are protected by `explicit` provenance
 * upstream and never reach this test, whatever their value.
 */
export function supersededDerivedCompactionLimits(spec?: string | null, opts?: { fleetMember?: boolean }): number[] {
  // Before codex-1m-context-window-2026-08-17, modelWindowForSpec had no codex
  // branch: `[1m]` is a Claude-only marker and no codex spec carries it, so every
  // codex spec fell to the conservative MODEL_WINDOW_DEFAULT. A spec that is
  // extended TODAY therefore derived that fabricated-window value yesterday.
  const out: number[] = [];

  if (isCodexExtendedWindowSpec(spec)) {
    out.push(defaultCompactionLimitForWindow(MODEL_WINDOW_DEFAULT, opts));
  }

  // The counterpart for every backend that lands on the 1M FLEET-MEMBER cap
  // (EI-22241751831038573). The codex branch above was the first instance of this
  // failure and its fix was scoped to codex, which left the identical hole open for
  // the population the 200_000 → 250_000 cap raise then stranded.
  //
  // Keyed on the DERIVED SEED, not on the `[1m]` marker: a bare `gpt-5.6-luna:high`
  // carries no marker yet resolves to a 1M window through modelWindowForSpec, so a
  // marker test silently excludes an entire backend that can be stranded exactly the
  // same way. Asking "does this spec actually derive the 1M fleet-member cap?" cannot
  // drift from the derivation it is protecting.
  if (opts?.fleetMember && defaultCompactionLimitForSpec(spec, opts) === COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP) {
    out.push(...SUPERSEDED_1M_FLEET_MEMBER_CAPS);
  }

  // The LEADER/solo counterpart, keyed the same way on the derived seed rather
  // than on the `[1m]` marker. Without it the 400_000 → 450_000 raise of
  // 2026-09-21 would have stranded every already-live ad-hoc/leader session at
  // 400_000 — exactly the shape the member branch above was added to fix, on the
  // other half of the population.
  if (!opts?.fleetMember && defaultCompactionLimitForSpec(spec, opts) === COMPACTION_LIMIT_DEFAULT_1M_CAP) {
    out.push(...SUPERSEDED_1M_LEADER_CAPS);
  }

  // Guard against a policy that makes these equal: a value that is still the
  // CURRENT derivation is not superseded, and returning it here would be a no-op
  // at best and confusing at worst.
  const current = defaultCompactionLimitForSpec(spec, opts);
  return [...new Set(out)].filter((limit) => limit !== current);
}

/**
 * The ceiling a DELIBERATE self-set (`config:set-compaction-limit`) may reach —
 * as opposed to `defaultCompactionLimitForSpec`, which is what a session is
 * SEEDED with.
 *
 * Those two were one number until 2026-08-08, and conflating them was a real
 * defect: `COMPACTION_LIMIT_DEFAULT_1M_CAP` served as both the seeded default
 * AND the hard ceiling, so a `[1m]` session that deliberately asked for more
 * runway was silently clamped back to the default and had no way to say "this
 * task genuinely needs a wider window" — the exact request the tool exists to
 * serve ("Tune how large a session's context grows before it self-compacts —
 * raise it for wide-context work"). Owner directive [owner 2026-08-08] — "set
 * your own token limit to 1m … I want to do a lot of research in this session"
 * — is what surfaced it.
 *
 * The DEFAULT is deliberately unchanged by THIS knob: every session still SEEDS
 * at its role cap (450k leader/solo), so the fleet-wide cost profile the owner
 * directives set is untouched by a self-set ceiling widening. Only
 * an explicit, per-session, audited self-set can now exceed it, and only up to
 * the real window-derived maximum (1M window ⇒ 825,000) — the same
 * `floor((window − margin) / overshoot)` derivation every non-`[1m]` spec
 * already used, rather than a second hand-picked magic number.
 *
 * ⚠ Cost note, stated where the knob lives: raising this is NOT free. A session
 * parked near 825k pays that whole window as a cache read on EVERY turn, which
 * is precisely the spend the 450k default was tuned to bound. It is the right
 * trade for a long single-threaded research/audit session; it is the wrong
 * trade for a drain loop.
 *
 * FLEET MEMBERS keep the current role ceiling: a member's limit is
 * governed by its leader by design (see
 * COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP), so a member self-raising past
 * its role cap would route around that.
 */
export function selfSetCeilingForSpec(spec?: string | null, opts?: { fleetMember?: boolean }): number {
  if (opts?.fleetMember) return defaultCompactionLimitForSpec(spec, opts);
  // Extended Codex models do not carry Claude's [1m] marker. Derive every
  // deliberate self-set from its window, never from the capped seeded default.
  const window = derivesFrom1mWindow(spec) ? MODEL_WINDOW_1M : modelWindowForSpec(spec);
  return selfSetCeilingForWindow(window, opts);
}

/**
 * Clamp a requested compaction limit into [MIN, ceiling], where the ceiling is
 * `defaultCompactionLimitForSpec(spec, opts)` for a SEEDED limit and
 * `selfSetCeilingForSpec(spec, opts)` when `opts.selfSet` marks a deliberate
 * per-session request (see that function for why the two differ).
 *
 * `opts.fleetMember` applies the leaner fleet-member ceiling (250k vs a leader's
 * 450k) — pass it wherever the requester's fleet role is known, so an explicit
 * request cannot exceed the cap its role is governed by
 * (per-member-declarative-launch-specs P-005). Omitted ⇒ the leader/solo ceiling,
 * which is the pre-existing behavior for every caller that has no role context.
 * `fleetMember` still wins over `selfSet`.
 */
export function clampCompactionLimit(
  limit: number,
  spec?: string | null,
  opts?: { fleetMember?: boolean; selfSet?: boolean },
): number {
  const cap = opts?.selfSet ? selfSetCeilingForSpec(spec, opts) : defaultCompactionLimitForSpec(spec, opts);
  return Math.min(Math.max(Math.floor(limit), MIN_COMPACTION_LIMIT_TOKENS), cap);
}

/** Clamp an explicit tier limit against the backend-catalog window when one
 * was resolved, falling back to the existing spec-only policy otherwise. */
export function clampCompactionLimitForTier(
  limit: number,
  tier: Pick<ModelTier, 'spec' | 'contextWindow'>,
  opts?: { fleetMember?: boolean },
): number {
  const cap = defaultCompactionLimitForTier(tier, opts);
  return Math.min(Math.max(Math.floor(limit), MIN_COMPACTION_LIMIT_TOKENS), cap);
}
