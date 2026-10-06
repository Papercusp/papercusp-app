/**
 * hosted-relay-confidentiality-registry.ts — the P-001 census of what the hosted
 * relays carry (plan hosted-byoc-confidentiality-correction-2026-10-02).
 *
 * One typed registry that classifies, BY SENSITIVITY (not by table or file), every
 * frame type on the four hosted content planes — workspace-session (PTY + files),
 * operator-http, app-http and desktop-viewer — plus the relay envelope itself, and
 * every field the control plane persists, logs or emits about workspace traffic.
 *
 *  - `content`: customer content. For a `byoc` workspace the control plane must
 *    never see it in plaintext (D-001/D-003). The sealed channel (P-004) carries it
 *    opaquely; the allowlist enforcement (P-005) refuses to persist or log it.
 *  - `control`: allowlisted control metadata the control plane may route on and
 *    record. A control frame can still carry a content-bearing FIELD; those are
 *    listed in `contentFields` and must be stripped or sealed by P-005.
 *
 * `hosted-relay-confidentiality-registry.test.ts` pins this against source: a new
 * frame type literal or a new audit-event field that is not classified here fails
 * the build. Census method and findings: see `PLAINTEXT_CONSUMERS` below.
 */

export type HostedRelayPlane = 'envelope' | 'workspace-session' | 'operator-http' | 'app-http' | 'desktop-viewer';
export type HostedRelaySensitivity = 'content' | 'control';

export interface HostedRelayFrameClass {
  planes: readonly HostedRelayPlane[];
  sensitivity: HostedRelaySensitivity;
  /** Fields of a `control` frame that nonetheless carry customer content. */
  contentFields?: readonly string[];
  note: string;
}

export const HOSTED_RELAY_FRAME_REGISTRY: Readonly<Record<string, HostedRelayFrameClass>> = {
  // ── Envelope (broker ⇄ connector ⇄ browser routing) ──
  relay: { planes: ['envelope'], sensitivity: 'content', note: 'wrapper; `payload` is an inner frame and inherits its class — opaque under the sealed channel' },
  'relay.open': { planes: ['envelope'], sensitivity: 'control', note: 'channel id, kind, role, session/desktop ids' },
  'relay.close': { planes: ['envelope'], sensitivity: 'control', note: 'channel id + reason code' },
  'relay.role': { planes: ['envelope'], sensitivity: 'control', note: 'controller/observer flip' },
  bound: { planes: ['envelope'], sensitivity: 'control', note: 'connector binding (org/workspace/host/generation)' },
  'session.bound': { planes: ['envelope'], sensitivity: 'control', note: 'browser channel binding' },
  'session.denied': { planes: ['envelope'], sensitivity: 'control', note: 'refusal reason + requestType' },
  'session.role': { planes: ['envelope'], sensitivity: 'control', note: 'role notification' },
  'session.claim-control': { planes: ['envelope'], sensitivity: 'control', note: 'takeover request' },
  'session.detach': { planes: ['envelope'], sensitivity: 'control', note: 'browser detach' },
  'membership.report': { planes: ['envelope'], sensitivity: 'control', note: 'host membership/liveness report' },
  'operation.error': { planes: ['workspace-session', 'desktop-viewer'], sensitivity: 'control', contentFields: ['message'], note: 'error code is control; free-text message can echo paths/output' },
  // ── workspace-session: PTY ──
  'pty.input': { planes: ['workspace-session'], sensitivity: 'content', note: 'keystrokes' },
  'pty.output': { planes: ['workspace-session'], sensitivity: 'content', note: 'terminal output' },
  'pty.snapshot': { planes: ['workspace-session'], sensitivity: 'content', note: 'scrollback replay' },
  'pty.ready': { planes: ['workspace-session'], sensitivity: 'control', note: 'session key + role; no output' },
  'pty.exit': { planes: ['workspace-session'], sensitivity: 'control', note: 'exit code/signal' },
  'pty.resize': { planes: ['workspace-session'], sensitivity: 'control', note: 'cols/rows' },
  'pty.signal': { planes: ['workspace-session'], sensitivity: 'control', note: 'signal name' },
  'pty.kill': { planes: ['workspace-session'], sensitivity: 'control', note: 'kill request' },
  // ── workspace-session: files ──
  'file.list': { planes: ['workspace-session'], sensitivity: 'content', note: 'directory path requested' },
  'file.read': { planes: ['workspace-session'], sensitivity: 'content', note: 'path' },
  'file.write': { planes: ['workspace-session'], sensitivity: 'content', note: 'path + bytes' },
  'file.upload': { planes: ['workspace-session'], sensitivity: 'content', note: 'path + bytes' },
  'file.download': { planes: ['workspace-session'], sensitivity: 'content', note: 'path' },
  'file.result': { planes: ['workspace-session'], sensitivity: 'content', note: 'listings / file bytes' },
  'file.progress': { planes: ['workspace-session'], sensitivity: 'content', note: 'carries path alongside byte counts' },
  // ── operator-http + app-http (shared wire, hosted-operator-http.ts) ──
  'http.request': { planes: ['operator-http', 'app-http'], sensitivity: 'content', note: 'method, path, headers, body' },
  'http.response': { planes: ['operator-http', 'app-http'], sensitivity: 'content', note: 'status + headers' },
  'http.body': { planes: ['operator-http', 'app-http'], sensitivity: 'content', note: 'body chunks' },
  'http.end': { planes: ['operator-http', 'app-http'], sensitivity: 'control', note: 'stream end' },
  'http.abort': { planes: ['operator-http', 'app-http'], sensitivity: 'control', note: 'client abort' },
  'http.ready': { planes: ['operator-http'], sensitivity: 'control', note: 'channel ready' },
  'http.error': { planes: ['operator-http', 'app-http'], sensitivity: 'control', contentFields: ['message'], note: 'code is control; message may echo a path' },
  // ── app-http: key mint + OAuth token relay ──
  'mint.request': { planes: ['app-http'], sensitivity: 'content', note: 'scopes + approver; yields a secret' },
  'mint.issued': { planes: ['app-http'], sensitivity: 'content', note: 'carries a pcapp_ secret' },
  'mint.error': { planes: ['app-http'], sensitivity: 'control', note: 'error code' },
  'token.request': { planes: ['app-http'], sensitivity: 'content', note: 'client credentials' },
  'token.answer': { planes: ['app-http'], sensitivity: 'content', note: 'carries a pcat_ token' },
  // ── desktop-viewer ──
  open: { planes: ['desktop-viewer'], sensitivity: 'control', note: 'viewer socket open' },
  'desktop.start': { planes: ['desktop-viewer'], sensitivity: 'control', note: 'desktop id + mode' },
  'desktop.start.result': { planes: ['desktop-viewer'], sensitivity: 'control', note: 'start outcome' },
  'desktop.ready': { planes: ['desktop-viewer'], sensitivity: 'control', note: '`action` read by the broker audit' },
  'desktop.data': { planes: ['desktop-viewer'], sensitivity: 'content', note: 'VNC framebuffer + input bytes' },
  'desktop.roster': { planes: ['desktop-viewer'], sensitivity: 'control', note: 'roster request' },
  'desktop.roster.result': { planes: ['desktop-viewer'], sensitivity: 'content', note: 'session titles/labels' },
  'desktop.thumbnail': { planes: ['desktop-viewer'], sensitivity: 'control', note: 'thumbnail request' },
  'desktop.thumbnail.result': { planes: ['desktop-viewer'], sensitivity: 'content', note: 'screen image' },
};

/** Control-plane fields recorded about workspace traffic, by sink. */
export interface HostedControlPlaneFieldClass {
  sensitivity: HostedRelaySensitivity;
  note: string;
}

export const HOSTED_CONTROL_PLANE_FIELD_REGISTRY: Readonly<Record<string, Readonly<Record<string, HostedControlPlaneFieldClass>>>> = {
  /** Broker audit (`HostedWorkspaceSessionAuditEvent`, hosted-workspace-session.ts). */
  'broker-audit': {
    action: { sensitivity: 'control', note: 'lifecycle action OR the relayed frame type (one row per client frame — timing side channel, not content)' },
    controlPlaneWorkspaceId: { sensitivity: 'control', note: 'tenant id' },
    organizationId: { sensitivity: 'control', note: 'tenant id' },
    customerWorkspaceId: { sensitivity: 'control', note: 'tenant id' },
    hostId: { sensitivity: 'control', note: 'host id' },
    generation: { sensitivity: 'control', note: 'binding generation' },
    userId: { sensitivity: 'control', note: 'principal' },
    hostedSessionId: { sensitivity: 'control', note: 'session id' },
    channelId: { sensitivity: 'control', note: 'channel id' },
    detail: { sensitivity: 'control', note: 'reason code / desktop id / reported mode — never payload' },
  },
  /** Host-side audit (`HostedHostAuditEvent`) — lands in the host DB, not the control plane. */
  'host-audit': {
    action: { sensitivity: 'control', note: 'action' },
    organizationId: { sensitivity: 'control', note: 'tenant id' },
    customerWorkspaceId: { sensitivity: 'control', note: 'tenant id' },
    hostId: { sensitivity: 'control', note: 'host id' },
    generation: { sensitivity: 'control', note: 'generation' },
    userId: { sensitivity: 'control', note: 'principal' },
    hostedSessionId: { sensitivity: 'control', note: 'session id' },
    channelId: { sensitivity: 'control', note: 'channel id' },
    detail: { sensitivity: 'control', note: 'code' },
  },
  /** Portal app-relay audit (`HostedAppRelayAuditEvent`). */
  'app-relay-audit': {
    action: { sensitivity: 'control', note: 'refused | request' },
    customerWorkspaceId: { sensitivity: 'control', note: 'tenant id' },
    detail: { sensitivity: 'control', note: 'refusal code or `<method> <status>`; never path/header/key/body' },
  },
};

/**
 * Census finding: every place the CONTROL PLANE reads a relayed payload today.
 * D-003 says the relay refuses plaintext byoc content; any entry with
 * `readsContent: true` is a consumer that P-004/P-005 must relocate or remove.
 */
export const PLAINTEXT_CONSUMERS: ReadonlyArray<{ site: string; reads: string; readsContent: boolean; disposition: string }> = [
  { site: 'hosted-workspace-session.ts payloadType()', reads: 'inner frame `type`', readsContent: false, disposition: 'needs the frame type in clear: keep `type` outside the sealed box (control metadata)' },
  { site: 'hosted-workspace-session.ts auditDesktopReady()', reads: '`desktop.ready.action`', readsContent: false, disposition: 'control metadata; keep in clear or derive from broker role alone' },
  { site: 'hosted-app-relay.ts handleHostedAppRelay() (portal)', reads: 'Authorization (app-key shape), URL path, body size, webhook path/signature headers', readsContent: true, disposition: 'app-http is a third-party-app ingress the portal terminates by design — see plan Decision on app-http scope' },
  { site: 'hosted-app-relay.ts portal token relay', reads: 'client-credentials request + pcat_ token answer body', readsContent: true, disposition: 'same app-http Decision' },
];
