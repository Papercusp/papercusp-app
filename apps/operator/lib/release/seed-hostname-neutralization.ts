/**
 * EI-20040763522089574 — keep the BUILD BOX's hostname out of the shipped seed.
 *
 * ── THE LEAK THIS EXISTS FOR ──
 * RocksDB stamps the writing machine's hostname into EVERY SST it produces, as the
 * `host.identity` TABLE PROPERTY (its `DBOptions::db_host_id` defaults to the
 * gethostname() value). Measured on the shipped seed: `corestore/db/000009.sst` and
 * `000012.sst` each carry `host.identity<build-hostname>`.
 *
 * ⚠ THAT IS NOT HYPERCORE CONTENT, so it is unreachable by every filter that works on
 * blocks or tables — including `SEED_EXCLUDED_TABLES` and the shipped-suffix guard in
 * `seed-provider-corestore.ts`, which together fixed the DIFFERENT `presence` leak
 * (EI-20108164746219771). Do not expect either of those to help here.
 *
 * ── WHY A NAMESPACE AND NOT A CONFIG OPTION ──
 * `rocksdb-native` exposes no host-id knob, verified at three layers: its JS constructor
 * destructures only `{columnFamily, state, snapshot, keyEncoding, valueEncoding}`;
 * `rocksdb_native_init` takes 14 explicit tunables, none of them a host id; and
 * `db->options` is built as a POSITIONAL struct literal, so adding one is an ABI change
 * to the underlying C shim rather than "pass one more option".
 *
 * gethostname() IS uts-namespaced, so running the cut inside a UTS namespace with a
 * neutral name fixes the whole CLASS — every RocksDB file the cut writes, now and later
 * — with no upstream patch and no byte rewriting. MEASURED, control vs treatment, same
 * script: RocksDB's own info LOG reported `Host name (Env): <build-hostname>` outside and
 * `Host name (Env): build` inside `bwrap --dev-bind / / --unshare-uts --hostname build`.
 *
 * `bwrap` specifically, NOT `unshare`: this box sets
 * `kernel.apparmor_restrict_unprivileged_userns=1`, under which `unshare -Ur --uts` fails
 * writing `/proc/self/uid_map` and bare `unshare --uts` fails outright — while bwrap
 * carries an AppArmor profile granting it `userns`.
 *
 * ── WHY REFUSING IS CHEAP (and why this is not a platform outage) ──
 * UTS namespaces are Linux-only, so on macOS the honest answer is "do not CUT here".
 * That costs almost nothing in practice: `mac-vm-build.sh` already defaults
 * `PAPERCUSP_SEED_REUSE_CORESTORE` to `auto`, which resolves to REUSE whenever a
 * committed corestore + manifest exist — so macOS normally grafts an already-cut
 * corestore and never writes an SST at all. The refusal below therefore only fires in the
 * bootstrap case (nothing committed to reuse), which is exactly when silently stamping a
 * Mac VM's hostname into a published installer would be worst.
 *
 * The decision is a PURE function so it can be tested without spawning anything; the
 * caller performs the re-exec.
 *
 * ── WHY NOT REUSE `provision/sandbox.ts` (which also shells bwrap) ──
 * It has a same-named private `buildBwrapArgv`, but it is the OPPOSITE tool: a
 * CONFINEMENT sandbox for untrusted plugin setup scripts — `--unshare-pid/ipc/user`,
 * `--proc`, `--dev`, `tmpfs /tmp`, `--ro-bind /usr|/lib|/etc`. Every one of those breaks a
 * seed cut, which needs the real filesystem, a real /tmp, the live corestore and a PG
 * socket. We unshare UTS and NOTHING else, for the single purpose of changing what
 * gethostname() returns. Nothing there is exported either. So this is a genuinely
 * different concern, not a fork — do not "consolidate" the two.
 */

import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';

const { X_OK } = constants;

/**
 * Marker proving we are already inside the neutralized namespace, so the re-exec cannot
 * recurse. ⚠ Presence of this variable is NOT trusted on its own — {@link planHostnameNeutralization}
 * also requires the hostname to actually BE the neutral one, so exporting it by hand
 * cannot be used to skip the namespace and ship a stamped seed.
 */
export const SEED_UTS_MARKER_ENV = 'PAPERCUSP_SEED_UTS_NEUTRALIZED';

/**
 * The hostname baked into every SST the cut writes. It becomes a PERMANENT, published
 * string inside every installer, so it is deliberately generic, obviously synthetic, and
 * says what produced it. Override with PAPERCUSP_SEED_BUILD_HOSTNAME.
 */
export const DEFAULT_NEUTRAL_BUILD_HOSTNAME = 'papercusp-build';

/**
 * Resolve an executable on PATH. Deliberately not `which`/`command -v` via a shell: this
 * runs on the release path, and shelling out to answer "does a binary exist" adds a shell
 * injection surface and a second failure mode for no benefit.
 */
export function findExecutableOnPath(
  name: string,
  opts?: { readonly pathEnv?: string; readonly isExecutable?: (p: string) => boolean },
): string | null {
  const pathEnv = opts?.pathEnv ?? process.env.PATH ?? '';
  const isExecutable =
    opts?.isExecutable ??
    ((p: string) => {
      try {
        accessSync(p, X_OK);
        return true;
      } catch {
        return false;
      }
    });
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export type NeutralizationPlan =
  /** Nothing to do — this run writes no corestore, or we are already inside the namespace. */
  | { readonly kind: 'proceed'; readonly reason: string }
  /** Re-exec the CLI under `bwrap` with a neutral UTS hostname. */
  | { readonly kind: 're-exec'; readonly bwrapPath: string; readonly neutralHostname: string }
  /** Refuse: this run would write a corestore whose hostname we cannot neutralize. */
  | { readonly kind: 'refuse'; readonly message: string };

export function planHostnameNeutralization(inp: {
  /** Does this invocation CUT a fresh corestore? (false for --no-corestore / --reuse-corestore) */
  readonly wantCorestore: boolean;
  readonly platform: NodeJS.Platform;
  /** Value of {@link SEED_UTS_MARKER_ENV}. */
  readonly markerSet: boolean;
  /** What gethostname() reports RIGHT NOW (inside the namespace, if we are in one). */
  readonly currentHostname: string;
  readonly neutralHostname: string;
  /** Resolved `bwrap` binary, or null when it is not on PATH. */
  readonly bwrapPath: string | null;
}): NeutralizationPlan {
  // A run that writes no corestore writes no SST. --reuse-corestore GRAFTS an
  // already-cut store (its SSTs carry whatever the ORIGINAL cut stamped, which is that
  // cut's problem, not this one's), and --no-corestore ships no store at all.
  if (!inp.wantCorestore) {
    return { kind: 'proceed', reason: 'no corestore is cut by this invocation (--no-corestore / --reuse-corestore)' };
  }

  if (inp.markerSet) {
    // TRUST THE HOSTNAME, NOT THE MARKER. If someone exported the marker to skip the
    // namespace, the hostname is still the build box's and the seed would still leak —
    // so verify rather than believe. This is the one bypass worth closing explicitly,
    // because it is the shape a frustrated operator reaches for at 2am.
    if (inp.currentHostname === inp.neutralHostname) {
      return { kind: 'proceed', reason: `inside the neutralized namespace (hostname=${inp.currentHostname})` };
    }
    return {
      kind: 'refuse',
      message:
        `[cut-seed] REFUSING TO CUT: ${SEED_UTS_MARKER_ENV} is set, but the hostname is ` +
        `'${inp.currentHostname}', not the expected '${inp.neutralHostname}'. That marker only means ` +
        '"already inside the neutralized namespace" — setting it by hand does not neutralize anything, ' +
        'it just skips the step, and every SST this cut writes would carry the real hostname as its ' +
        'RocksDB host.identity table property (EI-20040763522089574). Unset it and re-run.',
    };
  }

  if (inp.platform !== 'linux') {
    return {
      kind: 'refuse',
      message:
        `[cut-seed] REFUSING TO CUT a corestore on '${inp.platform}': the build box's hostname ` +
        `('${inp.currentHostname}') would be stamped into every SST as RocksDB's host.identity table ` +
        'property and shipped in the installer (EI-20040763522089574). UTS namespaces are Linux-only, ' +
        'so there is no way to neutralize it here.\n' +
        '  REMEDY: pass --reuse-corestore <prior seed dir> to graft an already-cut corestore (this is ' +
        'what mac-vm-build.sh does by default — PAPERCUSP_SEED_REUSE_CORESTORE=auto resolves to reuse ' +
        'whenever a committed corestore exists), or cut the corestore on Linux.\n' +
        '  --no-corestore also passes, at the cost of a git-only seed.',
    };
  }

  if (!inp.bwrapPath) {
    return {
      kind: 'refuse',
      message:
        '[cut-seed] REFUSING TO CUT a corestore: `bwrap` is not on PATH, so the build hostname cannot ' +
        `be neutralized, and every SST would ship '${inp.currentHostname}' as RocksDB's host.identity ` +
        'table property (EI-20040763522089574).\n' +
        '  REMEDY: install bubblewrap (apt-get install bubblewrap), or pass --reuse-corestore <prior ' +
        'seed dir> / --no-corestore.\n' +
        '  ⛔ Do NOT work around this by setting ' + SEED_UTS_MARKER_ENV + ' — it is verified against ' +
        'the actual hostname and will refuse anyway.',
    };
  }

  return { kind: 're-exec', bwrapPath: inp.bwrapPath, neutralHostname: inp.neutralHostname };
}

/**
 * The bwrap argv that re-runs this process inside a neutral UTS namespace.
 *
 * `--dev-bind / /` deliberately shares the filesystem: the cut needs the repo, the live
 * corestore and a PG socket, and measured control-vs-treatment probes confirm filesystem,
 * network and PG behave IDENTICALLY inside and out. `--unshare-uts` is the ONLY namespace
 * unshared — notably NOT `--unshare-net`, or the cut could not reach PG or the operator.
 */
/**
 * The env the re-exec'd child runs with. A pure function for the same reason
 * {@link planHostnameNeutralization} is one: the interesting part is the DECISION, and a
 * spawn is not a testable unit.
 *
 * Two variables, both load-bearing in OPPOSITE directions:
 *  • the UTS marker stops the child re-exec'ing forever;
 *  • the real hostname is the only way the child can still know what it must NOT ship.
 *    Inside the namespace `gethostname()` answers with the neutral label, so a child that
 *    resolved the hostname itself would scan the staged seed for the wrong string and call
 *    a leaking seed clean. MEASURED: `bwrap --unshare-uts --hostname papercusp-build` leaves
 *    the environment intact while `hostname` reports the neutral name, so the variable
 *    crosses the boundary the hostname cannot.
 *
 * An already-set real hostname is PRESERVED rather than overwritten: a nested invocation
 * must not relabel itself with the sandbox's own name.
 */
export function buildNeutralizedChildEnv(inp: {
  readonly env: NodeJS.ProcessEnv;
  readonly realHostname: string;
  readonly realHostnameEnvKey: string;
}): NodeJS.ProcessEnv {
  // Built by mutation on a copy rather than as one object literal: `ProcessEnv` carries a
  // REQUIRED readonly NODE_ENV (next/types/global.d.ts), which a literal cannot satisfy
  // without a cast — and a cast here would be hiding the one property the child must inherit.
  const next: NodeJS.ProcessEnv = { ...inp.env };
  next[SEED_UTS_MARKER_ENV] = '1';
  next[inp.realHostnameEnvKey] = inp.env[inp.realHostnameEnvKey] || inp.realHostname;
  return next;
}

export function buildBwrapArgv(inp: {
  readonly bwrapPath: string;
  readonly neutralHostname: string;
  readonly execPath: string;
  /**
   * `process.execArgv` — the node flags the CURRENT process was started with.
   *
   * ⚠ LOAD-BEARING, and omitting it is a silent, total break rather than a degradation.
   * This CLI runs under tsx, whose loader arrives ONLY via these flags:
   *   ["--require", ".../tsx/dist/preflight.cjs", "--import", ".../tsx/dist/loader.mjs"]
   * Drop them and the child is plain node, which strips TypeScript types but does NOT
   * resolve this repo's `./x.js` → `./x.ts` import convention — so the re-exec dies at
   * module resolution with ERR_MODULE_NOT_FOUND before any cut work begins. Caught by an
   * integration run; no unit test on the parent process can see it, because the parent
   * always has its own loader already applied.
   */
  readonly execArgv: readonly string[];
  readonly argv: readonly string[];
}): readonly string[] {
  return [
    '--dev-bind',
    '/',
    '/',
    '--unshare-uts',
    '--hostname',
    inp.neutralHostname,
    inp.execPath,
    ...inp.execArgv,
    ...inp.argv,
  ];
}
