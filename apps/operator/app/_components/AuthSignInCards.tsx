'use client';

/**
 * One-click OAuth sign-in cards for the agent providers.
 *
 * Shared between the Setup Wizard (StepLogins) and the Keys & OAuth
 * settings page. Each card spawns the provider's `/login` CLI in an
 * inline Tauri PTY — the CLI prints an OAuth URL, the user signs in
 * in their browser, and the CLI captures the token.
 *
 * Providers:
 *   - claude     → Anthropic (Claude Pro/Max). Writes
 *                  `~/.claude/.credentials.json` — read at runtime by
 *                  the stateless anthropic-direct LLM client (judges,
 *                  sim-users, summarisers), so it needs no separate
 *                  Anthropic login.
 *   - codex      → Codex CLI. Spawns `codex login`. Writes
 *                  `~/.codex/auth.json`, which Papercusp isolated
 *                  CODEX_HOME launches symlink for ChatGPT/Codex auth.
 *   - omp        → ChatGPT (via omp's Codex provider). Spawns
 *                  `omp /login`. Writes `~/.omp/agent/auth.json`.
 *                  When set, `models['operator'] = 'openai-codex/<m>'`
 *                  in /settings/agent makes the operator brain run
 *                  on a ChatGPT model.
 *
 * Outside Tauri (browser dev) the cards still render but emit a
 * "use the desktop app" note instead of trying to spawn a pty.
 */

import { useCallback, useEffect, useState } from 'react';
import { isTauriNative } from '@papercusp/operator-core/lib/pty-tauri';
import { InlinePtyTerminal } from './SetupWizard/InlinePtyTerminal';

type ProviderId = 'claude' | 'codex' | 'omp';

interface Provider {
  readonly id: ProviderId;
  readonly title: string;
  readonly summary: string;
}

const PROVIDERS: readonly Provider[] = [
  {
    id: 'claude',
    title: 'Claude account',
    summary:
      'Sign in with your Anthropic account (Claude Pro/Max). Operator + judge + sim-user traffic rides this session directly — no per-token API charges. Writes ~/.claude/.credentials.json.',
  },
  {
    id: 'codex',
    title: 'Codex account',
    summary:
      'Sign in with your ChatGPT/OpenAI account for the Codex CLI. Writes ~/.codex/auth.json, which Papercusp Codex launches inherit through isolated CODEX_HOME homes.',
  },
  {
    id: 'omp',
    title: 'OMP / ChatGPT account',
    summary:
      "Sign in with your ChatGPT account (via omp's Codex provider). Lets you point the operator brain at gpt-5 / gpt-5.5 from Settings → AI backend. Writes ~/.omp/agent/auth.json.",
  },
];

interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

interface PtyCommands {
  loginClaude: SpawnSpec;
  loginCodex: SpawnSpec;
  loginOmp: SpawnSpec;
}

interface AuthStatus {
  claude: boolean;
  codex: boolean;
  omp: boolean;
}

export interface AuthSignInCardsProps {
  /** Optional intro line above the cards. The wizard supplies one;
   *  the settings page can omit. */
  readonly intro?: string;
}

export function AuthSignInCards({ intro }: AuthSignInCardsProps) {
  const [tauri, setTauri] = useState(false);
  const [active, setActive] = useState<ProviderId | null>(null);
  const [exited, setExited] = useState<ProviderId | null>(null);
  const [specs, setSpecs] = useState<PtyCommands | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>({ claude: false, codex: false, omp: false });
  // Bump on every click so the pty terminal remounts fresh.
  const [attempt, setAttempt] = useState(0);
  // Browser-dev: which card showed the "use the desktop app" note.
  const [deskNote, setDeskNote] = useState<ProviderId | null>(null);

  const refreshAuth = useCallback(async () => {
    try {
      const r = await fetch('/api/desktop/agent-auth-status', { cache: 'no-store' });
      if (r.ok) setAuthStatus((await r.json()) as AuthStatus);
    } catch {
      /* leave previous state */
    }
  }, []);

  useEffect(() => {
    setTauri(isTauriNative());
    void (async () => {
      try {
        const r = await fetch('/api/desktop/setup-pty-commands', { cache: 'no-store' });
        if (r.ok) setSpecs((await r.json()) as PtyCommands);
      } catch {
        /* button stays disabled until specs resolve */
      }
    })();
    void refreshAuth();
    const id = setInterval(() => void refreshAuth(), 5000);
    return () => clearInterval(id);
  }, [refreshAuth]);

  const specFor = (id: ProviderId): SpawnSpec | undefined =>
    id === 'claude' ? specs?.loginClaude : id === 'codex' ? specs?.loginCodex : specs?.loginOmp;

  const signedIn = (id: ProviderId): boolean =>
    id === 'claude' ? authStatus.claude : id === 'codex' ? authStatus.codex : authStatus.omp;

  const startLogin = (id: ProviderId) => {
    if (!tauri) {
      setDeskNote(id);
      return;
    }
    setExited(null);
    setAttempt((n) => n + 1);
    setActive(id);
  };

  const handleExit = () => {
    setExited(active);
    setActive(null);
    void refreshAuth();
  };

  const dismiss = () => setExited(null);

  return (
    <div className="pc-step">
      {intro && <p className="pc-step__lead">{intro}</p>}
      <div className="pc-provider-grid">
        {PROVIDERS.map((p) => {
          const isActive = active === p.id;
          const isExited = exited === p.id;
          const done = signedIn(p.id);
          const label = p.title.replace(' account', '');
          return (
            <div key={p.id} className="pc-provider-card">
              <div
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
              >
                <h3 className="pc-provider-card__title">{p.title}</h3>
                {done && (
                  <span
                    className="pc-provider-card__badge"
                    data-status="ok"
                    style={{ fontSize: 12, color: 'var(--good, #2a8)' }}
                  >
                    ✓ Signed in
                  </span>
                )}
              </div>
              <p className="pc-provider-card__summary">{p.summary}</p>
              <button
                type="button"
                className="pc-btn pc-btn--primary"
                disabled={active !== null || !specs}
                onClick={() => startLogin(p.id)}
              >
                {isActive
                  ? 'Running…'
                  : done
                    ? `Re-sign in to ${label}`
                    : `Sign in to ${label}`}
              </button>
              {deskNote === p.id && !tauri && (
                <p className="pc-provider-card__instructions">
                  Terminal sign-in runs inside the Papercusp desktop app.
                </p>
              )}
              {(isActive || isExited) && tauri && specFor(p.id) && (
                <>
                  <InlinePtyTerminal
                    key={`${p.id}-${attempt}`}
                    command={specFor(p.id)!.command}
                    args={specFor(p.id)!.args}
                    cwd={specFor(p.id)!.cwd}
                    env={specFor(p.id)!.env}
                    rows={14}
                    onExit={handleExit}
                    onSpawnError={handleExit}
                  />
                  {isExited && (
                    <div className="pc-step__actions" style={{ marginTop: 8 }}>
                      <button type="button" className="pc-btn" onClick={dismiss}>
                        Done
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
