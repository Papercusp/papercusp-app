/**
 * Granted-only ambient Personal Vault recall.
 *
 * This is a fourth, isolated turn-start leg. It never joins general memory's
 * scope fan-out: the server first resolves the caller's plan/binding/role from
 * live session state, then runs the same default-deny authorization as
 * `personal:search`. A refusal is represented by silence, not an empty heading.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { authorizePersonalAccess, type PersonalAuthorization } from './authorization';
import type { DocumentLabel } from './disclosure-labels';
import { discloseDocuments, type DisclosedDocuments } from './disclosure-ledger';
import { buildPersonalQueryEmbedder } from './embedding';
import { searchPersonalDocuments } from './store';
import type { PersonalSearchResult, PersonalToolContext } from './types';
import { withMemoryTimeout } from '../memory/op-deadline';

export const PERSONAL_AMBIENT_LIMIT = 4;
export const PERSONAL_AMBIENT_BUDGET_CHARS = 1_800;
export const PERSONAL_AMBIENT_EMBED_TIMEOUT_MS = 750;

interface ClaimedPlanRunPayload {
  sessionId?: unknown;
  instancePlanSlug?: unknown;
  templateSlug?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Resolve identity from server-owned state. `ownerId` itself may be a direct
 * plan-run session id; scheduled/frontier workers instead carry a plan_run
 * pointer on their claimed work item. Nothing in the submitted prompt can
 * nominate a principal.
 */
export async function resolvePersonalAmbientToolContext(
  sql: Sql,
  ownerId: string,
  workspaceId: string,
): Promise<PersonalToolContext> {
  const [presence, directRun, claims] = await Promise.all([
    sql<Array<{ agent_role: string | null }>>`
      SELECT agent_role FROM harness_shared.coord_presence
       WHERE owner_id = ${ownerId} AND workspace_id = ${workspaceId}
       LIMIT 1`,
    sql<Array<{ session_id: string }>>`
      SELECT session_id FROM harness_shared.plan_runs
       WHERE workspace_id = ${workspaceId} AND session_id = ${ownerId}
       ORDER BY id DESC LIMIT 1`,
    sql<Array<{ feature_id: string; payload: unknown }>>`
      SELECT feature_id, payload
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId} AND taken_by = ${ownerId}
         AND status NOT IN ('done', 'closed', 'resolved', 'deprecated', 'dropped', 'passed')
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY COALESCE(last_progress_at, taken_at) DESC NULLS LAST
       LIMIT 1`,
  ]);
  const claim = claims[0];
  const payload = asRecord(claim?.payload);
  const planRun = asRecord(payload?.plan_run) as ClaimedPlanRunPayload | null;
  let planRunSessionId = directRun[0]?.session_id ?? null;
  if (!planRunSessionId && typeof planRun?.sessionId === 'string' && planRun.sessionId.trim()) {
    planRunSessionId = planRun.sessionId.trim();
  }
  if (!planRunSessionId) {
    const instance = typeof planRun?.instancePlanSlug === 'string' ? planRun.instancePlanSlug.trim() : '';
    const template = typeof planRun?.templateSlug === 'string' ? planRun.templateSlug.trim() : '';
    if (instance || template) {
      const rows = await sql<Array<{ session_id: string }>>`
        SELECT session_id FROM harness_shared.plan_runs
         WHERE workspace_id = ${workspaceId}
           AND (${instance} <> '' AND instance_plan_slug = ${instance}
             OR ${template} <> '' AND plan_slug = ${template})
         ORDER BY id DESC LIMIT 1`;
      planRunSessionId = rows[0]?.session_id ?? null;
    }
  }
  return {
    workspaceId,
    role: presence[0]?.agent_role ?? null,
    featureId: claim?.feature_id ?? null,
    planRunSessionId,
  };
}

export interface PersonalAmbientDeps {
  sql: Sql;
  resolveContext: (sql: Sql, ownerId: string, workspaceId: string) => Promise<PersonalToolContext>;
  authorize: (
    sql: Sql,
    context: PersonalToolContext,
    workspaceId: string,
    userId: string,
  ) => Promise<PersonalAuthorization>;
  embedQuery: (query: string) => Promise<number[] | null>;
  search: (
    sql: Sql,
    workspaceId: string,
    userId: string,
    input: { query: string; scopes: string[]; limit: number; snippetChars: number; queryEmbedding: number[] | null },
  ) => Promise<PersonalSearchResult[]>;
  /** Label the results and record a disclosure for each restricted one (reader-set labels P-008). */
  disclose: (
    sql: Sql,
    params: { workspaceId: string; userId: string; agentOwnerId: string; documents: PersonalSearchResult[] },
  ) => Promise<DisclosedDocuments<PersonalSearchResult>>;
}

/**
 * Its own transaction with the workspace GUC set, so the rules read and the
 * ledger write see this workspace's rows under RLS whichever role the pool
 * connects as. A rules read that RLS silently emptied would label nothing.
 */
export function disclosePersonalAmbientResults(
  sql: Sql,
  params: Parameters<PersonalAmbientDeps['disclose']>[1],
): Promise<DisclosedDocuments<PersonalSearchResult>> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', ${params.workspaceId}, true)`;
    return discloseDocuments(tx, { ...params, via: 'personal:ambient' });
  }) as Promise<DisclosedDocuments<PersonalSearchResult>>;
}

function defaultDeps(): PersonalAmbientDeps {
  const { sql } = getOrgPg();
  return {
    sql,
    resolveContext: resolvePersonalAmbientToolContext,
    authorize: (db, context, workspaceId, userId) =>
      authorizePersonalAccess(db, context, workspaceId, userId),
    async embedQuery(query) {
      try {
        const embed = await buildPersonalQueryEmbedder();
        return await withMemoryTimeout(embed(query), 'personal-ambient-query', PERSONAL_AMBIENT_EMBED_TIMEOUT_MS);
      } catch {
        return null;
      }
    },
    search: (db, workspaceId, userId, input) =>
      searchPersonalDocuments(db, workspaceId, userId, input),
    disclose: disclosePersonalAmbientResults,
  };
}

function compact(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

export function renderPersonalAmbientBlock(
  results: Array<PersonalSearchResult & { privacy?: DocumentLabel | null }>,
  scopes: string[],
  budgetChars = PERSONAL_AMBIENT_BUDGET_CHARS,
): string | null {
  if (!results.length || budgetChars <= 0) return null;
  const header = '## Granted Personal Vault context';
  const notice = `Private owner data · allowed only for this bound plan/context · scopes: ${scopes.join(', ')}`;
  const lines = [header, notice];
  let used = header.length + notice.length + 1;
  for (const result of results) {
    const provenance = [
      result.scopeKey,
      result.providerAccountId ? `account:${result.providerAccountId}` : null,
      result.occurredAt?.slice(0, 10),
      result.externalId,
    ]
      .filter(Boolean)
      .join(' · ');
    const restriction = result.privacy
      ? ` (restricted ${result.privacy.level}: send only to ${result.privacy.readerSet.join(', ')} or the owner)`
      : '';
    const line = `- ${compact(result.title || '(untitled)', 120)} — ${compact(result.snippet, 360)} [${provenance}]${restriction}`;
    if (used + line.length + 1 > budgetChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length > 2 ? lines.join('\n') : null;
}

export interface PersonalAmbientResults {
  scopes: string[];
  documents: Array<PersonalSearchResult & { privacy: DocumentLabel | null }>;
}

/**
 * The granted-only core of the ambient leg: resolve identity, authorize, search,
 * disclose. Returns null on refusal, an empty query, or any failure — the
 * caller renders. Shared by the Personal Vault block below and by the
 * generalized granted-sources leg (data-sources/granted-sources-injection.ts),
 * so both run the exact same authorization.
 */
export async function collectPersonalAmbientResults(
  input: { ownerId: string; userId: string; workspaceId: string; query: string },
  deps: PersonalAmbientDeps = defaultDeps(),
): Promise<PersonalAmbientResults | null> {
  const query = input.query.trim().slice(0, 500);
  if (!query || !input.ownerId.trim() || !input.userId.trim()) return null;
  try {
    const context = await deps.resolveContext(deps.sql, input.ownerId, input.workspaceId);
    const authorization = await deps.authorize(deps.sql, context, input.workspaceId, input.userId);
    if (!authorization.allowed || !authorization.scopes.length) return null;
    const queryEmbedding = await deps.embedQuery(query);
    const results = await deps.search(deps.sql, input.workspaceId, input.userId, {
      query,
      scopes: authorization.scopes,
      limit: PERSONAL_AMBIENT_LIMIT,
      snippetChars: 360,
      queryEmbedding,
    });
    // Same rule as personal:search: a restricted result reaches the session only
    // with its disclosure row, which then constrains every send it makes. A
    // failure to record lands in the catch below — silence, never unlabelled.
    const disclosed = await deps.disclose(deps.sql, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      agentOwnerId: input.ownerId.trim(),
      documents: results,
    });
    return { scopes: authorization.scopes, documents: disclosed.documents };
  } catch {
    // Turn-start injection is fail-soft. A vault/store/embedder failure is
    // silence; it must never cost the caller's turn or weaken authorization.
    return null;
  }
}

export async function buildPersonalAmbientContextBlock(
  input: {
    ownerId: string;
    userId: string;
    workspaceId: string;
    query: string;
    budgetChars?: number;
  },
  deps: PersonalAmbientDeps = defaultDeps(),
): Promise<string | null> {
  const collected = await collectPersonalAmbientResults(input, deps);
  if (!collected) return null;
  return renderPersonalAmbientBlock(collected.documents, collected.scopes, input.budgetChars);
}
