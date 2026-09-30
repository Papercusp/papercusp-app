#!/usr/bin/env node

/**
 * Build the deterministic identity manifest for the headless P2P witness.
 *
 * The manifest is deliberately independent of wall-clock time.  Its
 * artifactId is the SHA-256 of the canonical inputs (source, dependency,
 * migration, seed, runtime, and optional-pack identities), so rebuilding the
 * same inputs produces byte-identical identity data. Absolute paths are
 * diagnostic metadata and are excluded from the identity payload.
 */

import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { isCliEntry } from "@papercusp/operator-core/lib/util/cli-entry";

const ALGORITHM = "sha256";
const SCHEMA_VERSION = 2;

function sha256Bytes(bytes) {
  return createHash(ALGORITHM).update(bytes).digest("hex");
}

async function sha256File(path) {
  return sha256Bytes(await readFile(path));
}

async function walkFiles(root) {
  const absoluteRoot = resolve(root);
  const info = await stat(absoluteRoot);
  if (info.isFile())
    return [{ absolute: absoluteRoot, relative: basename(absoluteRoot) }];
  if (!info.isDirectory())
    throw new Error(`witness input is not a file or directory: ${root}`);

  const entries = [];
  async function visit(directory, prefix) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const child of children) {
      if (
        child.name === ".git" ||
        child.name === "node_modules" ||
        child.name === "dist"
      )
        continue;
      const absolute = join(directory, child.name);
      const childRelative = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.isDirectory()) await visit(absolute, childRelative);
      else if (child.isFile())
        entries.push({ absolute, relative: childRelative });
    }
  }
  await visit(absoluteRoot, "");
  return entries;
}

async function hashTree(root) {
  const files = await walkFiles(root);
  const rows = [];
  for (const file of files)
    rows.push(`${file.relative}\0${await sha256File(file.absolute)}\n`);
  return {
    path: resolve(root),
    fileCount: files.length,
    sha256: sha256Bytes(rows.join("")),
  };
}

async function hashInputs(paths, repoRoot) {
  const rows = [];
  for (const input of paths.filter(Boolean)) {
    const absolute = resolve(repoRoot, input);
    const inputName = relative(repoRoot, absolute).split(sep).join("/") || ".";
    if (
      inputName === ".." ||
      inputName.startsWith("../") ||
      isAbsolute(inputName)
    ) {
      throw new Error(`witness input must be inside the repository: ${input}`);
    }
    const info = await stat(absolute);
    const value = info.isDirectory()
      ? await hashTree(absolute)
      : { path: absolute, sha256: await sha256File(absolute) };
    rows.push({ input: inputName, ...value });
  }
  return rows;
}

function git(repoRoot, args) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
  }).trim();
}

function canonical(value) {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.keys(item)
        .sort()
        .map((key) => [key, item[key]]),
    );
  });
}

/**
 * Build the deterministic identity manifest for one (superproject, submodule)
 * source pair and materialise it under `outputDir`.
 *
 * Typed here because `scripts/p2p-witness-manifest.d.mts` is GENERATED from this
 * JSDoc: without it the `= null` defaults infer as `null`-only and every string
 * caller (the vitest suite passes a model-pack directory) becomes a TS2322.
 *
 * @param {{
 *   repoRoot: string,
 *   outputDir: string,
 *   sourceSha: string,
 *   submoduleSha: string,
 *   runtimePath?: string,
 *   dependencyInputs?: string[],
 *   migrationInputs?: string[],
 *   seedInputs?: string[],
 *   modelPackPath?: string | null,
 *   capabilityPackPath?: string | null,
 * }} options
 */
export async function buildManifest({
  repoRoot,
  outputDir,
  sourceSha,
  submoduleSha,
  runtimePath = "serve.mjs",
  dependencyInputs = ["package-lock.json"],
  migrationInputs = ["libs/papercusp/libs/db/sql"],
  seedInputs = [
    "libs/papercusp/packages/embedded-postgres-server/bin/build-seed.mjs",
  ],
  modelPackPath = null,
  capabilityPackPath = null,
}) {
  const root = resolve(repoRoot);
  const output = resolve(outputDir);
  const runtime = resolve(output, runtimePath);
  const submoduleRoot = resolve(root, "libs/papercusp");
  const inputs = {
    schemaVersion: SCHEMA_VERSION,
    runtime: {
      entry: "apps/operator/bin/serve.ts",
      bundleSha256: await sha256File(runtime),
    },
    source: {
      superprojectSha: sourceSha ?? git(root, ["rev-parse", "HEAD"]),
      papercuspSha: submoduleSha ?? git(submoduleRoot, ["rev-parse", "HEAD"]),
    },
    dependencies: await hashInputs(dependencyInputs, root),
    migrations: await hashInputs(migrationInputs, root),
    seeds: await hashInputs(seedInputs, root),
    optionalPacks: {
      model: modelPackPath ? await hashTree(resolve(modelPackPath)) : null,
      capability: capabilityPackPath
        ? await hashTree(resolve(capabilityPackPath))
        : null,
    },
  };
  // Keep paths for inspection, but hash only portable input names and bytes.
  // Optional packs may live outside the checkout; their root names are also
  // locations, while the names of files within each pack remain in its digest.
  const contentIdentity = ({ path: _path, ...identity }) => identity;
  const artifactId = sha256Bytes(
    canonical({
      ...inputs,
      dependencies: inputs.dependencies.map(contentIdentity),
      migrations: inputs.migrations.map(contentIdentity),
      seeds: inputs.seeds.map(contentIdentity),
      optionalPacks: {
        model: inputs.optionalPacks.model
          ? contentIdentity(inputs.optionalPacks.model)
          : null,
        capability: inputs.optionalPacks.capability
          ? contentIdentity(inputs.optionalPacks.capability)
          : null,
      },
    }),
  );
  return { schemaVersion: SCHEMA_VERSION, artifactId, inputs };
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const repoRoot = argValue(args, "--repo-root") ?? process.cwd();
  const outputDir = argValue(args, "--output-dir");
  if (!outputDir) throw new Error("--output-dir is required");
  const manifest = await buildManifest({
    repoRoot,
    outputDir,
    sourceSha: argValue(args, "--source-sha"),
    submoduleSha: argValue(args, "--submodule-sha"),
    modelPackPath: argValue(args, "--model-pack"),
    capabilityPackPath: argValue(args, "--capability-pack"),
  });
  const destination = join(resolve(outputDir), "witness-manifest.json");
  await writeFile(
    destination,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({ ok: true, artifactId: manifest.artifactId, manifest: destination })}\n`,
  );
}

if (isCliEntry(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `p2p witness manifest failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
