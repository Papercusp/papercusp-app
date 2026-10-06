/** PR viewer over the existing PrHost, report store and exact standing-PR merge gate. */
import type { Pr, PrDetailsData, PrHost } from './types';
import type { PrRowData } from './pr-row-data';
import { decideMergeGate, type MergeTestRecord } from '../harness/git-sync/decide-merge-gate';
import { isStandingPr } from '../harness/git-sync/standing-pr-merge';

export interface PrViewerPermissions { review: boolean; close: boolean; sendGreen: boolean }
export interface PrViewerDetails extends PrDetailsData {
  row: PrRowData;
  permissions: PrViewerPermissions;
  standing: boolean;
  mergeTest: MergeTestRecord | null;
  mergeTestStatus: 'not-tested' | 'running' | 'pass' | 'fail' | 'stale' | 'unavailable';
  mergeBlocker: string | null;
}
export interface PrViewerDeps {
  host: PrHost;
  remote: string;
  permissions: PrViewerPermissions;
  mergeEvidence(number: number): Promise<{ record: MergeTestRecord | null; promotedSha: string | null }>;
  enrich(row: PrRowData, headSha: string): Promise<void>;
  merge(pr: Pr): Promise<{ action: string; detail?: string }>;
  sendGreen(): Promise<{ action: string; detail?: string }>;
}
export function prToRow(pr: Pr): PrRowData {
  return { remote: pr.ref.remote, number: pr.ref.number, title: pr.title,
    author_login: pr.author.github_login, author_github_id: pr.author.github_user_id,
    html_url: pr.url, state: pr.state, review_decision: pr.review_decision,
    check_conclusion: pr.checks_state === 'unknown' ? null : pr.checks_state,
    trusted: false, reviewerRoleEnabled: false };
}
export async function readPrViewerDetails(number: number, deps: PrViewerDeps): Promise<PrViewerDetails> {
  if (!deps.host.getPrDetails) throw new Error('This PR host does not support the detail viewer.');
  const result = await deps.host.getPrDetails({ remote: deps.remote, number });
  if (!result.ok) throw new Error(result.error.message);
  const data = result.data;
  const row = prToRow(data.pr);
  await deps.enrich(row, data.pr.head_sha);
  let mergeTest: MergeTestRecord | null = null;
  let mergeTestStatus: PrViewerDetails['mergeTestStatus'] = 'not-tested';
  let mergeBlocker: string | null = null;
  const standing = isStandingPr(data.pr);
  if (standing) {
    try {
      const evidence = await deps.mergeEvidence(number);
      mergeTest = evidence.record;
      const decision = decideMergeGate({ prHeadSha: data.pr.head_sha, targetTipSha: data.targetSha,
        promotedSha: evidence.promotedSha, lastTest: mergeTest });
      const stale = mergeTest && data.pr.state === 'open' && (mergeTest.prHeadSha !== data.pr.head_sha ||
        mergeTest.targetTipSha !== data.targetSha || evidence.promotedSha !== data.pr.head_sha);
      mergeTestStatus = stale ? 'stale' : mergeTest?.result ?? 'not-tested';
      if (decision.action !== 'merge' && data.pr.state === 'open') mergeBlocker = decision.detail;
    } catch {
      mergeTestStatus = 'unavailable';
      mergeBlocker = 'Exact merge-test evidence could not be loaded. Refresh before merging.';
    }
  }
  if (data.pr.mergeable_state === 'not_mergeable' && data.pr.state === 'open') {
    mergeBlocker = 'Merge conflicts or branch requirements block this PR. Resolve them in the working copy.';
  }
  return { ...data, row, standing, mergeTest, mergeTestStatus, mergeBlocker, permissions: deps.permissions };
}
/** Re-read on every write; permission and state never come from the UI. */
export async function actOnPr(number: number | null, action: 'merge' | 'close' | 'send-green', deps: PrViewerDeps) {
  if (action === 'send-green') {
    if (!deps.permissions.sendGreen) throw new Error('Only the claimed owner can send green work.');
    return deps.sendGreen();
  }
  if (!deps.permissions[action === 'merge' ? 'review' : 'close']) throw new Error('You do not have permission for this PR action.');
  if (!number || !Number.isSafeInteger(number)) throw new Error('Invalid PR number.');
  const current = await deps.host.getPr({ remote: deps.remote, number });
  if (!current.ok) throw new Error(current.error.message);
  if (current.data.state !== 'open') throw new Error('This PR is no longer open. Refresh the viewer.');
  if (action === 'merge') return deps.merge(current.data);
  if (!deps.host.closePr) throw new Error('This host does not support closing PRs.');
  const result = await deps.host.closePr(current.data.ref);
  if (!result.ok) throw new Error(result.error.message);
  return { action: 'closed', detail: `Closed PR #${number}.` };
}
export async function livePrViewerDeps(slug: string): Promise<PrViewerDeps> {
  const [{ createGitHubPrHost }, { resolveHarnessPrRemote, attachReportsAndWi },
    { buildPrReviewerSettingsResponse }, { activeWorkspaceId }, { getOrgPg },
    { makeSqlStore }, { projectDirForSlug }, { execFile }, { promisify }] = await Promise.all([
    import('./github'), import('../endpoint-route/routes/harness/prs'),
    import('../endpoint-route/routes/harness/pr-reviewer-settings'), import('../workspace-registry'),
    import('@papercusp/db-org'), import('./poll-daemon'), import('../operator-notes'),
    import('node:child_process'), import('node:util'),
  ]);
  const host = await createGitHubPrHost();
  if (!host) throw new Error('GitHub is not authenticated.');
  const remote = await resolveHarnessPrRemote(slug);
  if (!remote) throw new Error('No GitHub remote is configured for this harness.');
  const settings = await buildPrReviewerSettingsResponse(slug);
  const workspaceId = activeWorkspaceId();
  const store = makeSqlStore(getOrgPg().sql);
  const repoDir = await projectDirForSlug(slug, workspaceId);
  return {
    host, remote,
    permissions: { review: settings.editable && settings.settings.pr_reviewer_role_enabled,
      close: !!settings.claimOwner && settings.editable, sendGreen: !!settings.claimOwner && settings.editable },
    enrich: async (row, sha) => attachReportsAndWi(slug, [row], new Map([[row.number, sha]])),
    async mergeEvidence(number) {
      const { STANDING_PR_MERGE_TESTS_META_KEY } = await import('../harness/git-sync/standing-pr-merge-deps');
      const meta = await store.readMeta(slug);
      const records = meta[STANDING_PR_MERGE_TESTS_META_KEY] as Record<string, MergeTestRecord> | undefined;
      const raw = records?.[String(number)];
      const record = raw && ['pass', 'fail', 'running'].includes(raw.result) &&
        [raw.mergeSha, raw.prHeadSha, raw.targetTipSha].every(x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x)) ? raw : null;
      let promotedSha: string | null = null;
      if (repoDir) {
        try { promotedSha = (await promisify(execFile)('git', ['rev-parse', '--verify', 'refs/heads/main^{commit}'], { cwd: repoDir })).stdout.trim(); }
        catch { /* no promoted commit */ }
      }
      return { record, promotedSha };
    },
    async merge(pr) {
      const { isPrAuthorRevoked } = await import('./contribution-admission');
      const authorRevoked = await isPrAuthorRevoked({ workspaceId, harnessSlug: slug, githubUserId: pr.author.github_user_id });
      if (authorRevoked) throw new Error('Contribution admission denied: the PR author is revoked.');
      if (isStandingPr(pr)) {
        // Reached only via actOnPr after its permissions.review check, so this is a
        // reviewer's decision to merge: it is the approval (WI-10006351).
        const { makeLiveStandingPrMerge } = await import('../harness/git-sync/standing-pr-merge-live');
        const onError = (err: unknown) => console.warn(`[pr-viewer] ${slug}: standing PR merge run failed:`, err);
        return makeLiveStandingPrMerge({ store, onError })({ workspaceId, installSlug: slug, remote, pr, autoMerge: true, authorRevoked,
          viewerApproved: true });
      }
      const { tryAutoMerge } = await import('./auto-merge');
      return tryAutoMerge(host, pr, { harnessSlug: slug, reviewerGithubId: settings.viewer?.github_user_id ?? 0,
        reviewerLogin: settings.viewer?.github_login ?? '', autoMerge: true, mergeMethod: 'squash', authorRevoked });
    },
    async sendGreen() {
      if (!repoDir) throw new Error('No checkout is registered for this harness.');
      const { sendStandingPrNow, createDefaultSendStandingPrNowDeps } = await import('../harness/git-sync/promotion-push-target');
      const outcome = await sendStandingPrNow({ repoPath: repoDir, workspaceId, ref: 'main' }, await createDefaultSendStandingPrNowDeps(() => {}));
      if (outcome.kind !== 'sent') return { action: outcome.kind, detail: outcome.message };
      if (!outcome.standingPr.ok) throw new Error(outcome.standingPr.error);
      return { action: 'sent', detail: `Sent tested work ${outcome.sha} to the standing PR.` };
    },
  };
}
