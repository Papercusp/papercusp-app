/**
 * loopback-peer-trust — bind "this request came from loopback" to the TRANSPORT
 * identity (the connecting process's uid) on hosts where the loopback interface is
 * shared across trust domains (WI-10003619).
 *
 * ## Why this exists
 *
 * Every loopback trust decision in the operator reads the request's ADDRESS: the
 * `auth:'loopback'` route tier (`requireLoopbackOr403`), the `principalFromLoopback`
 * fallback at the end of `requirePrincipal` (a `'*'`-capability principal), and the
 * ~27 ad-hoc `isLoopbackRequest` callers. On a desktop that is sound: the only
 * processes on the box belong to the one user who owns the operator.
 *
 * A hosted workspace VM breaks that premise. The operator runs as the service
 * account, while the CUSTOMER account (the D-417 PTY identity and the D-421
 * customer-driven agent identity) runs shells and shell-capable agents on the SAME
 * loopback interface. Measured 2026-09-28 on owner-test r56: logged in as the customer
 * (uid 1001), `GET 127.0.0.1:3070/api/internal/managed-timers` (an `auth:'loopback'`
 * route) returned 200 from the operator running as uid 999. The address cannot tell
 * the two apart; the socket owner can.
 *
 * ## What it does
 *
 * `runWithLoopbackPeerVerdict(socket, fn)` wraps the host's fetch handler. When the
 * policy is active it resolves the uid that owns the CLIENT end of a loopback TCP
 * connection from `/proc/net/tcp{,6}` and records a per-request verdict in an
 * AsyncLocalStorage. `isLoopbackRequest` and `requireLoopbackOr403` consult
 * `currentLoopbackPeerIsForeign()` and withdraw loopback trust from any peer that is
 * not the service uid — so a foreign local caller must authenticate like anyone else
 * (cookie / device JWT / bearer), and loopback-tier routes refuse it outright.
 *
 * Fail-closed: when the policy is active and the peer's owner cannot be resolved
 * (row vanished, /proc unreadable, malformed row) the verdict is FOREIGN.
 *
 * ## When it is active
 *
 * `loopbackPeerUidPolicyActive(env)`:
 *   - `PAPERCUSP_LOOPBACK_PEER_UID_POLICY=service-only` (explicit, any host), or
 *   - the host is a workspace host: the vm-release distribution profile
 *     (`isVmReleaseDistribution`, the same predicate host-docs uses to close
 *     /internal/docs there), or `PAPERCUSP_HOSTED_WORKSPACE_ROOT` /
 *     `PAPERCUSP_HOSTED_CONNECTOR_BEARER` is set. This is a deliberate SUPERSET of
 *     `readHostedWorkspaceHostConfig()` (which also requires a parseable control-plane
 *     URL to dial): a hosted host whose connector is misconfigured is still a
 *     multi-account host, and must not silently fall back to address trust.
 *   - `PAPERCUSP_LOOPBACK_PEER_UID_POLICY=off` disables it explicitly (never set by
 *     the bootstrap; an operator escape hatch only).
 * A desktop / dev box sets none of these, so the wrapper is a no-op there.
 *
 * The portal's customer traffic is unaffected by construction: it enters through the
 * outbound connector, and `OperatorHttpChannel` re-issues each request from the
 * operator process itself (the service uid), with its own allowlist as the boundary.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { pinModuleState } from '@papercusp/module-singleton';

/**
 * Mirrors `isVmReleaseDistribution()` (vm-release-runtime-policy.ts). Inlined, not
 * imported: that module imports remote-auth-policy → loopback-guard → this module,
 * which would close an import cycle. The equality is pinned by
 * loopback-peer-trust.test.ts so the two cannot drift.
 */
export const VM_RELEASE_PROFILE_MIRROR = 'vm-release';
function isVmReleaseDistribution(env: NodeJS.ProcessEnv): boolean {
  return env.PAPERCUSP_DISTRIBUTION_PROFILE === VM_RELEASE_PROFILE_MIRROR;
}

export type LoopbackPeerVerdict =
  /** Peer is not on a loopback address; the direct-remote gate owns it. */
  | { kind: 'non-loopback' }
  /** Loopback peer owned by the service uid — full loopback trust. */
  | { kind: 'service'; uid: number }
  /** Loopback peer NOT proven to be the service uid — loopback trust withdrawn. */
  | { kind: 'foreign'; uid: number | null; reason: 'uid-mismatch' | 'unresolved' };

/** The address/port tuple of one accepted TCP connection, as the server sees it. */
export interface LoopbackPeerSocket {
  remoteAddress?: string | null;
  remotePort?: number | null;
  localAddress?: string | null;
  localPort?: number | null;
}

export const LOOPBACK_PEER_UID_POLICY_ENV = 'PAPERCUSP_LOOPBACK_PEER_UID_POLICY';

const PROC_NET_TCP_FILES = ['/proc/net/tcp', '/proc/net/tcp6'] as const;

const state = pinModuleState('@papercusp/operator-core.loopback-peer-trust', () => ({
  als: new AsyncLocalStorage<LoopbackPeerVerdict>(),
  // Keep-alive connections carry many requests; resolve each socket once.
  bySocket: new WeakMap<object, LoopbackPeerVerdict>(),
}));

/** True when this host must bind loopback trust to the peer uid. */
export function loopbackPeerUidPolicyActive(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env[LOOPBACK_PEER_UID_POLICY_ENV]?.trim();
  if (explicit === 'off') return false;
  if (explicit === 'service-only') return true;
  return Boolean(
    isVmReleaseDistribution(env) ||
      env.PAPERCUSP_HOSTED_WORKSPACE_ROOT?.trim() ||
      env.PAPERCUSP_HOSTED_CONNECTOR_BEARER?.trim(),
  );
}

/** Loopback in any of the spellings Node reports for an accepted socket. */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const a = address.trim().toLowerCase();
  if (a === '::1') return true;
  const v4 = a.startsWith('::ffff:') ? a.slice('::ffff:'.length) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * Decode one `/proc/net/tcp{,6}` address column (`HEXIP:HEXPORT`) into a
 * normalized `{ ip, port }`. The kernel prints each 32-bit word of the address in
 * host byte order; every Linux target we ship (x86_64, arm64) is little-endian, so
 * each word's bytes are reversed. IPv4-mapped IPv6 decodes to the bare IPv4 form so
 * it compares equal to what Node reports on a dual-stack socket.
 */
export function decodeProcNetAddress(column: string): { ip: string; port: number } | null {
  const [hexIp, hexPort] = column.split(':');
  if (!hexIp || !hexPort || !/^[0-9A-Fa-f]+$/.test(hexIp) || !/^[0-9A-Fa-f]{4}$/.test(hexPort)) return null;
  const port = parseInt(hexPort, 16);
  if (hexIp.length === 8) {
    const bytes = wordBytesLE(hexIp);
    return { ip: bytes.join('.'), port };
  }
  if (hexIp.length === 32) {
    const bytes: number[] = [];
    for (let w = 0; w < 4; w++) bytes.push(...wordBytesLE(hexIp.slice(w * 8, w * 8 + 8)));
    const mapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    if (mapped) return { ip: bytes.slice(12).join('.'), port };
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
    return { ip: compressIpv6(groups), port };
  }
  return null;
}

function wordBytesLE(hex8: string): number[] {
  const out: number[] = [];
  for (let i = 6; i >= 0; i -= 2) out.push(parseInt(hex8.slice(i, i + 2), 16));
  return out;
}

function compressIpv6(groups: string[]): string {
  // Longest run of zero groups → '::' (RFC 5952); enough for comparison with Node's form.
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < groups.length; ) {
    if (groups[i] !== '0') { i++; continue; }
    let j = i;
    while (j < groups.length && groups[j] === '0') j++;
    if (j - i > bestLen) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  if (bestLen < 2) return groups.join(':');
  const head = groups.slice(0, bestStart).join(':');
  const tail = groups.slice(bestStart + bestLen).join(':');
  return `${head}::${tail}`;
}

/** Normalize a Node-reported address for comparison with a decoded /proc one. */
function normalizeAddress(address: string): string {
  const a = address.trim().toLowerCase();
  return a.startsWith('::ffff:') && a.includes('.') ? a.slice('::ffff:'.length) : a;
}

/**
 * Find the uid owning the CLIENT end of a connection in one `/proc/net/tcp{,6}`
 * body: the row whose LOCAL address is the client's (the server's `remote*`) and
 * whose REMOTE address is the server's (`local*`). Matching both ends excludes the
 * server's own row for the same connection, which is owned by the service.
 */
export function findClientSocketUid(
  procNetTcp: string,
  peer: { clientIp: string; clientPort: number; serverIp: string; serverPort: number },
): number | null {
  const clientIp = normalizeAddress(peer.clientIp);
  const serverIp = normalizeAddress(peer.serverIp);
  for (const line of procNetTcp.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    // sl local_address rem_address st tx:rx tr:tm retrnsmt uid timeout inode
    if (cols.length < 8) continue;
    const local = decodeProcNetAddress(cols[1]!);
    const remote = decodeProcNetAddress(cols[2]!);
    if (!local || !remote) continue;
    if (local.port !== peer.clientPort || remote.port !== peer.serverPort) continue;
    if (local.ip !== clientIp || remote.ip !== serverIp) continue;
    const uid = Number(cols[7]);
    return Number.isInteger(uid) && uid >= 0 ? uid : null;
  }
  return null;
}

export interface ResolveLoopbackPeerOptions {
  /** The uid loopback trust is reserved for. Default: this process's uid. */
  serviceUid?: number;
  /** Read one /proc file; throw when unreadable. Default: `fs.readFileSync`. */
  readProcFile?: (path: string) => string;
}

/** Compute the verdict for one accepted socket. Pure apart from the /proc read. */
export function resolveLoopbackPeerVerdict(
  socket: LoopbackPeerSocket | null | undefined,
  options: ResolveLoopbackPeerOptions = {},
): LoopbackPeerVerdict {
  const remoteAddress = socket?.remoteAddress ?? null;
  if (!isLoopbackAddress(remoteAddress)) {
    // No socket at all (an in-process app.request) is not a network peer: treat as
    // non-loopback so the address-based gates keep their existing behaviour for it.
    return { kind: 'non-loopback' };
  }
  const serviceUid = options.serviceUid ?? currentProcessUid();
  const read = options.readProcFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const clientPort = socket?.remotePort;
  const serverPort = socket?.localPort;
  const serverIp = socket?.localAddress;
  if (serviceUid === null || !clientPort || !serverPort || !serverIp) {
    return { kind: 'foreign', uid: null, reason: 'unresolved' };
  }
  for (const file of PROC_NET_TCP_FILES) {
    let body: string;
    try {
      body = read(file);
    } catch {
      continue;
    }
    const uid = findClientSocketUid(body, {
      clientIp: remoteAddress!,
      clientPort,
      serverIp,
      serverPort,
    });
    if (uid === null) continue;
    return uid === serviceUid ? { kind: 'service', uid } : { kind: 'foreign', uid, reason: 'uid-mismatch' };
  }
  return { kind: 'foreign', uid: null, reason: 'unresolved' };
}

function currentProcessUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/**
 * Run `fn` (the host's request handler) with this connection's verdict in scope.
 * A no-op wrapper when the policy is inactive, so single-user hosts pay nothing.
 */
export function runWithLoopbackPeerVerdict<T>(
  socket: (LoopbackPeerSocket & object) | null | undefined,
  fn: () => T,
  options: ResolveLoopbackPeerOptions & { env?: NodeJS.ProcessEnv } = {},
): T {
  if (!loopbackPeerUidPolicyActive(options.env)) return fn();
  let verdict = socket ? state.bySocket.get(socket) : undefined;
  if (!verdict) {
    verdict = resolveLoopbackPeerVerdict(socket, options);
    // Cache only a positive answer. A foreign/unresolved verdict is re-derived per
    // request, so a transient /proc miss cannot pin a connection shut, and a uid
    // cannot be "upgraded" by reusing a socket (a socket's owner never changes).
    if (socket && verdict.kind === 'service') state.bySocket.set(socket, verdict);
  }
  return state.als.run(verdict, fn);
}

/**
 * The same verdict for a listener that does NOT run inside host-handler's wrapper —
 * a server with its own `http.createServer` / `WebSocketServer` (the inference
 * gateway, the desktop voice bridge). Those listeners bind 127.0.0.1 and used the
 * address as their only boundary, which a hosted workspace host does not honour
 * (WI-10003621: from the customer uid, the gateway's `/admin/*` answered 200 and the
 * voice bridge piped the caller into the operator's voice socket).
 *
 * Returns the foreign verdict to refuse, or null to proceed: the policy is inactive
 * (single-user hosts pay nothing), the peer is not on loopback, or it is the service
 * uid. Positive answers are cached per socket exactly as the host-handler wrapper does.
 */
export function foreignLoopbackPeerForSocket(
  socket: (LoopbackPeerSocket & object) | null | undefined,
  options: ResolveLoopbackPeerOptions & { env?: NodeJS.ProcessEnv } = {},
): Extract<LoopbackPeerVerdict, { kind: 'foreign' }> | null {
  if (!loopbackPeerUidPolicyActive(options.env)) return null;
  const cached = socket ? state.bySocket.get(socket) : undefined;
  if (cached) return null;
  const verdict = resolveLoopbackPeerVerdict(socket, options);
  if (verdict.kind === 'service' && socket) state.bySocket.set(socket, verdict);
  return verdict.kind === 'foreign' ? verdict : null;
}

/** The verdict for the request currently executing, or null outside the wrapper. */
export function currentLoopbackPeerVerdict(): LoopbackPeerVerdict | null {
  return state.als.getStore() ?? null;
}

/** True when the current request is a loopback peer NOT proven to be the service. */
export function currentLoopbackPeerIsForeign(): boolean {
  return state.als.getStore()?.kind === 'foreign';
}

/**
 * The single 403 every loopback-trust gate returns for a foreign local peer.
 * Deliberately distinct from `loopback_only` so a refusal names the real reason.
 */
export function foreignLoopbackPeerResponse(): Response | null {
  const verdict = state.als.getStore();
  if (verdict?.kind !== 'foreign') return null;
  return Response.json(
    {
      error: 'loopback_peer_uid_denied',
      detail:
        'On a hosted workspace host, loopback trust is reserved for the operator service account. ' +
        'Authenticate this request with a session or bearer instead.',
      reason: verdict.reason,
    },
    { status: 403 },
  );
}
