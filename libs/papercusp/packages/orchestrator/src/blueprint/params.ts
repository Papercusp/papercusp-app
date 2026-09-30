/**
 * params.ts — read / write / validate per-harness config VALUES against a
 * blueprint's declared `params` (psu-isolation-and-blueprint-aware-harness-ui-2026-06-09
 * P-007). The schema-driven settings layer.
 *
 * The blueprint declares `params` (P-006) keyed by config.json INSTANCE paths
 * (`parallelWorkers.max`, `debugger.threshold`, `aiBackend.default.model`, …). This
 * module is what the settings UI (P-008) + the config write path use:
 *   - `resolveParamViews` — the current effective value for each declared param
 *     (instance override if present, else the param's `default`).
 *   - `validateParamPatch` — validate a set of edits against the declared params:
 *     reject keys that aren't declared (no arbitrary config writes), type/range/option
 *     check each value, and SKIP secret params (those route through the credential
 *     store, never config.json — the P-008 plaintext-secrets fix).
 *   - `applyParamPatch` — write the validated patch into the instance config at each
 *     key's dot-path, dropping a value equal to its `default` so config.json stays
 *     minimal (mirrors the old panel's "only persist non-defaults").
 *
 * Because the param keys ARE the existing config.json paths, NO data migration is
 * needed — an existing harness's `config.json` (parallelWorkers.* / debugger.threshold
 * / aiBackend.*) already sits at the param key-paths; the schema-driven layer just
 * reads/writes the same paths it always did, now declared + validated.
 *
 * Pure — no IO, no host coupling. Lives in the blueprint lib so the operator UI AND
 * the `papercusp` CLI can both use it.
 */
import type { BlueprintParams, ParamSpec } from './schema.js';

type Obj = Record<string, unknown>;

function isPlainObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Read a dot-path value from a nested object; undefined if any segment is missing. */
export function getParamPath(obj: Obj | null | undefined, dotPath: string): unknown {
  if (!obj) return undefined;
  let cur: unknown = obj;
  for (const seg of dotPath.split('.')) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Return a shallow-cloned-along-the-path copy of `obj` with `value` set at `dotPath`
 * (creating intermediate objects). `value === undefined` DELETES the leaf (so
 * "reset to default" simply drops the override) and prunes now-empty parent objects.
 */
export function setParamPath(obj: Obj, dotPath: string, value: unknown): Obj {
  const parts = dotPath.split('.');
  const root: Obj = { ...obj };
  const chain: Obj[] = [root];
  let cur: Obj = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    const existing = cur[k];
    const next: Obj = isPlainObject(existing) ? { ...existing } : {};
    cur[k] = next;
    chain.push(next);
    cur = next;
  }
  const leaf = parts[parts.length - 1];
  if (value === undefined) {
    delete cur[leaf];
    // prune now-empty ancestors created/left by the delete
    for (let i = parts.length - 2; i >= 0; i--) {
      const parent = chain[i];
      const key = parts[i];
      const child = parent[key];
      if (isPlainObject(child) && Object.keys(child).length === 0) delete parent[key];
      else break;
    }
  } else {
    cur[leaf] = value;
  }
  return root;
}

export interface ParamValidationResult {
  ok: boolean;
  /** The coerced value (e.g. a numeric string → number) when ok. */
  value?: unknown;
  error?: string;
}

/** Coerce + validate a single value against a ParamSpec (type / range / options). */
export function validateParamValue(spec: ParamSpec, raw: unknown): ParamValidationResult {
  switch (spec.type) {
    case 'number': {
      const n =
        typeof raw === 'number'
          ? raw
          : typeof raw === 'string' && raw.trim() !== ''
            ? Number(raw)
            : NaN;
      if (!Number.isFinite(n)) return { ok: false, error: 'expected a number' };
      if (spec.min !== undefined && n < spec.min) return { ok: false, error: `must be ≥ ${spec.min}` };
      if (spec.max !== undefined && n > spec.max) return { ok: false, error: `must be ≤ ${spec.max}` };
      return { ok: true, value: n };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (raw === 'true') return { ok: true, value: true };
      if (raw === 'false') return { ok: true, value: false };
      return { ok: false, error: 'expected a boolean' };
    }
    case 'string': {
      if (typeof raw !== 'string') return { ok: false, error: 'expected a string' };
      return { ok: true, value: raw };
    }
    case 'enum': {
      const allowed = (spec.options ?? []).map((o) => o.value);
      if (!allowed.includes(raw as string | number | boolean)) {
        return { ok: false, error: `must be one of: ${allowed.join(', ')}` };
      }
      return { ok: true, value: raw };
    }
    default:
      return { ok: false, error: 'unknown param type' };
  }
}

export interface ParamView {
  key: string;
  spec: ParamSpec;
  /** Effective value: the instance-config override if present, else `spec.default`. */
  value: unknown;
  /** true when the value is an explicit instance override (vs the default). */
  overridden: boolean;
}

/**
 * The UI-facing view: every declared param + its current effective value, in
 * declaration order. Reads the instance config (config.json) at each param's
 * key-path. Secret params are still returned (the UI renders a credential-ref
 * control) but carry no value here.
 */
export function resolveParamViews(params: BlueprintParams, instanceConfig: Obj | null | undefined): ParamView[] {
  const cfg = instanceConfig ?? {};
  return Object.entries(params).map(([key, spec]) => {
    if (spec.secret) return { key, spec, value: undefined, overridden: false };
    const raw = getParamPath(cfg, key);
    const overridden = raw !== undefined;
    return { key, spec, value: overridden ? raw : spec.default, overridden };
  });
}

export interface ParamPatchResult {
  ok: boolean;
  /** Per-key validation errors (empty when ok). */
  errors: { key: string; error: string }[];
  /** Keys rejected because they aren't declared params of this blueprint. */
  unknownKeys: string[];
  /** The validated + coerced patch (only the keys that passed; secrets excluded). */
  patch: Record<string, unknown>;
}

/**
 * Validate a `{ key: value }` patch against the declared params:
 *   - reject keys NOT declared in `params` → `unknownKeys` (no arbitrary config writes);
 *   - SKIP secret params with an error (they belong in the credential store — P-008);
 *   - type/range/option validate + coerce each remaining value.
 * `ok` is true only when there are no errors AND no unknown keys.
 */
export function validateParamPatch(params: BlueprintParams, edits: Record<string, unknown>): ParamPatchResult {
  const errors: { key: string; error: string }[] = [];
  const unknownKeys: string[] = [];
  const patch: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(edits)) {
    const spec = params[key];
    if (!spec) {
      unknownKeys.push(key);
      continue;
    }
    if (spec.secret) {
      errors.push({ key, error: 'secret — set via the credential store, not config' });
      continue;
    }
    const res = validateParamValue(spec, raw);
    if (!res.ok) {
      errors.push({ key, error: res.error ?? 'invalid' });
      continue;
    }
    patch[key] = res.value;
  }
  return { ok: errors.length === 0 && unknownKeys.length === 0, errors, unknownKeys, patch };
}

/**
 * Apply a validated patch into an instance config: set each key at its dot-path. A
 * value equal to the param's declared `default` is DROPPED (the override is deleted)
 * so config.json stays minimal — the runtime then resolves the default. Returns a new
 * config object (does not mutate the input).
 */
export function applyParamPatch(
  instanceConfig: Obj,
  params: BlueprintParams,
  patch: Record<string, unknown>,
): Obj {
  let out: Obj = { ...instanceConfig };
  for (const [key, value] of Object.entries(patch)) {
    const spec = params[key];
    const isDefault = spec && spec.default !== undefined && value === spec.default;
    out = setParamPath(out, key, isDefault ? undefined : value);
  }
  return out;
}
