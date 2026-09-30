/**
 * Esbuild transform detector — the commit-path check for files that TypeScript
 * accepts but the bundler rejects (EI-5240).
 *
 * TypeScript's parser/checker and esbuild do not reject the same source. In
 * particular, duplicate declarations and duplicate modifiers can survive the
 * TypeScript-only checks while esbuild refuses to transform the file. Because
 * the operator's bundle host uses esbuild, that distinction is a hard runtime
 * boundary: a file that cannot transform must not enter the shared tree.
 *
 * Esbuild is LAZILY imported. The registry is loaded during operator startup,
 * while esbuild may be externalized or unavailable in a lightweight host; a
 * missing loader therefore remains a detector failure that the content guard
 * handles fail-open, rather than turning startup into a dependency failure.
 */

/** A single esbuild transform diagnostic, normalized to the content-lint shape. */
export interface EsbuildTransformError {
  /** Esbuild locations are already 1-based; null when no location was supplied. */
  line: number | null;
  /** Esbuild columns are 0-based; this value is normalized to 1-based. */
  col: number | null;
  reason: string;
}

type EsbuildLoader = 'ts' | 'tsx' | 'js' | 'jsx';

interface EsbuildTransformOptions {
  loader: EsbuildLoader;
  target: 'node22';
  sourcefile: string;
  tsconfigRaw: { compilerOptions: { experimentalDecorators: true } };
  logLevel: 'silent';
}

type EsbuildTransform = (source: string, options: EsbuildTransformOptions) => Promise<unknown>;

interface RecordLike {
  [key: string]: unknown;
}

function asRecord(value: unknown): RecordLike | null {
  return typeof value === 'object' && value !== null ? (value as RecordLike) : null;
}

/** Map a supported source extension to the loader esbuild expects. */
function loaderForFile(fileName: string): EsbuildLoader | null {
  if (fileName.endsWith('.tsx')) return 'tsx';
  if (fileName.endsWith('.jsx')) return 'jsx';
  if (fileName.endsWith('.ts') || fileName.endsWith('.mts') || fileName.endsWith('.cts')) return 'ts';
  if (fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')) return 'js';
  return null;
}

let cachedTransform: EsbuildTransform | null = null;

/** Resolve esbuild only when a matching dirty file is actually checked. */
async function loadTransform(): Promise<EsbuildTransform> {
  if (cachedTransform) return cachedTransform;
  const mod = (await import('esbuild')) as {
    transform?: unknown;
    default?: { transform?: unknown };
  };
  const transform = mod.transform ?? mod.default?.transform;
  if (typeof transform !== 'function') {
    throw new Error('esbuild: transform export is unavailable — the transform check cannot run');
  }
  cachedTransform = transform as EsbuildTransform;
  return cachedTransform;
}

/**
 * Pull the first real esbuild diagnostic out of a TransformFailure. Other
 * errors (loader/runtime failures, malformed mocked modules, and so on) return
 * null so the caller can rethrow them and the content guard can fail open.
 */
function firstDiagnostic(error: unknown): EsbuildTransformError | null {
  const failure = asRecord(error);
  if (!failure || !Array.isArray(failure.errors) || failure.errors.length === 0) return null;
  const diagnostic = asRecord(failure.errors[0]);
  if (!diagnostic || typeof diagnostic.text !== 'string' || diagnostic.text.length === 0) return null;
  const location = asRecord(diagnostic.location);
  const line = typeof location?.line === 'number' && Number.isFinite(location.line) ? location.line : null;
  const column = typeof location?.column === 'number' && Number.isFinite(location.column) ? location.column : null;
  return { line, col: column == null ? null : column + 1, reason: diagnostic.text };
}

/**
 * Transform one supported source file with the same syntax engine used by the
 * bundle host. No bundling or module resolution occurs, so unresolved imports
 * are valid here; only a transform failure is returned as a cleanly formatted
 * diagnostic. Import/tooling failures deliberately propagate to the caller.
 */
export async function findEsbuildTransformError(
  fileName: string,
  text: string,
): Promise<EsbuildTransformError | null> {
  const loader = loaderForFile(fileName);
  if (!loader) return null;

  // Keep the import outside the transform-error catch: an unavailable or
  // malformed esbuild installation must be visible to the guard's fail-open
  // logging instead of being mistaken for a source offender.
  const transform = await loadTransform();
  try {
    await transform(text, {
      loader,
      target: 'node22',
      sourcefile: fileName,
      tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
      logLevel: 'silent',
    });
    return null;
  } catch (error) {
    const diagnostic = firstDiagnostic(error);
    if (!diagnostic) throw error;
    return diagnostic;
  }
}
