#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { diffChars, diffLines } from "diff";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const require = createRequire(import.meta.url);
const typescript = require("typescript");
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;

function mergeLineRanges(ranges) {
  return [...ranges]
    .sort((left, right) => left.startLine - right.startLine)
    .reduce((merged, range) => {
      const previous = merged.at(-1);
      if (previous && range.startLine <= previous.endLine + 1) {
        previous.endLine = Math.max(previous.endLine, range.endLine);
      } else {
        merged.push({ ...range });
      }
      return merged;
    }, []);
}

/** Return the added line ranges from a zero-context unified diff. */
export function parseAddedLineRanges(diff) {
  const ranges = [];
  for (const match of diff.matchAll(HUNK_RE)) {
    const startLine = Number(match[1]);
    const lineCount = Number(match[2] ?? 1);
    if (lineCount > 0) {
      ranges.push({ startLine, endLine: startLine + lineCount - 1 });
    }
  }
  return mergeLineRanges(ranges);
}

function lineStartOffsets(source) {
  const offsets = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) offsets.push(index + 1);
  }
  return offsets;
}

function lineNumberForOffset(source, offset) {
  const boundedOffset = Math.min(
    Math.max(Number.isInteger(offset) ? offset : source.length, 0),
    source.length,
  );
  let line = 1;
  for (let index = 0; index < boundedOffset; index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function scriptKindForPath(repoPath) {
  switch (extname(repoPath).toLowerCase()) {
    case ".jsx":
      return typescript.ScriptKind.JSX;
    case ".tsx":
      return typescript.ScriptKind.TSX;
    case ".js":
    case ".cjs":
    case ".mjs":
      return typescript.ScriptKind.JS;
    default:
      return typescript.ScriptKind.TS;
  }
}

function firstParseDiagnostic(source, repoPath) {
  const file = typescript.createSourceFile(
    repoPath,
    source,
    typescript.ScriptTarget.Latest,
    false,
    scriptKindForPath(repoPath),
  );
  return file.parseDiagnostics?.[0] ?? null;
}

/** Convert a one-based inclusive line range into Prettier character offsets. */
export function characterRangeForLines(source, range) {
  const offsets = lineStartOffsets(source);
  const startLine = Math.min(Math.max(range.startLine, 1), offsets.length);
  const endLine = Math.min(Math.max(range.endLine, startLine), offsets.length);
  return {
    start: offsets[startLine - 1],
    end: endLine < offsets.length ? offsets[endLine] : source.length,
  };
}

/**
 * Apply range formatting without ever publishing an unparseable intermediate.
 * Prettier may need the enclosing statement's terminator even when the requested
 * range ends earlier; use its first parse error to expand the range and retry.
 */
export function applyPrettierRangeWrites(
  source,
  lineRanges,
  formatRange,
  repoPath = "fixture.ts",
) {
  let current = source;

  for (const lineRange of [...lineRanges].reverse()) {
    let startLine = Math.max(lineRange.startLine, 1);
    let endLine = Math.max(lineRange.endLine, startLine);
    const maxLine = lineStartOffsets(current).length;

    while (true) {
      const range = characterRangeForLines(current, { startLine, endLine });
      if (range.end <= range.start) break;

      const candidate = formatRange(current, range);
      if (typeof candidate !== "string") {
        throw new Error(`formatter returned a non-string for ${repoPath}`);
      }

      const diagnostic = firstParseDiagnostic(candidate, repoPath);
      if (!diagnostic) {
        current = candidate;
        break;
      }

      const diagnosticLine = lineNumberForOffset(candidate, diagnostic.start);
      if (diagnosticLine < startLine) {
        startLine = diagnosticLine;
        continue;
      }
      if (diagnosticLine > endLine && endLine < maxLine) {
        endLine = Math.min(maxLine, diagnosticLine);
        continue;
      }

      const message = typescript.flattenDiagnosticMessageText(
        diagnostic.messageText,
        " ",
      );
      throw new Error(
        `range formatter produced invalid ${repoPath} near line ${diagnosticLine}: ${message}`,
      );
    }
  }

  return current;
}

function git(args, cwd = REPO_ROOT) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || `git ${args.join(" ")} failed`).trim());
  }
  return result.stdout;
}

function isWithinRoot(candidate, root) {
  const rootRelative = relative(root, candidate);
  return (
    rootRelative !== ".." &&
    !rootRelative.startsWith(`..${sep}`) &&
    !isAbsolute(rootRelative)
  );
}

/** Resolve the Git repository that owns an explicit path. */
function gitRepoRootForPath(absolutePath, fallbackRoot) {
  try {
    const output = git(
      ["rev-parse", "--show-toplevel"],
      dirname(absolutePath),
    ).trim();
    if (!output) return fallbackRoot;
    const candidate = resolve(output);
    return isWithinRoot(candidate, fallbackRoot) ? candidate : fallbackRoot;
  } catch {
    return fallbackRoot;
  }
}

function isTracked(repoPath, repoRoot = REPO_ROOT) {
  const result = spawnSync(
    "git",
    ["ls-files", "--error-unmatch", "--", repoPath],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  return result.status === 0;
}

/**
 * Return added line ranges from the repository that owns the requested file.
 *
 * `repoRoot` is optional for hermetic tests that build a temporary superproject
 * containing a nested repository; production callers use the canonical root.
 */
export function changedLineRanges(repoPath, source, repoRoot = REPO_ROOT) {
  const absolutePath = resolve(repoRoot, repoPath);
  const ownerRoot = gitRepoRootForPath(absolutePath, repoRoot);
  const ownerPath = relative(ownerRoot, absolutePath).split(sep).join("/");

  if (!isTracked(ownerPath, ownerRoot)) {
    return source.length === 0
      ? []
      : [{ startLine: 1, endLine: lineStartOffsets(source).length }];
  }
  return parseAddedLineRanges(
    git(
      [
        "diff",
        "--no-ext-diff",
        "--unified=0",
        "--no-color",
        "HEAD",
        "--",
        ownerPath,
      ],
      ownerRoot,
    ),
  );
}

const RANGE_CHECK_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

export const FORMAT_USAGE = `Usage:
  npm run format:check:scoped -- [--whole-file <file>] [--new-file <file>] <file...>
  npm run format:write:scoped -- [--whole-file <file>] [--new-file <file>] <file...>

Check or write only the changed ranges of explicit files in the repository. Repeat
--whole-file for existing files that should be checked or written in full. Repeat
--new-file for files created by the current task; those files are also checked or
written as complete files even if git-sync has already committed them. Both flags
accept an equals form, such as --whole-file=path/to/file.ts.
`;

/** Validate and normalize explicit in-repository file paths. */
export function normalizeScopedPaths(args) {
  const rawPaths = args[0] === "--" ? args.slice(1) : args;
  if (rawPaths.length === 0) {
    throw new Error(
      "provide one or more explicit file paths after `npm run format:check:scoped --`",
    );
  }

  return rawPaths.map((rawPath) => {
    if (!rawPath || rawPath.startsWith("-") || /[*?{}[\]!]/.test(rawPath)) {
      throw new Error(
        `format check accepts explicit file paths only: ${rawPath || "<empty>"}`,
      );
    }
    const absolutePath = resolve(REPO_ROOT, rawPath);
    const repoPath = relative(REPO_ROOT, absolutePath);
    if (
      !repoPath ||
      repoPath === ".." ||
      repoPath.startsWith(`..${sep}`) ||
      isAbsolute(repoPath)
    ) {
      throw new Error(
        `format check path must be inside the repository: ${rawPath}`,
      );
    }
    if (!existsSync(absolutePath) || !lstatSync(absolutePath).isFile()) {
      throw new Error(`format check path must be an existing file: ${rawPath}`);
    }
    const realPath = realpathSync(absolutePath);
    const realRepoPath = relative(REPO_ROOT, realPath);
    if (
      !realRepoPath ||
      realRepoPath === ".." ||
      realRepoPath.startsWith(`..${sep}`) ||
      isAbsolute(realRepoPath)
    ) {
      throw new Error(
        `format check path must resolve inside the repository: ${rawPath}`,
      );
    }
    return repoPath.split(sep).join("/");
  });
}

function prettierCli() {
  return require.resolve("prettier/bin/prettier.cjs", { paths: [REPO_ROOT] });
}

export function buildPrettierCheckArgs(cli, repoPath, range) {
  return buildPrettierArgs(cli, repoPath, range, "check");
}

export function buildPrettierArgs(cli, repoPath, range, mode = "check") {
  return [
    cli,
    mode === "write" ? "--write" : "--check",
    "--ignore-unknown",
    "--range-start",
    String(range.start),
    "--range-end",
    String(range.end),
    repoPath,
  ];
}

/** Build a whole-file Prettier invocation for an explicitly classified file. */
export function buildPrettierWholeFileArgs(cli, repoPath) {
  return [cli, "--ignore-unknown", "--stdin-filepath", repoPath];
}

function formatWholeFileWithPrettier(cli, repoPath, source) {
  const result = spawnSync(
    process.execPath,
    buildPrettierWholeFileArgs(cli, repoPath),
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      input: source,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || `prettier failed for ${repoPath}`).trim(),
    );
  }
  return result.stdout;
}

/**
 * Reapply a whole-file formatter result without publishing changes outside the
 * requested source range.
 *
 * Prettier's range parser can reject a valid range nested inside an object
 * method because it extracts the method (`async handler(...) { ... }`) and then
 * parses that fragment as a standalone program. Whole-file formatting remains
 * valid in that case. Diff at character granularity so the fallback can retain
 * legacy formatting everywhere else while adopting only formatter edits whose
 * source span is fully inside the line-aligned requested range.
 */
export function applyFormattedChangesWithinRange(source, formatted, range) {
  if (source === formatted) return source;

  const output = [];
  const parts = diffChars(source, formatted);
  let sourceOffset = 0;

  for (let index = 0; index < parts.length; ) {
    const part = parts[index];
    if (!part.added && !part.removed) {
      output.push(part.value);
      sourceOffset += part.value.length;
      index += 1;
      continue;
    }

    const changeStart = sourceOffset;
    let original = "";
    let replacement = "";
    while (
      index < parts.length &&
      (parts[index].added || parts[index].removed)
    ) {
      const changed = parts[index];
      if (changed.removed) {
        original += changed.value;
        sourceOffset += changed.value.length;
      } else {
        replacement += changed.value;
      }
      index += 1;
    }
    const changeEnd = sourceOffset;
    const insertion = changeStart === changeEnd;
    const touchesRange = insertion
      ? changeStart > range.start && changeStart < range.end
      : changeStart < range.end && changeEnd > range.start;

    if (!touchesRange) {
      output.push(original);
      continue;
    }
    if (!insertion && (changeStart < range.start || changeEnd > range.end)) {
      throw new Error(
        `whole-file formatter change crosses requested range boundary (${changeStart}-${changeEnd} vs ${range.start}-${range.end})`,
      );
    }
    output.push(replacement);
  }

  return output.join("");
}

export function buildPrettierStdinArgs(cli, repoPath, range) {
  return [
    cli,
    "--ignore-unknown",
    "--range-start",
    String(range.start),
    "--range-end",
    String(range.end),
    "--stdin-filepath",
    repoPath,
  ];
}

export function formatRangeWithPrettier(cli, repoPath, source, range) {
  const result = spawnSync(
    process.execPath,
    buildPrettierStdinArgs(cli, repoPath, range),
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      input: source,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const rangeError = (
      result.stderr || `prettier failed for ${repoPath}`
    ).trim();
    try {
      return applyFormattedChangesWithinRange(
        source,
        formatWholeFileWithPrettier(cli, repoPath, source),
        range,
      );
    } catch (fallbackError) {
      throw new Error(
        `${rangeError}\nwhole-file range fallback failed: ${
          fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError)
        }`,
      );
    }
  }
  return result.stdout;
}

/**
 * Prettier's range formatter can reprint an enclosing AST node before the
 * requested range. Comparing equal offsets in its whole-file output then
 * compares unrelated bytes after that reprint shifts the output. Map formatter
 * edits back to source offsets instead, so only edits that touch the requested
 * source range fail the scoped check.
 *
 * Ranges from characterRangeForLines are line-aligned. An insertion exactly at
 * either boundary is treated as adjacent context: Prettier may insert context
 * while expanding the range, but a formatting change to a requested line is
 * represented by a removed source line and is still detected.
 */
export function rangeFormattingDiffers(source, formatted, range) {
  if (
    source.slice(range.start, range.end) ===
    formatted.slice(range.start, range.end)
  ) {
    return false;
  }

  let sourceOffset = 0;
  for (const part of diffLines(source, formatted, { newlineIsToken: true })) {
    if (part.added) {
      if (sourceOffset > range.start && sourceOffset < range.end) {
        return true;
      }
      continue;
    }

    const nextSourceOffset = sourceOffset + part.value.length;
    if (
      part.removed &&
      sourceOffset < range.end &&
      nextSourceOffset > range.start
    ) {
      return true;
    }
    sourceOffset = nextSourceOffset;
  }

  return false;
}

function splitFileArgs(raw) {
  const paths = [];
  const newFilePaths = [];
  const wholeFilePaths = [];

  for (let index = 0; index < raw.length; index += 1) {
    const argument = raw[index];
    if (argument === "--new-file" || argument === "--whole-file") {
      const value = raw[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`\`${argument}\` requires an explicit file path`);
      }
      if (argument === "--new-file") {
        newFilePaths.push(value);
      } else {
        wholeFilePaths.push(value);
      }
      index += 1;
      continue;
    }
    if (
      argument.startsWith("--new-file=") ||
      argument.startsWith("--whole-file=")
    ) {
      const flag = argument.startsWith("--new-file=")
        ? "--new-file"
        : "--whole-file";
      const value = argument.slice(`${flag}=`.length);
      if (!value) {
        throw new Error(`\`${flag}\` requires an explicit file path`);
      }
      if (flag === "--new-file") {
        newFilePaths.push(value);
      } else {
        wholeFilePaths.push(value);
      }
      continue;
    }
    paths.push(argument);
  }

  return { paths, newFilePaths, wholeFilePaths };
}

function rejectDuplicateClassifications(classifications) {
  const seen = new Map();
  for (const [classification, paths] of classifications) {
    for (const path of paths) {
      const previousClassification = seen.get(path);
      if (previousClassification) {
        if (previousClassification === classification) {
          throw new Error(
            `file cannot be listed more than once as ${classification}: ${path}`,
          );
        }
        throw new Error(
          `file cannot be both ${previousClassification} and ${classification}: ${path}`,
        );
      }
      seen.set(path, classification);
    }
  }
}

/**
 * @returns {{
 *   mode: "check" | "write" | "help";
 *   paths: string[];
 *   newFilePaths?: string[];
 *   wholeFilePaths?: string[];
 * }}
 */
export function parseFormatCliArgs(args) {
  const raw = args[0] === "--" ? args.slice(1) : [...args];
  if (raw.includes("--help") || raw.includes("-h")) {
    return { mode: "help", paths: [] };
  }
  const write = raw[0] === "--write";
  const {
    paths: rawPaths,
    newFilePaths: rawNewFilePaths,
    wholeFilePaths: rawWholeFilePaths,
  } = splitFileArgs(write ? raw.slice(1) : raw);
  if (
    rawPaths.length === 0 &&
    rawNewFilePaths.length === 0 &&
    rawWholeFilePaths.length === 0
  ) {
    throw new Error(
      "provide one or more explicit file paths after `npm run format:check:scoped --`",
    );
  }
  const paths = rawPaths.length === 0 ? [] : normalizeScopedPaths(rawPaths);
  const newFilePaths =
    rawNewFilePaths.length === 0 ? [] : normalizeScopedPaths(rawNewFilePaths);
  const wholeFilePaths =
    rawWholeFilePaths.length === 0
      ? []
      : normalizeScopedPaths(rawWholeFilePaths);
  rejectDuplicateClassifications([
    ["range-scoped", paths],
    ["--new-file", newFilePaths],
    ["--whole-file", wholeFilePaths],
  ]);

  const parsed = {
    mode: write ? "write" : "check",
    paths,
  };
  if (newFilePaths.length > 0) parsed.newFilePaths = newFilePaths;
  if (wholeFilePaths.length > 0) parsed.wholeFilePaths = wholeFilePaths;
  return parsed;
}

/** Describe the exact changed range that failed scoped formatting. */
export function formatRangeDiagnostic(
  label,
  repoPath,
  lineRange,
  detail = "need formatting",
) {
  return `${label}: ${repoPath}:${lineRange.startLine}-${lineRange.endLine}: ${detail}`;
}

/** Describe a whole-file formatting failure with the affected path. */
export function formatWholeFileDiagnostic(
  label,
  repoPath,
  detail = "need formatting",
) {
  return `${label}: ${repoPath}: ${detail}`;
}

function main() {
  const {
    mode,
    paths,
    newFilePaths = [],
    wholeFilePaths = [],
  } = parseFormatCliArgs(process.argv.slice(2));
  if (mode === "help") {
    console.log(FORMAT_USAGE);
    return;
  }
  const label =
    mode === "write" ? "format:write:scoped" : "format:check:scoped";
  let checkedRanges = 0;
  let checkedWholeFiles = 0;
  let failedRanges = 0;
  let zeroRangePaths = 0;

  for (const repoPath of paths) {
    const source = readFileSync(resolve(REPO_ROOT, repoPath), "utf8");
    const lineRanges = changedLineRanges(repoPath, source);
    if (lineRanges.length === 0) {
      zeroRangePaths += 1;
      console.log(`${label}: no added lines in ${repoPath}`);
      continue;
    }
    if (!RANGE_CHECK_EXTENSIONS.has(extname(repoPath))) {
      console.log(`${label}: skipped non-code path ${repoPath}`);
      continue;
    }

    const runnableRanges = lineRanges.filter((lineRange) => {
      const range = characterRangeForLines(source, lineRange);
      return range.end > range.start;
    });
    checkedRanges += runnableRanges.length;

    if (mode === "write") {
      try {
        const formatted = applyPrettierRangeWrites(
          source,
          runnableRanges,
          (current, range) =>
            formatRangeWithPrettier(prettierCli(), repoPath, current, range),
          repoPath,
        );
        writeFileSync(resolve(REPO_ROOT, repoPath), formatted, "utf8");
      } catch (error) {
        failedRanges += 1;
        console.error(
          `${label}: ${repoPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      for (const lineRange of runnableRanges) {
        const range = characterRangeForLines(source, lineRange);
        try {
          const formatted = formatRangeWithPrettier(
            prettierCli(),
            repoPath,
            source,
            range,
          );
          if (rangeFormattingDiffers(source, formatted, range)) {
            failedRanges += 1;
            console.error(formatRangeDiagnostic(label, repoPath, lineRange));
          }
        } catch (error) {
          failedRanges += 1;
          const detail =
            error instanceof Error
              ? `check failed: ${error.message}`
              : `check failed: ${String(error)}`;
          console.error(
            formatRangeDiagnostic(label, repoPath, lineRange, detail),
          );
        }
      }
    }
  }

  for (const repoPath of [...wholeFilePaths, ...newFilePaths]) {
    const source = readFileSync(resolve(REPO_ROOT, repoPath), "utf8");
    if (!RANGE_CHECK_EXTENSIONS.has(extname(repoPath))) {
      console.log(`${label}: skipped non-code path ${repoPath}`);
      continue;
    }

    checkedWholeFiles += 1;
    try {
      const formatted = formatWholeFileWithPrettier(
        prettierCli(),
        repoPath,
        source,
      );
      if (mode === "write") {
        writeFileSync(resolve(REPO_ROOT, repoPath), formatted, "utf8");
      } else if (formatted !== source) {
        failedRanges += 1;
        console.error(formatWholeFileDiagnostic(label, repoPath));
      }
    } catch (error) {
      failedRanges += 1;
      console.error(
        formatWholeFileDiagnostic(
          label,
          repoPath,
          error instanceof Error
            ? `check failed: ${error.message}`
            : `check failed: ${String(error)}`,
        ),
      );
    }
  }

  if (
    paths.length > 0 &&
    zeroRangePaths === paths.length &&
    newFilePaths.length === 0 &&
    wholeFilePaths.length === 0
  ) {
    console.warn(
      `${label}: warning: every requested path has no added lines; if these files need a full-file check, rerun with --whole-file <path> (or --new-file <path> for task-created files)`,
    );
  }

  if (failedRanges > 0) {
    console.error(
      `${label}: ${failedRanges}/${checkedRanges + checkedWholeFiles} checked unit(s) ${mode === "write" ? "failed to write" : "need formatting"}`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `${label}: ${checkedRanges} changed range(s), ${checkedWholeFiles} whole file(s) ${mode === "write" ? "written" : "checked"}`,
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(
      `format:check:scoped: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  }
}
