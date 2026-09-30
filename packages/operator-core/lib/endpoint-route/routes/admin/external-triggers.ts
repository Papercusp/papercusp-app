/** Owner-local read/write surface backing /admin/triggers (P-004). */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { activeWorkspaceId } from '../../../workspace-registry';
import { getSessionUserOrDefault } from '../../../auth';
import {
  createExternalTriggerBinding,
  detachExternalTriggerBinding,
  disabledExternalTriggerAdminSnapshot,
  loadExternalTriggerAdminSnapshot,
  loadExternalTriggerPlanAdminSnapshot,
  setExternalTriggerBindingArmed,
  updateExternalTriggerBindingStormPolicy,
} from '../../../external-triggers/admin';
import { connectOwnedSlackSource, SLACK_APP_MANIFEST_TEMPLATE } from '../../../external-triggers/slack';
import {
  ensureSlackRespondInThreadBinding,
  SLACK_RESPOND_IN_THREAD_PLAN,
} from '../../../external-triggers/slack-flagship';
import { notifySyncInvalidate } from '../../../sync-sse';
import { requireAllowedOriginOr403 } from '../../cors';

// Keep the three target shapes explicit at the HTTP boundary. Besides making the
// generated contract legible, a union here prevents a caller from accidentally
// supplying plan + goal (or plan + direct work) and relying on the deeper SQL
// guard to decide which one wins.
const attachExternalCommon = {
  op: z.literal('attach-external'),
  sourceId: z.string().uuid(),
  eventPattern: z.string().min(1).max(500),
  eventFilter: z.record(z.string(), z.unknown()).default({}),
  // NO zod defaults here, deliberately. `.default(null)` + `.default(60)`
  // manufactured a `{ windowSeconds: 60 }` policy for a caller who stated
  // none — a rate window with no cap (EI-21500982767775449) — and, because
  // createExternalTriggerBinding only reaches for a source's own default
  // when `stormPolicy` is absent, that manufactured object also silently
  // disabled the P-023 per-platform social default for every binding
  // created through this route. Silence must stay distinguishable from a
  // stated policy.
  maxRuns: z.number().int().positive().max(1_000_000).nullable().optional(),
  windowSeconds: z.number().int().positive().max(31 * 24 * 60 * 60).optional(),
} as const;

const attachPlanSchema = z.object({
  ...attachExternalCommon,
  planHarnessSlug: z.string().min(1).max(120),
  planSlug: z.string().min(1).max(240),
}).strict();

const attachGoalSchema = z.object({
  ...attachExternalCommon,
  goalId: z.string().min(1).max(240),
}).strict();

const attachDirectWorkItemSchema = z.object({
  ...attachExternalCommon,
  workItemHarnessSlug: z.string().min(1).max(120),
  workItemKind: z.string().min(1).max(240),
}).strict();

const mutationSchema = z.union([
  attachPlanSchema,
  attachGoalSchema,
  attachDirectWorkItemSchema,
  z
    .object({
      op: z.literal('detach-external'),
      id: z.string().uuid(),
      confirm: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('set-armed'),
      id: z.string().uuid(),
      armed: z.boolean(),
      confirm: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('set-storm-policy'),
      id: z.string().uuid(),
      maxRuns: z.number().int().positive().max(1_000_000).nullable(),
      windowSeconds: z
        .number()
        .int()
        .positive()
        .max(31 * 24 * 60 * 60),
    })
    .strict(),
]);

async function enabled(distinctId: string): Promise<boolean> {
  return getFlag(FLAGS.TRIGGERS_ADMIN, distinctId).catch(() => true);
}

const read = defineTool({
  method: 'GET',
  path: '/admin/triggers',
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  async handler(req): Promise<Response> {
    if (!(await enabled('admin:triggers:read'))) {
      return Response.json(disabledExternalTriggerAdminSnapshot());
    }
    const { sql } = getOrgPg();
    const workspaceId = activeWorkspaceId();
    const url = new URL(req.url);
    const planSlug = url.searchParams.get('planSlug')?.trim() ?? '';
    const planHarnessSlug = url.searchParams.get('planHarnessSlug')?.trim() ?? '';
    if ((planSlug && !planHarnessSlug) || (!planSlug && planHarnessSlug)) {
      return Response.json(
        { ok: false, error: 'bad_request', detail: 'planSlug and planHarnessSlug must be supplied together' },
        { status: 400 },
      );
    }
    const [snapshot, plan] = await Promise.all([
      loadExternalTriggerAdminSnapshot(sql, workspaceId),
      planSlug
        ? loadExternalTriggerPlanAdminSnapshot(sql, workspaceId, planHarnessSlug, planSlug)
        : Promise.resolve(null),
    ]);
    if (planSlug && !plan) {
      return Response.json({ ok: false, error: 'plan_not_found' }, { status: 404 });
    }
    return Response.json({ ...snapshot, ...(plan ? { plan } : {}) });
  },
});

const mutate = defineTool({
  method: 'PATCH',
  path: '/admin/triggers',
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  async handler(req): Promise<Response> {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    if (!(await enabled('admin:triggers:write'))) {
      return Response.json(
        { ok: false, error: 'disabled', detail: 'external trigger admin is switched off' },
        { status: 409 },
      );
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'bad_request', detail: 'body must be JSON' }, { status: 400 });
    }
    const parsed = mutationSchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json(
        {
          ok: false,
          error: 'bad_request',
          detail: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        },
        { status: 400 },
      );
    }

    const { sql } = getOrgPg();
    const workspaceId = activeWorkspaceId();
    if (parsed.data.op === 'attach-external') {
      const user = await getSessionUserOrDefault(req.headers);
      try {
        const binding = await createExternalTriggerBinding(sql, workspaceId, {
          sourceId: parsed.data.sourceId,
          ...('planHarnessSlug' in parsed.data
            ? { planHarnessSlug: parsed.data.planHarnessSlug, planSlug: parsed.data.planSlug }
            : {}),
          ...('goalId' in parsed.data ? { goalId: parsed.data.goalId } : {}),
          ...('workItemHarnessSlug' in parsed.data
            ? {
                workItemHarnessSlug: parsed.data.workItemHarnessSlug,
                workItemKind: parsed.data.workItemKind,
              }
            : {}),
          eventPattern: parsed.data.eventPattern,
          eventFilter: parsed.data.eventFilter,
          // Undefined when the caller stated nothing, so the source's own
          // default (social per-platform, else the bounded generic one) still
          // applies. A stated policy still wins.
          stormPolicy:
            parsed.data.maxRuns == null && parsed.data.windowSeconds === undefined
              ? undefined
              : {
                  ...(parsed.data.maxRuns == null ? {} : { maxRuns: parsed.data.maxRuns }),
                  ...(parsed.data.windowSeconds === undefined
                    ? {}
                    : { windowSeconds: parsed.data.windowSeconds }),
                },
          createdBy: `owner:${user.id}`,
        });
        void notifySyncInvalidate('externalTriggers.admin', { workspaceId }).catch(() => {});
        void notifySyncInvalidate('plans.list', undefined).catch(() => {});
        return Response.json({ ok: true, binding });
      } catch (error) {
        return Response.json(
          { ok: false, error: 'attach_failed', detail: error instanceof Error ? error.message : String(error) },
          { status: 400 },
        );
      }
    }
    if (parsed.data.op === 'detach-external') {
      if (parsed.data.confirm !== true) {
        return Response.json(
          {
            ok: false,
            error: 'owner_confirmation_required',
            detail: 'detaching a trigger binding requires an explicit owner confirmation',
          },
          { status: 409 },
        );
      }
      const binding = await detachExternalTriggerBinding(sql, workspaceId, parsed.data.id);
      if (!binding) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
      void notifySyncInvalidate('externalTriggers.admin', { workspaceId }).catch(() => {});
      void notifySyncInvalidate('plans.list', undefined).catch(() => {});
      return Response.json({ ok: true, binding });
    }
    if (parsed.data.op === 'set-armed') {
      if (parsed.data.confirm !== true) {
        return Response.json(
          {
            ok: false,
            error: 'owner_confirmation_required',
            detail: `${parsed.data.armed ? 'arming' : 'disarming'} a trigger binding requires an explicit owner confirmation`,
            gate: { category: 'schedule-arm', authority: 'owner', reversible: true },
          },
          { status: 409 },
        );
      }
      const binding = await setExternalTriggerBindingArmed(sql, workspaceId, parsed.data.id, parsed.data.armed);
      if (!binding) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
      void notifySyncInvalidate('externalTriggers.admin', { workspaceId }).catch(() => {});
      return Response.json({ ok: true, binding });
    }

    const binding = await updateExternalTriggerBindingStormPolicy(sql, workspaceId, parsed.data.id, {
      maxRuns: parsed.data.maxRuns,
      windowSeconds: parsed.data.windowSeconds,
    });
    if (!binding) return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
    void notifySyncInvalidate('externalTriggers.admin', { workspaceId }).catch(() => {});
    return Response.json({ ok: true, binding });
  },
});

const slackManifest = defineTool({
  method: 'GET',
  path: '/admin/triggers/slack/manifest',
  // Provider-token setup stays behind the admin contract's verified/trusted
  // gate; it must not inherit the parent route's cookie-less fallback.
  auth: { trust: ['verified', 'trusted'] },
  async handler(): Promise<Response> {
    return Response.json({ ok: true, manifest: SLACK_APP_MANIFEST_TEMPLATE });
  },
});

const slackConnectSchema = z
  .object({
    appToken: z.string().min(6).max(2_000),
    botToken: z.string().min(6).max(2_000),
    installSlug: z.string().min(1).max(120).default('papercusp'),
    field: z.string().min(1).max(128).optional(),
    channels: z.array(z.string().min(1).max(80)).max(500).optional(),
  })
  .strict();

const slackConnect = defineTool({
  method: 'POST',
  path: '/admin/triggers/slack/connect',
  // Provider-token setup stays behind the admin contract's verified/trusted
  // gate; it must not inherit the parent route's cookie-less fallback.
  auth: { trust: ['verified', 'trusted'] },
  async handler(req): Promise<Response> {
    const csrf = requireAllowedOriginOr403(req);
    if (csrf) return csrf;
    if (!(await enabled('admin:triggers:write'))) {
      return Response.json({ ok: false, error: 'disabled' }, { status: 409 });
    }
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'bad_request', detail: 'body must be JSON' }, { status: 400 });
    }
    const parsed = slackConnectSchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json(
        {
          ok: false,
          error: 'bad_request',
          detail: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        },
        { status: 400 },
      );
    }
    try {
      const user = await getSessionUserOrDefault(req.headers);
      const workspaceId = activeWorkspaceId();
      const createdBy = `owner:${user.id}`;
      const source = await connectOwnedSlackSource(getOrgPg().sql, {
        workspaceId,
        ownerUserId: user.id,
        createdBy,
        ...parsed.data,
      });
      const flagship = await ensureSlackRespondInThreadBinding(getOrgPg().sql, workspaceId, source, createdBy);
      void notifySyncInvalidate('externalTriggers.admin', { workspaceId }).catch(() => {});
      return Response.json({
        ok: true,
        source,
        binding: flagship.binding,
        plan: {
          slug: SLACK_RESPOND_IN_THREAD_PLAN,
          created: flagship.plan.created,
          armed: flagship.binding.armed,
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return Response.json({ ok: false, error: 'slack_connect_failed', detail }, { status: 400 });
    }
  },
});

export default [read, mutate, slackManifest, slackConnect];
