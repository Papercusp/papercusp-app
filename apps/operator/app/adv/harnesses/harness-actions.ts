// Shared write-action helpers for the /adv Harness tab. Used by the
// Features/Issues panel rows (Phase 5 inline actions) and mirror the
// contracts the Detail pane uses. Callers own the toast + busy state so
// they can attach row context.

import type { IssueStatus } from '@papercusp/operator-core/lib/harness/issue-types';

async function post(path: string, body?: unknown): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
}

export async function featureReset(slug: string, id: string): Promise<void> {
  await post(`/api/harness/${encodeURIComponent(slug)}/features/${encodeURIComponent(id)}/reset?phase=staging`);
}

// Working-set (P-038): mark/unmark the viewer as actively working a feature.
// The viewer's github id comes from useViewer() (the viewer-identity infra) —
// the substrate projects it into working_users[] which the row's "working"
// pill reads. Server endpoints: working-set.ts.
export async function setWorkingActive(slug: string, featureId: string, githubUserId: number): Promise<void> {
  await post(
    `/api/harness/${encodeURIComponent(slug)}/working-set/${encodeURIComponent(featureId)}/set-active`,
    { github_user_id: githubUserId },
  );
}

export async function clearWorkingActive(slug: string, featureId: string, githubUserId: number): Promise<void> {
  await post(
    `/api/harness/${encodeURIComponent(slug)}/working-set/${encodeURIComponent(featureId)}/clear-active`,
    { github_user_id: githubUserId },
  );
}

export type IssueActionKind = 'promote' | 'acknowledge' | 'close' | 'wontfix';

// The IssueStatus an action transitions the issue to, or null for promote
// (which creates a fix feature server-side — not client-predictable, so it
// isn't applied optimistically). 'close' → 'closed' (the action verb is not
// itself a valid status); mirrors the legacy IssuesList.
export function issueActionStatus(action: IssueActionKind): IssueStatus | null {
  switch (action) {
    case 'acknowledge':
      return 'acknowledged';
    case 'close':
      return 'closed';
    case 'wontfix':
      return 'wontfix';
    default:
      return null; // promote
  }
}

export async function issueAction(slug: string, id: string, action: IssueActionKind): Promise<void> {
  const base = `/api/harness/${encodeURIComponent(slug)}/issues/${encodeURIComponent(id)}`;
  if (action === 'promote') {
    await post(`${base}/promote`, {});
  } else {
    await post(`${base}/update`, { status: issueActionStatus(action) });
  }
}
