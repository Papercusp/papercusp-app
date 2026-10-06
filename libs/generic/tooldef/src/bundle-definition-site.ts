/**
 * Resolve the module that DEFINED a tool when the tool and this library were bundled
 * into one file (unified-bug-pipeline-and-honest-queue-2026-10-05 P-002 /
 * EI-25176539351759672).
 *
 * ## The failure this closes
 *
 * `captureDefinitionSite` (define-tool.ts) finds a tool's defining file by walking the
 * call stack and taking the first frame whose FILE differs from its own. That is
 * correct when every module is its own file (tsx, vitest), and wrong in exactly one
 * shape: a bundle. When esbuild inlines tooldef and every tool module into one output
 * file, every frame — the capture, `defineTool`, and the tool's own top-level code —
 * reports the SAME file, so the walk skips them all and records no source at all.
 *
 * Nothing errors. The host's staleness check then answers `unknown/tool-source-unknown`
 * for every tool, the deployment-staleness screen stamps `deployment-freshness-unknown`
 * readiness on every promoted tool-failure it triages, and nothing ever re-screens those
 * rows. Measured 2026-10-05: 217 open bugs held that stamp, every one of them
 * `tool-source-unknown`, because the triage runs inside the bundled bg-host.
 *
 * ## The fix: frames carry a POSITION, and the bundle already names its modules
 *
 * A non-minified esbuild bundle precedes each inlined module with one comment line,
 * `// <path relative to the bundler's working directory>`. So a frame's LINE in the
 * bundle identifies its module: the nearest marker at or above that line. The capture
 * records the frames' lines; a host that can read the bundle maps them back here. The
 * defining module is the first frame whose module differs from frame [0]'s — the same
 * "skip my own frames" rule the unbundled walk applies to files, applied to modules.
 *
 * Deliberately pure and dependency-free: this lib ships a browser-safe barrel, so the
 * file read and the working-directory calibration live in the host (operator-core
 * `tool-source-file.ts`). Every miss is `null` — unknown, never a guess — exactly like
 * `projectedToolSourceFile`.
 */

/** Where a tool was defined, when every captured frame sat in one bundled file. */
export interface BundledDefinitionSite {
  /** Absolute path of the bundled file all captured frames reported. */
  readonly file: string;
  /**
   * 1-based line numbers of the captured frames in that file, innermost first. Frame
   * [0] is tooldef's own capture, which is what identifies tooldef's module.
   */
  readonly lines: readonly number[];
}

/** The module-boundary markers of one bundle, in ascending line order. */
export interface BundleModuleMarkers {
  /** 1-based line of each `// <path>` marker, ascending. */
  readonly lines: readonly number[];
  /** The marker path at the same index, relative to the bundler's working directory. */
  readonly paths: readonly string[];
}

/** The two modules a bundled site resolves to. */
export interface BundledDefiningModule {
  /** Marker path of tooldef's own module (frame [0]); a host calibrates against it. */
  readonly selfModule: string;
  /** Marker path of the module whose top-level code called `defineTool`. */
  readonly definingModule: string;
}

// One whole line: `// ` then a single path token ending in a script extension. esbuild
// strips ordinary source comments from its output, so a line of this exact shape is a
// module marker; the extension requirement keeps prose-shaped legal comments out.
const MODULE_MARKER = /^\/\/ (\S+\.(?:[cm]?[jt]s|[jt]sx))\r?$/;

/** Index every module-boundary marker in a bundle's text. Linear, one pass. */
export function indexBundleModuleMarkers(text: string): BundleModuleMarkers {
  const lines: number[] = [];
  const paths: string[] = [];
  let line = 1;
  let pos = 0;
  for (;;) {
    const end = text.indexOf('\n', pos);
    if (text.startsWith('// ', pos)) {
      const match = MODULE_MARKER.exec(text.slice(pos, end === -1 ? text.length : end));
      if (match) {
        lines.push(line);
        paths.push(match[1]);
      }
    }
    if (end === -1) break;
    pos = end + 1;
    line += 1;
  }
  return { lines, paths };
}

/** The marker path governing `line`, or null when the line precedes every marker. */
export function bundleModuleAtLine(markers: BundleModuleMarkers, line: number): string | null {
  let lo = 0;
  let hi = markers.lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (markers.lines[mid] <= line) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found === -1 ? null : markers.paths[found];
}

/**
 * Frame [0] of every captured site is `captureDefinitionSite`, which lives in this
 * library's `define-tool` module. A bundle whose marker at that line names anything else
 * is not the bundle the frames were captured from (rewritten since the process loaded
 * it), so its line numbers mean nothing and the site must stay unknown.
 */
const DEFINE_TOOL_MODULE = /(?:^|\/)define-tool\.[cm]?[jt]s$/;

/**
 * The defining module of a bundled site: the first frame after frame [0] whose module
 * is known and differs from frame [0]'s. Frames that precede every marker (esbuild's
 * runtime helpers, emitted above the first module) are skipped rather than taken.
 * Null when frame [0]'s module is not this library's `define-tool` module (a mismatched
 * bundle) or no frame leaves it.
 */
export function definingModuleOfBundledSite(
  markers: BundleModuleMarkers,
  site: Pick<BundledDefinitionSite, 'lines'>,
): BundledDefiningModule | null {
  if (site.lines.length === 0) return null;
  const selfModule = bundleModuleAtLine(markers, site.lines[0]);
  if (!selfModule || !DEFINE_TOOL_MODULE.test(selfModule)) return null;
  for (const line of site.lines.slice(1)) {
    const module = bundleModuleAtLine(markers, line);
    if (module && module !== selfModule) return { selfModule, definingModule: module };
  }
  return null;
}
