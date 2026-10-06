/**
 * The one path shape of a signed webhook (P-017, D-032 #3/#4), kept free of any database or crypto
 * import so the three hops that must agree on it can share it cheaply:
 *
 *  - the machine route              POST /api/hooks/<source id>        (routes/webhooks)
 *  - the hardened entry point       serves exactly that shape          (apps/operator/bin/external-ingress-paths.ts)
 *  - the Papercusp relay            POST /api/workspaces/<id>/hooks/<source id> → the machine path
 *                                                                       (workspace-host/hosted-app-relay.ts)
 *
 * Exact match only, never a prefix: a new route under /api/hooks/ is not exposed by accident.
 */

/** A source id: a lowercase UUID, as Postgres renders `data_sources.id`. */
export const WEBHOOK_SOURCE_ID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const SOURCE_ID_RE = new RegExp(`^${WEBHOOK_SOURCE_ID_PATTERN}$`);

/** The machine path of one webhook: exactly `/api/hooks/<uuid>`. */
export const WEBHOOK_PATH_RE = new RegExp(`^/api/hooks/(${WEBHOOK_SOURCE_ID_PATTERN})$`);

export function isWebhookSourceId(value: string): boolean {
  return SOURCE_ID_RE.test(value);
}

export function webhookPath(sourceId: string): string {
  return `/api/hooks/${sourceId}`;
}

export function isWebhookPath(pathname: string): boolean {
  return WEBHOOK_PATH_RE.test(pathname);
}
