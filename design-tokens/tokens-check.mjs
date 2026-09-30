#!/usr/bin/env node
// SPDX-License-Identifier: Elastic-2.0
//
// Regenerates design-token CSS outputs and fails if the working tree
// differs. Catches the drift case where someone edits a token source
// file but forgets `npm run tokens` before committing.
//
// Usage: npm run tokens:check  (called from CI / pre-commit / make check)

import { execSync } from "node:child_process";

const OUTPUTS = [
  "apps/operator/app/_brand-primitives.css",
  "apps/operator/app/_semantic.css",
  "apps/operator/app/_semantic.frost.css",
  "apps/operator/app/_semantic.black.css",
  "apps/operator/app/_semantic.honeycomb.css",
  "apps/operator/app/_semantic.portal-light.css",
  "apps/operator/app/_semantic.portal-dark.css",
  "design-tokens/primitives.tokens.json",
];

try {
  execSync("npm run tokens", { stdio: "inherit" });
} catch (e) {
  console.error("✗ tokens regen failed");
  process.exit(e.status || 1);
}

const diff = execSync(`git --no-pager diff --stat -- ${OUTPUTS.join(" ")}`, { encoding: "utf8" });
if (diff.trim()) {
  console.error("\n✗ design-token outputs drifted from sources. Run 'npm run tokens' and commit the diff:\n");
  console.error(diff);
  process.exit(1);
}
console.log("✓ design tokens in sync");
