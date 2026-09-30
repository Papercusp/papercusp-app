'use client';

import { useQueryState } from 'nuqs';
import { useRouter } from '@/lib/router-compat/navigation';
import { useEffect, useMemo, useState } from 'react';
import { SETUP_STEPS, findStep } from './steps';
import type { StepStatus } from './types';
import { StepAgents } from './StepAgents';
import { StepAutoUpdate } from './StepAutoUpdate';
import { StepBackups } from './StepBackups';
import { StepEmbeddedPg } from './StepEmbeddedPg';
import { StepGit } from './StepGit';
import { StepKeys } from './StepKeys';
import { StepLocalModel } from './StepLocalModel';
import { StepLogins } from './StepLogins';
import { StepMobilePairing } from './StepMobilePairing';
import { StepOsPermissions } from './StepOsPermissions';
import { StepPlaceholder } from './StepPlaceholder';
import { StepTelemetry } from './StepTelemetry';
import { StepWelcome } from './StepWelcome';
import { StepWorkspace } from './StepWorkspace';
import { useWizardStatuses } from './useWizardStatuses';
import { BootstrapFinishGate } from './BootstrapFinishGate';
import { useDogfoodBootstrapProgress } from '../useDogfoodBootstrapProgress';

interface Props {
  readonly mode: 'first-run' | 'settings';
}

export function SetupWizard({ mode }: Props) {
  const router = useRouter();
  const { statuses, persisted, refreshAll, setLastVisitedStep } =
    useWizardStatuses();
  const [stepId, setStepId] = useQueryState('step');
  const [finishing, setFinishing] = useState(false);
  const [recap, setRecap] = useState<null | { dest: string }>(null);
  // Dogfood clone-on-first-boot gate (desktop UI part B): when the user hits
  // Finish but the Papercusp workspace is still downloading, we BLOCK on
  // `gating` (the finish view → BootstrapFinishGate) and auto-advance to the
  // recap the moment the flow is ready. `dest` is the already-computed landing
  // route so the gate's onReady can finalize without recomputing.
  const [gating, setGating] = useState<null | { dest: string }>(null);
  const bootstrap = useDogfoodBootstrapProgress({ enabled: mode === 'first-run' });

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (stepId) void setLastVisitedStep(stepId);
  }, [stepId, setLastVisitedStep]);

  // First-run mode owns the landing screen. A direct `/setup` visit should
  // show it every time; deep links (`?step=...`) still jump into a step.
  // Settings mode starts directly on the first/last visited step.
  const showWelcome = mode === 'first-run' && !stepId;
  const active = useMemo(
    () => findStep(stepId) ?? findStep(persisted.last_visited_step) ?? SETUP_STEPS[0],
    [stepId, persisted.last_visited_step],
  );

  // Minimum to finish setup: embedded-pg ready + ≥1 coding agent
  // installed. Sign-in is deliberately NOT gating (owner call,
  // 2026-06-12): a login can happen later from Settings or a terminal,
  // and API keys are an alternative credential path — agents won't run
  // until one exists, but the wizard shouldn't hold the app hostage.
  // Workspace path is recorded server-side regardless of wizard
  // interaction (default `~/.papercusp/projects/` always works), so it
  // isn't part of the gate.
  //
  // `minimumMet` only governs the PRIMARY "Finish" affordance; even when
  // it's false a "Skip for now" escape always finishes the wizard. The
  // wizard must never trap a machine that can't (yet) satisfy the gate —
  // app/page.tsx hard-redirects `/` → `/setup` until `finished_at` is set,
  // so a gated-with-no-escape footer is a dead end (a fresh box with no
  // coding agent, or an older build that still gated sign-in).
  const minimumMet =
    statuses['embedded-pg'] === 'ok' && statuses['agents'] === 'ok';

  const idx = SETUP_STEPS.findIndex((s) => s.id === active.id);

  const stepCount = SETUP_STEPS.length;
  const currentStepNumber = Math.max(idx, 0) + 1;
  const progressPct = Math.round((currentStepNumber / stepCount) * 100);
  const hasNextStep = idx < SETUP_STEPS.length - 1;
  const goNext = () => {
    if (idx + 1 < SETUP_STEPS.length) setStepId(SETUP_STEPS[idx + 1].id);
  };
  const goPrev = () => {
    if (idx - 1 >= 0) setStepId(SETUP_STEPS[idx - 1].id);
  };

  const finishWizard = async () => {
    setFinishing(true);
    const markFinished = fetch('/api/desktop/setup-wizard-state', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ finished_at: new Date().toISOString() }),
    }).catch(() => null);

    if (mode === 'first-run') {
      // Land on /cupboard (the storefront) when the workspace is empty —
      // landing on /harness with no harnesses is a confusing dead-end. Once at
      // least one harness exists, /harness is the right home. (The legacy
      // /marketplace was retired — revive-cupboard-distribution D-004.)
      let dest = '/harness';
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1500);
        try {
          const r = await fetch('/api/installed', {
            cache: 'no-store',
            signal: controller.signal,
          });
          if (r.ok) {
            const j = (await r.json()) as { projects?: unknown[] };
            const count = Array.isArray(j.projects) ? j.projects.length : 0;
            if (count === 0) dest = '/cupboard';
          }
        } finally {
          clearTimeout(timeout);
        }
      } catch {
        // Timeout/network failure → fall through to /harness.
      }
      // Gate on the dogfood clone-on-first-boot (desktop UI part B): if the
      // Papercusp workspace is still downloading, BLOCK on the finish gate
      // rather than dropping the user into an app whose default hive isn't
      // there yet. The gate auto-advances (→ proceedToRecap) the moment the
      // flow is ready; an empty/degraded sync surfaces a soft Retry, never a
      // permanent block. When already ready, fall straight through to the recap.
      if (!bootstrap.ready) {
        setGating({ dest });
        setFinishing(false);
        void markFinished;
        return;
      }
      // Show the recap immediately; saving completion can finish in the background.
      setRecap({ dest });
      setFinishing(false);
      void markFinished;
      return;
    }

    await markFinished;
    setFinishing(false);
  };

  // Dogfood clone-on-first-boot finish gate (desktop UI part B). Blocks entry
  // while the Papercusp workspace downloads; onReady promotes gating → recap so
  // the user lands on the recap (and then the app) the instant it's ready.
  if (gating && !recap) {
    return (
      <BootstrapFinishGate
        onReady={() => {
          setRecap({ dest: gating.dest });
          setGating(null);
        }}
        onCancel={() => setGating(null)}
      />
    );
  }

  if (recap) {
    const completed = SETUP_STEPS.filter((s) => statuses[s.id] === 'ok');
    return (
      <div className="pc-setup-wizard pc-setup-wizard--recap pc-setup-wizard--friendly" data-mode={mode}>
        <div className="pc-step pc-step--recap pc-setup-recap-card">
          <CelebrationPapercup />
          <div className="pc-setup-recap-copy">
            <p className="pc-setup-recap-kicker">Ready for launch</p>
            <h2 className="pc-step__lead">
              You're all set. Nice work.
            </h2>
            <p className="pc-step__lead">
              Papercusp has the essentials it needs. {completed.length} of {SETUP_STEPS.length} setup
              checks are ready, and anything still pending can wait until later in Settings → Setup Wizard.
            </p>
          </div>
          <ul className="pc-bullets pc-setup-recap-list">
            {completed.slice(0, 6).map((s) => (
              <li key={s.id}>{s.title}</li>
            ))}
          </ul>
          <div className="pc-step__actions">
            <button
              type="button"
              className="pc-btn pc-btn--primary"
              onClick={() => router.push(recap.dest)}
            >
              {recap.dest === '/cupboard'
                ? 'Continue to the Cupboard →'
                : 'Continue to harness →'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pc-setup-wizard pc-setup-wizard--friendly" data-mode={mode} data-view={showWelcome ? 'welcome' : 'step'}>
      {!showWelcome && (
        <aside className="pc-setup-wizard__sidebar">
          <h2 className="pc-setup-wizard__title">Setup guide</h2>
          <p className="pc-setup-wizard__subtitle">
            {mode === 'first-run'
              ? "A calm checklist for getting Papercusp ready. Finish the essentials now; everything else can wait."
              : 'Tune your setup at your own pace. We re-check each item automatically.'}
          </p>
          <ol className="pc-setup-wizard__steps">
            {SETUP_STEPS.map((s, i) => {
              const status: StepStatus = statuses[s.id] ?? 'unknown';
              const isActive = s.id === active.id;
              return (
                <li
                  key={s.id}
                  className="pc-setup-wizard__step"
                  data-active={isActive ? 'true' : undefined}
                  data-status={status}
                >
                  <button
                    type="button"
                    className="pc-setup-wizard__step-btn"
                    onClick={() => setStepId(s.id)}
                  >
                    <span className="pc-setup-wizard__step-num">{i + 1}</span>
                    <span className="pc-setup-wizard__step-text">
                      <span className="pc-setup-wizard__step-title">{s.title}</span>
                      <span className="pc-setup-wizard__step-summary">{s.summary}</span>
                    </span>
                    <StatusBadge status={status} required={s.required} />
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="pc-setup-wizard__sidebar-footer">
            <div className="pc-setup-wizard__min" data-met={minimumMet ? 'true' : 'false'}>
              <span className="pc-setup-wizard__min-dot" />
              <span>
                {minimumMet
                  ? 'Essentials are ready — you can finish now.'
                  : 'To finish today: local database and one coding agent.'}
              </span>
            </div>
          </div>
        </aside>
      )}

      <main className="pc-setup-wizard__main">
        {showWelcome ? (
          <StepWelcome onStart={() => setStepId(SETUP_STEPS[0].id)} />
        ) : (
          <>
            <header className="pc-setup-wizard__main-header">
              <div className="pc-setup-wizard__eyebrow">
                <span>Step {currentStepNumber} of {stepCount}</span>
                <span className="pc-setup-wizard__pill">{active.required ? 'Required' : 'Optional'}</span>
              </div>
              <h1>{active.title}</h1>
              <p>{active.summary}</p>
              <div className="pc-setup-wizard__progress" aria-hidden="true">
                <span style={{ width: `${progressPct}%` }} />
              </div>
              <div className="pc-setup-helper-card">
                <strong>{active.required ? 'Helpful checkpoint' : 'Optional comfort step'}</strong>
                <span>
                  {active.required
                    ? 'This is one of the few things Papercusp needs to work locally. We’ll keep the steps small.'
                    : 'Skip this if you want. You can come back after you have explored the app.'}
                </span>
              </div>
            </header>
            <section className="pc-setup-wizard__main-body">{renderStep(active.id)}</section>
            <footer className="pc-setup-wizard__main-footer">
              <div className="pc-setup-wizard__main-footer-left">
                {idx > 0 && (
                  <button type="button" className="pc-btn" onClick={goPrev}>
                    ← Back
                  </button>
                )}
              </div>
              <div className="pc-setup-wizard__main-footer-right">
                {hasNextStep && (
                  <button type="button" className="pc-btn pc-btn--primary" onClick={goNext}>
                    Continue →
                  </button>
                )}
                {minimumMet ? (
                  <button
                    type="button"
                    className={`pc-btn${hasNextStep ? '' : ' pc-btn--primary'}`}
                    onClick={() => void finishWizard()}
                    disabled={finishing}
                  >
                    {finishing
                      ? 'Finishing…'
                      : mode === 'first-run'
                        ? 'Finish setup'
                        : 'Mark setup complete'}
                  </button>
                ) : (
                  <>
                    <span className="pc-setup-wizard__finish-hint">
                      The database and a coding agent aren’t ready yet — set them up
                      to finish properly, or skip and do it later.
                    </span>
                    <button
                      type="button"
                      className="pc-btn"
                      onClick={() => void finishWizard()}
                      disabled={finishing}
                    >
                      {finishing
                        ? 'Skipping…'
                        : mode === 'first-run'
                          ? 'Skip for now'
                          : 'Mark complete anyway'}
                    </button>
                  </>
                )}
              </div>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}

function CelebrationPapercup() {
  return (
    <div className="pc-setup-celebration" aria-hidden="true">
      <span className="pc-setup-celebration__confetti pc-setup-celebration__confetti--one" />
      <span className="pc-setup-celebration__confetti pc-setup-celebration__confetti--two" />
      <span className="pc-setup-celebration__confetti pc-setup-celebration__confetti--three" />
      <span className="pc-setup-celebration__confetti pc-setup-celebration__confetti--four" />
      <span className="pc-setup-celebration__spark pc-setup-celebration__spark--one" />
      <span className="pc-setup-celebration__spark pc-setup-celebration__spark--two" />
      <div className="pc-setup-celebration__halo" />
      <img className="pc-setup-celebration__mascot" src="/mascot.svg" alt="" />
    </div>
  );
}

function renderStep(id: string) {
  switch (id) {
    case 'os-permissions':
      return <StepOsPermissions />;
    case 'embedded-pg':
      return <StepEmbeddedPg />;
    case 'workspace':
      return <StepWorkspace />;
    case 'agents':
      return <StepAgents />;
    case 'local-model':
      return <StepLocalModel />;
    case 'logins':
      return <StepLogins />;
    case 'keys':
      return <StepKeys />;
    case 'git':
      return <StepGit />;
    case 'mobile-pairing':
      return <StepMobilePairing />;
    case 'backups':
      return <StepBackups />;
    case 'auto-update':
      return <StepAutoUpdate />;
    case 'telemetry':
      return <StepTelemetry />;
    default:
      return <StepPlaceholder id={id} />;
  }
}

function StatusBadge({ status, required }: { status: StepStatus; required?: boolean }) {
  if (status === 'unknown') return null;

  const label = {
    ok: '✓',
    'needs-attention': '!',
    unknown: '·',
  }[status];
  return (
    <span className="pc-setup-wizard__status" data-status={status} data-required={required ? 'true' : undefined}>
      {label}
    </span>
  );
}
