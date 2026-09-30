'use client';

/**
 * Editable keyboard-shortcut settings.
 *
 * Reads the canonical list from `lib/shortcut-registry`, lets the user
 * override any binding, and persists overrides to localStorage. The
 * `useShortcut` hook subscribes to changes, so a new binding takes
 * effect the moment the user clicks Save without needing a reload.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  SHORTCUTS,
  type ShortcutCategory,
  type ShortcutDef,
  effectiveCombo,
  loadOverrides,
  saveOverride,
  resetOverride,
  resetAllOverrides,
} from '@papercusp/operator-core/lib/shortcut-registry';
import { useConfirmDialog } from '@/app/harness/useConfirmDialog';

const CATEGORY_LABELS: Record<ShortcutCategory, string> = {
  global: 'Global',
  palette: 'Quick actions',
  navigation: 'Navigation',
  history: 'Back / forward',
  editor: 'Editors',
  voice: 'Voice & video',
};

const CATEGORY_ORDER: ShortcutCategory[] = [
  'palette',
  'global',
  'navigation',
  'history',
  'voice',
  'editor',
];

export default function ShortcutsSettingsPage() {
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [recordedKeys, setRecordedKeys] = useState<string>('');
  const { confirm: askConfirm, element: confirmEl } = useConfirmDialog();

  // Load on mount.
  useEffect(() => { setOverrides(loadOverrides()); }, []);

  const grouped = useMemo(() => {
    const g: Record<ShortcutCategory, ShortcutDef[]> = {
      global: [], palette: [], navigation: [], history: [], editor: [], voice: [],
    };
    for (const s of SHORTCUTS) g[s.category].push(s);
    return g;
  }, []);

  const refresh = () => setOverrides(loadOverrides());

  // While recording, capture the next key combo and write it.
  useEffect(() => {
    if (!recordingId) return;
    const onKey = (e: KeyboardEvent) => {
      // Esc cancels the recording.
      if (e.key === 'Escape') {
        e.preventDefault();
        setRecordingId(null);
        setRecordedKeys('');
        return;
      }
      // Don't record bare modifier-only presses; wait for a real key.
      if (['Shift', 'Control', 'Alt', 'Meta', 'Cmd', 'Ctrl'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const parts: string[] = [];
      if (e.ctrlKey || e.metaKey) parts.push('mod');
      if (e.shiftKey) parts.push('shift');
      if (e.altKey) parts.push('alt');
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      parts.push(k);
      const combo = parts.join('+');
      saveOverride(recordingId, combo);
      setRecordingId(null);
      setRecordedKeys('');
      refresh();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recordingId]);

  function startRecording(id: string) {
    setRecordingId(id);
    setRecordedKeys('press a combo… (Esc cancels)');
  }

  function manualEdit(id: string, value: string) {
    saveOverride(id, value);
    refresh();
  }

  function resetOne(id: string) {
    resetOverride(id);
    refresh();
  }

  async function resetAll() {
    const ok = await askConfirm({
      title: 'Reset all keyboard shortcuts?',
      body: 'All customized shortcuts will be restored to their defaults.',
      confirmLabel: 'Reset all',
      destructive: true,
    });
    if (!ok) return;
    resetAllOverrides();
    refresh();
  }

  const overrideCount = Object.keys(overrides).length;

  return (
    <div className="kbd-settings">
      {confirmEl}
      <header className="kbd-settings-head">
        <div>
          <h1>Keyboard shortcuts</h1>
          <p className="pc-settings-intro">
            Customize any binding. Click <strong>Record</strong> on a row and press
            the key combo you want to assign, or type it directly into the input.
            Settings persist in this browser only.
          </p>
        </div>
        {overrideCount > 0 && (
          <button type="button" className="kbd-settings-reset-all" onClick={resetAll}>
            Reset all to defaults ({overrideCount} customized)
          </button>
        )}
      </header>

      <div className="kbd-settings-help">
        <strong>Combo grammar:</strong> use <code>+</code> for modifier combinations
        (<code>mod+shift+p</code>), <code>,</code> to set alternates that all fire the
        same action (<code>mod+shift+p, mod+k</code>), and <code>&gt;</code> for two-stroke
        sequences (<code>g&gt;d</code>). <code>mod</code> is Cmd on macOS and Ctrl
        elsewhere.
      </div>

      {CATEGORY_ORDER.map((cat) => {
        const items = grouped[cat];
        if (items.length === 0) return null;
        return (
          <section key={cat} className="kbd-settings-section">
            <h2 className="kbd-settings-cat">{CATEGORY_LABELS[cat]}</h2>
            <div className="kbd-settings-grid">
              {items.map((s) => (
                <ShortcutRow
                  key={s.id}
                  def={s}
                  override={overrides[s.id] ?? null}
                  recording={recordingId === s.id}
                  recordedKeys={recordedKeys}
                  onStartRecording={() => startRecording(s.id)}
                  onManualEdit={(v) => manualEdit(s.id, v)}
                  onReset={() => resetOne(s.id)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ShortcutRow({
  def, override, recording, recordedKeys, onStartRecording, onManualEdit, onReset,
}: {
  def: ShortcutDef;
  override: string | null;
  recording: boolean;
  recordedKeys: string;
  onStartRecording: () => void;
  onManualEdit: (value: string) => void;
  onReset: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const isCustom = override !== null;
  const value = recording ? recordedKeys : (override ?? def.defaultCombo);
  return (
    <div className="kbd-settings-row">
      <div className="kbd-settings-row-head">
        <span className="kbd-settings-row-desc">{def.description}</span>
        {isCustom && <span className="kbd-settings-row-pill">customized</span>}
      </div>
      <div className="kbd-settings-row-controls">
        <input
          ref={inputRef}
          type="text"
          className={`kbd-settings-input${recording ? ' is-recording' : ''}`}
          value={value}
          readOnly={recording}
          placeholder={def.defaultCombo}
          onChange={(e) => onManualEdit(e.target.value)}
          aria-label={`Combo for ${def.description}`}
        />
        <button
          type="button"
          className="kbd-settings-record"
          onClick={onStartRecording}
          disabled={recording}
        >
          {recording ? 'Listening…' : 'Record'}
        </button>
        {isCustom && (
          <button type="button" className="kbd-settings-reset" onClick={onReset}>
            Reset
          </button>
        )}
      </div>
      {!isCustom && (
        <span className="kbd-settings-default">default: {def.defaultCombo}</span>
      )}
    </div>
  );
}
