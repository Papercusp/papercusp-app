/**
 * env-switcher-prefs — the per-machine "which env operators are enabled" preference
 * for the cross-platform env switcher (dogfood-silent-canonical-hive-join P-017 / D-007).
 *
 * The owner wanted full env parity (dev/prod/staging/local) BUT an easy way to turn off
 * envs a user doesn't want (right-click → disable). A disabled env is not provisioned/
 * started by install-time provisioning (and is rendered inert in the switcher). This is
 * the durable store of that choice.
 *
 * AGENT-LEGIBILITY (owner asked "will agents know how to re-enable?"): the enabled-state
 * is NOT hidden in browser localStorage — it lives in a known file, is reported per-op
 * in GET /api/desktop/dev-operators (`enabled`), and is toggled via POST
 * /api/desktop/dev-operators/set-enabled. So an agent can read which envs are off and
 * turn them back on through the same loopback API the UI uses. See
 * agent-insights/env-switcher-and-local-env-provisioning.
 *
 * Stored as a discovery-style JSON file under the papercusp root (papercuspPath) — the
 * same convention as the other ~/.papercusp discovery files (operator.json,
 * endpoint-ipc.json, desktop-build-target.json), so the (node) provisioning launcher and
 * the operator both read it without a DB round-trip.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { papercuspPath } from '../papercusp-root';

export interface EnvSwitcherPrefs {
  /** Env ids the user has turned OFF (default: none → all enabled). */
  disabled: string[];
}

export interface EnvSwitcherPrefsDeps {
  /** Override the prefs file path (tests). */
  filePath?: string;
  readFile?: (p: string) => string;
  writeFile?: (p: string, data: string) => void;
  ensureDir?: (p: string) => void;
}

const FILE = 'env-switcher-prefs.json';
/** 'release' is the immutable safe escape hatch (D-008) — never disablable. */
const UNDISABLABLE = new Set(['release']);

function prefsPath(deps: EnvSwitcherPrefsDeps): string {
  return deps.filePath ?? papercuspPath(FILE);
}

/** Read the prefs; returns `{ disabled: [] }` on a missing / malformed file (never throws). */
export function readEnvSwitcherPrefs(deps: EnvSwitcherPrefsDeps = {}): EnvSwitcherPrefs {
  const read = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  try {
    const j = JSON.parse(read(prefsPath(deps))) as { disabled?: unknown };
    const disabled = Array.isArray(j?.disabled)
      ? j.disabled.filter((x): x is string => typeof x === 'string' && !UNDISABLABLE.has(x))
      : [];
    return { disabled: [...new Set(disabled)].sort() };
  } catch {
    return { disabled: [] };
  }
}

/**
 * Enable / disable one env id and persist. 'release' can never be disabled. Returns the
 * new prefs. Never throws on a missing file (it creates the dir + file).
 */
export function setEnvEnabled(
  id: string,
  enabled: boolean,
  deps: EnvSwitcherPrefsDeps = {},
): EnvSwitcherPrefs {
  const set = new Set(readEnvSwitcherPrefs(deps).disabled);
  if (enabled || UNDISABLABLE.has(id)) set.delete(id);
  else set.add(id);
  const next: EnvSwitcherPrefs = { disabled: [...set].sort() };

  const p = prefsPath(deps);
  const ensureDir = deps.ensureDir ?? ((dir: string) => void mkdirSync(dir, { recursive: true }));
  const write = deps.writeFile ?? ((fp: string, data: string) => writeFileSync(fp, data));
  ensureDir(dirname(p));
  write(p, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
