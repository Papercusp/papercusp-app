import type {
  ExternalTriggerAdminSnapshot,
  ExternalTriggerPlanAdminSnapshot,
} from '@papercusp/operator-core/lib/external-triggers/admin';

export type PlanTriggerAdminResponse = ExternalTriggerAdminSnapshot & {
  plan?: ExternalTriggerPlanAdminSnapshot;
};

export async function fetchTriggerAdminSnapshot(args?: {
  planSlug?: string;
  planHarnessSlug?: string;
  signal?: AbortSignal;
}): Promise<PlanTriggerAdminResponse> {
  const url = new URL('/api/admin/triggers', window.location.origin);
  if (args?.planSlug && args.planHarnessSlug) {
    url.searchParams.set('planSlug', args.planSlug);
    url.searchParams.set('planHarnessSlug', args.planHarnessSlug);
  }
  const response = await fetch(url.toString(), {
    cache: 'no-store',
    ...(args?.signal ? { signal: args.signal } : {}),
  });
  const body = (await response.json()) as PlanTriggerAdminResponse & {
    error?: string;
    detail?: string;
  };
  if (!response.ok) throw new Error(body.detail ?? body.error ?? `HTTP ${response.status}`);
  return body;
}

export async function patchTriggerAdmin(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch('/api/admin/triggers', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as {
    ok?: boolean;
    error?: string;
    detail?: string;
    [key: string]: unknown;
  };
  if (!response.ok || result.ok !== true) {
    throw new Error(result.detail ?? result.error ?? `HTTP ${response.status}`);
  }
  return result;
}
