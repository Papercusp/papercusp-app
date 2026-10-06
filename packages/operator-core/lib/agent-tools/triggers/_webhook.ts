/**
 * Where a signed webhook can be reached from outside (P-017, D-032 #2/#4): through the user's own
 * tunnel (its public hostname + the machine path) and through the Papercusp relay (the linked
 * workspace's app base URL + `/hooks/<id>`). Either is null when it is not configured here; the
 * machine path always works for a sender on the same machine or network.
 */
import { normalizeHostname } from '../../own-tunnel/config';
import { readOwnTunnel } from '../../own-tunnel/store';
import { portalRelayStatus } from '../../remote-access/relay-opt-in';
import { webhookPath } from '../../external-triggers/webhook-path';

export interface WebhookUrls {
  ownTunnel: string | null;
  relay: string | null;
}

export interface WebhookUrlSources {
  ownTunnelHostname(): Promise<string | null>;
  relayAppBaseUrl(): Promise<string | null>;
}

const defaultSources: WebhookUrlSources = {
  async ownTunnelHostname() {
    const tunnel = await readOwnTunnel();
    return tunnel?.enabled && tunnel.hostname ? tunnel.hostname : null;
  },
  async relayAppBaseUrl() {
    return (await portalRelayStatus()).linked?.appBaseUrl ?? null;
  },
};

export async function webhookUrls(sourceId: string, sources: WebhookUrlSources = defaultSources): Promise<WebhookUrls> {
  const [hostname, appBaseUrl] = await Promise.all([
    sources.ownTunnelHostname().catch(() => null),
    sources.relayAppBaseUrl().catch(() => null),
  ]);
  let ownTunnel: string | null = null;
  if (hostname) {
    try {
      ownTunnel = `https://${normalizeHostname(hostname)}${webhookPath(sourceId)}`;
    } catch {
      ownTunnel = null;
    }
  }
  return {
    ownTunnel,
    relay: appBaseUrl ? `${appBaseUrl.replace(/\/+$/, '')}/hooks/${sourceId}` : null,
  };
}

/** How a sender signs a delivery — returned with every freshly shown key. */
export const WEBHOOK_SIGNING_HOWTO =
  'POST a JSON object. Header Papercusp-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(key, "<t>.<raw body>")>. ' +
  'Optional Papercusp-Event (default "received"; binds as ext:webhook:<event>) and Papercusp-Delivery (dedupe id). ' +
  'The timestamp must be within 300 s of the machine clock.';
