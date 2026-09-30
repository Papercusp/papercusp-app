/**
 * gl-strategy.ts — pick (and MEASURE) the GL stack a sandbox desktop's apps run under.
 *
 * THE TRAP THIS CLOSES (agent-insights/headless-desktop-testing-needs-gl): an app
 * launched on a bare `Xvfb` can screenshot uniformly blank while its DOM is perfectly
 * fine. WebKitGTK's accelerated compositor asks for an **EGL** context, gets
 * `libEGL warning: DRI3 error: Could not get DRI3 device`, and never paints the webview
 * into the framebuffer. The window chrome (drawn by the WM) shows up; the content does
 * not. Every screenshot then comes back the same size because nothing ever painted.
 *
 * ⚠ THE MEASUREMENT THAT MAKES THIS SUBTLE — and the reason this module does not just
 * shell out to `glxinfo` and call it a day. Measured on the dev box (2026-08-23,
 * NVIDIA RTX 3090, mesa 20.1.2), on a bare `Xvfb :191`:
 *
 *   glxinfo                          → "OpenGL renderer string: llvmpipe"   exit 0
 *   eglinfo, GBM platform            → EGL vendor NVIDIA, renderer RTX 3090
 *   eglinfo, X11 platform            → EGL vendor Mesa, driver **swrast**,
 *                                      + "libEGL warning: DRI3 error"
 *
 * So GLX reports a working renderer on the very display where the EGL/X11 path that
 * WebKitGTK actually uses degrades to swrast. A naive `glxinfo` probe would therefore
 * record `gl: true` for a display on which the product's own webview still blank-renders
 * — a capability flag that is worse than none, because the registry (D-004) and the BYOC
 * image check (P-012) would both trust it. `glxinfo` is used here ONLY to classify WHICH
 * renderer a chosen strategy resolves to. Whether pixels actually arrive is answered by
 * capturing real pixels and judging them (`@papercusp/image-blankness`) — never by a
 * probe binary's exit code. That is what `desktop-gl-live.test.ts` does, and it is the
 * only assertion in this feature that cannot be satisfied by a lying probe.
 *
 * THE LADDER, in preference order. Every rung is a MEASUREMENT, not an assumption:
 *
 *   'virtualgl'      `vglrun -d egl0 <app>` — GL rendered on the GPU's EGL device (the
 *                    render node) and blitted to the isolated Xvfb. Real hardware GL with
 *                    no focus-steal. Chosen only when the renderer observed THROUGH
 *                    `vglrun` classifies as hardware: a box can have `vglrun` and a render
 *                    node and still fall back to llvmpipe (no usable EGL device, wrong
 *                    group on the render node), and taking this rung there would pay the
 *                    wrapper's cost for software GL while recording `hardware` for a
 *                    display that has none.
 *   'native'         The unwrapped stack already reaches hardware — use it as-is. Forcing
 *                    mesa here would be a DOWNGRADE, which is why this rung exists
 *                    separately from the one below.
 *   'mesa-software'  Force mesa's llvmpipe rasterizer via env. This is the path a GPU-less
 *                    cloud VM takes (D-002/P-012: BYOC workspace VMs have no GPU) and it is
 *                    the CORRECT answer there, not a degradation to apologise for. It is
 *                    also the rescue path when the default vendor dispatch is broken:
 *                    `__GLX_VENDOR_LIBRARY_NAME=mesa` decides which vendor GLX loads, and
 *                    without it `LIBGL_ALWAYS_SOFTWARE` can be silently overridden by an
 *                    installed vendor library — which is exactly why the insight doc
 *                    records the software env vars as "not fixing it".
 *   'none'           No GL at all. Recorded honestly so callers can gate, rather than ship
 *                    a desktop whose screenshots silently lie.
 *
 * Both consumers derive from the constants HERE — `desktop-provisioner` (which spawns apps
 * in-process) and `frame-bootstrap` (which emits bash that runs on a remote frame). The
 * frame cannot execute this TypeScript, so it emits a shell implementation of the SAME
 * ladder built from these same constants, and `gl-strategy.test.ts` pins the two together
 * so they cannot drift (repo convention: derive, pin, or attest — never hand-maintain a
 * second copy).
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

/** How real the GL is. `capabilities.gl` in the D-004 registry stores this, not a boolean. */
export type GlTier = 'hardware' | 'software' | 'none';

export type GlStrategyId = 'virtualgl' | 'native' | 'mesa-software' | 'none';

export interface GlStrategy {
  id: GlStrategyId;
  tier: GlTier;
  /** argv prefix an app is launched under, e.g. `['vglrun','-d','egl0']`. Empty for env-only rungs. */
  launchPrefix: string[];
  /** Env additions layered over the sandbox X env. */
  env: Readonly<Record<string, string>>;
  /** Why this rung was chosen — carried into logs and the registry record. */
  reason: string;
  /** The renderer string actually observed, when a probe produced one. */
  renderer: string | null;
}

/**
 * The EGL **device index** VirtualGL routes through. Deliberately `egl0` and NOT a
 * `/dev/dri/renderD128` path: VGL rejects a path with `[VGL] ERROR: Invalid EGL device`.
 */
export const VIRTUALGL_ARGV: readonly string[] = Object.freeze(['vglrun', '-d', 'egl0']);

/**
 * Force mesa's software rasterizer. `__GLX_VENDOR_LIBRARY_NAME` is the load-bearing one on
 * a box that also has a vendor (e.g. NVIDIA) GLX library: it decides which vendor the GLX
 * dispatch loads, and without it `LIBGL_ALWAYS_SOFTWARE` can be silently overridden.
 */
export const MESA_SOFTWARE_ENV: Readonly<Record<string, string>> = Object.freeze({
  LIBGL_ALWAYS_SOFTWARE: '1',
  GALLIUM_DRIVER: 'llvmpipe',
  __GLX_VENDOR_LIBRARY_NAME: 'mesa',
});

/** Frozen empty env, for rungs that add none. */
const NO_ENV: Readonly<Record<string, string>> = Object.freeze({});

/**
 * Debian/Ubuntu packages a headless desktop needs before ANY rung can work.
 * `libgl1-mesa-dri` carries the llvmpipe driver itself — without it a GPU-less VM has no
 * software GL and falls all the way to `none`; `mesa-utils` provides `glxinfo`, which is
 * how the tier is classified at all.
 */
export const GL_APT_PACKAGES: readonly string[] = Object.freeze([
  'libgl1-mesa-dri',
  'libglx-mesa0',
  'libegl1',
  'mesa-utils',
]);

/** Renderer substrings that mean "this is a software rasterizer, not a GPU". */
export const SOFTWARE_RENDERER_MARKERS: readonly string[] = Object.freeze([
  'llvmpipe',
  'swrast',
  'softpipe',
  'software rasterizer',
]);

/**
 * Classify an `OpenGL renderer string` value into a tier. Pure — this is the same decision
 * `verify-tauri-headless.sh` makes inline in a `case`, lifted so it is testable and so the
 * frame and the operator cannot disagree about what "real GL" means.
 *
 * An absent/blank renderer is `none`: a probe that produced no renderer did not demonstrate
 * GL, and the honest record of that is "no GL", never an optimistic guess.
 */
export function classifyGlRenderer(renderer: string | null | undefined): GlTier {
  const value = (renderer ?? '').trim();
  if (value.length === 0) return 'none';
  const lowered = value.toLowerCase();
  if (SOFTWARE_RENDERER_MARKERS.some((marker) => lowered.includes(marker))) return 'software';
  return 'hardware';
}

/**
 * Extract the renderer from `glxinfo` output. Tolerates the surrounding noise (extension
 * lists, libEGL warnings) that the real command emits on a headless display.
 */
export function parseGlRenderer(glxinfoOutput: string): string | null {
  for (const line of glxinfoOutput.split('\n')) {
    const match = /OpenGL renderer string:\s*(.+?)\s*$/.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * The host facts strategy selection reads. Injected so selection is a pure function in
 * tests — the live implementation is `hostGlProbe()`.
 */
export interface GlProbe {
  /** Is this executable on PATH? */
  hasBinary(name: string): boolean;
  /** Does a DRM render node (`/dev/dri/renderD*`) exist? VirtualGL needs one. */
  hasRenderNode(): boolean;
  /**
   * Run `glxinfo` on `display` under `launchPrefix` with `env` layered over the ambient
   * environment, and return the renderer string (or `null` if it produced none).
   *
   * `env` is what makes the mesa RESCUE rung measurable: the ladder can ask "does forcing
   * mesa produce a renderer where the default dispatch produced nothing?" rather than
   * assuming the answer.
   */
  probeRenderer(
    display: string,
    launchPrefix: readonly string[],
    env: Readonly<Record<string, string>>,
  ): string | null;
}

/**
 * The honest zero value: "measured, and there is no GL here."
 *
 * Exported so the several test fixtures that build a `SandboxDesktop` do not each hand-roll
 * the same literal — and, more importantly, so the value they reach for is the one that
 * claims NOTHING. A fixture defaulting to a hardware strategy would quietly assert a
 * capability on a host that may not have it, which is the exact dishonesty the measurement
 * exists to prevent.
 */
export const NO_GL_STRATEGY: GlStrategy = Object.freeze({
  id: 'none',
  tier: 'none',
  launchPrefix: [],
  env: NO_ENV,
  reason: 'no GL: neither the default dispatch nor forced-mesa produced a renderer, and VirtualGL was unavailable or software-only',
  renderer: null,
});

/**
 * Choose the GL strategy for `display`. Pure over `probe` — see the module header for why
 * each rung is a measurement rather than a capability guess.
 */
export function selectGlStrategy(display: string, probe: GlProbe): GlStrategy {
  // Rung 1 — VirtualGL, only if it demonstrably reaches hardware.
  if (probe.hasBinary('vglrun') && probe.hasRenderNode()) {
    const renderer = probe.probeRenderer(display, VIRTUALGL_ARGV, NO_ENV);
    if (classifyGlRenderer(renderer) === 'hardware') {
      return {
        id: 'virtualgl',
        tier: 'hardware',
        launchPrefix: [...VIRTUALGL_ARGV],
        env: NO_ENV,
        reason: `VirtualGL reached a hardware renderer (${renderer})`,
        renderer,
      };
    }
  }

  // Rung 2/3 — what does the UNWRAPPED stack do? Probed with no env forced, so it reports
  // the real default rather than an answer this function pushed it toward.
  const nativeRenderer = probe.probeRenderer(display, [], NO_ENV);
  const nativeTier = classifyGlRenderer(nativeRenderer);

  if (nativeTier === 'hardware') {
    // Already on a GPU with no wrapper. Forcing mesa here would be a downgrade.
    return {
      id: 'native',
      tier: 'hardware',
      launchPrefix: [],
      env: NO_ENV,
      reason: `the unwrapped stack already reaches a hardware renderer (${nativeRenderer})`,
      renderer: nativeRenderer,
    };
  }

  if (nativeTier === 'software') {
    // The GPU-less cloud VM path (D-002/P-012). Pin mesa explicitly: the default already
    // resolves to a software rasterizer, and pinning keeps it deterministic across hosts
    // whose vendor dispatch would otherwise pick differently.
    return {
      id: 'mesa-software',
      tier: 'software',
      launchPrefix: [],
      env: MESA_SOFTWARE_ENV,
      reason: `mesa software GL (${nativeRenderer}) — the GPU-less path`,
      renderer: nativeRenderer,
    };
  }

  // Rung 3b — the default dispatch produced NOTHING. Forcing mesa can still rescue it when
  // a broken/mismatched vendor GLX library is what swallowed the context.
  const forcedRenderer = probe.probeRenderer(display, [], MESA_SOFTWARE_ENV);
  if (classifyGlRenderer(forcedRenderer) !== 'none') {
    return {
      id: 'mesa-software',
      tier: 'software',
      launchPrefix: [],
      env: MESA_SOFTWARE_ENV,
      reason: `default GL dispatch produced no renderer; forcing mesa recovered one (${forcedRenderer})`,
      renderer: forcedRenderer,
    };
  }

  return NO_GL_STRATEGY;
}

/**
 * Layer a strategy's env over a base env (typically `sandboxXEnv(display)`) and wrap an
 * app's argv in its launch prefix. Kept as ONE call so a caller cannot apply the env and
 * forget the prefix (or vice versa) — the two only work together.
 */
export function applyGlStrategy(
  strategy: GlStrategy,
  base: Record<string, string>,
  argv: readonly string[],
): { env: Record<string, string>; argv: string[] } {
  return {
    env: { ...base, ...strategy.env },
    argv: [...strategy.launchPrefix, ...argv],
  };
}

/**
 * Wraps a probe argv in the SAME confinement the desktop's apps get, so the probe measures
 * the app's GL stack rather than the host's.
 *
 * WI-1223202: without this the ladder ran `glxinfo` directly on the host while the apps ran
 * under bubblewrap, so `capabilities.gl.tier` could record `hardware` for a desktop whose
 * apps rendered in llvmpipe — which is exactly what D-031 found (the sandbox had never bound
 * `/dev/nvidia*`). D-031 fixed the BINDING; this fixes the INSTRUMENT, so the two cannot
 * silently disagree again the next time the sandbox argv changes.
 *
 * A wrap that returns its input unchanged is the honest no-op for an UNSANDBOXED desktop:
 * when apps run raw, host probing is the correct measurement.
 */
export type GlProbeWrap = (cmd: readonly string[]) => readonly string[];

/**
 * The live host probe.
 *
 * `wrap` (optional) is applied AROUND the GL launch prefix, never inside it — `vglrun` has to
 * run INSIDE the sandbox for the same reason the app loop applies `applyGlStrategy` before
 * `buildDesktopSandboxCommand`: VirtualGL's interposition must be subject to the confinement,
 * not sit outside it. Omit `wrap` and this is a host probe, as before.
 */
export function hostGlProbe(wrap?: GlProbeWrap): GlProbe {
  return {
    hasBinary(name) {
      try {
        // `command` is a shell builtin, but passing an argv array with the shell option
        // makes Node concatenate the arguments and emit DEP0190. `which` accepts
        // the same binary-name lookup without routing caller data through a shell.
        return spawnSync('which', [name], { stdio: 'ignore' }).status === 0;
      } catch {
        return false;
      }
    },
    hasRenderNode() {
      try {
        return readdirSync('/dev/dri').some((entry) => entry.startsWith('renderD'));
      } catch {
        return false;
      }
    },
    probeRenderer(display, launchPrefix, env) {
      const probed = [...launchPrefix, 'glxinfo'];
      const argv = wrap ? [...wrap(probed)] : probed;
      try {
        const res = spawnSync(argv[0]!, argv.slice(1), {
          env: { ...process.env, ...env, DISPLAY: display },
          encoding: 'utf8',
          timeout: 15_000,
        });
        if (res.status !== 0) return null;
        return parseGlRenderer(res.stdout ?? '');
      } catch {
        return null;
      }
    },
  };
}

/**
 * Detect the GL strategy for a live display. Thin wrapper over `selectGlStrategy` +
 * `hostGlProbe` so callers have one obvious entry point.
 *
 * ⚠ PASS `wrap` FOR ANY DESKTOP WHOSE APPS ARE SANDBOXED (WI-1223202). The 1-arg form
 * measures the HOST, which is correct only when the apps run on the host too. A provisioner
 * gets its wrap from `desktopSandboxSession().forGlProbe`, so the probe and the apps come out
 * of one builder with one context and cannot drift apart.
 */
export function detectGlStrategy(display: string, wrap?: GlProbeWrap): GlStrategy {
  return selectGlStrategy(display, hostGlProbe(wrap));
}

/* ────────────────────────── frame (bash) projection ────────────────────────── */

/**
 * Where the frame's bootstrap records the strategy it measured, for the agent loop to
 * source. A FILE rather than an exported variable because the bootstrap shell and the
 * agent's shell are different processes on the frame.
 */
export const GL_STRATEGY_ENV_PATH = '/run/papercusp/desktop/gl-strategy.env';

/**
 * Emit the shell implementation of the SAME ladder `selectGlStrategy` implements, for
 * `frame-bootstrap` to embed. The frame runs on a remote VM at bootstrap time and cannot
 * execute this module, so the ladder has to exist in shell too — but every literal in it is
 * derived from the constants above, and `gl-strategy.test.ts` asserts the emitted script
 * carries exactly those, so the two implementations cannot drift apart silently.
 *
 * The script probes `display`, writes `GL_STRATEGY_ENV_PATH`, and logs the tier.
 */
export interface GlSelectScriptOptions {
  /** Where the measured strategy is written. Default `GL_STRATEGY_ENV_PATH`. */
  envPath?: string;
  /**
   * Glob the render-node check expands. Default `/dev/dri/renderD*`. Overridable so
   * `gl-strategy.test.ts` can EXECUTE this script against a fixture and compare its verdict
   * to `selectGlStrategy`'s — a differential test between the two ladders, rather than a
   * substring match that would pass while the shell logic said something else entirely.
   */
  renderNodeGlob?: string;
}

export function buildGlSelectScript(display: string, opts: GlSelectScriptOptions = {}): string {
  const envPath = opts.envPath ?? GL_STRATEGY_ENV_PATH;
  const renderNodeGlob = opts.renderNodeGlob ?? '/dev/dri/renderD*';
  const mesaExports = Object.entries(MESA_SOFTWARE_ENV).map(
    ([k, v]) => `    echo 'export ${k}=${v}' >>"$GL_ENV"`,
  );
  // The marker is DOUBLE-QUOTED inside the glob because a marker containing a space
  // ("software rasterizer") is otherwise parsed as two words and bash rejects the whole
  // `case` with a syntax error — which takes the entire bootstrap section down, not just
  // the GL probe. Caught by the differential test, which executes this script.
  const softwareCase = SOFTWARE_RENDERER_MARKERS.map((m) => `*"${m}"*`).join('|');
  const rendererFrom = (prefix: string) =>
    `DISPLAY=${display} ${prefix}glxinfo 2>/dev/null | sed -n 's/^OpenGL renderer string: *//p' | head -1`;

  return [
    `# GL strategy for ${display} — mirrors selectGlStrategy() in lib/desktop/gl-strategy.ts.`,
    `# Bare Xvfb gives WebKitGTK no EGL context, so it never paints and every screenshot`,
    `# comes back blank (agent-insights/headless-desktop-testing-needs-gl).`,
    `GL_ENV=${shellQuote(envPath)}`,
    `mkdir -p "$(dirname "$GL_ENV")"`,
    `: >"$GL_ENV"`,
    `GL_TIER=none`,
    `GL_RENDERER=""`,
    `# Rung 1 — VirtualGL, only if it demonstrably reaches hardware.`,
    `if command -v vglrun >/dev/null 2>&1 && ls ${renderNodeGlob} >/dev/null 2>&1; then`,
    `  GL_RENDERER="$(${rendererFrom(`${VIRTUALGL_ARGV.join(' ')} `)})"`,
    `  case "$GL_RENDERER" in`,
    `    ${softwareCase}|"") ;;`,
    `    *) GL_TIER=hardware; echo 'export PAPERCUSP_GL_LAUNCH_PREFIX=${VIRTUALGL_ARGV.join(' ')}' >>"$GL_ENV" ;;`,
    `  esac`,
    `fi`,
    `# Rung 2/3 — the unwrapped stack, probed with nothing forced.`,
    `if [ "$GL_TIER" = none ]; then`,
    `  GL_RENDERER="$(${rendererFrom('')})"`,
    `  case "$GL_RENDERER" in`,
    `    "") ;;`,
    `    ${softwareCase})`,
    `      GL_TIER=software`,
    ...mesaExports,
    `      ;;`,
    `    *) GL_TIER=hardware ;;`,
    `  esac`,
    `fi`,
    `# Rung 3b — nothing at all; forcing mesa can still rescue a broken vendor dispatch.`,
    `if [ "$GL_TIER" = none ]; then`,
    `  GL_RENDERER="$(${rendererFrom(`${Object.entries(MESA_SOFTWARE_ENV).map(([k, v]) => `${k}=${v}`).join(' ')} `)})"`,
    `  if [ -n "$GL_RENDERER" ]; then`,
    `    GL_TIER=software`,
    ...mesaExports,
    `  fi`,
    `fi`,
    `echo "export PAPERCUSP_GL_TIER=$GL_TIER" >>"$GL_ENV"`,
    `log "GL strategy for ${display}: tier=$GL_TIER renderer=\${GL_RENDERER:-none}"`,
    `if [ "$GL_TIER" = none ]; then`,
    `  log "WARNING: no GL on ${display} — GTK/WebKitGTK apps will screenshot BLANK (install ${GL_APT_PACKAGES.join(' ')})."`,
    `fi`,
  ].join('\n');
}

/** Minimal single-quote shell escaping, local so this module has no import cycle. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
