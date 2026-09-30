/**
 * Agent backend configuration — which CLI (claude-code or omp) the
 * operator + harness drive, plus optional binary/path overrides.
 *
 * Persisted at <papercuspRoot>/agent/config.json so the setting is
 * per-workspace (matches how credentials.json + oracle/* settings are
 * scoped). On read it falls back to env vars; on write it both updates
 * the file AND mirrors into `process.env` so subsequent in-process
 * spawns (Architect chat, delegate-summary, runAgentChat) pick up the
 * change without a server restart.
 *
 * Notes:
 *   - Headless harness runs (`run.sh` invoked from a terminal outside
 *     the operator) DON'T inherit process.env from this server. Those
 *     callers either set $AGENT_BACKEND/$AGENT_CMD themselves or rely
 *     on the auto-inference from the binary name. The settings page
 *     surfaces this caveat to the user.
 *   - Per-role model overrides live alongside in `models` and feed
 *     the orchestrator's existing config.json `models.<role>` lookup
 *     (see invoke.ts — config wins; this file is the user-level
 *     default).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { registerOverrideConcern, type OverrideEntry } from './config-overrides/registry';
import { papercuspPath } from './papercusp-root';
import {
  AGENT_BACKENDS,
  BULK_RESOLVER_CARRY_MODES,
  BULK_RESOLVER_PROFILE_KINDS,
  MODEL_EFFORT_LEVELS,
  SURFACE_KEYS,
  defaultBulkResolverLaunchProfiles,
  isLaunchAccountValue,
  isValidModelSpec,
  clampCompactionLimitForTier,
  type AgentBackend,
  type BulkResolverLaunchProfile,
  type BulkResolverLaunchProfiles,
  type BulkResolverProfileKind,
  type ModelTier,
  type SurfaceKey,
} from './agent-config-constants';
import {
  BULK_AUTOMATION_MODES,
  BULK_CONFIDENCE_LEVELS,
  isBulkAutomationMode,
  isBulkConfidence,
} from './attention/bulk-dispositions';

// Client-safe constants + types live in `agent-config-constants.ts` (a leaf
// module with no Node/server imports) so the /settings/agent client page can
// import them without dragging this fs/PG module into the renderer. Re-exported
// here for backward compat — existing server callers still `import … from
// './agent-config'`.
export { AGENT_BACKENDS, SURFACE_KEYS };
export type {
  AgentBackend,
  BulkResolverLaunchProfile,
  BulkResolverLaunchProfiles,
  BulkResolverProfileKind,
  ModelTier,
  SurfaceKey,
};

export interface AgentConfig {
  /** Which backend to drive. 'auto' lets resolveBackend infer from the
      binary name; explicit values force-select. */
  backend: AgentBackend | 'auto';
  /** Override the agent binary + flags. e.g. 'omp -p' or
      '/usr/local/bin/claude -p --model sonnet' or 'omp -p --model haiku'.
      Empty = use defaults (omp -p). */
  cmd: string;
  /** Per-role model overrides (e.g. `{ worker: 'haiku', reviewer: 'opus' }`).
      Forwarded to the orchestrator via $AGENT_MODELS env (JSON). */
  models: Record<string, string>;
  /** Per-role backend overrides for spawned fleet/operational roles. A role
      absent from the map inherits the global backend / command. Mirrored to
      $AGENT_ROLE_BACKENDS and applied by buildInvokeOnce before the role model
      is appended. */
  roleBackends?: Record<string, AgentBackend>;
  /** Per-surface backend overrides for the in-app brains. A surface absent
      from the map inherits the global `backend`. Lets you run e.g. oracle on
      claude-code while the operator stays on omp. Resolved per-call via
      `surfaceBackend()` and passed as RunAgentChatOptions.backend — NOT
      mirrored to env (env carries only the single global backend). The
      orchestrator's harness-pipeline agents are configured separately via
      .papercusp/config.json `aiBackend.roles`. Optional: legacy rows/literals
      omit it; `readAgentConfig` always populates it from `parseBackends`. */
  backends?: Partial<Record<SurfaceKey, AgentBackend>>;
  /** Per-surface MODEL overrides — the companion to `backends` (OQ3). A
      surface that runs on a non-default backend needs a model id that
      backend can resolve (the operator brain's default
      `anthropic/claude-opus-4-7` won't resolve on codex). A surface absent
      from the map inherits whatever the surface's own default model logic
      picks. Resolved per-call via `surfaceModel()` and passed as
      RunAgentChatOptions.model. Distinct from `models` above, which is the
      per-ROLE map forwarded to the orchestrator pipeline via env. */
  surfaceModels?: Partial<Record<SurfaceKey, string>>;
  /** User-defined model-tier menu, ordered WEAKEST → STRONGEST (the order is
      the strength ranking the floor/ceiling clamp uses). Empty = the
      committed DEFAULT_MODEL_TIERS (quick/standard/deep/luna/max). The queen's
      cup:spawn `tier` arg resolves against this menu — see
      fleet/model-tiers.ts (queen-model-tier-selection-2026-06-11). */
  tiers?: ModelTier[];
  /** Per-role tier CEILING (role → tier name): the strongest tier the queen
      may pick for that role. Absent = the strongest tier is allowed. The
      FLOOR is not configured — it derives from the role's resolved default
      model (a tier pick can escalate a role, never downgrade it). */
  tierCeilings?: Record<string, string>;
  /** Preferred Linux terminal emulator for visible launches (for example
      `gnome-terminal` or `alacritty`). Empty/absent = inherit the host's
      `$TERMINAL`, then use Papercusp's existing desktop-aware auto-detection.
      Stored per workspace; never changes another installation's default. */
  terminal?: string;
  /** Separate next-run defaults for the Inbox and Plans bulk resolvers.
      Optional only for legacy stored rows/older clients; `readAgentConfig`
      always returns both normalized profiles. */
  resolverProfiles?: BulkResolverLaunchProfiles;
}

const DEFAULT_CONFIG: AgentConfig = {
  // A workspace with no saved agent-config row inherits this. claude-code is
  // the repo's canonical backend (CLAUDE.md) and the host's boot default
  // ($AGENT_BACKEND=claude-code); defaulting to 'omp' here silently launched
  // omp agents in any freshly-created workspace (e.g. the New-Plan button —
  // launch-su.ts resolves an agent-less launch via effectiveBackend(readAgentConfig())),
  // ignoring the configured/boot backend. Owner ask 2026-06-18.
  backend: 'claude-code',
  cmd: '',
  models: {},
  roleBackends: {},
  backends: {},
  surfaceModels: {},
  tiers: [],
  tierCeilings: {},
  terminal: '',
  resolverProfiles: defaultBulkResolverLaunchProfiles(),
};

export async function readAgentConfig(): Promise<AgentConfig> {
  const raw = await readOperatorState<Partial<AgentConfig>>('operator_agent_config');
  if (!raw) return { ...DEFAULT_CONFIG, resolverProfiles: defaultBulkResolverLaunchProfiles() };
  return {
    backend: validBackend(raw.backend) ?? DEFAULT_CONFIG.backend,
    cmd: typeof raw.cmd === 'string' ? raw.cmd : '',
    models:
      raw.models && typeof raw.models === 'object' && !Array.isArray(raw.models)
        ? Object.fromEntries(
            Object.entries(raw.models)
              .filter(([k, v]) => typeof k === 'string' && typeof v === 'string')
              .map(([k, v]) => [k, v as string]),
          )
        : {},
    roleBackends: parseRoleBackends(raw.roleBackends),
    backends: parseBackends(raw.backends),
    surfaceModels: parseSurfaceModels(raw.surfaceModels),
    tiers: parseTiers(raw.tiers),
    tierCeilings: parseTierCeilings(raw.tierCeilings, raw.tiers),
    terminal: parseTerminalEmulator(raw.terminal),
    resolverProfiles: parseBulkResolverLaunchProfiles(raw.resolverProfiles),
  };
}

/** Normalize one stored resolver profile without letting one malformed field
 * erase the other saved defaults. Reads are deliberately lenient; the POST
 * route calls `bulkResolverLaunchProfilesProblem` first and stays strict. */
function parseBulkResolverLaunchProfile(raw: unknown, fallback: BulkResolverLaunchProfile): BulkResolverLaunchProfile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...fallback };
  const value = raw as Record<string, unknown>;
  const rawModel = value.model;
  const model =
    rawModel === null
      ? null
      : typeof rawModel === 'string' && rawModel.trim() && rawModel.trim().length <= 120
        ? rawModel.trim()
        : fallback.model;
  const rawEffort = value.effort;
  const effort =
    rawEffort === null
      ? null
      : typeof rawEffort === 'string' &&
          (MODEL_EFFORT_LEVELS as readonly string[]).includes(rawEffort.trim().toLowerCase())
        ? (rawEffort.trim().toLowerCase() as BulkResolverLaunchProfile['effort'])
        : fallback.effort;
  const rawAccount = value.account;
  const account =
    typeof rawAccount === 'string' && isLaunchAccountValue(rawAccount.trim()) ? rawAccount.trim() : fallback.account;
  const carry = (BULK_RESOLVER_CARRY_MODES as readonly unknown[]).includes(value.carry)
    ? (value.carry as BulkResolverLaunchProfile['carry'])
    : fallback.carry;
  const automationMode = isBulkAutomationMode(value.automationMode)
    ? value.automationMode
    : fallback.automationMode;
  const minConfidence = isBulkConfidence(value.minConfidence)
    ? value.minConfidence
    : fallback.minConfidence;
  return {
    model,
    effort: model ? effort : null,
    account,
    carry,
    ...(automationMode ? { automationMode } : {}),
    ...(minConfidence ? { minConfidence } : {}),
  };
}

/**
 * Normalize the additive settings document. `fallback` makes a partial update
 * preserve the other pane instead of resetting it to defaults; ordinary reads
 * omit it and inherit the backward-compatible pre-feature behavior.
 */
export function parseBulkResolverLaunchProfiles(
  raw: unknown,
  fallback: BulkResolverLaunchProfiles = defaultBulkResolverLaunchProfiles(),
): BulkResolverLaunchProfiles {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(
    BULK_RESOLVER_PROFILE_KINDS.map((kind) => [kind, parseBulkResolverLaunchProfile(value[kind], fallback[kind])]),
  ) as BulkResolverLaunchProfiles;
}

/** Strict write-side validation for the additive resolver-profile document. */
export function bulkResolverLaunchProfilesProblem(
  raw: unknown,
  fallback: BulkResolverLaunchProfiles = defaultBulkResolverLaunchProfiles(),
): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'must be an object keyed by run kind';
  const value = raw as Record<string, unknown>;
  const unknownKinds = Object.keys(value).filter(
    (kind) => !(BULK_RESOLVER_PROFILE_KINDS as readonly string[]).includes(kind),
  );
  if (unknownKinds.length > 0) return `unknown run kind ${unknownKinds[0]}`;
  const allowedFields = new Set(['model', 'effort', 'account', 'carry', 'automationMode', 'minConfidence']);
  for (const kind of BULK_RESOLVER_PROFILE_KINDS) {
    if (!(kind in value)) continue;
    const rawProfile = value[kind];
    if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) {
      return `${kind} must be an object`;
    }
    const profile = rawProfile as Record<string, unknown>;
    const unknownField = Object.keys(profile).find((field) => !allowedFields.has(field));
    if (unknownField) return `${kind}.${unknownField} is not a resolver launch setting`;
    if (
      'model' in profile &&
      profile.model !== null &&
      (typeof profile.model !== 'string' || !profile.model.trim() || profile.model.trim().length > 120)
    ) {
      return `${kind}.model must be null or a non-empty model id up to 120 characters`;
    }
    if (
      'effort' in profile &&
      profile.effort !== null &&
      (typeof profile.effort !== 'string' ||
        !(MODEL_EFFORT_LEVELS as readonly string[]).includes(profile.effort.trim().toLowerCase()))
    ) {
      return `${kind}.effort must be null or one of ${MODEL_EFFORT_LEVELS.join('|')}`;
    }
    if (
      'account' in profile &&
      (typeof profile.account !== 'string' || !isLaunchAccountValue(profile.account.trim()))
    ) {
      return `${kind}.account is not a valid launch account value`;
    }
    if ('carry' in profile && !(BULK_RESOLVER_CARRY_MODES as readonly unknown[]).includes(profile.carry)) {
      return `${kind}.carry must be warm or cold`;
    }
    if ('automationMode' in profile && !isBulkAutomationMode(profile.automationMode)) {
      return `${kind}.automationMode must be one of ${BULK_AUTOMATION_MODES.join('|')}`;
    }
    if ('minConfidence' in profile && !isBulkConfidence(profile.minConfidence)) {
      return `${kind}.minConfidence must be one of ${BULK_CONFIDENCE_LEVELS.join('|')}`;
    }
    const effectiveModel = 'model' in profile ? profile.model : fallback[kind].model;
    const effectiveEffort = 'effort' in profile ? profile.effort : fallback[kind].effort;
    if (effectiveEffort !== null && effectiveEffort !== undefined && effectiveModel === null) {
      return `${kind}.effort requires an explicit model`;
    }
  }
  return null;
}

/** A terminal preference is a binary name, not a shell command. Keeping the
    stored value command-free lets console-spawn safely resolve it on PATH. */
export function parseTerminalEmulator(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const value = raw.trim();
  return value.length <= 80 && /^[A-Za-z0-9._+-]+$/.test(value) ? value : '';
}

/** Validate the stored tier menu: an array of { name, spec, backend?,
    compactionLimit? } with a non-empty lowercase-unique name, a syntactically
    valid model spec, an optional known backend, and an optional per-tier soft
    compaction limit (clamped to the spec's model-derived ceiling). Invalid
    entries are dropped (absence → DEFAULT_MODEL_TIERS at resolution time); an
    invalid backend/limit value drops to inherit rather than killing the row. */
export function parseTiers(raw: unknown): ModelTier[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelTier[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof (entry as ModelTier).name === 'string' ? (entry as ModelTier).name.trim() : '';
    const spec = typeof (entry as ModelTier).spec === 'string' ? (entry as ModelTier).spec.trim() : '';
    const backend = (entry as ModelTier).backend;
    const rawWhen = (entry as ModelTier).when;
    const when = typeof rawWhen === 'string' ? rawWhen.trim() : '';
    const key = name.toLowerCase();
    if (!name || !spec || seen.has(key) || !isValidModelSpec(spec)) continue;
    seen.add(key);
    // Optional per-tier soft compaction limit (context-trimming-tiers D-002):
    // a non-number drops the FIELD (→ model-derived default at resolution),
    // never the row; a number is clamped to the tier's SEEDED default (D-001 —
    // the ceiling IS that default). That is `limit × 1.2 ≤ window − margin`
    // only when the window derivation binds; where a role COST cap binds first
    // the ceiling is lower than the window would allow (EI-19914665525338044).
    const rawWindow = (entry as ModelTier).contextWindow;
    const contextWindow =
      typeof rawWindow === 'number' && Number.isFinite(rawWindow) && rawWindow > 0 ? Math.floor(rawWindow) : undefined;
    const rawLimit = (entry as ModelTier).compactionLimit;
    const compactionLimit =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit)
        ? clampCompactionLimitForTier(rawLimit, { spec, contextWindow })
        : undefined;
    out.push({
      name,
      spec,
      ...((AGENT_BACKENDS as readonly string[]).includes(backend as string) ? { backend } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      // The queen-facing one-liner; capped so a pasted essay can't bloat
      // every queen launch prompt.
      ...(when ? { when: when.slice(0, 300) } : {}),
      ...(compactionLimit !== undefined ? { compactionLimit } : {}),
    });
  }
  return out;
}

/** Validate the per-role ceiling map: role → tier name. A ceiling naming a
    tier absent from the stored menu is dropped (when the menu is empty the
    names are checked against nothing — resolution ignores unknown ceilings
    anyway, but dropping here keeps the stored config self-consistent). */
export function parseTierCeilings(raw: unknown, rawTiers?: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const tiers = parseTiers(rawTiers);
  const names = new Set(tiers.map((t) => t.name.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [role, tier] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof role !== 'string' || !role.trim() || typeof tier !== 'string' || !tier.trim()) continue;
    if (names.size > 0 && !names.has(tier.trim().toLowerCase())) continue;
    out[role.trim()] = tier.trim();
  }
  return out;
}

/** Validate the per-role backend map: any non-empty role key mapped to a
    concrete subprocess backend. Unknown backend values are dropped. */
export function parseRoleBackends(raw: unknown): Record<string, AgentBackend> {
  const out: Record<string, AgentBackend> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [role, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = role.trim();
    if (key && (v === 'omp' || v === 'claude-code' || v === 'codex')) {
      out[key] = v;
    }
  }
  return out;
}

/** Validate the per-surface backend map: keep only known surface keys
    mapped to concrete (non-'auto') backends. Unknown keys / invalid
    backends are dropped silently — absence means "inherit the global". */
export function parseBackends(raw: unknown): Partial<Record<SurfaceKey, AgentBackend>> {
  const out: Partial<Record<SurfaceKey, AgentBackend>> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if ((SURFACE_KEYS as readonly string[]).includes(k) && (v === 'omp' || v === 'claude-code' || v === 'codex')) {
      out[k as SurfaceKey] = v;
    }
  }
  return out;
}

/** Validate the per-surface model map (OQ3): known surface keys mapped to
    non-empty string model ids. Unknown keys / non-string values dropped. */
export function parseSurfaceModels(raw: unknown): Partial<Record<SurfaceKey, string>> {
  const out: Partial<Record<SurfaceKey, string>> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if ((SURFACE_KEYS as readonly string[]).includes(k) && typeof v === 'string' && v.trim()) {
      out[k as SurfaceKey] = v.trim();
    }
  }
  return out;
}

export async function writeAgentConfig(cfg: AgentConfig): Promise<AgentConfig> {
  await writeOperatorState('operator_agent_config', cfg);
  applyToProcessEnv(cfg);
  await writeShellEnvFile(cfg).catch(() => {
    /* best-effort; non-fatal */
  });
  return cfg;
}

/**
 * Mirror saved config to a shell-sourceable file at
 * <papercuspRoot>/agent/env.sh. Headless `run.sh` invocations
 * launched from a terminal outside the operator process source this
 * file so the user's /settings/agent toggle reaches the orchestrator
 * without manual export. run.sh's defaults still apply if the file is
 * absent or empty.
 *
 * Generates only `export` lines for set values — empty/auto values are
 * unset to allow run.sh's own fallback chain to kick in.
 */
export async function writeShellEnvFile(cfg: AgentConfig): Promise<string> {
  const path = papercuspPath('agent', 'env.sh');
  const lines: string[] = [
    '# Auto-generated by /settings/agent. Source from run.sh:',
    '#   [ -f "$HOME/.papercusp/agent/env.sh" ] && . "$HOME/.papercusp/agent/env.sh"',
    '# Edits will be overwritten on the next save.',
  ];
  // EI-337: an empty config value emits NO line (neither export nor unset) —
  // an `unset` here actively stripped the sourcing shell's own exported value
  // (.env.local, user exports), the same clobber applyToProcessEnv had.
  // Empty = "no user override → the shell/run.sh defaults stand".
  if (cfg.backend !== 'auto') {
    lines.push(`export AGENT_BACKEND=${shQuote(cfg.backend)}`);
  }
  if (cfg.cmd && cfg.cmd.trim()) {
    lines.push(`export AGENT_CMD=${shQuote(cfg.cmd.trim())}`);
  }
  if (Object.keys(cfg.models).length > 0) {
    lines.push(`export AGENT_MODELS=${shQuote(JSON.stringify(cfg.models))}`);
  }
  if (Object.keys(cfg.roleBackends ?? {}).length > 0) {
    lines.push(`export AGENT_ROLE_BACKENDS=${shQuote(JSON.stringify(cfg.roleBackends))}`);
  }
  if (cfg.terminal?.trim()) {
    lines.push(`export TERMINAL=${shQuote(cfg.terminal.trim())}`);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.join('\n') + '\n', { mode: 0o644 });
  return path;
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The agent env vars exactly as the process BOOTED with (.env.local via the
 * systemd unit, the shell, etc.), captured once at module load — i.e. before
 * any writeAgentConfig could have mutated process.env. The EI-337 fix's
 * ground truth: "empty config value" must mean "revert to the host's boot
 * default", not "delete whatever the host was booted with".
 */
const BOOT_AGENT_ENV: Readonly<
  Record<'AGENT_BACKEND' | 'AGENT_CMD' | 'AGENT_MODELS' | 'AGENT_ROLE_BACKENDS' | 'TERMINAL', string | undefined>
> = {
  AGENT_BACKEND: process.env.AGENT_BACKEND,
  AGENT_CMD: process.env.AGENT_CMD,
  AGENT_MODELS: process.env.AGENT_MODELS,
  AGENT_ROLE_BACKENDS: process.env.AGENT_ROLE_BACKENDS,
  TERMINAL: process.env.TERMINAL,
};

function restoreBootEnv(key: keyof typeof BOOT_AGENT_ENV): void {
  const boot = BOOT_AGENT_ENV[key];
  if (boot === undefined) delete process.env[key];
  else process.env[key] = boot;
}

/**
 * Mirror saved config into process.env so in-process spawns pick up
 * the change immediately. Called automatically on writeAgentConfig and
 * once at server startup (call applyToProcessEnv(readAgentConfig())
 * from a hot path; we don't have a single startup hook).
 *
 * EI-337: an EMPTY config value restores the BOOT-time env value rather than
 * deleting it. Deleting meant any settings save with cmd:''/models:{} (the
 * usual page state) silently stripped the host's .env.local-provided
 * AGENT_CMD/AGENT_MODELS until the next restart — observed live 2026-06-11:
 * bee spawns fell from the configured claude command to `omp -p` and produced
 * empty output. Empty = "no user override → host default", not "unset".
 */
export function applyToProcessEnv(cfg: AgentConfig): void {
  if (cfg.backend === 'auto') {
    restoreBootEnv('AGENT_BACKEND');
  } else {
    process.env.AGENT_BACKEND = cfg.backend;
  }
  if (cfg.cmd && cfg.cmd.trim()) {
    process.env.AGENT_CMD = cfg.cmd.trim();
  } else {
    restoreBootEnv('AGENT_CMD');
  }
  if (Object.keys(cfg.models).length > 0) {
    process.env.AGENT_MODELS = JSON.stringify(cfg.models);
  } else {
    restoreBootEnv('AGENT_MODELS');
  }
  if (Object.keys(cfg.roleBackends ?? {}).length > 0) {
    process.env.AGENT_ROLE_BACKENDS = JSON.stringify(cfg.roleBackends);
  } else {
    restoreBootEnv('AGENT_ROLE_BACKENDS');
  }
  if (cfg.terminal?.trim()) {
    process.env.TERMINAL = cfg.terminal.trim();
  } else {
    restoreBootEnv('TERMINAL');
  }
}

function validBackend(v: unknown): AgentConfig['backend'] | undefined {
  if (v === 'claude-code' || v === 'omp' || v === 'codex' || v === 'auto') return v;
  return undefined;
}

/**
 * [EI-727] Every autonomous fire path builds its child-process command as
 * `AGENT_CMD ?? CLAUDE ?? 'omp -p'` (harness-invoke-once.ts, harness-launch.ts,
 * scoper/supervisor-actions.ts). When NEITHER env var is set, every Queen/bee/worker
 * turn silently falls back to that hardcoded last-resort default — which has been
 * OBSERVED to hang indefinitely / exit 0 with completely empty output on a host with
 * no reachable provider credentials (the worst failure mode for autonomy: it looks
 * alive, rc=0 in run.log, while doing nothing). Pure predicate (env map in, message
 * or null out) called once at boot, right after config hydration, so a
 * misconfigured host fails LOUD before the first wake burns a turn discovering it.
 */
export function agentCmdBootWarning(env: Partial<Pick<NodeJS.ProcessEnv, 'AGENT_CMD' | 'CLAUDE'>>): string | null {
  if (env.AGENT_CMD || env.CLAUDE) return null;
  return (
    'AGENT_CMD/CLAUDE are BOTH unset — autonomous agent turns on this host will fall ' +
    "back to the hardcoded default 'omp -p', which is UNVERIFIED here and has been " +
    'observed to hang / produce completely empty rc=0 output when unconfigured (EI-727). ' +
    "Set AGENT_CMD (e.g. 'claude -p') via .env.local or the agent-config settings page " +
    'before relying on autonomous Queen/bee/worker turns on this host.'
  );
}

/**
 * Resolve the backend that would actually be driven right now, collapsing
 * `'auto'` to a concrete `'claude-code' | 'omp'` the same way the harness's
 * `resolveAgentBackend` does: explicit config wins; otherwise infer from the
 * binary name in `cmd` / $AGENT_CMD / $CLAUDE_CMD, defaulting to omp.
 *
 * Shared by the /agent-config GET snapshot and the /agent-config/test probe
 * so the "Test current backend" button exercises the same backend the user
 * actually selected.
 */
export function effectiveBackend(cfg: AgentConfig): AgentBackend {
  if (cfg.backend !== 'auto') return cfg.backend;
  const cmd = (cfg.cmd || process.env.AGENT_CMD || process.env.CLAUDE_CMD || 'omp').trim();
  const first = cmd.split(/\s+/).filter(Boolean)[0] ?? '';
  if (/(?:^|\/)(omp|pi)$/.test(first)) return 'omp';
  if (/(?:^|\/)claude$/.test(first)) return 'claude-code';
  if (/(?:^|\/)codex$/.test(first)) return 'codex';
  return 'omp';
}

/**
 * The per-surface backend override for an in-app brain, or `undefined` when
 * the surface inherits the global backend. Pass the result straight to
 * `RunAgentChatOptions.backend`: `undefined` lets `runAgentChat` fall back to
 * `$AGENT_BACKEND` (the global pick `applyToProcessEnv` mirrors from config).
 * Best-effort — returns `undefined` on any read error so the call site
 * degrades to the global backend rather than throwing on the hot path.
 */
export async function surfaceBackend(surface: SurfaceKey): Promise<AgentBackend | undefined> {
  try {
    const cfg = await readAgentConfig();
    return cfg.backends?.[surface];
  } catch {
    return undefined;
  }
}

/** Per-surface model override (OQ3 companion to surfaceBackend). Returns
    the configured model id for the surface, or undefined to inherit the
    surface's own default. Pass straight to RunAgentChatOptions.model. */
export async function surfaceModel(surface: SurfaceKey): Promise<string | undefined> {
  try {
    const cfg = await readAgentConfig();
    return cfg.surfaceModels?.[surface];
  } catch {
    return undefined;
  }
}

/** Revert the agent backend config to baked defaults (clears every override). Returns the
    default config. The override concern's reset — also re-mirrors env/shell to the boot state. */
export async function resetAgentConfig(): Promise<AgentConfig> {
  return writeAgentConfig({ ...DEFAULT_CONFIG });
}

/** True when a value diverges from the agent-config default (scalars by ===, the maps/array by
    "non-empty", since their default is empty ⇒ inherit). Keeps the diff readable: one entry per
    overridden field rather than a deep key-by-key blowout of the nested maps. */
function agentConfigOverrides(cfg: AgentConfig): OverrideEntry[] {
  const out: OverrideEntry[] = [];
  if (cfg.backend !== DEFAULT_CONFIG.backend) {
    out.push({ key: 'backend', effective: cfg.backend, default: DEFAULT_CONFIG.backend, layer: 'pg-settings' });
  }
  if (cfg.cmd !== DEFAULT_CONFIG.cmd) {
    out.push({ key: 'cmd', effective: cfg.cmd, default: DEFAULT_CONFIG.cmd, layer: 'pg-settings' });
  }
  for (const k of ['models', 'roleBackends', 'backends', 'surfaceModels', 'tierCeilings'] as const) {
    const v = cfg[k] ?? {};
    if (Object.keys(v).length > 0) out.push({ key: k, effective: v, default: {}, layer: 'pg-settings' });
  }
  if ((cfg.tiers?.length ?? 0) > 0) out.push({ key: 'tiers', effective: cfg.tiers, default: [], layer: 'pg-settings' });
  if ((cfg.terminal ?? '') !== DEFAULT_CONFIG.terminal) {
    out.push({
      key: 'terminal',
      effective: cfg.terminal ?? '',
      default: DEFAULT_CONFIG.terminal ?? '',
      layer: 'pg-settings',
    });
  }
  return out;
}

// Self-register as a runtime-config override concern (P-024 registry / sentinel-herald P-037):
// the agent backend/cmd + per-role/per-surface model+backend maps show up in
// config:list-overrides, and config:reset-overrides reverts them to DEFAULT_CONFIG.
registerOverrideConcern({
  name: 'agent-config',
  description:
    'agent backend + cmd + terminal + per-role/per-surface model & backend overrides (operator_agent_config)',
  diff: async () => agentConfigOverrides(await readAgentConfig()),
  capture: () => readAgentConfig(),
  reset: () => resetAgentConfig(),
  restore: (snap) => writeAgentConfig(snap as AgentConfig).then(() => {}),
});
