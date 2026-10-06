#!/usr/bin/env node
// Producer for the affected-test selector's graph dependency snapshot
// (plan gitnexus-selective-hardening-and-comparison-2026-09-13, P-008).
//
// This is the ONLY place that talks to the code-graph backend. It runs out-of-band (a person or
// a routine) and writes `.papercusp/graph-snapshot/dependency-snapshot.json`; the selector
// (`scripts/affected-tests.mjs`) only ever READS that file. An ordinary gate run therefore
// never starts or queries a graph server (see scripts/lib/graph-dependency-suggestions.mjs).
//
// FAIL CLOSED. The backend has been observed answering the same read-only query with full
// rows, `[]`, and `Binder exception: Table CodeRelation does not exist` against ONE index
// (EI-24827431110263906), so no single answer is trusted. A snapshot is written only when:
//   * the edge COUNT read before paging, the rows actually paged, and the edge COUNT read after
//     paging all agree, and
//   * the index identity (lastCommit) is the same before and after, and
//   * at least one edge survives source corroboration.
// Anything else exits 3 and leaves the previous snapshot untouched — an empty or partial
// snapshot must never overwrite a good one (a stale/absent snapshot only costs selection
// precision, never correctness: the selector treats it as "adds nothing").
//
// Usage:
//   node scripts/gen-graph-dependency-snapshot.mjs [--out <path>] [--repo <name>] [--client <id>]
//        [--page-size <n>] [--retries <n>] [--source-root <dir>]
//        [--edges-file <json> --index-commit <sha>]     (offline: edges as [{importer,imported}])
//
// Exit: 0 written · 2 usage · 3 graph unavailable/inconsistent (nothing written) · 4 write failure.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isCliEntry } from "@papercusp/operator-core/lib/util/cli-entry";
import {
  buildMcpCallParams,
  buildMcpSessionQuery,
  buildUnreachableDiagnostic,
  fetchWithConnectionRecovery,
  isRecoverableAuthorityDenial,
  MCP_CALL_CONNECTION_RETRY_WINDOW_MS,
  parseSse,
  resolveCandidatePorts,
  resolveMcpCallOrigin,
  resolveMcpClientId,
  resolveMcpRole,
  resolveMcpWorkspace,
  toolResultNotOkReason,
} from "./mcp-call.mjs";
import { buildSnapshot, sharedSnapshotPath } from "./lib/graph-dependency-suggestions.mjs";

/** DIRECT-mode page: no response budget applies, ~12 pages for 59k edges (each query ~5s to open). */
export const DIRECT_PAGE_SIZE = 5000;
export const DIRECT_QUERY_TIMEOUT_MS = 120_000;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
export const DEFAULT_SNAPSHOT_REL = ".papercusp/graph-snapshot/dependency-snapshot.json";
// Measured 2026-10-02: ~100-char rows against a 6000-char result-door budget fit ~55 rows a page,
// and 57k edges therefore need ~1.1k pages. Start at the largest page that has been seen to fit
// and let the oversize halving in produceSnapshotFromGraph find the real ceiling.
export const DEFAULT_PAGE_SIZE = 50;
const MIN_PAGE_SIZE = 4;
const DEFAULT_RETRIES = 3;
const MAX_PAGES = 20000;
const EDGE_MATCH = "MATCH (a:File)-[r:CodeRelation]->(b:File) WHERE r.type = 'IMPORTS'";

/** Typed failure so the CLI (and tests) can tell WHY a read was refused. */
export class GraphReadError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "GraphReadError";
    this.code = code;
  }
}

/** Split one markdown table row on UNESCAPED pipes. */
function splitRow(line) {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/**
 * Parse the text a `gitnexus.cypher` call returns: a JSON body (`{markdown,row_count}`, `[]`, or
 * `{error}`), optionally followed by a `\n\n---\n**Next:**…` footer.
 * @returns {{ kind: "rows", rows: Record<string,string>[] } | { kind: "empty" } | { kind: "error", message: string }}
 */
export function parseCypherText(text) {
  // OVERSIZE is its own answer kind, not a generic error: the page was too big for a response
  // budget, so the retry that helps is a SMALLER page, never the same statement again. Two
  // budgets can cut a page (both measured, 2026-10-02): the gitnexus bridge caps a response at
  // 20000 chars and appends a `⚠ TRUNCATED at` marker after the cut (leaving unterminated JSON),
  // and the MCP result door (1500 tokens) replaces anything larger with a `{text,_projection}`
  // spill envelope. Either one carries no complete page — never read partial rows out of it.
  if (String(text).includes("⚠ TRUNCATED at")) {
    return { kind: "oversize", message: "response truncated by the gitnexus bridge budget" };
  }
  const body = String(text).split("\n\n---\n")[0].trim();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "error", message: `unparseable cypher answer: ${body.slice(0, 120)}` };
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.text === "string" && parsed._projection) {
    return { kind: "oversize", message: "response spilled by the MCP result door" };
  }
  if (Array.isArray(parsed)) {
    return parsed.length === 0
      ? { kind: "empty" }
      : { kind: "error", message: "unexpected non-empty array answer" };
  }
  if (parsed && typeof parsed.error === "string") return { kind: "error", message: parsed.error };
  if (!parsed || typeof parsed.markdown !== "string") {
    return { kind: "error", message: `answer has neither markdown nor error: ${body.slice(0, 160).replace(/\s+/g, " ")}` };
  }
  const lines = parsed.markdown.split("\n").filter((l) => l.trim().startsWith("|"));
  if (lines.length < 2) return { kind: "empty" };
  const header = splitRow(lines[0]);
  const rows = [];
  for (const line of lines.slice(2)) {
    const cells = splitRow(line);
    if (cells.length !== header.length) {
      return { kind: "error", message: `row has ${cells.length} cells, header has ${header.length}` };
    }
    rows.push(Object.fromEntries(header.map((h, i) => [h, cells[i]])));
  }
  return rows.length === 0 ? { kind: "empty" } : { kind: "rows", rows };
}

/**
 * Orchestrate one consistent read. All I/O is injected so the fail-closed behavior is testable
 * against a scripted backend without ever starting one.
 * @param {{
 *   runCypher: (statement: string) => Promise<string>,
 *   fetchIndex: () => Promise<{ lastCommit: string, indexedAt?: string | null, backend?: string | null, backendVersion?: string | null }>,
 *   readSource: (rel: string) => string | null,
 *   now: number,
 *   pageSize?: number,
 *   retries?: number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} deps
 */
export async function produceSnapshotFromGraph({
  runCypher,
  fetchIndex,
  readSource,
  now,
  pageSize = DEFAULT_PAGE_SIZE,
  retries = DEFAULT_RETRIES,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onProgress = null,
}) {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new GraphReadError("usage", "pageSize must be a positive integer");

  /** Run a statement, retrying transient backend flaps; never swallows a persistent failure. */
  async function ask(statement, { emptyOk }) {
    let last = "no attempt";
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await sleep(1000 * attempt);
      let parsed;
      try {
        parsed = parseCypherText(await runCypher(statement));
      } catch (e) {
        last = `transport: ${e instanceof Error ? e.message : String(e)}`;
        continue;
      }
      if (parsed.kind === "rows") return parsed.rows;
      if (parsed.kind === "empty" && emptyOk) return [];
      // Re-asking an oversize page cannot help; surface it so the caller can shrink the page.
      if (parsed.kind === "oversize") throw new GraphReadError("oversize", parsed.message);
      last = parsed.kind === "error" ? parsed.message : "empty answer";
    }
    throw new GraphReadError("backend-unavailable", `cypher refused after ${retries + 1} attempts: ${last}`);
  }

  const countEdges = async () => {
    const rows = await ask(`${EDGE_MATCH} RETURN count(*) AS n`, { emptyOk: false });
    const n = Number(rows[0]?.n);
    if (!Number.isSafeInteger(n) || n < 0) throw new GraphReadError("backend-unavailable", `unreadable edge count: ${rows[0]?.n}`);
    return n;
  };

  const indexBefore = await fetchIndex();
  const expected = await countEdges();
  if (expected === 0) throw new GraphReadError("empty", "graph reports zero IMPORTS edges — refusing to write an empty snapshot");

  const edges = [];
  let pages = 0;
  // The page size SHRINKS (never grows) when a page is refused as oversize: the response budgets
  // are measured in characters, so the right size depends on path lengths and cannot be known up
  // front. Starting high and halving converges in a handful of extra calls.
  let size = pageSize;
  while (edges.length < expected) {
    if (pages >= MAX_PAGES) throw new GraphReadError("inconsistent-count", `page cap ${MAX_PAGES} hit with ${edges.length}/${expected} rows`);
    // SKIP advances by rows ACTUALLY returned, so a backend that caps a page below `size`
    // cannot make the walk skip or repeat rows; ORDER BY keeps the walk deterministic.
    let rows;
    try {
      rows = await ask(
        `${EDGE_MATCH} RETURN a.filePath AS importer, b.filePath AS imported ORDER BY importer, imported SKIP ${edges.length} LIMIT ${size}`,
        { emptyOk: true },
      );
    } catch (e) {
      if (e instanceof GraphReadError && e.code === "oversize") {
        if (size <= MIN_PAGE_SIZE) throw new GraphReadError("oversize", `a page of ${size} rows is still over the response budget: ${e.message}`);
        size = Math.max(MIN_PAGE_SIZE, Math.floor(size / 2));
        continue;
      }
      throw e;
    }
    pages += 1;
    if (rows.length === 0) {
      throw new GraphReadError("inconsistent-count", `page ${pages} was empty at ${edges.length}/${expected} rows`);
    }
    for (const r of rows) edges.push({ importer: r.importer, imported: r.imported });
    if (onProgress) onProgress({ pages, rows: edges.length, expected, pageSize: size });
  }
  if (edges.length !== expected) {
    throw new GraphReadError("inconsistent-count", `paged ${edges.length} rows but the pre-count said ${expected}`);
  }

  const after = await countEdges();
  if (after !== expected) throw new GraphReadError("inconsistent-count", `edge count moved during the read: ${expected} -> ${after}`);
  const indexAfter = await fetchIndex();
  if (indexAfter.lastCommit !== indexBefore.lastCommit) {
    throw new GraphReadError("index-moved", `index lastCommit changed during the read: ${indexBefore.lastCommit} -> ${indexAfter.lastCommit}`);
  }

  const built = buildSnapshot({ edges, index: indexBefore, readSource, now });
  if (built.stats.kept === 0) throw new GraphReadError("empty", "no edge survived source corroboration — refusing to write an empty snapshot");
  return { ...built, rows: edges.length, pages };
}

/** Offline producer: edges handed in directly (hermetic tests, or a cached edge dump). */
export function produceSnapshotFromEdges({ edges, index, readSource, now }) {
  if (!index || typeof index.lastCommit !== "string" || index.lastCommit.length === 0) {
    throw new GraphReadError("usage", "an index identity (lastCommit) is required");
  }
  const built = buildSnapshot({ edges, index, readSource, now });
  if (built.stats.kept === 0) throw new GraphReadError("empty", "no edge survived source corroboration — refusing to write an empty snapshot");
  return { ...built, rows: edges.length, pages: 0 };
}

/** Write atomically (tmp in the same dir + rename) so a reader never sees a half-written file. */
export function writeSnapshotAtomic(outPath, snapshot) {
  const text = `${JSON.stringify(snapshot)}\n`;
  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, outPath);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return Buffer.byteLength(text);
}

export function parseArgs(argv) {
  const opts = {
    out: null,
    repo: "papercusp",
    client: process.env.PAPERCUSP_SID || null,
    pageSize: DEFAULT_PAGE_SIZE,
    pageSizeExplicit: false,
    retries: DEFAULT_RETRIES,
    sourceRoot: ROOT,
    edgesFile: null,
    indexCommit: null,
    gitnexusBin: null,
    registry: null,
  };
  const takes = new Set([
    "--out",
    "--repo",
    "--client",
    "--page-size",
    "--retries",
    "--source-root",
    "--edges-file",
    "--index-commit",
    "--gitnexus-bin",
    "--registry",
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const flag = eq === -1 ? a : a.slice(0, eq);
    if (!takes.has(flag)) return { error: `unknown argument: ${a}` };
    const value = eq === -1 ? argv[(i += 1)] : a.slice(eq + 1);
    if (value === undefined || value === "") return { error: `${flag} needs a value` };
    if (flag === "--out") opts.out = value;
    else if (flag === "--repo") opts.repo = value;
    else if (flag === "--client") opts.client = value;
    else if (flag === "--source-root") opts.sourceRoot = value;
    else if (flag === "--edges-file") opts.edgesFile = value;
    else if (flag === "--index-commit") opts.indexCommit = value;
    else if (flag === "--gitnexus-bin") opts.gitnexusBin = value;
    else if (flag === "--registry") opts.registry = value;
    else {
      const n = Number(value);
      if (!Number.isInteger(n) || n < (flag === "--retries" ? 0 : 1)) return { error: `${flag} must be an integer` };
      if (flag === "--page-size") {
        opts.pageSize = n;
        opts.pageSizeExplicit = true;
      } else opts.retries = n;
    }
  }
  if (opts.edgesFile && !opts.indexCommit) return { error: "--edges-file requires --index-commit" };
  if (opts.edgesFile && opts.gitnexusBin) return { error: "--edges-file and --gitnexus-bin are exclusive" };
  // Direct mode has no response budget to fit under, so it pages in large steps.
  if (opts.gitnexusBin && !opts.pageSizeExplicit) opts.pageSize = DIRECT_PAGE_SIZE;
  return { opts };
}

/**
 * DIRECT mode (gitnexus-deterministic-integration P-001): run `gitnexus cypher` as a child of
 * THIS process instead of one `mcp-call.mjs` spawn + MCP round-trip per page. The MCP path was
 * measured at ~29 min / 2,274 pages for 57k edges (pages capped by the 20,000-char bridge budget
 * and the ~6,000-char result door); the CLI prints the same `{markdown,row_count}` body with
 * neither budget, so `parseCypherText` reads it unchanged. `--repo` is always named: the CLI
 * resolves its target from the GLOBAL registry and refuses when two repos are registered.
 * @param {{ bin: string, repo: string, cwd: string, runToFile?: (bin: string, argv: string[], opts: { cwd: string, timeoutMs: number }) => Promise<string>, timeoutMs?: number }} o
 * @returns {(statement: string) => Promise<string>}
 */
export function directCypherRunner({ bin, repo, cwd, runToFile = runCliToFile, timeoutMs = DIRECT_QUERY_TIMEOUT_MS }) {
  return async (statement) => runToFile(bin, ["cypher", "--repo", repo, statement], { cwd, timeoutMs });
}

/**
 * Run a CLI with stdout bound to a FILE, then read it. ⚠ Never a pipe: `gitnexus cypher` exits
 * before a pipe drains, so a piped answer is cut at exactly 65,536 bytes (measured 2026-10-06: a
 * 5,000-row page is 533,892 bytes to a file, 65,536 through `| wc -c`) — a truncated JSON body
 * that reads as "unparseable". File writes are synchronous, so the file holds the whole answer.
 */
export async function runCliToFile(bin, argv, { cwd, timeoutMs }) {
  const dir = mkdtempSync(join(tmpdir(), "gnx-cypher-"));
  const file = join(dir, "stdout.json");
  const fd = openSync(file, "w");
  try {
    const outcome = await new Promise((resolveRun, rejectRun) => {
      const child = spawn(bin, argv, { cwd, stdio: ["ignore", fd, "ignore"] });
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        rejectRun(e);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolveRun({ code, signal });
      });
    });
    if (outcome.code !== 0) {
      throw new Error(`${bin} ${argv[0]} exited ${outcome.code ?? `signal ${outcome.signal}`}`);
    }
    return readFileSync(file, "utf8");
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Index identity for DIRECT mode, read from the gitnexus registry file the CLI itself resolves
 * against (`~/.gitnexus/registry.json`, an array of `{name,lastCommit,indexedAt}`). Read before
 * AND after paging by produceSnapshotFromGraph, so an index swapped mid-read is refused.
 * @param {{ registry: string, repo: string, readFile?: (p: string) => string, backendVersion?: string | null }} o
 */
export function registryIndexReader({ registry, repo, readFile = (p) => readFileSync(p, "utf8"), backendVersion = null }) {
  return async () => {
    let entries;
    try {
      entries = JSON.parse(readFile(registry));
    } catch (e) {
      throw new GraphReadError("backend-unavailable", `registry unreadable at ${registry}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const list = Array.isArray(entries) ? entries : Array.isArray(entries?.repositories) ? entries.repositories : [];
    const hit = list.find((r) => r && r.name === repo);
    if (!hit || typeof hit.lastCommit !== "string" || hit.lastCommit.length === 0) {
      throw new GraphReadError("backend-unavailable", `repo ${repo} not in registry ${registry}`);
    }
    return { lastCommit: hit.lastCommit, indexedAt: hit.indexedAt ?? null, backend: "gitnexus", backendVersion };
  };
}

/** The installed gitnexus version next to a CLI binary (`…/node_modules/.bin/gitnexus`). */
export function backendVersionNearBin(bin, readFile = (p) => readFileSync(p, "utf8")) {
  try {
    const pkg = JSON.parse(readFile(join(dirname(dirname(bin)), "gitnexus", "package.json")));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** Call a Papercusp MCP tool with the shared in-process transport helpers. */
async function mcpCallText(tool, args, client) {
  const token = readFileSync(join(homedir(), ".papercusp", "superuser-token"), "utf8").trim();
  const clientId = resolveMcpClientId({ client });
  const query = buildMcpSessionQuery({
    client: clientId,
    workspace: resolveMcpWorkspace(),
    role: resolveMcpRole(),
    origin: resolveMcpCallOrigin(clientId),
  });
  const { configuredPort, candidatePorts, pinned } = resolveCandidatePorts({});
  const init = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: buildMcpCallParams(tool, args, { outputGroupId: randomUUID() }),
    }),
  };
  const attempts = [];

  for (let index = 0; index < candidatePorts.length; index += 1) {
    const port = candidatePorts[index];
    let raw;
    try {
      const response = await fetchWithConnectionRecovery(
        `http://localhost:${port}/api/mcp?${query}`,
        init,
        { retryWindowMs: pinned ? MCP_CALL_CONNECTION_RETRY_WINDOW_MS : 0 },
      );
      raw = await response.text();
    } catch (error) {
      attempts.push({ port, error });
      continue;
    }

    if (!pinned && index < candidatePorts.length - 1 && isRecoverableAuthorityDenial(raw)) continue;
    const parsed = parseSse(raw, 1);
    if (parsed.error) throw new Error(`mcp-call ${tool} failed: ${JSON.stringify(parsed.error)}`);
    const notOk = toolResultNotOkReason(parsed.result);
    if (notOk !== null) throw new Error(`mcp-call ${tool} answered ok:false: ${notOk}`);
    if (typeof parsed.result === "string") return parsed.result;
    if (parsed.result && typeof parsed.result === "object") return JSON.stringify(parsed.result);
    throw new Error(`mcp-call ${tool} returned no usable result`);
  }

  throw new Error(buildUnreachableDiagnostic({ attempts, configuredPort, pinned }));
}

function installedBackendVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "node_modules", "gitnexus", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stderr.write(`GRAPH_SNAPSHOT status=usage-error reason=${parsed.error}\n`);
    return 2;
  }
  const { opts } = parsed;
  // Default target is the SHARED path the selector reads first (outside every checkout, so the
  // gate's isolated tree sees it); `--out` keeps any explicit (e.g. legacy per-checkout) target.
  const out = opts.out ? resolve(ROOT, opts.out) : sharedSnapshotPath(opts.repo);
  const sourceRoot = resolve(opts.sourceRoot);
  const readSource = (rel) => {
    try {
      return readFileSync(join(sourceRoot, rel), "utf8");
    } catch {
      return null;
    }
  };
  const now = Date.now();
  let result;
  try {
    if (opts.edgesFile) {
      const edges = JSON.parse(readFileSync(resolve(opts.edgesFile), "utf8"));
      if (!Array.isArray(edges)) throw new GraphReadError("usage", "--edges-file must hold a JSON array");
      result = produceSnapshotFromEdges({ edges, index: { lastCommit: opts.indexCommit, indexedAt: null, backend: "edges-file", backendVersion: null }, readSource, now });
    } else if (opts.gitnexusBin) {
      result = await produceSnapshotFromGraph({
        runCypher: directCypherRunner({ bin: opts.gitnexusBin, repo: opts.repo, cwd: sourceRoot }),
        fetchIndex: registryIndexReader({
          registry: opts.registry ?? join(homedir(), ".gitnexus", "registry.json"),
          repo: opts.repo,
          backendVersion: backendVersionNearBin(opts.gitnexusBin),
        }),
        readSource,
        now,
        pageSize: opts.pageSize,
        retries: opts.retries,
        onProgress: ({ pages, rows, expected, pageSize }) => {
          process.stderr.write(`GRAPH_SNAPSHOT_PROGRESS pages=${pages} rows=${rows}/${expected} pageSize=${pageSize}\n`);
        },
      });
    } else {
      const fetchIndex = async () => {
        const text = await mcpCallText("gitnexus.list_repos", { limit: 200 }, opts.client);
        const repos = JSON.parse(text.split("\n\n---\n")[0]).repositories ?? [];
        const repo = repos.find((r) => r.name === opts.repo);
        if (!repo || typeof repo.lastCommit !== "string") throw new GraphReadError("backend-unavailable", `repo ${opts.repo} not in list_repos`);
        return { lastCommit: repo.lastCommit, indexedAt: repo.indexedAt ?? null, backend: "gitnexus", backendVersion: installedBackendVersion() };
      };
      result = await produceSnapshotFromGraph({
        runCypher: async (statement) => mcpCallText("gitnexus.cypher", { statement, repo: opts.repo }, opts.client),
        fetchIndex,
        readSource,
        now,
        pageSize: opts.pageSize,
        retries: opts.retries,
        onProgress: ({ pages, rows, expected, pageSize }) => {
          if (pages % 100 === 0) process.stderr.write(`GRAPH_SNAPSHOT_PROGRESS pages=${pages} rows=${rows}/${expected} pageSize=${pageSize}\n`);
        },
      });
    }
  } catch (e) {
    const code = e instanceof GraphReadError ? e.code : "backend-unavailable";
    process.stderr.write(`GRAPH_SNAPSHOT status=not-written reason=${code} detail=${JSON.stringify(e instanceof Error ? e.message : String(e))} out=${out}\n`);
    return code === "usage" ? 2 : 3;
  }
  let bytes;
  try {
    bytes = writeSnapshotAtomic(out, result.snapshot);
  } catch (e) {
    process.stderr.write(`GRAPH_SNAPSHOT status=write-failed detail=${JSON.stringify(e instanceof Error ? e.message : String(e))} out=${out}\n`);
    return 4;
  }
  const s = result.stats;
  process.stderr.write(
    `GRAPH_SNAPSHOT status=written edges=${s.kept} input=${s.input} uncorroborated=${s.skippedUncorroborated} missing=${s.skippedMissing} duplicates=${s.duplicates} rows=${result.rows} pages=${result.pages} bytes=${bytes} index=${result.snapshot.index.lastCommit.slice(0, 10)} out=${out}\n`,
  );
  return 0;
}

if (isCliEntry(import.meta.url)) {
  main().then((code) => process.exit(code));
}
