/**
 * DB scope resolution for the reproducibility layer. Production callers pass
 * nothing → the shared org pool + the active workspace. Tests inject a fresh-DB
 * `sql` + a fixed `workspaceId` (the repo's engine-injection pattern) so emit /
 * store / prereg run against a throwaway Postgres without touching the live DB.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';

export type OrgSql = ReturnType<typeof getOrgPg>['sql'];

export interface DbScope {
  /** Inject a postgres client (tests / a caller-held tx). Default: the org pool. */
  sql?: OrgSql;
  /** Override the workspace. Default: the active workspace. */
  workspaceId?: string;
}

export function resolveDb(opts: DbScope = {}): { sql: OrgSql; ws: string } {
  return {
    sql: opts.sql ?? getOrgPg().sql,
    ws: opts.workspaceId ?? activeWorkspaceId(),
  };
}
