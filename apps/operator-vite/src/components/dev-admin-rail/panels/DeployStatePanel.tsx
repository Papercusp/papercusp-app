/**
 * Deploy / release-gate state (P-006, D-004) — the in-app antidote to the #10
 * "my edit reverted" confusion. Shows that the live `:3070` runs from a separate
 * green release checkout, N commits / X behind `main`, so a missing edit reads as
 * *not-yet-deployed*, not *reverted*. READ-ONLY: no deploy button — triggering a
 * deploy stays the release-gate agent's job. Reads the `dev.deployState` sync
 * query (a snapshot wrapped in a 1-element array → data[0]).
 */
import { useSyncQuery } from '@papercusp/sync';
import { PanelBar, PanelState, formatRelative } from '../panel-kit';

interface CommitRef {
  sha: string;
  shortSha: string;
  committedAtMs: number;
  subject: string;
}
interface DeployState {
  integrationBranch: string;
  releaseRef: string;
  releaseRoot: string;
  mainHead: CommitRef | null;
  ready: CommitRef | null;
  deployed: CommitRef | null;
  deployedAtMs: number | null;
  deployedBehindMain: number | null;
  readyBehindMain: number | null;
  deployedBehindReady: number | null;
  readyAtMainHead: boolean | null;
  errors: string[];
}

function behindPill(n: number | null) {
  if (n == null) return <span className="pcdar-pill">—</span>;
  if (n === 0) return <span className="pcdar-pill is-good">caught up</span>;
  return <span className="pcdar-pill is-warn">{n} behind</span>;
}

export default function DeployStatePanel({ active }: { active: boolean }) {
  const sync = useSyncQuery<DeployState>({
    queryName: 'dev.deployState',
    enabled: active,
    staleTime: 30_000,
  });
  const st = sync.data?.[0];

  return (
    <div className="pcdar-panel">
      <PanelBar label="Deploy / release gate" fetching={sync.fetching} onRefresh={sync.invalidate} />
      <PanelState loading={sync.loading && !st} error={sync.error} empty={!st} emptyHint="No deploy state." />
      {st && (
        <>
          <div className="pcdar-row">
            <span
              className={`pcdar-dot ${st.deployedBehindMain === 0 ? 'is-up' : 'is-absent'}`}
              aria-hidden="true"
            />
            <div className="pcdar-row__main">
              <div className="pcdar-row__title">
                {st.deployedBehindMain === 0
                  ? `:3070 is current with ${st.integrationBranch}`
                  : `:3070 is ${st.deployedBehindMain ?? '?'} commits behind ${st.integrationBranch}`}
              </div>
              <div className="pcdar-row__sub">
                {st.deployedBehindMain && st.deployedBehindMain > 0
                  ? 'a missing edit here is NOT-YET-DEPLOYED, not reverted'
                  : 'the live host matches main'}
              </div>
            </div>
          </div>

          <div className="pcdar-kv">
            <span className="pcdar-kv__k">deployed (:3070)</span>
            <span className="pcdar-kv__v" title={st.deployed?.sha}>
              {st.deployed ? st.deployed.shortSha : '—'}
            </span>
            <span className="pcdar-kv__k">deployed at</span>
            <span className="pcdar-kv__v">{formatRelative(st.deployedAtMs)}</span>
            <span className="pcdar-kv__k">deployed commit</span>
            <span className="pcdar-kv__v">{formatRelative(st.deployed?.committedAtMs)}</span>

            <span className="pcdar-kv__k">{st.releaseRef} (green pin)</span>
            <span className="pcdar-kv__v" title={st.ready?.sha}>
              {st.ready ? st.ready.shortSha : '— unset'}
            </span>
            <span className="pcdar-kv__k">{st.integrationBranch} HEAD</span>
            <span className="pcdar-kv__v" title={st.mainHead?.sha}>
              {st.mainHead ? st.mainHead.shortSha : '—'}
            </span>
          </div>

          <div className="pcdar-row">
            <div className="pcdar-row__main">
              <div className="pcdar-row__sub" style={{ fontFamily: 'inherit' }}>
                green pin vs {st.integrationBranch}
              </div>
            </div>
            {behindPill(st.readyBehindMain)}
          </div>
          <div className="pcdar-row">
            <div className="pcdar-row__main">
              <div className="pcdar-row__sub" style={{ fontFamily: 'inherit' }}>
                deployable but undeployed ({st.releaseRef} ahead of :3070)
              </div>
            </div>
            {st.deployedBehindReady == null ? (
              <span className="pcdar-pill">—</span>
            ) : st.deployedBehindReady === 0 ? (
              <span className="pcdar-pill is-good">none</span>
            ) : (
              <span className="pcdar-pill is-warn">{st.deployedBehindReady}</span>
            )}
          </div>

          {st.errors.length > 0 && (
            <div className="pcdar-panel__error">{st.errors.join(' · ')}</div>
          )}
        </>
      )}
    </div>
  );
}
