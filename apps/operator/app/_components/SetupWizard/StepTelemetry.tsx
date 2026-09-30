'use client';

import * as Collapsible from '@radix-ui/react-collapsible';
import { useEffect, useState } from 'react';
import { commands } from '@papercusp/operator-core/lib/tauri-bindings';
import { isTauri } from './tauri-detect';

interface FlushResult {
  archived: number;
  forwarded: number;
  forwardFailed: number;
  retentionDeleted: number;
  posthogConfigured: boolean;
  internalBuild: boolean;
  optedIn: boolean;
}

type Choice = 'undecided' | 'yes' | 'no';

export function StepTelemetry() {
  const [choice, setChoice] = useState<Choice>('undecided');
  const [tauri, setTauri] = useState(false);
  const [testing, setTesting] = useState(false);
  const [flushing, setFlushing] = useState(false);
  const [lastTest, setLastTest] = useState<string | null>(null);
  const [lastFlush, setLastFlush] = useState<FlushResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTauri(isTauri());
    void (async () => {
      try {
        const r = await fetch('/api/desktop/setup-wizard-state', { cache: 'no-store' });
        const j = await r.json();
        if (j.telemetry_enabled === true) setChoice('yes');
        else if (j.telemetry_enabled === false) setChoice('no');
      } catch { /* keep undecided */ }
    })();
  }, []);

  const patch = async (body: Record<string, unknown>) => {
    await fetch('/api/desktop/setup-wizard-state', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  const accept = async () => {
    setChoice('yes');
    await patch({ telemetry_enabled: true });
  };

  const decline = async () => {
    setChoice('no');
    await patch({ telemetry_enabled: false });
  };

  const reconsider = () => {
    setChoice('undecided');
  };

  const sendTest = async () => {
    setTesting(true);
    setError(null);
    setLastTest(null);
    try {
      let appVersion: string | undefined;
      if (tauri) {
        try { appVersion = await commands.appVersion(); } catch { /* best effort */ }
      }
      const res = await fetch('/api/desktop/telemetry-report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'test',
          app_version: appVersion,
          os: typeof navigator !== 'undefined' ? navigator.platform : undefined,
          payload: { source: 'setup-wizard', triggered_at: new Date().toISOString() },
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setLastTest(new Date().toISOString());
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setTesting(false);
    }
  };

  const flushNow = async () => {
    setFlushing(true);
    setError(null);
    try {
      const res = await fetch('/api/desktop/telemetry-flush', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = (await res.json()) as FlushResult;
      setLastFlush(result);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setFlushing(false);
    }
  };

  // ── 1. Decision pending (default state on first visit) ─────────────
  if (choice === 'undecided') {
    return (
      <div className="pc-step">
        <div className="pc-consent">
          <p className="pc-consent__status">
            <strong>Telemetry is currently OFF.</strong> Nothing is sent off your machine.
          </p>

          <h3 className="pc-consent__heading">What this would do</h3>
          <p>
            If you opt in, Papercusp will send a small amount of diagnostic data to a PostHog
            instance we operate. The purpose is to find bugs in alpha builds — we get to see when
            something crashes for a real user, not just when one of us reproduces it locally.
          </p>

          <h3 className="pc-consent__heading">What gets sent</h3>
          <ul className="pc-consent__list">
            <li>
              <strong>Crash and error reports</strong>: the JavaScript stack trace and a 64-byte
              kind label (e.g. <code>crash</code>, <code>migration_failed</code>).
            </li>
            <li>
              <strong>App version + OS</strong> (e.g. <code>0.0.1</code> / <code>linux</code>).
            </li>
            <li>
              <strong>Anonymous workspace ID</strong> — a random local identifier (default:{' '}
              <code>default</code>). Not tied to your name, email, or account.
            </li>
            <li>
              <strong>Page views in the operator UI</strong> (which routes you visit) and{' '}
              <strong>UI element clicks</strong> (PostHog autocapture).
            </li>
          </ul>

          <h3 className="pc-consent__heading">What does NOT get sent</h3>
          <ul className="pc-consent__list">
            <li>API keys, OAuth tokens, or any credentials.</li>
            <li>Source code, file contents, project paths, or anything from your harnesses.</li>
            <li>Prompts, agent outputs, or conversation history.</li>
            <li>Your email, name, IP, or any account information.</li>
            <li>Session recordings (we explicitly disable PostHog's session-replay feature).</li>
          </ul>

          <h3 className="pc-consent__heading">Where it goes</h3>
          <p>
            A PostHog instance operated by the Papercusp maintainers — not PostHog Cloud, not any
            third-party SaaS. Power users can override the destination by setting{' '}
            <code>PAPERCUSP_POSTHOG_HOST</code> / <code>PAPERCUSP_POSTHOG_KEY</code>.
          </p>

          <h3 className="pc-consent__heading">Reversibility</h3>
          <p>
            You can turn this off any time, from this screen, and forwarding stops immediately on
            the next flush tick. Local archived reports stay on your machine (in your embedded
            Postgres) and roll off after 30 days regardless.
          </p>

          <div className="pc-consent__actions">
            <button type="button" className="pc-btn pc-btn--primary" onClick={() => void accept()}>
              Yes, opt in
            </button>
            <button type="button" className="pc-btn" onClick={() => void decline()}>
              No, keep it off
            </button>
          </div>
          <p className="pc-step__hint">
            Either choice is fine. The app is fully functional with telemetry off; we just lose
            visibility into bugs you hit.
          </p>
        </div>
      </div>
    );
  }

  // ── 2. User declined ──────────────────────────────────────────────
  if (choice === 'no') {
    return (
      <div className="pc-step">
        <div className="pc-step__progress" data-status="ok">
          <div className="pc-step__progress-dot" />
          <div className="pc-step__progress-text">
            <strong>Telemetry is off.</strong>
            <span>Nothing is sent off your machine. You can change your mind any time.</span>
          </div>
        </div>
        <div className="pc-step__actions">
          <button type="button" className="pc-btn" onClick={reconsider}>
            Reconsider…
          </button>
        </div>
      </div>
    );
  }

  // ── 3. User opted in ─────────────────────────────────────────────
  // Public host + projectKey are bundled, so opt-in alone flips
  // forwarding on at the next hourly flush.
  return (
    <div className="pc-step">
      <div className="pc-step__progress" data-status="ok">
        <div className="pc-step__progress-dot" />
        <div className="pc-step__progress-text">
          <strong>Telemetry is on.</strong>
          <span>Crash reports + autocapture are forwarded on each hourly flush.</span>
        </div>
      </div>

      <div className="pc-step__actions">
        <button type="button" className="pc-btn" onClick={() => void decline()}>
          Turn off
        </button>
      </div>

      <Collapsible.Root className="pc-consent__details">
        <Collapsible.Trigger asChild>
          <button type="button" className="pc-consent__summary">Diagnostics</button>
        </Collapsible.Trigger>
        <Collapsible.Content>
        <div className="pc-step__actions">
          <button type="button" className="pc-btn" onClick={() => void sendTest()} disabled={testing}>
            {testing ? 'Sending…' : 'Send test report'}
          </button>
          <button type="button" className="pc-btn" onClick={() => void flushNow()} disabled={flushing}>
            {flushing ? 'Flushing…' : 'Flush now'}
          </button>
          {lastTest && (
            <span className="pc-step__saved">Test recorded at {new Date(lastTest).toLocaleTimeString()}</span>
          )}
        </div>

        {lastFlush && (
          <div className="pc-step__progress" data-status={lastFlush.posthogConfigured ? 'ok' : 'missing'}>
            <div className="pc-step__progress-dot" />
            <div className="pc-step__progress-text">
              <strong>Flushed.</strong>
              <span>
                archived={lastFlush.archived} forwarded={lastFlush.forwarded} failed=
                {lastFlush.forwardFailed} retention-deleted={lastFlush.retentionDeleted}{' '}
                opted-in={String(lastFlush.optedIn)} internal-build=
                {String(lastFlush.internalBuild)} posthog-configured=
                {String(lastFlush.posthogConfigured)}
              </span>
            </div>
          </div>
        )}

        {error && (
          <div className="pc-step__progress" data-status="error">
            <div className="pc-step__progress-dot" />
            <div className="pc-step__progress-text">
              <strong>Failed.</strong>
              <span>{error}</span>
            </div>
          </div>
        )}
        </Collapsible.Content>
      </Collapsible.Root>

      <p className="pc-step__hint">
        Reports are also archived locally in <code>harness_shared.telemetry_reports_archive</code>{' '}
        with a 30-day retention. Even if you opt in, you can browse what's been sent off your
        machine.
      </p>
    </div>
  );
}
