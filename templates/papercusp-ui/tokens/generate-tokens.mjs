#!/usr/bin/env node
// generate-tokens.mjs — DTCG source (tokens.base.json) → generated tokens.css
// implementing the 3-state light/dark/system theme model (D-011, plan
// unified-web-portal-2026-08-29):
//   :root                                     → light (the default)
//   :root[data-theme="dark"]                  → explicit dark
//   @media (prefers-color-scheme: dark)
//     :root:not([data-theme="light"])         → system dark unless overridden
//
// Dependency-free on purpose: apps copy tokens.css verbatim; this script runs
// only when the DTCG source changes.
//
// Usage:
//   node generate-tokens.mjs            # (re)write tokens.css next to the source
//   node generate-tokens.mjs --check    # exit 1 if tokens.css drifts from source
//   node generate-tokens.mjs --out FILE # write to FILE instead
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, "tokens.base.json");
const args = process.argv.slice(2);
const check = args.includes("--check");
const outIdx = args.indexOf("--out");
const outPath = outIdx >= 0 ? args[outIdx + 1] : join(here, "tokens.css");

const source = JSON.parse(readFileSync(sourcePath, "utf8"));

/** Flatten DTCG groups → [{ cssVar, light, dark }] preserving source order. */
function collect(doc) {
  const rows = [];
  for (const [group, tokens] of Object.entries(doc)) {
    if (group.startsWith("$")) continue;
    for (const [key, token] of Object.entries(tokens)) {
      if (key.startsWith("$") || typeof token !== "object") continue;
      const light = token.$value;
      const dark = token.$extensions?.["com.papercusp.modes"]?.dark;
      if (typeof light !== "string" || typeof dark !== "string") {
        throw new Error(`token ${group}.${key}: needs string $value (light) and $extensions["com.papercusp.modes"].dark`);
      }
      const cssVar = group === "color" ? `--${key}` : `--${group}-${key}`;
      rows.push({ cssVar, light, dark });
    }
  }
  if (rows.length === 0) throw new Error("no tokens collected from tokens.base.json");
  return rows;
}

function render(rows) {
  const decls = (mode, indent) => rows.map((r) => `${indent}${r.cssVar}: ${r[mode]};`).join("\n");
  return `/* GENERATED — do not hand-edit. Source: tokens.base.json (DTCG).
 * Regenerate: node generate-tokens.mjs   Verify: node generate-tokens.mjs --check
 * Papercusp app-family semantic theme tokens (D-011). Light/dark/system:
 * explicit choice via data-theme on <html>; no attribute = follow the system.
 * Per-app accents/extras are a thin override layer ON TOP of this file —
 * never edit these values in place. */
:root {
  color-scheme: light;
${decls("light", "  ")}
}
:root[data-theme="dark"] {
  color-scheme: dark;
${decls("dark", "  ")}
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
${decls("dark", "    ")}
  }
}
`;
}

const css = render(collect(source));

if (check) {
  let existing = "";
  try {
    existing = readFileSync(outPath, "utf8");
  } catch {
    console.error(`tokens --check: ${outPath} is missing — run: node generate-tokens.mjs`);
    process.exit(1);
  }
  if (existing !== css) {
    console.error("tokens --check: tokens.css DRIFTS from tokens.base.json — run: node generate-tokens.mjs");
    process.exit(1);
  }
  console.log("tokens --check: tokens.css matches source");
} else {
  writeFileSync(outPath, css);
  console.log(`wrote ${outPath}`);
}
