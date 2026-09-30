'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createResilientEventSource } from '@papercusp/sse';
import { ALL_FLAG_KEYS, FLAGS, type FlagKey, type FlagValues } from '@papercusp/flags';
import { Tooltip } from '@/app/harness/Tooltip';
import { toast } from 'sonner';
import { useLexicon } from '@/lib/useLexicon';
import type { BoundLexicon } from '@papercusp/lexicon';

/**
 * Interactive feature-flag console. Lets admins:
 *   - Apply preset modes ("V1 Production" / "Full testing") in one click
 *   - Toggle `testingFeatures` (master switch — operator phones home or not)
 *   - Flip individual flags in PostHog when in testing mode
 *
 * Source of truth:
 *   - testingFeatures lives in ~/.papercusp/posthog.json
 *   - individual flag values live in PostHog at flags.papercuspai.com
 * Both are fetched live via the operator's flag-bus.
 */

// Labels/blurbs are built at render through the lexicon (`t`) so the
// project-meaning "harness" strings render as the active brand term ("Hive").
// They are NOT module-level consts — a hook can't run at module scope.
function flagLabels(t: BoundLexicon): Partial<Record<FlagKey, string>> {
  return {
    [FLAGS.CLOUDFLARE_PUBLISH]: 'Cloudflare publishing',
    [FLAGS.HARNESS_PHASES]: `${t('pot')} phases`,
    [FLAGS.DESIGN]: 'Design tab',
    [FLAGS.TRIGGERS_ADMIN]: 'External triggers admin',
    // WI-37561. An unlabelled flag falls back to its raw wire key
    // (`labels[key] ?? key`), so it is still listed and still togglable — but
    // "papercusp-conversations-rail-tab" is not a thing an owner scans a list
    // for. This flag in particular is one the OWNER asked for in order to flip
    // it themselves, so a findable name is part of the feature, not polish.
    [FLAGS.CONVERSATIONS_RAIL_TAB]: 'Convos tab (middle rail)',
    [FLAGS.TESTING]: 'Testing surfaces',
    [FLAGS.INBOX_DURABLE_ESCALATIONS]: 'Durable inbox escalations',
    [FLAGS.IMPROVEMENT_AUTO_IMPLEMENT]: 'Auto-implement improvements',
    [FLAGS.VIDEO_CHANNELS]: 'Video channels (desktop)',
    [FLAGS.VOICE_CHANNELS]: 'Voice channels (desktop)',
    [FLAGS.THE_HIVE]: 'The Swarm (bee lexicon)',
    [FLAGS.OPEN_SIGNUP]: 'Open signup',
    [FLAGS.ENDPOINT_AUTH_TIERS]: 'Endpoint auth tiers',
    [FLAGS.ACCEPT_DELEGATED_SEATS]: 'Accept delegated seats',
  };
}

function flagBlurbs(t: BoundLexicon): Partial<Record<FlagKey, string>> {
  return {
    [FLAGS.CLOUDFLARE_PUBLISH]: 'Publish-to-Cloudflare flow. Cut for V1 ship.',
    [FLAGS.CONVERSATIONS_RAIL_TAB]:
      'The 💬 Convos tab in the middle steering rail. OFF (default): the rail ends at Spend. ON: Convos returns to its owner-set last position. Nothing is lost while it is off — /adv keeps its own Conversations tab on the same data.',
    [FLAGS.HARNESS_PHASES]: `Multi-phase ${t('pot')} (staging / testing / production). Cut for V1 ship.`,
    [FLAGS.DESIGN]: `In-${t('pot')} design tab + /design route. Cut for V1 ship.`,
    [FLAGS.TRIGGERS_ADMIN]:
      'Owner-local /admin/triggers surface for source health, plan bindings, deliberate arm/disarm, storm policy, and recent runs.',
    [FLAGS.TESTING]:
      'Testing-only surfaces: pi tab, + add plugin button, Oracle assistant (tutorial dock + menubar button + /api/oracle). Cut for V1 ship.',
    [FLAGS.INBOX_DURABLE_ESCALATIONS]:
      'Mirror chat decision cards to durable coord escalations (answer live or from the inbox).',
    [FLAGS.IMPROVEMENT_AUTO_IMPLEMENT]:
      'Master switch for auto-implementing captured improvements. Off = capture + triage only.',
    [FLAGS.VIDEO_CHANNELS]:
      `Desktop P2P video channel (participant-grid) for shared ${t('pot', { plural: true, lower: true })}. Off until the live-camera E2E passes.`,
    [FLAGS.VOICE_CHANNELS]:
      `Desktop P2P voice channel (holepunch) for shared ${t('pot', { plural: true, lower: true })}. Off until the live Tauri+mic pass.`,
    [FLAGS.THE_HIVE]:
      'Bee-themed user-facing lexicon, internal/testing skin (Pot→Hive, Fleet→Colony, Papercup→Sentinel, Mug→Queen, Cup→Bee, Humans→Keepers; Swarm = a deployment). Presentation only — code/DB/tools unchanged. Off = classic Papercusp (the public one-identity lexicon, voice-release D-001).',
    [FLAGS.OPEN_SIGNUP]:
      'Allow new account signup after the first user exists. Off (default): the internet-facing /auth/signup only bootstraps the first account — security gate, deliberate default-OFF.',
    [FLAGS.ENDPOINT_AUTH_TIERS]:
      'Enforce loopback-tier routes at the dispatch chokepoint (auth-tier Wave 1: mutating routes reject non-loopback hosts). Off = emergency revert to pre-rollout behavior.',
    [FLAGS.ACCEPT_DELEGATED_SEATS]:
      'Let a REMOTE fleet owner spawn agents on THIS host (delegated agent seats — agent-allocation P-008). Off (default): this host honors no delegated-seat spawn requests. On: opt in to run agents delegated by fleets you belong to, bounded by this host’s capability envelope + the seat count/account/budget caps. A trust decision — enable only for owners you intend to contribute capacity to.',
  };
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; testingFeatures: boolean; source: string; flags: FlagValues };

export default function FeaturesAdmin() {
  const t = useLexicon();
  const labels = useMemo(() => flagLabels(t), [t]);
  const blurbs = useMemo(() => flagBlurbs(t), [t]);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [statusRes, flagsRes] = await Promise.all([
        fetch('/api/flags/testing-features', { cache: 'no-store' }),
        fetch('/api/flags/bootstrap', { cache: 'no-store' }),
      ]);
      if (!statusRes.ok) throw new Error(`HTTP ${statusRes.status} on /api/flags/testing-features`);
      if (!flagsRes.ok) throw new Error(`HTTP ${flagsRes.status} on /api/flags/bootstrap`);
      const status = (await statusRes.json()) as { testingFeatures: boolean; source: string };
      const flagsPayload = (await flagsRes.json()) as { flags: FlagValues };
      setState({
        kind: 'ok',
        testingFeatures: status.testingFeatures,
        source: status.source,
        flags: flagsPayload.flags,
      });
    } catch (e) {
      setState({ kind: 'error', message: String((e as Error)?.message ?? e) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Subscribe to the flag-bus SSE so this page reflects live flag flips
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const source = createResilientEventSource({
      url: '/api/flags/stream',
      withCredentials: true,
      // WI-2141694: the safest yield candidate in the app — /api/flags/stream is
      // replay-backed (ring buffer + Last-Event-ID, with a `resync` → full
      // refetch fallback), AND both handlers below are a bare refresh(), so this
      // stream accumulates no state of its own. Lowest priority: an admin page's
      // flag ticker should step aside before anything else on the page.
      yieldOnContention: true,
      streamPriority: -20,
      handlers: {
        flag_changed: () => void refresh(),
        flags_payload: () => void refresh(),
      },
    });
    return () => source.close();
  }, [refresh]);

  async function applyPreset(name: 'production' | 'testing') {
    setBusy(`preset:${name}`);
    try {
      const res = await fetch('/api/flags/preset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      toast.success(name === 'production' ? 'Switched to V1 Production' : 'Switched to Full testing');
      await refresh();
    } catch (e) {
      toast.error('Failed to apply preset', { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function toggleTesting(next: boolean) {
    setBusy('testing-features');
    try {
      const res = await fetch('/api/flags/testing-features', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      await refresh();
      toast.success(next ? 'testingFeatures enabled' : 'testingFeatures disabled');
    } catch (e) {
      toast.error('Failed to update testingFeatures', { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function toggleFlag(key: FlagKey, next: boolean) {
    setBusy(`flag:${key}`);
    try {
      const res = await fetch('/api/flags/set', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, enabled: next }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      await refresh();
    } catch (e) {
      toast.error(`Failed to update ${labels[key] ?? key}`, { description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  if (state.kind === 'loading') {
    return <div className="fa-shell"><div className="fa-spinner">Loading…</div></div>;
  }
  if (state.kind === 'error') {
    return <div className="fa-shell"><div className="fa-error">Failed to load: {state.message}</div></div>;
  }

  const testingOn = state.testingFeatures;
  const effective = state.flags;

  return (
    <div className="fa-shell">
      {/* Preset row */}
      <section className="fa-section">
        <h2 className="fa-h2">Preset</h2>
        <p className="fa-p">
          One-click swap between V1 ship state and the full testing build.
        </p>
        <div className="fa-presets">
          <button
            type="button"
            className={`fa-preset${!testingOn ? ' active' : ''}`}
            disabled={busy !== null}
            onClick={() => applyPreset('production')}
          >
            <span className="fa-preset-emoji">🚀</span>
            <span className="fa-preset-title">V1 Production</span>
            <span className="fa-preset-blurb">
              testingFeatures = false · bundled defaults serve everything · zero PostHog contact
            </span>
            {busy === 'preset:production' && <span className="fa-preset-busy">…</span>}
          </button>
          <button
            type="button"
            className={`fa-preset${testingOn ? ' active' : ''}`}
            disabled={busy !== null}
            onClick={() => applyPreset('testing')}
          >
            <span className="fa-preset-emoji">🧪</span>
            <span className="fa-preset-title">Full testing</span>
            <span className="fa-preset-blurb">
              testingFeatures = true · all flags flipped on in PostHog
            </span>
            {busy === 'preset:testing' && <span className="fa-preset-busy">…</span>}
          </button>
        </div>
      </section>

      {/* Master switch */}
      <section className="fa-section">
        <h2 className="fa-h2">Master switch</h2>
        <div className="fa-master">
          <div className="fa-master-text">
            <strong>testingFeatures</strong>{' '}
            <span className={`fa-pill ${testingOn ? 'on' : 'off'}`}>
              {testingOn ? 'on' : 'off'}
            </span>
            <div className="fa-master-blurb">
              {testingOn
                ? 'Papercusp is phoning home to flags.papercuspai.com. Per-flag toggles below are live.'
                : 'Papercusp is using bundled defaults (most finished flags on by default). PostHog is not being contacted.'}
              <br />
              <span className="fa-source">Config source: {state.source}</span>
            </div>
          </div>
          <Tooltip
            label={testingOn ? 'Disable testingFeatures' : 'Enable testingFeatures'}
            side="top"
            align="end"
          >
            <button
              type="button"
              className={`fa-toggle${testingOn ? ' on' : ''}`}
              disabled={busy !== null}
              onClick={() => toggleTesting(!testingOn)}
              aria-pressed={testingOn}
            >
              <span className="fa-toggle-knob" />
            </button>
          </Tooltip>
        </div>
      </section>

      {/* Per-flag toggles */}
      <section className="fa-section">
        <h2 className="fa-h2">Per-flag toggles</h2>
        <p className="fa-p">
          Effective values shown reflect what the operator is currently serving.
          {!testingOn && <> When testingFeatures is off, toggles below have no effect — turn it on first.</>}
        </p>
        <div className="fa-flags">
          {ALL_FLAG_KEYS.map((key) => {
            const on = effective[key] ?? false;
            const label = labels[key] ?? key;
            const blurb = blurbs[key] ?? '';
            return (
              <div key={key} className={`fa-flag${!testingOn ? ' disabled' : ''}`}>
                <div className="fa-flag-main">
                  <div className="fa-flag-name">{label}</div>
                  <div className="fa-flag-blurb">{blurb}</div>
                  <div className="fa-flag-key">{key}</div>
                </div>
                <Tooltip
                  label={!testingOn ? 'Turn on testingFeatures first' : on ? 'Disable this flag' : 'Enable this flag'}
                  side="top"
                  align="end"
                >
                  <button
                    type="button"
                    className={`fa-toggle${on ? ' on' : ''}`}
                    disabled={!testingOn || busy !== null}
                    onClick={() => toggleFlag(key, !on)}
                    aria-pressed={on}
                  >
                    <span className="fa-toggle-knob" />
                  </button>
                </Tooltip>
              </div>
            );
          })}
        </div>
      </section>

      <style>{`
        .fa-shell {
          padding: 24px 24px 56px;
          max-width: 1060px;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .fa-section {
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding: 18px 18px 20px;
          border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 86%);
          border-radius: 16px;
          background:
            linear-gradient(180deg, color-mix(in srgb, var(--bg-1), transparent 6%), color-mix(in srgb, var(--bg-deep), transparent 2%));
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.035),
            0 18px 34px rgba(0,0,0,0.18);
        }
        .fa-h2 {
          margin: 0;
          font-size: 11px;
          font-weight: 760;
          color: rgba(203, 238, 255, 0.76);
          letter-spacing: 0;
          text-transform: uppercase;
        }
        .fa-p {
          margin: 0;
          color: rgba(214, 236, 248, 0.72);
          font-size: 13px;
          line-height: 1.55;
        }
        .fa-presets { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 4px; }
        .fa-preset {
          display: flex; flex-direction: column; gap: 6px;
          padding: 18px 16px; min-height: 110px;
          border-radius: 14px;
          background: color-mix(in srgb, var(--bg-deep), transparent 8%);
          border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 84%);
          color: #eff8ff;
          text-align: left;
          cursor: pointer;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
          transition: background 120ms, border-color 120ms, transform 120ms;
        }
        .fa-preset:hover:not(:disabled) {
          background: color-mix(in srgb, var(--bg-1), transparent 2%);
          border-color: rgb(from var(--accent-strong) r g b / 0.30);
          transform: translateY(-1px);
        }
        .fa-preset.active {
          background: linear-gradient(180deg, color-mix(in srgb, var(--bg-raised), transparent 2%), color-mix(in srgb, var(--bg-1), transparent 1%));
          border-color: rgb(from var(--accent-strong) r g b / 0.42);
        }
        .fa-preset:disabled { opacity: 0.62; cursor: progress; }
        .fa-preset-emoji { font-size: 20px; }
        .fa-preset-title { font-size: 16px; font-weight: 700; }
        .fa-preset-blurb { font-size: 12px; color: rgba(205, 226, 240, 0.76); line-height: 1.5; }
        .fa-preset-busy { font-size: 11px; color: color-mix(in srgb, var(--accent-soft), transparent 36%); }
        .fa-master,
        .fa-flag {
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 14px 16px;
          border-radius: 14px;
          background: color-mix(in srgb, var(--bg-deep), transparent 12%);
          border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 86%);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.025);
        }
        .fa-master-text,
        .fa-flag-main { flex: 1; min-width: 0; }
        .fa-master-blurb { color: rgba(205, 226, 240, 0.74); font-size: 12px; line-height: 1.5; margin-top: 6px; }
        .fa-source,
        .fa-flag-key { color: rgba(148, 163, 184, 0.78); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
        .fa-pill {
          display: inline-block; padding: 2px 8px; border-radius: 999px;
          font-size: 10px; font-weight: 760; text-transform: uppercase; letter-spacing: 0;
          margin-left: 8px;
        }
        .fa-pill.on  { background: rgba(34, 197, 94, 0.18); color: #86efac; }
        .fa-pill.off { background: rgba(148, 163, 184, 0.18); color: rgba(214, 236, 248, 0.72); }
        .fa-flags { display: flex; flex-direction: column; gap: 10px; margin-top: 6px; }
        .fa-flag.disabled { opacity: 0.62; }
        .fa-flag-name { font-size: 14px; font-weight: 650; color: #eff8ff; }
        .fa-flag-blurb { color: rgba(205, 226, 240, 0.76); font-size: 12px; line-height: 1.5; margin-top: 2px; }
        .fa-toggle {
          flex: 0 0 auto;
          width: 42px; height: 24px;
          padding: 2px;
          border-radius: 999px;
          background: rgba(255,255,255,0.08);
          border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 82%);
          position: relative; cursor: pointer;
          transition: background 120ms, border-color 120ms, transform 120ms;
        }
        .fa-toggle.on {
          background: color-mix(in srgb, var(--accent), transparent 66%);
          border-color: rgb(from var(--accent-strong) r g b / 0.46);
        }
        .fa-toggle:hover:not(:disabled) {
          border-color: rgb(from var(--accent-strong) r g b / 0.36);
        }
        .fa-toggle:disabled { cursor: not-allowed; }
        .fa-toggle-knob {
          display: block; width: 18px; height: 18px;
          border-radius: 50%;
          background: #f3fbff;
          transform: translateX(0);
          transition: transform 120ms;
          box-shadow: 0 2px 8px rgba(0,0,0,0.24);
        }
        .fa-toggle.on .fa-toggle-knob { transform: translateX(18px); }
        .fa-error,
        .fa-spinner {
          padding: 16px 18px;
          border-radius: 14px;
          border: 1px solid color-mix(in srgb, var(--accent-strong), transparent 86%);
          background: color-mix(in srgb, var(--bg), transparent 6%);
        }
        .fa-error { color: #fda4af; }
        .fa-spinner { color: rgba(214, 236, 248, 0.72); }
        @media (max-width: 880px) {
          .fa-presets { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}
