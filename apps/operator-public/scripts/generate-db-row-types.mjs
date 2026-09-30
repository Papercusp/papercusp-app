#!/usr/bin/env node

/**
 * Generate TypeScript row shapes from the final D1 schema.
 *
 * The migrations are the canonical schema source.  Applying them to an
 * in-memory SQLite database before introspecting the resulting tables means a
 * new column cannot silently drift past the public worker's row types.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(here);
const migrationsDir = join(appRoot, "migrations");
const outputPath = join(appRoot, "src", "db-row-types.generated.ts");
const checkOnly = process.argv.includes("--check");

function migrationFiles() {
  const files = readdirSync(migrationsDir)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort((a, b) => a.localeCompare(b, "en"));
  const bySequence = new Map();
  for (const file of files) {
    const prefix = file.match(/^(\d+)_/)?.[1];
    const sequence = Number(prefix);
    const previous = bySequence.get(sequence);
    if (previous) {
      throw new Error(
        `Duplicate migration sequence ${prefix}: ${previous} and ${file}. ` +
          "Migration filename prefixes must be unique so production apply order is unambiguous.",
      );
    }
    bySequence.set(sequence, file);
  }
  return files;
}

function loadSchema() {
  const files = migrationFiles();
  const db = new DatabaseSync(":memory:");
  try {
    for (const file of files)
      db.exec(readFileSync(join(migrationsDir, file), "utf8"));
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name));
    return {
      files,
      tables: tables.map((table) => ({
        table,
        columns: db
          .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
          .all()
          .map((column) => ({
            name: String(column.name),
            type: String(column.type ?? ""),
            required: Number(column.notnull) === 1 || Number(column.pk) > 0,
          })),
      })),
    };
  } finally {
    db.close();
  }
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function pascalCase(value) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

function tsType(sqlType, nullable) {
  const affinity = sqlType.toUpperCase();
  let type = affinity.includes("INT")
    ? "number"
    : affinity.includes("CHAR") ||
        affinity.includes("CLOB") ||
        affinity.includes("TEXT")
      ? "string"
      : affinity.includes("REAL") ||
          affinity.includes("FLOA") ||
          affinity.includes("DOUB")
        ? "number"
        : affinity.includes("BLOB")
          ? "Uint8Array"
          : affinity.includes("NUM") ||
              affinity.includes("DEC") ||
              affinity.includes("BOOL")
            ? "number"
            : "unknown";
  if (nullable) type += " | null";
  return type;
}

function render(schema) {
  const migrationDigest = createHash("sha256")
    .update(
      schema.files
        .map((file) => readFileSync(join(migrationsDir, file)))
        .join(""),
    )
    .digest("hex");
  const lines = [
    "/**",
    " * GENERATED FILE — do not edit by hand.",
    " *",
    " * Source: apps/operator-public/migrations/*.sql applied in filename order",
    ` * Migration digest: ${migrationDigest}`,
    " * Regenerate with: npm run db:types:generate --workspace @papercusp/cupboard-worker",
    " */",
    "",
    "export const GENERATED_MIGRATION_DIGEST =",
    `  "${migrationDigest}";`,
    "export const GENERATED_TABLES = [",
    ...schema.tables.map(({ table }) => `  "${table}",`),
    "] as const;",
    "",
  ];
  for (const { table, columns } of schema.tables) {
    lines.push(`export interface ${pascalCase(table)}Row {`);
    for (const column of columns) {
      const property = /^[A-Za-z_$][\w$]*$/.test(column.name)
        ? column.name
        : JSON.stringify(column.name);
      lines.push(`  ${property}: ${tsType(column.type, !column.required)};`);
    }
    lines.push("}", "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

const generated = render(loadSchema());
if (checkOnly) {
  let existing;
  try {
    existing = readFileSync(outputPath, "utf8");
  } catch (error) {
    console.error(`Generated row types are missing: ${outputPath}`);
    process.exitCode = 1;
  }
  if (existing !== generated) {
    console.error(`Generated row types are stale: ${outputPath}`);
    process.exitCode = 1;
  }
  if (!process.exitCode)
    console.log(`Generated row types are current (${generated.length} bytes).`);
} else {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outputPath, generated);
  console.log(`Wrote ${outputPath} (${generated.length} bytes).`);
}
