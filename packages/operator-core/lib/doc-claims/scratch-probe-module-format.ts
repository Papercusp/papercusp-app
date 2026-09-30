/**
 * EI-19480727636352439 / EI-21075977983151346 — doc claim: a scratch probe written
 * OUTSIDE any `package.json` declaring `"type": "module"` compiles as **CJS**, so any
 * top-level `await` in it dies at transform time with:
 *
 *     ERROR: Top-level await is currently not supported with the "cjs" output format
 *
 * The error names the OUTPUT FORMAT, not the fix, which is why it costs a round-trip
 * every time: it points the reader at their own code (wrap in an async main? find an
 * esbuild knob?) when the actual fix is one character of filename — name it `.mts`.
 *
 * Both scratch locations agents use are outside such a scope:
 *   - the in-tree `.papercusp/scratch/` (gitignored; resolves repo imports), and
 *   - `/tmp` (resolves nothing from the repo).
 *
 * This module is the PIN for that prose. It is deliberately pure — no fs, no spawn —
 * so the judgement is testable against fixtures in both directions. The live leg lives
 * in the test: if someone later drops a `"type": "module"` package.json over the scratch
 * tree (a real fix), the claim stops being true and the pin FAILS, forcing the doc to be
 * updated rather than silently rotting into a lie.
 */

/** A `package.json` that could cover a probe path. */
export interface CoveringPackageJson {
  /** Directory the package.json sits in. */
  dir: string;
  /** Its `type` field, if declared. */
  type?: string | undefined;
}

export interface ScratchProbeFormatVerdict {
  /** How a bare `.ts` file at `probeDir` is compiled. */
  moduleFormat: 'esm' | 'cjs';
  /** The extension a probe using top-level await MUST use to work at `probeDir`. */
  requiredExtension: '.mts' | '.ts';
  /** Whether top-level await works in a bare `.ts` there. */
  topLevelAwaitWorksInBareTs: boolean;
  /** Directory of the nearest package.json that governs `probeDir`, if any. */
  governingPackageJsonDir: string | null;
  reason: string;
}

/** Normalize to forward slashes and drop any trailing separator. */
function normalizeDir(dir: string): string {
  const forward = dir.replace(/\\/g, '/');
  const trimmed = forward.replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : '/';
}

/** True when `ancestor` is `dir` itself or a directory above it. */
function covers(ancestor: string, dir: string): boolean {
  const a = normalizeDir(ancestor);
  const d = normalizeDir(dir);
  if (a === d) return true;
  return d.startsWith(a === '/' ? '/' : `${a}/`);
}

/**
 * Decide how a bare `.ts` file at `probeDir` is compiled, given every `package.json`
 * that might govern it. The NEAREST governing package.json wins, exactly as Node
 * resolves `type` — so a `type: module` far above is correctly overridden by a nearer
 * package.json that omits `type` (which means CJS).
 */
export function judgeScratchProbeFormat(input: {
  probeDir: string;
  packageJsons: readonly CoveringPackageJson[];
}): ScratchProbeFormatVerdict {
  const { probeDir } = input;

  let nearest: CoveringPackageJson | null = null;
  for (const candidate of input.packageJsons) {
    if (!covers(candidate.dir, probeDir)) continue;
    if (nearest === null || normalizeDir(candidate.dir).length > normalizeDir(nearest.dir).length) {
      nearest = candidate;
    }
  }

  const isEsm = nearest?.type === 'module';

  if (isEsm) {
    return {
      moduleFormat: 'esm',
      requiredExtension: '.ts',
      topLevelAwaitWorksInBareTs: true,
      governingPackageJsonDir: nearest ? normalizeDir(nearest.dir) : null,
      reason: `governed by ${normalizeDir(nearest!.dir)}/package.json which declares "type": "module", so a bare .ts is ESM and top-level await works`,
    };
  }

  return {
    moduleFormat: 'cjs',
    requiredExtension: '.mts',
    topLevelAwaitWorksInBareTs: false,
    governingPackageJsonDir: nearest ? normalizeDir(nearest.dir) : null,
    reason:
      nearest === null
        ? 'no package.json governs this path, so a bare .ts compiles as CJS — name the probe .mts to use top-level await'
        : `governed by ${normalizeDir(nearest.dir)}/package.json which does not declare "type": "module", so a bare .ts compiles as CJS — name the probe .mts to use top-level await`,
  };
}

/** The literal esbuild emits, which is what sends readers looking in the wrong place. */
export const CJS_TOP_LEVEL_AWAIT_ERROR =
  'Top-level await is currently not supported with the "cjs" output format';

export interface ScratchProbeDocVerdict {
  ok: boolean;
  problems: string[];
}

/**
 * Verify the guidance actually carries the fix. A doc that reproduces the misleading
 * error without naming `.mts` is precisely the failure these two items reported, so
 * naming the error alone does not satisfy the claim.
 */
export function judgeScratchProbeDocClaim(input: { docText: string }): ScratchProbeDocVerdict {
  const problems: string[] = [];
  const text = input.docText;

  if (!text.includes('.mts')) {
    problems.push('guidance does not name the `.mts` fix');
  }
  if (!/\.papercusp\/scratch/.test(text)) {
    problems.push('guidance does not name the `.papercusp/scratch/` probe location');
  }
  if (!text.includes(CJS_TOP_LEVEL_AWAIT_ERROR)) {
    problems.push('guidance does not quote the actual error text agents will search for');
  }

  return { ok: problems.length === 0, problems };
}
