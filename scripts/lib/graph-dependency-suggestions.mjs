// Snapshot-bound, source-corroborated graph dependency SUGGESTIONS for the affected-test
// selector (plan gitnexus-selective-hardening-and-comparison-2026-09-13, P-008).
//
// The selector's baseline derives affected workspaces from `package.json` dependencies. That
// misses file-level imports that cross a workspace boundary without a declared dependency
// (relative `../../x/y` imports, tsconfig/vite aliases). A code graph knows those edges.
// This module lets a PRE-COMPUTED graph snapshot ADD workspaces to the baseline. It is
// deliberately incapable of anything else:
//
//   * SUPERSET ONLY — a suggestion adds workspaces; nothing here can remove or narrow the
//     baseline. `unionSuperset` asserts it. A stale / invalid / absent snapshot adds nothing.
//   * NO LIVE GRAPH — this file only READS a JSON snapshot. Producing the snapshot (which
//     talks to the graph backend) is an out-of-band step (`gen-graph-dependency-snapshot.mjs`);
//     an ordinary gate run never starts or queries a graph server.
//   * SNAPSHOT-BOUND — every edge records the sha256 of the importer's source at snapshot
//     time; an edge whose importer has changed since is `stale-importer` and is dropped. The
//     snapshot as a whole is bound to the index identity (`index.lastCommit`) and ages out.
//   * SOURCE-CORROBORATED — the graph is never trusted alone: an edge is accepted only when
//     the importer's CURRENT source contains an import/export-from/require specifier that
//     resolves to the imported file. A wrong graph edge costs nothing but is never believed.
//
// Pure + hermetic: every filesystem/clock dependency is injected.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";

export const GRAPH_SNAPSHOT_SCHEMA = "graph-dependency-snapshot-v1";
export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A snapshot dated in the future by more than this is treated as invalid (clock/forgery). */
const FUTURE_SKEW_MS = 5 * 60 * 1000;
/** Hard cap on files visited by one suggestion walk — a bound, never a verdict. */
export const MAX_VISITED_FILES = 20000;

const RESOLVE_EXTS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const JS_TO_TS = new Map([
  [".js", [".ts", ".tsx"]],
  [".jsx", [".tsx"]],
  [".mjs", [".mts"]],
  [".cjs", [".cts"]],
]);
const SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"`])([^'"`\n]+)\1/g;
const SHA256_RE = /^[0-9a-f]{64}$/;

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isRepoRelativePosix(p) {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    !p.startsWith("/") &&
    !p.includes("\\") &&
    !p.split("/").includes("..")
  );
}

/** Parse + validate snapshot text. Malformed EDGES are dropped (adds nothing); a malformed
 * snapshot as a whole is `{ ok:false }` so the caller records `status=invalid`. */
export function parseSnapshot(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (!raw || typeof raw !== "object" || raw.schema !== GRAPH_SNAPSHOT_SCHEMA) {
    return { ok: false, reason: "schema-mismatch" };
  }
  const index = raw.index;
  if (!index || typeof index.lastCommit !== "string" || index.lastCommit.length === 0) {
    return { ok: false, reason: "missing-index-identity" };
  }
  if (typeof raw.generatedAt !== "string" || Number.isNaN(Date.parse(raw.generatedAt))) {
    return { ok: false, reason: "missing-generated-at" };
  }
  if (!Array.isArray(raw.edges)) return { ok: false, reason: "edges-not-array" };
  const edges = [];
  let droppedMalformed = 0;
  for (const e of raw.edges) {
    if (
      e &&
      isRepoRelativePosix(e.importer) &&
      isRepoRelativePosix(e.imported) &&
      typeof e.importerSha256 === "string" &&
      SHA256_RE.test(e.importerSha256)
    ) {
      edges.push({ importer: e.importer, imported: e.imported, importerSha256: e.importerSha256 });
    } else {
      droppedMalformed += 1;
    }
  }
  return {
    ok: true,
    droppedMalformed,
    snapshot: {
      schema: GRAPH_SNAPSHOT_SCHEMA,
      index: {
        lastCommit: index.lastCommit,
        indexedAt: typeof index.indexedAt === "string" ? index.indexedAt : null,
        backend: typeof index.backend === "string" ? index.backend : null,
        backendVersion: typeof index.backendVersion === "string" ? index.backendVersion : null,
      },
      generatedAt: raw.generatedAt,
      edges,
    },
  };
}

/** Module specifiers an import/export-from/require/dynamic-import in `source` names. */
export function extractSpecifiers(source) {
  const out = [];
  SPECIFIER_RE.lastIndex = 0;
  let m;
  while ((m = SPECIFIER_RE.exec(source)) !== null) out.push(m[2]);
  return out;
}

/** Candidate repo-relative files a RELATIVE specifier written in `importer` can name. */
export function relativeCandidates(importer, specifier) {
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier));
  const out = new Set();
  for (const ext of RESOLVE_EXTS) out.add(`${base}${ext}`);
  for (const ext of RESOLVE_EXTS) out.add(`${base}/index${ext}`);
  for (const [from, tos] of JS_TO_TS) {
    if (base.endsWith(from)) {
      const stem = base.slice(0, -from.length);
      for (const to of tos) out.add(`${stem}${to}`);
    }
  }
  return out;
}

function stripExt(p) {
  const i = p.lastIndexOf(".");
  return i > p.lastIndexOf("/") ? p.slice(0, i) : p;
}

/** A non-relative (alias / package) specifier can only be corroborated by path tail: its
 * trailing segments must equal the imported path's trailing segments (>= 2, or the whole
 * path when shorter). Deliberately conservative — a miss only drops a suggestion. */
function aliasTailMatches(specifier, imported) {
  const impSegs = stripExt(imported).split("/");
  const specSegs = specifier.replace(/^[@~]\/?/, "").split("/");
  const want = Math.min(2, impSegs.length);
  if (specSegs.length < want) return false;
  for (let i = 1; i <= want; i += 1) {
    if (specSegs[specSegs.length - i] !== impSegs[impSegs.length - i]) return false;
  }
  return true;
}

/** Does `source` (the importer's current text) actually import `imported`? */
export function sourceCorroborates(source, importer, imported) {
  for (const spec of extractSpecifiers(source)) {
    if (spec.startsWith("./") || spec.startsWith("../")) {
      if (relativeCandidates(importer, spec).has(imported)) return true;
    } else if (aliasTailMatches(spec, imported)) {
      return true;
    }
  }
  return false;
}

/** Verify ONE snapshot edge against the current tree. */
export function verifyEdge(edge, { readSource }) {
  const source = readSource(edge.importer);
  if (typeof source !== "string") return { ok: false, reason: "importer-missing" };
  if (sha256Hex(source) !== edge.importerSha256) return { ok: false, reason: "stale-importer" };
  if (!sourceCorroborates(source, edge.importer, edge.imported)) {
    return { ok: false, reason: "uncorroborated" };
  }
  return { ok: true };
}

/** Walk verified importers of `changed` files in `snapshot`. Never throws on bad data; the
 * only outputs are accepted importer files plus a full account of what was rejected.
 * @param {{ changed: string[], snapshot: any, now: number, maxAgeMs?: number, readSource: (rel: string) => string | null }} args
 */
export function suggestFromSnapshot({ changed, snapshot, now, maxAgeMs, readSource }) {
  if (!snapshot) return { status: "unavailable", suggestedFiles: [], accepted: [], rejected: [] };
  const generated = Date.parse(snapshot.generatedAt);
  const age = now - generated;
  const index = snapshot.index;
  if (!Number.isFinite(generated) || age < -FUTURE_SKEW_MS) {
    return { status: "invalid", reason: "generated-at-in-future", suggestedFiles: [], accepted: [], rejected: [], index };
  }
  if (age > (maxAgeMs ?? DEFAULT_MAX_AGE_MS)) {
    return { status: "stale", reason: "snapshot-too-old", suggestedFiles: [], accepted: [], rejected: [], index };
  }
  const importedBy = new Map();
  for (const e of snapshot.edges) {
    const list = importedBy.get(e.imported);
    if (list) list.push(e);
    else importedBy.set(e.imported, [e]);
  }
  const acceptedImporters = new Set();
  const accepted = [];
  const rejected = [];
  const seen = new Set();
  const queue = [];
  let truncated = false;
  for (const file of changed) {
    if (seen.has(file)) continue;
    if (seen.size >= MAX_VISITED_FILES) {
      truncated = true;
      break;
    }
    seen.add(file);
    queue.push(file);
  }
  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const file = queue[queueIndex++];
    for (const edge of importedBy.get(file) ?? []) {
      if (acceptedImporters.has(edge.importer)) continue;
      const verdict = verifyEdge(edge, { readSource });
      if (!verdict.ok) {
        rejected.push({ importer: edge.importer, imported: edge.imported, reason: verdict.reason });
        continue;
      }
      acceptedImporters.add(edge.importer);
      accepted.push({ importer: edge.importer, imported: edge.imported });
      if (seen.size >= MAX_VISITED_FILES) {
        truncated = true;
        continue;
      }
      if (!seen.has(edge.importer)) {
        seen.add(edge.importer);
        queue.push(edge.importer);
      }
    }
  }
  return {
    status: "applied",
    suggestedFiles: [...acceptedImporters],
    accepted,
    rejected,
    truncated,
    index,
  };
}

/** baseline ∪ suggested, asserting the one invariant this whole feature exists to keep:
 * the result is a superset of the baseline. Returns the names added beyond it. */
export function unionSuperset(baseline, suggested) {
  const base = new Set(baseline);
  const out = new Set(base);
  for (const s of suggested) out.add(s);
  for (const b of base) {
    if (!out.has(b)) throw new Error(`graph suggestions violated superset invariant: lost ${b}`);
  }
  const added = [...out].filter((n) => !base.has(n)).sort();
  return { names: [...out], added };
}

/** The gitnexus repo name this tree is indexed under (the reindex routine's `--name`). */
export const GRAPH_SNAPSHOT_REPO = "papercusp";

/**
 * Where the reindex routine writes the snapshot (gitnexus-deterministic-integration P-001):
 * OUTSIDE every checkout, so the green-checkpoint's isolated tree — whose gitignored
 * `.papercusp/` never holds one — reads the same file the canonical tree does.
 */
export function sharedSnapshotPath(repoName = GRAPH_SNAPSHOT_REPO, home = homedir()) {
  return join(home, ".papercusp", "graph-snapshot", repoName, "dependency-snapshot.json");
}

/**
 * Resolve the snapshot the selector reads, and say WHERE it came from (printed on the status
 * line, so a dormant or misplaced snapshot is never silent). Order: an explicit env path; the
 * shared routine-written path; the legacy per-checkout path. Under Vitest (`VITEST` set) with no
 * explicit path the default lookup is OFF: dozens of tests spawn the selector and assert exact
 * workspace sets, and a host snapshot leaking into them would make those sets host-dependent.
 * @param {{ env: Record<string, string | undefined>, root: string, home?: string, exists?: (p: string) => boolean }} args
 * @returns {{ path: string | null, source: "env" | "shared" | "checkout" | "hermetic-test" }}
 */
export function resolveSnapshotPath({ env, root, home = homedir(), exists = existsSync }) {
  const explicit = env.PAPERCUSP_AFFECTED_GRAPH_SNAPSHOT;
  if (explicit) return { path: explicit, source: "env" };
  if (env.VITEST) return { path: null, source: "hermetic-test" };
  const shared = sharedSnapshotPath(GRAPH_SNAPSHOT_REPO, home);
  if (exists(shared)) return { path: shared, source: "shared" };
  const checkout = join(root, ".papercusp", "graph-snapshot", "dependency-snapshot.json");
  if (exists(checkout)) return { path: checkout, source: "checkout" };
  return { path: shared, source: "shared" };
}

/** Read + parse a snapshot file; never throws. A missing file is `unavailable/absent`. */
export function loadSnapshotFile(path, { readFile }) {
  let text;
  try {
    text = readFile(path);
  } catch (e) {
    return { status: "unavailable", reason: e && e.code === "ENOENT" ? "absent" : "unreadable" };
  }
  const parsed = parseSnapshot(text);
  if (!parsed.ok) return { status: "invalid", reason: parsed.reason };
  return { status: "ok", snapshot: parsed.snapshot, droppedMalformed: parsed.droppedMalformed };
}

/**
 * One-call integration seam for the selector: snapshot path in, workspace NAMES to add out.
 * `ownerOfPath(file)` maps a repo-relative file to the workspace names that own it.
 * @param {{ changed: string[], snapshotPath: string | null, readFile: (p: string) => string, readSource: (rel: string) => string | null, ownerOfPath: (file: string) => string[], now: number, maxAgeMs?: number }} args
 */
export function computeGraphSuggestions({ changed, snapshotPath, readFile, readSource, ownerOfPath, now, maxAgeMs }) {
  if (!snapshotPath) {
    return { status: "unavailable", reason: "no-snapshot-path", workspaces: [], accepted: 0, rejected: 0, index: null, ageMs: null };
  }
  const loaded = loadSnapshotFile(snapshotPath, { readFile });
  if (loaded.status !== "ok") {
    return {
      status: loaded.status,
      reason: loaded.reason ?? null,
      workspaces: [],
      accepted: 0,
      rejected: 0,
      index: null,
      ageMs: null,
    };
  }
  const ageMs = now - Date.parse(loaded.snapshot.generatedAt);
  const result = suggestFromSnapshot({ changed, snapshot: loaded.snapshot, now, maxAgeMs, readSource });
  const workspaces = new Set();
  for (const file of result.suggestedFiles) {
    for (const name of ownerOfPath(file) ?? []) workspaces.add(name);
  }
  return {
    status: result.status,
    reason: result.reason ?? null,
    workspaces: [...workspaces].sort(),
    accepted: result.accepted.length,
    rejected: result.rejected.length,
    rejectedReasons: [...new Set(result.rejected.map((r) => r.reason))].sort(),
    truncated: Boolean(result.truncated),
    index: result.index ?? null,
    ageMs: Number.isFinite(ageMs) ? ageMs : null,
  };
}

/** Snapshot age as hours with one decimal, or `none` when nothing was loaded. */
export function formatSnapshotAge(ageMs) {
  return typeof ageMs === "number" && Number.isFinite(ageMs) ? `${(Math.max(0, ageMs) / 3_600_000).toFixed(1)}h` : "none";
}

/**
 * The single greppable stderr line the selector prints on EVERY run (stdout stays a clean
 * AFFECTED_WS list, so no stdout parser sees it). Printing it when the snapshot is absent or
 * stale is the point: P-008's suggestions sat inert for days because this line was silent then.
 * `source` names where the snapshot was looked for (env | shared | checkout | hermetic-test).
 * @param {{ status: string, reason?: string | null, accepted: number, rejected: number, index?: { lastCommit?: string } | null, ageMs?: number | null }} report
 * @param {string[]} added
 * @param {string | null} [source]
 * @returns {string}
 */
export function formatSuggestionLine(report, added, source = null) {
  const idx = report.index?.lastCommit ? report.index.lastCommit.slice(0, 10) : "none";
  return (
    `GRAPH_SUGGESTIONS status=${report.status}` +
    (report.reason ? ` reason=${report.reason}` : "") +
    ` accepted=${report.accepted} rejected=${report.rejected}` +
    ` added=${added.length ? added.join(",") : "none"} index=${idx}` +
    ` age=${formatSnapshotAge(report.ageMs)}` +
    (source ? ` source=${source}` : "")
  );
}

/**
 * Producer (out-of-band, used by gen-graph-dependency-snapshot.mjs): turn raw
 * `{importer, imported}` graph edges into a snapshot, keeping only edges the CURRENT source
 * corroborates and binding each to the importer's content hash.
 */
export function buildSnapshot({ edges, index, readSource, now }) {
  const kept = [];
  const seen = new Set();
  const stats = { input: 0, kept: 0, skippedMissing: 0, skippedUncorroborated: 0, duplicates: 0 };
  const cache = new Map();
  const source = (p) => {
    if (!cache.has(p)) cache.set(p, readSource(p));
    return cache.get(p);
  };
  for (const e of edges) {
    stats.input += 1;
    if (!isRepoRelativePosix(e.importer) || !isRepoRelativePosix(e.imported)) {
      stats.skippedMissing += 1;
      continue;
    }
    const key = `${e.importer}\u0000${e.imported}`;
    if (seen.has(key)) {
      stats.duplicates += 1;
      continue;
    }
    seen.add(key);
    const text = source(e.importer);
    if (typeof text !== "string") {
      stats.skippedMissing += 1;
      continue;
    }
    if (!sourceCorroborates(text, e.importer, e.imported)) {
      stats.skippedUncorroborated += 1;
      continue;
    }
    kept.push({ importer: e.importer, imported: e.imported, importerSha256: sha256Hex(text) });
  }
  kept.sort((a, b) => (a.imported === b.imported ? a.importer.localeCompare(b.importer) : a.imported.localeCompare(b.imported)));
  stats.kept = kept.length;
  return {
    snapshot: {
      schema: GRAPH_SNAPSHOT_SCHEMA,
      index,
      generatedAt: new Date(now).toISOString(),
      edges: kept,
    },
    stats,
  };
}
