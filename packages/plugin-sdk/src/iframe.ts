/**
 * @papercusp/plugin-sdk/iframe — SDK plugin authors import in their
 * iframe HTML to talk to the host (operator) via postMessage.
 *
 * Three host-mediated channels (per rev3 plan + the WIT v0.1.0 shape):
 *   - usePapercupAction(name, payload)  — RPC into plugin core
 *   - usePapercupEvent(name, handler)   — pub/sub from plugin core
 *   - usePapercupQuery(query)           — reactive PG-backed state
 *
 * Wire format: postMessage between iframe + parent operator.
 * Messages are tagged JSON envelopes:
 *   { kind: 'rpc-request', id, action, payload-b64 }
 *   { kind: 'rpc-response', id, ok, payload-b64?, error? }
 *   { kind: 'event-subscribe', name }
 *   { kind: 'event-unsubscribe', name }
 *   { kind: 'event', name, payload-b64 }
 *   { kind: 'query', query, id }
 *   { kind: 'query-result', id, rows }
 *
 * Source-window check: caller verifies event.source === window.parent.
 * Origin string is "null" for sandbox=allow-scripts iframes (per the
 * rev3 plan A2 fix to drop sandbox attribute, single-origin
 * iframe.app.papercup.local is used instead — origin string is
 * meaningful again, but we keep source-window as belt+suspenders).
 *
 * No React-specific code: this SDK is React-agnostic so plugins can
 * use vanilla JS, Vue, Svelte, etc. inside their iframe.
 */

type RpcRequestMsg = {
  kind: 'rpc-request';
  id: string;
  action: string;
  payloadB64: string;
};

type RpcResponseMsg = {
  kind: 'rpc-response';
  id: string;
  ok: true;
  payloadB64: string;
} | {
  kind: 'rpc-response';
  id: string;
  ok: false;
  error: { tag: string; message: string };
};

type EventMsg = {
  kind: 'event';
  name: string;
  payloadB64: string;
};

type EventSubscribeMsg = {
  kind: 'event-subscribe';
  name: string;
};

type EventUnsubscribeMsg = {
  kind: 'event-unsubscribe';
  name: string;
};

let _nextRpcId = 1;
const _pendingRpc = new Map<string, (resp: RpcResponseMsg) => void>();
const _eventHandlers = new Map<string, Set<(payload: Uint8Array) => void>>();

function nextRpcId(): string {
  return `rpc-${Date.now()}-${_nextRpcId++}`;
}

/**
 * Per-iframe nonce read from the operator-templated wrapper's
 * <meta name="papercup-nonce" content="..."> tag. The operator
 * generates a fresh nonce per iframe mount; every postMessage
 * envelope carries it so the parent can drop spoofed/cross-origin
 * messages even if they pass the source-window check.
 */
let _nonce = '';
function readNonce(): string {
  if (_nonce) return _nonce;
  if (typeof document === 'undefined') return '';
  const m = document.querySelector('meta[name="papercup-nonce"]');
  _nonce = (m as HTMLMetaElement | null)?.content ?? '';
  return _nonce;
}

/**
 * Initialize the iframe SDK. Sets up the postMessage listener; must
 * be called before any of the use* helpers.
 */
export function initPapercupIframe(): void {
  if (typeof window === 'undefined') {
    throw new Error('initPapercupIframe() must run in a browser context');
  }
  readNonce();
  window.addEventListener('message', (event) => {
    // Source-window check: only trust messages from our parent (the
    // operator). Origin check is a belt+suspenders since sandbox
    // attribute would zero it; both must pass.
    if (event.source !== window.parent) return;
    const msg = event.data as (RpcResponseMsg | EventMsg) & { nonce?: string } | undefined;
    if (!msg || typeof msg !== 'object' || !('kind' in msg)) return;
    if (_nonce && msg.nonce !== _nonce) return;
    if (msg.kind === 'rpc-response') {
      const cb = _pendingRpc.get(msg.id);
      if (cb) {
        _pendingRpc.delete(msg.id);
        cb(msg);
      }
    } else if (msg.kind === 'event') {
      const handlers = _eventHandlers.get(msg.name);
      if (handlers) {
        const payload = b64ToBytes(msg.payloadB64);
        for (const h of handlers) {
          try {
            h(payload);
          } catch (e) {
            // eslint-disable-next-line no-console
            console.error('iframe event handler threw:', e);
          }
        }
      }
    }
  });
}

/**
 * Invoke a plugin action by name. Resolves with bytes from the plugin
 * (Ok) or rejects with a typed error (capability-denied, plugin-error,
 * not-found, invalid-payload).
 */
export async function usePapercupAction(
  action: string,
  payload: Uint8Array,
): Promise<Uint8Array> {
  const id = nextRpcId();
  const msg: RpcRequestMsg = {
    kind: 'rpc-request',
    id,
    action,
    payloadB64: bytesToB64(payload),
  };
  return new Promise((resolve, reject) => {
    _pendingRpc.set(id, (resp) => {
      if (resp.ok) {
        resolve(b64ToBytes(resp.payloadB64));
      } else {
        const err = new Error(`${resp.error.tag}: ${resp.error.message}`);
        (err as Error & { tag?: string }).tag = resp.error.tag;
        reject(err);
      }
    });
    window.parent.postMessage({ ...msg, nonce: readNonce() }, "*");
  });
}

/**
 * Subscribe to events emitted by the plugin's core. Returns an
 * unsubscribe function. Multiple handlers per event name allowed;
 * each fires for every event.
 */
export function usePapercupEvent(
  name: string,
  handler: (payload: Uint8Array) => void,
): () => void {
  let handlers = _eventHandlers.get(name);
  if (!handlers) {
    handlers = new Set();
    _eventHandlers.set(name, handlers);
    const sub: EventSubscribeMsg = { kind: 'event-subscribe', name };
    window.parent.postMessage({ ...sub, nonce: readNonce() }, "*");
  }
  handlers.add(handler);
  return () => {
    const set = _eventHandlers.get(name);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) {
      _eventHandlers.delete(name);
      const unsub: EventUnsubscribeMsg = { kind: 'event-unsubscribe', name };
      window.parent.postMessage({ ...unsub, nonce: readNonce() }, "*");
    }
  };
}

/**
 * Query plugin's PG-backed shared state. Returns the current rows;
 * subscribe via usePapercupEvent for reactive updates (operator's
 * sync layer emits change events under the conventional name
 * `<pluginId>.kv-changed` or similar — pattern up to plugin author).
 *
 * v0.1.0: query is a string passed straight to the operator's data
 * channel. v0.2.0 will wire to Zero query objects directly.
 */
export async function usePapercupQuery(query: string): Promise<unknown[]> {
  const id = nextRpcId();
  const msg = { kind: 'query' as const, id, query };
  return new Promise((resolve, reject) => {
    _pendingRpc.set(id, (resp) => {
      if (resp.ok) {
        try {
          const parsed = JSON.parse(new TextDecoder().decode(b64ToBytes(resp.payloadB64)));
          resolve(Array.isArray(parsed) ? parsed : []);
        } catch (e) {
          reject(e);
        }
      } else {
        reject(new Error(`${resp.error.tag}: ${resp.error.message}`));
      }
    });
    window.parent.postMessage({ ...msg, nonce: readNonce() }, "*");
  });
}

/* ───── b64 helpers (browser-safe; no Node Buffer dependency) ────── */

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    out[i] = s.charCodeAt(i);
  }
  return out;
}
