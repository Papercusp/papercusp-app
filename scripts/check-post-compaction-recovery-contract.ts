#!/usr/bin/env tsx
/** CI guard for D-017/P-019. Scans canonical non-generated prompt/producer
 * sources and rejects the retired unconditional post-compaction orient ritual. */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findUnconditionalPostCompactionRecoveryDirectives } from "../packages/operator-core/lib/instruction-lint";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = [
  "packages/operator-core/lib",
  "apps/operator/prompts",
  "libs/papercusp/packages/harness/blueprints/base/prompts",
] as const;
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".md",
]);
const SKIP_DIRS = new Set([
  "dist",
  "generated",
  "node_modules",
  "public",
  ".materialized",
  "__tests__",
]);

const REQUIRED_PRODUCERS = [
  [
    "packages/operator-core/lib/agent-tools/coordination/compaction-recovery.ts",
    "AUTOMATIC_COMPACTION_RECOVERY_MARKER",
  ],
  [
    "packages/operator-core/lib/carry-doc.ts",
    "MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION",
  ],
  [
    "packages/operator-core/lib/agent-tools/session/request-compaction.ts",
    "MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION",
  ],
  [
    "packages/operator-core/lib/harness/routines/loop-turn-outcome.ts",
    "MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION",
  ],
  [
    "packages/operator-core/lib/system-health/compaction-compliance-watchdog.ts",
    "MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION",
  ],
  [
    "packages/operator-core/lib/enforcement-gate-io.ts",
    "MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION",
  ],
  [
    "packages/operator-core/lib/cold-boot-drill-live.ts",
    "MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION",
  ],
  [
    "packages/operator-core/lib/agent-tools/coordination/tools/orient.ts",
    "MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION",
  ],
  [
    "packages/operator-core/lib/interactive-claude-config.ts",
    "MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION",
  ],
  [
    "apps/operator/prompts/papercusp-compaction.base.md",
    "⟦post-compaction-recovery⟧",
  ],
  [
    "apps/operator/prompts/papercusp-su-power.tools.md",
    "⟦post-compaction-recovery⟧",
  ],
  [
    "apps/operator/prompts/papercusp-su-engineer.tools.md",
    "⟦post-compaction-recovery⟧",
  ],
] as const;

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (path: string) => {
    for (const name of readdirSync(path)) {
      if (SKIP_DIRS.has(name)) continue;
      const child = join(path, name);
      const stat = statSync(child);
      if (stat.isDirectory()) {
        visit(child);
      } else if (
        SOURCE_EXTENSIONS.has(extname(name)) &&
        !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)
      ) {
        out.push(child);
      }
    }
  };
  if (existsSync(root)) visit(root);
  return out;
}

function main() {
  const positiveControl = findUnconditionalPostCompactionRecoveryDirectives(
    "Fresh context. First re-run coord:orient { afterCompaction: true }, then continue.",
  );
  if (positiveControl.length === 0) {
    throw new Error(
      "positive control did not fire — the recurrence guard is inert",
    );
  }
  const negativeControl = findUnconditionalPostCompactionRecoveryDirectives(
    "Call coord:orient { afterCompaction: true } exactly once only when the recovery marker is absent.",
  );
  if (negativeControl.length > 0) {
    throw new Error(
      "negative control fired — the recurrence guard rejects the valid conditional fallback",
    );
  }

  const violations: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(resolve(ROOT, root))) {
      const repoPath = relative(ROOT, file).split("\\").join("/");
      const findings = findUnconditionalPostCompactionRecoveryDirectives(
        readFileSync(file, "utf8"),
      );
      for (const finding of findings) {
        violations.push(
          `${repoPath}:${finding.line} [${finding.pattern}] ${finding.directive}`,
        );
      }
    }
  }
  for (const [repoPath, token] of REQUIRED_PRODUCERS) {
    const absolute = resolve(ROOT, repoPath);
    if (
      !existsSync(absolute) ||
      !readFileSync(absolute, "utf8").includes(token)
    ) {
      violations.push(
        `${repoPath}: missing marker-aware contract token ${token}`,
      );
    }
  }

  if (violations.length > 0) {
    console.error("[post-compaction-recovery-contract] FAILED");
    for (const violation of violations) console.error(`  ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `[post-compaction-recovery-contract] OK — ${REQUIRED_PRODUCERS.length} producers marker-aware; no unconditional recovery-orient mandate found.`,
  );
}

main();
