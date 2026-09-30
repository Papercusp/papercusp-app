import WebSocket from 'ws';
import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;
const DEFAULT_CLOSE_POLL_MS = 100;

export class CdpEvaluationError extends Error {
  constructor(expression, exceptionDetails) {
    const description = exceptionDetails?.exception?.description
      ?? exceptionDetails?.text
      ?? JSON.stringify(exceptionDetails);
    super(`Runtime.evaluate failed: ${description}`);
    this.name = 'CdpEvaluationError';
    this.expression = expression;
    this.exceptionDetails = exceptionDetails;
  }
}

export class CdpProtocolError extends Error {
  constructor(method, error) {
    super(`${method} failed: ${error?.message ?? JSON.stringify(error)}`);
    this.name = 'CdpProtocolError';
    this.method = method;
    this.protocolError = error;
  }
}

export class CdpRequestTimeoutError extends Error {
  constructor(method, timeoutMs) {
    super(`${method} timed out after ${timeoutMs}ms`);
    this.name = 'CdpRequestTimeoutError';
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class CdpTransportClosedError extends Error {
  constructor(method) {
    super(`CDP transport closed while waiting for ${method}`);
    this.name = 'CdpTransportClosedError';
    this.method = method;
  }
}

function addListener(ws, event, handler) {
  if (typeof ws.on === 'function') {
    ws.on(event, handler);
    return;
  }
  ws.addEventListener(event, handler);
}

function addOnceListener(ws, event, handler) {
  if (typeof ws.once === 'function') {
    ws.once(event, handler);
    return;
  }
  const once = (...args) => {
    ws.removeEventListener?.(event, once);
    handler(...args);
  };
  ws.addEventListener(event, once);
}

function messageText(data) {
  if (typeof data === 'string') return data;
  if (data?.data !== undefined) return messageText(data.data);
  return data?.toString?.() ?? String(data);
}

function errorMessage(error) {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Render an inspector/browser URL safely for diagnostic output.
 *
 * Debugger and browser WebSocket URLs can carry credentials or short-lived
 * access tokens in their query string. Diagnostics only need the endpoint
 * identity, so omit credentials, search parameters, and fragments entirely.
 * An unparseable value is not echoed because it may itself contain a secret.
 */
export function redactDiagnosticUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname || '/'}`;
  } catch {
    return '<unparseable-url>';
  }
}

/**
 * Create a small CDP client whose Runtime.evaluate path cannot mistake
 * `exceptionDetails` for a successful evaluation.
 */
export function createCdpClient(
  wsUrl,
  {
    WebSocketImpl = WebSocket,
    webSocketOptions = { maxPayload: 1024 * 1024 * 1024 },
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = {},
) {
  const ws = new WebSocketImpl(wsUrl, webSocketOptions);
  let nextId = 0;
  let transportClosed = false;
  const pending = new Map();

  const rejectPending = (error) => {
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      pending.delete(id);
      request.reject(error instanceof CdpTransportClosedError
        ? error
        : errorMessage(error));
    }
  };

  addListener(ws, 'message', (data) => {
    let message;
    try {
      message = JSON.parse(messageText(data));
    } catch (error) {
      rejectPending(error);
      return;
    }
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new CdpProtocolError(request.method, message.error));
    else request.resolve(message.result);
  });

  addListener(ws, 'close', () => {
    transportClosed = true;
    rejectPending(new CdpTransportClosedError('CDP request'));
  });
  addListener(ws, 'error', (error) => {
    if (!transportClosed) rejectPending(error);
  });

  const connect = () => {
    if (ws.readyState === 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      addOnceListener(ws, 'open', resolve);
      addOnceListener(ws, 'error', (error) => reject(errorMessage(error)));
      addOnceListener(ws, 'close', () => reject(new CdpTransportClosedError('connect')));
    });
  };

  const send = (method, params = {}, timeoutMs = requestTimeoutMs) => {
    if (transportClosed) return Promise.reject(new CdpTransportClosedError(method));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CdpRequestTimeoutError(method, timeoutMs));
      }, timeoutMs);
      pending.set(id, { method, resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(errorMessage(error));
      }
    });
  };

  const evaluate = async (expression, params = {}, timeoutMs = requestTimeoutMs) => {
    const result = await send('Runtime.evaluate', { expression, ...params }, timeoutMs);
    if (result?.exceptionDetails) {
      throw new CdpEvaluationError(expression, result.exceptionDetails);
    }
    return result;
  };

  const close = () => {
    if (transportClosed) return;
    transportClosed = true;
    try {
      ws.close();
    } catch {
      // The target may have already torn down the transport.
    }
  };

  return { ws, connect, send, evaluate, close };
}

/**
 * Find a Node inspector target and retain its port for post-close verification.
 */
export async function discoverInspector({
  startPort = 9229,
  portCount = 6,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = 1_500,
} = {}) {
  for (let port = startPort; port < startPort + portCount; port += 1) {
    try {
      const response = await fetchImpl(
        `http://127.0.0.1:${port}/json/list`,
        { signal: AbortSignal.timeout(requestTimeoutMs) },
      );
      if (!response.ok) continue;
      const list = await response.json();
      const target = list.find((entry) => entry.webSocketDebuggerUrl);
      if (target) return { port, wsUrl: target.webSocketDebuggerUrl };
    } catch {
      // Try the next candidate port.
    }
  }
  return null;
}

async function inspectorResponds(port, fetchImpl) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`);
    // A successful HTTP response proves that the inspector is still listening,
    // even if its target list happens to be empty during shutdown.
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForInspectorClosed(
  port,
  {
    fetchImpl = globalThis.fetch,
    sleepImpl = sleep,
    timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_CLOSE_POLL_MS,
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await inspectorResponds(port, fetchImpl))) return true;
    if (Date.now() >= deadline) break;
    await sleepImpl(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  return false;
}

/**
 * Close the target inspector, then prove the listening port went away.
 * `_debugEnd()` tears down the CDP transport before its reply can arrive, so
 * transport close/timeout is expected; Runtime.evaluate exceptions are not.
 */
export async function closeInspector(
  client,
  port,
  {
    evaluateTimeoutMs = 1_000,
    fetchImpl = globalThis.fetch,
    sleepImpl = sleep,
    verifyTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_CLOSE_POLL_MS,
  } = {},
) {
  let evaluationError = null;
  try {
    await client.evaluate('process._debugEnd()', { returnByValue: true }, evaluateTimeoutMs);
  } catch (error) {
    if (!(error instanceof CdpRequestTimeoutError) && !(error instanceof CdpTransportClosedError)) {
      evaluationError = errorMessage(error);
    }
  } finally {
    client.close();
  }

  const closed = await waitForInspectorClosed(port, {
    fetchImpl,
    sleepImpl,
    timeoutMs: verifyTimeoutMs,
    pollIntervalMs,
  });
  if (!closed) {
    const detail = evaluationError ? `; close expression failed: ${evaluationError.message}` : '';
    throw new Error(`inspector still open on port ${port} after close request${detail}`);
  }
  if (evaluationError) throw evaluationError;
  return { closed: true };
}
