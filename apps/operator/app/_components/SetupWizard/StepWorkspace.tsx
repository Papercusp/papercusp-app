'use client';


import { Tooltip } from '@/app/harness/Tooltip';
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri-detect';

interface Profile {
  default_project_dir?: string;
}

interface ValidateOk {
  ok: true;
  normalized: string;
  exists: boolean;
  writable: boolean;
}
interface ValidateErr {
  ok: false;
  reason: string;
}
type Validation = ValidateOk | ValidateErr;

export function StepWorkspace() {
  const [dir, setDir] = useState<string>('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [tauri, setTauri] = useState(false);
  const [validation, setValidation] = useState<Validation | null>(null);

  useEffect(() => {
    setTauri(isTauri());
  }, []);

  // Seed-once guard: StrictMode runs this effect twice with both fetches in
  // flight — the late one must not setDir() over what the user already typed.
  const seededRef = useRef(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/profile', { cache: 'no-store' });
        const j = (await r.json()) as Profile;
        if (!seededRef.current) {
          seededRef.current = true;
          setDir(j.default_project_dir ?? '');
        }
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  // Debounced validation: every time the user pauses typing we ping
  // /api/desktop/workspace-validate.
  useEffect(() => {
    if (!loaded) return;
    if (dir.trim().length === 0) {
      setValidation(null);
      return;
    }
    const handle = setTimeout(async () => {
      try {
        const r = await fetch('/api/desktop/workspace-validate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: dir }),
        });
        const j = (await r.json()) as Validation;
        setValidation(j);
      } catch {
        setValidation(null);
      }
    }, 350);
    return () => clearTimeout(handle);
  }, [dir, loaded]);

  const pickFolder = async () => {
    try {
      const result = (await invoke('plugin:dialog|open', {
        options: {
          directory: true,
          multiple: false,
          title: 'Choose a folder for your Papercusp projects',
        },
      })) as string | string[] | null;
      const path = Array.isArray(result) ? result[0] : result;
      if (path) setDir(path);
    } catch {
      // user cancelled or plugin unavailable
    }
  };

  const canSave = loaded && !saving && (validation === null || validation.ok);

  const onSave = async () => {
    setSaving(true);
    try {
      await fetch('/api/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ default_project_dir: dir || undefined }),
      });
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pc-step">
      <p className="pc-step__lead">
        This is where Papercusp creates new project folders when you scaffold a harness. Leave it
        blank to use the default <code>~/.papercusp/projects/</code>.
      </p>
      <label className="pc-field">
        <span className="pc-field__label">Default project directory</span>
        <div className="pc-field__row">
          <input
            type="text"
            className="pc-input"
            placeholder="~/papercusp-projects"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            disabled={!loaded || saving}
          />
          {tauri && (
            <button
              type="button"
              className="pc-btn"
              onClick={() => void pickFolder()}
              disabled={!loaded || saving}
            >
              Choose folder…
            </button>
          )}
        </div>
        {validation && validation.ok && validation.normalized && (
          <span className="pc-field__hint pc-field__hint--ok">
            ✓ {validation.exists ? 'Exists, writable' : 'Will be created'} ·{' '}
            <code>{validation.normalized}</code>
          </span>
        )}
        {validation && !validation.ok && (
          <span className="pc-field__hint pc-field__hint--err">⚠ {validation.reason}</span>
        )}
        {!validation && (
          <span className="pc-field__hint">
            Use an absolute path or one starting with <code>~/</code>. Created if it doesn't exist.
            Blank uses the default.
          </span>
        )}
      </label>
      <div className="pc-step__actions">
        <Tooltip label={validation && !validation.ok ? validation.reason : undefined}><button
          type="button"
          className="pc-btn pc-btn--primary"
          onClick={() => void onSave()}
          disabled={!canSave}

        >
          {saving ? 'Saving…' : 'Save'}
        </button></Tooltip>
        {savedAt && <span className="pc-step__saved">Saved.</span>}
      </div>
      {!tauri && (
        <p className="pc-step__hint">
          A native folder picker appears here when running inside the desktop app. In a browser tab,
          paste the path manually.
        </p>
      )}
    </div>
  );
}
