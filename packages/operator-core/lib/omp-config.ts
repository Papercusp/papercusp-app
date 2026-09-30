/**
 * Wraps the omp (oh-my-pi) `config` subcommand so the operator UI can
 * read the full settings tree and persist changes.
 *
 * `omp config list` output is line-oriented:
 *
 *   Settings:
 *
 *   [section]
 *     key.path = value (type)
 *     ...
 *
 * Where `type` is one of: string, boolean, number, array, record, or an
 * enum literal `a|b|c`. For string/number scalars the value is rendered
 * inline; arrays/records are JSON-stringified on a single line.
 */

import { spawn } from 'node:child_process';
import { delimiter } from 'node:path';

import { resolveSpawnPathDirs } from './backend-bin-resolve.mjs';

export interface OmpModelCatalogCost {
  /** OMP may use a negative finite sentinel when a router's price is dynamic. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One row emitted by OMP's own `models --json` registry view. */
export interface OmpModelCatalogEntry {
  provider: string;
  id: string;
  /** Exact selector OMP accepts at launch time (`provider/id`). */
  selector: string;
  name: string;
  contextWindow: number | null;
  maxTokens: number | null;
  reasoning: boolean;
  /** Model-specific reasoning choices from OMP's catalog, or null when unsupported. */
  thinking: string[] | null;
  input: Array<'text' | 'image'>;
  cost: OmpModelCatalogCost;
}

export interface OmpModelCatalog {
  models: OmpModelCatalogEntry[];
}

const OMP_MODEL_CATALOG_TTL_MS = 30_000;
const OMP_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

export type OmpConfigType =
  | 'string'
  | 'boolean'
  | 'number'
  | 'array'
  | 'record'
  | { kind: 'enum'; choices: string[] };

export interface OmpConfigSetting {
  key: string;
  raw: string;          // verbatim value text from `omp config list`
  parsed: unknown;      // best-effort parsed value (boolean/number/JSON/string)
  type: OmpConfigType;
  isUnset: boolean;
}

export interface OmpConfigSection {
  name: string;
  settings: OmpConfigSetting[];
}

const TYPE_LITERALS = new Set(['string', 'boolean', 'number', 'array', 'record']);

function parseTypeAnnotation(rawType: string): OmpConfigType {
  if (TYPE_LITERALS.has(rawType)) return rawType as OmpConfigType;
  // Enum like "a|b|c"
  const choices = rawType.split('|').map((s) => s.trim()).filter(Boolean);
  if (choices.length > 1) return { kind: 'enum', choices };
  return 'string';
}

function parseValue(raw: string, type: OmpConfigType): { parsed: unknown; isUnset: boolean } {
  const isUnset = raw === '(not set)';
  if (isUnset) return { parsed: null, isUnset: true };
  if (type === 'boolean') return { parsed: raw === 'true', isUnset: false };
  if (type === 'number') {
    const n = Number(raw);
    return { parsed: Number.isFinite(n) ? n : raw, isUnset: false };
  }
  if (type === 'array' || type === 'record') {
    try { return { parsed: JSON.parse(raw), isUnset: false }; } catch { return { parsed: raw, isUnset: false }; }
  }
  return { parsed: raw, isUnset: false };
}

const LINE_RE = /^\s{2}([\w.-]+)\s+=\s+(.+?)\s+\((.+?)\)\s*$/;
const SECTION_RE = /^\[([^\]]+)\]\s*$/;

export function parseOmpConfigList(output: string): OmpConfigSection[] {
  const sections: OmpConfigSection[] = [];
  let current: OmpConfigSection | null = null;
  for (const line of output.split(/\r?\n/)) {
    const sec = SECTION_RE.exec(line);
    if (sec) {
      current = { name: sec[1], settings: [] };
      sections.push(current);
      continue;
    }
    const m = LINE_RE.exec(line);
    if (!m || !current) continue;
    const [, key, rawValue, rawType] = m;
    const type = parseTypeAnnotation(rawType);
    const { parsed, isUnset } = parseValue(rawValue, type);
    current.settings.push({ key, raw: rawValue, parsed, type, isUnset });
  }
  return sections;
}

function execOmp(
  args: string[],
  timeoutMs = 10_000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    // The deployed operator often has a service PATH that omits the target
    // user's install roots. Resolve the same canonical backend locations used
    // by console launches and carry both the binary's directory and its
    // shebang interpreter's directory (OMP is commonly `#!/usr/bin/env bun`).
    const spawnPath = resolveSpawnPathDirs({
      home: env.HOME ?? env.USERPROFILE,
      env,
      agents: ['omp'],
    });
    const ompBin = spawnPath.resolved.find((entry) => entry.agent === 'omp')?.bin ?? 'omp';
    const inheritedPath = env.PATH ?? env.Path ?? '';
    const childEnv = {
      ...env,
      PATH: [...spawnPath.dirs, inheritedPath].filter(Boolean).join(delimiter),
    };
    const child = spawn(ompBin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let resolved = false;
    const append = (target: 'stdout' | 'stderr', b: Buffer | string) => {
      if (resolved) return;
      const text = b.toString();
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > OMP_OUTPUT_LIMIT_BYTES) {
        resolved = true;
        clearTimeout(t);
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        reject(new Error(`omp ${args.join(' ')} exceeded ${OMP_OUTPUT_LIMIT_BYTES} output bytes`));
        return;
      }
      if (target === 'stdout') stdout += text;
      else stderr += text;
    };
    const t = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      reject(new Error(`omp ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on('data', (b) => append('stdout', b));
    child.stderr?.on('data', (b) => append('stderr', b));
    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(t);
      reject(err);
    });
    child.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(t);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

function nullableFiniteNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`omp models --json returned invalid ${field}`);
  }
  return value;
}

/** Validate the CLI boundary rather than trusting arbitrary subprocess JSON. */
export function parseOmpModelCatalogJson(output: string): OmpModelCatalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`omp models --json returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const rows = (parsed as { models?: unknown })?.models;
  if (!Array.isArray(rows)) throw new Error('omp models --json returned no models array');

  const selectors = new Set<string>();
  const models = rows.map((raw, index): OmpModelCatalogEntry => {
    if (!raw || typeof raw !== 'object') throw new Error(`omp models --json row ${index} is not an object`);
    const row = raw as Record<string, unknown>;
    const provider = typeof row.provider === 'string' ? row.provider.trim() : '';
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    const selector = typeof row.selector === 'string' ? row.selector.trim() : '';
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!provider || !id || !name || selector !== `${provider}/${id}`) {
      throw new Error(`omp models --json row ${index} has an invalid provider/id/selector/name identity`);
    }
    if (selectors.has(selector)) throw new Error(`omp models --json returned duplicate selector ${selector}`);
    selectors.add(selector);

    if (typeof row.reasoning !== 'boolean') {
      throw new Error(`omp models --json row ${index} has invalid reasoning metadata`);
    }
    const thinking = row.thinking === null
      ? null
      : Array.isArray(row.thinking) && row.thinking.every((v) => typeof v === 'string' && v.trim())
        ? row.thinking.map((v) => String(v))
        : null;
    if (row.thinking !== null && thinking === null) {
      throw new Error(`omp models --json row ${index} has invalid thinking metadata`);
    }
    if (!Array.isArray(row.input) || !row.input.every((v) => v === 'text' || v === 'image')) {
      throw new Error(`omp models --json row ${index} has invalid input metadata`);
    }
    if (!row.cost || typeof row.cost !== 'object') {
      throw new Error(`omp models --json row ${index} has invalid cost metadata`);
    }
    const cost = row.cost as Record<string, unknown>;
    const costNumber = (field: keyof OmpModelCatalogCost): number => {
      const value = cost[field];
      // Preserve OMP's numeric contract exactly. Dynamic routers currently use
      // a negative finite sentinel for prices that cannot be known up front.
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`omp models --json row ${index} has invalid cost.${field}`);
      }
      return value;
    };
    return {
      provider,
      id,
      selector,
      name,
      contextWindow: nullableFiniteNumber(row.contextWindow, `row ${index} contextWindow`),
      maxTokens: nullableFiniteNumber(row.maxTokens, `row ${index} maxTokens`),
      reasoning: row.reasoning,
      thinking,
      input: [...row.input] as Array<'text' | 'image'>,
      cost: {
        input: costNumber('input'),
        output: costNumber('output'),
        cacheRead: costNumber('cacheRead'),
        cacheWrite: costNumber('cacheWrite'),
      },
    };
  });
  return { models };
}

type OmpCatalogExec = (
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
) => Promise<{ stdout: string; stderr: string; code: number }>;

/**
 * Build a cached reader. Exported as a narrow test seam; production uses the
 * singleton below so the options endpoint and omp:config share one cache.
 */
export function createOmpModelCatalogReader(
  deps: { exec?: OmpCatalogExec; now?: () => number; ttlMs?: number } = {},
): (options?: { env?: NodeJS.ProcessEnv; forceRefresh?: boolean }) => Promise<OmpModelCatalog> {
  const run = deps.exec ?? execOmp;
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? OMP_MODEL_CATALOG_TTL_MS;
  const cache = new Map<string, { expiresAt: number; value?: OmpModelCatalog; pending?: Promise<OmpModelCatalog> }>();

  return async (options = {}) => {
    const env = options.env ?? process.env;
    // OMP's profile/config/auth discovery is user-local. Keep cache entries
    // isolated across every env input that can select a different registry.
    const key = JSON.stringify([
      env.HOME ?? '',
      env.PI_CODING_AGENT_DIR ?? '',
      env.PI_CONFIG_DIR ?? '',
      env.XDG_CONFIG_HOME ?? '',
      env.PATH ?? '',
    ]);
    const cached = cache.get(key);
    if (!options.forceRefresh && cached?.value && cached.expiresAt > now()) return cached.value;
    if (!options.forceRefresh && cached?.pending) return cached.pending;

    const pending = run(['models', '--json'], 20_000, env).then((result) => {
      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout).trim().slice(0, 400);
        throw new Error(`omp models --json failed (exit ${result.code}): ${detail || 'no output'}`);
      }
      const value = parseOmpModelCatalogJson(result.stdout);
      cache.set(key, { value, expiresAt: now() + ttlMs });
      return value;
    }).catch((error) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, { pending, expiresAt: 0 });
    return pending;
  };
}

export const readOmpModelCatalog = createOmpModelCatalogReader();

export async function readOmpConfig(): Promise<OmpConfigSection[]> {
  const r = await execOmp(['config', 'list']);
  if (r.code !== 0) throw new Error(`omp config list failed (exit ${r.code}): ${r.stderr}`);
  return parseOmpConfigList(r.stdout);
}

/**
 * Set a single config key. Value is stringified to omp's expected wire format:
 * - boolean → 'true' | 'false'
 * - number  → String(n)
 * - array/record → JSON.stringify(v)
 * - string/enum → as-is
 *
 * Returns the new raw value omp echoed back, or throws.
 */
export async function setOmpConfig(key: string, value: unknown): Promise<{ raw: string }> {
  // Validate key shape — omp keys are dotted alphanumerics (no shell metas).
  if (!/^[\w.-]+$/.test(key)) throw new Error(`invalid config key: ${key}`);
  let serialized: string;
  if (value === null || value === undefined) serialized = '';
  else if (typeof value === 'boolean') serialized = value ? 'true' : 'false';
  else if (typeof value === 'number') serialized = String(value);
  else if (typeof value === 'string') serialized = value;
  else serialized = JSON.stringify(value);

  const r = await execOmp(['config', 'set', key, serialized]);
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim().slice(0, 400);
    throw new Error(`omp config set ${key} failed: ${detail || `exit ${r.code}`}`);
  }
  return { raw: serialized };
}

/**
 * Reset a key back to its default by calling `omp config unset <key>` if
 * supported, falling back to `omp config set <key> ''` (omp treats empty
 * as "unset" for most string-typed scalars).
 */
export async function unsetOmpConfig(key: string): Promise<void> {
  if (!/^[\w.-]+$/.test(key)) throw new Error(`invalid config key: ${key}`);
  const r = await execOmp(['config', 'unset', key]);
  if (r.code !== 0) {
    // Older omp may not have `unset` — try `set <key> ''`.
    const r2 = await execOmp(['config', 'set', key, '']);
    if (r2.code !== 0) {
      const detail = (r2.stderr || r2.stdout).trim().slice(0, 400);
      throw new Error(`omp config unset ${key} failed: ${detail || `exit ${r2.code}`}`);
    }
  }
}
