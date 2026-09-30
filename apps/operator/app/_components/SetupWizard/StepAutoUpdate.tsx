'use client';

import { useEffect, useRef, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { commands } from '@papercusp/operator-core/lib/tauri-bindings';
import { isTauri } from './tauri-detect';

/**
 * Update LANES only. `nightly` is excluded deliberately — it is a side-by-side
 * install (own bundle id, own data home), not a lane this app can switch to.
 */
type Channel = 'alpha' | 'beta' | 'stable';

interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'up-to-date' | 'installing' | 'error';
  current?: string;
  new_version?: string;
  notes?: string;
  error?: string;
}

export function StepAutoUpdate() {
  const [channel, setChannel] = useState<Channel>('alpha');
  const [tauri, setTauri] = useState(false);
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle' });
  const pickedByUser = useRef(false);

  useEffect(() => {
    setTauri(isTauri());
    void (async () => {
      try {
        const r = await fetch('/api/desktop/setup-wizard-state', { cache: 'no-store' });
        const j = await r.json();
        // A user can pick a channel before the initial state request resolves.
        // Never let that stale response (or the fresh-install alpha write below)
        // overwrite the user's explicit choice.
        if (pickedByUser.current) return;
        if (j.update_channel === 'alpha' || j.update_channel === 'beta' || j.update_channel === 'stable') {
          setChannel(j.update_channel);
        } else {
          // No channel persisted yet (fresh install). PERSIST the shown default
          // ('alpha', recommended while the app is in alpha) so the updater's
          // server-side channel resolution actually sees it. Otherwise an onboarding
          // step that was merely VIEWED (not clicked) never pins the choice, the
          // manifest falls back, and a default install is silently never offered an
          // alpha release (WI-4389).
          setChannel('alpha');
          await fetch('/api/desktop/setup-wizard-state', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ update_channel: 'alpha' }),
          });
        }
      } catch {
        // keep default
      }
    })();
  }, []);

  const pick = async (c: Channel) => {
    pickedByUser.current = true;
    setChannel(c);
    try {
      await fetch('/api/desktop/setup-wizard-state', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ update_channel: c }),
      });
    } catch {
      // ignore
    }
  };

  const checkNow = async () => {
    if (!tauri) return;
    setUpdate({ status: 'checking' });
    try {
      const result = await commands.checkForUpdate();
      if (result.status === 'error') {
        setUpdate({ status: 'error', error: result.error });
        return;
      }
      const info = result.data;
      if (info.available) {
        setUpdate({
          status: 'available',
          current: info.current_version,
          new_version: info.new_version ?? undefined,
          notes: info.notes ?? undefined,
        });
      } else if (info.check_failed) {
        // Not the same as "up to date": we never reached the release host, so we
        // do not actually know whether a newer version exists. Saying "you're
        // current" here would be a guess dressed up as a fact.
        setUpdate({
          status: 'error',
          error: `Couldn't reach the release host${
            info.check_reason ? ` (${info.check_reason})` : ''
          } — update status unknown.`,
        });
      } else {
        setUpdate({ status: 'up-to-date', current: info.current_version });
      }
    } catch (e: any) {
      setUpdate({ status: 'error', error: e?.message ?? String(e) });
    }
  };

  const installNow = async () => {
    if (!tauri) return;
    setUpdate({ ...update, status: 'installing' });
    try {
      const result = await commands.installUpdate();
      if (result.status === 'error') {
        setUpdate({ ...update, status: 'error', error: result.error });
      }
      // success: app will restart, this code unreachable
    } catch (e: any) {
      setUpdate({ ...update, status: 'error', error: e?.message ?? String(e) });
    }
  };

  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        Which release channel should Papercusp auto-update from? You can change this any time. While
        the app is in alpha, the alpha channel is recommended.
      </p>
      <div className="pc-radio-grid" role="radiogroup" aria-label="Release channel">
        {(['alpha', 'beta', 'stable'] as const).map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={c === channel}
            className="pc-radio-card"
            data-active={c === channel ? 'true' : undefined}
            onClick={() => void pick(c)}
          >
            <div>
              <div className="pc-radio-card__title">{c[0].toUpperCase() + c.slice(1)}</div>
              <div className="pc-radio-card__sub">
                {c === 'alpha' && 'Latest fixes, fastest cadence, may have rough edges.'}
                {c === 'beta' && 'Newer features, sanity-checked. Updated weekly-ish.'}
                {c === 'stable' && 'Conservative. Updated when a release is ready for everyone.'}
              </div>
            </div>
          </button>
        ))}
      </div>

      {tauri ? (
        <div className="pc-step__actions">
          <button
            type="button"
            className="pc-btn pc-btn--primary"
            onClick={() => void checkNow()}
            disabled={update.status === 'checking' || update.status === 'installing'}
          >
            {update.status === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>
          {(update.status === 'available' || update.status === 'installing') && (
            <button
              type="button"
              className="pc-btn"
              onClick={() => void installNow()}
              disabled={update.status === 'installing'}
            >
              {update.status === 'installing' ? 'Installing…' : `Install ${update.new_version}`}
            </button>
          )}
        </div>
      ) : (
        <p className="pc-step__hint">Update controls appear here when running inside the desktop app.</p>
      )}

      {update.status === 'up-to-date' && (
        <div className="pc-step__progress" data-status="ok">
          <div className="pc-step__progress-dot" />
          <div className="pc-step__progress-text">
            <strong>Up to date.</strong>
            <span>Running v{update.current}.</span>
          </div>
        </div>
      )}
      {update.status === 'available' && (
        <div className="pc-step__progress" data-status="ok">
          <div className="pc-step__progress-dot" />
          <div className="pc-step__progress-text">
            <strong>Update available.</strong>
            <span>v{update.current} → v{update.new_version}</span>
          </div>
        </div>
      )}
      {update.status === 'error' && (
        <div className="pc-step__progress" data-status="error">
          <div className="pc-step__progress-dot" />
          <div className="pc-step__progress-text">
            <strong>Couldn't check.</strong>
            <span>{update.error}</span>
          </div>
        </div>
      )}
      {update.notes && (
        <Collapsible.Root className="pc-release-notes">
          <Collapsible.Trigger>Release notes</Collapsible.Trigger>
          <Collapsible.Content>
          <pre>{update.notes}</pre>
          </Collapsible.Content>
        </Collapsible.Root>
      )}

      <p className="pc-step__hint">
        Your channel choice is saved server-side and honored by the update manifest — the updater
        only offers releases from the channel you pick here. While the app is in alpha, a fresh
        install defaults to the alpha channel so auto-update works out of the box.
      </p>
    </div>
  );
}
