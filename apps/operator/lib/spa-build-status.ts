/**
 * What to tell a browser when `dist/index.html` is missing (EI-10539).
 *
 * The old 503 said, unconditionally:
 *
 *   operator-vite is not built. Run `npm --workspace @papercusp/operator-vite run build`.
 *
 * On 2026-07-12 that message met the owner on a dead desktop — and it was
 * actively misleading. The bundle HAD been built; a `pnpm install` had hijacked
 * node_modules, `@assistant-ui/store` lost its `tapClientResource` export, and
 * the resulting LINK-time failure landed AFTER vite's renderStart hook had
 * already emptied dist/. So the app was dead, and the 503's suggested cure was
 * the exact command that had just failed — it would fail again, identically,
 * for as long as the real cause went unnamed.
 *
 * bin/vite-build-singleflight now (a) stages builds so a failure can no longer
 * destroy a working bundle, and (b) drops `.vite-build-failure.json` next to
 * dist/ when a build fails. If we are bundle-less AND that record exists, say so
 * — name the failure, point at the log — instead of prescribing a build.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface BuildFailure {
  /** ISO timestamp the build failed at. */
  failedAt: string;
  /** The build's exit status. */
  exitCode: number;
  /** Absolute path to the tee'd build log. */
  log: string;
}

/** The marker bin/vite-build-singleflight writes beside dist/ on a failed build. */
export const BUILD_FAILURE_MARKER = '.vite-build-failure.json';

/** Parse the failure marker's JSON. Exported for tests; null on anything unusable. */
export function parseBuildFailure(raw: string): BuildFailure | null {
  try {
    const v = JSON.parse(raw) as Partial<BuildFailure>;
    if (typeof v.failedAt !== 'string' || typeof v.exitCode !== 'number') return null;
    return { failedAt: v.failedAt, exitCode: v.exitCode, log: typeof v.log === 'string' ? v.log : '' };
  } catch {
    return null;
  }
}

/**
 * Read the failure record for the build that produces `distRoot`, or null if the
 * last build did not fail (the marker is deleted on every successful build).
 *
 * The marker sits beside dist/, i.e. at `<distRoot>/../.vite-build-failure.json`.
 * A packaged desktop's SPA dist has no sibling marker — it never builds in place
 * — so this correctly returns null there and we fall back to the plain message.
 */
export function readBuildFailure(distRoot: string): BuildFailure | null {
  const marker = resolve(distRoot, '..', BUILD_FAILURE_MARKER);
  if (!existsSync(marker)) return null;
  try {
    return parseBuildFailure(readFileSync(marker, 'utf8'));
  } catch {
    return null;
  }
}

/** Last `n` non-blank lines of the build log — the part that names the error. */
export function tailLines(log: string, n = 12): string[] {
  return log
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '')
    .slice(-n);
}

/**
 * The 503 body. Pure — takes the failure record (if any) and the log tail, so it
 * is unit-testable without touching disk.
 *
 * With no failure on record we are genuinely un-built (a fresh checkout): the
 * original "run the build" advice is right, and we keep it. With a failure on
 * record, prescribing that same build is the bug — lead with what actually
 * happened.
 */
export function formatMissingBundleMessage(failure: BuildFailure | null, logTail: string[] = []): string {
  const buildCmd = 'npm --workspace @papercusp/operator-vite run build';
  if (!failure) {
    return `operator-vite is not built. Run \`${buildCmd}\`.`;
  }
  const lines = [
    `operator-vite has NO built bundle — and the LAST BUILD FAILED (exit ${failure.exitCode}, ${failure.failedAt}).`,
    '',
    `Re-running \`${buildCmd}\` will fail exactly the same way until the underlying`,
    'error is fixed — it is the command that just failed. Fix the error first.',
  ];
  if (failure.log) lines.push('', `Build log: ${failure.log}`);
  if (logTail.length > 0) lines.push('', '--- tail of the failed build ---', ...logTail);
  return lines.join('\n');
}

/** Compose the whole 503 body for `distRoot` (reads the marker + log tail). */
export function describeMissingBundle(distRoot: string): string {
  const failure = readBuildFailure(distRoot);
  if (!failure) return formatMissingBundleMessage(null);
  let tail: string[] = [];
  if (failure.log && existsSync(failure.log)) {
    try {
      tail = tailLines(readFileSync(failure.log, 'utf8'));
    } catch {
      /* log unreadable — the failure record alone is still worth reporting */
    }
  }
  return formatMissingBundleMessage(failure, tail);
}

/** Convenience for callers that hold a dist root and want the index path too. */
export function distIndexPath(distRoot: string): string {
  return join(distRoot, 'index.html');
}

/**
 * Identity of the bundle currently ON DISK (EI-15848).
 *
 * WHY index.html IS THE RIGHT SUBJECT, and not a heuristic: Vite emits
 * CONTENT-HASHED asset filenames (`assets/index-<hash>.js`) and index.html is
 * the manifest that references them. So a bundle whose code changed produces a
 * different index.html, and one whose code did not produce the same bytes.
 * Hashing the entry document is therefore an exact identity for "which build is
 * being served", not a proxy for it — no mtime (which a no-op rebuild bumps and
 * a restored file does not), no directory walk.
 *
 * Deliberately NOT the injected shell: `serveIndexHtml` splices per-REQUEST
 * state (flags, workspace id) into the HTML before sending it, so hashing what
 * we send would change whenever a FLAG flipped and report a phantom new build.
 * We hash the file, then inject the result.
 *
 * Returns null when the bundle is missing — the caller already has
 * `describeMissingBundle` for that case, and a null here means "no opinion",
 * never "unchanged". A reader must not treat it as a mismatch: an absent
 * bundle during a rebuild would otherwise nag the user to reload into a 503.
 */
export function readBundleIdentity(distRoot: string): string | null {
  const indexPath = distIndexPath(distRoot);
  if (!existsSync(indexPath)) return null;
  try {
    return createHash('sha256').update(readFileSync(indexPath)).digest('hex').slice(0, 16);
  } catch {
    // Unreadable mid-rebuild (vite stages then swaps). Same contract as missing:
    // no opinion. Reporting a mismatch here would fire the notice on every build.
    return null;
  }
}

// The COMPARISON deliberately lives in `./spa-build-identity` (no node
// builtins) so the browser-side notice can import it without dragging this
// module's `node:fs`/`node:crypto` into the client bundle.
