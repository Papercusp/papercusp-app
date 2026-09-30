/**
 * Detect abandoned atomic-publish backups named `<live>.old.<pid>`.
 *
 * Several independent publishers use the same safe swap shape: move the live
 * directory aside, publish its replacement, then remove the backup. A killed
 * producer can strand gigabytes without leaving a tracked-file diff. The PID
 * suffix makes the debris recognizable, but it does NOT make blind deletion
 * safe: one real incident left the only complete build in the `.old.<pid>`
 * directory while the live sibling contained only a placeholder.
 *
 * This module is therefore deliberately a detector, never a reaper. It reports
 * both trees so a human can establish which copy is authoritative before any
 * cleanup.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const DEFAULT_STALE_SWAP_MAX_AGE_MINUTES = 30;

// These trees cannot contain an actionable repository publish target and are
// large enough that walking them would make `npm run doctor` needlessly slow.
export const DEFAULT_STALE_SWAP_PRUNE_DIR_NAMES = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "node_modules",
  "target",
]);

const SWAP_BACKUP_NAME = /^(.+)\.old\.(\d+)$/;

function missingDuringScan(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (missingDuringScan(error)) return null;
    throw error;
  }
}

function readDirIfPresent(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    if (missingDuringScan(error)) return [];
    throw error;
  }
}

/**
 * Count logical bytes and entries without following symlinks. Directory inode
 * sizes are excluded; the result describes payload size, not filesystem blocks.
 */
export function summarizeTree(root) {
  const rootStat = lstatIfPresent(root);
  if (!rootStat) return null;
  if (!rootStat.isDirectory()) {
    return { bytes: rootStat.size, files: 1, directories: 0 };
  }

  const summary = { bytes: 0, files: 0, directories: 1 };
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readDirIfPresent(current)) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        summary.directories += 1;
        pending.push(path);
        continue;
      }
      const stat = lstatIfPresent(path);
      if (!stat) continue;
      summary.files += 1;
      summary.bytes += stat.size;
    }
  }
  return summary;
}

function relativePath(repoRoot, path) {
  return relative(repoRoot, path).split(sep).join("/");
}

function describeLiveSibling(repoRoot, path) {
  const summary = summarizeTree(path);
  if (!summary) {
    return {
      path: relativePath(repoRoot, path),
      state: "missing",
      looksPopulated: false,
      bytes: 0,
      files: 0,
      directories: 0,
    };
  }

  const isDirectory = summary.directories > 0;
  const looksPopulated = isDirectory
    ? summary.files > 0 || summary.directories > 1
    : summary.bytes > 0;
  return {
    path: relativePath(repoRoot, path),
    state: isDirectory
      ? looksPopulated
        ? "populated"
        : "empty"
      : "not-a-directory",
    looksPopulated,
    ...summary,
  };
}

/**
 * @param {{
 *   repoRoot: string,
 *   maxAgeMinutes?: number,
 *   nowMs?: number,
 *   pruneDirNames?: Set<string>,
 * }} args
 */
export function findStaleSwapLeftovers({
  repoRoot,
  maxAgeMinutes = DEFAULT_STALE_SWAP_MAX_AGE_MINUTES,
  nowMs = Date.now(),
  pruneDirNames = DEFAULT_STALE_SWAP_PRUNE_DIR_NAMES,
}) {
  if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes < 0) {
    throw new Error(
      `maxAgeMinutes must be a non-negative finite number; received ${maxAgeMinutes}`,
    );
  }

  const cutoffMs = nowMs - maxAgeMinutes * 60_000;
  const problems = [];
  const pending = [repoRoot];

  while (pending.length > 0) {
    const parent = pending.pop();
    for (const entry of readDirIfPresent(parent)) {
      if (!entry.isDirectory()) continue;
      if (pruneDirNames.has(entry.name)) continue;

      const path = join(parent, entry.name);
      const match = SWAP_BACKUP_NAME.exec(entry.name);
      if (!match) {
        pending.push(path);
        continue;
      }

      // Treat a candidate as a leaf: nested matches are part of the same stale
      // payload, and reporting both would double-count bytes and remediation.
      const stat = lstatIfPresent(path);
      if (!stat || stat.mtimeMs > cutoffMs) continue;
      const summary = summarizeTree(path);
      if (!summary) continue;

      const livePath = join(parent, match[1]);
      problems.push({
        path: relativePath(repoRoot, path),
        pid: Number(match[2]),
        ageMinutes: Math.max(0, (nowMs - stat.mtimeMs) / 60_000),
        ...summary,
        liveSibling: describeLiveSibling(repoRoot, livePath),
      });
    }
  }

  return problems.sort((a, b) => a.path.localeCompare(b.path));
}

export function formatBytes(bytes) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function formatFileCount(files) {
  return `${files} file${files === 1 ? "" : "s"}`;
}

/** Human-readable evidence and the safety rule the operator must preserve. */
export function formatStaleSwapProblems(problems) {
  const lines = problems.map((problem) => {
    const live = problem.liveSibling;
    const liveSize =
      live.state === "missing"
        ? ""
        : `, ${formatBytes(live.bytes)}, ${formatFileCount(live.files)}`;
    return (
      `${problem.path}: ${problem.ageMinutes.toFixed(1)}m old, ` +
      `${formatBytes(problem.bytes)}, ${formatFileCount(problem.files)}; ` +
      `live sibling ${live.path} is ${live.state}${liveSize}`
    );
  });
  return [
    lines.join("\n    "),
    "",
    "    Inspect both trees before cleanup. A missing, empty, or much smaller live sibling",
    "    can mean the `.old.<pid>` tree is the only complete copy; this guard never deletes it.",
  ].join("\n");
}
