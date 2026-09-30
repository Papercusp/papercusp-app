/**
 * Canonical model-window + launch-budget resolver shared by PSU bootstrap,
 * launcher preflight, and session-port preparation. Keep policy here: callers
 * provide facts (model/backend/live override), then consume the returned
 * versioned budget instead of independently guessing 200k vs 1M.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export const MODEL_CONTEXT_BUDGET_VERSION = 1;
export const RUNTIME_OVERHEAD_TOKENS = Object.freeze({ full: 152_000, trimmed: 50_000 });
export const DEFAULT_CONTEXT_WINDOWS = Object.freeze({ claude: 200_000, codex: 272_000, omp: 200_000 });
export const MAX_LAUNCH_CONTEXT_BYTES = 1024 * 1024;

const CODEX_REASONING_EFFORT_RE = /:(low|medium|high|xhigh|max)$/i;

/** Strip provider/decorative selectors before comparing a Codex model to policy.
 * Codex callers use both `provider/id` and `id:effort` (and a few historical
 * launch paths append a `[1m]` marker).  The deny decision must not depend on
 * which of those presentation forms happened to reach the boundary. */
function codexPolicyBaseId(model) {
  let value = String(model ?? '').trim();
  if (!value) return '';
  const slash = value.indexOf('/');
  if (slash > 0) value = value.slice(slash + 1);
  // Effort is an open-ended presentation suffix at this boundary.  Do not
  // limit the deny guard to today's known effort enum (`ultra` and future
  // levels must not become a way around a retired model id).
  value = value.replace(/\[[^\]]+\]$/i, '');
  // Normalize aliases BEFORE stripping a trailing colon: `chatgpt:<id>` uses
  // its colon as part of the alias, while native ids use it for an effort (or
  // an open-ended future suffix).  Doing this in the opposite order lets
  // `chatgpt:5.3-codex-spark` evade the deny list as the bare `chatgpt` token.
  value = normalizeCodexCliModel(value);
  value = value.replace(/:[^:]+$/i, '').replace(/\[[^\]]+\]$/i, '');
  return value.toLowerCase();
}

/**
 * Managed Codex model policy.  Keep the default and deny-list in this
 * dependency-free launch-policy module so the bare `psu` launcher, server-side
 * CODEX_HOME writers, and the TypeScript launch paths all enforce the same
 * rule.  The installed Codex cache is not a policy source: it may advertise a
 * model that the ChatGPT subscription cannot serve (the Spark incident).
 */
// Pin effort as well as the model: an omitted launch must not inherit the
// native client's medium effort (or a cached model selection).
export const CODEX_SAFE_DEFAULT_MODEL = 'gpt-5.6-sol:xhigh';
// Alias retained for callers that describe this as the launch default.
export const CODEX_DEFAULT_MODEL = CODEX_SAFE_DEFAULT_MODEL;
export const CODEX_DENIED_MODEL_IDS = Object.freeze(['gpt-5.3-codex-spark']);
/** @typedef {'explicit' | 'inherited' | 'configured-default'} CodexModelSource */
export const CODEX_MODEL_SOURCES = Object.freeze(['explicit', 'inherited', 'configured-default']);

/** Stable policy error consumed by launch/request boundaries. */
export class CodexModelPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CodexModelPolicyError';
    this.code = code;
  }
}

/** True when a model spec resolves to the retired/forbidden Spark model. */
export function isCodexModelDenied(model) {
  const id = codexPolicyBaseId(model);
  return id !== '' && CODEX_DENIED_MODEL_IDS.includes(id);
}

/**
 * Resolve a supplied managed Codex model to a safe explicit id. Empty input is
 * a policy error: callers that deliberately choose the configured default must
 * say so through resolveCodexModelSelection instead of disguising absence as a
 * choice. Reasoning suffixes are preserved for callers that split them into
 * config.
 */
export function resolveCodexModel(model) {
  const raw = String(model ?? '').trim();
  if (!raw) {
    throw new CodexModelPolicyError(
      'missing_model',
      `Codex model is required. Supply an explicit/inherited model, or deliberately select the configured default '${CODEX_SAFE_DEFAULT_MODEL}'.`,
    );
  }
  const slash = raw.indexOf('/');
  const bare = slash > 0 ? raw.slice(slash + 1) : raw;
  const resolved = normalizeCodexCliModel(bare);
  if (isCodexModelDenied(resolved)) {
    throw new CodexModelPolicyError(
      'denied_model',
      `Codex model '${raw || resolved}' is denied by Papercusp policy (gpt-5.3-codex-spark is retired). ` +
        `Use the approved default '${CODEX_SAFE_DEFAULT_MODEL}' or another supported Codex model.`,
    );
  }
  return resolved;
}

/**
 * Resolve a model together with the authority that selected it.  The
 * configured-default branch is the ONLY branch allowed to turn absence into a
 * model, making that policy choice visible to launch ledgers and callers.
 * @param {unknown} model
 * @param {{ source?: CodexModelSource }} [options]
 * @returns {{ model: string, source: CodexModelSource }}
 */
export function resolveCodexModelSelection(model, { source = 'explicit' } = {}) {
  if (!CODEX_MODEL_SOURCES.includes(source)) {
    throw new CodexModelPolicyError('invalid_model_source', `Unknown Codex model source '${String(source)}'.`);
  }
  const raw = String(model ?? '').trim();
  if (source === 'configured-default') {
    if (raw && resolveCodexModel(raw) !== CODEX_SAFE_DEFAULT_MODEL) {
      throw new CodexModelPolicyError(
        'invalid_model_source',
        `Configured-default selection must resolve to '${CODEX_SAFE_DEFAULT_MODEL}', not '${raw}'.`,
      );
    }
    return { model: CODEX_SAFE_DEFAULT_MODEL, source };
  }
  return { model: resolveCodexModel(raw), source };
}

/** Alias with an assertion-oriented name for request-boundary callers. */
export const assertCodexModelAllowed = resolveCodexModel;

/**
 * Render the root model settings that must survive a model-less resume.  The
 * model id and effort are separated because Codex's TOML schema accepts the
 * effort as `model_reasoning_effort`, not as part of `model`.
 */
export function codexModelConfigToml(model) {
  const resolved = resolveCodexModel(model);
  const effort = CODEX_REASONING_EFFORT_RE.exec(resolved)?.[0] ?? '';
  const id = effort ? resolved.slice(0, -effort.length) : resolved;
  return [
    `model = "${id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    ...(effort ? [`model_reasoning_effort = "${effort.slice(1)}"`] : []),
    '',
  ];
}

/**
 * Map Papercusp's user-facing Codex model selectors to model ids the native
 * Codex CLI accepts. This sits in the existing plain-ESM launch-policy module
 * because both the bare-node psu launcher and TypeScript spawn paths need the
 * exact same rule.
 *
 * The GPT-5.6 family names are product-facing aliases, not native model ids.
 * Preserve a recognized reasoning-effort suffix so callers can split it into
 * Codex's `model_reasoning_effort` config after normalizing the model itself.
 * Full/native ids remain byte-identical.
 */
export function normalizeCodexCliModel(model) {
  const trimmed = model.trim();
  const effort = CODEX_REASONING_EFFORT_RE.exec(trimmed)?.[0] ?? '';
  const base = effort ? trimmed.slice(0, -effort.length) : trimmed;
  const chatgpt = /^chatgpt:(.+)$/i.exec(base);
  const unprefixed = chatgpt ? `gpt-${chatgpt[1]}` : base;
  const family = /^(sol|terra|luna)$/i.exec(unprefixed);
  const normalized = family ? `gpt-5.6-${family[1].toLowerCase()}` : unprefixed;
  return `${normalized}${effort}`;
}

const POSITIVE = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

export function bareModelId(model) {
  return String(model ?? '')
    .trim()
    .replace(/:(?:minimal|low|medium|high|xhigh|max|ultra)$/i, '')
    .replace(/^(?:ollama|ollama-cc|local|llamacpp|llama\.cpp|lmstudio|localai)\//i, '');
}

function jsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Resolve a Codex registry file without confusing the user's HOME with the
 * direct CODEX_HOME that an isolated session receives. Explicit `home` keeps
 * the historical HOME semantics (`<home>/.codex`), while `codexHome` and the
 * process environment name the direct Codex root. A populated direct file is
 * also accepted for callers that already have a CODEX_HOME path but use the
 * legacy option name.
 */
function codexRegistryFile(name, { home, codexHome } = {}) {
  const directHome =
    String(codexHome ?? '').trim() ||
    (home === undefined ? String(process.env.CODEX_HOME ?? '').trim() : '');
  if (directHome) return join(directHome, name);

  const root = String(home ?? homedir()).trim() || homedir();
  const direct = join(root, name);
  const nested = join(root, '.codex', name);
  if (basename(root) === '.codex' || (existsSync(direct) && !existsSync(nested))) return direct;
  return nested;
}

function findModelRecord(node, id) {
  if (Array.isArray(node)) {
    for (const value of node) {
      const hit = findModelRecord(value, id);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  if ([node.id, node.slug, node.model].some((v) => String(v ?? '') === id)) return node;
  for (const value of Object.values(node)) {
    const hit = findModelRecord(value, id);
    if (hit) return hit;
  }
  return null;
}

function recordWindow(record) {
  if (!record) return null;
  return POSITIVE(
    record.contextWindow ??
      record.context_window ??
      record.max_context_window ??
      record.nCtx ??
      record.n_ctx,
  );
}

/**
 * Codex models officially documented with a 1,050,000-token context window
 * that Papercusp exposes as selectors. The configured value is deliberately
 * 1,000,000 (not 1,050,000): that is the exact Codex guide setting and leaves
 * the native 900,000 auto-compact backstop above Papercusp's 400k/200k cuts.
 *
 * D-008 makes this table authoritative for the known 1M-class ids. Codex may
 * still report a lower EFFECTIVE window after applying runtime model metadata
 * (828,400 on the measured 0.148.0 install), but that does not change the
 * required top-level opt-in bytes. Registry maxima remain the fallback for
 * unrecognised extended-window models.
 */
export const CODEX_EXTENDED_WINDOW_FALLBACK = Object.freeze({
  'gpt-6-sol': 1_000_000,
  'gpt-6-luna': 1_000_000,
  'gpt-5.6-sol': 1_000_000,
  'gpt-5.6-terra': 1_000_000,
  'gpt-5.6-luna': 1_000_000,
  'gpt-5.4': 1_000_000,
  // Astra's live registry currently reports an 872k max. Prefer that record
  // when the session home has one; this 1M value is only the safe fresh-home
  // fallback before Codex has populated its direct registry.
  'gpt-6-astra': 1_000_000,
});

const CODEX_REGISTRY_FIRST_EXTENDED_IDS = new Set(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']);

/** Ceiling on the window we will DECLARE to the Codex CLI (plan D-002). */
export const CODEX_MAX_CONFIGURED_WINDOW = 1_000_000;

/**
 * Codex's own auto-compact fires at this fraction of the declared window. It is
 * a pure BACKSTOP and is meant never to run: papercusp's carry-respawn cuts at
 * the role soft limit (400k su/leader, 250k fleet member) far below it. Its only
 * job is to sit high enough that the native summarizer cannot pre-empt ours —
 * the exact failure the 272k default causes today, where Codex's effective
 * 258,400 window compacts BEFORE a leader's 400k limit is ever reached.
 */
export const CODEX_AUTO_COMPACT_FRACTION = 0.9;

function codexModelRecord(id, { home, codexHome } = {}) {
  if (!id) return null;
  return findModelRecord(jsonFile(codexRegistryFile('models_cache.json', { home, codexHome })), id);
}

/**
 * LIST the Codex CLI's installed models, from the same `~/.codex/models_cache.json`
 * `codexModelRecord` above has been reading one-at-a-time since the 1M-window work.
 *
 * WI-126377: nothing enumerated it, so psu's resume picker could offer only the
 * three hardcoded `sol/terra/luna` aliases and a free-text prompt — gpt-5.5,
 * gpt-5.4, gpt-5.4-mini and gpt-5.3-codex-spark were installed and reachable only
 * by typing their ids from memory.
 *
 * Two filters, both from the registry's own fields rather than a hand-kept list:
 *   • `visibility: 'hide'` is dropped. Codex marks its internal entries that way
 *     (measured 2026-08-27: `gpt-reserve`, `codex-auto-review`) — they are real
 *     models, but they are not what a human means by "the model list".
 *   • order follows the registry's `priority`, so the picker's first rows are the
 *     ones Codex itself ranks first, and a new model lands in the right place with
 *     no code change.
 *
 * A missing / unparseable cache returns `[]`, never a throw: the caller must
 * degrade to its alias rows, not lose the picker. A registry that yields nothing
 * is INDISTINGUISHABLE from one that is absent, and deliberately so — both mean
 * "nothing extra to offer here".
 *
 * @param {{ home?: string, codexHome?: string }} [opts]
 * @returns {Array<{ id: string, label: string | null, description: string | null,
 *   efforts: string[], defaultEffort: string | null, contextWindow: number | null,
 *   maxContextWindow: number | null }>}
 */
export function listCodexInstalledModels({ home, codexHome } = {}) {
  const cache = jsonFile(codexRegistryFile('models_cache.json', { home, codexHome }));
  const rows = Array.isArray(cache?.models) ? cache.models : [];
  return rows
    .filter((m) => m && typeof m === 'object' && String(m.visibility ?? '') !== 'hide')
    .map((m) => ({
      record: m,
      id: String(m.slug ?? m.id ?? m.model ?? '').trim(),
      priority: POSITIVE(m.priority) ?? Number.MAX_SAFE_INTEGER,
    }))
    .filter((m) => m.id !== '' && !isCodexModelDenied(m.id))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .map(({ record, id }) => ({
      id,
      label: typeof record.display_name === 'string' && record.display_name ? record.display_name : null,
      description: typeof record.description === 'string' && record.description ? record.description : null,
      efforts: Array.isArray(record.supported_reasoning_levels)
        ? record.supported_reasoning_levels
            .map((lvl) => String(lvl?.effort ?? lvl ?? '').trim())
            .filter((lvl) => lvl !== '')
        : [],
      defaultEffort:
        typeof record.default_reasoning_level === 'string' && record.default_reasoning_level
          ? record.default_reasoning_level
          : null,
      contextWindow: POSITIVE(record.context_window ?? record.contextWindow),
      maxContextWindow: POSITIVE(record.max_context_window ?? record.maxContextWindow),
    }));
}

/**
 * The context window papercusp DECLARES to the Codex CLI for `model`, or null
 * when that model has no extended window to ask for (plan
 * codex-1m-context-window-2026-08-17 D-008).
 *
 * NULL IS A MEANINGFUL ANSWER, not a failure: gpt-5.5, gpt-5.4-mini and
 * gpt-5.3-codex-spark report `max_context_window == context_window`, so there is
 * no bigger window to request and their launch argv must stay byte-identical to
 * today. Callers emit nothing on null — they must not substitute a default.
 *
 * Precedence: the exact 1M policy table for known 1M-class models, then an
 * installed model record's `max_context_window` for other models. Registry
 * maxima are clamped to CODEX_MAX_CONFIGURED_WINDOW and refused unless they
 * genuinely EXCEED the model's own default window, so sub-1M behavior remains
 * byte-identical and this can never talk an unknown model down.
 *
 * @param {string | null | undefined} model  a psu model spec, alias, or native id
 * @param {{ home?: string, codexHome?: string }} [opts]
 * @returns {{ model: string, window: number, autoCompactLimit: number, source: string } | null}
 */
export function codexContextWindowConfig(model, { home, codexHome } = {}) {
  const spec = model || codexDefaultModel(home, codexHome);
  const id = bareModelId(normalizeCodexCliModel(String(spec ?? '')));
  if (!id) return null;

  const record = codexModelRecord(id, { home, codexHome });
  const declaredMax = POSITIVE(record?.max_context_window ?? record?.maxContextWindow);
  const declaredDefault = POSITIVE(record?.context_window ?? record?.contextWindow);
  const officialWindow = POSITIVE(CODEX_EXTENDED_WINDOW_FALLBACK[id]);

  let window = null;
  let source = null;
  if (officialWindow && !(record && CODEX_REGISTRY_FIRST_EXTENDED_IDS.has(id))) {
    // D-008: keep the documented top-level opt-in exact even when the installed
    // model cache still advertises 872k. Codex 0.148.0 accepts these bytes and
    // reports 828,400 effective after applying the record's 95% factor.
    window = officialWindow;
    source = 'codex-official-1m-policy';
  } else if (record) {
    // For models outside the explicit 1M policy, the installed record remains
    // authoritative in both directions. A record without a usable extended
    // maximum emits no override rather than guessing.
    if (!declaredMax) return null;
    if (declaredDefault != null && declaredMax <= declaredDefault) return null;
    window = declaredMax;
    source = 'codex-model-cache-max';
  } else {
    return null;
  }

  window = Math.min(window, CODEX_MAX_CONFIGURED_WINDOW);
  if (window <= (declaredDefault ?? DEFAULT_CONTEXT_WINDOWS.codex)) return null;
  return {
    model: id,
    window,
    autoCompactLimit: Math.floor(window * CODEX_AUTO_COMPACT_FRACTION),
    source,
  };
}

/**
 * The `-c key=value` pair every Codex launch composer appends. `[]` when the
 * model has no extended window (see codexContextWindowConfig) — an empty argv
 * is the correct, deliberate output there, not a silent failure.
 *
 * Emitted as CONFIG OVERRIDES rather than written into a shared config.toml so
 * a per-launch model choice cannot leak across sessions sharing a CODEX_HOME.
 * The per-session home ALSO bakes the same keys (P-004) because a bare
 * `psu --resume` names no model and therefore emits no `-c` at all.
 */
export function codexContextConfigArgs(model, { home, codexHome } = {}) {
  const cfg = codexContextWindowConfig(model, { home, codexHome });
  if (!cfg) return [];
  return [
    '-c',
    `model_context_window=${cfg.window}`,
    '-c',
    `model_auto_compact_token_limit=${cfg.autoCompactLimit}`,
  ];
}

/**
 * The same policy as a config.toml fragment, for the per-session CODEX_HOME
 * (P-004). `''` when the model has no extended window, so a caller can
 * concatenate unconditionally.
 */
export function codexContextConfigToml(model, { home, codexHome } = {}) {
  const cfg = codexContextWindowConfig(model, { home, codexHome });
  if (!cfg) return '';
  return (
    `model_context_window = ${cfg.window}\n` +
    `model_auto_compact_token_limit = ${cfg.autoCompactLimit}\n`
  );
}

function codexDefaultModel(home, codexHome) {
  try {
    const text = readFileSync(codexRegistryFile('config.toml', { home, codexHome }), 'utf8');
    return text.match(/^model\s*=\s*["']([^"']+)["']/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

function ompDefaultModel(home) {
  try {
    const text = readFileSync(join(home, '.omp', 'agent', 'config.yml'), 'utf8');
    return text.match(/modelRoles:[\s\S]*?\n[ \t]+default:[ \t]*([^\s#]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Read the exact target-only launch context that the backend CLI will append.
 * A shared bounded reader keeps preview and bootstrap on the same bytes. */
export function readLaunchContextText(path) {
  if (!path) return '';
  const bytes = readFileSync(path);
  if (bytes.byteLength > MAX_LAUNCH_CONTEXT_BYTES) {
    throw new Error(`launch_context exceeds ${MAX_LAUNCH_CONTEXT_BYTES} byte cap`);
  }
  const text = bytes.toString('utf8');
  if (text.includes('\uFFFD')) throw new Error('launch_context is not valid UTF-8');
  return text.trim();
}

/** Codex has no append-system-prompt-file flag, so bootstrap folds the same
 * bytes into AGENTS.md using this exact framing. Preview uses it too. */
export function formatCodexLaunchContextSection(text) {
  const normalized = String(text ?? '').trim();
  return normalized ? `\n\n---\n## Launch Context\n\n${normalized}\n` : '';
}

export function appendCodexLaunchContextPrompt(promptText, launchContextText) {
  const section = formatCodexLaunchContextSection(launchContextText);
  return section ? `${String(promptText ?? '').replace(/\n+$/, '')}${section}` : String(promptText ?? '');
}

export function installedModelContextWindow({ agent, model, home, codexHome }) {
  const backend = String(agent ?? '').toLowerCase();
  if (backend === 'codex') {
    // We LAUNCH extended-window models at their declared max (D-002), so the
    // budget math must see that window and not the 272k default the registry
    // reports as `context_window`. Without this the preflight would refuse a
    // launch context that comfortably fits, and the seeded soft limit would be
    // derived from a window the session is not actually running.
    const configured = codexContextWindowConfig(model, { home, codexHome });
    if (configured) return { window: configured.window, source: configured.source };
    const root = jsonFile(codexRegistryFile('models_cache.json', { home, codexHome }));
    const id = bareModelId(model || codexDefaultModel(home, codexHome));
    const exact = id ? findModelRecord(root, id) : null;
    if (recordWindow(exact)) return { window: recordWindow(exact), source: 'codex-model-cache' };
    const visible = Array.isArray(root?.models) ? root.models.find((m) => recordWindow(m)) : null;
    if (recordWindow(visible)) return { window: recordWindow(visible), source: 'codex-model-cache-default' };
  }
  if (backend === 'omp') {
    const id = bareModelId(model || ompDefaultModel(home));
    const root = jsonFile(join(home, '.omp', 'agent', 'models.json'));
    const exact = id ? findModelRecord(root, id) : null;
    if (recordWindow(exact)) return { window: recordWindow(exact), source: 'omp-model-registry' };
    if (id) {
      try {
        const yml = readFileSync(join(home, '.omp', 'agent', 'models.yml'), 'utf8');
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const start = new RegExp(`^[ \\t]*-[ \\t]+id:[ \\t]*["']?${escaped}["']?[ \\t]*$`, 'm').exec(yml);
        const tail = start ? yml.slice(start.index + start[0].length) : '';
        const next = /^[ \t]*-[ \t]+id:/m.exec(tail);
        const block = tail.slice(0, next?.index ?? tail.length);
        const n = POSITIVE(block.match(/^[ \t]*contextWindow:[ \t]*(\d+)/m)?.[1]);
        if (n) return { window: n, source: 'omp-models-yml' };
      } catch {
        /* registry is optional */
      }
    }
  }
  return null;
}

/**
 * Resolve a model's context window: explicit/live values win, then the installed
 * registry, then a per-backend conservative default.
 *
 * ⚠ The `= {}` whole-object default COLLAPSES tsc's inferred options type down to
 * only the properties that carry their own initializer — here just `home`. Measured
 * 2026-08-10 (EI-19384804106131566): with no `@param`, declaration emit typed this
 * bag as `{ home?: string }`, so every caller passing `agent`/`model` became a
 * TS2353 excess-property error the moment this module was pulled into
 * `tsconfig.declarations.json`. The sibling `installedModelContextWindow` has no
 * `= {}` default and is unaffected, which is what isolates the cause. The explicit
 * `@param`/`@returns` below are what keep the emitted `.d.mts` honest — do not drop
 * them, and prefer them to removing the `= {}` (callers rely on the no-arg form).
 *
 * The `| null` members are not defensive padding: the body coerces with
 * `String(agent || 'claude')` / `POSITIVE(...)`, and real callers pass nulls
 * straight through from DB rows. Typing them as `string | undefined` under-declares
 * the runtime and reds `lint:tsc` at the CALLERS, not here.
 *
 * @param {{
 *   agent?: string | null,
 *   model?: string | null,
 *   home?: string,
 *   codexHome?: string,
 *   declaredWindow?: number | null,
 *   liveWindow?: number | null,
 * }} [opts]
 * @returns {{ window: number, source: string }}
 */
export function resolveModelContextWindow({ agent, model, home, codexHome, declaredWindow, liveWindow } = {}) {
  const declared = POSITIVE(declaredWindow);
  const live = POSITIVE(liveWindow);
  if (declared || live) {
    const window = declared && live ? Math.min(declared, live) : declared ?? live;
    return { window, source: declared && live ? 'declared-live-min' : declared ? 'declared' : 'live' };
  }

  const installed = installedModelContextWindow({ agent, model, home, codexHome });
  if (installed) return installed;

  const backend = String(agent || 'claude').toLowerCase();
  const spec = String(model ?? '');
  if (backend === 'claude' && (/\[1m\]/i.test(spec) || /fable|opus|sonnet-?5/i.test(spec) || /^sonnet(?::|$)/i.test(spec))) {
    return { window: 1_000_000, source: 'claude-1m-selector' };
  }
  return {
    window: DEFAULT_CONTEXT_WINDOWS[backend] ?? DEFAULT_CONTEXT_WINDOWS.claude,
    source: `${backend || 'claude'}-conservative-default`,
  };
}

export function estimatePromptTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text ?? ''), 'utf8') / 3.7);
}

/**
 * Build the full context-budget record for a launch.
 *
 * ⚠ Same `= {}` inference collapse as `resolveModelContextWindow` above — see that
 * note. Keep the explicit `@param`/`@returns`; without them the emitted `.d.mts`
 * types this bag as `{ home?: string }` and widens `window`/`level` to `any`/`string`.
 *
 * Same `| null` note as above — every one of these reaches a `?? ''` / `||` /
 * `POSITIVE()` coercion in the body, and callers pass DB-shaped nulls
 * (`contextSize` is `'full' | 'trimmed' | null`, `promptText` is `string | null`).
 *
 * @param {{
 *   agent?: string | null,
 *   model?: string | null,
 *   home?: string,
 *   codexHome?: string,
 *   contextSize?: string | null,
 *   promptText?: string | null,
 *   additionalPromptText?: string | null,
 *   estimatedPromptTokens?: number | null,
 *   declaredWindow?: number | null,
 *   liveWindow?: number | null,
 * }} [opts]
 * @returns {{
 *   version: number,
 *   agent: string,
 *   model: string | null,
 *   window: number,
 *   windowSource: string,
 *   variant: 'full' | 'trimmed',
 *   promptTokens: number,
 *   runtimeOverheadTokens: number,
 *   baselineTokens: number,
 *   reserveTokens: number,
 *   availableInputTokens: number,
 *   level: 'ok' | 'warn' | 'refuse',
 *   pct: number,
 *   estimator: string,
 * }}
 */
export function buildContextBudget({
  agent,
  model,
  home,
  codexHome,
  contextSize,
  promptText,
  additionalPromptText,
  estimatedPromptTokens,
  declaredWindow,
  liveWindow,
} = {}) {
  const resolved = resolveModelContextWindow({ agent, model, home, codexHome, declaredWindow, liveWindow });
  const variant = contextSize === 'full' ? 'full' : 'trimmed';
  const promptTokens = POSITIVE(estimatedPromptTokens) ?? estimatePromptTokens(
    `${String(promptText ?? '')}${String(additionalPromptText ?? '')}`,
  );
  const runtimeOverheadTokens = RUNTIME_OVERHEAD_TOKENS[variant];
  const baselineTokens = promptTokens + runtimeOverheadTokens;
  const reserveTokens = Math.min(15_000, Math.max(8_000, Math.floor(resolved.window / 26)));
  const availableInputTokens = Math.max(0, resolved.window - baselineTokens - reserveTokens);
  const pct = baselineTokens / resolved.window;
  return {
    version: MODEL_CONTEXT_BUDGET_VERSION,
    agent: String(agent || 'claude'),
    model: model ? String(model) : null,
    window: resolved.window,
    windowSource: resolved.source,
    variant,
    promptTokens,
    runtimeOverheadTokens,
    baselineTokens,
    reserveTokens,
    availableInputTokens,
    level: pct >= 0.6 ? 'refuse' : pct >= 0.35 ? 'warn' : 'ok',
    pct,
    estimator: 'utf8-bytes/3.7-v1',
  };
}
