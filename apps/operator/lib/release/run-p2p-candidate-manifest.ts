/**
 * run-p2p-candidate-manifest.ts — CLI entry point for `buildP2pCandidateManifest()`
 * (p2p-public-release-endgame-2026-09-01 D-038 / D-080, WI-10002524). Mirrors
 * run-autoloop-release-profile.ts.
 *
 * COMPUTED mode (the P-521 manifest; nothing hand-written):
 *
 *   npx tsx apps/operator/lib/release/run-p2p-candidate-manifest.ts \
 *     --release 0.0.25 [--channel alpha] \
 *     --leg linux=<leg dir>/build-provenance.json --leg mac=… --leg windows=… \
 *     [--evidence-dir docs/evidence] [--rehash none|ledger-only|all] \
 *     [--history <prior manifest.json>] \
 *     --provenance-out <provenance.json> [--journeys-out <journeys.json>] --out <manifest.json>
 *
 * The candidate provenance is derived by `deriveCandidateProvenance()` from each leg's
 * emitted build-provenance.json, the `harness_shared.releases` row, optional fresh
 * re-hashes and the recorded `release:cut op:run` invocation. Journey results are
 * derived by `deriveJourneyEvidence()` from the operational evidence documents. The
 * provenance output is a `P2pCandidateProvenance` superset, so the legacy mode below
 * accepts it unchanged. Exit status 2 means a provenance check FAILED (the files are
 * still written, so the contradiction is inspectable).
 *
 * LEGACY mode (explicit inputs):
 *
 *   npx tsx apps/operator/lib/release/run-p2p-candidate-manifest.ts \
 *     --provenance <candidate.json> [--journeys <journeys.json>] [--history <manifest.json>] --out <manifest.json>
 *
 * `--history` appends the prior manifest's current interpretation to history, so
 * re-running after each journey keeps history append-only. Both modes write the
 * manifest JSON to --out and print the readiness table to stdout.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import {
  appendReadinessHistory,
  renderReadinessTable,
  serializeCurrentReadinessManifest,
  type CurrentReadinessManifest,
  type ReadinessHistoryEntry,
} from './current-readiness-manifest';
import {
  artifactBasename,
  deriveCandidateProvenance,
  deriveJourneyEvidence,
  parseLegBuildProvenance,
  type ArtifactRehash,
  type BuildCommandRecord,
  type DerivedCandidateProvenance,
  type DerivedJourneyEvidence,
  type EvidenceDocInput,
  type LegProvenanceInput,
  type ReleaseLedgerRecord,
} from './p2p-candidate-evidence';
import {
  buildP2pCandidateManifest,
  type P2pCandidateProvenance,
  type P2pJourneyResult,
} from './p2p-candidate-manifest';

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function flags(argv: readonly string[], name: string): string[] {
  const out: string[] = [];
  argv.forEach((arg, i) => {
    if (arg === `--${name}` && argv[i + 1] !== undefined) out.push(argv[i + 1]);
  });
  return out;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Replace the operator's home directory with `~` so evidence files carry no user path. */
export function redactHome(text: string, home: string = homedir()): string {
  if (!home || home === '/') return text;
  return text.split(home).join('~');
}

export function sha256Bytes(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export type RehashScope = 'none' | 'ledger-only' | 'all';

/** Reads that need the operator database, injectable for tests. */
export interface ComputeDeps {
  readLedger(version: string, channel: string): Promise<ReleaseLedgerRecord | null>;
  readBuildCommand(version: string, channel: string, sourceSha: string | null): Promise<BuildCommandRecord | null>;
  hashFile(path: string): Promise<string>;
}

export interface ComputeOptions {
  version: string;
  channel: string;
  /** `label=path` pairs. */
  legs: readonly { leg: string; path: string }[];
  evidenceDir?: string;
  /** Root that evidence paths are reported relative to (default: cwd). */
  repoRoot?: string;
  rehash?: RehashScope;
  history?: readonly ReadinessHistoryEntry[];
  now?: number;
}

export interface ComputeResult {
  provenance: DerivedCandidateProvenance;
  evidence: DerivedJourneyEvidence;
  manifest: CurrentReadinessManifest;
}

/** Find `<dir>/<name>` or `<dir>/<sub>/<name>` for a ledger artifact basename. */
function locateInLegDirs(legDirs: readonly string[], name: string): string | null {
  for (const dir of legDirs) {
    const direct = join(dir, name);
    if (existsSync(direct)) return direct;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const nested = join(dir, entry, name);
      try {
        if (statSync(join(dir, entry)).isDirectory() && existsSync(nested)) return nested;
      } catch {
        // unreadable entry: keep looking
      }
    }
  }
  return null;
}

export function readEvidenceDir(dir: string, repoRoot: string): EvidenceDocInput[] {
  const out: EvidenceDocInput[] = [];
  for (const entry of readdirSync(dir).filter((e) => e.endsWith('.json')).sort()) {
    const full = join(dir, entry);
    const bytes = readFileSync(full);
    let doc: unknown;
    try {
      doc = JSON.parse(bytes.toString('utf8'));
    } catch {
      doc = null;
    }
    out.push({ path: relative(repoRoot, full), sha256: sha256Bytes(bytes), doc });
  }
  return out;
}

/** COMPUTED mode, with every database/file read injectable. */
export async function computeCandidateManifestFromRecords(
  options: ComputeOptions,
  deps: ComputeDeps,
): Promise<ComputeResult> {
  const legs: LegProvenanceInput[] = options.legs.map(({ leg, path }) => {
    const bytes = readFileSync(path);
    return {
      leg,
      path,
      fileSha256: sha256Bytes(bytes),
      record: parseLegBuildProvenance(JSON.parse(bytes.toString('utf8')), `${leg} (${path})`),
    };
  });
  const ledger = await deps.readLedger(options.version, options.channel);
  const sourceGuess = ledger?.gitSha ?? null;
  const buildCommand = await deps.readBuildCommand(options.version, options.channel, sourceGuess);

  const rehashScope = options.rehash ?? 'none';
  const rehashes: ArtifactRehash[] = [];
  if (rehashScope !== 'none') {
    const legDirs = legs.map((l) => dirname(l.path));
    const legBasenames = new Set(legs.flatMap((l) => l.record.artifacts.map((a) => artifactBasename(a.name))));
    const targets: { name: string; path: string }[] = [];
    if (rehashScope === 'all') {
      for (const l of legs) for (const a of l.record.artifacts) targets.push({ name: a.name, path: join(dirname(l.path), a.name) });
    }
    for (const a of ledger?.artifacts ?? []) {
      if (legBasenames.has(artifactBasename(a.name))) continue;
      const found = locateInLegDirs(legDirs, artifactBasename(a.name));
      if (found) targets.push({ name: a.name, path: found });
    }
    for (const t of targets) {
      if (!existsSync(t.path)) continue;
      rehashes.push({ name: t.name, path: t.path, bytes: statSync(t.path).size, sha256: await deps.hashFile(t.path) });
    }
  }

  const provenance = deriveCandidateProvenance({
    version: options.version,
    channel: options.channel,
    legs,
    ledger,
    rehashes,
    buildCommand,
  });
  const repoRoot = options.repoRoot ?? process.cwd();
  const evidence = deriveJourneyEvidence({
    candidate: provenance,
    evidence: options.evidenceDir ? readEvidenceDir(options.evidenceDir, repoRoot) : [],
  });
  const manifest = await buildP2pCandidateManifest({
    candidate: provenance,
    journeys: evidence.journeys,
    history: options.history,
    now: options.now,
  });
  return { provenance, evidence, manifest };
}

type SqlClient = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;

/** Database-backed deps: the release ledger row and the recorded `release:cut op:run`. */
export function databaseDeps(sql: SqlClient, workspaceId: string): ComputeDeps {
  return {
    async readLedger(version, channel) {
      const rows = await sql`
        SELECT version, channel, git_sha, cut_at, published_at, artifacts
          FROM harness_shared.releases
         WHERE workspace_id = ${workspaceId} AND version = ${version} AND channel = ${channel}`;
      const row = rows[0];
      if (!row) return null;
      const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
      return {
        version: String(row.version),
        channel: String(row.channel),
        gitSha: row.git_sha == null ? null : String(row.git_sha),
        cutAt: iso(row.cut_at),
        publishedAt: iso(row.published_at),
        artifacts: Array.isArray(row.artifacts) ? (row.artifacts as ReleaseLedgerRecord['artifacts']) : [],
      };
    },
    async readBuildCommand(version, channel, sourceSha) {
      // The latest CONFIRMED successful `release:cut op:run` for this version is the
      // invocation that produced the artifacts; the provenance check then verifies it
      // precedes every leg's build time.
      const rows = await sql`
        SELECT id, invoked_at, args_json, serving_build_sha
          FROM harness_shared.tool_invocations
         WHERE workspace_id = ${workspaceId}
           AND tool_name = 'release:cut'
           AND status = 'ok'
           AND args_json->>'op' = 'run'
           AND args_json->>'version' = ${version}
           AND COALESCE(args_json->>'channel', ${channel}) = ${channel}
           AND (args_json->>'confirm')::boolean IS TRUE
           AND (${sourceSha}::text IS NULL OR args_json->>'sourceSha' = ${sourceSha})
         ORDER BY invoked_at DESC
         LIMIT 1`;
      const row = rows[0];
      if (!row) return null;
      return {
        tool: 'release:cut',
        invocationId: String(row.id),
        invokedAt: row.invoked_at instanceof Date ? row.invoked_at.toISOString() : String(row.invoked_at),
        args: (row.args_json ?? {}) as Record<string, unknown>,
        servingBuildSha: row.serving_build_sha == null ? null : String(row.serving_build_sha),
      };
    },
    hashFile: sha256File,
  };
}

function parseLegFlags(values: readonly string[]): { leg: string; path: string }[] {
  return values.map((value) => {
    const eq = value.indexOf('=');
    if (eq <= 0 || eq === value.length - 1) throw new Error(`--leg expects <label>=<build-provenance.json>, got '${value}'`);
    return { leg: value.slice(0, eq), path: value.slice(eq + 1) };
  });
}

function priorHistory(historyPath: string | undefined): readonly ReadinessHistoryEntry[] | undefined {
  if (!historyPath) return undefined;
  return appendReadinessHistory(readJson<CurrentReadinessManifest>(historyPath)).history;
}

function writeRedacted(path: string, text: string): void {
  writeFileSync(path, `${redactHome(text)}\n`);
}

async function mainComputed(argv: readonly string[]): Promise<number> {
  const version = flag(argv, 'release')!;
  const channel = flag(argv, 'channel') ?? 'alpha';
  const outPath = flag(argv, 'out');
  const provenanceOut = flag(argv, 'provenance-out');
  if (!outPath || !provenanceOut) throw new Error('--release mode needs --provenance-out <file> and --out <file>');
  const legs = parseLegFlags(flags(argv, 'leg'));
  if (legs.length === 0) throw new Error('--release mode needs at least one --leg <label>=<build-provenance.json>');
  const rehash = (flag(argv, 'rehash') ?? 'none') as RehashScope;
  if (!['none', 'ledger-only', 'all'].includes(rehash)) throw new Error(`--rehash must be none|ledger-only|all, got '${rehash}'`);

  const { default: postgres } = await import('postgres');
  const { getHarnessAdminUrl } = await import('@papercusp/operator-core/lib/embedded-pg-discovery');
  const sql = postgres(getHarnessAdminUrl(), { max: 1 });
  try {
    const workspaceId = flag(argv, 'workspace') ?? 'papercusp-workspace';
    const result = await computeCandidateManifestFromRecords(
      {
        version,
        channel,
        legs,
        evidenceDir: flag(argv, 'evidence-dir') ?? 'docs/evidence',
        rehash,
        history: priorHistory(flag(argv, 'history')),
      },
      databaseDeps(sql as unknown as SqlClient, workspaceId),
    );
    writeRedacted(provenanceOut, JSON.stringify(result.provenance, null, 2));
    const journeysOut = flag(argv, 'journeys-out');
    if (journeysOut) writeRedacted(journeysOut, JSON.stringify(result.evidence, null, 2));
    writeRedacted(outPath, serializeCurrentReadinessManifest(result.manifest));
    for (const c of result.provenance.provenance.checks) console.log(`[${c.status}] ${c.id}: ${redactHome(c.detail)}`);
    console.log(
      `evidence: ${result.evidence.bindings.length} journey-declared doc(s), ${result.evidence.unmapped.length} on this candidate but unmapped (${result.evidence.unmapped.map((u) => basename(u.path)).join(', ') || 'none'})`,
    );
    for (const m of result.evidence.mappings) {
      console.log(`mapping ${basename(m.path)}: ${m.applied ? 'applied' : 'NOT applied'}: ${redactHome(m.reason)}`);
    }
    console.log(renderReadinessTable(result.manifest));
    console.log(`artifact ${result.manifest.artifact.id} sha256=${result.manifest.artifact.sha256} go=${result.manifest.current.go}`);
    return result.provenance.provenance.ok ? 0 : 2;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function mainLegacy(argv: readonly string[]): Promise<number> {
  const provenancePath = flag(argv, 'provenance');
  const outPath = flag(argv, 'out');
  if (!provenancePath || !outPath) {
    throw new Error(
      'usage: --release <version> --leg <label>=<build-provenance.json>… --provenance-out <file> --out <file>  |  --provenance <candidate.json> [--journeys <journeys.json>] [--history <manifest.json>] --out <manifest.json>',
    );
  }
  const journeysPath = flag(argv, 'journeys');
  const manifest = await buildP2pCandidateManifest({
    candidate: readJson<P2pCandidateProvenance>(provenancePath),
    journeys: journeysPath ? readJson<Record<string, P2pJourneyResult>>(journeysPath) : undefined,
    history: priorHistory(flag(argv, 'history')),
  });
  writeFileSync(outPath, `${serializeCurrentReadinessManifest(manifest)}\n`);
  console.log(renderReadinessTable(manifest));
  console.log(`artifact ${manifest.artifact.id} sha256=${manifest.artifact.sha256} go=${manifest.current.go}`);
  return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  return flag(argv, 'release') ? mainComputed(argv) : mainLegacy(argv);
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('[run-p2p-candidate-manifest] FAILED:', e instanceof Error ? (e.stack ?? e.message) : e);
      process.exit(1);
    });
}
