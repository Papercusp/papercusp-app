/**
 * INJECTION TRANSPORT — the one place that talks to the operator.
 *
 * Plan: codex-context-injection-parity-2026-08-09, D-001 (FROZEN, shared
 * verbatim with omp-context-injection-parity-2026-08-09).
 *
 * Everything client-specific lives in `adapters/*.mjs`. Everything about
 * WHEN/HOW LONG/WHETHER-AT-ALL to call lives here, so a fix to the transport is
 * a fix for every client at once — the property that made three copied shell
 * scripts the wrong answer.
 *
 * ── FAIL-SILENT IS THE CONTRACT, NOT AN ERROR-HANDLING STYLE (invariant 1) ──
 * Every failure path returns null and every caller injects nothing. A context
 * hook that raises an error can wedge the client's turn — and it would do so at
 * the exact moment the operator is already unhealthy, i.e. it converts a
 * degraded backend into a broken agent. The bare `|| exit 0` and blanket
 * `except:` in the shell scripts this replaces were this invariant, not
 * sloppiness (D-001 says so explicitly). The tests assert EXIT 0 AND EMPTY
 * STDOUT together, because that pair is the actual contract.
 */

import { PORTS, killSwitchState, specFor } from './ports.mjs';

/**
 * @typedef {import('./ports.mjs').InjectionPort} InjectionPort
 * @typedef {'claude' | 'codex' | 'omp'} InjectionClient
 */

/**
 * @typedef {object} InjectionRequest
 * @property {string} owner
 * @property {string} workspace
 * @property {string} harness
 * @property {string} cwd
 * @property {InjectionClient} client
 * @property {string} [prompt]
 * @property {Array<{ tool: string, toolInput: string, toolResponse: string }>} [toolCalls]
 * @property {boolean} [memoryEnabled]
 * @property {string} [detectorSessionKey] private failure-loop detector key
 * @property {string | null} [confirmedDelivery] turn-start ACK-ON-PROOF token (delivery-ledger.mjs)
 */

/** Loopback operator. */
export function operatorBase(env = process.env) {
  return (env.PAPERCUSP_OPERATOR_URL || 'http://localhost:3070').replace(/\/+$/, '');
}

/**
 * The session id IS the gate: no PAPERCUSP_SID means this is not a psu session,
 * so there is no session to inject into and nothing to look up (invariant 3).
 * Checked before anything else — cheapest possible exit, and the common case
 * for a developer running the client by hand.
 * @returns {string | null}
 */
export function sessionId(env = process.env) {
  const sid = env.PAPERCUSP_SID;
  return typeof sid === 'string' && sid.length > 0 ? sid : null;
}

/**
 * Keep a returned CTRL block bound to the session that requested it.
 *
 * The operator already enforces this at the durable-anchor read, but the hook
 * is the last boundary before text reaches a client. A stale operator response
 * (or an older server that does not stamp `targetOwnerId`) must not be able to
 * change a successor's mode, loop, route, or scope. CTRL is the first block in
 * the turn-start response, followed by ordinary orientation/memory context;
 * reject only that block so useful non-control context can still be delivered.
 *
 * @param {unknown} text
 * @param {string} owner
 * @returns {string | null}
 */
export function fenceControlTransition(text, owner) {
  if (typeof text !== 'string' || !text) return null;
  if (!text.startsWith('⟦CTRL:')) return text;

  // The server renders CTRL as one marker + one JSON line, then separates the
  // following orientation/memory blocks with a blank line. Keep this parser
  // deliberately narrow: an unrecognisable first block is not control we can
  // safely trust, so it is dropped rather than guessed at.
  const match = /^⟦CTRL:(?:transition|full-resync)⟧[ \t]*([^\r\n]*)(?:\r?\n\r?\n|$)/.exec(text);
  if (!match) return null;

  let payload;
  try {
    payload = JSON.parse(match[1]);
  } catch {
    payload = null;
  }
  if (payload && typeof payload === 'object' && payload.targetOwnerId === owner) return text;

  const remainder = text.slice(match[0].length);
  return remainder || null;
}

/**
 * Build the request envelope shared by every client and both ports.
 *
 * ⚠ `cwd` is load-bearing, not decoration (EI-18893248175645463).
 * PAPERCUSP_HARNESS_SLUG is only exported for harness-scoped spawns, so an
 * operator/superuser-scope session never has one — and without a fallback its
 * harness AND hive memory pools were empty for the session's ENTIRE lifetime.
 * Sending cwd lets the server run its own env -> marker-file -> meta-repo
 * detection chain (detect-harness-slug.ts) instead of giving up. Both claude
 * hooks were fixed to send it; anything that drops it re-opens that bug.
 *
 * @param {{ port: InjectionPort, client: InjectionClient, owner: string, cwd?: string, env?: NodeJS.ProcessEnv }} args
 * @returns {InjectionRequest}
 */
export function baseRequest({ port, client, owner, cwd, env = process.env }) {
  /** @type {InjectionRequest} */
  const req = {
    owner,
    client,
    workspace: env.PAPERCUSP_WORKSPACE || '',
    harness: env.PAPERCUSP_HARNESS_SLUG || '',
    cwd: cwd || process.cwd(),
  };
  // See ports.mjs: 'degrade' means the request still goes, memory suppressed.
  const { off, mode } = killSwitchState(port, env);
  if (port === 'turn-start') req.memoryEnabled = !(off && mode === 'degrade');
  return req;
}

/**
 * POST an injection request and return the text to inject.
 *
 * ⚠ NEVER route the loopback operator through an egress proxy. A configured
 * http(s)_proxy 502s the local call, which presents as "injection silently
 * stopped working" on exactly the boxes that have a proxy set. Node's fetch
 * only consults a proxy when one is installed explicitly, so the guard is to
 * pass no agent — documented here because the shell version needed an explicit
 * ProxyHandler({}) and the reason is not obvious from the code.
 *
 * @param {InjectionPort} port
 * @param {InjectionRequest} body
 * @param {{ env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ text: string, deliveryToken: string | null } | null>} the text
 *   to inject plus the turn-start orientation delivery token (delivery-ledger.mjs),
 *   or null to inject nothing
 */
export async function postInjection(port, body, opts = {}) {
  const { env = process.env, fetchImpl = globalThis.fetch } = opts;
  const spec = specFor(port);
  if (!spec) return null;

  const { off, mode } = killSwitchState(port, env);
  if (off && mode === 'suppress') return null;

  // AbortSignal.timeout is the hard wall (invariant 2). It bounds the whole
  // exchange including body read, which a per-socket timeout would not.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), spec.timeoutMs);
  try {
    if (typeof fetchImpl !== 'function') return null;
    const res = await fetchImpl(operatorBase(env) + spec.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res || !res.ok) return null;
    const payload = await res.json();
    if (!payload || typeof payload !== 'object') return null;
    const { text, deliveryToken } = payload;
    if (typeof text !== 'string' || !text.trim()) return null;
    return { text, deliveryToken: typeof deliveryToken === 'string' && deliveryToken ? deliveryToken : null };
  } catch {
    // Timeout, connection refused, malformed JSON, operator restarting mid-call.
    // All of it is "inject nothing" — never an error the turn can see.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Clamp a value to a string of at most `max` chars.
 *
 * ⚠ CLAMP CLIENT-SIDE, NOT SERVER-SIDE (invariant 5). A tool_response can be
 * megabytes (a big grep, a whole-file read) and mid-turn runs on EVERY batch —
 * shipping raw batches would make the transport itself the dominant cost. The
 * server only needs enough text to form a query.
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
export function clampField(value, max) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : safeStringify(value);
  return text.slice(0, max);
}

/** @param {unknown} value @returns {string} */
function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    // Cyclic or otherwise unserializable tool payloads must not break a turn.
    return '';
  }
}

/**
 * Build the mid-turn digest from an already-normalised call list, applying the
 * contract clamps. Shared by every adapter so the three clients cannot drift
 * into shipping different volumes of context for the same batch.
 * @param {Array<{ tool?: unknown, toolInput?: unknown, toolResponse?: unknown }>} calls
 * @returns {Array<{ tool: string, toolInput: string, toolResponse: string }>}
 */
export function buildDigest(calls) {
  const spec = PORTS['mid-turn'];
  if (!Array.isArray(calls)) return [];
  const digest = [];
  for (const call of calls.slice(0, spec.maxCalls)) {
    if (!call || typeof call !== 'object') continue;
    digest.push({
      tool: typeof call.tool === 'string' ? call.tool : '',
      toolInput: clampField(call.toolInput, spec.fieldClamp),
      toolResponse: clampField(call.toolResponse, spec.fieldClamp),
    });
  }
  return digest;
}

/**
 * Clamp a turn-start prompt to the contract length.
 * @param {unknown} prompt
 * @returns {string}
 */
export function clampPrompt(prompt) {
  return typeof prompt === 'string' ? prompt.slice(0, PORTS['turn-start'].promptClamp) : '';
}

/**
 * The whole pipeline for one event, minus the client specifics.
 *
 * Adapters supply the three pure functions; this owns every decision that must
 * be identical across clients. Returns the STDOUT PAYLOAD STRING, or null for
 * "emit nothing" — deliberately a string, not an object, because each client's
 * payload shape is the adapter's business (claude/codex emit a JSON envelope,
 * omp emits bare text) and core must never parse or re-serialize it.
 *
 * @param {object} args
 * @param {import('./index.mjs').InjectionAdapter} args.adapter
 * @param {string} args.nativeEvent
 * @param {unknown} args.event
 * @param {NodeJS.ProcessEnv} [args.env]
 * @param {typeof fetch} [args.fetchImpl]
 * @param {(owner: string, env: NodeJS.ProcessEnv) => import('./delivery-ledger.mjs').DeliveryLedger | null} [args.openDeliveryLedger]
 *   turn-start only. Opts the request into ACK-ON-PROOF: the last confirmed token
 *   rides as `confirmedDelivery`, and the returned token is OFFERED to the ledger
 *   once a payload exists. Committing it is the caller's job, after it has actually
 *   written the payload — only the process that prints knows the print succeeded.
 * @returns {Promise<string | null>}
 */
export async function runInjection({ adapter, nativeEvent, event, env = process.env, fetchImpl, openDeliveryLedger }) {
  try {
    const owner = sessionId(env);
    if (!owner) return null;

    const port = adapter.portForEvent(nativeEvent);
    if (!port || !specFor(port)) return null;

    const { off, mode } = killSwitchState(port, env);
    if (off && mode === 'suppress') return null;

    // parse() returning null means "no signal in this event" — e.g. an empty
    // batch, a blank prompt. Spend nothing: no request, no output.
    const partial = adapter.parse(port, event);
    if (!partial) return null;

    const detectorSessionKey =
      typeof env.PAPERCUSP_FAILURE_LOOP_SESSION_KEY === 'string' &&
      env.PAPERCUSP_FAILURE_LOOP_SESSION_KEY.trim()
        ? env.PAPERCUSP_FAILURE_LOOP_SESSION_KEY.trim()
        : owner;
    const ledger = port === 'turn-start' && openDeliveryLedger ? openDeliveryLedger(owner, env) : null;
    const request = {
      ...baseRequest({ port, client: adapter.client, owner, cwd: partial.cwd, env }),
      ...partial,
      owner,
      client: adapter.client,
      // Keep the detector key explicit in the request while retaining the
      // public owner for memory recall. The producer copies the private key
      // used to sign MCP `?detector=` into this env carrier; the owner fallback
      // preserves older hook launches that predate the carrier.
      ...(port === 'mid-turn' ? { detectorSessionKey } : {}),
      ...(ledger ? { confirmedDelivery: ledger.confirmed() } : {}),
    };

    const response = await postInjection(port, request, { env, fetchImpl });
    const safeText = fenceControlTransition(response?.text ?? null, owner);
    if (!safeText) return null;

    const payload = adapter.render(port, safeText, event);
    if (typeof payload !== 'string' || payload.length === 0) return null;
    if (ledger && response?.deliveryToken) ledger.offer(response.deliveryToken);
    return payload;
  } catch {
    // Invariant 1, final backstop: an adapter bug must cost silence, not a turn.
    return null;
  }
}
