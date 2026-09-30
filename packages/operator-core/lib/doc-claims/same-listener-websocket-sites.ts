/**
 * Pins the claim in `libs/generic/desktop-ipc/src/ws-guard.ts` about which
 * WebSocket servers SHARE an HTTP listener (EI-21855861879191381).
 *
 * WHY THIS EXISTS — a guard outlived the measurement that justified it.
 *
 * ws-guard.ts classifies `WebSocket` as GUARDED rather than ROUTED, and its
 * header argues that is sufficient because "there is no `noServer:true` and no
 * `{ server }` attachment anywhere, so no socket shares the operator's HTTP
 * listener... there is nothing on the other end for a shim to reach." That was
 * measured on 2026-08-03 and was true then. `apps/operator/bin/hosted-handler.ts`
 * later added exactly such an attachment for the hosted (app.papercusp.com)
 * runtime, and NOTHING FAILED. `transport-coverage.test.ts` kept passing, because
 * it checks that each door is still WIRED — never that the door's stated
 * justification still holds. So the reasoning quietly expired while every test
 * stayed green, and the next reader inherits a refuted premise as fact.
 *
 * That gap is the real defect, and it is the one this file closes: an absence
 * claim is the cheapest kind of claim to check and the most expensive kind to be
 * wrong about, because acting on one means building something.
 *
 * DELIBERATELY TEXTUAL, and comment-blind. The detector runs over
 * comment-stripped source via `stripComments` (reused from `gate-candidate-ref`,
 * which preserves line numbers by blanking rather than deleting). That is not a
 * detail: ws-guard.ts's CORRECTED header now quotes `noServer: true` in prose, so
 * a naive scanner would report the very paragraph documenting the problem as a
 * violation of itself. The fixture controls in the sibling test pin that.
 *
 * SCOPE, stated because this file's whole subject is over-broad absence claims:
 * it judges only what a textual scan of the declared roots can see. A listener
 * shared through an indirection the text does not name — a helper that receives
 * the options object, a dynamically built config — is invisible here. This
 * narrows the class; it does not eliminate it.
 */
import { stripComments } from './gate-candidate-ref';

/** How a `WebSocketServer` obtains the socket it listens on. */
export type WsServerBinding =
  /** `{ noServer: true }` — the caller feeds it upgrades from another listener. */
  | 'noServer'
  /** `{ server }` / `{ server: httpServer }` — attached directly to a listener. */
  | 'server-attach'
  /** `{ port }` — its own listener. The compliant, non-sharing shape. */
  | 'dedicated-port'
  /** Constructed, but no recognized binding option. Treated as sharing: unknown is not safe. */
  | 'unclassified';

/** A Hono `upgradeWebSocket(...)` route — always shares the host's listener. */
export type WsRouteKind = 'upgrade-route';

export interface WsSite {
  readonly file: string;
  readonly line: number;
  readonly binding: WsServerBinding | WsRouteKind;
}

export interface AllowedWsSite {
  readonly file: string;
  readonly binding: WsServerBinding | WsRouteKind;
  /** Why it is correct that this one shares a listener. The review artifact. */
  readonly reason: string;
}

export interface WsSiteVerdict {
  readonly ok: boolean;
  /** Sharing sites found in the tree that no allowlist entry covers. */
  readonly unexpected: readonly WsSite[];
  /** Allowlist entries whose site is gone — a stale allowlist is also drift. */
  readonly missing: readonly AllowedWsSite[];
  readonly violations: readonly string[];
}

/**
 * A `WebSocketServer` options object is not line-stable — Prettier splits it as
 * soon as it grows, and scanning only the opening line manufactures a false
 * absence, which is precisely the failure mode this file exists to prevent.
 * Bound the join to the constructor call (or 14 lines) so an unrelated later
 * `server:` cannot be attributed to an earlier construction.
 */
function optionsWindow(lines: readonly string[], start: number): string {
  let depth = 0;
  let seenOpen = false;
  const parts: string[] = [];
  for (let i = start; i < Math.min(lines.length, start + 14); i += 1) {
    const line = lines[i] ?? '';
    parts.push(line);
    for (const ch of line) {
      if (ch === '(' || ch === '{') {
        depth += 1;
        seenOpen = true;
      } else if (ch === ')' || ch === '}') depth -= 1;
    }
    if (seenOpen && depth <= 0) break;
  }
  return parts.join(' ');
}

const WS_SERVER_CTOR = /new\s+WebSocketServer\s*\(/;
const UPGRADE_ROUTE = /upgradeWebSocket\s*\(/;
const NO_SERVER = /noServer\s*:\s*true/;
/** `{ server }` shorthand or `{ server: x }` — but never `websocketServer:`/`myServer:`. */
const SERVER_ATTACH = /[{,]\s*server\s*[,:}]/;
const DEDICATED_PORT = /[{,]\s*port\s*[,:]/;

export function classifyWsBinding(window: string): WsServerBinding {
  if (NO_SERVER.test(window)) return 'noServer';
  if (SERVER_ATTACH.test(window)) return 'server-attach';
  if (DEDICATED_PORT.test(window)) return 'dedicated-port';
  return 'unclassified';
}

/** Every WebSocket-server construction and upgrade route in one file. */
export function findWsSites(file: string, source: string): WsSite[] {
  const lines = stripComments(source);
  const sites: WsSite[] = [];
  lines.forEach((line, index) => {
    if (WS_SERVER_CTOR.test(line)) {
      sites.push({
        file,
        line: index + 1,
        binding: classifyWsBinding(optionsWindow(lines, index)),
      });
    }
    if (UPGRADE_ROUTE.test(line)) {
      sites.push({ file, line: index + 1, binding: 'upgrade-route' });
    }
  });
  return sites;
}

/**
 * A site SHARES a listener unless it demonstrably owns one. `unclassified` is
 * deliberately on the sharing side: an unrecognized binding is an unreviewed
 * binding, and defaulting the unknown case to "safe" is how the original claim
 * survived being wrong.
 */
export function sharesListener(site: WsSite): boolean {
  return site.binding !== 'dedicated-port';
}

export function judgeWsSites(
  sites: readonly WsSite[],
  allowlist: readonly AllowedWsSite[],
): WsSiteVerdict {
  const sharing = sites.filter(sharesListener);

  const unexpected = sharing.filter(
    (s) => !allowlist.some((a) => a.file === s.file && a.binding === s.binding),
  );
  const missing = allowlist.filter(
    (a) => !sharing.some((s) => s.file === a.file && s.binding === a.binding),
  );

  const violations: string[] = [];
  for (const s of unexpected) {
    violations.push(
      `${s.file}:${s.line} binds a WebSocket server as "${s.binding}", which SHARES an HTTP ` +
        `listener, and no allowlist entry covers it. ws-guard.ts's header reasons about which ` +
        `sockets share the operator's listener; adding one silently invalidates that reasoning. ` +
        `Either give it a dedicated port, or add it to SAME_LISTENER_WEBSOCKET_SITES with a ` +
        `reason and update the ws-guard.ts header to match.`,
    );
  }
  for (const a of missing) {
    violations.push(
      `${a.file} is on the allowlist as "${a.binding}" but no such site was found. If it was ` +
        `removed, drop the entry AND revisit ws-guard.ts's header, which may now be able to ` +
        `state a stronger claim. A stale allowlist hides the next real one.`,
    );
  }
  return { ok: violations.length === 0, unexpected, missing, violations };
}
