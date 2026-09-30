'use client';

import dynamic from '@/lib/router-compat/dynamic';
import { parseAsString, useQueryState } from 'nuqs';
import { CommitDetail } from '@papercusp/git-graph';
import type { PanelComponentProps } from '../../harness/dock/panel-registry';
import { crossOriginUrl } from '@papercusp/operator-core/lib/cross-origin-url';

const GitGraphPanelLib = dynamic(
  () => import('@papercusp/git-graph').then((m) => ({ default: m.GitGraphPanel })),
  {
    ssr: false,
    loading: () => (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--fg-mute)' }}>
        Loading git graph…
      </div>
    ),
  },
);

export function AdvGitPanel({ params }: PanelComponentProps) {
  const slug = (params.harnessSlug as string) || (params.slug as string) || '';
  const [gitSha, setGitSha] = useQueryState('gitSha', parseAsString.withDefault(''));

  if (!slug) {
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--fg-mute)' }}>
        No harness slug in params.
      </div>
    );
  }

  const showCommitUrl = (sha: string) =>
    crossOriginUrl(`/api/harness/${slug}/git/show/${sha}`);

  return (
    <div className="pc-adv-git">
      <div className="pc-adv-git__left">
        <GitGraphPanelLib
          scope={`harness:${slug}`}
          gitLogUrl={(limit) => `/api/harness/${slug}/git/log?limit=${limit}`}
          showCommitUrl={showCommitUrl}
          worktreesUrl={() => `/api/harness/${slug}/git/worktrees`}
          selectedSha={gitSha || null}
          onCommitSelect={(sha) => void setGitSha(sha ?? '')}
        />
      </div>
      <div className="pc-adv-git__right">
        {gitSha ? (
          <CommitDetail
            sha={gitSha}
            showCommitUrl={showCommitUrl}
            onClose={() => void setGitSha('')}
            inline
          />
        ) : (
          <div className="pc-adv-git__placeholder">
            Select a commit to view its diff
          </div>
        )}
      </div>
      <style>{`
        .pc-adv-git {
          display: flex;
          height: 100%;
          overflow: hidden;
        }
        .pc-adv-git__left {
          flex: 0 0 360px;
          min-width: 240px;
          max-width: 480px;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          border-right: 1px solid color-mix(in oklab, var(--border), transparent 20%);
        }
        .pc-adv-git__right {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
        .pc-adv-git__placeholder {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          color: rgba(220, 214, 248, 0.38);
          font-size: 13px;
          font-style: italic;
        }
      `}</style>
    </div>
  );
}
