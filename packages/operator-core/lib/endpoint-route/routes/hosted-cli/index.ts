/**
 * psu CLI sign-in and terminal access for Papercusp-hosted workspaces (WI-10002874, byoc D-412).
 *
 * A hosted workspace machine keeps an outbound connector to this control plane and never accepts
 * inbound connections, so a customer's psu cannot SSH to it. psu reaches it the way the portal's
 * Terminal tab does: a short-lived, single-use session ticket for one workspace, redeemed on the
 * connector socket. These routes are how a CLI earns that ticket.
 *
 * Sign-in is the device-authorization pattern (RFC 8628). The CLI asks for a device code, the
 * person opens the verification page in a browser that holds a hosted session and approves the
 * user code, and the CLI exchanges the approved code ONCE for a revocable bearer token. The token
 * carries identity only (user + organization). Every bearer request re-derives permissions from
 * the CURRENT membership, so removing someone from the organization cuts their CLI off at the next
 * request with no token bookkeeping.
 *
 * Bearer routes are `public` in the hosted allowlist for the same reason the connector routes
 * are: they authenticate with their own credential inside the handler, and a CLI bearer must
 * never enter the browser principal chain. The one browser route here (the approval decision) is
 * `authenticated` and goes through the hosted stack like every other browser mutation.
 */
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { defineTool, type RouteDefinition } from '@papercusp/tooldef/define-tool';
import type { HostedMembershipAuthorityReader } from '../../../auth/hosted-membership-authority';
import { isHostedPrincipal, type HostedPermission } from '../../../auth/hosted-principal';
import type { HostedPrincipalResolver } from '../../../auth/hosted-principal-resolver';
import { isHostedConnectorLive, type HostedWorkspaceConnectorGateway } from '../../hosted-workspace-connector';
import type { HostedCliStore, HostedCliToken } from './store';

export { PostgresHostedCliStore, type HostedCliStore } from './store';

export const HOSTED_CLI_ROUTES = [
  { method: 'POST', path: '/hosted/cli/device/code', access: 'public' },
  { method: 'GET', path: '/hosted/cli/device', access: 'public' },
  { method: 'POST', path: '/hosted/cli/device/decision', access: 'authenticated' },
  { method: 'POST', path: '/hosted/cli/device/token', access: 'public' },
  { method: 'GET', path: '/hosted/cli/workspaces', access: 'public' },
  { method: 'POST', path: '/hosted/cli/workspaces/:workspaceId/terminal', access: 'public' },
  { method: 'POST', path: '/hosted/cli/logout', access: 'public' },
] as const;

export const HOSTED_CLI_DEVICE_CODE_TTL_MS = 10 * 60_000;
export const HOSTED_CLI_POLL_INTERVAL_MS = 5_000;
export const HOSTED_CLI_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;

/** No vowels (no words) and none of 0/O/1/I, so a code read aloud or retyped survives. */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';
const USER_CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const DEVICE_CODE_RE = /^pdc_[A-Za-z0-9_-]{43}$/;
const CLI_BEARER_RE = /^Bearer\s+(pct_[A-Za-z0-9_-]{43})$/;
const SESSION_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

const HOSTED_VIEW_AUTH = { capabilities: ['workspace:view'], kind: ['user'], trust: ['verified'] } as const;

export interface HostedCliRouteDependencies {
  /** Exact externally reachable HTTPS origin, e.g. https://app.papercusp.com. */
  readonly publicOrigin: string;
  readonly controlPlaneWorkspaceId: string;
  readonly store: HostedCliStore;
  readonly membershipAuthority: Pick<HostedMembershipAuthorityReader, 'resolveActive'>;
  readonly connectorGateway: Pick<HostedWorkspaceConnectorGateway, 'issueSessionTicket'>;
  /** The page route looks the browser session up itself so it can send a signed-out visitor to sign-in. */
  readonly resolvePrincipal: HostedPrincipalResolver;
  readonly clock?: () => Date;
  readonly randomBytes?: (size: number) => Uint8Array;
}

type AnyRoute = RouteDefinition<any>;

const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function jsonError(code: string, status: number, extra: Record<string, unknown> = {}): Response {
  return Response.json({ ok: false, error: { code, ...extra } }, { status, headers: { 'cache-control': 'no-store' } });
}

/** RFC 8628 §3.5 token-endpoint errors: a 400 whose body names the state. */
function deviceTokenError(error: string): Response {
  return Response.json({ ok: false, error }, { status: 400, headers: { 'cache-control': 'no-store' } });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The name a device-code client gets when it sends no usable label. */
export const DEFAULT_CLIENT_LABEL = 'psu';

/**
 * A display-only label: printable, single-line, bounded. Never an identifier.
 * Returns '' when nothing printable is left, so a route that requires a label can refuse it;
 * a route that wants a fallback name applies DEFAULT_CLIENT_LABEL itself.
 */
export function sanitizeClientLabel(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return text.slice(0, 120).trim();
}

/** Accept a user code however it was typed: case, spacing and the dash are all optional. */
export function normalizeUserCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (compact.length !== 8) return null;
  const code = `${compact.slice(0, 4)}-${compact.slice(4)}`;
  return USER_CODE_RE.test(code) ? code : null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * The approval page. Server-rendered on purpose: it must work whether or not the portal SPA is
 * healthy, and an approve button must never be frameable (clickjacking would turn a visit into a
 * signed-in CLI for whoever holds the device code).
 */
function htmlPage(title: string, body: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Papercusp</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}
main{max-width:28rem;padding:2rem;border:1px solid color-mix(in srgb,CanvasText 15%,transparent);border-radius:12px}
h1{font-size:1.25rem;margin:0 0 1rem}p{line-height:1.5;margin:0 0 1rem}
code{font-size:1.5rem;letter-spacing:.15em;font-weight:600}
.row{display:flex;gap:.75rem;margin-top:1.5rem}
button,input{font:inherit;padding:.5rem 1rem;border-radius:8px;border:1px solid color-mix(in srgb,CanvasText 30%,transparent);background:Canvas;color:CanvasText}
button.primary{background:#4f46e5;border-color:#4f46e5;color:#fff}
input{text-transform:uppercase;letter-spacing:.15em}
</style></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      // NOT 'no-referrer' (WI-10003612): the Fetch spec serializes the Origin of a non-GET
      // navigation as the literal "null" under a no-referrer policy, so the approve form's POST
      // reached the decision route with `Origin: null` and every browser approval was refused as
      // cross_origin_blocked. 'same-origin' still withholds the user_code URL from other origins.
      'referrer-policy': 'same-origin',
    },
  });
}

/**
 * CSRF guard for the browser form post. The exact portal Origin is the normal case. A browser
 * whose own privacy setting forces a no-referrer policy still sends `Origin: null`; Fetch Metadata
 * (`Sec-Fetch-Site`, browser-set and not forgeable by a page) then proves the post came from a
 * same-origin document. A cross-site or sandboxed-opaque initiator reports `cross-site`.
 */
function isSameOriginFormPost(headers: Headers, origin: string): boolean {
  const requestOrigin = headers.get('origin');
  if (requestOrigin === origin) return true;
  return requestOrigin === 'null' && headers.get('sec-fetch-site') === 'same-origin';
}

function randomString(random: (size: number) => Uint8Array, size: number): string {
  const bytes = Buffer.from(random(size));
  if (bytes.byteLength !== size) throw new Error('hosted_cli_entropy_source_returned_wrong_size');
  return bytes.toString('base64url');
}

function randomUserCode(random: (size: number) => Uint8Array): string {
  const bytes = Buffer.from(random(8));
  let code = '';
  for (const byte of bytes) code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

interface CliCaller {
  readonly token: HostedCliToken;
  readonly permissions: ReadonlySet<HostedPermission>;
}

export function createHostedCliRoutes(deps: HostedCliRouteDependencies): ReadonlyArray<AnyRoute> {
  const origin = new URL(deps.publicOrigin).origin;
  const clock = deps.clock ?? (() => new Date());
  const random = deps.randomBytes ?? ((size: number) => nodeRandomBytes(size));

  /** Display label for a sign-in's organization; a lookup failure degrades to no label, never to an error. */
  async function organizationLabel(organizationId: string): Promise<string | null> {
    try {
      return await deps.store.organizationName(organizationId);
    } catch {
      return null;
    }
  }
  const devicePagePath = '/api/hosted/cli/device';

  async function authenticate(request: Request): Promise<CliCaller | Response> {
    const bearer = CLI_BEARER_RE.exec(request.headers.get('authorization')?.trim() ?? '')?.[1];
    if (!bearer) return jsonError('cli_token_required', 401);
    let token: HostedCliToken | null;
    try {
      token = await deps.store.resolveToken(sha256Hex(bearer), clock());
    } catch {
      return jsonError('authority_unavailable', 503);
    }
    if (!token) return jsonError('cli_token_invalid', 401);
    let membership;
    try {
      membership = await deps.membershipAuthority.resolveActive({
        userId: token.userId,
        organizationId: token.organizationId,
      });
    } catch {
      return jsonError('authority_unavailable', 503);
    }
    if (!membership || membership.permissions.size === 0) return jsonError('membership_not_active', 403);
    return { token, permissions: membership.permissions as ReadonlySet<HostedPermission> };
  }

  const deviceCode = defineTool({
    method: 'POST',
    path: '/hosted/cli/device/code',
    auth: 'public',
    async handler(request) {
      const body = (await readJson(request)) ?? {};
      const clientLabel = sanitizeClientLabel(body.clientLabel) || DEFAULT_CLIENT_LABEL;
      const now = clock();
      const expiresAt = new Date(now.getTime() + HOSTED_CLI_DEVICE_CODE_TTL_MS);
      const code = `pdc_${randomString(random, 32)}`;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const userCode = randomUserCode(random);
        let created: boolean;
        try {
          created = await deps.store.createGrant({
            deviceCodeHash: sha256Hex(code),
            userCode,
            clientLabel,
            createdAt: now,
            expiresAt,
          });
        } catch {
          return jsonError('device_code_unavailable', 503);
        }
        if (!created) continue; // a live user code collided; draw another
        const verificationUri = `${origin}${devicePagePath}`;
        return Response.json(
          {
            ok: true,
            deviceCode: code,
            userCode,
            verificationUri,
            verificationUriComplete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
            expiresIn: Math.round(HOSTED_CLI_DEVICE_CODE_TTL_MS / 1000),
            interval: Math.round(HOSTED_CLI_POLL_INTERVAL_MS / 1000),
          },
          { headers: { 'cache-control': 'no-store' } },
        );
      }
      return jsonError('device_code_unavailable', 503);
    },
  });

  const devicePage = defineTool({
    method: 'GET',
    path: '/hosted/cli/device',
    auth: 'public',
    async handler(request) {
      const url = new URL(request.url);
      const rawCode = url.searchParams.get('user_code');
      const userCode = normalizeUserCode(rawCode);
      const resolution = await deps.resolvePrincipal(request.headers).catch(() => null);
      if (!resolution?.ok) {
        const returnTo = userCode ? `${devicePagePath}?user_code=${encodeURIComponent(userCode)}` : devicePagePath;
        const signIn = new URL('/api/hosted/auth/sign-in', origin);
        signIn.searchParams.set('returnTo', returnTo);
        return new Response(null, { status: 303, headers: { location: signIn.toString(), 'cache-control': 'no-store' } });
      }
      if (!userCode) {
        const invalid = rawCode ? '<p>That code is not in the right form. It looks like <code>ABCD-EFGH</code>.</p>' : '';
        return htmlPage(
          'Sign in to psu',
          `${invalid}<p>Enter the code psu is showing in your terminal.</p>
<form method="get" action="${devicePagePath}"><input name="user_code" autocomplete="off" autofocus maxlength="12" placeholder="ABCD-EFGH" required>
<div class="row"><button class="primary" type="submit">Continue</button></div></form>`,
        );
      }
      const grant = await deps.store.findPendingGrant(userCode, clock()).catch(() => null);
      if (!grant) {
        return htmlPage(
          'Code not found',
          '<p>This code has expired, was already used, or does not exist.</p><p>Run <b>psu --connect-login</b> again to get a new one.</p>',
          404,
        );
      }
      return htmlPage(
        'Allow psu to use your workspaces?',
        `<p>psu on <b>${escapeHtml(grant.clientLabel)}</b> is asking to sign in as you. Check that your terminal shows this code:</p>
<p><code>${escapeHtml(grant.userCode)}</code></p>
<p>If you allow it, psu can open terminals on the workspaces your organization role lets you operate, until you sign it out.</p>
<form method="post" action="/api/hosted/cli/device/decision"><input type="hidden" name="user_code" value="${escapeHtml(grant.userCode)}">
<div class="row"><button class="primary" type="submit" name="decision" value="approve">Allow</button>
<button type="submit" name="decision" value="deny">Deny</button></div></form>`,
      );
    },
  });

  const deviceDecision = defineTool({
    method: 'POST',
    path: '/hosted/cli/device/decision',
    auth: HOSTED_VIEW_AUTH,
    async handler(request, ctx) {
      // A form post always carries Origin; demanding the portal origin is the CSRF guard.
      if (!isSameOriginFormPost(request.headers, origin)) return jsonError('cross_origin_blocked', 403);
      if (!ctx.principal || !isHostedPrincipal(ctx.principal)) return jsonError('hosted_principal_required', 401);
      const principal = ctx.principal;
      const isForm = (request.headers.get('content-type') ?? '').includes('application/x-www-form-urlencoded');
      let fields: Record<string, unknown>;
      if (isForm) {
        fields = Object.fromEntries(new URLSearchParams(await request.text()));
      } else {
        const parsed = await readJson(request);
        if (!parsed) return jsonError('invalid_json', 400);
        fields = parsed;
      }
      const userCode = normalizeUserCode(fields.user_code ?? fields.userCode);
      const decision = fields.decision === 'approve' ? 'approved' : fields.decision === 'deny' ? 'denied' : null;
      if (!userCode || !decision) return jsonError('invalid_decision', 400);
      let decided: boolean;
      try {
        decided = await deps.store.decideGrant({
          userCode,
          decision,
          userId: principal.userId,
          organizationId: principal.activeOrganizationId,
          at: clock(),
        });
      } catch {
        return jsonError('authority_unavailable', 503);
      }
      if (!isForm) return decided ? Response.json({ ok: true, decision }) : jsonError('grant_not_pending', 404);
      if (!decided) {
        return htmlPage('Code not found', '<p>This code has expired or was already used. Run <b>psu --connect-login</b> again.</p>', 404);
      }
      return decision === 'approved'
        ? htmlPage('psu is signed in', '<p>You can close this tab and go back to your terminal.</p>')
        : htmlPage('Sign-in denied', '<p>psu was not signed in. You can close this tab.</p>');
    },
  });

  const deviceToken = defineTool({
    method: 'POST',
    path: '/hosted/cli/device/token',
    auth: 'public',
    async handler(request) {
      const body = await readJson(request);
      const code = typeof body?.deviceCode === 'string' ? body.deviceCode : '';
      if (!DEVICE_CODE_RE.test(code)) return deviceTokenError('invalid_grant');
      const now = clock();
      const token = `pct_${randomString(random, 32)}`;
      let result;
      try {
        result = await deps.store.exchangeGrant({
          deviceCodeHash: sha256Hex(code),
          now,
          minPollIntervalMs: HOSTED_CLI_POLL_INTERVAL_MS - 1_000,
          token: {
            id: `hct_${randomString(random, 16)}`,
            tokenHash: sha256Hex(token),
            expiresAt: new Date(now.getTime() + HOSTED_CLI_TOKEN_TTL_MS),
          },
        });
      } catch {
        return jsonError('authority_unavailable', 503);
      }
      switch (result.status) {
        case 'issued':
          return Response.json(
            {
              ok: true,
              accessToken: token,
              tokenType: 'Bearer',
              tokenId: result.token.id,
              organizationId: result.token.organizationId,
              // A label only: the grant is already consumed, so a failed lookup must not lose the token.
              organizationName: await organizationLabel(result.token.organizationId),
              userId: result.token.userId,
              expiresAt: result.token.expiresAt.toISOString(),
            },
            { headers: { 'cache-control': 'no-store' } },
          );
        case 'pending':
          return deviceTokenError('authorization_pending');
        case 'slow_down':
          return deviceTokenError('slow_down');
        case 'denied':
          return deviceTokenError('access_denied');
        case 'expired':
          return deviceTokenError('expired_token');
        default:
          return deviceTokenError('invalid_grant');
      }
    },
  });

  const workspaces = defineTool({
    method: 'GET',
    path: '/hosted/cli/workspaces',
    auth: 'public',
    async handler(request) {
      const caller = await authenticate(request);
      if (caller instanceof Response) return caller;
      let rows;
      try {
        rows = await deps.store.listWorkspaces(caller.token.organizationId);
      } catch {
        return jsonError('authority_unavailable', 503);
      }
      const now = clock();
      return Response.json(
        {
          ok: true,
          organizationId: caller.token.organizationId,
          organizationName: await organizationLabel(caller.token.organizationId),
          userId: caller.token.userId,
          permissions: [...caller.permissions].sort(),
          workspaces: rows.map((row) => ({
            id: row.id,
            displayName: row.displayName,
            state: row.state,
            hostId: row.hostId,
            // P-001: a live link, not just an active row. The relay stamps heartbeat_at on
            // every pong, so an active row with a stale stamp is a machine whose link died.
            reachable: isHostedConnectorLive(row.connector, now),
            connectorHeartbeatAt: row.connector?.heartbeatAt?.toISOString() ?? null,
          })),
        },
        { headers: { 'cache-control': 'no-store' } },
      );
    },
  });

  const terminal = defineTool({
    method: 'POST',
    path: '/hosted/cli/workspaces/:workspaceId/terminal',
    auth: 'public',
    async handler(request, ctx) {
      const caller = await authenticate(request);
      if (caller instanceof Response) return caller;
      if (!caller.permissions.has('workspace:operate')) {
        return jsonError('forbidden', 403, { missingPermission: 'workspace:operate' });
      }
      const workspaceId = String(ctx.params.workspaceId ?? '').trim();
      const body = (await readJson(request)) ?? {};
      const sessionKey = body.session === undefined ? randomString(random, 12) : body.session;
      if (typeof sessionKey !== 'string' || !SESSION_KEY_RE.test(sessionKey)) return jsonError('invalid_session_key', 400);
      let rows;
      try {
        rows = await deps.store.listWorkspaces(caller.token.organizationId);
      } catch {
        return jsonError('authority_unavailable', 503);
      }
      // Scoped by the TOKEN's organization: a workspace id from another tenant is simply absent.
      const workspace = rows.find((row) => row.id === workspaceId);
      if (!workspace?.hostId) return jsonError('workspace_not_found', 404);
      const connector = workspace.connector;
      if (!connector || !isHostedConnectorLive(connector, clock())) {
        // Refuse here rather than mint a ticket the relay can only answer with 4411.
        return jsonError('workspace_not_reachable', 409, {
          connectorHeartbeatAt: connector?.heartbeatAt?.toISOString() ?? null,
        });
      }
      // Its own hosted session id gives psu its own shell on the machine (the host keys PTYs by
      // user + session), separate from the portal's Terminal tab; reusing the key within the
      // host's idle window reattaches to the same shell.
      const hostedSessionId = `cli.${caller.token.id}.${sessionKey}`;
      let issued;
      try {
        issued = await deps.connectorGateway.issueSessionTicket({
          controlPlaneWorkspaceId: deps.controlPlaneWorkspaceId,
          organizationId: caller.token.organizationId,
          customerWorkspaceId: workspace.id,
          hostId: workspace.hostId,
          routeLabel: connector.routeLabel,
          generation: connector.generation,
          state: 'active',
          transport: 'websocket',
          userId: caller.token.userId,
          hostedSessionId,
          audience: 'workspace-operator',
        });
      } catch {
        return jsonError('ticket_unavailable', 503);
      }
      if (!issued) return jsonError('workspace_not_reachable', 409);
      const socketUrl = new URL('/api/hosted/connectors/socket', origin);
      socketUrl.protocol = 'wss:';
      socketUrl.searchParams.set('ticket', issued.ticket);
      return Response.json(
        {
          ok: true,
          socketUrl: socketUrl.toString(),
          session: sessionKey,
          expiresAt: issued.binding.expiresAt.toISOString(),
        },
        { headers: { 'cache-control': 'no-store' } },
      );
    },
  });

  const logout = defineTool({
    method: 'POST',
    path: '/hosted/cli/logout',
    auth: 'public',
    async handler(request) {
      const bearer = CLI_BEARER_RE.exec(request.headers.get('authorization')?.trim() ?? '')?.[1];
      if (!bearer) return jsonError('cli_token_required', 401);
      try {
        const token = await deps.store.resolveToken(sha256Hex(bearer), clock());
        if (token) await deps.store.revokeToken(token.id, 'cli_logout', clock());
      } catch {
        return jsonError('authority_unavailable', 503);
      }
      // Idempotent: an unknown or already-revoked token is already signed out.
      return Response.json({ ok: true });
    },
  });

  return [deviceCode, devicePage, deviceDecision, deviceToken, workspaces, terminal, logout];
}
