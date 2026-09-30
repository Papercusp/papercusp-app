import { useId, useState } from 'react';
import { useSyncQuery } from '@papercusp/sync';
import { useFlag } from '@papercusp/flags/client';
import { FLAGS } from '@papercusp/flags';
import { Button } from '@/app/harness/Button';
import { Checkbox } from '@/app/harness/Checkbox';
import type { DreamControlSnapshot } from '@papercusp/operator-core/lib/dream/dream-control';
import { runAgentTool } from './run-tool';

type DreamControlProps = {
  potSlug: string;
  compact?: boolean;
  potLabel?: string;
  learningPaused?: boolean;
  onWrote?: () => void;
};

function DreamControlBody({ potSlug, compact, potLabel = potSlug, learningPaused, onWrote }: DreamControlProps) {
  const query = useSyncQuery<DreamControlSnapshot>({
    queryName: 'learning.dream', args: { potSlug, ...(compact ? { mode: 'auto' } : {}) }, enabled: Boolean(potSlug),
  });
  const row = query.data?.[0];
  const snapshot = query.error || row?.potSlug !== potSlug ? undefined : row;
  const hintId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = async (mode: 'manual' | 'auto', enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await runAgentTool('dream:control', { pot: potSlug, mode, enabled });
      query.invalidate();
      onWrote?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const last = snapshot?.lastCycle;
  if (compact) {
    const enabled = snapshot?.automatic.enabled === true;
    const hint = error ?? (!snapshot
      ? query.loading ? 'Loading…' : 'Unavailable'
      : learningPaused ? 'Learning paused'
      : snapshot.blocker ?? (enabled ? 'On when idle' : 'Off'));
    return (
      <div className="pc-lloop__potdream">
        <span className="pc-lloop__togglelabel">Dreaming</span>
        {snapshot ? (
          <span className="pc-lloop__sw">
            <input
              type="checkbox"
              role="switch"
              checked={enabled}
              disabled={busy || !snapshot.automatic.available || (!enabled && (Boolean(snapshot.blocker) || learningPaused))}
              aria-label={`${enabled ? 'Switch off' : 'Switch on'} dreaming for ${potLabel}`}
              aria-describedby={hintId}
              onChange={() => void change('auto', !enabled)}
            />
            <span className="pc-lloop__swtrack" aria-hidden />
            <span className="pc-lloop__swthumb" aria-hidden />
          </span>
        ) : (
          <button type="button" className="pc-lloop__potfix" disabled={query.loading}
            aria-label={`Retry Dreaming controls for ${potLabel}`} onClick={() => query.invalidate()}>Retry</button>
        )}
        <span id={hintId} className="pc-lloop__togglehint" role={error ? 'alert' : 'status'}>{hint}</span>
      </div>
    );
  }
  return (
    <section aria-label="Dream" className="pc-dream-control" data-testid="dream-control">
      <h3>Dream</h3>
      <p>Combine code capabilities into proposals for independent review.</p>
      {!snapshot ? (
        <p role="status">{query.loading ? 'Loading Dream controls…' : 'Dream controls could not be read.'} <Button onClick={() => query.invalidate()}>Retry</Button></p>
      ) : (
        <>
          <div className="pc-dream-control__row">
            <span>Manual dreaming: {snapshot.manual.active ? last?.mode === 'manual' && last.running ? 'running' : 'scheduled' : 'paused'}</span>
            <Button
              variant={snapshot.manual.active ? 'neutral' : 'primary'}
              disabled={busy || !snapshot.manual.available || (!snapshot.manual.active && Boolean(snapshot.blocker))}
              onClick={() => void change('manual', !snapshot.manual.active)}
            >{snapshot.manual.active ? 'Pause manual dreaming' : 'Start manual dreaming'}</Button>
          </div>
          <label className="pc-dream-control__row">
            <Checkbox
              ariaLabel="Auto-dream"
              checked={snapshot.automatic.enabled}
              disabled={busy || !snapshot.automatic.available || (!snapshot.automatic.enabled && Boolean(snapshot.blocker))}
              onChange={(enabled) => void change('auto', enabled)}
            />
            <span>Auto-dream: {snapshot.automatic.enabled ? 'on' : 'off'}</span>
          </label>
          <p className="pc-dream-control__hint">Auto-dream runs when idle. Manual Start and Pause leave this setting unchanged. Pausing stops before the next phase; a call already in progress may finish.</p>
          {snapshot.blocker ? <p role="status">{snapshot.blocker}</p> : null}
          <p>Admission limits: {snapshot.limits.attempts} attempts and ${snapshot.limits.cycleUsd.toFixed(2)} per cycle. Workspace last 24 hours: ${snapshot.rollingAccountedUsd.toFixed(2)} / ${snapshot.limits.rollingUsd.toFixed(2)}. Calls already in progress may exceed their cost estimates; actual costs are recorded.</p>
          {last ? (
            <div role="status" data-testid="dream-last-cycle">
              <strong>{last.running ? 'Current cycle' : 'Last cycle'}</strong>
              <p>{last.attempts} attempts · {last.accepted} accepted {last.accepted === 1 ? 'proposal' : 'proposals'} · ${last.costUsd.toFixed(2)} accounted</p>
              <p>{last.reason}</p>
              {last.reason.includes('no-pair') || last.reason.includes('packet') ? <p>Check that this pot’s repository has current capability sources and tests.</p> : null}
              {last.reason.includes('review') || last.reason.includes('error') ? <p>Check the source and reviewer configuration, then pause and start a new cycle. Previous outcomes and charges are preserved.</p> : null}
            </div>
          ) : <p>No Dream cycle has run for this pot.</p>}
          <p className="pc-dream-control__hint">Accounted cost includes reservations whose final provider bill is not yet known. Admission limits cannot guarantee the final bill.</p>
        </>
      )}
      {error ? <p role="alert">{error}</p> : null}
      <style>{`
        .pc-dream-control { border: 1px solid var(--border); border-radius: 10px; padding: 12px; background: var(--bg-1); color: var(--fg); }
        .pc-dream-control h3 { margin: 0 0 6px; font-size: 14px; }
        .pc-dream-control p { margin: 6px 0; font-size: 12px; overflow-wrap: anywhere; }
        .pc-dream-control__row { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin: 10px 0; font-size: 12px; }
        .pc-dream-control__hint { color: var(--fg-mute); }
        .pc-dream-control [role=alert] { color: var(--bad); }
      `}</style>
    </section>
  );
}

export default function DreamControl(props: DreamControlProps) {
  const enabled = useFlag(FLAGS.DREAM_CYCLE);
  return enabled && props.potSlug ? <DreamControlBody key={props.potSlug} {...props} /> : null;
}
