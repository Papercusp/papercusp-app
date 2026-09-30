/**
 * Marketplace-publish credentials (tenantId + tenantSecret + host).
 *
 * Persisted in `harness_shared.operator_publish_credentials` (PG, migration
 * 022). Was previously `<papercuspRoot>/publish-credentials.json` mode 0600.
 * NOT in the zero_harness publication — credentials must not be broadcast
 * over WS. Read via authenticated REST only.
 */
import { getOrgPg, generated } from '@papercusp/db-org';
import { eq } from 'drizzle-orm';
import { activeWorkspaceId } from './workspace-registry';
import { readOperatorState, writeOperatorState } from './operator-state-pg';

const t = generated.operatorPublishCredentialsInHarnessShared;

export interface PublishCredentials {
  tenantId: string;
  tenantSecret: string;
  registeredAt: number;
  publishHost: string;
}

const TABLE_PATH = 'harness_shared.operator_publish_credentials';
/** @deprecated returns table identifier now. */
export function PUBLISH_CREDENTIALS_PATH() { return TABLE_PATH; }

export async function readPublishCredentials(): Promise<PublishCredentials | null> {
  return await readOperatorState<PublishCredentials>('operator_publish_credentials');
}

export async function writePublishCredentials(c: PublishCredentials): Promise<void> {
  await writeOperatorState('operator_publish_credentials', c);
}

export async function deletePublishCredentials(): Promise<void> {
  const { db } = getOrgPg();
  const ws = activeWorkspaceId();
  await db.delete(t).where(eq(t.workspaceId, ws));
}

export interface MaskedPublishCredentials {
  tenantId: string | null;
  tenantSecretMasked: string | null;
  registeredAt: string | null;
  publishHost: string | null;
  path: string;
}

export function maskPublishCredentials(c: PublishCredentials | null): MaskedPublishCredentials {
  if (!c) {
    return {
      tenantId: null,
      tenantSecretMasked: null,
      registeredAt: null,
      publishHost: null,
      path: TABLE_PATH,
    };
  }
  return {
    tenantId: c.tenantId,
    tenantSecretMasked:
      c.tenantSecret.length < 12
        ? '***'
        : c.tenantSecret.slice(0, 6) + '...' + c.tenantSecret.slice(-4),
    registeredAt: new Date(c.registeredAt).toISOString(),
    publishHost: c.publishHost,
    path: TABLE_PATH,
  };
}
