/**
 * @papercusp/operator-core/lib/authority — the per-harness lock authority.
 *
 * Stable import surface for Track B of
 * distributed-coordination-shared-harness-2026-06-04. Peers whose control state
 * needs cross-machine serialization (file-claim locks, plan-item claim leases —
 * plan-item-assignment-claim-liveness-2026-06-04) import from here:
 *
 *   import { lockAuthorityFor, routeToAuthority }
 *     from '@papercusp/operator-core/lib/authority';
 *
 * - `lockAuthorityFor(harnessSlug)` → `{ isSelf, peer?, liveCount }`
 * - `routeToAuthority(harnessSlug, { local, remote? })` → runs local when we are
 *   the authority, RPCs a remote authority when a transport exists, else fails
 *   open (D-004 — git-merge is the backstop).
 *
 * See ./README.md for the full contract + the cross-machine cutover.
 */

export {
  lockAuthorityFor,
  isLockAuthority,
  routeToAuthority,
  DEFAULT_AUTHORITY_STALE_MS,
  type PeerRef,
  type AuthorityResolution,
  type SelfSwarmIdentity,
  type LockAuthorityDeps,
  type AuthorityOp,
  type RouteResult,
} from './lock-authority';

export {
  setPeerRpcTransport,
  getPeerRpcTransport,
  NULL_PEER_RPC_TRANSPORT,
  PeerUnreachableError,
  type PeerRpcTransport,
  type AuthorityRpcRequest,
} from './peer-rpc-transport';

export {
  routeFileLockOp,
  configureFileLockDomainResolver,
  getDomainToHarnessSlug,
  type DomainToHarnessSlug,
  type FileLockRoutingDeps,
} from './file-lock-routing';

export {
  hasRemotePeers,
  invalidateRemotePeers,
  type RemotePeersCacheDeps,
} from './remote-peers-cache';

export {
  LockSetReconstructor,
  type HeldLock,
  type LockSetReconstructorOpts,
} from './lock-set-reconstructor';

export {
  LOCK_EVENT_TABLE,
  reconstructLockSet,
  lockEventHbKey,
  lockEventToPeerLogOp,
  peerLogOpToLockEvent,
  recordLockEvent,
  setLockEventSink,
  getLockEventSink,
  setLockEventReader,
  getLockEventReader,
  PeerLogLockEventSink,
  PeerLogLockEventReader,
  type LockEvent,
  type LockEventSink,
  type LockEventReader,
  type OwnLogAppender,
  type OwnLogResolver,
  type ReadableLog,
  type AdmittedLogsResolver,
} from './lock-event-stream';

export { wireLockEventStream } from './lock-event-wiring';

export {
  AuthorityEvictionMonitor,
  setAuthorityEvictionMonitor,
  getAuthorityEvictionMonitor,
  transportRelayProbe,
  peerLabel,
  PEER_PROBE_OP_KIND,
  DEFAULT_PROBE_FANOUT,
  type AuthorityEvictionMonitorOpts,
  type PresenceObservation,
} from './peer-eviction';

export {
  registerPeerProbeOp,
  buildPeerProbeHandler,
  defaultPeerLiveness,
  type PeerProbeResult,
  type PeerProbeDeps,
  type PeerLivenessCheck,
} from './peer-probe-op';

export { getAuthorityExemptKinds } from './authority-op-registry';

export { wirePeerEviction } from './eviction-wiring';

export {
  registerFileLockAuthorityOps,
  buildFileLockAuthorityHandlers,
  FILE_LOCK_OP_KINDS,
  type FileLockCoordinator,
  type FileLockAcquireParams,
  type FileLockReleaseParams,
  type FileLockQueueParams,
  type FileLockAcquireResult,
} from './file-lock-authority-ops';

export {
  registerAuthorityOp,
  registeredAuthorityOpKinds,
  handleAuthorityRpc,
  type AuthorityRpcEnvelope,
  type AuthorityOpHandler,
  type HandleAuthorityRpcResult,
  type HandleAuthorityRpcOpts,
} from './authority-op-registry';

export {
  HttpPeerRpcTransport,
  type PeerAddressResolver,
  type HttpPeerRpcTransportOpts,
} from './http-peer-rpc-transport';

export {
  wireAuthorityRpcTransport,
  configurePeerAddressResolver,
  resolvePeerAddress,
  PEER_ADDRESSES_ENV,
} from './transport-wiring';

export {
  makeAuthorityRpcSwarmTransport,
  AUTHORITY_RPC_PROTOCOL,
  type AuthorityRpcSwarmTransport,
  type AuthorityRpcSwarmTransportOpts,
  type AuthorityRpcDispatch,
} from './authority-rpc-swarm-transport';

export { CompositePeerRpcTransport } from './composite-peer-rpc-transport';
