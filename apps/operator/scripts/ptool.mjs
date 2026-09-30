#!/usr/bin/env node
/**
 * ptool.mjs — the `ptool` command.
 *
 * An interactive CLI for invoking any `defineTool` endpoint from the
 * terminal. You pick a service, then an endpoint, then ptool prompts for
 * each argument (derived from the tool's `inputSchema`) and calls it.
 *
 * It talks to the operator over the SAME superuser surface the engineer
 * shells use — the MCP transport at `/api/mcp?superuser=1` (loopback +
 * the `PAPERCUSP_HOME/superuser-token` (or `~/.papercusp/superuser-token`)
 * bearer). That transport already
 * exposes every projected `defineTool` with its `inputSchema` and runs at
 * operator tier (role/capability/quota gates bypassed), so ptool needs no
 * server-side support: discovery (`tools/list`) and invocation
 * (`tools/call`) both ride it.
 *
 * Sibling to `psu` (psu-launcher.mjs) — same conventions: lives in the repo
 * so it resolves `@inquirer/prompts` + the MCP SDK from the operator's
 * node_modules; the on-PATH `ptool` shim (install-standalone-mcp.sh) is a
 * plain `exec node <this file>` — deliberately NOT behind the install:safe
 * mutex, whose reader guard could swallow a completed invocation into an
 * exit-0/near-zero-output no-op (EI-21267836337650976 /
 * EI-21250765620092599); `PAPERCUSP_OPERATOR_URL`
 * overrides the host; the token is read from `--token-file`, then
 * `PAPERCUSP_MCP_TOKEN_FILE`, then `PAPERCUSP_HOME/superuser-token`, then
 * `~/.papercusp/superuser-token`.
 *
 * Interactive:  ptool
 *               ptool <group:verb>                 # skip the pickers, prompt args
 * Scripting:    ptool <group:verb> --json - <<'EOF'          # read JSON from stdin (safe; raw controls in strings are escaped)
 *               {"copy": "it's fine now"}
 *               EOF
 *               ptool <group:verb> --json-file payload.json   # read JSON from a file (safe)
 *               ptool <group:verb> --json '{...}'            # quote-free inline payloads only
 *               ptool code:run --script-file batch.js     # carry script as file data
 *               ptool code:run --script - <<'EOF'          # carry script as stdin data
 *               return await tools.dev.build_status({});
 *               EOF
 *               ptool --list [filter]              # print the catalog
 *               ptool <group:verb> --workspace=<ws> --harness=<slug>
 *               ptool <group:verb> --all-workspaces
 *
 * Prefer `--json -` (read stdin) or `--json-file <path>` for arbitrary payloads,
 * especially `loop:checkpoint` checks/walls whose recheck text commonly contains
 * shell quotes. Literal control characters inside quoted JSON strings (for example
 * a multiline decision body) are escaped before parsing; a `--json '<inline>'` argument asks the SHELL to carry the JSON
 * through a single-quoted argument — any apostrophe in the payload (a normal
 * English string like "it's") terminates that shell quoting early and the tool
 * never sees valid JSON (EI-14958). For `code:run`, use `--script -` or
 * `--script-file <path>` to carry JavaScript source as data; prefer these for
 * scripts containing nested shell commands, substitutions, or quoted strings.
 *
 * When launched inside a tracked psu session, ptool carries PAPERCUSP_SID as
 * the MCP `client=` identity. That makes it a safe transport fallback when a
 * client has connected to papercusp-su but deferred every MCP tool schema:
 * calls still belong to the current session rather than the shared
 * `su-loopback` fallback identity. Workspace scope is resolved from the
 * explicit flag first, then the session environment/path, so a warm-loop wake
 * whose shell lost `PAPERCUSP_WORKSPACE` does not silently fall back to the
 * default workspace. MCP payloads use the trimmed context tier by default,
 * matching psu launches; set `PAPERCUSP_CONTEXT_TIER=full` for the explicit
 * unshaped-payload escape hatch.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PSU_REQUEST_TIMEOUT_MS } from '../lib/mcp-proxy/budgets.mjs';
import { discoverOperatorUrl, rebaseUrl, resolveOperatorBase } from './operator-discovery.mjs';

/** @typedef {Record<string, string | undefined>} EnvironmentMap */
/**
 * @typedef {{
 *   name: string,
 *   description?: string,
 *   inputSchema?: Record<string, unknown>,
 *   outputSchema?: Record<string, unknown>,
 *   annotations?: {readOnlyHint?: boolean},
 * }} ToolCatalogEntry
 */

// When ptool is launched from an operator host, prefer the host's explicit
// resolved base (written by serve.ts after binding) or serving port over the
// inherited `.env.local` green pin. Source-root markers identify ownership,
// not a listener port; packaged installs without a host identity retain
// operator.json discovery and the resilient proxy/default.
export function resolvePtoolOperatorBase(env = process.env) {
  const resolvedBase = typeof env.PAPERCUSP_OPERATOR_BASE === 'string'
    ? env.PAPERCUSP_OPERATOR_BASE.trim()
    : '';
  if (resolvedBase) return resolveOperatorBase({ operatorUrl: resolvedBase }, env);
  return resolveOperatorBase({}, env, { preferSelfPort: true });
}

/**
 * Resolve the implicit operator candidates for ptool. An operator-host shell
 * can retain a dead PAPERCUSP_HONO_PORT after its per-session host exits; the
 * canonical green operator is still a safe recovery target in that case.
 * Keep this fallback limited to the implicit self-port route so an explicit
 * --url or a bare PAPERCUSP_OPERATOR_URL without a self-port remains an
 * authoritative pin.
 *
 * @param {EnvironmentMap} [env]
 * @param {string | null} [explicitUrl]
 * @returns {string[]}
 */
export function resolvePtoolOperatorCandidates(env = process.env, explicitUrl = null) {
  const explicit = typeof explicitUrl === 'string' ? explicitUrl.trim() : '';
  if (explicit) return [explicit];

  const primary = resolvePtoolOperatorBase(env);
  const selfPort = typeof env.PAPERCUSP_HONO_PORT === 'string'
    ? env.PAPERCUSP_HONO_PORT.trim()
    : '';
  if (!/^\d+$/.test(selfPort) || Number(selfPort) < 1 || Number(selfPort) > 65535) return [primary];
  try {
    const parsed = new URL(primary);
    const localHost = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
    const parsedPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    if (localHost && selfPort !== '3070' && parsedPort === selfPort) {
      return [primary, `${parsed.protocol}//127.0.0.1:3070`];
    }
  } catch {
    // connectWithLocalRetry will report malformed primary URLs; do not mask
    // that diagnostic while resolving an optional fallback.
  }
  return [primary];
}

/**
 * A named call must use the operator selected at invocation start. Otherwise a
 * dead staging listener can silently move a schema-dependent write or replay to
 * an older live operator. Catalog browsing may still recover to another host;
 * callers can then explicitly pin that host with --url for a subsequent call.
 */
export function resolvePtoolInvocationCandidates(args = {}, env = process.env) {
  const candidates = resolvePtoolOperatorCandidates(env, args.url);
  return args.tool ? candidates.slice(0, 1) : candidates;
}

const OPERATOR_URL = resolvePtoolOperatorBase(process.env);

// psu-launcher exports the resolved URL into every child so the MCP config can
// reach the same operator. That export is a managed handoff, not an explicit
// caller pin: a wake-respawn must be allowed to rediscover operator.json when
// the desktop operator has moved to a new port. The launcher stamps this value
// only on managed exports; a bare PAPERCUSP_OPERATOR_URL remains authoritative.
export const OPERATOR_URL_PROVENANCE_ENV = 'PAPERCUSP_OPERATOR_URL_PROVENANCE';
export const LAUNCHER_OPERATOR_URL_PROVENANCE = 'psu-launcher';

/**
 * Whether the operator URL came from implicit local discovery and may follow a
 * packaged operator that restarts onto a different port. Explicit CLI/env
 * URLs are pins: changing them behind the caller's back would violate the
 * caller's transport choice (and could route a request to the wrong host).
 */
export function shouldRediscoverOperatorUrl(args = {}, env = process.env) {
  return !args.url && (
    !env.PAPERCUSP_OPERATOR_URL ||
    env[OPERATOR_URL_PROVENANCE_ENV] === LAUNCHER_OPERATOR_URL_PROVENANCE
  );
}

/**
 * Pinned operator URLs are caller-selected endpoints, not managed launcher
 * routes. A dead pin must report its connection failure promptly instead of
 * spending the managed route's 120s recovery budget retrying an endpoint that
 * cannot be rediscovered or rebased. Managed/discoverable routes retain their
 * bounded retry loop for operator restarts.
 */
export function ptoolConnectionRetryOptions(args = {}, env = process.env) {
  return shouldRediscoverOperatorUrl(args, env) ? {} : { maxAttempts: 1 };
}

/* ─── arg parsing (pure — exported for tests) ─────────────────────────── */

/**
 * Parse argv into the ptool invocation shape. The first non-flag positional
 * is the tool name (`group:verb`); everything else is a flag. Pure.
 */
export function parseArgs(argv = []) {
  const out = {
    tool: null,
    json: null,
    jsonFile: null,
    script: null,
    scriptFile: null,
    list: false,
    listFilter: null,
    workspace: null,
    allWorkspaces: false,
    harness: null,
    projection: null,
    idempotencyKey: null,
    raw: false,
    url: null,
    tokenFile: null,
    transport: null,
    help: false,
  };
  // Value-bearing flags accept BOTH `--flag=value` and `--flag value`. Map a
  // flag name to the out-key it sets (`--args` is an alias for `--json`).
  const valueFlags = {
    '--json': 'json',
    '--args': 'json',
    '--json-file': 'jsonFile',
    '--script': 'script',
    '--script-file': 'scriptFile',
    '--workspace': 'workspace',
    '--harness': 'harness',
    '--projection': 'projection',
    '--idempotency-key': 'idempotencyKey',
    '--url': 'url',
    '--token-file': 'tokenFile',
    '--transport': 'transport',
  };
  const stdinValueFlags = new Set(['--json', '--args', '--script']);
  let pendingStdinCapableValueFlag = null;
  let sawList = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--raw') { out.raw = true; continue; }
    if (a === '--all-workspaces') { out.allWorkspaces = true; continue; }
    if (a === '--list' || a === '-l') { out.list = true; sawList = true; continue; }
    // `--flag=value`
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) {
      const key = valueFlags[a.slice(0, eq)];
      if (key) { out[key] = a.slice(eq + 1); continue; }
      throw new Error(
        `unknown flag ${a}; tool-specific arguments must be supplied in the JSON payload via --json, --json-file, or --json -`,
      );
    }
    // `--json -` / `--script -` are documented stdin forms. Convenience
    // flags may be interleaved between the source flag and the sentinel, so
    // do not consume the first option as JSON/script text when a later `-`
    // is present.
    if (valueFlags[a]) {
      if (i + 1 >= argv.length) {
        throw new Error(`--${a.slice(2)} requires a value`);
      }
      const next = argv[i + 1];
      const nextLooksLikeFlag = next !== '-'
        && (next.startsWith('--') || next === '-h' || next === '-l');
      if (stdinValueFlags.has(a) && nextLooksLikeFlag && argv.slice(i + 1).includes('-')) {
        out[valueFlags[a]] = '-';
        continue;
      }
      if (nextLooksLikeFlag) {
        // Source flags may be followed by transport flags before their
        // inline value. Defer the value until the next non-flag token so
        // `--json --workspace ws --projection <spec> <json>` is equivalent
        // to the conventional `--json <json> --workspace ws` ordering.
        if (stdinValueFlags.has(a)) {
          pendingStdinCapableValueFlag = a;
          continue;
        }
        throw new Error(`--${a.slice(2)} requires a value`);
      }
      out[valueFlags[a]] = argv[++i];
      continue;
    }
    if (a.startsWith('--')) {
      throw new Error(
        `unknown flag ${a}; tool-specific arguments must be supplied in the JSON payload via --json, --json-file, or --json -`,
      );
    }
    if (pendingStdinCapableValueFlag && !a.startsWith('-')) {
      out[valueFlags[pendingStdinCapableValueFlag]] = a;
      pendingStdinCapableValueFlag = null;
      continue;
    }
    // A bare positional: the tool name first, then (if --list was given) a
    // catalog filter term.
    if (!a.startsWith('-')) {
      if (!out.tool && !sawList) out.tool = a;
      else if (sawList && !out.listFilter) out.listFilter = a;
      else if (!out.tool) out.tool = a;
    }
  }
  if (pendingStdinCapableValueFlag) {
    throw new Error(`--${pendingStdinCapableValueFlag.slice(2)} requires a value`);
  }
  if (out.allWorkspaces && out.workspace) {
    throw new Error('--all-workspaces cannot be combined with --workspace');
  }
  return out;
}

/**
 * Resolve the workspace scope for a ptool session. An explicit CLI flag wins;
 * otherwise mirror the OMP coordination hook's session-local resolution:
 * `PAPERCUSP_WORKSPACE`, then the workspace name embedded in
 * `PAPERCUSP_HOME`/cwd. Returning null when no tracked scope is available is
 * deliberate — ptool must never guess a tenant. Pure when `env` and `cwd` are
 * supplied; both are injectable for tests.
 * @param {{workspace?: string | null, allWorkspaces?: boolean, env?: EnvironmentMap, cwd?: string}} [options]
 * @returns {string | null}
 */
export function resolveWorkspaceScope({ workspace = null, allWorkspaces = false, env = process.env, cwd } = {}) {
  const explicit = typeof workspace === 'string' ? workspace.trim() : '';
  if (allWorkspaces) {
    if (explicit) throw new Error('--all-workspaces cannot be combined with --workspace');
    return '*';
  }
  if (explicit) return explicit;

  const fromEnv = typeof env?.PAPERCUSP_WORKSPACE === 'string' ? env.PAPERCUSP_WORKSPACE.trim() : '';
  if (fromEnv) return fromEnv;

  let currentDir = typeof cwd === 'string' ? cwd : '';
  if (!currentDir) {
    try {
      currentDir = process.cwd();
    } catch {
      currentDir = '';
    }
  }
  for (const candidate of [env?.PAPERCUSP_HOME ?? '', currentDir]) {
    const match = String(candidate).match(/\.papercusp-workspaces[\\/]([^\\/]+)/);
    if (match?.[1] && match[1] !== '.papercusp') return match[1];
  }
  return null;
}

/**
 * Resolve a harness scope embedded in a parsed ptool payload. Direct calls
 * carry `harness` at the top level; a `tools:invoke` wrapper carries it in
 * the nested target `args`. Only the wrapper path is recursive so an
 * unrelated nested object cannot accidentally become session scope. Pure.
 * @param {unknown} payload
 * @param {{toolName?: string | null}} [options]
 * @returns {string | null}
 */
export function resolvePayloadHarnessScope(payload, { toolName = null } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const direct = typeof payload.harness === 'string' ? payload.harness.trim() : '';
  if (direct) return direct;

  const isToolsInvoke = toolName === 'tools:invoke' || payload.name === 'tools:invoke';
  if (!isToolsInvoke || !payload.args || typeof payload.args !== 'object' || Array.isArray(payload.args)) {
    return null;
  }
  return resolvePayloadHarnessScope(payload.args, { toolName: 'tools:invoke' });
}

/**
 * Resolve the harness scope for a ptool session. An explicit CLI flag wins;
 * otherwise use the parsed payload's harness, then inherit the harness
 * exported by a tracked su/psu session. A missing harness stays null
 * deliberately — ptool must not guess a project when the caller is not
 * harness-scoped.
 * @param {{harness?: string | null, payload?: unknown, toolName?: string | null, env?: EnvironmentMap}} [options]
 * @returns {string | null}
 */
export function resolveHarnessScope({ harness = null, payload, toolName = null, env = process.env } = {}) {
  const explicit = typeof harness === 'string' ? harness.trim() : '';
  if (explicit) return explicit;

  const fromPayload = resolvePayloadHarnessScope(payload, { toolName });
  if (fromPayload) return fromPayload;

  const fromEnv = typeof env?.PAPERCUSP_HARNESS_SLUG === 'string'
    ? env.PAPERCUSP_HARNESS_SLUG.trim()
    : '';
  return fromEnv || null;
}

/**
 * Resolve the MCP payload tier for a ptool session. Direct ptool invocations
 * do not inherit psu's URL interpolation, so they must carry the same bounded
 * default themselves. `PAPERCUSP_CONTEXT_TIER=full` is the explicit escape
 * hatch for callers that need the unshaped response. Pure when `env` is
 * supplied; values are passed through so the server remains the authority for
 * the supported tier vocabulary.
 * @param {{contextTier?: string | null, env?: EnvironmentMap}} [options]
 * @returns {string}
 */
export function resolveContextTier({ contextTier = null, env = process.env } = {}) {
  const explicit = typeof contextTier === 'string' ? contextTier.trim() : '';
  if (explicit) return explicit;

  const fromEnv = typeof env?.PAPERCUSP_CONTEXT_TIER === 'string'
    ? env.PAPERCUSP_CONTEXT_TIER.trim()
    : '';
  return fromEnv || 'trimmed';
}

/**
 * Decide where a ptool invocation's JSON args payload comes from, given
 * parsed args. Pure — the actual file/stdin read is impure and lives in
 * `main()`; this just picks the source so the branching is testable without
 * a real filesystem/stdin (EI-14958: a shell-quoted `--json '<inline>'`
 * cannot safely carry an apostrophe, so `file`/`stdin` exist as quoting-free
 * alternatives).
 *   'file'   — `--json-file <path>` was given (takes priority over --json).
 *   'stdin'  — `--json -` (the literal dash sentinel).
 *   'inline' — a normal `--json '<...>'` / `--args '<...>'` value.
 *   null     — no JSON source given; caller should prompt interactively.
 */
export function jsonSourceKind(args) {
  if (args.jsonFile) return 'file';
  if (args.json === '-') return 'stdin';
  if (args.json != null) return 'inline';
  return null;
}

/**
 * Escape literal JSON control characters that occur inside quoted strings.
 * JSON requires those characters to be represented as escapes, but a heredoc
 * is a natural way to author a multiline tool argument and users should not
 * have to hand-escape every line break. Formatting whitespace outside strings
 * is left untouched, as are already-escaped sequences. Pure.
 * @param {string} text
 * @returns {string}
 */
export function escapeJsonStringControls(text) {
  if (typeof text !== 'string') return String(text);

  let inString = false;
  let escaped = false;
  let changed = false;
  let repaired = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (inString) {
      if (escaped) {
        repaired += ch;
        escaped = false;
      } else if (ch === '\\') {
        repaired += ch;
        escaped = true;
      } else if (ch === '"') {
        repaired += ch;
        inString = false;
      } else if (code < 0x20) {
        repaired += `\\u${code.toString(16).padStart(4, '0')}`;
        changed = true;
      } else {
        repaired += ch;
      }
    } else {
      repaired += ch;
      if (ch === '"') inString = true;
    }
  }

  return changed ? repaired : text;
}

/**
 * Parse a ptool JSON payload after normalizing heredoc-friendly string controls.
 * An empty stdin stream is equivalent to omitting JSON args, which lets callers
 * use the standard quoting-safe `--json -` shape for zero-argument tools. Files
 * and inline payloads remain strict so an accidentally empty payload still
 * fails loudly. Pure.
 */
export function parseJsonInput(text, { emptyAsObject = false } = {}) {
  if (emptyAsObject && String(text).trim() === '') return {};
  return JSON.parse(escapeJsonStringControls(text));
}

export function formatJsonInputError(jsonKind, error) {
  const message = error instanceof Error ? error.message : String(error);
  const hint = /bad escaped character/i.test(message)
    ? ' Hint: JSON strings must escape literal backslashes by doubling each one; JSON.stringify can build the payload safely.'
    : '';
  return `ptool: --json${jsonKind === 'inline' ? '' : ` (${jsonKind})`} is not valid JSON: ${message}${hint}`;
}

/**
 * Decide where a direct `code:run` script comes from. The file/stdin forms
 * carry JavaScript as data, so the caller's shell never has to quote nested
 * commands or apostrophes (EI-20235746813390458). `--script-file` takes
 * priority over `--script`, mirroring jsonSourceKind's file precedence.
 * Pure — the actual file/stdin read is impure and lives in main().
 *
 *   'file'   — `--script-file <path>` was given.
 *   'stdin'  — `--script -` was given.
 *   'inline' — a normal `--script '<source>'` value.
 *   null     — no direct script source was given.
 */
export function scriptSourceKind(args) {
  if (args.scriptFile) return 'file';
  if (args.script === '-') return 'stdin';
  if (args.script != null) return 'inline';
  return null;
}

/**
 * Decide whether the human-readable invocation line belongs on stderr.
 * Scripted JSON mode must leave stdout/stderr suitable for machine capture;
 * interactive calls retain the line as useful operator feedback. Pure.
 */
export function shouldPrintInvocationLine(jsonKind) {
  return jsonKind == null;
}

/**
 * Scripted JSON calls must keep stdout machine-parseable. The MCP response may
 * contain advisory text after its primary JSON content, so every explicit JSON
 * input uses the raw extractor even when the caller did not spell `--raw`.
 * Interactive calls retain the existing pretty human-readable output unless
 * `--raw` was explicitly requested.
 */
export function shouldPrintRawResult(jsonKind, raw) {
  return Boolean(raw || jsonKind != null);
}

/* ─── catalog grouping (pure — exported for tests) ────────────────────── */

/** The service a tool belongs to — the segment before the first `:`
 *  (`work_items:list` → `work_items`). Colon-less names group under
 *  `(misc)`. Pure. */
export function serviceOf(name) {
  const i = name.indexOf(':');
  return i > 0 ? name.slice(0, i) : '(misc)';
}

/**
 * Group a tools array into `{ service: tool[] }`, services and tools each
 * sorted by name. Pure — exported for tests. Each tool keeps its original
 * `{ name, description, inputSchema }`.
 * @param {ToolCatalogEntry[]} tools
 * @returns {Map<string, ToolCatalogEntry[]>}
 */
export function groupTools(tools) {
  const byService = new Map();
  for (const t of tools) {
    const svc = serviceOf(t.name);
    if (!byService.has(svc)) byService.set(svc, []);
    byService.get(svc).push(t);
  }
  for (const list of byService.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }
  return new Map([...byService.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

/** First non-empty line of a (possibly multi-line guidance) description,
 *  trimmed + truncated to `max` chars. Pure. */
export function firstLine(desc, max = 90) {
  if (!desc) return '';
  const line = String(desc).split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

/* ─── schema → prompt specs (pure — exported for tests) ───────────────── */

/** Normalize a JSON-schema `type` that may be a string or an array
 *  (`['string','null']`) to the first non-null type. Pure. */
export function normalizeType(type) {
  if (Array.isArray(type)) return type.find((t) => t && t !== 'null') ?? null;
  return type ?? null;
}

/**
 * Derive an ordered list of prompt specs from a tool's JSON `inputSchema`.
 * Required properties come first (in schema order), then optionals. Each
 * spec: `{ name, required, kind, enumValues?, description, default }` where
 * `kind` ∈ enum | boolean | number | integer | string | json. Anything not
 * a plain scalar (arrays, objects, unions, unknown) falls to `json` (raw
 * JSON entry). Pure — exported for tests.
 */
export function promptSpecsFromSchema(inputSchema) {
  const props = (inputSchema && inputSchema.properties) || {};
  const required = new Set(Array.isArray(inputSchema?.required) ? inputSchema.required : []);
  const specs = [];
  for (const [name, raw] of Object.entries(props)) {
    const sub = raw && typeof raw === 'object' ? raw : {};
    const type = normalizeType(sub.type);
    let kind;
    let enumValues;
    if (Array.isArray(sub.enum) && sub.enum.length > 0) {
      kind = 'enum';
      enumValues = sub.enum;
    } else if (type === 'boolean') kind = 'boolean';
    else if (type === 'integer') kind = 'integer';
    else if (type === 'number') kind = 'number';
    else if (type === 'string') kind = 'string';
    else kind = 'json'; // array | object | union (anyOf/oneOf) | unknown
    specs.push({
      name,
      required: required.has(name),
      kind,
      enumValues,
      description: typeof sub.description === 'string' ? sub.description : '',
      default: sub.default,
    });
  }
  // Required first (keep schema order within each group).
  return [...specs.filter((s) => s.required), ...specs.filter((s) => !s.required)];
}

/**
 * Coerce a raw user-entered string to the typed value its spec wants.
 * Throws on a malformed number / JSON so a bad arg fails loudly rather than
 * being sent as the wrong type. `boolean`/`enum` values arrive already typed
 * (from confirm/select) and pass through. Pure — exported for tests.
 */
export function coerceArg(kind, raw) {
  switch (kind) {
    case 'boolean':
    case 'enum':
      return raw; // already a typed value from the prompt widget
    case 'integer': {
      const n = Number(raw);
      if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error(`not an integer: "${raw}"`);
      return n;
    }
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`not a number: "${raw}"`);
      return n;
    }
    case 'json': {
      try {
        return JSON.parse(raw);
      } catch (e) {
        throw new Error(`not valid JSON: ${e.message}`);
      }
    }
    case 'string':
    default:
      return raw;
  }
}

/**
 * Merge `--workspace`/`--harness` convenience flags into an args object,
 * but ONLY for properties the tool's schema actually declares (so we never
 * inject an arg a tool would reject). Existing keys in `args` win. Pure.
 * @param {Record<string, unknown>} args
 * @param {{workspace?: unknown, harness?: unknown}} convenience
 * @param {{properties?: Record<string, unknown>} | null | undefined} inputSchema
 * @param {{toolName?: string | null}} [options]
 * @returns {Record<string, unknown>}
 */
export function mergeConvenienceArgs(args, { workspace, harness }, inputSchema, { toolName = null } = {}) {
  const props = (inputSchema && inputSchema.properties) || {};
  const out = { ...args };
  // EI-22785520568687738: testing:runs declares workspace/harness as explicit
  // ledger filters, but its CI rows intentionally store both columns NULL.
  // The ptool session scope still belongs in the MCP URL; copying that ambient
  // scope into this tool's args silently filters every CI row out. Callers that
  // need a ledger filter can provide it explicitly in the JSON payload.
  const injectScopeFilters = toolName !== 'testing:runs';
  // `work_items:rehome` exposes a flattened union schema: `harness` belongs to
  // the move variant, while classify accepts only its discriminator and id.
  // Ambient session scope must not select a variant-incompatible key. Keep an
  // explicitly supplied value untouched so this helper preserves its existing
  // caller-owned-args semantics.
  const rehomeClassify = toolName === 'work_items:rehome' && out.op === 'classify';
  // `workspace:work_scope` is another flattened discriminated union: only the
  // check variant accepts `harness`; get/set/clear intentionally reject it.
  // The ambient harness still scopes the MCP session URL, so do not copy it
  // into those variant payloads.
  const workScopeNonCheck = toolName === 'workspace:work_scope' && out.op !== 'check';
  if (injectScopeFilters && workspace != null && 'workspace' in props && !('workspace' in out)) out.workspace = workspace;
  if (injectScopeFilters && !rehomeClassify && !workScopeNonCheck && harness != null && 'harness' in props && !('harness' in out)) out.harness = harness;
  return out;
}

/**
 * Add a caller-owned result projection to a direct tool call. The MCP
 * transport reserves `projection` at the dispatch layer, so it must travel
 * alongside the target tool's ordinary arguments rather than being dropped
 * by the CLI parser. An explicit projection already present in JSON wins,
 * matching mergeConvenienceArgs' preserve-explicit-args behavior. Pure.
 */
export function mergeDispatchProjection(args, projection) {
  if (projection === undefined) return args;
  if (args && typeof args === 'object' && !Array.isArray(args) && Object.hasOwn(args, 'projection')) {
    return args;
  }
  const base = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  return { ...base, projection };
}

/** Server-owned proof metadata emitted by a completed, settled-read code:run. */
export const CODE_RUN_REPLAY_PROOF_META_KEY = 'codeRunReplayProof';
export const CODE_RUN_REPLAY_PROOF_SCHEMA_VERSION = 1;
export const CODE_RUN_TOOL_NAME = 'code:run';

/**
 * Canonical JSON matching the server's codeRunRequestHash implementation:
 * object keys sort recursively, array order is retained, undefined object
 * values are dropped, and undefined array slots become null. Pure.
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((entry) => entry === undefined ? 'null' : canonicalJson(entry)).join(',')}]`;
  }
  const object = value;
  return `{${Object.keys(object)
    .sort()
    .filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

/** SHA-256 of the exact code:run argument object sent in `params.arguments`. */
export function codeRunRequestHash(args) {
  return createHash('sha256').update(canonicalJson(args), 'utf8').digest('hex');
}

/**
 * Validate server-owned code:run replay evidence against the exact MCP body.
 * Catalog annotations, tool names, script text, and caller-authored argument
 * fields are deliberately not accepted as replay authority.
 */
export function isValidCodeRunReplayProof(proof, params) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return false;
  if (params?.name !== CODE_RUN_TOOL_NAME) return false;
  if (proof.schemaVersion !== CODE_RUN_REPLAY_PROOF_SCHEMA_VERSION) return false;
  if (proof.kind !== 'settled-read' || proof.tool !== CODE_RUN_TOOL_NAME) return false;
  if (!Number.isSafeInteger(proof.callCount) || proof.callCount < 1) return false;
  if (typeof proof.requestHash !== 'string') return false;
  const requestHash = proof.requestHash.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(requestHash)) return false;
  return codeRunRequestHash(params.arguments) === requestHash;
}

/** Alias that reads naturally at the replay decision point. */
export function isCodeRunReplayAuthorized(params, proof) {
  return isValidCodeRunReplayProof(proof, params);
}

/* ─── result formatting (pure — exported for tests) ───────────────────── */

/**
 * Repair JSON text whose string values contain literal control characters.
 * A tool can return JSON in an MCP text content block, and printing that text
 * unchanged makes `ptool --raw | jq` reject the whole result. Only escape
 * controls found inside structurally quoted spans; preserve ordinary human
 * text and malformed JSON that contains no such controls verbatim. The result
 * door may truncate otherwise-valid JSON, so whole-document validity cannot be
 * a prerequisite for repairing the visible prefix.
 */
export function sanitizeJsonText(text) {
  if (typeof text !== 'string') return String(text);
  const first = text.trimStart()[0];
  if (first !== '{' && first !== '[' && first !== '"') return text;

  try {
    JSON.parse(text);
    return text;
  } catch {
    // Continue only for the known text-content serialization defect below.
  }

  return escapeJsonStringControls(text);
}

/** Pretty-print a text payload: if it parses as JSON, indent it; else
 *  return it unchanged. Pure. */
export function prettyText(text) {
  if (typeof text !== 'string') return String(text);
  const t = text.trim();
  if (!t) return text;
  if (t[0] !== '{' && t[0] !== '[') return text;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return text;
  }
}

/**
 * Find a complete JSON value at the start of a text block. The MCP result
 * door can append its guidance/truncation notice to the SAME text item as an
 * otherwise-complete JSON payload, so parsing the whole item is too strict.
 * A structurally complete root is safe to return; an actually truncated
 * object/array never reaches a closing root and remains fail-closed. Pure.
 */
function completeJsonPrefix(text) {
  if (typeof text !== 'string') return null;
  const start = text.search(/\S/);
  if (start < 0) return null;
  const first = text[start];

  // Object/array roots need a structural scan so braces inside quoted values
  // and nested containers do not masquerade as the document boundary.
  if (first === '{' || first === '[') {
    const stack = [first === '{' ? '}' : ']'];
    let inString = false;
    let escaped = false;
    for (let i = start + 1; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') stack.push('}');
      else if (ch === '[') stack.push(']');
      else if (ch === '}' || ch === ']') {
        if (stack.at(-1) !== ch) return null;
        stack.pop();
        if (stack.length === 0) {
          const candidate = text.slice(start, i + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  // JSON string roots are uncommon for tool results, but escaped quotes must
  // not terminate the value early.
  if (first === '"') {
    let escaped = false;
    for (let i = start + 1; i < text.length; i += 1) {
      const ch = text[i];
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') {
        const candidate = text.slice(start, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  // Scalar roots end at the first whitespace before any appended guidance.
  const end = text.search(/\s/, start + 1);
  const candidate = text.slice(start, end < 0 ? text.length : end);
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * A projected MCP result keeps trust-degrading warnings in a leading text
 * item, ahead of the JSON payload. Raw ptool output must stay parseable, so
 * surface that warning on stderr instead of letting raw extraction discard it.
 * This mirrors result-door's structural projection warning bridge.
 */
function leadingProjectionWarning(result) {
  const projection = result?._meta?.resultProjection;
  if (projection?.applied !== true) return '';
  if (!Array.isArray(projection.notes) && projection.notes !== undefined) return '';

  const textParts = Array.isArray(result?.content)
    ? result.content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
    : [];
  const jsonItemIndex = textParts.findIndex((text) => {
    const sanitized = sanitizeJsonText(text);
    try {
      JSON.parse(sanitized);
      return true;
    } catch {
      return completeJsonPrefix(sanitized) !== null;
    }
  });
  if (jsonItemIndex <= 0) return '';
  return textParts
    .slice(0, jsonItemIndex)
    .find((text) => text.trimStart().startsWith('⚠')) ?? '';
}

/** Prefer the complete structured result requested by ptool, then fall back to
 *  flattening an MCP tools/call result's `content[]` into one text blob.
 *  Content text may carry result-door truncation markers and is therefore a
 *  human-readable fallback, not the scripting authority. Pure.
 *  @param {any} result
 *  @param {{raw?: boolean}} [options]
 */
export function resultToText(result, { raw = false } = {}) {
  if (result && Object.prototype.hasOwnProperty.call(result, 'structuredContent')) {
    const structuredText = JSON.stringify(result.structuredContent);
    if (typeof structuredText === 'string') return structuredText;
  }

  const parts = Array.isArray(result?.content) ? result.content : [];
  const textParts = parts
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text);
  const contentText = parts
    .map((c) => (c && c.type === 'text' && typeof c.text === 'string' ? c.text : JSON.stringify(c)))
    .join('\n');

  // MCP guidance is appended as a separate text item (for example, the
  // `See also:` block on loop:status). It is useful in the interactive
  // display, but contaminates stdout for `ptool --raw | jq`. If the joined
  // body is not JSON, recover the first complete JSON text item as the
  // scripting payload. Sanitize before parsing because tool text can contain
  // literal control characters (see sanitizeJsonText below).
  if (raw) {
    const primaryJson = textParts.find((text) => {
      const sanitized = sanitizeJsonText(text);
      try {
        JSON.parse(sanitized);
        return true;
      } catch {
        return completeJsonPrefix(sanitized) !== null;
      }
    });
    if (primaryJson !== undefined) {
      const sanitized = sanitizeJsonText(primaryJson);
      try {
        JSON.parse(sanitized);
        return sanitized;
      } catch {
        return completeJsonPrefix(sanitized) ?? primaryJson;
      }
    }
  }

  return contentText;
}

const SCRATCH_URI_PREFIX = 'papercusp://scratch/';
const OUTPUT_ENVELOPE_SCHEMA_VERSION = 'papercusp.output-envelope/v1';

/**
 * Filesystem root for scratch spill files, mirroring
 * packages/operator-core/lib/scratch-uri.ts's `scratchRoot()` (the operator's
 * own resolver): `PAPERCUSP_SCRATCH_ROOT` override, else `~/.papercusp/scratch`.
 * ptool.mjs is plain JS (no ts-node loader in its runtime), so it cannot import
 * that TS module directly — this mirrors its resolution logic instead of
 * re-deriving it independently, so the two never drift apart on which root a
 * spill actually landed under.
 */
function scratchRootDir(env = process.env) {
  const override = typeof env.PAPERCUSP_SCRATCH_ROOT === 'string' ? env.PAPERCUSP_SCRATCH_ROOT.trim() : '';
  if (override) return override;
  return join(homedir(), '.papercusp', 'scratch');
}

/**
 * Map a `papercusp://scratch/<workspace>/<tool>/<runId>/<basename>` URI to its
 * file on disk, or '' when it doesn't match the scheme or would resolve
 * outside the scratch root. Deliberately minimal (prefix + traversal check
 * only, not the full class-based validator in scratch-uri.ts): ptool is a
 * TRUSTED client reading a URI its OWN operator just generated over an
 * authenticated bearer, not a server accepting untrusted input.
 */
export function scratchUriToPath(uri, env = process.env) {
  if (typeof uri !== 'string' || !uri.startsWith(SCRATCH_URI_PREFIX)) return '';
  const rest = uri.slice(SCRATCH_URI_PREFIX.length);
  if (!rest || rest.includes('\0') || /(^|\/)\.\.(\/|$)/.test(rest)) return '';
  const root = scratchRootDir(env);
  const candidate = resolve(root, rest);
  if (candidate !== root && !candidate.startsWith(root + sep)) return '';
  return candidate;
}

/** Parse `text` as a JSON OBJECT (not array/scalar/null) — the shape both a
 *  plain tool result and an output envelope share. Prose parts are expected
 *  to fail this and are the normal case, not an error. */
function tryParseJsonObject(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t.startsWith('{')) return null;
  try {
    const value = JSON.parse(t);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Read the payload back out of one spill file. Line-oriented: a magic line, a
 * manifest line, then the JSON payload — parsed from the LAST non-empty line
 * rather than by a fixed index, since the manifest is allowed to grow and
 * indexing would break silently the first time it did.
 */
async function readSpilledPayload(path) {
  const text = await readFile(path, 'utf8');
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new Error(`empty spill file: ${path}`);
  return JSON.parse(lines[lines.length - 1]);
}

/**
 * Unwrap a parsed `ptool --json` reply down to the tool's own result, when it
 * is actually an OUTPUT ENVELOPE (`schemaVersion: papercusp.output-envelope/v1`)
 * rather than the result itself — the shape a large tool result renders as
 * past a size threshold: a bounded MCP-style `content[]` whose parts are
 * either inline text or, once spilled, `{ kind:'reference', uri, preview }`.
 *
 * WHY THIS EXISTS (EI-22212780570913684, 2026-09-03): a caller that does
 * `JSON.parse(stdout)` then reads `.ok` off the result reads an envelope as a
 * REFUSAL — it has no `.ok` at all — even when the wrapped call SUCCEEDED. A
 * portal build read a granted `locks:acquire` this way, aborted believing it
 * had been refused a lock it was actually holding, and orphaned that lock for
 * its full hour-long TTL because the unwind never reached the release call.
 * The size threshold makes it intermittent (the same command works all
 * afternoon, then fails once a reply grows by a few hundred bytes) — the
 * worst possible property for a lock path. Fixing it here, once, at the
 * client every `ptool --json` caller shares, fixes it for every caller
 * instead of requiring each one to patch around it independently (portal's
 * own `scripts/ptool-envelope.mjs` was the first such patch, and the direct
 * source for this port).
 *
 * A no-op on a plain result (returns the SAME reference — callers can detect
 * "nothing changed" via `!==`). Returns the envelope UNCHANGED when nothing
 * inside it parses: an unreadable reply must stay unreadable, never become a
 * fabricated success. `readSpill`/`fileExists` are injectable for tests.
 */
export async function unwrapOutputEnvelope(parsed, { readSpill = readSpilledPayload, fileExists = existsSync, env = process.env } = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  if (parsed.schemaVersion !== OUTPUT_ENVELOPE_SCHEMA_VERSION) return parsed;
  if (!Array.isArray(parsed.content)) return parsed;
  // Already result-shaped (carries `ok`) — prefer it outright. Also protects a
  // genuine tool result that happens to carry its own `content` array.
  if (Object.prototype.hasOwnProperty.call(parsed, 'ok')) return parsed;

  for (const part of parsed.content) {
    const inline = tryParseJsonObject(part?.text);
    if (inline) return mergeUnwrappedMetadata(inline, parsed._meta);

    if (
      part?.kind === 'reference' ||
      part?.kind === 'evidence-reference' ||
      part?.type === 'reference'
    ) {
      const path = scratchUriToPath(part.uri, env);
      if (!path || !fileExists(path)) continue;
      // The spilled payload is itself an envelope: one of its content parts
      // is the tool's JSON and the rest is advisory prose ("See also: ..."),
      // which is why this scans for a parseable object instead of trusting
      // position (the payload is not always content[0]).
      let spilled;
      try {
        spilled = await readSpill(path);
      } catch {
        continue;
      }
      for (const spilledPart of spilled?.content ?? []) {
        const candidate = tryParseJsonObject(spilledPart?.text);
        if (candidate) return mergeUnwrappedMetadata(candidate, spilled?._meta, parsed._meta);
      }
      // A reference we could read but could not parse falls through to the
      // next part rather than returning early — if none parses, the caller
      // still gets the envelope back and reports it verbatim (never fabricated).
    }
  }
  return parsed;
}

/**
 * Keep result metadata attached while replacing an output envelope with its
 * inner JSON. The outer server metadata is applied last so a payload cannot
 * shadow server-owned replay proof with a caller-authored `_meta` field.
 */
function mergeUnwrappedMetadata(result, ...metadataSources) {
  const metadata = [result?._meta, ...metadataSources]
    .filter((value) => value && typeof value === 'object' && !Array.isArray(value))
    .reduce((merged, value) => Object.assign(merged, value), {});
  if (Object.keys(metadata).length === 0) return result;
  return { ...result, _meta: metadata };
}

/**
 * The result door can splice its truncation notice into a text block before
 * ptool sees it. That leaves a JSON-looking prefix which is not a document;
 * never let that prefix reach a machine-readable stdout stream.
 */
const RESULT_DOOR_TRUNCATION_RE = /\[result-door:[\s\S]{0,2000}\btruncated\b/i;

/**
 * A result-door truncation only tells ptool that the operator's reply is not
 * machine-readable. The tool call may already have executed, which is
 * especially important for writes: retrying blindly can duplicate a
 * non-idempotent mutation. Keep the recovery instruction about execution
 * uncertainty rather than inventing a query/jq pipeline that may not exist.
 */
export const PTOOL_TRUNCATED_RESULT_MESSAGE =
  'ptool: operator reply was truncated before a complete JSON payload; the tool call may have executed — verify its state before retrying. ' +
  'For a large read, retry with a dispatch-level `projection` in the JSON args using paths from the actual payload root; `plans:items` uses `items[].item.id`, `items[].item.status`, and `items[].item.workItemId`. ' +
  'use `payloadTier:"full"` only when you need the unshaped detail and it fits the transport.';

function isInvalidTruncatedJson(text) {
  if (!RESULT_DOOR_TRUNCATION_RE.test(text)) return false;
  try {
    JSON.parse(text);
    return false;
  } catch {
    return true;
  }
}

/* ─── runtime (impure) ────────────────────────────────────────────────── */

/** Resolve the bearer-token files in precedence order. Pure and injectable for
 * tests: an explicit CLI path wins over the environment. When an isolated
 * `PAPERCUSP_HOME` is configured, its token is preferred, but the normal
 * per-home token remains a fallback when the isolated file is absent. A su
 * session can carry the workspace-scoped HOME even though the shared
 * superuser bearer still lives at `~/.papercusp/superuser-token` (EI-202457).
 * @param {{tokenFile?: string|null, env?: EnvironmentMap, home?: string}} [options]
 */
export function resolveTokenPaths({ tokenFile = null, env = process.env, home = homedir() } = {}) {
  const explicit = typeof tokenFile === 'string' ? tokenFile.trim() : '';
  if (explicit) return [explicit];

  const fromEnv = typeof env?.PAPERCUSP_MCP_TOKEN_FILE === 'string'
    ? env.PAPERCUSP_MCP_TOKEN_FILE.trim()
    : '';
  if (fromEnv) return [fromEnv];

  // Packaged and isolated operators set PAPERCUSP_HOME to the directory that
  // owns operator.json, embedded-pg.json, and superuser-token. Falling back to
  // homedir() here sends the host user's token to an isolated endpoint, which
  // is rejected as superuser_invalid_bearer even though the endpoint is live.
  const isolatedHome = typeof env?.PAPERCUSP_HOME === 'string' ? env.PAPERCUSP_HOME.trim() : '';
  const isolated = isolatedHome ? join(isolatedHome, 'superuser-token') : null;
  const shared = join(home, '.papercusp', 'superuser-token');
  return isolated && isolated !== shared ? [isolated, shared] : [shared];
}

/** Resolve the first bearer-token candidate for callers that need one path.
 * @param {{tokenFile?: string|null, env?: EnvironmentMap, home?: string}} [options]
 */
export function resolveTokenPath(options = {}) {
  return resolveTokenPaths(options)[0];
}

function readToken({ tokenFile = null, env = process.env, home = homedir() } = {}) {
  for (const tokenPath of resolveTokenPaths({ tokenFile, env, home })) {
    try {
      const token = readFileSync(tokenPath, 'utf8').trim();
      if (token) return token;
    } catch {
      // Try the next candidate. The isolated workspace token is optional for
      // sessions whose shared superuser bearer is still in the host home.
    }
  }
  return '';
}

/** Build the `tools/call` params for a ptool invocation. Pure and exported so
 *  the MCP result negotiation is regression-tested without opening a
 *  transport. Object-rooted output schemas need `_meta.structured` because
 *  the MCP SDK validates their structured response field (EI-13245), EXCEPT
 *  when the caller supplied a dispatch-level `projection`: the projection
 *  deliberately drops the unprojected structured twin so it cannot defeat the
 *  requested reduction. Projected calls therefore negotiate JSON text and use
 *  the schema-neutral request path in callToolWithPressureRetry below.
 *  Array-rooted tools deliberately omit `outputSchema` because MCP requires
 *  `structuredContent` to be an object; ask those tools for JSON text instead
 *  so ptool still emits a lossless scripting payload.
 *  @param {string} toolName
 *  @param {any} callArgs
 *  @param {{outputSchema?: {type?: string}, idempotencyKey?: string}} [options]
 */
export function buildCallToolParams(toolName, callArgs, { outputSchema, idempotencyKey } = {}) {
  const projected = Boolean(
    callArgs &&
    typeof callArgs === 'object' &&
    !Array.isArray(callArgs) &&
    Object.hasOwn(callArgs, 'projection'),
  );
  const objectRooted = outputSchema?.type === 'object' && !projected;
  const meta = objectRooted ? { structured: true } : { format: 'json' };
  if (idempotencyKey) meta.idempotencyKey = idempotencyKey;
  // EI-21669966698063758: tools:invoke is a second JSON boundary. Keep its
  // target args as one JSON string so shell-heavy code:run payloads survive
  // the host/MCP serialization path exactly once. Direct calls must retain
  // their ordinary object arguments, and an already-stringified nested value
  // must not be encoded again.
  const argumentsValue = toolName === 'tools:invoke' &&
    callArgs &&
    typeof callArgs === 'object' &&
    !Array.isArray(callArgs) &&
    callArgs.args &&
    typeof callArgs.args === 'object' &&
    !Array.isArray(callArgs.args)
    ? { ...callArgs, args: JSON.stringify(callArgs.args) }
    : callArgs;
  return {
    name: toolName,
    arguments: argumentsValue,
    _meta: meta,
  };
}

// `tools/list` is a recovery prerequisite for every named ptool call, but it
// is still a remote MCP request and can stall while the operator is under
// pressure. Do not inherit the SDK's 60s default: a CLI that produces no
// output for a minute looks indistinguishable from a dead operator.
export const PTOOL_LIST_TOOLS_TIMEOUT_MS = 10_000;

// The default dev-box endpoint is the resilient MCP proxy. It deliberately
// holds an initialize request through a :3070 restart for up to 90s, then
// returns a typed 503 when that window is exhausted. A shorter client-side
// handshake deadline abandons that response and turns the proxy's bounded
// failure into an opaque retry loop. Reuse the same client/proxy budget psu
// already owns instead of choosing another independent number here.
export const PTOOL_CONNECT_TIMEOUT_MS = PSU_REQUEST_TIMEOUT_MS;

// EI-22697016277102033: a direct local operator (:3070/:3170 or a packaged
// dynamic port) does not own the resilient proxy's 90s upstream-recovery
// contract. Giving ONE direct initialize attempt the whole 120s total budget
// means a silent handshake consumes every retry: connectWithLocalRetry reaches
// its loop, but has no time left to make attempt two. Staging-sync routinely
// cycles :3170, so keep a direct attempt above the measured ~10-13s hard-down
// window while preserving several attempts inside the existing total budget.
// The resilient proxy itself must retain the full budget: it deliberately holds
// one request through the upstream restart window and returns a typed result.
export const PTOOL_DIRECT_CONNECT_ATTEMPT_TIMEOUT_MS = 15_000;

/**
 * Per-attempt handshake budget for one local MCP origin. Pure and exported so
 * the direct-vs-proxy distinction cannot silently collapse back to one number.
 */
export function ptoolConnectAttemptTimeoutMs(operatorUrl, env = process.env) {
  try {
    const url = new URL(operatorUrl);
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
    if (!local) return PTOOL_CONNECT_TIMEOUT_MS;

    const configuredProxyBase = typeof env.PAPERCUSP_MCP_PROXY_BASE === 'string'
      ? env.PAPERCUSP_MCP_PROXY_BASE.trim()
      : '';
    if (configuredProxyBase && new URL(configuredProxyBase).origin === url.origin) {
      return PTOOL_CONNECT_TIMEOUT_MS;
    }
    const configuredProxyPort = Number(env.PAPERCUSP_MCP_PROXY_PORT);
    const proxyPort = Number.isInteger(configuredProxyPort) && configuredProxyPort > 0
      ? configuredProxyPort
      : 9071;
    if (Number(url.port) === proxyPort) return PTOOL_CONNECT_TIMEOUT_MS;
  } catch {
    // connectWithLocalRetry/connect() will surface the malformed URL. Do not
    // turn input validation into an unrelated timeout-policy error here.
    return PTOOL_CONNECT_TIMEOUT_MS;
  }
  return Math.min(PTOOL_DIRECT_CONNECT_ATTEMPT_TIMEOUT_MS, PTOOL_CONNECT_TIMEOUT_MS);
}

// The proxy's handshake bulkhead returns a retryable HTTP 429 while all
// handshake slots are occupied. Keep the attempt ceiling aligned with the
// complete client budget: a fixed 30-attempt ceiling plus a one-second delay
// silently shortened the 120s recovery window to ~30s, so a busy fleet could
// exhaust ptool before a slot became available (EI-21395813315545528).
export const PTOOL_CONNECT_RETRY_DELAY_MS = 1_000;
export const PTOOL_CONNECT_MAX_ATTEMPTS = Math.ceil(
  PTOOL_CONNECT_TIMEOUT_MS / PTOOL_CONNECT_RETRY_DELAY_MS,
) + 1;

// A proxy-generated handshake 502 already represents the proxy exhausting its
// own bounded upstream-silence retries (currently three upstream attempts).
// Allow one ptool replay for a transient race, but do not replay that expensive
// failure until the outer 120s budget starts another copy of the same stall.
// HTTP 429 remains on the longer budget above: it is pre-dispatch admission
// shedding and the proxy explicitly asks clients to retry it.
export const PTOOL_PROXY_UPSTREAM_ERROR_MAX_ATTEMPTS = 2;

// EI-21549712506971072: independent ptool processes receive the same proxy
// Retry-After hint and otherwise share the same fixed retry cadence. Without a
// positive per-process offset they re-enter the handshake bulkhead in lockstep,
// turning a bounded shed into another synchronized retry wave. Keep the jitter
// additive so Retry-After remains a minimum, and small enough that the outer
// 120s recovery budget remains authoritative.
export const PTOOL_RETRY_JITTER_MS = 1_000;

// `tools/list` is the first request after the MCP session initialize. It is still
// a write-free handshake and can receive the proxy's class-specific 429 after
// `connect()` has succeeded, so give discovery the same bounded recovery budget
// as the initial connection rather than surfacing a false "operator unreachable"
// error to every named ptool call.
export const PTOOL_LIST_TOOLS_RETRY_DELAY_MS = PTOOL_CONNECT_RETRY_DELAY_MS;
export const PTOOL_LIST_TOOLS_MAX_ATTEMPTS = PTOOL_CONNECT_MAX_ATTEMPTS;
export const PTOOL_LIST_TOOLS_TOTAL_TIMEOUT_MS = PTOOL_CONNECT_TIMEOUT_MS;

// A named tools/call can otherwise inherit the MCP SDK's 60s timeout, and a
// saturated default operator route can produce no output at all while that
// request is outstanding. Keep the CLI liveness bound below the observed
// stand-down failure window; callers can still opt out for a deliberately
// long-running call by passing timeoutMs: 0 to the exported helper.
export const PTOOL_CALL_TOOL_TIMEOUT_MS = 30_000;

// `fleet:launch-on-plan` opens terminals/processes in waves and then waits for
// bounded first-turn verification. A five-member visible wave has measured
// multi-minute completion time under fleet load; keep ptool from abandoning the
// call at its ordinary 30s ceiling while the server is still doing real work.
export const PTOOL_FLEET_LAUNCH_ON_PLAN_TIMEOUT_MS = 300_000;

// EI-21388931083718076: `fleet:respawn-member` is a bounded drain + relaunch +
// verify orchestration that declares `timeoutSec: 660` server-side
// (RESPAWN_TIMEOUT_SEC, packages/operator-core/lib/agent-tools/fleet_registry/
// respawn-member.ts — EI-21266158571232094 deliberately aligned the dispatch
// stack AND the MCP transport deadline to that same 660s budget, +5s transport
// buffer = 665s effective). The CLIENT was never aligned: the flat 30s deadline
// aborted five concurrent respawns as MCP -32001 outcome-unknown while every one
// of them completed ok server-side at ~29–33s (tool_invocations, 2026-08-25).
// A client deadline tighter than the server's just aborts calls the server would
// have completed (see PTOOL_TEMPLATES_NEW_APP_TIMEOUT_MS above and
// /internal/docs/agent-insights/ptool-client-timeout-must-outlive-tool-server-clamp);
// keep it above the 665s effective MCP deadline so the tool's own typed
// success / verified-failure / timeout is always the first outcome observed.
export const PTOOL_RESPAWN_MEMBER_TIMEOUT_MS = 675_000;

// EI-21569203429658749: `fleet:require-checkpoint` may intentionally block for
// MAX_WAIT_SEC=300 while re-probing the checkpoint ledger, and its tool
// definition therefore declares timeoutSec=330. The MCP transport adds a 5s
// backstop buffer, so ptool's ordinary 30s client deadline abandoned the
// write-side call first and surfaced MCP -32001 with an unknown outcome.
// Keep the client beyond the effective 335s transport deadline so the tool's
// structured safe/unsafe verdict always wins the race.
export const PTOOL_REQUIRE_CHECKPOINT_TIMEOUT_MS = 345_000;

// EI-22063784282522464: `dev:restart` declares a 330s server-side dispatch
// budget (`MAX_DRAIN_SEC + 30`) because its coordinated drain can wait up to
// 300s before returning a typed result. The ordinary 30s ptool client cutoff
// otherwise reports MCP -32001/outcome-unknown while the restart is still
// draining, including when reached through `tools:invoke`. Keep the client
// beyond the server budget plus the MCP transport settlement buffer so the
// restart's structured refusal/success is observed before the client gives up.
export const PTOOL_DEV_RESTART_TIMEOUT_MS = 345_000;

// `git-sync:run` is an acknowledged long-running call: its server handler
// bounds the sync fire at 45s and may spend up to 5s each reading HEAD before
// and after that fire. Keep the normal ptool liveness ceiling for ordinary
// calls, but give this mutation enough time to return its durable `in_progress`
// continuation instead of cutting the MCP request off at 30s.
// WI-10003638: 60s was exactly that budget (45s + 5s + 5s + 5s MCP settlement),
// so any main-thread lag on the background-worker host made the client give up
// first with MCP -32001 outcome=unknown (P-505 run 13 lost Phase B that way).
// Keep a full server budget of headroom so a late reply is still observed.
export const PTOOL_GIT_SYNC_RUN_TIMEOUT_MS = 120_000;

// `backup:snapshot_create` has the same continuation contract: its handler
// races the heavyweight kopia snapshot against 45s, then returns the durable
// `snapshotId` while the snapshot continues. The ordinary 30s ptool ceiling
// otherwise wins first and turns a successful, observable mutation into an
// ambiguous transport timeout (EI-20477679208771292).
export const PTOOL_BACKUP_SNAPSHOT_CREATE_TIMEOUT_MS = 60_000;

// `backup:restore` returns a structured continuation after racing the
// potentially long Kopia clone against its 45s handler deadline. Keep the
// ptool client outside the MCP transport floor so callers receive that
// continuation instead of an ambiguous 30s transport timeout.
export const PTOOL_BACKUP_RESTORE_TIMEOUT_MS = 60_000;

// `templates:new-app` composes a full pot:create before overlaying the
// template. Under real operator pressure the inner create alone has taken
// 111s. A 30s client deadline is unsafe here: the old reconnect path replayed
// the same still-running write before its result receipt existed.
// EI-21107910194803524: raised 300s -> 900s. The 111s figure above was a baseline,
// not a worst case: a real materialization on 2026-08-21 spent ~290s in pot:create
// alone under fleet load (~55 load average), leaving no room for the template
// overlay inside a 300s client deadline. The server-side budgets were raised to
// 900s to match; a client deadline TIGHTER than the server's just aborts calls the
// server would have completed, which is the failure this constant exists to prevent.
export const PTOOL_TEMPLATES_NEW_APP_TIMEOUT_MS = 900_000;

// `scorecards:emit` is intentionally long-running. Its deterministic
// criterion-check leg owns a 13-minute check budget inside a 15-minute tool
// timeout, then still has to persist the card and serialize the response. The
// previous 195s client budget was left behind when that server budget grew and
// returned MCP -32001 with the write outcome unknown while the card was still
// being evaluated (EI-21402752040470797). The MCP transport adds a 5s buffer to
// the declared timeout; keep the client above that effective 905s deadline so
// the typed success/refusal is the first outcome observed.
export const PTOOL_SCORECARD_EMIT_TIMEOUT_MS = 915_000;

// scorecards:repair can dispatch independent auditors for up to fifty pending
// cards. Its handler declares a 900s budget, and MCP adds 5s for settlement.
// A 30s client cutoff previously reported an unknown outcome even after the
// dispatcher wrote a reservation (EI-24230006371870177).
export const PTOOL_SCORECARD_REPAIR_TIMEOUT_MS = 915_000;

// EI-21106949380687332: a FOREGROUND-capable tool (testing:run, build:typecheck,
// capability:bash, capability:inspect, code:run) self-clamps its OWN command timeout to
// FOREGROUND_TIMEOUT_CEILING_MS (50s — packages/operator-core/lib/agent-tools/capability/
// foreground-transport-cap.ts) precisely so it can return an actionable "re-run detached"
// hint (with the run's own id) BEFORE the MCP transport's ~55s hard cap (MCP_TRANSPORT_CAP_MS)
// kills the call outright. That design was defeated here: a caller's `timeoutMs` ARGUMENT only
// bounds the SERVER-side handler — it has no effect on THIS CLIENT's own request deadline,
// which fell through to the flat PTOOL_CALL_TOOL_TIMEOUT_MS (30s) regardless of what was asked
// for. So `testing:run { timeoutMs: 240000 }` on a genuinely slow file was abandoned by ptool at
// 30s — before the tool's own 50s self-timeout, let alone the transport's 55s hard cap, could
// ever return — surfacing as an opaque MCP -32001 with no runId delivered, even though the
// handler was executing exactly as designed and its response already carries one. Give every
// tool that applies this clamp (see foreground-transport-cap.test.ts's own enumeration) a client
// deadline that outlives the transport's hard cap with margin, so ptool always sees whichever
// server-side outcome fires first — the tool's actionable hint, or (rarer) the transport's own
// cutoff — instead of pre-empting both.
export const PTOOL_FOREGROUND_TOOL_TIMEOUT_MS = 60_000;

// EI-22646214305093468: release:checkpoint-run launches the green-checkpoint
// suite detached, but its pre-launch admission path still runs inside the MCP
// call. The tool declares no timeoutSec, so MCP uses its 55s deadline floor;
// ptool's ordinary 30s deadline could abandon the launch receipt first and
// leave the caller unable to tell whether the gate run was scheduled. Keep the
// client just beyond that server floor, matching the other bounded foreground
// calls without pretending to wait for the detached suite itself.
export const PTOOL_CHECKPOINT_RUN_TIMEOUT_MS = PTOOL_FOREGROUND_TOOL_TIMEOUT_MS;

// EI-22613070628418671: db:migrate declares timeoutSec=1020
// (MAX_DRAIN_SEC 300 + 2*MAX_LOCK_TIMEOUT_SQL_SEC 600 + 120). The MCP
// transport adds a 5s settlement buffer, so the effective server deadline is
// 1,025s. The old foreground 60s client deadline could report MCP -32001
// while the migration was still legitimately draining behind a holder. Keep
// this migration-specific client budget above that effective deadline with a
// 5s delivery margin, preserving the server's typed result for both direct
// and tools:invoke-wrapped calls.
export const PTOOL_DB_MIGRATE_TIMEOUT_MS = 1_030_000;

// EI-22361433147291495: work_items:complete declares a 120s server budget after
// a legitimate proxy continuation took 61.8s. The MCP transport adds its 5s
// handler buffer, so keep this client deadline above the effective 125s boundary
// and let a committed completion return its typed receipt instead of becoming
// outcome-unknown at the client.
export const PTOOL_WORK_ITEMS_COMPLETE_TIMEOUT_MS = 130_000;

// `work_items:create` performs deduplication, goal/fleet admission, the
// create+claim transaction, links, and lifecycle emission before returning.
// With no explicit tool timeout it uses the route-stack's 30s handler budget,
// while MCP's flat deadline is ~55s. Keep the client outside that transport
// window so a server-side result wins the race instead of a post-connect
// ECONNRESET/outcome-unknown at the old 30s client cutoff
// (EI-21832411975767034).
export const PTOOL_WORK_ITEMS_CREATE_TIMEOUT_MS = PTOOL_FOREGROUND_TOOL_TIMEOUT_MS;

// `fleet:wind-down` performs the durable control-state write, scheduler drain
// stamp, pause-hold reconciliation, and best-effort member cue before returning.
// It inherits the dispatch stack's 60s default (the tool has no explicit
// timeoutSec), so the ordinary 30s ptool deadline can report an ambiguous
// outcome while the mutation is still settling (EI-21831468700319864).
export const PTOOL_FLEET_WIND_DOWN_TIMEOUT_MS = PTOOL_FOREGROUND_TOOL_TIMEOUT_MS;

// EI-22780156976598155 (building on WI-2944 / EI-21637077415806005):
// capability:launch-agent declares a 90s handler budget because a fresh
// headless launch may spend time in boot checks, kickoff-proof polling, and
// fresh-launch verification. The MCP transport adds a 5s settlement buffer,
// so keep ptool beyond that 95s response window; otherwise it can report an
// unknown outcome while the server is still persisting the launch receipt.
export const PTOOL_AGENT_LAUNCH_TIMEOUT_MS = 100_000;

// EI-21305071238818431: coord:orient declares a 120s server-side dispatch budget.
// Its handler-local 50s aggregate fence does not cover time spent before/after the
// composition body (dispatch contention and result shaping/serialization); the
// invocation ledger contains successful calls lasting 68s. A 60s ptool deadline
// therefore abandons a server call that is still within its documented budget and
// later completes successfully. Keep the client outside the full server budget,
// with response-delivery margin, so the tool's typed result wins the race.
export const PTOOL_COORD_ORIENT_TIMEOUT_MS = 130_000;

// EI-23098800759403082: request-compaction supports a legacy pre-ACK host by
// waiting through its doubled busy-gate window. Its handler declares 600s and
// MCP adds a 5s settlement buffer. Keep ptool outside that whole contract for
// direct and tools:invoke calls so the queued receipt remains observable.
export const PTOOL_SESSION_REQUEST_COMPACTION_TIMEOUT_MS = 610_000;

// `events:await` performs a write-side registration after several bounded,
// best-effort state/catalog probes. Under a busy operator those probes can
// legitimately outlive ptool's ordinary 30s deadline; abandoning the call
// then leaves an ambiguous waiter registration that callers may blindly
// retry. Keep the client outside the MCP transport cap so the server's
// structured registration result (or timeout) is observed first.
export const PTOOL_EVENTS_AWAIT_TIMEOUT_MS = PTOOL_FOREGROUND_TOOL_TIMEOUT_MS;

// `plans:get` is the durable plan-read path used during agent wake/bootstrap. A large
// nested plan response can spend ~28.5s through the MCP proxy even when the direct
// operator read is healthy; the ordinary 30s ptool deadline turns that slow-but-valid
// wrapped read into an ambiguous tools:invoke timeout. Keep the client deadline above
// the observed proxy path without changing the ordinary deadline for unrelated tools.
export const PTOOL_PLANS_GET_TIMEOUT_MS = PTOOL_FOREGROUND_TOOL_TIMEOUT_MS;

// EI-22774777434821469: plans:audit resolves every submitted citation and
// then persists one completion/activation audit. A valid multi-item audit
// can outlive ptool's ordinary 30s client deadline while the MCP transport
// is still within its ~55s server-side deadline, turning a committed write
// into an ambiguous outcome-unknown response. Keep direct and
// tools:invoke-wrapped audits beyond the transport cap so the typed result
// (or the server's bounded timeout) wins the race.
export const PTOOL_PLANS_AUDIT_TIMEOUT_MS = PTOOL_FOREGROUND_TOOL_TIMEOUT_MS;

// `plans:new` writes the plan under a slug lock and opts into idempotent
// completion because the write may finish after the MCP transport's ~55s
// boundary. The ordinary 30s ptool deadline can abandon that committed write
// before its truthful success/slug_exists response arrives, leaving callers
// with an outcome-unknown result and encouraging an unnecessary replay.
export const PTOOL_PLANS_NEW_TIMEOUT_MS = PTOOL_FOREGROUND_TOOL_TIMEOUT_MS;

// `work_items:get` performs several independent checkpoint, holder, plan-lane,
// prior-work, and lifecycle reads. Under a busy fleet that compound read can
// outlive the ordinary 30s ptool deadline, especially through tools:invoke;
// keep its client budget aligned with the other durable coordination reads
// (EI-21281814895308307).
export const PTOOL_WORK_ITEMS_GET_TIMEOUT_MS = PTOOL_FOREGROUND_TOOL_TIMEOUT_MS;

// EI-23211866726609651: scorecards:get can return an oversized-card index and
// perform a compound evidence read. Its direct and tools:invoke-wrapped paths
// must outlive ptool's ordinary 30s client cutoff so a valid read is not
// surfaced as an ambiguous timeout while the server is still settling.
export const PTOOL_SCORECARDS_GET_TIMEOUT_MS = PTOOL_FOREGROUND_TOOL_TIMEOUT_MS;

// `locks:heartbeat_resource` may heartbeat multiple lock ids sequentially and
// probe the caller plus special coordination domains for each id. Under a
// serialized package build, each transaction can consume the configured
// contention window; the ordinary 30s ptool deadline can therefore abandon a
// still-running heartbeat batch before its per-lock results are returned.
export const PTOOL_HEARTBEAT_RESOURCE_TIMEOUT_MS = 60_000;

const PTOOL_LONG_RUNNING_TIMEOUTS_MS = new Map([
  ['fleet:launch-on-plan', PTOOL_FLEET_LAUNCH_ON_PLAN_TIMEOUT_MS],
  ['fleet:respawn-member', PTOOL_RESPAWN_MEMBER_TIMEOUT_MS],
  ['fleet:require-checkpoint', PTOOL_REQUIRE_CHECKPOINT_TIMEOUT_MS],
  ['dev:restart', PTOOL_DEV_RESTART_TIMEOUT_MS],
  // EI-22701666730811258: dev:pg_query bounds SQL execution, but the request
  // can still spend time in proxy admission/queueing before that bound starts.
  // Keep the ptool client outside the MCP transport floor on both direct and
  // tools:invoke-wrapped calls so the server's typed result wins over the
  // ordinary 30s client cutoff.
  ['dev:pg_query', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-23079930157206205: dev:service_health fans out across fixed service
  // endpoints and systemd state. Its valid read can outlive ptool's ordinary
  // 30s client cutoff, so keep direct and tools:invoke-wrapped calls outside
  // the MCP transport floor instead of reporting an outcome-unknown timeout.
  ['dev:service_health', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  ['scorecards:get', PTOOL_SCORECARDS_GET_TIMEOUT_MS],
  // EI-22707343179859326: pipeline-position aggregates commit, gate, deploy, and
  // activation reads; keep its direct and deferred calls beyond the flat 30s
  // client deadline so the structured position result remains observable.
  ['dev:pipeline_position', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-22810897251728336: blueprint:publish legitimately composes three
  // independently bounded network stages (GitHub repo metadata, best-effort
  // publisher attestation, and the complete Cupboard POST/body read). Their
  // combined budget can exceed ptool's flat 30s client cutoff while remaining
  // inside the MCP transport floor. Preserve the tool's structured success or
  // bounded 504 on both direct and tools:invoke routes instead of surfacing an
  // outcome-unknown -32001 first.
  ['blueprint:publish', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  ['git-sync:run', PTOOL_GIT_SYNC_RUN_TIMEOUT_MS],
  ['backup:snapshot_create', PTOOL_BACKUP_SNAPSHOT_CREATE_TIMEOUT_MS],
  ['backup:restore', PTOOL_BACKUP_RESTORE_TIMEOUT_MS],
  ['templates:new-app', PTOOL_TEMPLATES_NEW_APP_TIMEOUT_MS],
  ['scorecards:emit', PTOOL_SCORECARD_EMIT_TIMEOUT_MS],
  ['scorecards:repair', PTOOL_SCORECARD_REPAIR_TIMEOUT_MS],
  ['release:checkpoint-run', PTOOL_CHECKPOINT_RUN_TIMEOUT_MS],
  ['testing:run', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  ['build:typecheck', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  ['capability:bash', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  ['capability:inspect', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-22780156976598155 (building on EI-21314560074357302): capability:launch-agent
  // resolves the target/profile and may run headless boot, kickoff-proof, and
  // fresh-launch verification before returning. Keep the client outside the
  // tool's 90s handler + 5s MCP settlement window so it observes the typed
  // result instead of returning an ambiguous may-have-executed timeout.
  ['capability:launch-agent', PTOOL_AGENT_LAUNCH_TIMEOUT_MS],
  ['code:run', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // `recipes:run` executes the same foreground orchestration worker as
  // `code:run`, including its 45s server-side ceiling. Keep the client beyond
  // the MCP transport cap so a saved recipe receives its typed timeout/result
  // instead of being cut off by ptool's flat 30s default (EI-22529463182997544).
  ['recipes:run', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // Provisioning starts Xvfb, waits for the display, and may launch a window
  // manager plus apps. The ordinary 30s client deadline can return an
  // ambiguous timeout while the lease is still being created; keep the
  // caller outside the transport cap so it receives the structured result.
  ['computer:provision_desktop', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-22778035061732249: events:emit waits through the durable fire latch,
  // await claiming, announcement stamping, and delivery insertion before it
  // returns. The ordinary 30s ptool cutoff could report an unknown outcome
  // after the server had already fired the event; keep both direct and
  // tools:invoke calls outside the MCP transport floor.
  ['events:emit', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  ['events:await', PTOOL_EVENTS_AWAIT_TIMEOUT_MS],
  ['plans:get', PTOOL_PLANS_GET_TIMEOUT_MS],
  ['plans:new', PTOOL_PLANS_NEW_TIMEOUT_MS],
  // EI-23098800759403082: preserve the legacy-host compatibility path's typed
  // queued receipt beyond the tool's 600s budget + MCP settlement buffer.
  ['session:request-compaction', PTOOL_SESSION_REQUEST_COMPACTION_TIMEOUT_MS],
  // EI-21567372634210816: plans:start runs the plan-start consult, approval,
  // idempotent item promotion, exact-plan admission, and claim-spec binding.
  // Its projected dispatcher defaults to 60s when no timeoutSec is declared;
  // keep ptool from cutting the request off at its ordinary 30s deadline and
  // turning a completed-or-in-flight mutation into outcome_unknown.
  ['plans:start', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-21360596114670049: the idempotent plan lifecycle writer evaluates the
  // full completion/audit/spec/rubric gate before taking the plan lock. Under
  // operator pressure that valid pre-write path can outlive the flat 30s
  // client budget. Keep ptool outside the MCP transport cap so callers observe
  // the typed verdict (or idempotent reconciliation) instead of an ambiguous
  // may-have-executed timeout.
  ['plans:set-plan-status', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  ['work_items:get', PTOOL_WORK_ITEMS_GET_TIMEOUT_MS],
  // EI-21391946334020415: activity:recent and events:status are compound
  // coordination reads. Under serializer pressure their valid responses can
  // outlive ptool's ordinary 30s deadline, especially through tools:invoke;
  // preserve the structured read instead of reconnecting after -32001.
  ['activity:recent', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  ['events:status', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-21391902187370268: work_items:complete evaluates completion evidence,
  // claim release, and broadcasts before returning. Under operator pressure
  // the writer can outlive the ordinary 30s client deadline, so preserve its
  // typed receipt instead of reconnecting with an outcome-unknown result.
  ['work_items:complete', PTOOL_WORK_ITEMS_COMPLETE_TIMEOUT_MS],
  // EI-21832411975767034: work_items:create has a 30s route-stack default,
  // but ptool's old 30s client cutoff could win after the mutation started.
  ['work_items:create', PTOOL_WORK_ITEMS_CREATE_TIMEOUT_MS],
  // EI-21831468700319864: fleet:wind-down inherits the 60s dispatch default,
  // but the old 30s ptool client cutoff could win after the control mutation
  // started and leave its outcome unknown.
  ['fleet:wind-down', PTOOL_FLEET_WIND_DOWN_TIMEOUT_MS],
  // EI-22347167277704688: work_items:request_release records a durable release
  // request, comment, and holder notification. With the minimum announced
  // deadlineSec of 30s, the ordinary 30s ptool cutoff can win while those
  // writes are still settling and surface MCP -32001/outcome-unknown. Keep
  // this write-side coordination call outside the MCP transport cap.
  ['work_items:request_release', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-22351729180562005: consult:get_feedback can spend most of the MCP
  // transport window selecting/reviving a responder and durably routing the
  // conversation. A live call completed successfully in 47.954s after ptool's
  // ordinary 30s deadline had already reported its mutation outcome unknown.
  // Keep direct and tools:invoke-wrapped calls outside the transport window so
  // callers receive the typed consult receipt instead of reconciling by hand.
  ['consult:get_feedback', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-21386877660531420: activity:tool-log scans and compacts the activity
  // ledger. In a concurrent projected batch that read can outlive ptool's
  // ordinary 30s deadline even though it is bounded and still progressing.
  // Keep the client outside the transport cap so tools:invoke returns the
  // structured log instead of an ambiguous MCP -32001.
  ['activity:tool-log', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-21394759701293947: sessions:search hydrates session windows and
  // provenance after its lexical/vector fan-out. Several concurrent deferred
  // calls can legitimately outlive the ordinary 30s ptool deadline even when
  // the server-side embed budget degrades cleanly and the search keeps
  // progressing. Keep the client outside the MCP transport cap so the typed
  // search result (or its structured server-side failure) wins over an
  // ambiguous -32001 outcome.
  ['sessions:search', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-21386877660531420: release:deploy status fans out through the release
  // pipeline and has a 20s server-side status bound. The dispatch queue and
  // projection overhead can consume the ordinary 30s client budget when it
  // runs beside other compound reads; preserve its typed status envelope.
  ['release:deploy', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-21385061122156093: these durable writers can each spend the full
  // coordination/serialization window before returning their receipt. A 30s
  // client cutoff abandoned all three calls in one concurrent batch; loop's
  // writer was already covered below, so keep the other two on the same 60s
  // budget and preserve the server's typed result or timeout envelope.
  ['events:cancel', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  ['work_items:checkpoint', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-21269176538636068: these continuity/control-plane calls perform
  // multi-leg coordination reads or writes of their own. Under pool
  // contention they can legitimately outlive the ordinary 30s ptool
  // deadline; cutting the request off first turns a valid typed result into
  // an ambiguous blank/transport failure. Keep the caller outside the MCP
  // transport cap so the server-side result remains observable.
  // EI-21863905839650704: loop:arm declares no timeoutSec (bound only by the
  // flat 55s MCP_DEADLINE_MS floor) and performs a compound admission — loop
  // materialization, an optional work-item claim, inbox-wake arming, a
  // wake-reachability probe, and control-anchor refresh — any of which can
  // stack past ptool's flat 30s client cutoff under fleet load. A reporter's
  // combined "coord:declare-intent and loop:arm" call surfaced the identical
  // ambiguous-outcome failure for this tool. Keep the client outside the MCP
  // transport cap so a committed loop arm returns its typed receipt instead
  // of an outcome-unknown -32001 that invites an unsafe blind re-arm.
  ['loop:arm', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  ['loop:checkpoint', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  ['loop:end', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  ['loop:status', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  ['improvements:capture', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-22598752399389413: coord:wake performs recipient resolution, a bounded
  // roster preflight, and a bounded wake/diagnostic chain. Its tool definition
  // has no explicit timeoutSec, so MCP uses the ~55s transport floor; the old
  // 30s ptool default could report the wake as outcome-unknown while the server
  // was still settling. Keep both direct and tools:invoke calls above that
  // floor so the typed wake result wins instead of inviting a blind replay.
  ['coord:wake', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-21391922294549625: directed coordination sends can perform durable
  // delivery, close-notification, and wake work before returning. Under local
  // operator pressure the valid response can outlive the ordinary 30s client
  // deadline; preserve the typed receipt instead of surfacing a transport
  // timeout that invites an unsafe replay.
  ['coord:send', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-21863905839650704: coord:declare-intent declares no timeoutSec, so it
  // is bound only by the flat 55s MCP_DEADLINE_MS floor (_mcp-handler.ts
  // effectiveMcpDeadlineMs). EI-9484 bounded its own enrichment legs (mailbox
  // drain, presence/fleet re-reads) to 8s each so a slow leg cannot hold the
  // handler past the server deadline, but under fleet/DB-pool pressure those
  // legs plus the base presence upsert can still legitimately outlive ptool's
  // flat 30s client cutoff. A reporter observed exactly that: "MCP -32001
  // timed out after 30s; mutation may have executed and requires state
  // reconciliation before replay" — the client aborted before the server's
  // (already-succeeded) presence write and claim reconciliation could be
  // observed. Keep the client outside the MCP transport cap so the server's
  // typed result wins the race instead of leaving the caller to guess whether
  // its declared intent / claimed lane actually landed.
  ['coord:declare-intent', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-23173103907673402: tools:find can spend more than ptool's ordinary
  // 30s client cutoff in the live catalog/schema search path. Keep direct
  // discovery calls outside the MCP transport floor so the returned schema
  // (or the server's typed bounded failure) remains observable.
  ['tools:find', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // `coord:orient` is the wake-bootstrap compound read. Its individual legs
  // are bounded, but the full reconciliation can legitimately outlive the
  // ordinary 30s ptool liveness deadline when several legs degrade together.
  // Keep the client deadline above the server transport cap so the caller
  // observes the orient result or its structured fallback instead of an
  // ambiguous client-side -32001 timeout.
  ['coord:orient', PTOOL_COORD_ORIENT_TIMEOUT_MS],
  // EI-21562940235111441: scheduler:get_next performs fleet-scope
  // reconciliation before its claim path. The server's shared 30s watchdog
  // can return its structured retryable timeout just after ptool's flat 30s
  // client deadline, turning a claim attempt into an outcome-unknown -32001.
  // Keep the direct and tools:invoke-wrapped call outside the MCP transport
  // cap so the server's typed result wins the race.
  ['scheduler:get_next', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-22774777434821469: completion/activation audits resolve all submitted
  // citations before persisting; preserve the typed result beyond ptool's
  // ordinary 30s client cutoff on both transport routes.
  ['plans:audit', PTOOL_PLANS_AUDIT_TIMEOUT_MS],
  // EI-22722799928417577: by-id claims perform admission, claim, and several
  // claim-time advisory reads. The ordinary 30s client deadline can expire
  // before the idempotent claim's MCP result settles, reporting outcome-unknown
  // even though the server-side write may have landed. Keep both direct and
  // tools:invoke-wrapped claims beyond the transport cap.
  ['work_items:claim', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // `release:trace` composes candidate, gate, deploy, and await reads. Under
  // operator pressure that read-only bundle can outlive the ordinary 30s
  // client budget even though it is still progressing; keep the typed trace
  // result observable instead of surfacing an opaque MCP -32001.
  ['release:trace', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-21310243062797569: fleet:assignments fans out across presence,
  // claims, and liveness reads. During a BYOC live recheck that placement
  // read can outlive the ordinary 30s client deadline even though the
  // operator is still working and will return a valid response. Keep the
  // ptool client outside the long-read budget so it reports the tool's
  // structured result instead of an ambiguous MCP -32001 timeout.
  ['fleet:assignments', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // `coord:presence` is the live roster read and may enrich rows with
  // coordination/liveness/coupling state. Its bounded multi-leg read can
  // exceed the ordinary 30s client budget during a busy fleet; preserve the
  // server's structured roster or typed timeout instead of -32001.
  ['coord:presence', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-22613070628418671: `db:migrate` declares a 1020s server-side timeout;
  // the generic foreground budget is only 60s and can still cut the client off
  // while the server is legitimately draining behind a holder. Keep the client
  // above the effective 1025s MCP deadline so the structured verdict wins.
  ['db:migrate', PTOOL_DB_MIGRATE_TIMEOUT_MS],
  // EI-21574172453638335: locks:acquire permits a bounded blocking wait up to
  // MAX_LOCK_WAIT_SEC (45s) plus its final-busy/cleanup tail. Keep the direct
  // and deferred tools:invoke paths outside the MCP transport cap so a queued
  // acquire returns its typed busy result instead of an outcome-unknown 30s
  // client timeout.
  ['locks:acquire', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  // EI-22593064345817096: locks:release can spend the same transaction
  // contention/retry window as acquire before its durable receipt returns.
  // Keep direct and tools:invoke-wrapped releases outside the flat 30s client
  // cutoff so a completed release is not surfaced as outcome-unknown.
  ['locks:release', PTOOL_FOREGROUND_TOOL_TIMEOUT_MS],
  ['locks:heartbeat_resource', PTOOL_HEARTBEAT_RESOURCE_TIMEOUT_MS],
]);

/**
 * @param {string} toolName
 * @param {(Record<string, unknown> & {name?: string}) | undefined} [callArgs]
 */
export function timeoutForTool(toolName, callArgs) {
  // Deferred callers may route the same logical call through tools:invoke.
  // Honor the inner tool's contract there too; budgeting only the wrapper name
  // would recreate the 30s cutoff on the sanctioned fallback path.
  const effectiveToolName = toolName === 'tools:invoke' && typeof callArgs?.name === 'string'
    ? callArgs.name
    : toolName;
  return PTOOL_LONG_RUNNING_TIMEOUTS_MS.get(effectiveToolName) ?? PTOOL_CALL_TOOL_TIMEOUT_MS;
}

/**
 * P-010 admission control may reject a tools/call before dispatch when the
 * operator event loop is critically saturated. That refusal is explicitly
 * retry-safe: the tool never ran. Normal agent traffic traverses mcp-proxy,
 * which absorbs this signal; ptool can connect directly to :3170 during
 * staging/release recovery, so it must provide the same bounded absorption.
 */
export function isLoopPressureShed(error) {
  const text = String(error?.message ?? error ?? '');
  if (/loop_pressure_critical|event loop critically saturated/i.test(text)) return true;

  // The MCP proxy can also refuse a request before forwarding when its normal
  // admission class or any bounded class FIFO is full/aged out. The SDK
  // preserves the HTTP status as `code` and includes the proxy's typed JSON
  // body in the message. Do not treat every 429 as pre-dispatch: an ordinary
  // tool can surface a provider rate limit after it has already run.
  const seen = new Set();
  let current = error;
  while (current && (typeof current === 'object' || typeof current === 'function')) {
    if (seen.has(current)) break;
    seen.add(current);
    if (
      Number(current.code) === 429 &&
      /\bmcp_proxy_(?:overloaded|handshake_overloaded|(?:handshake|coord_send|critical_continuation|improvements_capture)_queue_(?:full|dwell))\b/i.test(
        String(current?.message ?? current ?? ''),
      )
    ) return true;
    current = current.cause;
  }
  return false;
}

function errorDetail(error) {
  if (error instanceof Error) {
    const message = error.message || error.name || String(error);
    const cause = error.cause;
    if (cause && cause !== error) {
      const code = typeof cause.code === 'string' ? cause.code : '';
      const causeMessage = typeof cause.message === 'string' ? cause.message : '';
      const detail = [code, causeMessage].filter(Boolean).join(': ');
      if (detail && !message.includes(detail)) return `${message} (cause: ${detail})`;
    }
    return message;
  }
  if (typeof error === 'string') return error;
  try {
    const serialized = JSON.stringify(error);
    return serialized === undefined ? String(error) : serialized;
  } catch {
    return String(error);
  }
}

/**
 * The MCP proxy includes a forwarding result in its JSON error body when it
 * refuses an upstream request before forwarding it. Keep this check tolerant
 * of the MCP SDK's Error wrapper (which normally preserves the body only in
 * `message`) and of callers that pass the decoded result directly.
 */
function isNotForwardedFailure(error) {
  const seen = new Set();
  let current = error;
  while (current != null) {
    if (typeof current === 'string') {
      return /"?forwardingResult"?\s*[:=]\s*"?not_forwarded\b/i.test(current);
    }
    if (typeof current !== 'object' && typeof current !== 'function') return false;
    if (seen.has(current)) return false;
    seen.add(current);
    if (current.forwardingResult === 'not_forwarded') return true;
    if (/"?forwardingResult"?\s*[:=]\s*"?not_forwarded\b/i.test(errorDetail(current))) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * A refused TCP connection is a pre-connect failure: no HTTP request reached
 * the operator, so a tools/call cannot have executed. Walk the cause chain
 * because fetch implementations commonly expose ECONNREFUSED only there.
 */
function isPreConnectConnectionRefused(error) {
  const seen = new Set();
  let current = error;
  let sawHttpStatus = false;
  while (current != null) {
    if (typeof current === 'string') return /\bECONNREFUSED\b/i.test(current);
    if (typeof current !== 'object' && typeof current !== 'function') return false;
    if (seen.has(current)) return false;
    seen.add(current);
    const status = Number(current.code);
    if (Number.isInteger(status) && status >= 400 && status <= 599) {
      sawHttpStatus = true;
    }
    if (
      !sawHttpStatus &&
      (String(current.code ?? '').toUpperCase() === 'ECONNREFUSED' ||
        /\bECONNREFUSED\b/i.test(String(current.message ?? '')))
    ) return true;
    current = current.cause;
  }
  return false;
}

/**
 * Read the proxy's typed retry hint from a pre-dispatch refusal. The MCP SDK
 * surfaces the JSON body in the error text rather than preserving response
 * headers, so parse the emitted `retryAfterSec` field and fall back to the
 * caller's bounded cadence when the body is absent or malformed.
 */
function retryAfterMsFromError(error) {
  const match = errorDetail(error).match(/(?:["']retryAfterSec["']|\bretryAfterSec\b)\s*:\s*(-?\d+(?:\.\d+)?)/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : null;
}

/**
 * Add bounded positive jitter AFTER a retry minimum, without overrunning the
 * caller's remaining total deadline. Returns null when even the minimum cannot
 * be honored before that deadline, so the caller surfaces the last typed error
 * instead of retrying early. Pure + injectable for deterministic fanout tests.
 */
export function retryWaitMsWithJitter(
  baseWaitMs,
  remainingMs,
  { rand = Math.random, jitterMs = PTOOL_RETRY_JITTER_MS } = {},
) {
  const base = Number.isFinite(baseWaitMs) ? Math.max(0, Math.floor(baseWaitMs)) : 0;
  const remaining = remainingMs == null
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Math.floor(remainingMs));
  if (remaining <= base) return null;

  const jitterCap = Math.min(
    Math.max(0, Math.floor(jitterMs)),
    remaining - base,
  );
  if (jitterCap <= 0) return base;

  let sample = 0;
  try {
    sample = Number(rand());
  } catch {
    // Retry pacing must never fail because an injected entropy source did.
  }
  const unit = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0;
  const jitter = Math.max(1, Math.ceil(unit * jitterCap));
  return base + jitter;
}

/**
 * Format a tools/call failure without implying that the call did not run.
 * Stream transport failures can arrive after the operator has dispatched the
 * tool, so callers must verify mutation state before replaying the payload.
 * Known pre-dispatch refusals (proxy `not_forwarded`, loop-pressure shedding,
 * and direct ECONNREFUSED) are called out separately because those signals are
 * safe to retry and cannot have executed.
 * Pure — exported for focused diagnostics tests.
 */
export function formatToolCallFailure(toolName, error, { idempotencyKey } = {}) {
  const name = typeof toolName === 'string' && toolName ? toolName : '(unknown tool)';
  const detail = errorDetail(error);
  if (
    isLoopPressureShed(error) ||
    isNotForwardedFailure(error) ||
    isPreConnectConnectionRefused(error)
  ) {
    return `ptool: tools/call ${name} was rejected before dispatch: ${detail}; no tool execution occurred.`;
  }
  const receipt = typeof idempotencyKey === 'string' && idempotencyKey
    ? ` outcome=unknown; idempotencyKey=${idempotencyKey}; after reconciling state, replay this logical call with the ptool transport flag --idempotency-key ${idempotencyKey} (MCP _meta.idempotencyKey), not by adding idempotencyKey to the target tool JSON arguments or creating a new invocation.`
    : '';
  return `ptool: tools/call ${name} failed: ${detail}; the tool call may have executed — verify its state before retrying. Do not blindly retry a mutation.${receipt}`;
}

/**
 * Format a tools/list failure as the PRE-DISPATCH stage it is. A named ptool
 * invocation must discover the catalog before it can resolve the tool schema,
 * read-only hint, or output contract. Until that succeeds, no tools/call has
 * been sent, so retrying is safe and outcome=unknown guidance is incorrect.
 * Pure — exported for focused diagnostics tests.
 */
export function formatToolCatalogFailure(requestedToolName, error) {
  const requested = typeof requestedToolName === 'string' && requestedToolName
    ? ` for requested tool ${requestedToolName}`
    : '';
  return (
    `ptool: tool catalog discovery failed${requested}: ${errorDetail(error)}; ` +
    'failure_stage=tools/list; no named tool was dispatched, so retrying this CLI invocation is safe.'
  );
}

/**
 * A scripted named call already has the only input ptool needs to dispatch:
 * the target name and its JSON arguments. If read-only catalog discovery is
 * unavailable, bypassing it keeps tools/list from becoming a prerequisite for
 * an exact tools/call. Interactive calls cannot use this path because their
 * arguments still need the catalog's input schema.
 */
export function canDispatchWithoutCatalog(toolName, inputKind) {
  return typeof toolName === 'string' && toolName.trim().length > 0 && inputKind != null;
}

/** Explain the catalog-independent fallback on stderr without contaminating
 * scripted JSON output. The target tool still validates its own arguments. */
export function formatToolCatalogBypass(requestedToolName, error) {
  const requested = typeof requestedToolName === 'string' && requestedToolName
    ? ` for requested tool ${requestedToolName}`
    : '';
  return (
    `ptool: tool catalog discovery failed${requested}: ${errorDetail(error)}; ` +
    'failure_stage=tools/list; dispatching the supplied scripted arguments directly without catalog discovery.'
  );
}

export async function callToolWithPressureRetry(
  client,
  params,
  {
    maxAttempts = 30,
    retryDelayMs = 1_000,
    timeoutMs = PTOOL_CALL_TOOL_TIMEOUT_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const requestOptions = timeoutMs > 0
        ? { timeout: timeoutMs, maxTotalTimeout: timeoutMs }
        : undefined;
      const projected = Boolean(
        params?.arguments &&
        typeof params.arguments === 'object' &&
        !Array.isArray(params.arguments) &&
        Object.hasOwn(params.arguments, 'projection'),
      );
      if (projected) {
        // EI-20335329169958057: Client.callTool() performs a SECOND semantic
        // validation using the outputSchema cached from tools/list. A
        // dispatch projection intentionally removes structuredContent (the
        // complete, unprojected payload), so that validator throws
        // "has an output schema but did not return structured content" after
        // the server already returned a valid reduced result. Use the SDK's
        // ordinary request primitive with the protocol CallToolResult schema:
        // wire-shape validation remains, while the incompatible cached
        // full-output-schema check is correctly skipped for this partial view.
        const { CallToolResultSchema } = await importSdkModuleWithInstallAwareness('@modelcontextprotocol/sdk/types.js');
        return await client.request(
          { method: 'tools/call', params },
          CallToolResultSchema,
          requestOptions,
        );
      }
      return await client.callTool(params, undefined, requestOptions);
    } catch (error) {
      lastError = error;
      if (!isLoopPressureShed(error) || attempt === maxAttempts) throw error;
      await sleep(Math.min(
        retryAfterMsFromError(error) ?? retryDelayMs,
        PTOOL_CALL_TOOL_TIMEOUT_MS,
      ));
    }
  }
  throw lastError;
}

/**
 * The MCP SDK uses these error codes for a request whose stream closed or whose
 * client-side deadline expired. Network implementations wrap the same failure
 * in ordinary fetch/socket errors, so keep the code and message checks together
 * rather than treating every rejected tools/call as replayable.
 */
export function isTransportFailure(error) {
  const codes = [error?.code, error?.cause?.code];
  if (codes.some((code) => code === -32000 || code === -32001)) return true;
  const detail = errorDetail(error);
  return /(?:fetch failed|econn(?:reset|refused|aborted)|etimedout|epipe|en[et]unreach|und_err_socket|socket (?:hang up|closed|reset|error)|(?:connection|transport|stream) (?:closed|reset|aborted|failed)|other side closed|network error)/i.test(detail);
}

/**
 * An HTTP response proves that the local endpoint answered. Retrying it as a
 * connection failure is both wasteful and misleading: in particular, the MCP
 * proxy's 503 is the authoritative, typed result after it has already spent
 * its full restart-absorption window. Walk `cause` because connect() adds
 * operator guidance around the SDK's StreamableHTTPError.
 */
export function isExplicitHttpConnectFailure(error) {
  const seen = new Set();
  let current = error;
  while (current && (typeof current === 'object' || typeof current === 'function')) {
    if (seen.has(current)) break;
    seen.add(current);
    const status = Number(current.code);
    if (Number.isInteger(status) && status >= 400 && status <= 599) return true;
    current = current.cause;
  }
  return false;
}

/**
 * A reachable staging listener may run an older control-plane build that
 * cannot read this session's authority. This is a pre-dispatch refusal, so an
 * unpinned ptool call may safely try the next discovered operator candidate.
 * Keep the matcher exact: ordinary authorization failures must remain terminal.
 */
export function isRecoverableAuthorityDenial(result) {
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
  return /authorization_denied[\s\S]*current session authority could not be read[\s\S]*no effect authorized/i.test(text);
}

/**
 * The initial MCP connect only performs the write-free initialize/tools-list
 * handshake. A local resilient MCP proxy can answer that handshake with a 502
 * after an upstream worker accepted the socket but stayed silent; that is a
 * retryable proxy transport failure, not a terminal operator HTTP response.
 * Keep this narrower than `isExplicitHttpConnectFailure`: auth, routing, and
 * the proxy's exhausted refused-upstream 503 must still surface immediately.
 */
export function isRetryableLocalHttpConnectFailure(error) {
  const seen = new Set();
  let current = error;
  while (current && (typeof current === 'object' || typeof current === 'function')) {
    if (seen.has(current)) break;
    seen.add(current);
    const status = Number(current.code);
    const detail = errorDetail(current);
    if (status === 502 && /mcp_proxy_upstream_error/i.test(detail)) return true;
    // The proxy's handshake bulkhead (and its global admission ceiling) refuse
    // before forwarding with a typed 429. The initial MCP connect has not
    // dispatched a tool yet, so retrying this local, proxy-generated refusal is
    // safe and lets the reconnect herd drain instead of surfacing a terminal
    // "could not reach operator" error to ptool callers.
    //
    // The bulkhead sheds a handshake in TWO ways and both are pre-forward: at
    // admission when the queue is already full (`mcp_proxy_handshake_overloaded`)
    // and after a queued handshake ages out of its dwell budget
    // (`mcp_proxy_handshake_queue_dwell`). The dwell shed is the one that fires
    // under a sustained reconnect herd, so omitting it surfaced a terminal
    // "could not reach operator" at exactly the moment retrying was correct.
    // Parity with the proxy's full 429 vocabulary is asserted by the derived
    // guard in ptool.test.ts — add a shed code there, not only here.
    if (
      status === 429 &&
      /\bmcp_proxy_(?:overloaded|handshake_overloaded|handshake_queue_(?:full|dwell))\b/i.test(detail)
    ) return true;
    current = current.cause;
  }
  return false;
}

/** Preserve the proxy's HTTP status and typed JSON body in ptool's stderr. */
export function formatOperatorConnectFailure(operatorUrl, error) {
  const status = Number(error?.code);
  const statusPrefix = Number.isInteger(status) && status >= 400 && status <= 599
    ? `HTTP ${status}: `
    : '';
  return (
    `could not reach the operator at ${operatorUrl} (${statusPrefix}${errorDetail(error)}). ` +
    'Is the desktop/operator running? Override with PAPERCUSP_OPERATOR_URL or --url=.'
  );
}

/**
 * Automatic reconnect replays after a connected tools/call are disabled.
 * A key can replay a completed call, but it is not an in-flight claim: an
 * immediate retry can overlap the original handler before its receipt exists.
 */
export const PTOOL_POST_CONNECT_RETRIES = 0;

async function closeClientQuietly(client) {
  try {
    await client?.close?.();
  } catch {
    // The original stream is already broken; its close failure must not prevent
    // the keyed replay from opening a fresh MCP session.
  }
}

/**
 * Call with a stable idempotency key, but do not automatically replay a
 * post-connect transport failure. The reconnect-shaped API remains for callers,
 * with its production retry ceiling clamped to zero.
 *
 * Returns the active client because the successful replay belongs to the new
 * session. A failed replay client is closed before the error is surfaced.
 * @param {any} client
 * @param {any} params
 * @param {{reconnect?: () => Promise<any>, maxAttempts?: number, timeoutMs?: number, replayProof?: unknown}} [options]
 */
export async function callToolWithReplayRecovery(
  client,
  params,
  {
    reconnect,
    maxAttempts = PTOOL_POST_CONNECT_RETRIES,
    timeoutMs = PTOOL_CALL_TOOL_TIMEOUT_MS,
    replayProof,
  } = {},
) {
  let activeClient = client;
  let retriesUsed = 0;
  const requestedRetries = Number.isFinite(maxAttempts) ? Math.max(0, Math.floor(maxAttempts)) : 0;
  // No automatic replay exists. A caller must explicitly supply a valid,
  // server-owned proof for this exact code:run body, and even then only one
  // replay is allowed.
  const retryBudget = isCodeRunReplayAuthorized(params, replayProof)
    ? Math.min(requestedRetries, 1)
    : 0;
  while (true) {
    try {
      const result = await callToolWithPressureRetry(activeClient, params, { timeoutMs });
      return { client: activeClient, result };
    } catch (error) {
      if (
        !isTransportFailure(error) ||
        retriesUsed >= retryBudget ||
        typeof reconnect !== 'function'
      ) {
        if (activeClient !== client) await closeClientQuietly(activeClient);
        throw error;
      }
      retriesUsed += 1;
      await closeClientQuietly(activeClient);
      activeClient = await reconnect();
    }
  }
}

/**
 * Explicitly replay one exact code:run body after an unknown transport result.
 * This is intentionally separate from normal recovery so catalog annotations
 * and generic per-call retry budgets cannot opt a request into replay.
 * @param {any} client
 * @param {any} params
 * @param {any} replayProof
 * @param {object} [options]
 * @param {() => Promise<any>} [options.reconnect]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxAttempts]
 */
export async function retryCodeRunWithProof(
  client,
  params,
  replayProof,
  {
    reconnect,
    timeoutMs = PTOOL_CALL_TOOL_TIMEOUT_MS,
    maxAttempts = 1,
  } = {},
) {
  if (!isCodeRunReplayAuthorized(params, replayProof)) {
    throw new Error(
      'ptool: refusing code:run replay; a valid server-owned settled-read proof for the exact request body is required',
    );
  }
  return callToolWithReplayRecovery(client, params, {
    reconnect,
    timeoutMs,
    maxAttempts: Math.min(1, Math.max(0, Number.isFinite(maxAttempts) ? Math.floor(maxAttempts) : 0)),
    replayProof,
  });
}

/** Noun-first alias for callers that describe the operation as replay. */
export const replayCodeRunWithProof = retryCodeRunWithProof;

/**
 * Dispatch a named scripted call without first resolving its catalog entry.
 * This is safe after tools/list failed because no target tools/call was sent;
 * the operator remains authoritative for target existence and argument
 * validation. Do not opt the call into post-connect replay: the target may be
 * a mutation, and only the catalog can provide the read-only annotation.
 */
export async function dispatchScriptedToolWithoutCatalog(
  client,
  toolName,
  callArgs,
  {
    idempotencyKey,
    reconnect,
    timeoutMs,
  } = {},
) {
  return callToolWithReplayRecovery(
    client,
    buildCallToolParams(toolName, callArgs, { idempotencyKey }),
    {
      timeoutMs: timeoutMs ?? timeoutForTool(toolName, callArgs),
      reconnect,
    },
  );
}

/**
 * A local operator restart can make the initial MCP handshake race the brief
 * socket-down window. Retrying the connection is safe because no tool has been
 * dispatched yet; never extend this to a tools/call transport failure, whose
 * mutation status is ambiguous.
 * @template T
 * @param {(url: string, scope: object, options?: {timeoutMs: number}) => Promise<T>} connectOnce
 * @param {string} operatorUrl
 * @param {object} scope
 * @param {{maxAttempts?: number, retryDelayMs?: number, attemptTimeoutMs?: number,
 * totalTimeoutMs?: number, sleep?: (ms: number) => Promise<void>, rand?: () => number,
 * retryJitterMs?: number, rediscover?: (() => string | null) | null,
 * onRebase?: ((url: string) => void) | null}} [options]
 */
export async function connectWithLocalRetry(
  connectOnce,
  operatorUrl,
  scope,
  {
    maxAttempts = PTOOL_CONNECT_MAX_ATTEMPTS,
    retryDelayMs = PTOOL_CONNECT_RETRY_DELAY_MS,
    attemptTimeoutMs,
    totalTimeoutMs = PTOOL_CONNECT_TIMEOUT_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    rand = Math.random,
    retryJitterMs = PTOOL_RETRY_JITTER_MS,
    rediscover = null,
    onRebase = null,
  } = {},
) {
  let liveOperatorUrl = operatorUrl;
  const hostname = new URL(liveOperatorUrl).hostname;
  const local = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  const startedAt = Date.now();
  let lastError;
  // EI-21504867146958629: intermediate failures used to be discarded (only
  // lastError survived), so a budget burned down by dozens of fast proxy-shed
  // 429s surfaced as ONE naked "local operator connection attempt timed out
  // after Xms" — indistinguishable from a dead operator even while
  // /api/health answered in ~2ms. Classify every attempt and append the tally
  // to whichever error finally escapes.
  const attemptKinds = [];
  let proxyUpstreamErrorAttempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let timeout;
    try {
      const remainingTotalMs = totalTimeoutMs > 0
        ? Math.max(1, totalTimeoutMs - (Date.now() - startedAt))
        : null;
      const configuredAttemptTimeoutMs =
        attemptTimeoutMs ?? ptoolConnectAttemptTimeoutMs(liveOperatorUrl);
      const effectiveAttemptTimeoutMs = configuredAttemptTimeoutMs > 0
        ? Math.min(configuredAttemptTimeoutMs, remainingTotalMs ?? configuredAttemptTimeoutMs)
        : remainingTotalMs;
      const connection = connectOnce(
        liveOperatorUrl,
        scope,
        local && effectiveAttemptTimeoutMs ? { timeoutMs: effectiveAttemptTimeoutMs } : undefined,
      );
      if (!local || !effectiveAttemptTimeoutMs) return await connection;
      const connected = Promise.withResolvers();
      timeout = setTimeout(
        () => connected.reject(new Error(`local operator connection attempt timed out after ${effectiveAttemptTimeoutMs}ms`)),
        effectiveAttemptTimeoutMs,
      );
      Promise.resolve(connection).then(connected.resolve, connected.reject);
      return await connected.promise;
    } catch (error) {
      lastError = error;
      const failureKind = classifyConnectFailure(error);
      attemptKinds.push(failureKind);
      if (failureKind === 'proxy-upstream-502') proxyUpstreamErrorAttempts += 1;
      const remainingTotalMs = totalTimeoutMs > 0
        ? totalTimeoutMs - (Date.now() - startedAt)
        : null;
      if (
        !local ||
        (isExplicitHttpConnectFailure(error) && !isRetryableLocalHttpConnectFailure(error)) ||
        (failureKind === 'proxy-upstream-502' &&
          proxyUpstreamErrorAttempts >= PTOOL_PROXY_UPSTREAM_ERROR_MAX_ATTEMPTS) ||
        attempt === maxAttempts ||
        (remainingTotalMs !== null && remainingTotalMs <= 0)
      ) {
        break;
      }
      if (rediscover) {
        try {
          const freshBase = rediscover();
          const rebased = freshBase ? rebaseUrl(liveOperatorUrl, freshBase) : null;
          if (rebased) {
            // ptool stores an operator BASE URL; avoid turning the root path
            // from rebaseUrl into a double slash when buildMcpUrl appends /api.
            liveOperatorUrl = rebased.replace(/\/$/, '');
            try {
              onRebase?.(String(freshBase).replace(/\/$/, ''));
            } catch {
              /* a discovery notice must never break connection recovery */
            }
          }
        } catch {
          /* discovery must never break the bounded retry loop */
        }
      }
      // The proxy's typed handshake shed carries a Retry-After hint
      // (`retryAfterSec` in its JSON body — listToolsWithLocalRetry already
      // honors it). Pacing connect retries to the same hint stops this client
      // from re-contending for a bulkhead slot faster than the proxy asks.
      const retryWaitMs = retryWaitMsWithJitter(
        retryAfterMsFromError(error) ?? retryDelayMs,
        remainingTotalMs,
        { rand, jitterMs: retryJitterMs },
      );
      if (retryWaitMs == null) break;
      await sleep(retryWaitMs);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw appendConnectAttemptHistory(lastError, attemptKinds, Date.now() - startedAt);
}

/**
 * Connect to the first reachable operator candidate. Later candidates are
 * used only for pre-dispatch transport failures, so authentication and HTTP
 * failures do not silently route a caller to another operator.
 *
 * @template T
 * @param {(url: string, scope: object, options?: {timeoutMs: number}) => Promise<T>} connectOnce
 * @param {string[]} operatorUrls
 * @param {object} scope
 * @param {Record<string, any> & {primaryAttemptOptions?: object, onFallback?: ((url: string, error: unknown) => void) | null}} [options]
 * @returns {Promise<{client: T, operatorUrl: string}>}
 */
export async function connectWithOperatorCandidates(
  connectOnce,
  operatorUrls,
  scope,
  {
    primaryAttemptOptions = {},
    onFallback = null,
    ...retryOptions
  } = {},
) {
  const candidates = [...new Set(
    (Array.isArray(operatorUrls) ? operatorUrls : [])
      .filter((url) => typeof url === 'string' && url.trim()),
  )];
  if (candidates.length === 0) throw new Error('ptool: no operator URL candidates were resolved');

  let lastError;
  for (let index = 0; index < candidates.length; index += 1) {
    const operatorUrl = candidates[index];
    let liveOperatorUrl = operatorUrl;
    const onRebase = retryOptions.onRebase;
    try {
      const client = await connectWithLocalRetry(connectOnce, operatorUrl, scope, {
        ...retryOptions,
        ...(index < candidates.length - 1 ? primaryAttemptOptions : {}),
        onRebase: (freshBase) => {
          liveOperatorUrl = freshBase;
          try {
            onRebase?.(freshBase);
          } catch {
            /* a discovery notice must never break connection recovery */
          }
        },
      });
      if (index > 0) {
        try {
          onFallback?.(liveOperatorUrl, lastError);
        } catch {
          /* fallback diagnostics must never break a successful connection */
        }
      }
      return { client, operatorUrl: liveOperatorUrl };
    } catch (error) {
      lastError = error;
      const explicitHttpFailure = isExplicitHttpConnectFailure(error)
        && !isRetryableLocalHttpConnectFailure(error);
      const timedOutLocalAttempt = /^local operator connection attempt timed out/.test(errorDetail(error));
      if (index === candidates.length - 1 || explicitHttpFailure || (!isTransportFailure(error) && !timedOutLocalAttempt)) {
        throw error;
      }
    }
  }
  throw lastError;
}

/** First HTTP status (400–599) found walking the error's cause chain. */
function connectHttpStatusOf(error) {
  const seen = new Set();
  let current = error;
  while (current && (typeof current === 'object' || typeof current === 'function')) {
    if (seen.has(current)) break;
    seen.add(current);
    const status = Number(current.code);
    if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
    current = current.cause;
  }
  return null;
}

/**
 * One short token per failed connect attempt, for the attempt-history suffix.
 * Proxy-generated refusals classify BEFORE generic HTTP so a retried 429/502
 * reads as the proxy condition it is, not a bare status. Pure — exported for
 * focused diagnostics tests.
 */
export function classifyConnectFailure(error) {
  if (/^local operator connection attempt timed out/.test(errorDetail(error))) return 'attempt-timeout';
  if (isRetryableLocalHttpConnectFailure(error)) {
    const status = connectHttpStatusOf(error);
    if (status === 429) return 'proxy-shed-429';
    if (status === 502) return 'proxy-upstream-502';
  }
  if (isExplicitHttpConnectFailure(error)) return `http-${connectHttpStatusOf(error) ?? 'unknown'}`;
  if (isTransportFailure(error)) return 'transport';
  return 'other';
}

/**
 * EI-21504867146958629 recurrence guard companion: mutate the escaping error
 * IN PLACE so its original message stays the greppable prefix while the full
 * attempt tally rides along, e.g.
 * `…timed out after 24717ms [54 connect attempts over 96s: 51x proxy-shed-429, 3x transport]`.
 * Pure — exported for focused diagnostics tests.
 */
export function appendConnectAttemptHistory(error, attemptKinds, elapsedMs) {
  if (!error) return error;
  const counts = new Map();
  for (const kind of attemptKinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  const tally = [...counts.entries()].map(([kind, n]) => `${n}x ${kind}`).join(', ');
  error.message =
    `${error.message} [${attemptKinds.length} connect attempt(s) over ${Math.round(elapsedMs / 1000)}s` +
    `${tally ? `: ${tally}` : ''}]`;
  return error;
}

function isLocalOperatorUrl(operatorUrl) {
  const hostname = new URL(operatorUrl).hostname;
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

/**
 * Retry the bounded, pre-dispatch failures that can occur while discovering
 * the tool catalog. Proxy-generated handshake refusals never reached the
 * upstream; an MCP transport timeout/close may have reached it, but tools/list
 * is read-only and safe to replay on the same session. In both cases the total
 * discovery deadline below remains the hard bound.
 */
export async function listToolsWithLocalRetry(
  client,
  params = {},
  {
    timeoutMs = PTOOL_LIST_TOOLS_TIMEOUT_MS,
    maxAttempts = PTOOL_LIST_TOOLS_MAX_ATTEMPTS,
    retryDelayMs = PTOOL_LIST_TOOLS_RETRY_DELAY_MS,
    totalTimeoutMs = PTOOL_LIST_TOOLS_TOTAL_TIMEOUT_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    rand = Math.random,
    retryJitterMs = PTOOL_RETRY_JITTER_MS,
  } = {},
) {
  const enforceDeadline = timeoutMs > 0 && totalTimeoutMs > 0;
  const startedAt = Date.now();
  let lastError;
  let proxyUpstreamErrorAttempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remainingTotalMs = enforceDeadline
      ? totalTimeoutMs - (Date.now() - startedAt)
      : null;
    if (remainingTotalMs !== null && remainingTotalMs <= 0) break;
    const requestTimeoutMs = timeoutMs > 0
      ? Math.min(timeoutMs, remainingTotalMs ?? timeoutMs)
      : 0;
    try {
      return await client.listTools(
        params,
        requestTimeoutMs > 0
          ? { timeout: requestTimeoutMs, maxTotalTimeout: requestTimeoutMs }
          : undefined,
      );
    } catch (error) {
      lastError = error;
      if (classifyConnectFailure(error) === 'proxy-upstream-502') {
        proxyUpstreamErrorAttempts += 1;
      }
      const remainingAfterFailure = enforceDeadline
        ? totalTimeoutMs - (Date.now() - startedAt)
        : null;
      if (
        !(isRetryableLocalHttpConnectFailure(error) || isTransportFailure(error)) ||
        (proxyUpstreamErrorAttempts >= PTOOL_PROXY_UPSTREAM_ERROR_MAX_ATTEMPTS &&
          classifyConnectFailure(error) === 'proxy-upstream-502') ||
        attempt === maxAttempts ||
        (remainingAfterFailure !== null && remainingAfterFailure <= 0)
      ) {
        throw error;
      }
      const serverRetryAfterMs = retryAfterMsFromError(error);
      const retryWaitMs = retryWaitMsWithJitter(
        serverRetryAfterMs ?? retryDelayMs,
        remainingAfterFailure,
        { rand, jitterMs: retryJitterMs },
      );
      if (retryWaitMs == null) break;
      await sleep(retryWaitMs);
    }
  }

  if (lastError) throw lastError;
  throw new Error('tools/list retry budget exhausted before the first request');
}

/** Build ptool's superuser MCP URL. Pure and exported so the identity and
 * payload-tier contracts are regression-tested without opening a transport.
 * Accept either an operator base URL or an already-qualified `/api/mcp`
 * endpoint; explicit endpoint URLs must not receive a second MCP path.
 * @param {string} operatorUrl
 * @param {{workspace?: string, harness?: string, client?: string, contextTier?: string}} [options]
 */
export function buildMcpUrl(operatorUrl, {
  workspace,
  harness,
  client,
  contextTier = 'trimmed',
} = {}) {
  const url = new URL(operatorUrl);
  const pathWithoutTrailingSlash = url.pathname.replace(/\/+$/, '');
  if (pathWithoutTrailingSlash.endsWith('/api/mcp')) {
    url.pathname = pathWithoutTrailingSlash || '/api/mcp';
  } else {
    url.pathname = `${pathWithoutTrailingSlash}/api/mcp`;
  }
  url.searchParams.set('superuser', '1');
  if (workspace) url.searchParams.set('workspace', workspace);
  if (harness) url.searchParams.set('harness', harness);
  if (client) url.searchParams.set('client', client);
  if (contextTier) url.searchParams.set('ctx_tier', contextTier);
  return url;
}

const SDK_IMPORT_RETRY_TOTAL_MS = 150_000;
const SDK_IMPORT_RETRY_INTERVAL_MS = 1_500;

function isModuleNotFoundError(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}

/**
 * EI-21860372620642128 — `npm run install:safe` rewrites shared node_modules
 * IN PLACE while holding a repo-keyed fs mutex (scripts/lib/fs-mutex.mjs), so
 * a ptool invocation launched during that window can hit a transiently
 * missing `@modelcontextprotocol/sdk` deep import and fail outright, even
 * though the identical import succeeds moments later once the install
 * finishes (reproduced 2026-08-30: five ptool calls retried ~78-81 times over
 * ~120s, then failed `Cannot find module`).
 *
 * ptool itself must never be wrapped in install:safe's own reader guard
 * (EI-21267836337650976 / EI-21250765620092599 — that swallowed a completed
 * write into a near-silent no-op), so this coordinates IN-PROCESS instead:
 * on a MODULE_NOT_FOUND for one of these deep SDK imports, confirm — via the
 * mutex's own non-blocking `peekFsMutexSync` diagnostic peek, never a
 * blocking reader marker, which would reintroduce that exact class of hang —
 * that an install:safe write is ACTUALLY in flight for this repo before
 * retrying. A MODULE_NOT_FOUND with no install in flight is a genuine
 * missing dependency and is rethrown immediately, unretried.
 */
export async function importSdkModuleWithInstallAwareness(
  specifier,
  {
    doImport = (spec) => import(spec),
    sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
    loadInstallMutex = () =>
      Promise.all([
        import('../../../scripts/lib/fs-mutex.mjs'),
        import('../../../scripts/npm-install-safe.mjs'),
      ]),
    totalMs = SDK_IMPORT_RETRY_TOTAL_MS,
    intervalMs = SDK_IMPORT_RETRY_INTERVAL_MS,
  } = {},
) {
  const startedAt = Date.now();
  let warned = false;
  for (;;) {
    try {
      return await doImport(specifier);
    } catch (error) {
      if (!isModuleNotFoundError(error)) throw error;

      let peek;
      try {
        const [{ peekFsMutexSync }, { repoLockName }] = await loadInstallMutex();
        peek = peekFsMutexSync(repoLockName());
      } catch {
        // Best-effort diagnostic only — an unloadable helper (or a repo that
        // predates this mutex) must never mask the real missing-module error.
        throw error;
      }
      if (!peek.held) throw error;

      const elapsed = Date.now() - startedAt;
      if (elapsed >= totalMs) throw error;
      if (!warned) {
        warned = true;
        const owner = peek.owner ?? {};
        const ownerDetail = owner.pid ? ` (pid ${owner.pid}${owner.host ? `@${owner.host}` : ''})` : '';
        console.error(
          `ptool: ${specifier} is transiently missing while npm run install:safe rewrites shared ` +
            `node_modules${ownerDetail} — waiting for it to finish instead of failing (EI-21860372620642128).`,
        );
      }
      await sleep(Math.min(intervalMs, Math.max(0, totalMs - elapsed)));
    }
  }
}

/** Connect an MCP client to the operator's superuser endpoint. Returns the
 *  connected client; caller closes it.
 *
 *  `workspace`/`harness`, when given, scope the SESSION via `?workspace=`/
 *  `?harness=` on the MCP URL — the documented way to scope a superuser MCP
 *  session. This is what lets workspace-scoped legacy first-party tools
 *  (harness:*, features:*, …) get a synthesized workspace transaction, so
 *  it works regardless of whether the host also honors a per-call `workspace`
 *  arg (the newer EI-30 path). The flags are ALSO merged into the args object
 *  (mergeConvenienceArgs) for tools that take `workspace` as a genuine filter. */
async function connect(operatorUrl, { workspace, harness, tokenFile, transport: requestedTransport } = {}, { timeoutMs } = {}) {
  const { Client } = await importSdkModuleWithInstallAwareness('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await importSdkModuleWithInstallAwareness('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const tokenPaths = resolveTokenPaths({ tokenFile });
  const token = readToken({ tokenFile });
  if (!token) {
    throw new Error(`no superuser token at ${tokenPaths.join(' or ')} — is the operator installed? (run apps/operator/scripts/install-standalone-mcp.sh)`);
  }
  const url = buildMcpUrl(operatorUrl, {
    workspace: resolveWorkspaceScope({ workspace }),
    harness,
    client: process.env.PAPERCUSP_SID,
    contextTier: resolveContextTier(),
  });
  const mode = requestedTransport || process.env.PAPERCUSP_MCP_TRANSPORT || 'http';
  if (!['http', 'uds', 'auto'].includes(mode)) throw new Error('Invalid MCP transport; expected http, uds or auto');
  if (mode !== 'http') {
    // Package-built plain JS: do not import a TS-only workspace package from
    // the installed Node CLI or copy its wire implementation into this file.
    const { default: native } = await import('../../../packages/omp-plugin/dist/native-client.cjs');
    const connected = await native.connectAgentMcp({
      url: url.href, headers: { Authorization: `Bearer ${token}` }, mode,
      name: 'ptool', timeoutMs, home: process.env.PAPERCUSP_OPERATOR_HOME,
    });
    return connected.client;
  }
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'ptool', version: '0.1.0' }, { capabilities: {} });
  try {
    await client.connect(transport, timeoutMs > 0 ? { timeout: timeoutMs } : undefined);
  } catch (e) {
    throw new Error(formatOperatorConnectFailure(operatorUrl, e), { cause: e });
  }
  return client;
}

/**
 * List every tool, following pagination if the server returns a cursor.
 * @param {{listTools: (params?: {cursor?: string}, options?: {timeout?: number,
 * maxTotalTimeout?: number}) => Promise<{tools?: ToolCatalogEntry[], nextCursor?: string}>}} client
 * @param {{timeoutMs?: number, retryLocalErrors?: boolean, maxAttempts?: number,
 * retryDelayMs?: number, totalTimeoutMs?: number, sleep?: (ms: number) => Promise<void>,
 * rand?: () => number, retryJitterMs?: number}} [options]
 */
export async function listAllTools(
  client,
  {
    timeoutMs = PTOOL_LIST_TOOLS_TIMEOUT_MS,
    retryLocalErrors = false,
    maxAttempts = PTOOL_LIST_TOOLS_MAX_ATTEMPTS,
    retryDelayMs = PTOOL_LIST_TOOLS_RETRY_DELAY_MS,
    totalTimeoutMs = PTOOL_LIST_TOOLS_TOTAL_TIMEOUT_MS,
    sleep,
    // WI-71582: listToolsWithLocalRetry already takes these, and
    // retryWaitMsWithJitter documents itself as "pure + injectable for
    // deterministic fanout tests" — but the seam stopped one level short of the
    // entry point callers and tests actually use, so the jitter could not be
    // pinned from here. Forwarded (not defaulted) so omitting them keeps the
    // real randomized pacing exactly as before.
    rand,
    retryJitterMs,
  } = {},
) {
  const all = [];
  let cursor;
  do {
    const page = retryLocalErrors
      ? await listToolsWithLocalRetry(client, cursor ? { cursor } : {}, {
        timeoutMs,
        maxAttempts,
        retryDelayMs,
        totalTimeoutMs,
        sleep,
        ...(rand === undefined ? {} : { rand }),
        ...(retryJitterMs === undefined ? {} : { retryJitterMs }),
      })
      : await client.listTools(
        cursor ? { cursor } : {},
        timeoutMs > 0 ? { timeout: timeoutMs, maxTotalTimeout: timeoutMs } : undefined,
      );
    if (Array.isArray(page.tools)) all.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

/** Collect arg values for a tool by prompting per its inputSchema. Returns
 *  the assembled args object. */
async function collectArgs(inputSchema) {
  const { input, confirm, select } = await import('@inquirer/prompts');
  const specs = promptSpecsFromSchema(inputSchema);
  if (specs.length === 0) return {};
  const SKIP = Symbol('skip');
  const args = {};
  for (const spec of specs) {
    const label = `${spec.name}${spec.required ? '' : ' (optional)'}`;
    const hint = spec.description ? `  — ${firstLine(spec.description, 70)}` : '';
    const message = `${label}${hint}`;

    if (spec.kind === 'boolean') {
      if (spec.required) {
        args[spec.name] = await confirm({ message, default: spec.default === true });
      } else {
        const choices = [
          { name: '(skip)', value: SKIP },
          { name: 'true', value: true },
          { name: 'false', value: false },
        ];
        const v = await select({ message, choices, default: spec.default === undefined ? SKIP : spec.default });
        if (v !== SKIP) args[spec.name] = v;
      }
      continue;
    }

    if (spec.kind === 'enum') {
      const base = spec.enumValues.map((e) => ({ name: String(e), value: e }));
      const choices = spec.required ? base : [{ name: '(skip)', value: SKIP }, ...base];
      const def = spec.default !== undefined ? spec.default : spec.required ? base[0].value : SKIP;
      const v = await select({ message, choices, default: def });
      if (v !== SKIP) args[spec.name] = v;
      continue;
    }

    // string | number | integer | json — free text, coerced + validated.
    const placeholder =
      spec.kind === 'json'
        ? '(raw JSON, e.g. {"k":"v"} or ["a","b"])'
        : spec.default !== undefined
          ? `default: ${JSON.stringify(spec.default)}`
          : '';
    const answer = await input({
      message: placeholder ? `${message}\n  ${placeholder}` : message,
      validate: (val) => {
        const v = val.trim();
        if (!v) return spec.required ? 'required' : true;
        try {
          coerceArg(spec.kind, v);
          return true;
        } catch (e) {
          return e.message;
        }
      },
    });
    const trimmed = answer.trim();
    if (!trimmed) continue; // optional + blank → omit
    args[spec.name] = coerceArg(spec.kind, trimmed);
  }
  return args;
}

/** The live stdout delivery-failure probe (injectable in printResult for tests).
 *  Node SWALLOWS EPIPE on process.stdout by design: when the consumer of a
 *  captured/piped stdout dies mid-invocation (a wake-harness capture, `| head`),
 *  every later write is silently dropped and the process still exits 0 — which
 *  is exactly the "completed successfully but emitted no JSON or text" shape
 *  filed as EI-21250765620092599. `stream.errored` exposes the swallowed error. */
export function stdoutDeliveryError() {
  if (process.stdout.errored) return process.stdout.errored;
  if (process.stdout.destroyed) return new Error('stdout destroyed before the result was delivered');
  return null;
}

/** Exit status when the call was delivered but the tool ANSWERED ok:false — a
 *  refused write, a missing id, a partially-failed batch. Distinct from 1 (the
 *  call failed or produced nothing usable) so a script can tell "refused" from
 *  "unreachable". Before this, an ok:false answer exited 0, so every
 *  `ptool … || fail` guard silently passed a refused write
 *  (EI-24654733539966460: a physical drill waited its full 900s bound on a
 *  work_items:create the operator had rejected). */
export const PTOOL_TOOL_NOT_OK_EXIT = 5;

/** Why a delivered tool result reports failure, or null when it does not.
 *  A result fails when its top-level `ok` is false or any entry of a
 *  `results` batch has `ok: false`. Only an explicit `false` counts: a body
 *  with no `ok` (a projection that picked other fields, an output envelope,
 *  prose) is not a refusal.
 * @param {string} text
 * @returns {string | null}
 */
export function toolNotOkReason(text) {
  const parsed = tryParseJsonObject(text);
  if (!parsed) return null;
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const failed = results.filter((r) => r && typeof r === 'object' && r.ok === false);
  if (parsed.ok !== false && failed.length === 0) return null;
  const first = failed[0] ?? {};
  const detail = [parsed.reason, parsed.error, parsed.code, first.error, first.reason, first.code]
    .find((v) => typeof v === 'string' && v.trim()) ?? 'no reason given';
  const reason = failed.length > 0 ? `${failed.length} of ${results.length} result(s) ok:false; first: ${detail}` : detail;
  return reason.length > 300 ? `${reason.slice(0, 297)}...` : reason;
}

/** Print the result of a tools/call, or its error. Returns the exit code.
 * WI-39692: the @param types are LOAD-BEARING — ptool.d.mts is generated from
 * this JSDoc, and without them tsc infers the options shape from the defaults
 * alone (dropping `raw` entirely, which strands every typed caller).
 * Async since EI-22212780570913684: a `raw` result that parses as an output
 * envelope is unwrapped (possibly reading a spill file off disk) before it is
 * ever handed to a `.ok`-checking caller — see {@link unwrapOutputEnvelope}.
 * @param {unknown} result
 * @param {{ raw?: boolean, deliveryProbe?: () => (Error | null), env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<number>}
 */
export async function printResult(result, { raw, deliveryProbe = stdoutDeliveryError, env = process.env } = {}) {
  let text = resultToText(result, { raw });
  const rawProjectionWarning = raw ? leadingProjectionWarning(result) : '';
  if (raw) {
    const parsed = tryParseJsonObject(text);
    if (parsed) {
      const unwrapped = await unwrapOutputEnvelope(parsed, { env });
      if (unwrapped !== parsed) text = JSON.stringify(unwrapped);
    }
  }
  if (!text.trim()) {
    console.error('ptool: operator returned an empty MCP result; no content or structuredContent was received');
    return 1;
  }
  const safeText = sanitizeJsonText(text);
  if (result?.isError) {
    console.error('✗ tool returned an error:');
    console.error(raw ? safeText : prettyText(safeText));
    return 1;
  }
  if (raw && isInvalidTruncatedJson(safeText)) {
    console.error(PTOOL_TRUNCATED_RESULT_MESSAGE);
    return 1;
  }
  if (rawProjectionWarning) console.error(rawProjectionWarning);
  console.log(raw ? safeText : prettyText(safeText));
  const delivery = deliveryProbe();
  if (delivery) {
    console.error(
      `ptool: result was produced but stdout delivery FAILED (${delivery.code || delivery.message}) — the consumer of stdout went away, so the caller saw nothing. Treat this invocation as failed and re-run. (EI-21250765620092599)`,
    );
    return 1;
  }
  const notOk = toolNotOkReason(safeText);
  if (notOk !== null) {
    console.error(
      `ptool: the tool answered ok:false (${notOk}). The result above is complete; exiting ${PTOOL_TOOL_NOT_OK_EXIT} so a \`|| fail\` guard sees the refusal. (EI-24654733539966460)`,
    );
    return PTOOL_TOOL_NOT_OK_EXIT;
  }
  return 0;
}

function printCatalog(grouped, filter) {
  const term = (filter || '').toLowerCase();
  for (const [svc, tools] of grouped) {
    const matched = term
      ? tools.filter((t) => t.name.toLowerCase().includes(term))
      : tools;
    if (matched.length === 0) continue;
    console.log(`\n${svc}  (${matched.length})`);
    for (const t of matched) {
      console.log(`  ${t.name}`);
      const d = firstLine(t.description, 76);
      if (d) console.log(`      ${d}`);
    }
  }
}

export const PTOOL_USAGE = `ptool — call any Papercusp defineTool endpoint from the terminal.

  ptool                         interactive: pick service → endpoint → args
  ptool <group:verb>            skip the pickers, prompt for that tool's args
  ptool <group:verb> --json - <<'EOF'  read JSON args from stdin (safe)
  {"copy": "it's fine now"}
  EOF
  ptool <group:verb> --json-file payload.json   read JSON args from a file (safe)
  ptool <group:verb> --json '<args>'   inline, quote-free JSON only
  ptool <group:verb> --projection '<spec>'  bound the result at dispatch time
  ptool code:run --script-file batch.js   read the script from a file
  ptool code:run --script - <<'EOF'      read the script from stdin
  return await tools.dev.build_status({});
  EOF
  ptool --list [filter]         print the catalog (optionally name-filtered)
  ptool <tool> --transport=uds  require direct local MCP (http and auto also accepted)

Prefer --json-file or --json - for any payload that is not a trivial,
quote-free literal — especially loop:checkpoint checks/walls with recheck text.
A shell-quoted --json '<inline>' cannot safely carry an apostrophe (the quote
terminates early). For code:run, prefer --script-file or --script - for source
that contains nested shell commands or quoted strings.

Flags:
  --json <json> / --args <json>   args object for a direct (non-interactive) call;
                                   '-' reads the JSON from stdin instead
  --json-file <path>              read the args JSON from a file (quoting-free)
  --projection <json>             dispatch-level result projection (quote-free JSON)
  --script <source>               direct code:run JavaScript source; '-' reads stdin
  --script-file <path>            direct code:run JavaScript source (quoting-free)
  --workspace <ws>                scope the session (needed for harness:*, features:*, …)
  --all-workspaces                use an unscoped superuser session (workspace=*)
  --harness <slug>                scope the session to a harness
  --idempotency-key <key>         reuse one logical tools/call receipt after reconciling an unknown outcome
  --token-file <path>             bearer token file (default $PAPERCUSP_MCP_TOKEN_FILE, $PAPERCUSP_HOME/superuser-token, or ~/.papercusp/superuser-token)
  PAPERCUSP_CONTEXT_TIER=full     explicit escape hatch for unshaped MCP payloads (default: trimmed)
  --raw                           print the raw result text (no JSON pretty-print)
  --url=<http://host:port>        operator URL (default current PAPERCUSP_HONO_PORT host, then $PAPERCUSP_OPERATOR_URL or :3070)
  -h, --help                      this help

Exit status:
  0  the tool answered and its result is ok (or carries no ok field)
  1  the call failed or produced no usable result (tool error, empty or
     truncated result, stdout lost)
  5  the call was delivered but the tool answered ok:false (a refusal, a
     missing id, a failed batch entry); the complete result is still on stdout
`;

async function pickService(grouped) {
  const { search } = await import('@inquirer/prompts');
  const rows = [...grouped.entries()].map(([svc, tools]) => ({
    name: `${svc}  (${tools.length})`,
    value: svc,
  }));
  return search({
    message: 'Service',
    source: async (term) => {
      const t = (term || '').toLowerCase();
      return t ? rows.filter((r) => r.value.toLowerCase().includes(t)) : rows;
    },
  });
}

async function pickEndpoint(tools) {
  const { search } = await import('@inquirer/prompts');
  const rows = tools.map((t) => ({
    name: t.name + (firstLine(t.description) ? `  —  ${firstLine(t.description)}` : ''),
    value: t.name,
  }));
  return search({
    message: 'Endpoint',
    source: async (term) => {
      const t = (term || '').toLowerCase();
      return t ? rows.filter((r) => r.value.toLowerCase().includes(t)) : rows;
    },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(PTOOL_USAGE);
    return;
  }

  // Read scripted input before opening the MCP session. The payload can carry
  // the harness that should scope that session, including through a nested
  // tools:invoke envelope; connecting first would bind the stale environment
  // harness before the payload is available (EI-21577595300302349).
  const jsonKind = jsonSourceKind(args);
  const scriptKind = scriptSourceKind(args);
  if (jsonKind != null && scriptKind != null) {
    console.error('ptool: choose one input source: --json/--json-file or --script/--script-file');
    process.exit(1);
  }
  const inputKind = scriptKind ?? jsonKind;
  let inputArgs;
  if (scriptKind != null) {
    if (args.tool && args.tool !== 'code:run') {
      console.error('ptool: --script/--script-file can only be used with code:run');
      process.exit(1);
    }
    try {
      if (scriptKind === 'file') inputArgs = { script: readFileSync(args.scriptFile, 'utf8') };
      else if (scriptKind === 'stdin') inputArgs = { script: readFileSync(0, 'utf8') };
      else inputArgs = { script: args.script };
    } catch (e) {
      console.error(`ptool: could not read script from ${scriptKind === 'file' ? `--script-file ${args.scriptFile}` : 'stdin'}: ${e.message}`);
      process.exit(1);
    }
  } else if (jsonKind != null) {
    let jsonText;
    try {
      if (jsonKind === 'file') jsonText = readFileSync(args.jsonFile, 'utf8');
      else if (jsonKind === 'stdin') jsonText = readFileSync(0, 'utf8');
      else jsonText = args.json;
    } catch (e) {
      console.error(`ptool: could not read JSON from ${jsonKind === 'file' ? `--json-file ${args.jsonFile}` : 'stdin'}: ${e.message}`);
      process.exit(1);
    }
    try {
      inputArgs = parseJsonInput(jsonText, { emptyAsObject: jsonKind === 'stdin' });
    } catch (e) {
      console.error(formatJsonInputError(jsonKind, e));
      process.exit(1);
    }
  }

  let operatorUrl = args.url || OPERATOR_URL;
  let operatorCandidates = resolvePtoolInvocationCandidates(args, process.env);
  const workspace = resolveWorkspaceScope({ workspace: args.workspace, allWorkspaces: args.allWorkspaces });
  const harness = resolveHarnessScope({
    harness: args.harness,
    payload: jsonKind != null ? inputArgs : undefined,
    toolName: args.tool,
  });
  const scope = { workspace, harness, tokenFile: args.tokenFile, transport: args.transport };
  const retryOptions = ptoolConnectionRetryOptions(args, process.env);
  const rediscover = !args.tool && Object.keys(retryOptions).length === 0 ? discoverOperatorUrl : null;
  const connectOperator = async ({ preferredIndex = 0 } = {}) => {
    const candidates = preferredIndex > 0
      ? [
        ...operatorCandidates.slice(preferredIndex),
        ...operatorCandidates.slice(0, preferredIndex),
      ]
      : operatorCandidates;
    const connected = await connectWithOperatorCandidates(connect, candidates, scope, {
      ...retryOptions,
      rediscover,
      primaryAttemptOptions: candidates.length > 1 ? { maxAttempts: 1 } : {},
      onRebase: (freshBase) => {
        operatorUrl = freshBase;
        candidates[0] = freshBase;
      },
      onFallback: (fallbackBase) => {
        console.error(
          `ptool: primary operator at ${operatorUrl} was unreachable; using fallback ${fallbackBase}`,
        );
      },
    });
    operatorUrl = connected.operatorUrl;
    // A reconnect should prefer the last known-good route instead of spending
    // another direct attempt on the same stale self-port.
    operatorCandidates = [
      connected.operatorUrl,
      ...operatorCandidates.filter((candidate) => candidate !== connected.operatorUrl),
    ];
    return connected.client;
  };
  let client = await connectOperator();
  try {
    let projection;
    if (args.projection != null) {
      try {
        projection = JSON.parse(args.projection);
      } catch (e) {
        console.error(`ptool: --projection is not valid JSON: ${e.message}`);
        process.exit(1);
      }
    }

    let tools;
    try {
      tools = await listAllTools(client, { retryLocalErrors: isLocalOperatorUrl(operatorUrl) });
    } catch (error) {
      if (canDispatchWithoutCatalog(args.tool, inputKind)) {
        const callArgs = mergeDispatchProjection(inputArgs, projection);
        const idempotencyKey = args.idempotencyKey || randomUUID();
        console.error(formatToolCatalogBypass(args.tool, error));
        try {
          const recovered = await dispatchScriptedToolWithoutCatalog(
            client,
            args.tool,
            callArgs,
            { idempotencyKey, reconnect: connectOperator },
          );
          client = recovered.client;
          const code = await printResult(recovered.result, {
            raw: shouldPrintRawResult(inputKind, args.raw),
          });
          if (code !== 0) process.exitCode = code;
        } catch (callError) {
          console.error(formatToolCallFailure(args.tool, callError, { idempotencyKey }));
          process.exitCode = 1;
        }
        return;
      }
      console.error(formatToolCatalogFailure(args.tool, error));
      process.exitCode = 1;
      return;
    }
    const grouped = groupTools(tools);
    const byName = new Map(tools.map((t) => [t.name, t]));

    if (args.list) {
      printCatalog(grouped, args.listFilter);
      return;
    }

    // Resolve the target tool: named on the CLI, or picked interactively.
    let toolName = args.tool;
    if (!toolName) {
      const svc = await pickService(grouped);
      toolName = await pickEndpoint(grouped.get(svc));
    }
    const tool = byName.get(toolName);
    if (!tool) {
      console.error(`ptool: no tool named "${toolName}". Try \`ptool --list ${serviceOf(toolName)}\`.`);
      process.exit(1);
    }
    if (scriptKind != null && toolName !== 'code:run') {
      console.error('ptool: --script/--script-file can only be used with code:run');
      process.exit(1);
    }

    // Assemble args from the input parsed before connect, or prompt
    // interactively when no scripted source was provided.
    let callArgs = inputKind != null ? inputArgs : await collectArgs(tool.inputSchema);
    callArgs = mergeDispatchProjection(callArgs, projection);
    callArgs = mergeConvenienceArgs(callArgs, { workspace, harness }, tool.inputSchema, { toolName });

    // Interactive confirmation (only when we prompted — a scripted --json/
    // --json-file/stdin call is non-interactive by intent).
    if (inputKind == null && !args.tool) {
      const { confirm } = await import('@inquirer/prompts');
      console.error(`\n→ ${toolName}  ${JSON.stringify(callArgs)}`);
      const go = await confirm({ message: 'Call it?', default: true });
      if (!go) {
        console.error('ptool: cancelled');
        return;
      }
    } else if (shouldPrintInvocationLine(inputKind)) {
      console.error(`→ ${toolName}  ${JSON.stringify(callArgs)}`);
    }

    let result;
    // Keep the receipt outside the try so a transport failure can surface the
    // exact key needed to replay the completed server result.
    const idempotencyKey = args.idempotencyKey || randomUUID();
    try {
      let recovered = await callToolWithReplayRecovery(
        client,
        buildCallToolParams(toolName, callArgs, {
          outputSchema: tool.outputSchema,
          // One key belongs to this logical CLI invocation. Reconnect recovery
          // deliberately reuses these params so the server can deduplicate it.
          idempotencyKey,
        }),
        {
          timeoutMs: timeoutForTool(toolName, callArgs),
          reconnect: () => connectOperator(),
        },
      );
      if (isRecoverableAuthorityDenial(recovered.result) && !args.url && operatorCandidates.length > 1) {
        console.error(
          `ptool: ${operatorUrl} rejected the session authority before dispatch; ` +
            'retrying the same call on the canonical operator candidate.',
        );
        await closeClientQuietly(recovered.client);
        recovered = await callToolWithReplayRecovery(
          await connectOperator({ preferredIndex: 1 }),
          buildCallToolParams(toolName, callArgs, {
            outputSchema: tool.outputSchema,
            idempotencyKey,
          }),
          {
            timeoutMs: timeoutForTool(toolName, callArgs),
            reconnect: () => connectOperator(),
          },
        );
      }
      client = recovered.client;
      result = recovered.result;
    } catch (error) {
      console.error(formatToolCallFailure(toolName, error, { idempotencyKey }));
      process.exitCode = 1;
      return;
    }
    const code = await printResult(result, { raw: shouldPrintRawResult(inputKind, args.raw) });
    if (code !== 0) process.exitCode = code;
  } finally {
    await client.close().catch(() => {});
  }
}

// Symlink-robust CLI-entry check (WI-1443): node realpaths the entry module's
// import.meta.url while argv[1] keeps the invoked path, so through a symlinked
// checkout (papercup -> papercusp, as the on-PATH `ptool` shim does) the naive
// === is false and main() silently never runs (exit 0, zero output).
const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  // EPIPE backstop (EI-21250765620092599): an EPIPE can surface on the tick
  // AFTER printResult's synchronous probe, so re-check at exit and refuse to
  // report success when the result never reached the consumer. stderr is a
  // separate pipe and usually still deliverable when stdout's consumer died.
  process.on('exit', (code) => {
    if (code === 0 && stdoutDeliveryError()) {
      process.stderr.write(
        'ptool: exiting after a swallowed stdout delivery failure (EPIPE) — the result never reached the consumer; treating this invocation as FAILED (EI-21250765620092599)\n',
      );
      process.exitCode = 1;
    }
  });
  main().catch((e) => {
    // @inquirer throws ExitPromptError on Ctrl+C — treat as a clean cancel.
    if (e && (e.name === 'ExitPromptError' || /force closed/i.test(e.message || ''))) {
      console.error('ptool: cancelled');
      process.exit(130);
    }
    const msg = e?.message || (typeof e === 'string' ? e : JSON.stringify(e));
    console.error('ptool: ' + msg);
    process.exit(1);
  });
}
