/**
 * Pure assembly + validation for the /settings/agent auto-save pipeline.
 *
 * THE INVARIANT (owner bug 2026-06-11 — "saved a model spec, reloaded, it was
 * wiped"): an invalid or incomplete edit must NEVER remove a setting from the
 * persisted config. The page used to EXCLUDE invalid tier rows from the saved
 * body, so a transiently bad row was deleted from the store 600ms later and a
 * reload re-hydrated the gutted config. Assembly now works on committed
 * (blur-validated) values and, when a section still fails cross-field checks
 * (duplicate tier name, incomplete row, dangling ceiling), it HOLDS that
 * section at the last server-acknowledged value and flags the problem inline
 * — nothing is dropped on the floor.
 *
 * Kept free of React so the semantics are unit-testable; the page wires it to
 * state + refs in a useMemo.
 */
import {
  DEFAULT_MODEL_TIERS,
  MODEL_EFFORT_LEVELS,
  MIN_COMPACTION_LIMIT_TOKENS,
  SURFACE_KEYS,
  compactionCapBindingForTier,
  defaultCompactionLimitForTier,
  isValidModelSpec,
  type AgentBackend,
  type ModelTier,
  type SurfaceKey,
} from "@papercusp/operator-core/lib/agent-config-constants";

/** Mid-edit tier rows. `backend: ''` = inherit the global agent command. */
export interface TierRow {
  name: string;
  spec: string;
  backend: "" | AgentBackend;
  /** When the queen should pick this tier — injected into her launch prompt. */
  when: string;
  /** Soft compaction limit (tokens) as edited text; ''/absent = model-derived
      default (context-trimming-tiers D-002). Optional so pre-existing row
      literals stay valid; tierToRow always populates it. */
  compactionLimit?: string;
  /** Catalog window snapshot and the spec it belongs to. The spec marker keeps
      an edited model id from inheriting the previous model's window. */
  contextWindow?: number;
  contextWindowSpec?: string;
}

export const tierToRow = (t: ModelTier): TierRow => ({
  name: t.name,
  spec: t.spec,
  backend: t.backend ?? "",
  when: t.when ?? "",
  compactionLimit: t.compactionLimit != null ? String(t.compactionLimit) : "",
  ...(t.contextWindow != null
    ? { contextWindow: t.contextWindow, contextWindowSpec: t.spec }
    : {}),
});

/** Bare cloud model aliases that are recognized without a vendor prefix.
    Includes Anthropic (haiku, sonnet, opus, fable) verified against the installed
    Claude CLI (2026-06-11: `claude -p --model <x>` — `fable5`/`opush` are rejected)
    and OpenAI GPT-5.6 (sol, terra, luna) for codex backend (WI-4639). */
const KNOWN_CLOUD_ALIASES_SETTINGS = new Set([
  "haiku",
  "sonnet",
  "opus",
  "fable",
  "sol",
  "terra",
  "luna",
]);

/** Model-id half of a `<modelId>[:<effort>]` spec. */
export function specId(spec: string): string {
  const lastColon = spec.lastIndexOf(":");
  if (lastColon <= 0) return spec;
  const suffix = spec.slice(lastColon + 1);
  return (MODEL_EFFORT_LEVELS as readonly string[]).includes(suffix)
    ? spec.slice(0, lastColon)
    : spec;
}

/**
 * Validate one model spec for commit. Returns the error message or null.
 *
 * Two layers: the syntactic `<modelId>[:<effort>]` shape, then a HARD check
 * that a bare lowercase word is a known cloud alias — a bare unknown word
 * ("opush", "fable5") is almost always a typo, and a typo'd spec going live
 * means broken spawns. Full / provider ids (anything with `-`, `/`, or `.`)
 * always pass; that's the escape hatch for new models and other backends.
 */
export function modelSpecError(spec: string): string | null {
  const s = spec.trim();
  if (!s) return null; // empty = inherit/unset — the row-level checks own "required"
  if (!isValidModelSpec(s))
    return "invalid spec — shape is <modelId>[:<effort>], no spaces";
  const id = specId(s);
  if (/^[a-z][a-z0-9]*$/.test(id) && !KNOWN_CLOUD_ALIASES_SETTINGS.has(id)) {
    return `"${id}" is not a known model alias (haiku · sonnet · opus · fable · sol · terra · luna) — use a full model id like claude-opus-4-8 or gpt-5.6-luna if intentional`;
  }
  return null;
}

/** Validate the per-role models JSON draft for commit (DraftTextarea). */
export function modelsJsonError(draft: string): string | null {
  if (!draft.trim()) return null; // empty = no overrides
  let parsed: unknown;
  try {
    parsed = JSON.parse(draft);
  } catch (err) {
    return `invalid JSON: ${(err as Error).message}`;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return 'must be a JSON object of { "role": "model" }';
  }
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== "string" || !v.trim())
      return `"${k}" must map to a model id string`;
    const err = modelSpecError(v);
    if (err) return `"${k}": ${err}`;
  }
  return null;
}

export type GlobalBackend = "auto" | AgentBackend;
export type SurfaceChoice = "inherit" | AgentBackend;

/** The wire shape POSTed to /api/agent-config. */
export interface PersistableAgentConfig {
  backend: GlobalBackend;
  cmd: string;
  models: Record<string, string>;
  roleBackends: Record<string, AgentBackend>;
  backends: Partial<Record<SurfaceKey, AgentBackend>>;
  surfaceModels: Partial<Record<SurfaceKey, string>>;
  tiers: ModelTier[];
  tierCeilings: Record<string, string>;
}

/** The last server-acknowledged value of each holdable section — the
    fallbacks assembly substitutes when a section is currently invalid.
    Seeded from the GET on hydration; advanced whenever a section validates. */
export interface LastValidSections {
  models: Record<string, string>;
  surfaceModels: Partial<Record<SurfaceKey, string>>;
  tiers: ModelTier[];
  tierCeilings: Record<string, string>;
}

export interface AssembleInput {
  backend: GlobalBackend;
  cmd: string;
  /** Committed (blur-validated) per-role models JSON text. */
  modelsJson: string;
  roleBackends: Record<string, SurfaceChoice>;
  surfaceBackends: Record<SurfaceKey, SurfaceChoice>;
  surfaceModels: Record<SurfaceKey, string>;
  tierRows: TierRow[];
  tierCeilings: Record<string, string>;
  lastValid: LastValidSections;
}

export interface AssembleResult {
  persistable: PersistableAgentConfig;
  /** Inline flags — every line explains what is held back and why. */
  problems: string[];
  /** The advanced fallback snapshot the caller stores for the next pass. */
  lastValid: LastValidSections;
}

export function assembleAgentConfig(input: AssembleInput): AssembleResult {
  const problems: string[] = [];
  const lastValid: LastValidSections = { ...input.lastValid };

  // ── Per-role models (committed JSON is blur-validated; parse defensively) ──
  let models = lastValid.models;
  if (input.modelsJson.trim()) {
    const err = modelsJsonError(input.modelsJson);
    if (err) {
      problems.push(
        `per-role models: ${err} — keeping the last saved overrides until fixed`,
      );
    } else {
      models = Object.fromEntries(
        Object.entries(
          JSON.parse(input.modelsJson) as Record<string, string>,
        ).map(([k, v]) => [k, v.trim()]),
      );
      lastValid.models = models;
    }
  } else {
    models = {};
    lastValid.models = {};
  }

  // ── Per-role backend overrides ────────────────────────────────────────────
  const roleBackends: Record<string, AgentBackend> = {};
  for (const [role, choice] of Object.entries(input.roleBackends)) {
    const key = role.trim();
    if (key && choice !== "inherit") roleBackends[key] = choice;
  }

  // ── Per-surface backend + model ─────────────────────────────────────────────
  const backends: Partial<Record<SurfaceKey, AgentBackend>> = {};
  for (const k of SURFACE_KEYS) {
    const choice = input.surfaceBackends[k];
    if (choice !== "inherit") backends[k] = choice;
  }
  let surfaceModelsOut: Partial<Record<SurfaceKey, string>> = {};
  let surfaceModelsValid = true;
  for (const k of SURFACE_KEYS) {
    const m = input.surfaceModels[k]?.trim();
    if (!m) continue;
    const err = modelSpecError(m);
    if (err) {
      surfaceModelsValid = false;
      problems.push(
        `model for "${k}": ${err} — keeping the last saved surface models until fixed`,
      );
      continue;
    }
    surfaceModelsOut[k] = m;
  }
  if (!surfaceModelsValid) surfaceModelsOut = lastValid.surfaceModels;
  else lastValid.surfaceModels = surfaceModelsOut;

  // ── Model-tier menu — validated as a UNIT: one bad row holds the whole menu
  //    at the last saved value (a partially-saved menu is how rows got wiped) ──
  const cleanedTiers: ModelTier[] = [];
  const seenNames = new Set<string>();
  let tiersValid = true;
  for (const [i, row] of input.tierRows.entries()) {
    const name = row.name.trim();
    const spec = row.spec.trim();
    if (!name && !spec) continue; // fully blank row (e.g. just added) — ignored
    if (!name || !spec) {
      problems.push(`tier row ${i + 1} needs both a name and a model spec`);
      tiersValid = false;
      continue;
    }
    if (seenNames.has(name.toLowerCase())) {
      problems.push(`tier row ${i + 1}: duplicate name "${name}"`);
      tiersValid = false;
      continue;
    }
    const specErr = modelSpecError(spec);
    if (specErr) {
      problems.push(`tier "${name}": ${specErr}`);
      tiersValid = false;
      continue;
    }
    // Optional per-tier soft compaction limit (context-trimming-tiers D-001/D-002):
    // '' = model-derived default; a number must sit in [20k, the tier's SEEDED
    // cap]. A tier limit seeds every session launched on that tier, so it is a
    // fleet-wide cost policy, not the per-session deliberate self-set that
    // `config:set-compaction-limit` serves — which is why the cap here is the
    // seeded default and may sit below `selfSetCeilingForSpec` (EI-19914665525338044).
    // Two different constraints can produce that cap, so ask which one bound
    // rather than asserting the window derivation.
    let compactionLimit: number | undefined;
    const contextWindow =
      row.contextWindowSpec === spec &&
      typeof row.contextWindow === "number" &&
      Number.isFinite(row.contextWindow) &&
      row.contextWindow > 0
        ? Math.floor(row.contextWindow)
        : undefined;
    const limitText = (row.compactionLimit ?? "").trim();
    if (limitText) {
      const n = Number(limitText);
      const cap = defaultCompactionLimitForTier({ spec, contextWindow });
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        problems.push(
          `tier "${name}": compaction limit must be a whole number of tokens (or blank for the model default)`,
        );
        tiersValid = false;
        continue;
      }
      if (n < MIN_COMPACTION_LIMIT_TOKENS || n > cap) {
        const binding = compactionCapBindingForTier({ spec, contextWindow });
        const why =
          binding === "role-cap"
            ? "the cap bounds fleet-wide spend, since a tier limit seeds every session launched on it; a single session can go higher with config:set-compaction-limit"
            : binding === "minimum"
              ? "this model's window cannot safely support a larger limit"
              : "the cap keeps limit × 1.2 under the model window";
        problems.push(
          `tier "${name}": compaction limit must be ${MIN_COMPACTION_LIMIT_TOKENS.toLocaleString()}–${cap.toLocaleString()} for spec "${spec}" (${why})`,
        );
        tiersValid = false;
        continue;
      }
      compactionLimit = n;
    }
    seenNames.add(name.toLowerCase());
    cleanedTiers.push({
      name,
      spec,
      ...(row.backend ? { backend: row.backend } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(row.when.trim() ? { when: row.when.trim() } : {}),
      ...(compactionLimit !== undefined ? { compactionLimit } : {}),
    });
  }
  // Store [] when the rows still equal the committed defaults — an untouched
  // menu keeps tracking future default changes instead of freezing a copy.
  const isDefaultMenu =
    JSON.stringify(cleanedTiers) === JSON.stringify(DEFAULT_MODEL_TIERS);
  let tiersOut = isDefaultMenu ? [] : cleanedTiers;
  if (!tiersValid) {
    tiersOut = lastValid.tiers;
    problems.push(
      "tier menu has invalid rows — keeping the last saved menu until fixed",
    );
  } else {
    lastValid.tiers = tiersOut;
  }

  // ── Per-role ceilings — validated against the menu actually being persisted ──
  // ([] = default menu, so ceilings may name the default tiers too.)
  const persistedNames = tiersValid
    ? new Set(cleanedTiers.map((t) => t.name.toLowerCase()))
    : new Set(
        (lastValid.tiers.length > 0
          ? lastValid.tiers
          : [...DEFAULT_MODEL_TIERS]
        ).map((t) => t.name.toLowerCase()),
      );
  let ceilingsOut: Record<string, string> = {};
  let ceilingsValid = true;
  for (const [role, tier] of Object.entries(input.tierCeilings)) {
    if (!tier) continue;
    if (!persistedNames.has(tier.toLowerCase())) {
      // Backstop — the page remaps ceilings on tier rename and cascades them
      // on tier remove, so a dangling name here means out-of-band drift.
      ceilingsValid = false;
      problems.push(
        `ceiling for "${role}" names unknown tier "${tier}" — keeping the last saved ceilings until fixed`,
      );
      continue;
    }
    ceilingsOut[role] = tier;
  }
  if (!ceilingsValid) ceilingsOut = lastValid.tierCeilings;
  else lastValid.tierCeilings = ceilingsOut;

  return {
    persistable: {
      backend: input.backend,
      cmd: input.cmd,
      models,
      roleBackends,
      backends,
      surfaceModels: surfaceModelsOut,
      tiers: tiersOut,
      tierCeilings: ceilingsOut,
    },
    problems,
    lastValid,
  };
}
