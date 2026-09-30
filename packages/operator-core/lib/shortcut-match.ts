'use client';

/**
 * Combo parser + matcher — the Notion-style core.
 *
 * Combo grammar (reused from `react-hotkeys-hook` so existing registry
 * strings keep working):
 *   - `mod+k`              → Cmd on macOS, Ctrl elsewhere
 *   - `mod+shift+p`        → with Shift
 *   - `mod+p, mod+/, mod+k` → comma = alternates (any matches)
 *   - `g>d`                → sequence: g, then d (within SEQUENCE_TIMEOUT_MS)
 *   - `slash` / `bracketright` / `Enter` / `Space` / `Escape` / etc. — special key names
 */

const SEQUENCE_TIMEOUT_MS = 1000;

/**
 * Whether the platform's `mod` accelerator is Cmd (Mac) rather than Ctrl.
 *
 * MUST NOT trust `navigator.platform` alone: WebKit FREEZES it to `"MacIntel"`
 * in webviews regardless of the real OS, so on the Linux Tauri desktop
 * (WebKitGTK) `isMac` came out `true`, `mod+*` shortcuts demanded Cmd, and every
 * `mod` shortcut — most visibly Ctrl+F find-in-page — silently stopped firing
 * (the keydown reached JS but never matched). Prefer the userAgent OS token
 * (which WebKitGTK + every real browser report correctly), then Chromium's
 * `userAgentData.platform`, and only fall back to the frozen `platform` string
 * when the UA is uninformative. Cheap enough to call per keydown.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/Macintosh|Mac OS X/i.test(ua)) return true;
  if (/Windows|Linux|Android|CrOS|X11|Ubuntu/i.test(ua)) return false;
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData;
  if (uaData?.platform) return /mac/i.test(uaData.platform);
  return /Mac|iPhone|iPad/i.test(navigator.platform || '');
}

export interface ParsedStep {
  key: string;
  mod?: boolean;   // Cmd on Mac, Ctrl elsewhere
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface ParsedAlternate {
  steps: ParsedStep[];
}

export interface ParsedCombo {
  alternates: ParsedAlternate[];
}

export function parseCombo(raw: string): ParsedCombo {
  const alternates: ParsedAlternate[] = [];
  for (const altRaw of raw.split(',')) {
    const trimmed = altRaw.trim();
    if (!trimmed) continue;
    const steps: ParsedStep[] = [];
    for (const stepRaw of trimmed.split('>')) {
      steps.push(parseStep(stepRaw.trim()));
    }
    alternates.push({ steps });
  }
  return { alternates };
}

function parseStep(raw: string): ParsedStep {
  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean);
  const step: ParsedStep = { key: '' };
  for (const p of parts) {
    const lc = p.toLowerCase();
    if (lc === 'mod') { step.mod = true; continue; }
    if (lc === 'ctrl' || lc === 'control') { step.ctrl = true; continue; }
    if (lc === 'cmd' || lc === 'command' || lc === 'meta') { step.meta = true; continue; }
    if (lc === 'shift') { step.shift = true; continue; }
    if (lc === 'alt' || lc === 'option') { step.alt = true; continue; }
    step.key = normalizeKey(p);
  }
  return step;
}

function normalizeKey(k: string): string {
  const lc = k.toLowerCase();
  switch (lc) {
    case 'space': return ' ';
    case 'slash': return '/';
    case 'backslash': return '\\';
    case 'bracketleft': return '[';
    case 'bracketright': return ']';
    case 'period': return '.';
    case 'comma': return ',';
    case 'semicolon': return ';';
    case 'quote': return "'";
    case 'backquote': return '`';
    case 'minus': return '-';
    case 'equal': return '=';
    case 'enter': case 'return': return 'Enter';
    case 'escape': case 'esc': return 'Escape';
    case 'tab': return 'Tab';
    case 'arrowup': case 'up': return 'ArrowUp';
    case 'arrowdown': case 'down': return 'ArrowDown';
    case 'arrowleft': case 'left': return 'ArrowLeft';
    case 'arrowright': case 'right': return 'ArrowRight';
    case 'home': return 'Home';
    case 'end': return 'End';
    case 'pageup': return 'PageUp';
    case 'pagedown': return 'PageDown';
    case 'backspace': return 'Backspace';
    case 'delete': return 'Delete';
  }
  if (/^f\d+$/.test(lc)) return lc.toUpperCase();
  if (k.length === 1) return k.toLowerCase();
  return k;
}

/**
 * Map of registry keys to the shifted character a US keyboard produces.
 * Lets `shift+slash` match `event.key === '?'`, etc.
 */
const SHIFTED_VARIANTS: Record<string, string> = {
  '/': '?',
  '1': '!', '2': '@', '3': '#', '4': '$', '5': '%',
  '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
  '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|',
  ';': ':', "'": '"', ',': '<', '.': '>', '`': '~',
};

function keyEquals(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (SHIFTED_VARIANTS[a] === b) return true;
  if (a.length === 1 && b.length === 1) return a.toLowerCase() === b.toLowerCase();
  return false;
}

export function stepMatches(step: ParsedStep, e: KeyboardEvent): boolean {
  if (step.mod) {
    if (isMacPlatform() ? !e.metaKey : !e.ctrlKey) return false;
  }
  if (step.ctrl && !e.ctrlKey) return false;
  if (step.meta && !e.metaKey) return false;
  if (step.shift !== undefined && step.shift !== e.shiftKey) return false;
  if (step.alt !== undefined && step.alt !== e.altKey) return false;
  // No modifier requested — ensure no Ctrl/Meta is pressed (else `Cmd+J`
  // would falsely match a `j` binding).
  const wantsAnyMod = !!(step.mod || step.ctrl || step.meta);
  if (!wantsAnyMod && (e.ctrlKey || e.metaKey)) return false;
  // For unmodified single-key shortcuts, also ensure Shift isn't held
  // unless the key explicitly wants it (covered by the explicit shift
  // check above) or the key is a shifted variant of what was bound.
  if (step.shift === undefined && e.shiftKey) {
    // Allow if the registry key is a base char whose shift variant
    // equals the event key (e.g. `?` for shift+`/`). Otherwise reject —
    // a `j` binding shouldn't fire on Shift+J.
    if (SHIFTED_VARIANTS[step.key] !== e.key) return false;
  }
  return keyEquals(step.key, e.key);
}

interface SequenceState {
  matchedDepth: number;
  lastAt: number;
}

const sequenceState = new Map<string, SequenceState>();

export function tryMatchAlternate(
  comboId: string,
  altIndex: number,
  alt: ParsedAlternate,
  e: KeyboardEvent,
): boolean {
  const stateKey = `${comboId}:${altIndex}`;
  const now = Date.now();
  const state = sequenceState.get(stateKey);

  if (alt.steps.length === 1) {
    return stepMatches(alt.steps[0], e);
  }

  const expectedDepth = state && now - state.lastAt < SEQUENCE_TIMEOUT_MS
    ? state.matchedDepth
    : 0;

  if (stepMatches(alt.steps[expectedDepth], e)) {
    if (expectedDepth === alt.steps.length - 1) {
      sequenceState.delete(stateKey);
      return true;
    }
    sequenceState.set(stateKey, { matchedDepth: expectedDepth + 1, lastAt: now });
    return false;
  }

  if (expectedDepth > 0) sequenceState.delete(stateKey);
  return false;
}

export function tryMatch(comboId: string, combo: ParsedCombo, e: KeyboardEvent): boolean {
  for (let i = 0; i < combo.alternates.length; i++) {
    if (tryMatchAlternate(comboId, i, combo.alternates[i], e)) return true;
  }
  return false;
}

export function _resetSequenceState() {
  sequenceState.clear();
}
