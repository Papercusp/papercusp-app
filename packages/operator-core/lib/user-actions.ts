/**
 * Server-side wrapper for long-running user-initiated actions. Writes a row to
 * harness_shared.user_actions with status='running' on entry; updates with
 * 'succeeded' (+ summary/detailUrl) or 'failed' (+ error_text) on exit.
 *
 * Drives the OperatorActionLog UI panel via Zero. Designed to be a one-line
 * wrap of any existing action endpoint:
 *
 *   harness.post('/:slug/replan', (c) => recordUserAction(c.req.param('slug'), 'replan',
 *     async () => {
 *       const { invocationId } = invokeScoperBackground(project, 'replan');
 *       return { invocationId, response: c.json({ ok: true, invocationId }) };
 *     }));
 *
 * For background-job actions (replan, cleanup), the wrapper
 * captures the invocationId and stamps it onto the row; the job's completion
 * handler updates status when it finishes (see updateUserAction).
 */

import { getOrgPg, generated } from '@papercusp/db-org';
import { eq, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from './workspace-registry';
import { notifySyncInvalidate } from './sync-sse';

const t = generated.userActionsInHarnessShared;

export type ActionKind =
  | 'replan'
  | 'cleanup'
  | 'consolidate'
  | 'plugin.install'
  | 'plugin.enable'
  | 'plugin.disable'
  | 'branch.action';

export interface ActionResult<T = unknown> {
  /** One-line user-facing summary string. */
  summary: string;
  /** Optional URL the OperatorActionLog row should link to. */
  detailUrl?: string;
  /** Optional invocation_id for async jobs that finish later. */
  invocationId?: string;
  /** The actual response value forwarded back to the route handler's caller. */
  result: T;
}

interface RecordOpts {
  /** When true, the row stays in 'running' status; caller is expected to
   *  finish the row later via updateUserAction(). Default false (auto-complete). */
  async?: boolean;
  actor?: string;
}

/**
 * Wrap an action. The fn receives the row id so it can pass it through to
 * a background job that will call updateUserAction() on completion.
 */
export async function recordUserAction<T>(
  slug: string,
  kind: ActionKind,
  fn: (id: number) => Promise<ActionResult<T>>,
  opts: RecordOpts = {},
): Promise<T> {
  const { db } = getOrgPg();
  const now = Date.now();
  const inserted = await db
    .insert(t)
    .values({
      harnessSlug: slug,
      kind,
      status: 'running',
      startedAt: now,
      actor: opts.actor ?? null,
      workspaceId: activeWorkspaceId(),
    })
    .returning({ id: t.id });
  const id = Number(inserted[0].id);

  try {
    const out = await fn(id);
    if (opts.async) {
      // Caller will finalize via updateUserAction; just stamp invocationId
      // and any detailUrl now so the running row is fully linked.
      await db
        .update(t)
        .set({
          invocationId: out.invocationId ?? null,
          detailUrl: out.detailUrl ?? null,
          summary: out.summary,
        })
        .where(eq(t.id, BigInt(id)));
    } else {
      await db
        .update(t)
        .set({
          status: 'succeeded',
          summary: out.summary,
          detailUrl: out.detailUrl ?? null,
          invocationId: out.invocationId ?? null,
          finishedAt: Date.now(),
        })
        .where(eq(t.id, BigInt(id)));
    }
    void notifySyncInvalidate('userActions.byHarness', { harnessSlug: slug }).catch(() => {});
    return out.result;
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    await db
      .update(t)
      .set({
        status: 'failed',
        errorText: msg.slice(0, 1000),
        finishedAt: Date.now(),
      })
      .where(eq(t.id, BigInt(id)));
    void notifySyncInvalidate('userActions.byHarness', { harnessSlug: slug }).catch(() => {});
    throw err;
  }
}

/**
 * Finalize an async action started with `{ async: true }`. Background jobs
 * (scoper-result poll, plugin install) call this when the work
 * actually finishes.
 */
export async function updateUserAction(args: {
  id: number;
  status: 'succeeded' | 'failed' | 'cancelled';
  summary?: string;
  detailUrl?: string;
  errorText?: string;
}): Promise<void> {
  const { db, sql: rawSql } = getOrgPg();
  // COALESCE on the existing column requires either a raw sql snippet or
  // a conditional set; drizzle's set object doesn't have a built-in
  // COALESCE primitive. Use sql.raw for the COALESCE merges.
  const rows = await db
    .update(t)
    .set({
      status: args.status,
      summary: args.summary !== undefined ? args.summary : dsql`${t.summary}`,
      detailUrl: args.detailUrl !== undefined ? args.detailUrl : dsql`${t.detailUrl}`,
      errorText: args.errorText ?? null,
      finishedAt: Date.now(),
    })
    .where(eq(t.id, BigInt(args.id)))
    .returning({ harnessSlug: t.harnessSlug });
  const slug = rows[0]?.harnessSlug;
  if (slug) void notifySyncInvalidate('userActions.byHarness', { harnessSlug: slug }).catch(() => {});
}
