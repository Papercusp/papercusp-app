#!/usr/bin/env node
/**
 * mcp-call — recover-now access to the operator MCP when the Claude Code
 * papercusp-su client has dropped (EI-1740 / EI-1750; runbook:
 * agent-insights/mcp-client-drop-curl-recovery). The server stays healthy when
 * the client disconnects; this drives it directly via a single-shot stateless
 * `tools/call` over the streamable-HTTP endpoint with the superuser bearer.
 *
 * Standardizes the technique several auto-mode agents were hand-rolling in
 * /tmp (and colliding on the same path) — pass your OWN --client so coord/plan
 * writes attribute correctly.
 *
 * Usage:
 *   node scripts/mcp-call.mjs <tool> [jsonArgs] [--json -|--json-file <path>] [--client <id>|--client=<id>] [--workspace <ws>|--workspace=<ws>] [--all-workspaces] [--harness <h>|--harness=<h>] [--port <n>|--port=<n>] [--idempotency-key <key>|--idempotency-key=<key>] [--raw]
 * Examples:
 *   node scripts/mcp-call.mjs coord:whoami
 *   node scripts/mcp-call.mjs work_items:get '{"id":"EI-1750"}' --harness papercup
 *   printf '%s\n' '{"id":"EI-1750","summary":"it's safe"}' | node scripts/mcp-call.mjs work_items:complete --json - --harness papercup
 *   node scripts/mcp-call.mjs work_items:complete --json-file payload.json --harness papercup
 *   node scripts/mcp-call.mjs plans:search '{"query":"infra","harness":"papercup"}' --client su-1234
 *   node scripts/mcp-call.mjs knowledge_packs:list --json-file payload.json --all-workspaces --client su-1234
 *
 * Prefer `--json -` or `--json-file <path>` for payloads containing apostrophes
 * or other shell-hostile text; the positional JSON form remains for compact,
 * quote-free arguments.
 *
 * Notes: tool names use COLONS (coord:whoami, plans:new, work_items:set_state —
 * arg is `itemId` not `item`). `tools/list` returns empty in this mode, but
 * `tools/call` reaches every tool. Reads the bearer from ~/.papercusp/superuser-token.
 * For an unknown-outcome retry, pass the same `--idempotency-key` value; it is
 * sent as transport metadata (`_meta.idempotencyKey`), not as a tool argument.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The JSON-RPC id we send; parseSse selects the frame that answers it. */
const REQUEST_ID = 1;

/**
 * A managed staging restart can leave the explicitly pinned port refused while
 * systemd is rebuilding the host. Keep this recovery path aligned with the
 * always-up MCP proxy's measured restart budget, but only use it for an
 * explicit `--port` pin. An unpinned call must retain its immediate canonical
 * 3070 fallback instead of waiting 90s before discovering that its inherited
 * port hint is stale.
 */
export const MCP_CALL_CONNECTION_RETRY_WINDOW_MS = 90_000;
export const MCP_CALL_CONNECTION_RETRY_DELAY_MS = 1_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** ECONNREFUSED is raised before an HTTP request can reach the operator. */
export function isConnectionRefusedError(error) {
  const seen = new Set();
  let current = error;
  while (current && (typeof current === 'object' || typeof current === 'function') && !seen.has(current)) {
    seen.add(current);
    if (current.code === 'ECONNREFUSED') return true;
    current = current.cause;
  }
  return false;
}

export function buildFallbackWarning({
  configuredPort,
  port,
  proxyPort,
  configuredPortError,
  authorityFallback = false,
}) {
  const endpoint = port === proxyPort
    ? 'the resilient MCP proxy on port ' + port
    : 'the canonical operator on port ' + port;

  if (authorityFallback) {
    const cause = 'PAPERCUSP_HONO_PORT=' + configuredPort +
      ' answered with a stale session-authority denial; reached ';
    const repair = port === proxyPort
      ? 'unset PAPERCUSP_HONO_PORT or set it to the actual operator port'
      : 'export PAPERCUSP_HONO_PORT=' + port + ' (or unset it)';
    return 'mcp-call: WARNING — ' + cause + endpoint + ' instead. ' +
      "Your environment's port is STALE: " + repair +
      ', or every other tool deriving its URL from that variable will keep failing.';
  }

  if (isConnectionRefusedError(configuredPortError)) {
    if (String(configuredPort) === '3070') {
      return 'mcp-call: WARNING — connection to canonical PAPERCUSP_HONO_PORT=3070 ' +
        'was refused at request time; reached ' + endpoint + ' instead. ' +
        'The environment setting is canonical; verify operator health before changing it.';
    }
    return 'mcp-call: WARNING — no listener accepted a connection on PAPERCUSP_HONO_PORT=' +
      configuredPort + ' at request time; reached ' + endpoint + ' instead. ' +
      'The configured port may be stale or restarting; unset PAPERCUSP_HONO_PORT or set it ' +
      'to the actual operator port only if it has been retired.';
  }

  return 'mcp-call: WARNING — the MCP request through PAPERCUSP_HONO_PORT=' +
    configuredPort + ' did not complete; reached ' + endpoint + ' instead. ' +
    'This does not establish that the port is stale; verify the transport before changing it.';
}

/**
 * Retry only a pre-connect refusal. Retrying resets, HTTP errors, or any other
 * fetch failure could duplicate a POST whose request reached the operator.
 * The injected seams keep the restart-window behavior directly testable.
 */
export async function fetchWithConnectionRecovery(
  url,
  init,
  {
    fetchImpl = fetch,
    retryWindowMs = MCP_CALL_CONNECTION_RETRY_WINDOW_MS,
    retryDelayMs = MCP_CALL_CONNECTION_RETRY_DELAY_MS,
    sleepImpl = sleep,
    now = Date.now,
    onRetry,
  } = {},
) {
  const budgetMs = Number.isFinite(retryWindowMs) ? Math.max(0, retryWindowMs) : 0;
  const delayMs = Number.isFinite(retryDelayMs) ? Math.max(1, retryDelayMs) : MCP_CALL_CONNECTION_RETRY_DELAY_MS;
  const deadline = now() + budgetMs;
  let attempt = 0;

  while (true) {
    try {
      return await fetchImpl(url, init);
    } catch (error) {
      if (!isConnectionRefusedError(error)) throw error;
      const remainingMs = deadline - now();
      if (remainingMs <= 0) throw error;
      const waitMs = Math.min(delayMs, remainingMs);
      attempt += 1;
      onRetry?.({ attempt, delayMs: waitMs, remainingMs });
      await sleepImpl(waitMs);
    }
  }
}

/**
 * Flags are declared ONCE here, in the camelCase spelling the readers use.
 *
 * The command line spells the only multi-word flag kebab-cased (`--json-file`)
 * while every reader asks for `flags.jsonFile`, so a parser that stored the
 * raw CLI key left that flag permanently undefined — `--json-file` selected no
 * JSON source and the call went out with EMPTY args, surfacing as a schema
 * error about the CALLER's payload rather than a flag error (WI-41249).
 * Normalizing here fixes the whole class rather than that one flag, and the
 * allowlist means a mistyped or renamed flag fails loudly instead of
 * degrading into a silently-empty payload — the same contract the operator
 * tools enforce on undeclared args (EI-10883).
 *
 * `--all-workspaces` is a boolean transport flag, not a tool argument. It
 * explicitly selects the unscoped superuser session (`workspace=*`), which is
 * required for cross-workspace tools when the scoped-superuser clamp is ON.
 */
export const BOOLEAN_FLAGS = new Set(['raw', 'allWorkspaces', 'help']);
export const VALUE_FLAGS = new Set(['json', 'jsonFile', 'client', 'workspace', 'harness', 'port', 'idempotencyKey']);

/** `json-file` -> `jsonFile`. Leaves an already-camelCase key untouched. */
export function toCamelCaseFlag(key) {
  return key.replace(/-+([a-z0-9])/gi, (_match, char) => char.toUpperCase());
}

export function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') {
      flags.help = true;
    } else if (a.startsWith('--')) {
      const rawKey = a.slice(2);
      const equalsAt = rawKey.indexOf('=');
      const cliKey = equalsAt === -1 ? rawKey : rawKey.slice(0, equalsAt);
      const key = toCamelCaseFlag(cliKey);
      if (BOOLEAN_FLAGS.has(key)) {
        if (equalsAt !== -1) throw new Error(`--${cliKey} does not take a value`);
        flags[key] = true;
      } else if (VALUE_FLAGS.has(key)) {
        const value = equalsAt === -1 ? argv[++i] : rawKey.slice(equalsAt + 1);
        if (value === undefined) throw new Error(`--${cliKey} requires a value`);
        flags[key] = value;
      } else {
        const accepted = [...BOOLEAN_FLAGS, ...VALUE_FLAGS].sort().join(', ');
        throw new Error(`unknown flag --${cliKey}; accepted flags: ${accepted}`);
      }
    } else pos.push(a);
  }
  return { tool: pos[0], jsonArgs: pos[1], flags };
}

/**
 * Select the JSON input source. `--json-file` takes priority over `--json`,
 * matching the ptool contract; the legacy positional form remains supported.
 * The source selection is pure so every quoting-safe path is testable without
 * spawning a shell or contacting the operator.
 */
export function jsonSourceKind({ jsonArgs, flags = {} } = {}) {
  if (flags.jsonFile) return 'file';
  if (flags.json === '-') return 'stdin';
  if (flags.json !== undefined) return 'inline';
  if (jsonArgs !== undefined) return 'inline';
  return null;
}

/**
 * Read and parse the selected JSON args source. `readFile` is injectable for
 * tests; descriptor 0 is used for the `--json -` stdin sentinel.
 */
export function readJsonArgs(
  { jsonArgs, flags = {} } = {},
  { readFile = readFileSync } = {},
) {
  const kind = jsonSourceKind({ jsonArgs, flags });
  if (kind === null) return {};

  const label = kind === 'file'
    ? `--json-file ${flags.jsonFile}`
    : kind === 'stdin'
      ? 'stdin'
      : 'inline JSON';
  let jsonText;
  try {
    if (kind === 'file') jsonText = readFile(flags.jsonFile, 'utf8');
    else if (kind === 'stdin') jsonText = readFile(0, 'utf8');
    else jsonText = flags.json ?? jsonArgs;
  } catch (error) {
    throw new Error(`could not read ${label}: ${error?.message ?? error}`);
  }

  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error?.message ?? error}`);
  }
}

/**
 * Extract the JSON-RPC result from an SSE stream or a JSON response body.
 *
 * The stream carries frames we did NOT ask for: the server emits
 * `notifications/tools/list_changed` (and friends) BEFORE the response to our
 * `tools/call`. Those are JSON-RPC *notifications* — a `method`, no `id`, no
 * `result`. Returning the first `data:` frame therefore handed callers the
 * notification instead of the tool result, and because the old fallback
 * (`d.result ?? d`) returned the raw frame rather than erroring, it looked like
 * a successful call that answered `{"method":"notifications/tools/list_changed"}`
 * — a well-formed, confidently wrong result on the exact path agents use when
 * the papercusp-su MCP client has dropped. Select the frame that RESPONDS to us
 * (`id` matching the request), never merely the first one.
 */
export function parseSse(raw, requestId = 1) {
  let sawFrame = false;
  // Admission sheds are HTTP 429 JSON-RPC bodies, not SSE frames. Parse both
  // transport shapes so the caller sees the retryable reason from the server.
  const frames = raw.trimStart().startsWith('{')
    ? [raw.trim()]
    : raw.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
  for (const frame of frames) {
    let d;
    try { d = JSON.parse(frame); } catch { continue; }
    sawFrame = true;
    // A notification has no id and never answers our call — skip it.
    if (d.id === undefined || d.id === null) continue;
    if (d.id !== requestId) continue;
    if (d.error) return { error: d.error };
    if (!('result' in d)) continue;
    const result = d.result;
    // MCP tool failures are returned as successful JSON-RPC envelopes with
    // `result.isError: true`. Preserve the complete result so main() routes
    // the tool's text to stderr and exits nonzero instead of presenting a
    // refusal as a successful stdout value.
    if (result?.isError === true) return { error: result };
    // A projected result places trust-degrading warnings in a leading text
    // item and keeps the retained JSON body in a following item. Selecting
    // only content[0] turns a valid partial projection into a warning-only
    // response, silently discarding the data the caller asked for.
    const textItems = Array.isArray(result?.content)
      ? result.content.filter((item) => item?.type === 'text' && typeof item.text === 'string')
      : [];
    for (const item of textItems) {
      try {
        return { result: JSON.parse(item.text) };
      } catch {
        // Advisory text and other human-readable blocks are expected; keep
        // looking for the JSON payload before falling back to plain text.
      }
    }
    if (Object.prototype.hasOwnProperty.call(result ?? {}, 'structuredContent')) {
      return { result: result.structuredContent };
    }
    const firstText = textItems[0]?.text;
    if (firstText !== undefined) {
      return { result: firstText };
    }
    return { result };
  }
  return {
    error: sawFrame
      ? { message: `no JSON-RPC response frame for id ${requestId} in SSE stream`, raw: raw.slice(0, 400) }
      : { message: 'no data: line in SSE response', raw: raw.slice(0, 400) },
  };
}

/** Resolve the local resilient MCP proxy port using the same default as ptool. */
export function resolveMcpProxyPort(env = process.env) {
  const DEFAULT_MCP_PROXY_PORT = '9071';
  const envProxyPort = Number(env.PAPERCUSP_MCP_PROXY_PORT);
  return Number.isInteger(envProxyPort) && envProxyPort > 0 && envProxyPort <= 65535
    ? String(envProxyPort)
    : DEFAULT_MCP_PROXY_PORT;
}

/** Resolve the operator ports to try. An explicit CLI port is a fail-closed pin;
 * the inherited environment hint retains its recovery fallback to canonical and proxy. */
export function resolveCandidatePorts(flags = {}, env = process.env) {
  const CANONICAL_PORT = '3070';
  if (flags.port !== undefined) {
    const pinned = String(flags.port).trim();
    if (!/^\d+$/.test(pinned) || Number(pinned) < 1 || Number(pinned) > 65535) {
      throw new Error(`--port must be an integer from 1 to 65535 (received ${JSON.stringify(flags.port)})`);
    }
    return { configuredPort: pinned, candidatePorts: [pinned], pinned: true };
  }
  const configuredPort = env.PAPERCUSP_HONO_PORT ?? CANONICAL_PORT;
  const proxyPort = resolveMcpProxyPort(env);
  return {
    configuredPort: String(configuredPort),
    // The local MCP proxy stays up while its operator target restarts. Keep it
    // last so an explicit runtime hint and canonical operator retain precedence.
    candidatePorts: [...new Set([String(configuredPort), CANONICAL_PORT, proxyPort])],
    pinned: false,
  };
}

/**
 * A live staging operator can be reachable but still run an older control-plane
 * build whose kernel cannot read this session's authority. That response is
 * recoverable for an unpinned helper call: the canonical :3070 operator is the
 * shared coordination endpoint and may already accept the same session. Keep
 * this matcher narrow so ordinary authorization failures remain visible.
 */
export function isRecoverableAuthorityDenial(raw) {
  return /authorization_denied[\s\S]*current session authority could not be read[\s\S]*no effect authorized/i.test(raw);
}

/**
 * Build the scoped-superuser query for the recovery transport.
 *
 * `mcp-call` promises JSON on stdout (and vmcall.sh validates that contract),
 * while the operator's default result encoding is intentionally compact/TOON.
 * Pin JSON at the transport boundary instead of depending on that mutable
 * default; otherwise a successful tool call becomes non-JSON output that the
 * maintained VM-rig driver correctly rejects.
 * Forward the launched role as an admission hint for bounded judge calls;
 * signed principal verification remains the authorization boundary.
 */
export function buildMcpSessionQuery({ client, workspace, harness, role, allWorkspaces = false }) {
  const qs = new URLSearchParams({
    superuser: '1',
    client,
    workspace: allWorkspaces ? '*' : workspace,
    format: 'json',
  });
  if (harness) qs.set('harness', harness);
  if (role) qs.set('role', role);
  return qs;
}

/**
 * Build the stateless `tools/call` params for the recovery transport.
 *
 * Idempotency belongs to MCP transport metadata. Putting the key in
 * `arguments` would send it to the target tool schema, where it is either
 * ignored or rejected as an unrecognized tool argument instead of enabling
 * result replay after an unknown outcome.
 */
export function buildMcpCallParams(tool, args, { idempotencyKey, outputGroupId } = {}) {
  return {
    name: tool,
    arguments: args,
    ...(idempotencyKey !== undefined || outputGroupId !== undefined
      ? { _meta: { ...(idempotencyKey !== undefined ? { idempotencyKey } : {}), ...(outputGroupId !== undefined ? { outputGroupId } : {}) } }
      : {}),
  };
}

/**
 * Resolve the session workspace. Ordinary calls remain scoped by default so
 * first-party tenant tools keep their workspace transaction. The explicit
 * `--all-workspaces` escape is the only CLI path that selects the unscoped
 * superuser session required by cross-workspace tools.
 */
export function resolveMcpWorkspace(flags = {}, env = process.env) {
  if (flags.allWorkspaces && flags.workspace !== undefined) {
    throw new Error('--all-workspaces cannot be combined with --workspace');
  }
  if (flags.allWorkspaces) return '*';
  return flags.workspace ?? env.PAPERCUSP_WORKSPACE ?? 'papercusp-workspace';
}

/**
 * Resolve the coordination identity used by the stateless MCP transport.
 *
 * A launched helper can make several `mcp-call` invocations from different
 * processes. `PAPERCUSP_SPAWN_ID` is stable for that launch, whereas a PID is
 * not; using only the PID strands work-item ownership between calls. Preserve
 * an explicit client or full session identity first, then reuse the launch id
 * before falling back to the legacy per-process identity for ordinary shells.
 */
export function resolveMcpClientId(
  flags = {},
  env = process.env,
  pid = process.pid,
) {
  for (const candidate of [
    flags.client,
    env.PAPERCUSP_SID,
    env.PAPERCUSP_SPAWN_ID,
  ]) {
    const value = String(candidate ?? '').trim();
    if (value) return value;
  }
  return `mcp-call-${pid}`;
}

/** Role is an admission routing hint; signed principal checks still run downstream. */
export function resolveMcpRole(env = process.env) {
  return [env.PAPERCUSP_ROLE, env.PAPERCUSP_AGENT_ROLE]
    .map((value) => String(value ?? '').trim())
    .find(Boolean);
}

/**
 * Decide whether this module is the launched script after resolving filesystem
 * aliases. macOS exposes `/tmp` as a symlink to `/private/tmp`; the VM-rig
 * deploy invokes `/tmp/mcp-call.mjs`, while `import.meta.url` canonicalizes to
 * `/private/tmp/mcp-call.mjs`. Comparing their raw URLs suppresses main() and
 * produces a false-success, zero-byte result.
 */
export function isInvokedDirectly(
  argv1,
  moduleUrl,
  resolveRealpath = realpathSync,
) {
  if (!argv1) return false;
  try {
    return resolveRealpath(argv1) === resolveRealpath(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

async function main() {
  const { tool, jsonArgs, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || !tool) {
    console.error('usage: node scripts/mcp-call.mjs <ns:verb> [jsonArgs] [--json -|--json-file <path>] [--client <id>|--client=<id>] [--workspace <ws>|--workspace=<ws>] [--all-workspaces] [--harness <h>|--harness=<h>] [--port <n>|--port=<n>] [--idempotency-key <key>|--idempotency-key=<key>] [--raw]');
    process.exit(flags.help ? 0 : 2);
  }
  let tok;
  try {
    tok = readFileSync(join(homedir(), '.papercusp', 'superuser-token'), 'utf8').trim();
  } catch {
    console.error('mcp-call: no ~/.papercusp/superuser-token — run on a host that has it.');
    process.exit(3);
  }
  let args;
  try {
    args = readJsonArgs({ jsonArgs, flags });
  } catch (error) {
    console.error(`mcp-call: ${error?.message ?? error}`);
    process.exit(2);
  }
  // EI-6631: blank explicit clients still fall through; EI-22014303182044906:
  // launched helpers reuse their stable session/spawn identity across processes.
  const client = resolveMcpClientId(flags);
  let workspace;
  try {
    // The scoped-superuser session requires a resolved workspace (else
    // `scoped_superuser_workspace_unresolved`). Default to the standard one;
    // override with --workspace or PAPERCUSP_WORKSPACE. Cross-workspace calls
    // must opt in explicitly with --all-workspaces.
    workspace = resolveMcpWorkspace(flags);
  } catch (error) {
    console.error(`mcp-call: ${error?.message ?? error}`);
    process.exit(2);
  }
  const qs = buildMcpSessionQuery({
    client,
    workspace,
    harness: flags.harness,
    role: resolveMcpRole(),
    allWorkspaces: flags.allWorkspaces,
  });
  // EI-20182275617587040: PAPERCUSP_HONO_PORT can OUTLIVE the process it described
  // (e.g. a per-session operator that has since died), and a bare fetch at a port with
  // no listener dies as an unactionable `fetch failed`. That is worst precisely HERE:
  // this script IS the documented recovery path for a dropped MCP client, so when it
  // inherits the same stale port, the primary and its fallback fail together and the
  // symptom reads as "the server is down" while the server is answering in ~4ms.
  // So: try the configured port, then canonical, then the resilient MCP proxy.
  const { configuredPort, candidatePorts, pinned } = resolveCandidatePorts(flags);
  const proxyPort = resolveMcpProxyPort();

  const init = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${tok}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: REQUEST_ID,
      method: 'tools/call',
      // Each CLI invocation is a standalone MCP request, even when several
      // processes share one agent SID and start within the 2s legacy cohort
      // window. Do not let a previous process consume this request's budget.
      params: buildMcpCallParams(tool, args, {
        idempotencyKey: flags.idempotencyKey,
        outputGroupId: randomUUID(),
      }),
    }),
  };

  let res;
  let raw;
  let authorityFallback = false;
  let configuredPortError = null;
  const attempts = [];
  for (let index = 0; index < candidatePorts.length; index += 1) {
    const port = candidatePorts[index];
    try {
      const candidateRes = await fetchWithConnectionRecovery(`http://localhost:${port}/api/mcp?${qs}`, init, {
        // An explicit pin means the caller deliberately chose this operator
        // and must not be silently routed to another port while it restarts.
        retryWindowMs: pinned ? MCP_CALL_CONNECTION_RETRY_WINDOW_MS : 0,
        onRetry: ({ attempt, delayMs, remainingMs }) => {
          // Keep a long restart quiet without hiding that recovery is active.
          if (attempt === 1 || attempt % 10 === 0) {
            console.error(
              `mcp-call: ${port} refused the connection; operator may be restarting — ` +
                `retry ${attempt} in ${delayMs}ms (${Math.ceil(remainingMs / 1000)}s left)`,
            );
          }
        },
      });
      const candidateRaw = await candidateRes.text();
      const hasFallback = index < candidatePorts.length - 1;
      if (!pinned && hasFallback && isRecoverableAuthorityDenial(candidateRaw)) {
        authorityFallback = true;
        continue;
      }
      res = candidateRes;
      raw = candidateRaw;
      if (!pinned && port !== String(configuredPort)) {
        console.error(buildFallbackWarning({
          configuredPort,
          port,
          proxyPort,
          configuredPortError,
          authorityFallback,
        }));
      }
      break;
    } catch (err) {
      if (index === 0) configuredPortError = err;
      attempts.push(`${port} (${err?.cause?.code ?? err?.code ?? err?.message ?? 'unknown error'})`);
    }
  }

  if (!res) {
    console.error(
      `mcp-call: could not reach the operator MCP endpoint. Tried port(s): ${attempts.join(', ')}.\n` +
        (pinned ? `  Port ${configuredPort} was explicitly pinned with --port, so no fallback was attempted.\n` : '') +
        `  Nothing is listening there — but a HEALTHY operator on a DIFFERENT port is the common\n` +
        `  case, so do not read this as a dead server. Find the live port:\n` +
        `    ss -ltn | grep -E ':(3070|3170|9071)'   # then: PAPERCUSP_HONO_PORT=<live port> re-run\n` +
        `  The resilient MCP proxy usually listens on :9071 and can bridge an operator restart.\n` +
        `  Confirm the canonical operator is healthy with:\n` +
        `    curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:3070/api/health\n` +
        `  See EI-20182275617587040 / agent-insights/mcp-client-drop-curl-recovery.`,
    );
    process.exit(4);
  }
  if (flags.raw) { process.stdout.write(raw); return; }
  const out = parseSse(raw, REQUEST_ID);
  if (out.error) {
    console.error('MCP_ERROR:', JSON.stringify(out.error));
    process.exit(1);
  }
  console.log(typeof out.result === 'string' ? out.result : JSON.stringify(out.result, null, 2));
}

// Run ONLY when invoked as a script. `parseSse` is exported for tests, and a
// bare `main()` at module scope executed it on import — so importing the parser
// fired a real MCP call and then process.exit(1), which reads as a broken test
// rather than a non-importable module.
const invokedDirectly = isInvokedDirectly(process.argv[1], import.meta.url);

if (invokedDirectly) {
  main().catch((e) => { console.error('mcp-call failed:', e?.message ?? e); process.exit(1); });
}
