/**
 * The user's own tunnel — pure configuration helpers
 * (external-app-access-to-workspaces-2026-09-29 P-009, D-001, D-020).
 *
 * A local install reaches outside apps through a tunnel the USER owns. The setup wizard automates
 * Cloudflare Tunnel in the user's own Cloudflare account; any other outbound tunnel (Tailscale
 * Funnel, ngrok, …) is pointed at the same place by hand. That place is always the
 * external-ingress listener (P-004): a loopback port where every request runs as external ingress,
 * so no header can reach local trust, and where only the MCP OAuth surface is served (D-020).
 *
 * Nothing here does I/O. The cloudflared ingress this module builds is the contract R-21 checks:
 * the tunnel forwards to the external-ingress listener's port, never to the operator's own port,
 * and it never rewrites Host (D-020: the OAuth metadata is built from the public Host).
 */

/** Thrown for input the user can fix (a bad hostname, a bad port). */
export class OwnTunnelInputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OwnTunnelInputError';
    this.code = code;
  }
}

export interface CloudflaredIngressRule {
  readonly hostname?: string;
  readonly service: string;
}

/** The `config` body of `PUT /accounts/{a}/cfd_tunnel/{t}/configurations`. */
export interface CloudflaredIngressConfig {
  readonly ingress: readonly CloudflaredIngressRule[];
}

/** The catch-all rule cloudflared requires last: anything but our hostname gets a plain 404. */
export const CLOUDFLARED_CATCH_ALL_SERVICE = 'http_status:404';

/** The subdomain label the wizard suggests. */
export const OWN_TUNNEL_DEFAULT_LABEL = 'papercusp';

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function assertPort(port: number, what = 'port'): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new OwnTunnelInputError('invalid_port', `${what} must be an integer between 1 and 65535`);
  }
  return port;
}

/** The origin cloudflared forwards to: the external-ingress listener on loopback. */
export function ingressServiceUrl(ingressPort: number): string {
  return `http://127.0.0.1:${assertPort(ingressPort, 'ingress port')}`;
}

/**
 * Normalize a hostname the user typed: lowercase, no scheme, no path, no port, no trailing dot.
 * Refuses anything that is not a multi-label DNS name.
 */
export function normalizeHostname(input: string): string {
  let h = String(input ?? '').trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  h = h.split(/[/?#]/, 1)[0] ?? '';
  h = h.replace(/:\d+$/, '').replace(/\.$/, '');
  const labels = h.split('.');
  if (h.length === 0 || h.length > 253 || labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) {
    throw new OwnTunnelInputError('invalid_hostname', `"${input}" is not a valid hostname (for example papercusp.example.com)`);
  }
  if (/^\d+$/.test(labels[labels.length - 1]!)) {
    throw new OwnTunnelInputError('invalid_hostname', `"${input}" is an IP address, not a hostname`);
  }
  return h;
}

/** Normalize a single DNS label (the part the user picks in front of their zone). */
export function normalizeLabel(input: string): string {
  const l = String(input ?? '').trim().toLowerCase();
  if (!LABEL_RE.test(l)) {
    throw new OwnTunnelInputError('invalid_label', `"${input}" is not a valid DNS label (letters, digits and hyphens)`);
  }
  return l;
}

/** True when `hostname` is the zone apex or a name under it. */
export function hostnameInZone(hostname: string, zoneName: string): boolean {
  const z = zoneName.toLowerCase().replace(/\.$/, '');
  return hostname === z || hostname.endsWith(`.${z}`);
}

/**
 * The zone names a hostname could belong to, longest first, down to the registrable-looking
 * two-label suffix: `a.b.example.com` → `a.b.example.com`, `b.example.com`, `example.com`.
 */
export function zoneCandidates(hostname: string): string[] {
  const labels = normalizeHostname(hostname).split('.');
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'));
  return out;
}

/**
 * The cloudflared ingress for the user's tunnel (R-21): the chosen hostname goes to the
 * external-ingress listener on loopback; everything else gets a 404. No `originRequest` is set,
 * so cloudflared passes the public Host through unchanged (D-020 forbids `httpHostHeader`).
 */
export function buildCloudflaredIngress(input: { hostname: string; ingressPort: number }): CloudflaredIngressConfig {
  const hostname = normalizeHostname(input.hostname);
  return {
    ingress: [
      { hostname, service: ingressServiceUrl(input.ingressPort) },
      { service: CLOUDFLARED_CATCH_ALL_SERVICE },
    ],
  };
}

/** The CNAME target Cloudflare routes to a tunnel. */
export function tunnelCnameTarget(tunnelId: string): string {
  return `${tunnelId}.cfargotunnel.com`;
}

/** The tunnel name in the user's account: stable per install, recognisably ours. */
export function tunnelNameFor(installLabel: string): string {
  const slug = String(installLabel ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `papercusp-${slug || 'local'}`;
}

/** What `cloudflared tunnel login` leaves behind: the zone the user picked, and an API token. */
export interface ArgoTunnelLogin {
  readonly accountId: string;
  readonly zoneId: string;
  readonly apiToken: string;
}

const ARGO_BLOCK_RE = /-----BEGIN ARGO TUNNEL TOKEN-----([\s\S]*?)-----END ARGO TUNNEL TOKEN-----/;

/**
 * Parse the `ARGO TUNNEL TOKEN` block of the cert.pem that `cloudflared tunnel login` writes. The
 * block is base64 JSON `{ zoneID, accountID, apiToken }`: the zone the user chose on the Cloudflare
 * page, its account, and an API token that can create tunnels and DNS records there. Returns null
 * when the block is missing or incomplete.
 */
export function parseArgoTunnelCert(pem: string): ArgoTunnelLogin | null {
  const m = ARGO_BLOCK_RE.exec(String(pem ?? ''));
  if (!m) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof o[k] === 'string' && (o[k] as string).length > 0) return o[k] as string;
    return null;
  };
  const accountId = pick('accountID', 'accountId', 'account_id');
  const zoneId = pick('zoneID', 'zoneId', 'zone_id');
  const apiToken = pick('apiToken', 'api_token');
  return accountId && zoneId && apiToken ? { accountId, zoneId, apiToken } : null;
}

const LOGIN_URL_RE = /https:\/\/dash\.cloudflare\.com\/argotunnel\?[^\s"'<>]+/;

/** The sign-in URL `cloudflared tunnel login` prints, or null if it has not printed it yet. */
export function parseLoginUrl(output: string): string | null {
  const m = LOGIN_URL_RE.exec(String(output ?? ''));
  return m ? m[0] : null;
}

/** The public MCP endpoint an outside app uses once the tunnel is up. */
export function publicMcpUrl(hostname: string): string {
  return `https://${normalizeHostname(hostname)}/api/mcp`;
}
