'use client';


import { Tooltip } from '@/app/harness/Tooltip';
import { useEffect, useRef, useState } from 'react';
import { isTauriNative } from '@papercusp/operator-core/lib/pty-tauri';
import { InlinePtyTerminal } from './InlinePtyTerminal';
import { startDogfoodBootstrap } from '../useDogfoodBootstrapProgress';

/**
 * GitHub sign-in (`gh auth login`) — fully wired (pty flow + bundled-gh
 * resolution in preflight + setup-pty-commands). ENABLED: the dogfood
 * clone-on-first-boot needs a GitHub sign-in to clone the private repo,
 * so the wizard must offer it. (Was alpha-gated off; re-enabled.)
 */
const GITHUB_AUTH_ALPHA_DISABLED: boolean = false;

interface GitIdentity {
  name?: string;
  email?: string;
  source?: 'global' | 'system' | 'none';
}

interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

interface PtyCommands {
  loginGithub?: SpawnSpec;
}

interface AuthStatus {
  claude?: boolean;
  omp?: boolean;
  github?: boolean;
}

export function StepGit() {
  const [identity, setIdentity] = useState<GitIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [tauri, setTauri] = useState(false);
  const [ghInstalled, setGhInstalled] = useState<boolean | null>(null);
  const [spec, setSpec] = useState<SpawnSpec | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>({});
  const [active, setActive] = useState(false);
  const [exited, setExited] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Git-identity form draft (useState, not nuqs — mid-edit form state).
  const [nameDraft, setNameDraft] = useState('');
  const [emailDraft, setEmailDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const refreshAuth = async () => {
    try {
      const r = await fetch('/api/desktop/agent-auth-status', { cache: 'no-store' });
      if (r.ok) setAuthStatus((await r.json()) as AuthStatus);
    } catch { /* leave previous */ }
  };

  useEffect(() => {
    setTauri(isTauriNative());
    void (async () => {
      try {
        const [identRes, pfRes, specsRes] = await Promise.all([
          fetch('/api/desktop/git-identity', { cache: 'no-store' }),
          fetch('/api/desktop/preflight', { cache: 'no-store' }),
          fetch('/api/desktop/setup-pty-commands', { cache: 'no-store' }),
        ]);
        if (identRes.ok) {
          const j = (await identRes.json()) as GitIdentity;
          setIdentity(j);
          if (j.name) setNameDraft(j.name);
          if (j.email) setEmailDraft(j.email);
        } else {
          setIdentity({ source: 'none' });
        }
        if (pfRes.ok) {
          const pf = (await pfRes.json()) as { checks: Array<{ name: string; status: string }> };
          const gh = pf.checks?.find((c) => c.name === 'gh');
          setGhInstalled(gh?.status === 'ok');
        }
        if (specsRes.ok) {
          const j = (await specsRes.json()) as PtyCommands;
          if (j.loginGithub) setSpec(j.loginGithub);
        }
      } catch {
        setIdentity({ source: 'none' });
      } finally {
        setLoading(false);
      }
    })();
    void refreshAuth();
    const id = setInterval(() => void refreshAuth(), 5000);
    return () => clearInterval(id);
  }, []);

  const configured = Boolean(identity?.name && identity?.email);
  const ghSignedIn = authStatus.github === true;

  // Dogfood clone-on-first-boot trigger (desktop UI part C): the moment GitHub
  // auth is confirmed (the boot-time bootstrap no-ops before `gh` is signed in),
  // kick the Papercusp workspace clone so it runs DURING the rest of setup — the
  // banner shows it and the finish gate usually finds it already done. The
  // endpoint is idempotent + single-flight, so a second call is a no-op; this
  // ref ensures we fire AT MOST once per signed-in success regardless of polls.
  const bootstrapKickedRef = useRef(false);
  useEffect(() => {
    if (ghSignedIn && !bootstrapKickedRef.current) {
      bootstrapKickedRef.current = true;
      void startDogfoodBootstrap();
    }
  }, [ghSignedIn]);

  const saveIdentity = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const r = await fetch('/api/desktop/git-identity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: nameDraft.trim(), email: emailDraft.trim() }),
      });
      const j = (await r.json().catch(() => ({}))) as GitIdentity & { error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setIdentity({ name: j.name, email: j.email, source: 'global' });
    } catch (e: any) {
      setSaveError(e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  const startGithubLogin = () => {
    if (GITHUB_AUTH_ALPHA_DISABLED) return;
    setExited(false);
    setAttempt((n) => n + 1);
    setActive(true);
  };

  const handleExit = () => {
    setExited(true);
    setActive(false);
    void refreshAuth();
  };

  const dismiss = () => {
    setExited(false);
  };

  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        Every commit Papercusp makes — on your behalf or via an agent — needs a name and email. We
        read these from your existing <code>git config</code>; nothing to set up if you've used git
        before.
      </p>
      <div className="pc-step__progress" data-status={loading ? 'loading' : configured ? 'ok' : 'missing'}>
        <div className="pc-step__progress-dot" />
        <div className="pc-step__progress-text">
          {loading && <span>Checking…</span>}
          {!loading && configured && (
            <>
              <strong>Ready.</strong>
              <span>
                {identity?.name} &lt;{identity?.email}&gt; (from {identity?.source ?? 'config'})
              </span>
            </>
          )}
          {!loading && !configured && (
            <>
              <strong>Not configured.</strong>
              <span>Fill in your name and email below.</span>
            </>
          )}
        </div>
      </div>
      {!loading && (
        <div style={{ marginTop: 12, maxWidth: 420 }}>
          <label className="pc-field">
            <span className="pc-field__label">Name</span>
            <input
              type="text"
              className="pc-input"
              value={nameDraft}
              placeholder="Your Name"
              disabled={saving}
              onChange={(e) => setNameDraft(e.target.value)}
            />
          </label>
          <label className="pc-field" style={{ marginTop: 10 }}>
            <span className="pc-field__label">Email</span>
            <input
              type="email"
              className="pc-input"
              value={emailDraft}
              placeholder="you@example.com"
              disabled={saving}
              onChange={(e) => setEmailDraft(e.target.value)}
            />
          </label>
          <div className="pc-step__actions" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="pc-btn pc-btn--primary"
              onClick={() => void saveIdentity()}
              disabled={saving || !nameDraft.trim() || !emailDraft.trim()}
            >
              {saving ? 'Saving…' : configured ? 'Update git identity' : 'Save git identity'}
            </button>
            {configured && !saving && <span className="pc-step__saved">Saved.</span>}
          </div>
          {saveError && (
            <span className="pc-field__hint pc-field__hint--err">{saveError}</span>
          )}
        </div>
      )}

      <div className="pc-divider" />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h3 className="pc-consent__heading" style={{ margin: 0 }}>GitHub</h3>
        {ghSignedIn && (
          <span
            className="pc-provider-card__badge"
            data-status="ok"
            style={{ fontSize: 12, color: 'var(--good, #2a8)' }}
          >
            ✓ Signed in
          </span>
        )}
      </div>
      <p className="pc-step__hint">
        The bundled Papercusp workspace is private, so setup needs GitHub auth before it can
        download. The simplest path is the GitHub CLI — <code>gh auth login</code> stores a token
        in your system keychain that <code>git</code> picks up automatically.
      </p>
      <div className="pc-step__actions">
        <Tooltip label={GITHUB_AUTH_ALPHA_DISABLED
              ? 'GitHub sign-in is disabled during the alpha'
              : ghInstalled === false
                ? 'Install the GitHub CLI first (see hint below)'
                : undefined}><button
          type="button"
          className="pc-btn pc-btn--primary"
          onClick={startGithubLogin}
          disabled={GITHUB_AUTH_ALPHA_DISABLED || active || !tauri || !spec || ghInstalled === false}

        >
          {active
            ? 'Running…'
            : ghSignedIn
              ? 'Re-sign in to GitHub'
              : 'Sign in to GitHub'}
        </button></Tooltip>
        {GITHUB_AUTH_ALPHA_DISABLED ? (
          <span className="pc-field__hint" style={{ marginLeft: 8 }}>
            GitHub sign-in is disabled while Papercusp is in alpha — it'll light up in a later release.
          </span>
        ) : ghInstalled === false ? (
          <span className="pc-field__hint pc-field__hint--err" style={{ marginLeft: 8 }}>
            ⚠ GitHub CLI not detected. Install it first:{' '}
            <a href="https://cli.github.com/" target="_blank" rel="noreferrer">cli.github.com</a>
          </span>
        ) : null}
      </div>
      {!GITHUB_AUTH_ALPHA_DISABLED && (active || exited) && spec && (
        <>
          <InlinePtyTerminal
            key={`github-${attempt}`}
            command={spec.command}
            args={spec.args}
            cwd={spec.cwd}
            env={spec.env}
            rows={14}
            onExit={handleExit}
            onSpawnError={handleExit}
          />
          {exited && (
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
}
