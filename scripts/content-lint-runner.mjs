#!/usr/bin/env node
/**
 * Boundary launcher for content-lint.
 *
 * `tsx scripts/content-lint.mjs` can fail before loading the probe when a
 * sandbox denies tsx's unix-domain IPC socket. That child failure exits 1,
 * which is indistinguishable from a detector flag to callers that only inspect
 * the exit code. Run the loader through Node instead, and require a positive
 * result banner before preserving any non-zero child verdict.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROBE_SCRIPT = resolve(ROOT, "scripts/content-lint.mjs");
export const RESULT_BANNER = "content-lint probe:";

function probeReported(stdout, stderr) {
  const output = `${stdout}\n${stderr}`;
  if (output.includes(RESULT_BANNER)) return true;

  // `--json` intentionally has no human-readable banner. Its result shape is
  // still an explicit positive report, unlike a loader/runtime stack trace.
  try {
    const result = JSON.parse(stdout);
    return (
      result &&
      typeof result === "object" &&
      Array.isArray(result.verdicts) &&
      Number.isInteger(result.ranCount) &&
      Number.isInteger(result.exitCode)
    );
  } catch {
    return false;
  }
}

/**
 * Return the child verdict only when the probe positively reported a result.
 * A non-zero child without the banner did not reach the probe's result path,
 * so it is MISUSE regardless of whether the runtime called it an exit 1.
 */
export function childExitCode({
  status,
  signal = null,
  stdout = "",
  stderr = "",
}) {
  if (status === 0) return 0;
  if (signal) return 2;

  if (!probeReported(stdout, stderr)) return 2;
  return status === 1 || status === 2 ? status : 2;
}

export function runContentLint(argv = process.argv.slice(2)) {
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", PROBE_SCRIPT, ...argv],
    {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
    },
  );

  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  if (child.error) {
    process.stderr.write(
      `content-lint could not start: ${child.error.message}\n`,
    );
  }

  return childExitCode(child);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(runContentLint());
}
