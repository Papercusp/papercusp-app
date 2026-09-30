/**
 * Provision and remove the user's own Cloudflare Tunnel (external-app-access P-009, D-001, D-020).
 *
 * Idempotent: re-running with the same install finds the tunnel it created before (by name) and
 * the CNAME it wrote before (by target), so a half-finished setup resumes instead of duplicating.
 * It never overwrites a DNS record it did not create: a hostname already in use for anything else
 * is refused with `hostname_taken`, and the user picks another name.
 */
import {
  CloudflareApiError,
  type CloudflareApi,
  type CloudflareZone,
} from './cloudflare-api';
import {
  OwnTunnelInputError,
  buildCloudflaredIngress,
  hostnameInZone,
  normalizeHostname,
  tunnelCnameTarget,
  zoneCandidates,
} from './config';

export interface ProvisionInput {
  readonly accountId: string;
  /** The zone `cloudflared tunnel login` returned; omitted when the user pasted a token. */
  readonly zoneId?: string | null;
  readonly hostname: string;
  readonly ingressPort: number;
  readonly tunnelName: string;
}

export interface ProvisionedTunnel {
  readonly accountId: string;
  readonly zoneId: string;
  readonly zoneName: string;
  readonly hostname: string;
  readonly tunnelId: string;
  readonly tunnelName: string;
  readonly dnsRecordId: string;
  readonly runToken: string;
}

async function resolveZone(api: CloudflareApi, hostname: string, zoneId?: string | null): Promise<CloudflareZone> {
  if (zoneId) {
    const zone = await api.getZone(zoneId);
    if (!hostnameInZone(hostname, zone.name)) {
      throw new OwnTunnelInputError(
        'hostname_outside_zone',
        `${hostname} is not in ${zone.name}, the zone you picked when signing in to Cloudflare`,
      );
    }
    return zone;
  }
  for (const candidate of zoneCandidates(hostname)) {
    const zone = await api.findZoneByName(candidate);
    if (zone) return zone;
  }
  throw new OwnTunnelInputError('zone_not_found', `no zone in this Cloudflare account contains ${hostname}`);
}

export async function provisionCloudflareTunnel(api: CloudflareApi, input: ProvisionInput): Promise<ProvisionedTunnel> {
  const hostname = normalizeHostname(input.hostname);
  const zone = await resolveZone(api, hostname, input.zoneId);

  const existing = (await api.listTunnelsByName(input.accountId, input.tunnelName)).find((t) => !t.deleted_at);
  const tunnel = existing ?? (await api.createTunnel(input.accountId, input.tunnelName));

  await api.putTunnelConfig(
    input.accountId,
    tunnel.id,
    buildCloudflaredIngress({ hostname, ingressPort: input.ingressPort }),
  );

  const target = tunnelCnameTarget(tunnel.id);
  const records = await api.listDnsRecords(zone.id, hostname);
  const ours = records.find((r) => r.type === 'CNAME' && r.content === target);
  if (!ours && records.length > 0) {
    throw new OwnTunnelInputError(
      'hostname_taken',
      `${hostname} already has a ${records[0]!.type} record in Cloudflare; pick another name or remove that record`,
    );
  }
  const record = ours ?? (await api.createCname(zone.id, hostname, target));

  const runToken = await api.getTunnelToken(input.accountId, tunnel.id);
  if (typeof runToken !== 'string' || runToken.length < 20) {
    throw new CloudflareApiError(502, 'Cloudflare returned no tunnel run token', null);
  }

  return {
    accountId: input.accountId,
    zoneId: zone.id,
    zoneName: zone.name,
    hostname,
    tunnelId: tunnel.id,
    tunnelName: tunnel.name ?? input.tunnelName,
    dnsRecordId: record.id,
    runToken,
  };
}

export interface RemovalTarget {
  readonly accountId: string;
  readonly zoneId: string;
  readonly tunnelId: string;
  readonly hostname: string;
  readonly dnsRecordId?: string | null;
}

/**
 * Remove what `provisionCloudflareTunnel` created: our CNAME (only if it still points at our
 * tunnel), the tunnel's connections, then the tunnel. A 404 on any step counts as already gone.
 * Stop the local connector first; Cloudflare refuses to delete a tunnel with live connections.
 */
export async function removeCloudflareTunnel(api: CloudflareApi, target: RemovalTarget): Promise<void> {
  const gone = (err: unknown) => err instanceof CloudflareApiError && err.status === 404;
  const cname = tunnelCnameTarget(target.tunnelId);
  const records = await api.listDnsRecords(target.zoneId, normalizeHostname(target.hostname));
  for (const r of records) {
    if (r.type === 'CNAME' && r.content === cname) {
      await api.deleteDnsRecord(target.zoneId, r.id).catch((e) => {
        if (!gone(e)) throw e;
      });
    }
  }
  await api.cleanupConnections(target.accountId, target.tunnelId).catch((e) => {
    if (!gone(e)) throw e;
  });
  await api.deleteTunnel(target.accountId, target.tunnelId).catch((e) => {
    if (!gone(e)) throw e;
  });
}
