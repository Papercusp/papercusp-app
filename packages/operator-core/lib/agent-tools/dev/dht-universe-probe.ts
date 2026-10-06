/**
 * WI-10005995 — standing alarm for a product host booted on an ISOLATED DHT
 * outside a drill.
 *
 * WI-10004745's root cause: a hand-placed systemd drop-in
 * (`papercusp-bg-host.service.d/91-isolated-dht.conf`, added for a rig hairpin)
 * kept the tower bg-host on the isolated testnet for ~3 months. No internet
 * joiner could reach a tower-hosted pot, and the first signal was a failed GCP
 * cold-join. A host-local drop-in cannot be guarded by a repo test, so this
 * probe reads what the host ACTUALLY resolves, from outside the process:
 *
 *  - `running`    — the live MainPID's `/proc/<pid>/environ`, i.e. what the
 *                   process booted with (drop-ins, EnvironmentFile=, and the
 *                   user-manager environment all included);
 *  - `configured` — the user-manager environment overlaid with the unit's loaded
 *                   `Environment=`, i.e. what the NEXT start resolves — so a
 *                   drop-in that was placed (and daemon-reloaded) but not yet
 *                   restarted into is flagged before it takes effect.
 *
 * Both apply the swarm's own precedence ({@link resolveEffectiveDhtBootstrap}:
 * env var, else the `dht-bootstrap` marker file) and classifier
 * ({@link resolveDhtUniverseState}), so the alarm cannot disagree with what the
 * swarm would join. A host off the public DHT is expected only while a drill
 * holds the `hive-git-physical-rig` lock; outside one it is a warning.
 *
 * Limits, stated rather than hidden: an `EnvironmentFile=` is visible only in
 * `running` (systemd's `Environment` property does not expand it), and the marker
 * file is read NOW, not as it was at boot.
 */
import { readFile as readFileAsync } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  resolveDhtUniverseState,
  resolveEffectiveDhtBootstrap,
  type DhtBootstrapSource,
  type DhtUniverseState,
} from '../../sync/hyperbee/dht-universe';
import { execProbeCommand, parseMultiUnitShowOutput } from './systemd-service-probe';
import { getTxPool, listLiveResourceDomains } from '../locks/su-lock-store';

/** The product hosts whose DHT universe decides whether internet joiners can reach this box's pots. */
export const DHT_PRODUCT_UNITS: readonly string[] = ['papercusp-bg-host.service', 'papercusp-staging-api.service'];

/** The exclusive lease a physical drill holds while it legitimately runs hosts on the rig DHT. */
export const PHYSICAL_RIG_RESOURCE = 'hive-git-physical-rig';

export type DhtUniverseMode = DhtUniverseState['mode'];

export interface DhtUniverseReading {
  mode: DhtUniverseMode;
  source: DhtBootstrapSource;
  /** The raw bootstrap value, when one was found (env or marker file). */
  bootstrap?: string;
}

export interface ProductHostDhtUniverse {
  unit: string;
  mainPid: number;
  /** What the live process resolved; null when there is no live MainPID or its environ is unreadable. */
  running: DhtUniverseReading | null;
  /** What the next start resolves from the user-manager env + the unit's loaded Environment=. */
  configured: DhtUniverseReading;
  warning?: string;
}

export interface DhtUniverseBlock {
  /** Present only when some host is off the public DHT (the lock is not read otherwise).
   *  `null` = the lock store could not be read, which never suppresses a warning. */
  rigLockHeld?: boolean | null;
  hosts: ProductHostDhtUniverse[];
  warnings: Array<{ unit: string; warning: string }>;
}

/**
 * Parse systemd's `Environment=` property as printed by `systemctl show`:
 * space-separated `KEY=VALUE` tokens, a token containing whitespace being
 * double-quoted with backslash escapes. PURE.
 */
export function parseSystemdEnvironmentProperty(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value) return out;
  for (const m of value.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    const token = m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? '');
    const eq = token.indexOf('=');
    if (eq > 0) out[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return out;
}

/** Parse newline-separated `KEY=VALUE` lines (`systemctl --user show-environment`). PURE. */
export function parseEnvironmentLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** Parse a NUL-separated `/proc/<pid>/environ` body. PURE. */
export function parseProcEnviron(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of body.split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

/** Classify one environment with the swarm's own precedence + classifier. PURE given `readFile`. */
export function classifyDhtEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string,
  fallbackHome: string,
): DhtUniverseReading {
  const home = env.HOME?.trim() || fallbackHome;
  const effective = resolveEffectiveDhtBootstrap({
    env,
    defaultFilePath: join(home, '.papercusp', 'dht-bootstrap'),
    readFile,
  });
  const state = resolveDhtUniverseState(effective.raw);
  return { mode: state.mode, source: effective.source, ...(effective.raw ? { bootstrap: effective.raw } : {}) };
}

function describeReading(label: string, reading: DhtUniverseReading): string {
  const from = reading.source === 'env' ? 'PAPERCUSP_DHT_BOOTSTRAP' : 'the dht-bootstrap marker file';
  return `${label} resolves ${reading.mode.toUpperCase()} (${from}${reading.bootstrap ? ` = ${reading.bootstrap}` : ''})`;
}

/**
 * The warning for one host, or undefined. PURE. A host off the public DHT is
 * expected only while a drill holds {@link PHYSICAL_RIG_RESOURCE}; an UNREADABLE
 * lock (`null`) still warns, because an alarm that goes quiet when its own
 * evidence is missing is the failure WI-10004745 already had for 3 months.
 */
export function dhtUniverseWarning(
  unit: string,
  running: DhtUniverseReading | null,
  configured: DhtUniverseReading,
  rigLockHeld: boolean | null | undefined,
): string | undefined {
  if (rigLockHeld === true) return undefined;
  const offPublic: string[] = [];
  if (running && running.mode !== 'public') offPublic.push(describeReading('the running process', running));
  if (configured.mode !== 'public') offPublic.push(describeReading('the next start', configured));
  if (!offPublic.length) return undefined;
  const lock =
    rigLockHeld === false
      ? `no drill holds the ${PHYSICAL_RIG_RESOURCE} lock`
      : `the ${PHYSICAL_RIG_RESOURCE} lock could not be read`;
  return (
    `${unit} is off the PUBLIC DHT outside a drill: ${offPublic.join('; ')}, and ${lock}. ` +
    `Internet joiners cannot reach the pots this host serves (WI-10004745).`
  );
}

/** The remediation verb for a DHT-universe warning on `unit`. PURE. */
export function dhtUniverseNextVerb(unit: string): string {
  const target = unit.includes('staging') ? 'staging' : 'bg-host';
  return (
    `remove the stray PAPERCUSP_DHT_BOOTSTRAP source for ${unit} (a drop-in under ` +
    `~/.config/systemd/user/${unit}.d/, \`systemctl --user show-environment\`, or ~/.papercusp/dht-bootstrap), ` +
    `\`systemctl --user daemon-reload\`, then dev:restart { target: "${target}" }`
  );
}

/** Live check: does any coordination domain hold a lease on the rig? null when unreadable. */
export async function readRigLockHeld(timeoutMs = 3000): Promise<boolean | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const domains = await Promise.race([
      listLiveResourceDomains(getTxPool(), PHYSICAL_RIG_RESOURCE),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('rig lock read timed out')), timeoutMs);
      }),
    ]);
    return domains.length > 0;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface DhtUniverseProbeDeps {
  platform?: string;
  units?: readonly string[];
  systemctl?: (args: string[]) => Promise<string>;
  readProcEnviron?: (pid: number) => Promise<string>;
  readFile?: (path: string) => string;
  rigLockHeld?: () => Promise<boolean | null>;
  homedir?: string;
}

const defaultSystemctl = async (args: string[]): Promise<string> =>
  (await execProbeCommand('systemctl', args, 5000)).stdout;

/**
 * Probe every installed product host. Returns null when systemd cannot be read
 * (non-Linux, or the user manager is unreachable) — no verdict, never a false
 * "clean". A unit that is not installed on this host is skipped.
 */
export async function probeProductHostDhtUniverse(deps: DhtUniverseProbeDeps = {}): Promise<DhtUniverseBlock | null> {
  if ((deps.platform ?? process.platform) !== 'linux') return null;
  const units = deps.units ?? DHT_PRODUCT_UNITS;
  const systemctl = deps.systemctl ?? defaultSystemctl;
  const readProcEnviron = deps.readProcEnviron ?? ((pid: number) => readFileAsync(`/proc/${pid}/environ`, 'utf8'));
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const home = deps.homedir ?? homedir();

  let blocks: Map<string, string>[];
  let managerEnv: Record<string, string>;
  try {
    const [show, managerOut] = await Promise.all([
      systemctl(['--user', 'show', '-p', 'Id', '-p', 'LoadState', '-p', 'MainPID', '-p', 'Environment', ...units]),
      systemctl(['--user', 'show-environment']).catch(() => ''),
    ]);
    blocks = parseMultiUnitShowOutput(show);
    managerEnv = parseEnvironmentLines(managerOut);
  } catch {
    return null;
  }

  const hosts: ProductHostDhtUniverse[] = [];
  await Promise.all(
    blocks.map(async (props, i) => {
      if (props.get('LoadState') === 'not-found') return;
      const unit = props.get('Id') || units[i] || 'unknown';
      const mainPid = Number.parseInt(props.get('MainPID') ?? '0', 10) || 0;
      const configured = classifyDhtEnvironment(
        { ...managerEnv, ...parseSystemdEnvironmentProperty(props.get('Environment')) },
        readFile,
        home,
      );
      let running: DhtUniverseReading | null = null;
      if (mainPid > 0) {
        try {
          running = classifyDhtEnvironment(parseProcEnviron(await readProcEnviron(mainPid)), readFile, home);
        } catch {
          running = null;
        }
      }
      hosts[i] = { unit, mainPid, running, configured };
    }),
  );
  const present = hosts.filter((h): h is ProductHostDhtUniverse => h !== undefined);

  const anyOffPublic = present.some(
    (h) => h.configured.mode !== 'public' || (h.running !== null && h.running.mode !== 'public'),
  );
  if (!anyOffPublic) return { hosts: present, warnings: [] };

  const rigLockHeld = await (deps.rigLockHeld ?? (() => readRigLockHeld()))();
  const warnings: Array<{ unit: string; warning: string }> = [];
  for (const host of present) {
    const warning = dhtUniverseWarning(host.unit, host.running, host.configured, rigLockHeld);
    if (warning) {
      host.warning = warning;
      warnings.push({ unit: host.unit, warning });
    }
  }
  return { rigLockHeld, hosts: present, warnings };
}
