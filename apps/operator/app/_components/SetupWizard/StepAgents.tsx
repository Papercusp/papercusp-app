'use client';

import { useEffect, useState } from 'react';
import { isTauriNative } from '@papercusp/operator-core/lib/pty-tauri';
import { InlinePtyTerminal } from './InlinePtyTerminal';

interface AgentRuntime {
  claude: boolean;
  codex: boolean;
  omp: boolean;
}

interface ModelEgressStatus {
  enabled: boolean;
  throttled: boolean;
  retryAfterSec: number | null;
}

interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

interface PtyCommands {
  installRuntime: SpawnSpec;
  installFramework?: Partial<Record<'claude' | 'codex' | 'omp', SpawnSpec>>;
}

export function StepAgents() {
  const [runtime, setRuntime] = useState<AgentRuntime | null>(null);
  const [modelEgress, setModelEgress] = useState<ModelEgressStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [installSpec, setInstallSpec] = useState<SpawnSpec | null>(null);
  const [lastExitCode, setLastExitCode] = useState<number | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [tauri, setTauri] = useState(false);
  // Bumped per install attempt so the pty terminal remounts cleanly
  // on Retry rather than relying on spec-object reference churn.
  const [attempt, setAttempt] = useState(0);

  // Detection comes from /api/desktop/setup-status — the SAME source
  // the wizard sidebar uses, so the card and the badge never disagree.
  const refreshRuntime = async () => {
    try {
      const r = await fetch('/api/desktop/setup-status', { cache: 'no-store' });
      if (r.ok) {
        const j = (await r.json()) as { agentRuntime?: AgentRuntime; modelEgress?: ModelEgressStatus };
        if (j.agentRuntime) setRuntime(j.agentRuntime);
        setModelEgress(j.modelEgress ?? null);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setTauri(isTauriNative());
    void refreshRuntime();
    const id = setInterval(() => void refreshRuntime(), 5000);
    return () => clearInterval(id);
  }, []);

  const claudeOk = runtime?.claude ?? false;
  const codexOk = runtime?.codex ?? false;
  const ompOk = runtime?.omp ?? false;
  // A complete backend is any standalone CLI agent — Claude Code, Codex, or
  // oh-my-pi — the orchestrator drives the CLI directly.
  const allOk = claudeOk || codexOk || ompOk;

  // Per-runtime breakdown rows. `id` keys the per-framework installer.
  const runtimeRows: { id: 'claude' | 'codex' | 'omp'; label: string; hint: string; ok: boolean; detail: string }[] = [
    {
      id: 'claude',
      label: 'Claude Code',
      hint: 'standalone claude CLI',
      ok: claudeOk,
      detail: claudeOk ? 'Installed.' : 'Not installed.',
    },
    {
      id: 'codex',
      label: 'Codex',
      hint: 'standalone codex CLI (OpenAI)',
      ok: codexOk,
      detail: codexOk ? 'Installed.' : 'Not installed.',
    },
    {
      id: 'omp',
      label: 'oh-my-pi',
      hint: 'multi-provider omp CLI (downloaded from GitHub releases)',
      ok: ompOk,
      detail: ompOk ? 'Installed.' : 'Not installed.',
    },
  ];

  // Shared launcher for a fetched install SpawnSpec (streams into the pty pane).
  const runInstallSpec = (spec: SpawnSpec | undefined, source: string) => {
    if (!spec?.command) {
      setStartError(`Couldn't start the installer for ${source}. Use the manual commands below.`);
      return;
    }
    setAttempt((n) => n + 1);
    setInstallSpec(spec);
    setInstalling(true);
  };

  const startInstall = async () => {
    setLastExitCode(null);
    setStartError(null);
    try {
      const r = await fetch('/api/desktop/setup-pty-commands', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as PtyCommands;
      runInstallSpec(j.installRuntime, 'the agent runtime');
    } catch (e: any) {
      setInstallSpec(null);
      setInstalling(false);
      setStartError(
        `Couldn't start the installer: ${e?.message ?? e}. Use the manual commands below.`,
      );
    }
  };

  // Install ONE backend (claude / codex / oh-my-pi) via its per-framework spec —
  // this is how oh-my-pi (no npm package) gets installed: a direct download of the
  // omp binary from GitHub releases (installFramework.omp), same as the CLI setup.
  const startInstallFramework = async (framework: 'claude' | 'codex' | 'omp') => {
    setLastExitCode(null);
    setStartError(null);
    try {
      const r = await fetch('/api/desktop/setup-pty-commands', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as PtyCommands;
      runInstallSpec(j.installFramework?.[framework], framework);
    } catch (e: any) {
      setInstallSpec(null);
      setInstalling(false);
      setStartError(
        `Couldn't start the ${framework} installer: ${e?.message ?? e}. Use the manual commands below.`,
      );
    }
  };

  const handleExit = (code: number) => {
    setLastExitCode(code);
    setInstalling(false);
    void refreshRuntime();
    // installSpec stays set on failure so the terminal pane (with the
    // exit log) remains visible. Clicking Retry blows it away.
    if (code === 0) setInstallSpec(null);
  };

  const dismissPanel = () => {
    setInstallSpec(null);
    setLastExitCode(null);
  };

  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        Papercusp needs an <strong>agent backend</strong>. The simplest is{' '}
        <strong>Claude Code</strong> — just the <code>claude</code> CLI signed into
        your Claude subscription; the orchestrator drives it and background calls go
        straight to Anthropic. <strong>Codex</strong> (the <code>codex</code> CLI,
        OpenAI) works the same way. Or use <strong>oh-my-pi</strong> to route
        through other providers. You need <em>one</em> complete path, not all
        of them.
      </p>

      {!loading && (
        <div className="pc-step__progress" data-status={allOk ? 'ok' : 'missing'}>
          <div className="pc-step__progress-dot" />
          <div className="pc-step__progress-text">
            {allOk ? (
              <>
                <strong>Ready.</strong>
                <span>
                  {[
                    claudeOk && 'Claude Code',
                    codexOk && 'Codex',
                    ompOk && 'oh-my-pi',
                  ]
                    .filter(Boolean)
                    .join(', ')}{' '}
                  installed.
                </span>
              </>
            ) : (
              <>
                <strong>No agent backend yet.</strong>
                <span>
                  Install <strong>Claude Code</strong> (the <code>claude</code> CLI),{' '}
                  <strong>Codex</strong> (the <code>codex</code> CLI) — or oh-my-pi.
                  Click Install to run the commands here in the wizard.
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {/* WI-3186: a signed-in CLI (the checks above) proves LOGIN, not that a real model
          call can go through right now — a packaged single-account install has no gateway
          failover, so its account commonly exhausts its window. Surface that explicitly
          instead of leaving the user to hit a raw {gateway:true,error:{type:'rate_limit_error'}}
          body the first time something actually calls the model. */}
      {!loading && modelEgress?.throttled && (
        <div className="pc-step__progress" data-status="missing" style={{ marginTop: 10 }}>
          <div className="pc-step__progress-dot" />
          <div className="pc-step__progress-text">
            <strong>Signed in, but your account is rate-limited right now.</strong>
            <span>
              Every model call is currently throttled
              {modelEgress.retryAfterSec != null && modelEgress.retryAfterSec > 0
                ? ` — it should clear in about ${Math.ceil(modelEgress.retryAfterSec / 60)} min`
                : ''}
              . This happens once a single account's usage window is used up; no action is
              needed here — Papercusp resumes automatically once it resets.
            </span>
          </div>
        </div>
      )}

      {!loading && runtime && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {runtimeRows.map((r) => (
            <div
              key={r.label}
              className="pc-step__progress"
              data-status={r.ok ? 'ok' : 'missing'}
              style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}
            >
              <div className="pc-step__progress-dot" />
              <div className="pc-step__progress-text" style={{ flex: 1 }}>
                <strong>{r.label}</strong>
                <span>
                  {r.detail} <em style={{ opacity: 0.7 }}>({r.hint})</em>
                </span>
              </div>
              {tauri && !r.ok && (
                <button
                  type="button"
                  className="pc-btn"
                  onClick={() => void startInstallFramework(r.id)}
                  disabled={loading || installing}
                  style={{ flexShrink: 0 }}
                >
                  Install {r.label}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {tauri && (
        <div
          className="pc-step__actions"
          style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center' }}
        >
          <button
            type="button"
            className="pc-btn pc-btn--primary"
            onClick={() => void startInstall()}
            disabled={loading || installing || allOk}
          >
            {loading
              ? 'Checking…'
              : installing
                ? 'Installing…'
                : allOk
                  ? 'Installed'
                  : lastExitCode !== null && lastExitCode !== 0
                    ? 'Retry install'
                    : 'Install Agent Runtime'}
          </button>
          {installSpec && !installing && (
            <button type="button" className="pc-btn" onClick={dismissPanel}>
              Dismiss log
            </button>
          )}
        </div>
      )}

      {startError && (
        <p style={{ marginTop: 8, color: 'var(--bad, #d33)', fontSize: 13 }}>
          {startError}
        </p>
      )}

      {installSpec && (
        <InlinePtyTerminal
          key={attempt}
          command={installSpec.command}
          args={installSpec.args}
          cwd={installSpec.cwd}
          env={installSpec.env}
          rows={20}
          readOnly
          onExit={handleExit}
          onSpawnError={(msg) => {
            // Without this the button sticks on "Installing…" forever
            // when the pty never comes up (found live 2026-06-12).
            setInstalling(false);
            setLastExitCode(-1);
            setStartError(`Installer terminal failed to start: ${msg}. Use the manual commands below.`);
          }}
        />
      )}

      {!tauri && !loading && (
        <div
          className="pc-step__progress"
          data-status="missing"
          style={{ marginTop: 16 }}
        >
          <div className="pc-step__progress-dot" />
          <div className="pc-step__progress-text">
            <strong>Open this in the desktop app to install.</strong>
            <span>The wizard's install button runs commands locally; that needs Tauri.</span>
          </div>
        </div>
      )}

      <p className="pc-step__hint" style={{ marginTop: 16 }}>
        <button type="button" className="pc-link-btn" onClick={() => setShowManual((v) => !v)}>
          {showManual ? 'Hide manual install commands' : 'Or install manually ↓'}
        </button>
      </p>
      {showManual && (
        <div className="pc-agent-card" style={{ marginTop: 8 }}>
          <p className="pc-agent-card__install-label">From a terminal:</p>
          <pre className="pc-code">
            {`# Claude Code
curl -fsSL https://claude.ai/install.sh | bash   # macOS/Linux
iwr https://claude.ai/install.ps1 | iex          # Windows PowerShell

# Codex (OpenAI)
npm install -g @openai/codex

# oh-my-pi ships bundled with the desktop app (it has no npm package)
`}
          </pre>
          <p className="pc-agent-card__link">
            <a href="https://docs.anthropic.com/claude/docs/claude-code" target="_blank" rel="noreferrer">
              Claude Code docs ↗
            </a>{' '}
            ·{' '}
            <a href="https://github.com/openai/codex" target="_blank" rel="noreferrer">
              Codex docs ↗
            </a>{' '}
            ·{' '}
            <a href="https://github.com/can1357/oh-my-pi" target="_blank" rel="noreferrer">
              oh-my-pi docs ↗
            </a>
          </p>
        </div>
      )}
    </div>
  );
}
