/**
 * Pure DHT-universe classification — which DHT a process joins, given its
 * `PAPERCUSP_DHT_BOOTSTRAP` environment and the marker-file fallback.
 *
 * Two kinds of caller need the SAME answer:
 *  - the swarm itself (swarm.ts), resolving its own bootstrap at construction;
 *  - host probes that classify ANOTHER process from outside, e.g.
 *    `dev:service_health`'s isolated-DHT alarm (WI-10005995), which reads a
 *    product host's `/proc/<pid>/environ` and its unit `Environment=`.
 *
 * It lives apart from swarm.ts so a probe can classify without loading
 * swarm.ts's hyperswarm / pot-git / identity import graph. swarm.ts re-exports
 * every symbol here, so existing importers are unchanged. No node: imports —
 * callers inject file I/O and the default file path.
 */

/** One DHT bootstrap node (host + UDP port). */
export interface DhtBootstrapNode {
  host: string;
  port: number;
}

/**
 * Parse `PAPERCUSP_DHT_BOOTSTRAP` — a comma-separated `host:port` list — into
 * hyperdht bootstrap nodes. Returns undefined when unset/empty/all-malformed
 * (→ the swarm uses the real public DHT, the default). When set, every peer
 * that shares the value joins the SAME isolated DHT — which is how two
 * instances on ONE box deterministically discover each other without relying on
 * public-DHT NAT hairpinning (the same trick the in-process p079 live test uses
 * via `hyperdht/testnet`). Exported for unit testing.
 */
export function parseDhtBootstrap(raw: string | undefined): DhtBootstrapNode[] | undefined {
  if (!raw) return undefined;
  const nodes = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s): DhtBootstrapNode | null => {
      const i = s.lastIndexOf(':'); // lastIndexOf tolerates IPv6-ish hosts minimally
      if (i <= 0) return null;
      const host = s.slice(0, i);
      const port = Number.parseInt(s.slice(i + 1), 10);
      return host && Number.isFinite(port) && port > 0 ? { host, port } : null;
    })
    .filter((n): n is DhtBootstrapNode => n !== null);
  return nodes.length ? nodes : undefined;
}

/**
 * WI-3604 (split-DHT-universe recurrence guard). The DHT universe this
 * process's shared swarm actually resolved to, at construction time:
 * `'isolated'` (a custom bootstrap list, e.g. the fed-a/fed-b rig DHT),
 * `'public'` (no `PAPERCUSP_DHT_BOOTSTRAP` set — the real public DHT), or
 * `'misconfigured'` (the env var WAS set but resolved to zero usable
 * bootstrap nodes — {@link parseDhtBootstrap}'s all-malformed case — which
 * silently falls back to the PUBLIC DHT, the exact "isolated federation
 * quietly breaks" failure this guards against).
 */
export type DhtUniverseState =
  | { mode: 'isolated'; bootstrap: DhtBootstrapNode[] }
  | { mode: 'public' }
  | { mode: 'misconfigured'; envValue: string };

/** Pure classifier: given the raw `PAPERCUSP_DHT_BOOTSTRAP` value, resolve
 * which DHT universe a swarm constructed with it would join. Exported for
 * unit testing (no I/O). */
export function resolveDhtUniverseState(envBootstrapRaw: string | undefined): DhtUniverseState {
  const trimmed = envBootstrapRaw?.trim();
  if (!trimmed) return { mode: 'public' };
  const bootstrap = parseDhtBootstrap(trimmed);
  if (bootstrap?.length) return { mode: 'isolated', bootstrap };
  return { mode: 'misconfigured', envValue: trimmed };
}

/** Where an effective bootstrap value came from. */
export type DhtBootstrapSource = 'env' | 'file' | 'none';

export interface EffectiveDhtBootstrap {
  /** The raw value to classify; undefined when neither source supplies one. */
  raw: string | undefined;
  source: DhtBootstrapSource;
  /** The marker file consulted (or that WOULD be consulted) for the fallback. */
  filePath: string;
}

export interface EffectiveDhtBootstrapInput {
  /** The environment of the process being classified (this one, or another's /proc environ). */
  env: Readonly<Record<string, string | undefined>>;
  /** `~/.papercusp/dht-bootstrap` for that process's HOME — the caller joins it, so path
   *  separators stay platform-correct without a node: import here. */
  defaultFilePath: string;
  /** Reads a file as UTF-8; throws when missing/unreadable (treated as no value). */
  readFile: (path: string) => string;
}

/**
 * The ONE precedence rule for a process's effective DHT bootstrap: the
 * `PAPERCUSP_DHT_BOOTSTRAP` env var wins; when it is unset/empty, the marker
 * file (`PAPERCUSP_DHT_BOOTSTRAP_FILE`, else `defaultFilePath`) supplies it
 * (EI-8893). A missing/unreadable/empty file is not an error.
 */
export function resolveEffectiveDhtBootstrap(input: EffectiveDhtBootstrapInput): EffectiveDhtBootstrap {
  const filePath = input.env.PAPERCUSP_DHT_BOOTSTRAP_FILE?.trim() || input.defaultFilePath;
  const envVal = input.env.PAPERCUSP_DHT_BOOTSTRAP?.trim();
  if (envVal) return { raw: envVal, source: 'env', filePath };
  try {
    const contents = input.readFile(filePath).trim();
    if (contents) return { raw: contents, source: 'file', filePath };
  } catch {
    // missing/unreadable marker file → no file-provided value
  }
  return { raw: undefined, source: 'none', filePath };
}
