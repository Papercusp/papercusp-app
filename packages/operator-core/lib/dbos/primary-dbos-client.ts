/**
 * The DBOS PRIMARY, as seen from a process that does not run it.
 *
 * DBOS launches only on the background host (`startDbos()` runs under
 * `PAPERCUSP_DBOS_ENABLE=1`); the operator's request workers never launch it. A
 * request-side caller that must start durable work therefore enqueues through a
 * `DBOSClient` on the primary's system database, tagged with the primary's
 * application version so the primary's executor picks the workflow up.
 *
 * routines-workflow, durable-spawn, durable-orchestration-workflow and
 * workspace-host-provision-client each carry a private copy of this; new callers
 * use this one.
 */
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { pinModuleState } from '@papercusp/module-singleton';
import { getHarnessAdminUrlWithSource } from '../embedded-pg-discovery';
import { withDbosIdleTxGrace } from './bootstrap';

/** The application version the primary's executor runs (`bg-host-v1` on this box). */
export function primaryDbosAppVersion(env: Record<string, string | undefined> = process.env): string {
  return (
    env.PAPERCUSP_HOSTED_PROVISIONING_DBOS_APP_VERSION?.trim() ||
    env.DBOS__APPVERSION?.trim() ||
    'bg-host-v1'
  );
}

const state = pinModuleState('@papercusp/operator-core.dbos.primary-dbos-client', () => ({
  client: null as Promise<DBOSClient> | null,
}));

/** One shared client per process; a failed creation is not cached. */
export function getPrimaryDbosClient(): Promise<DBOSClient> {
  state.client ??= DBOSClient.create({
    systemDatabaseUrl: withDbosIdleTxGrace(getHarnessAdminUrlWithSource().url),
    systemDatabaseSchemaName: 'dbos',
  }).catch((error: unknown) => {
    state.client = null;
    throw error;
  });
  return state.client;
}
