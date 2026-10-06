/**
 * gate-test-reuse-yield-2026-10-01 P-007 / D-010: judge a change to the GENERATED DB schema per
 * exported table instead of per file.
 *
 * Every test that imports `@papercusp/db` executes libs/papercusp/libs/db/src/schema/generated.ts
 * and generated-relations.ts, because connection.ts spreads both namespaces into the schema it
 * hands to drizzle({ schema }). Those two files are regenerated on every migration (47 commits in
 * the 7 days before 2026-10-01), and each regeneration voided about half of all gate proofs, nearly
 * all of which never use the tables that changed (measured: 79.6% of proof x commit pairs are
 * unaffected under the rule below).
 *
 * The rule. Split both files into top-level `export const NAME` blocks. S = the blocks added,
 * removed or changed between the proof's sha and the judged sha, plus the owner table of any
 * changed relations block, closed transitively over the relations graph (a table whose relations
 * name a member of S joins S, which covers nested `with` queries). A proof is unaffected when
 *   - the generated.ts header (imports, pgSchema declarations) is unchanged,
 *   - drizzle's eager relational-config construction succeeds on the judged files (the one path by
 *     which a change to an unnamed table could break every drizzle-constructing test), and
 *   - no executed module other than the schema plumbing names a member of S as an identifier
 *     token, or binds a generated namespace and reads it dynamically.
 * Any read, git or smoke failure answers "affected", which keeps the whole-file rule.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/** The two generated schema files, repo-relative. */
export const GENERATED_SCHEMA_FILES = Object.freeze([
  "libs/papercusp/libs/db/src/schema/generated.ts",
  "libs/papercusp/libs/db/src/schema/generated-relations.ts",
]);
const [GEN, REL] = GENERATED_SCHEMA_FILES;

/**
 * Modules that pass the generated namespaces through whole without naming a table: the two
 * generated files, the schema barrel that re-exports them and connection.ts, which spreads them
 * into drizzle's schema. Their own text is not evidence of use. A change to any of them other
 * than the generated files is ordinary drift and still invalidates.
 */
export const SCHEMA_PLUMBING_MODULES = Object.freeze(
  new Set([
    GEN,
    REL,
    "libs/papercusp/libs/db/src/schema/index.ts",
    "libs/papercusp/libs/db/src/connection.ts",
  ]),
);

const EXPORT_RE = /^export const ([A-Za-z_$][\w$]*)\s*=/;

/**
 * Split a generated schema file into its header (everything before the first top-level
 * `export const`) and one block per exported name.
 *
 * @param {string} src
 * @returns {{ header: string, blocks: Map<string, string> }}
 */
export function exportBlocks(src) {
  const blocks = new Map();
  let header = "";
  /** @type {string | null} */
  let current = null;
  /** @type {string[]} */
  let buf = [];
  // Trailing whitespace is trimmed: appending a block after the last one moves the blank line
  // that used to end the file, which is not a change to the previous block.
  const flush = () => {
    if (current === null) header = buf.join("\n").trimEnd();
    else blocks.set(current, buf.join("\n").trimEnd());
  };
  for (const line of src.split("\n")) {
    const m = EXPORT_RE.exec(line);
    if (m) {
      flush();
      current = m[1];
      buf = [line];
    } else buf.push(line);
  }
  flush();
  return { header, blocks };
}

const TOKEN_RE = /[A-Za-z_$][\w$]*/g;

/** A column-0 declaration that is not the block's own `export const` line. */
const FOREIGN_TOP_LEVEL_RE =
  /^(?:const|let|var|function|async\s+function|class|import|type|interface|enum|declare|namespace|export\s+(?!const\b))\b/m;

/** @param {string | undefined} block */
function hasForeignTopLevelStatement(block) {
  if (block === undefined) return false;
  const nl = block.indexOf("\n");
  return nl >= 0 && FOREIGN_TOP_LEVEL_RE.test(block.slice(nl + 1));
}

/**
 * The schema symbols a change affects, or null when the change must be judged as a whole file
 * (the generated.ts header changed, or an input is missing). The relations-file header is the
 * import list, derived from the table set, so it is not compared.
 *
 * @param {{ beforeGen: string, beforeRel: string, afterGen: string, afterRel: string }} o
 * @returns {Set<string> | null}
 */
export function changedSchemaSymbols({ beforeGen, beforeRel, afterGen, afterRel }) {
  for (const s of [beforeGen, beforeRel, afterGen, afterRel]) if (typeof s !== "string" || s === "") return null;
  const gA = exportBlocks(beforeGen);
  const gB = exportBlocks(afterGen);
  if (gA.header !== gB.header) return null;
  const rA = exportBlocks(beforeRel);
  const rB = exportBlocks(afterRel);
  /** @type {Set<string>} */
  const S = new Set();
  for (const [a, b] of [
    [gA.blocks, gB.blocks],
    [rA.blocks, rB.blocks],
  ]) {
      for (const name of new Set([...a.keys(), ...b.keys()])) {
      const before = a.get(name);
      const after = b.get(name);
      if (before === after) continue;
      // A changed block that also carries a top-level statement other than its own export (a
      // helper declared between two exports) can change every block that uses the helper:
      // judge the file whole.
      if (hasForeignTopLevelStatement(before) || hasForeignTopLevelStatement(after)) return null;
      S.add(name);
    }
  }
  // A changed relations block changes what queries on its owner table can traverse.
  for (const name of [...S]) if (name.endsWith("Relations")) S.add(name.slice(0, -"Relations".length));
  // Closure over BOTH files, before and after (a removed edge matters as much as an added one):
  // a table whose definition names an affected block (harnessShared.table, a foreign key's
  // .references(() => other.id)) and a relations block that names an affected table are affected.
  /** @type {Map<string, Set<string>>} */
  const edges = new Map();
  for (const file of [gA, gB, rA, rB]) {
    for (const [name, text] of file.blocks) {
      const toks = edges.get(name) ?? new Set();
      for (const t of text.match(TOKEN_RE) ?? []) if (t !== name) toks.add(t);
      edges.set(name, toks);
    }
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, toks] of edges) {
      if (S.has(name)) continue;
      for (const t of toks) {
        if (S.has(t)) {
          S.add(name);
          if (name.endsWith("Relations")) S.add(name.slice(0, -"Relations".length));
          grew = true;
          break;
        }
      }
    }
  }
  return S;
}

const IMPORT_NAMED_RE =
  /import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"](@papercusp\/db[^'"]*|[^'"]*\/schema(?:\/index)?(?:\.js|\.ts)?)['"]/g;
const IMPORT_NS_RE =
  /import\s+\*\s+as\s+([\w$]+)\s+from\s*['"]([^'"]*schema\/generated(?:-relations)?(?:\.js|\.ts)?|@papercusp\/db[^'"]*|[^'"]*\/schema(?:\/index)?(?:\.js|\.ts)?)['"]/g;
/** Dynamic access on a drizzle instance: db.query[x], db._.schema / fullSchema / tableNamesMap, Object.keys(db.query). */
const DRIZZLE_DYNAMIC_RE =
  /\.query\s*\[|\._\.(?:fullSchema|schema|tableNamesMap)\b|Object\.(?:keys|values|entries)\(\s*[\w$.]*\.query\s*\)/;

/**
 * How one module's source can reach generated schema symbols. `tokens` is every identifier-shaped
 * token in the raw text, comments and string literals included (an over-approximation of use,
 * which is the safe direction). `dynamic` is true when the module binds a generated namespace
 * (under any alias) and reads it by computed key, enumerates or spreads it, or reads a drizzle
 * instance's schema dynamically: such a module may touch any table.
 *
 * @param {string} src
 * @returns {{ tokens: Set<string>, dynamic: boolean }}
 */
export function moduleSchemaUse(src) {
  const tokens = new Set(src.match(TOKEN_RE) ?? []);
  /** @type {Set<string>} */
  const binds = new Set();
  for (const m of src.matchAll(IMPORT_NAMED_RE)) {
    for (const part of m[1].split(",")) {
      const mm = /^\s*(?:type\s+)?(generated|generatedRelations)(?:\s+as\s+([\w$]+))?\s*$/.exec(part);
      if (mm) binds.add(mm[2] ?? mm[1]);
    }
  }
  for (const m of src.matchAll(IMPORT_NS_RE)) binds.add(m[1]);
  let dynamic = DRIZZLE_DYNAMIC_RE.test(src);
  for (const b of binds) {
    if (dynamic) break;
    const e = b.replace(/\$/g, "\\$");
    dynamic = new RegExp(
      `\\b${e}\\s*\\[|Object\\.(?:keys|values|entries|assign|getOwnPropertyNames)\\(\\s*${e}\\b|\\.\\.\\.${e}\\b|\\b(?:in|of)\\s+${e}\\b|\\b${e}\\.(?:generated|generatedRelations)\\s*\\[`,
    ).test(src);
  }
  return { tokens, dynamic };
}

/**
 * Build the per-proof judge selectReusablePasses consults when a proof's drift includes a
 * generated schema file. Every dependency is injected so the rule is testable without git.
 *
 * @param {object} o
 * @param {(sha: string, rel: string) => string} o.readAtSha   file text at a commit; throws when absent
 * @param {(rel: string) => string} o.readJudged   file text in the judged (clean) checkout
 * @param {() => boolean} o.constructionSmoke   true when drizzle's eager relational config builds
 *        on the judged generated files
 * @param {string} o.judgedSha
 * @returns {(proof: { recordedSha: string, executedModules: string[] }) => boolean}
 *        true = the generated-schema drift does not reach this proof
 */
export function createSchemaDriftJudge({ readAtSha, readJudged, constructionSmoke, judgedSha }) {
  /** @type {Map<string, Set<string> | null>} */
  const symbolCache = new Map();
  /** @type {Map<string, { tokens: Set<string>, dynamic: boolean } | null>} */
  const useCache = new Map();
  /** @type {boolean | null} */
  let smoke = null;
  const symbolsFor = (sha) => {
    if (!symbolCache.has(sha)) {
      let S = null;
      try {
        S = changedSchemaSymbols({
          beforeGen: readAtSha(sha, GEN),
          beforeRel: readAtSha(sha, REL),
          afterGen: readJudged(GEN),
          afterRel: readJudged(REL),
        });
      } catch {
        S = null;
      }
      symbolCache.set(sha, S);
    }
    return symbolCache.get(sha);
  };
  const useOf = (rel) => {
    if (!useCache.has(rel)) {
      let use = null;
      try {
        use = moduleSchemaUse(readJudged(rel));
      } catch {
        use = null;
      }
      useCache.set(rel, use);
    }
    return useCache.get(rel);
  };
  const smokeOk = () => {
    if (smoke === null) {
      try {
        smoke = constructionSmoke() === true;
      } catch {
        smoke = false;
      }
    }
    return smoke;
  };
  return (proof) => {
    if (!proof || proof.recordedSha === judgedSha || !Array.isArray(proof.executedModules)) return false;
    const S = symbolsFor(proof.recordedSha);
    if (S === null) return false;
    if (!smokeOk()) return false;
    for (const mod of proof.executedModules) {
      if (SCHEMA_PLUMBING_MODULES.has(mod)) continue;
      const use = useOf(mod);
      if (use === null || use.dynamic) return false;
      for (const s of S) if (use.tokens.has(s)) return false;
    }
    return true;
  };
}

/**
 * Read `rel` at `sha` in `repoDir`, following gitlinks: a path inside a submodule is read at the
 * commit the tree pins, recursively. Throws when the path is absent.
 *
 * @param {(file: string, args: string[], opts: object) => string | Buffer} exec
 * @param {string} repoDir
 * @param {string} sha
 * @param {string} rel
 * @returns {string}
 */
export function gitReadAtSha(exec, repoDir, sha, rel) {
  const opts = {
    cwd: repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
    killSignal: "SIGKILL",
  };
  const parts = rel.split("/");
  for (let i = 1; i < parts.length; i += 1) {
    const prefix = parts.slice(0, i).join("/");
    const entry = String(exec("git", ["ls-tree", sha, "--", prefix], opts)).trim();
    if (entry === "") throw new Error(`${prefix} absent at ${sha}`);
    const m = /^160000 commit ([0-9a-f]+)\t/.exec(entry);
    if (m) return gitReadAtSha(exec, path.join(repoDir, prefix), m[1], parts.slice(i).join("/"));
    if (!/^040000 tree /.test(entry)) throw new Error(`${prefix} is not a directory at ${sha}`);
  }
  return String(exec("git", ["show", `${sha}:${rel}`], opts));
}

/**
 * The construction smoke: load the judged generated files with tsx and run drizzle's
 * extractTablesRelationalConfig, the eager step drizzle({ schema }) performs. True only when the
 * child prints its marker.
 *
 * @param {{ repoRoot: string, exec?: (file: string, args: string[], opts: object) => string | Buffer, timeoutMs?: number }} o
 * @returns {boolean}
 */
export function drizzleConstructionSmoke({ repoRoot, exec = execFileSync, timeoutMs = 120_000 }) {
  const script =
    "import * as g from './src/schema/generated.ts';" +
    "import * as r from './src/schema/generated-relations.ts';" +
    "import { extractTablesRelationalConfig, createTableRelationsHelpers } from 'drizzle-orm';" +
    "const c = extractTablesRelationalConfig({ ...g, ...r }, createTableRelationsHelpers);" +
    "console.log('SCHEMA_CONSTRUCTION_SMOKE_OK tables=' + Object.keys(c.tables).length);";
  const out = String(
    exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: path.join(repoRoot, "libs/papercusp/libs/db"),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
    }),
  );
  return /SCHEMA_CONSTRUCTION_SMOKE_OK tables=[1-9]\d*/.test(out);
}

/**
 * The git-backed judge affected-tests.mjs uses. The judged tree is read from the working tree,
 * which is sound because reuse is switched off on any dirty checkout (submodules included).
 *
 * @param {{ repoRoot: string, judgedSha: string, exec?: (file: string, args: string[], opts: object) => string | Buffer }} o
 */
export function gitSchemaDriftJudge({ repoRoot, judgedSha, exec = execFileSync }) {
  return createSchemaDriftJudge({
    judgedSha,
    readAtSha: (sha, rel) => gitReadAtSha(exec, repoRoot, sha, rel),
    readJudged: (rel) => readFileSync(path.join(repoRoot, rel), "utf8"),
    constructionSmoke: () => drizzleConstructionSmoke({ repoRoot, exec }),
  });
}
