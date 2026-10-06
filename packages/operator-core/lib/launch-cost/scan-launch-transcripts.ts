/**
 * Launch-cost metrics — the STREAMING half of the baseline instrument
 * (plan `agent-launch-context-cost-2026-09-18`, P-001).
 *
 * ⚠ WHY THIS STREAMS, AND WHY THAT IS THE WHOLE POINT OF THE FILE.
 * A psu Claude transcript's first entry is the system prompt, and it is ~580 KB on ONE line. The
 * first row carrying `message.usage` — the launch measurement — sits after it. So any reader that
 * looks at a bounded prefix of the file (a 600 KB read window, a `head -c`, a capped file-read
 * tool) never reaches the usage row and returns ZERO ROWS. Zero rows is indistinguishable from
 * "this session has no usage data", which is exactly the reading that makes an agent conclude the
 * corpus is empty and move on. Every read here is a `createReadStream` + `readline` pass that
 * stops at the first qualifying row, so the window can never be the reason a file measures empty.
 * `scan-launch-transcripts.test.ts` pins this with a fixture whose usage row sits past 600 KB.
 *
 * SKIPS ARE COUNTED, NOT SWALLOWED. Every file that yields no sample lands in `skipped` with a
 * typed reason. An instrument that silently drops files reports a smaller, cleaner-looking corpus
 * than it measured, and the difference is invisible at the call site.
 */

import { constants as fsConstants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { opendir, open, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isBuiltin } from 'node:module';
import { createInterface } from 'node:readline';
import type { StableSource } from '../session-port/source';
import type { SuStdioPeer, SuStdioReceipt } from '../su-session-stdio-peer';
import { processMonotonicClock } from '../process-monotonic-clock';
import type { Sql } from 'postgres';
import type { GatewayRequestTelemetrySnapshot } from '../inference-gateway/request-stage-telemetry';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { linuxPpidFromProcStat, linuxProcessIdentityFromStat } from '../process-identity';

import {
  DEFAULT_MIN_PROMPT_TOKENS,
  extractLaunchUsage,
  extractSampleContext,
  isLaunchCandidate,
  utcDay,
  createCarryTrialRecipe,
  inspectCarryNativePopulation,
  inspectCarryRequestPopulation,
  type CarryCanonicalUsageRow,
  type LaunchSample,
} from './launch-cost-metrics';

export type SkipReason =
  /** File was read to EOF and carried no `message.usage` row at all. */
  | 'no-usage-row'
  /** Usage rows existed but every one sat at or below the `minPromptTokens` floor. */
  | 'all-below-threshold'
  /** No qualifying sample and at least one incomplete usage row: size cannot be established. */
  | 'incomplete-usage'
  /** The only qualifying rows were sub-agent turns and sidechains were excluded. */
  | 'sidechain-only'
  /** A sample was found but excluded by a caller filter (day window, model, owner prefix). */
  | 'filtered-out'
  /** The measured row had no parseable timestamp, so it cannot be placed on a day. */
  | 'undatable'
  /** The file could not be read (permissions, disappeared mid-scan, IO error). */
  | 'unreadable';

export type SkippedFile = {
  filePath: string;
  reason: SkipReason;
  detail?: string;
};

export type ScanOptions = {
  /** Transcript root, e.g. `~/.papercusp/session-claude`. */
  root: string;
  minPromptTokens?: number;
  includeSidechains?: boolean;
  /** Inclusive UTC `YYYY-MM-DD` lower bound on the measured entry's day. */
  since?: string;
  /** Inclusive UTC `YYYY-MM-DD` upper bound on the measured entry's day. */
  until?: string;
  /** Keep only owners whose id starts with this (e.g. `su-` for superuser sessions). */
  ownerPrefix?: string;
  /** Keep only samples whose model contains this substring (e.g. `opus`). */
  modelContains?: string;
  /** Max files read in parallel. Defaults to 8. */
  concurrency?: number;
  /** Bound the walk depth below `root`. Defaults to 8; the real layout needs 3. */
  maxDepth?: number;
};

export type ScanReport = {
  root: string;
  samples: LaunchSample[];
  filesScanned: number;
  filesMeasured: number;
  skipped: SkippedFile[];
  /** Skip counts by reason — the census a reader needs before trusting a small sample set. */
  skippedByReason: Record<SkipReason, number>;
};

export interface CarrySourceSnapshot {
  threadId: string;
  turnId: string;
  filePath: string;
  snapshot: StableSource;
  forkedFromId: string | null;
  /** Native parent links in child-to-root order; file observations, not writer exclusion. */
  ancestors: Omit<CarrySourceSnapshot, 'ancestors'>[];
}

/** Complete rows in ONE SQL snapshot for the locally reconciled native scope.
 * Query the entire session/source-file population, including inherited usage,
 * null event keys and bad turn provenance. Never prefilter to expected turns,
 * successful requests or non-null usage. This is not ingestion completeness,
 * an authenticated charge census, or proof against later writer activity.
 */
export async function captureCarryCanonicalUsagePopulation(sql: Sql, input: {
  workspaceId: string;
  native: ReturnType<typeof inspectCarryNativePopulation>;
  maxRows?: number;
}) {
  const scope = structuredClone(input), maxRows = scope.maxRows ?? 10_000;
  if (!scope.workspaceId.trim() || scope.native.status !== 'closed-peer-reconciled' ||
    !scope.native.threads.length || scope.native.threads.some(t => !t.sourcePath) ||
    !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 100_000) {
    throw new Error('carry canonical query requires a reconciled native scope and bounded row limit');
  }
  const sessions = scope.native.threads.map(t => t.threadId), paths = scope.native.threads.map(t => t.sourcePath!);
  // count OVER and rows share a statement snapshot: a second count query could
  // observe different ingestion state. LIMIT only bounds transport/memory.
  const rows = await sql<Array<CarryCanonicalUsageRow & { population_count: string }>>`
    SELECT session_id, usage_event_key, usage_provenance, count(*) OVER ()::text AS population_count
    FROM harness_shared.agent_usage_samples
    WHERE workspace_id = ${scope.workspaceId} AND
      (session_id = ANY(${sql.array(sessions)}::text[]) OR run_id = ANY(${sql.array(sessions)}::text[])
       OR usage_provenance->>'sourceFile' = ANY(${sql.array(paths)}::text[]))
    ORDER BY id LIMIT ${maxRows + 1}`;
  const count = rows.length ? Number(rows[0].population_count) : 0;
  if (!Number.isSafeInteger(count) || count !== rows.length || count > maxRows ||
    rows.some(r => Number(r.population_count) !== count)) throw new Error('carry canonical query exceeded bound or lost rows');
  return { coverage: 'complete-selected-snapshot' as const,
    scope: { workspaceId: scope.workspaceId, sessionIds: sessions, sourcePaths: paths },
    rows: rows.map(r => ({ session_id: r.session_id, usage_event_key: r.usage_event_key, usage_provenance: r.usage_provenance })),
    ingestionCoverage: 'not-established' as const, chargeJoin: 'unavailable' as const, accountingComplete: false as const };
}

/** Controller closeout for captured peers sharing one isolated gateway. Derive
 * scope from the raw native receipts, read the canonical population here, and
 * reconcile it without accepting a caller's prefiltered usage array or turn
 * list. This function reads evidence only: it never dispatches inference,
 * ingests usage, grants admission or turns missing charges into zero cost.
 */
export async function captureCarryRequestEvidence(sql: Sql, input: {
  workspaceId: string;
  ownerId: string;
  native: Parameters<typeof inspectCarryNativePopulation>[0] | readonly Parameters<typeof inspectCarryNativePopulation>[0][];
  gateway: GatewayRequestTelemetrySnapshot;
  maxRows?: number;
}) {
  // Freeze before the first await, including the caller's raw capture. A live
  // callback appending to an array must not rewrite the evidence under a query.
  input = structuredClone(input);
  const captureSha256 = createHash('sha256').update(canonicalJson(input)).digest('hex');
  const captures: readonly Parameters<typeof inspectCarryNativePopulation>[0][] = Array.isArray(input.native)
    ? input.native : [input.native as Parameters<typeof inspectCarryNativePopulation>[0]];
  // Preparation must stop before freezing its source, so subsequent arms may
  // have different native processes. Validate EACH closed receipt stream before
  // combining its scope. Never concatenate streams or normalize their clocks.
  const inspected = captures.length > 0 && captures.length <= 128
    ? captures.map(capture => inspectCarryNativePopulation(capture)) : [];
  const nativeViolations = new Set(inspected.flatMap(result => result.violations));
  const nativeMissing = new Set(inspected.flatMap(result => result.missing));
  if (!inspected.length) nativeViolations.add('native-capture-set-bound');
  const unique = (values: unknown[], label: string) => {
    if (new Set(values).size !== values.length) nativeViolations.add(`duplicate-native-${label}-across-peers`);
  };
  unique(captures.map(capture => capture.state?.peerId), 'peer');
  unique(captures.flatMap(capture => capture.arms.map(arm => arm.armId)), 'arm');
  unique(inspected.flatMap(result => result.threads.map(thread => thread.threadId)), 'thread');
  unique(inspected.flatMap(result => result.threads.map(thread => thread.sourcePath)), 'source');
  const native: ReturnType<typeof inspectCarryNativePopulation> = {
    status: nativeViolations.size ? 'invalid' : nativeMissing.size ? 'incomplete' : 'closed-peer-reconciled',
    violations: [...nativeViolations], missing: [...nativeMissing],
    turns: inspected.flatMap(result => result.turns), threads: inspected.flatMap(result => result.threads),
    accountingComplete: false,
  };
  const base = { evidenceKind: 'observation-only' as const, captureSha256, native,
    admission: 'not-established' as const, accountingComplete: false as const };
  if (native.status !== 'closed-peer-reconciled') {
    return { ...base, status: native.status, canonical: null, population: null, inheritedUsage: [],
      violations: [...native.violations], missing: [...native.missing] };
  }
  const canonical = await captureCarryCanonicalUsagePopulation(sql, {
    workspaceId: input.workspaceId, native, maxRows: input.maxRows,
  });
  const usage: CarryCanonicalUsageRow[] = [], inheritedUsage: CarryCanonicalUsageRow[] = [];
  const violations = new Set<string>(), usageKeys = new Set<string>();
  for (const [index, row] of canonical.rows.entries()) {
    // Check the UNION before partitioning. A duplicate key in inherited rows
    // must not evade the existing current-turn reconciliation validator.
    if (!row.usage_event_key || !/^[a-f0-9]{64}$/.test(row.usage_event_key) || usageKeys.has(row.usage_event_key)) {
      violations.add(`invalid-or-duplicate-canonical-key:${index}`);
    }
    if (row.usage_event_key) usageKeys.add(row.usage_event_key);
    const inherited = native.threads.find(thread => thread.threadId === row.session_id)?.inheritedTurnIds;
    const turnId = row.usage_provenance?.turnId;
    if (typeof turnId === 'string' && inherited?.includes(turnId)) inheritedUsage.push(row);
    else usage.push(row); // Unknown provenance stays visible to the join.
  }
  const population = inspectCarryRequestPopulation({ ownerId: input.ownerId,
    turns: native.turns, gateway: input.gateway, usage });
  for (const violation of population.violations) violations.add(violation);
  // Keep the helper's supplied-input coverage labels intact. The companion
  // native/canonical receipts state the narrower coverage actually measured.
  return { ...base, status: violations.size ? 'invalid' as const : population.missing.length
    ? 'incomplete' as const : 'observations-linked' as const,
    canonical, population, inheritedUsage, violations: [...violations], missing: population.missing };
}

export interface CarryNativeConfigurationScope {
  threadId: string;
  cwd: string;
  servers: Array<{ name: string; tools: string[]; authStatus: string }>;
}

/** Read-only manifest component, not an authorization or serving-account
 * receipt. Hash the FULL native config/layers and complete MCP inventory,
 * retaining neither credentials nor raw config in the returned evidence.
 * The caller supplies a frozen allowlist and waits for native startup first.
 * A paginated inventory must finish without duplicate servers/cursor loops.
 */
export async function captureCarryNativeConfiguration(peer: SuStdioPeer, scope: CarryNativeConfigurationScope) {
  // The controller can continue running while RPC reads await; pin its supplied
  // scope now so a concurrent mutation cannot widen the declared allowlist.
  scope = structuredClone(scope);
  const record = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  if (!nonblank(scope.threadId) || !isAbsolute(scope.cwd) || !Array.isArray(scope.servers) ||
    new Set(scope.servers.map(server => server.name)).size !== scope.servers.length || scope.servers.some(server =>
      !nonblank(server.name) || !nonblank(server.authStatus) || !Array.isArray(server.tools) ||
      server.tools.some(tool => !nonblank(tool)) || new Set(server.tools).size !== server.tools.length)) {
    throw new Error('carry config requires exact thread/cwd and a unique server/tool allowlist');
  }
  const config = await peer.request({ method: 'config/read', params: { cwd: scope.cwd, includeLayers: true } });
  if (!record(config.config) || !Array.isArray(config.layers)) throw new Error('carry native config/layers unavailable');
  const servers = new Map<string, Record<string, unknown>>(), cursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; ; pageNumber++) {
    // Bound a malformed peer without accepting a truncated census. No retry.
    if (pageNumber >= 64) throw new Error('carry MCP inventory exceeded page bound');
    const page = await peer.request({ method: 'mcpServerStatus/list', params: {
      threadId: scope.threadId, detail: 'toolsAndAuthOnly', ...(cursor ? { cursor } : {}),
    } });
    if (!Array.isArray(page.data) || !Object.hasOwn(page, 'nextCursor')) throw new Error('carry MCP inventory incomplete');
    for (const value of page.data) {
      const server = record(value), tools = record(server?.tools);
      if (!server || !nonblank(server.name) || !tools || server.runtimeStatus !== 'connected' ||
        server.toolsError != null || servers.has(server.name)) throw new Error('carry MCP inventory invalid or unavailable');
      const allowed = scope.servers.find(expected => expected.name === server.name);
      if (!allowed || server.authStatus !== allowed.authStatus ||
        canonicalJson(Object.keys(tools).sort()) !== canonicalJson([...allowed.tools].sort()) ||
        Object.entries(tools).some(([name, tool]) => !record(tool) || record(tool)!.name !== name || !record(record(tool)!.inputSchema))) {
        throw new Error('carry MCP inventory differs from frozen allowlist');
      }
      servers.set(server.name, server);
    }
    if (page.nextCursor === null) break;
    if (!nonblank(page.nextCursor) || cursors.has(page.nextCursor)) throw new Error('carry MCP inventory cursor invalid or repeated');
    cursor = page.nextCursor; cursors.add(cursor);
  }
  if (servers.size !== scope.servers.length) throw new Error('carry MCP inventory missing required server');
  const ordered = [...servers.values()].sort((a, b) => String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0);
  const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
  return { threadId: scope.threadId, cwd: scope.cwd,
    configSha256: hash(config), toolInventorySha256: hash(ordered),
    servers: ordered.map(server => ({ name: String(server.name), authStatus: String(server.authStatus),
      tools: Object.keys(server.tools as object).sort() })) };
}

/** Recheck using the original scope; never silently refresh a changed manifest.
 * These discrete observations do not prove there was no transient change
 * between reads, or that the effective provider honored the native settings.
 */
export async function recheckCarryNativeConfiguration(
  peer: SuStdioPeer, snapshot: Awaited<ReturnType<typeof captureCarryNativeConfiguration>>,
): Promise<void> {
  const current = await captureCarryNativeConfiguration(peer, snapshot);
  if (canonicalJson(current) !== canonicalJson(snapshot)) throw new Error('carry native configuration changed after capture');
}

export interface CarryArtifactInput {
  /** Stable role/name in the predeclared recipe, not an inferred dependency. */
  id: string;
  filePath: string;
  maxBytes: number;
}

const CARRY_DEPENDENCY_ROLES = ['launcher', 'native-runtime', 'scripts', 'task', 'seed',
  'source', 'pricing', 'checker', 'instrument'] as const;

/** A declared dependency graph, not a discovered or authenticated census.
 * Every frozen artifact must have a node and be reachable from a named root.
 * Missing roles and unresolved runtime surfaces remain visible in the binding.
 * An empty residue does not prove the caller declared all real dependencies.
 */
export interface CarryDependencyScope {
  recipeSha256: string;
  roots: Array<{ role: typeof CARRY_DEPENDENCY_ROLES[number]; artifactIds: string[] }>;
  nodes: Array<{ artifactId: string; dependsOn: string[] }>;
  unresolved: string[];
}

function bindCarryDependencyScope(scope: CarryDependencyScope, artifacts: readonly CarryArtifactInput[]) {
  const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  const ids = new Set(artifacts.map(artifact => artifact.id));
  const references = (value: unknown): value is string[] => Array.isArray(value) && value.length <= ids.size &&
    value.every(id => typeof id === 'string' && ids.has(id)) && new Set(value).size === value.length;
  const recipe = createCarryTrialRecipe();
  if (!scope || scope.recipeSha256 !== recipe.sha256 || !Array.isArray(scope.roots) || !scope.roots.length ||
    scope.roots.length > CARRY_DEPENDENCY_ROLES.length || scope.roots.some(root => !root ||
      !CARRY_DEPENDENCY_ROLES.includes(root.role) || !references(root.artifactIds) || !root.artifactIds.length) ||
    new Set(scope.roots.map(root => root.role)).size !== scope.roots.length || !Array.isArray(scope.nodes) ||
    scope.nodes.length !== ids.size || scope.nodes.some(node => !node || !ids.has(node.artifactId) || !references(node.dependsOn)) ||
    new Set(scope.nodes.map(node => node.artifactId)).size !== ids.size || !Array.isArray(scope.unresolved) ||
    scope.unresolved.length > 64 || scope.unresolved.some(entry => !nonblank(entry) || entry.length > 2000) ||
    new Set(scope.unresolved).size !== scope.unresolved.length) {
    throw new Error('carry dependency scope requires the current recipe, unique roots and a complete declared artifact graph');
  }
  const nodes = new Map(scope.nodes.map(node => [node.artifactId, node.dependsOn]));
  const reachable = new Set<string>(), pending = scope.roots.flatMap(root => root.artifactIds);
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    pending.push(...nodes.get(id)!);
  }
  if (reachable.size !== ids.size) throw new Error('carry dependency scope contains artifacts unreachable from its roots');
  // Project only the public schema. Raw config, task contents and other caller
  // additions must not escape through this otherwise descriptive surface.
  const ordered = <T>(values: T[], key: (value: T) => string) => [...values].sort((a, b) =>
    key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  return { evidenceKind: 'declaration-only' as const, recipeSha256: recipe.sha256,
    roots: ordered(scope.roots.map(root => ({ role: root.role, artifactIds: [...root.artifactIds].sort() })), root => root.role),
    nodes: ordered(scope.nodes.map(node => ({ artifactId: node.artifactId, dependsOn: [...node.dependsOn].sort() })), node => node.artifactId),
    missingRoles: CARRY_DEPENDENCY_ROLES.filter(role => !scope.roots.some(root => root.role === role)),
    unresolved: [...scope.unresolved].sort() };
}

export interface CarryRuntimeSnapshot {
  schemaVersion: 1;
  evidenceKind: 'observation-only';
  rootPid: number;
  processes: Array<{ pid: number; parentPid: number; identity: string; executable: string; mappedFiles: string[];
    openFiles: Array<{ fd: number; filePath: string; device: string; inode: string; flags: string;
      access: 'read' | 'write' | 'read-write' | 'path' }> }>;
  /** Regular files observed through exe/maps/fd, not a complete dependency graph. */
  artifacts: CarryArtifactInput[];
  /** File-backed writable SHARED mappings (for example SQLite SHM), retained
   * in artifacts but explicitly unsuitable for a constant-byte run invariant.
   * Absence here does not prove immutability or exclude external writers. */
  writableSharedFiles: string[];
  /** Regular files opened for writing, including unmapped databases/WAL/logs.
   * This labels observed access, not actual writes or external-writer exclusion. */
  writableOpenFiles: string[];
}

/** Observe the live native process tree, including a wrapper's children and
 * file-backed mappings and regular open descriptors. Reuse the kernel identity parsers; PID alone is not an
 * identity. All thread children lists are read because a non-main thread can
 * spawn the native child. Missing/short/oversized proc data fails closed.
 *
 * This is deliberately NOT admission: maps do not enumerate JS modules, files
 * read then closed, future/transient children, or unloaded dependencies. Hashing
 * a mapped pathname binds its current on-disk bytes, not resident memory. The
 * controller still needs declared script/data dependencies and writer exclusion.
 */
export async function captureCarryRuntimeSnapshot(rootPid: number): Promise<CarryRuntimeSnapshot> {
  if (process.platform !== 'linux' || !Number.isSafeInteger(rootPid) || rootPid <= 0) {
    throw new Error('carry runtime requires a live Linux peer PID');
  }
  const readProc = async (path: string): Promise<string> => {
    const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    try {
      const maxBytes = 2 * 1024 * 1024, buffer = Buffer.alloc(64 * 1024), chunks: Buffer[] = [];
      let bytes = 0;
      while (bytes <= maxBytes) {
        const chunk = await file.read(buffer, 0, Math.min(buffer.length, maxBytes + 1 - bytes), bytes);
        if (!chunk.bytesRead) break;
        bytes += chunk.bytesRead;
        if (bytes > maxBytes) throw new Error('carry runtime proc record exceeds bound');
        chunks.push(Buffer.from(buffer.subarray(0, chunk.bytesRead)));
      }
      return Buffer.concat(chunks, bytes).toString('utf8');
    } finally { await file.close(); }
  };
  const boot = (await readProc('/proc/sys/kernel/random/boot_id')).trim();
  if (!/^[0-9a-f-]{36}$/i.test(boot)) throw new Error('carry runtime boot identity unavailable');
  const observe = async (): Promise<CarryRuntimeSnapshot> => {
    const processes: CarryRuntimeSnapshot['processes'] = [], files = new Set<string>(), writableSharedFiles = new Set<string>();
    const writableOpenFiles = new Set<string>();
    const queue = [{ pid: rootPid, parent: null as number | null }], seen = new Set<number>();
    while (queue.length) {
      const { pid, parent } = queue.shift()!;
      if (seen.has(pid) || seen.size >= 64) throw new Error('carry runtime process tree repeated or exceeds bound');
      seen.add(pid);
      const before = await readProc(`/proc/${pid}/stat`);
      const identity = linuxProcessIdentityFromStat(boot, before), parentPid = linuxPpidFromProcStat(before);
      if (!identity || parentPid === null || (parent !== null && parentPid !== parent)) {
        throw new Error('carry runtime process identity or parent changed');
      }
      const processName = before.slice(before.indexOf('(') + 1, before.lastIndexOf(')')).replace(/[^a-zA-Z0-9_. -]/g, '?').slice(0, 32);
      const executable = await readlink(`/proc/${pid}/exe`).catch(() => { throw new Error(`carry runtime process disappeared or executable unreadable: ${processName}`); });
      if (!isAbsolute(executable) || executable.endsWith(' (deleted)')) throw new Error('carry runtime executable unavailable');
      const mappedFiles = new Set<string>();
      const mappedIdentities = new Map<string, { ino: bigint; major: bigint; minor: bigint }>();
      const maps = await readProc(`/proc/${pid}/maps`);
      if (!maps.trim() || !maps.endsWith('\n')) throw new Error('carry runtime mappings incomplete');
      for (const line of maps.trimEnd().split('\n')) {
        const match = /^([0-9a-f]+)-([0-9a-f]+)\s+([r-][w-][x-][ps])\s+[0-9a-f]+\s+([0-9a-f]+):([0-9a-f]+)\s+(\d+)(?:\s+(.*))?$/i.exec(line);
        if (!match) throw new Error('carry runtime mapping invalid');
        const path = match[7];
        // Node 25 maps the kernel io_uring object under this pseudo-name.
        // It is neither a pathname nor an omitted disk dependency. Keep this
        // exact rather than swallowing arbitrary unrecognized/deleted files.
        if (!path || path.startsWith('[') || path === 'anon_inode:[io_uring]') continue;
        if (!isAbsolute(path) || path.endsWith(' (deleted)') || /\\[0-7]{3}/.test(path)) {
          throw new Error('carry runtime mapped pathname unavailable or ambiguous');
        }
        let identity = mappedIdentities.get(path);
        if (!identity) {
          const file = await stat(path, { bigint: true });
          if (!file.isFile()) throw new Error('carry runtime mapped file is non-regular');
          identity = { ino: file.ino, major: ((file.dev >> 8n) & 0xfffn) | ((file.dev >> 32n) & 0xfffff000n),
            minor: (file.dev & 0xffn) | ((file.dev >> 12n) & 0xffffff00n) };
          mappedIdentities.set(path, identity);
        }
        // A pathname can occur in several mappings. Validate every mapping's
        // identity before deduplicating; an older inode must not hide behind
        // a newer mapping with the same pathname.
        if (identity.ino !== BigInt(match[6]) || identity.major !== BigInt(`0x${match[4]}`) ||
          identity.minor !== BigInt(`0x${match[5]}`)) throw new Error('carry runtime mapped file replaced');
        mappedFiles.add(path);
        if (match[3][1] === 'w' && match[3][3] === 's') writableSharedFiles.add(path);
      }
      if (!mappedFiles.has(executable)) throw new Error('carry runtime executable absent from mappings');
      for (const path of mappedFiles) files.add(path);
      const descriptors = await readdir(`/proc/${pid}/fd`);
      if (descriptors.length > 4096 || descriptors.some(fd => !/^(0|[1-9]\d*)$/.test(fd) || !Number.isSafeInteger(Number(fd)))) {
        throw new Error('carry runtime descriptor population invalid or exceeds bound');
      }
      const openFiles: CarryRuntimeSnapshot['processes'][number]['openFiles'] = [];
      for (const fd of descriptors.sort((a, b) => Number(a) - Number(b))) {
        const fdPath = `/proc/${pid}/fd/${fd}`, path = await readlink(fdPath);
        if (/^(?:pipe|socket):\[\d+\]$/.test(path) || /^anon_inode:\[[^\]\n]+\]$/.test(path) || path === 'anon_inode:inotify') continue;
        if (!isAbsolute(path) || path.endsWith(' (deleted)')) {
          const kind = path.startsWith('anon_inode:') ? path.slice(0, 80).replace(/[^a-zA-Z0-9_:\[\]-]/g, '?')
            : isAbsolute(path) ? 'deleted-file' : 'non-absolute';
          throw new Error(`carry runtime open pathname unavailable or ambiguous (${kind}; fd ${fd})`);
        }
        const descriptor = await stat(fdPath, { bigint: true });
        // Directories and devices are not regular-file artifacts. Do not open
        // or read the descriptor itself: that could advance a live file offset.
        if (!descriptor.isFile()) continue;
        const named = await stat(path, { bigint: true });
        if (!named.isFile() || named.dev !== descriptor.dev || named.ino !== descriptor.ino) {
          throw new Error('carry runtime open file replaced');
        }
        const flagLines = (await readProc(`/proc/${pid}/fdinfo/${fd}`)).split('\n').filter(line => line.startsWith('flags:'));
        if (flagLines.length !== 1 || !/^flags:\s+[0-7]+$/.test(flagLines[0])) throw new Error('carry runtime descriptor flags unavailable');
        const flags = BigInt(`0o${flagLines[0].split(/\s+/)[1]}`), mode = flags & 3n;
        const access = (flags & 0o10000000n) !== 0n ? 'path' : mode === 0n ? 'read' : mode === 1n ? 'write' : mode === 2n ? 'read-write' : null;
        if (access === null) throw new Error('carry runtime descriptor access invalid');
        if (await readlink(fdPath) !== path) throw new Error('carry runtime descriptor changed during observation');
        openFiles.push({ fd: Number(fd), filePath: path, device: descriptor.dev.toString(), inode: descriptor.ino.toString(),
          flags: flags.toString(8), access });
        files.add(path);
        if (access === 'write' || access === 'read-write') writableOpenFiles.add(path);
      }
      if (files.size > 256) throw new Error('carry runtime artifact population exceeds bound');
      const threads = await readdir(`/proc/${pid}/task`).catch(() => { throw new Error(`carry runtime process disappeared or tasks unreadable: ${processName}`); });
      if (!threads.length || threads.length > 512 || threads.some(tid => !/^[1-9]\d*$/.test(tid))) {
        throw new Error('carry runtime thread population invalid or exceeds bound');
      }
      const children = new Set<number>();
      for (const tid of threads) {
        const text = (await readProc(`/proc/${pid}/task/${tid}/children`)).trim();
        if (!text) continue;
        for (const child of text.split(/\s+/)) {
          const childPid = Number(child);
          if (!/^[1-9]\d*$/.test(child) || !Number.isSafeInteger(childPid)) throw new Error('carry runtime child PID invalid');
          children.add(childPid);
          if (seen.size + children.size + queue.length > 64) throw new Error('carry runtime process tree exceeds bound');
        }
      }
      if (linuxProcessIdentityFromStat(boot, await readProc(`/proc/${pid}/stat`)) !== identity ||
        await readlink(`/proc/${pid}/exe`) !== executable) throw new Error('carry runtime process changed during observation');
      processes.push({ pid, parentPid, identity, executable, mappedFiles: [...mappedFiles].sort(), openFiles });
      queue.push(...[...children].sort((a, b) => a - b).map(child => ({ pid: child, parent: pid })));
    }
    return { schemaVersion: 1, evidenceKind: 'observation-only', rootPid,
      processes: processes.sort((a, b) => a.pid - b.pid),
      writableSharedFiles: [...writableSharedFiles].sort(),
      writableOpenFiles: [...writableOpenFiles].sort(),
      artifacts: [...files].sort().map(filePath => ({
        id: `runtime:${createHash('sha256').update(filePath).digest('hex')}`, filePath, maxBytes: 512 * 1024 * 1024,
      })) };
  };
  const before = await observe(), after = await observe();
  if ((await readProc('/proc/sys/kernel/random/boot_id')).trim() !== boot || canonicalJson(before) !== canonicalJson(after)) {
    throw new Error(`carry runtime tree or mappings changed during observation (${before.processes.map(p => basename(p.executable)).join(',')} -> ${after.processes.map(p => basename(p.executable)).join(',')})`);
  }
  return before;
}

/** Equal snapshots establish observations at the boundaries, never absence of
 * a transient child/mapping or an authenticated provider-send event. */
export async function recheckCarryRuntimeSnapshot(snapshot: CarryRuntimeSnapshot): Promise<void> {
  snapshot = structuredClone(snapshot);
  const current = await captureCarryRuntimeSnapshot(snapshot.rootPid);
  if (canonicalJson(current) !== canonicalJson(snapshot)) {
    throw new Error(`carry runtime changed after capture (${snapshot.processes.map(p => basename(p.executable)).join(',')} -> ${current.processes.map(p => basename(p.executable)).join(',')})`);
  }
}

/** Freeze the declared file set alongside its native configuration observation.
 * Reuses the existing canonical serializer and configuration capture. This is
 * an artifact binding, NOT a complete dependency census, approval, provider
 * identity, output-limit receipt, or permission to send a charged request.
 * Callers must enumerate the binary, task/recipe, checker, pricing, launcher,
 * instruments and their dependencies before freezing the controller manifest.
 * File contents (including private configuration) never leave this function.
 */
export async function captureCarryArtifactManifest(input: {
  protocolRef: string;
  artifacts: readonly CarryArtifactInput[];
  configuration: Awaited<ReturnType<typeof captureCarryNativeConfiguration>>;
  dependencyScope?: CarryDependencyScope;
  /** Opt-in AST observation of these frozen script artifacts. Unbound relative
   * candidates, external packages and computed imports remain explicit. This
   * does not authenticate a loader or discover files outside the declared set. */
  scriptArtifactIds?: string[];
  /** Walk relative source candidates transitively from these selected scripts.
   * Discovered files are frozen separately from the caller's declared graph.
   * Package exports, runtime loaders and data reads remain outside this walk. */
  relativeScriptRoots?: string[];
}) {
  input = structuredClone(input);
  const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  if (!nonblank(input.protocolRef) || !Array.isArray(input.artifacts) || !input.artifacts.length ||
    input.artifacts.length > 256 || new Set(input.artifacts.map(a => a.id)).size !== input.artifacts.length ||
    input.artifacts.some(a => !nonblank(a.id) || !isAbsolute(a.filePath) ||
      !Number.isSafeInteger(a.maxBytes) || a.maxBytes <= 0)) {
    throw new Error('carry manifest requires a protocol and a bounded unique artifact set');
  }
  const dependencyScope = input.dependencyScope === undefined ? undefined :
    bindCarryDependencyScope(input.dependencyScope, input.artifacts);
  const scriptIds = new Set(input.scriptArtifactIds ?? []);
  if (input.scriptArtifactIds !== undefined && (!Array.isArray(input.scriptArtifactIds) || !scriptIds.size ||
    scriptIds.size !== input.scriptArtifactIds.length || [...scriptIds].some(id =>
      !input.artifacts.some(artifact => artifact.id === id)))) {
    throw new Error('carry script census requires unique declared script artifact ids');
  }
  const scriptSources = new Map<string, string>();
  const relativeRoots = input.relativeScriptRoots;
  if (relativeRoots !== undefined && (!Array.isArray(relativeRoots) || !relativeRoots.length ||
    new Set(relativeRoots).size !== relativeRoots.length || relativeRoots.some(id => !scriptIds.has(id)))) {
    throw new Error('carry relative census requires unique selected script roots');
  }
  let scriptBytes = 0;
  const observed = input.configuration;
  if (!observed || !Array.isArray(observed.servers) || observed.servers.some(server =>
    !nonblank(server.name) || !nonblank(server.authStatus) || !Array.isArray(server.tools) ||
    server.tools.some(tool => !nonblank(tool)) || new Set(server.tools).size !== server.tools.length) ||
    new Set(observed.servers.map(server => server.name)).size !== observed.servers.length) {
    throw new Error('carry manifest requires a complete native configuration scope');
  }
  // Copy only the observation schema; never propagate caller-added raw config
  // or artifact contents into the serializable evidence artifact.
  const config = { threadId: observed.threadId, cwd: observed.cwd, configSha256: observed.configSha256,
    toolInventorySha256: observed.toolInventorySha256,
    servers: observed.servers.map(({ name, authStatus, tools }) => ({ name, authStatus, tools })) };
  if (!config || !nonblank(config.threadId) || !isAbsolute(config.cwd) ||
    !/^[a-f0-9]{64}$/.test(config.configSha256) || !/^[a-f0-9]{64}$/.test(config.toolInventorySha256)) {
    throw new Error('carry manifest requires a native configuration observation');
  }
  const scriptFormat = (path: string) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path);
  const captureArtifact = async (artifact: CarryArtifactInput, retainSource: boolean) => {
    // Legitimate executable links are resolved and bound, so later retargeting
    // fails even if both destinations contain identical bytes. O_NONBLOCK keeps
    // a substituted FIFO from hanging before the regular-file check.
    const resolvedPath = await realpath(artifact.filePath);
    const fh = await open(resolvedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    try {
      const before = await fh.stat({ bigint: true });
      if (!before.isFile() || before.size <= 0n || before.size > BigInt(artifact.maxBytes)) {
        throw new Error(`carry artifact ${artifact.id} is empty, non-regular or oversized`);
      }
      const identity = (s: typeof before) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String);
      const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
      const sourceChunks: Buffer[] = [];
      let bytes = 0;
      while (true) {
        const read = await fh.read(buffer, 0, Math.min(buffer.length, artifact.maxBytes - bytes + 1), bytes);
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
        if (bytes > artifact.maxBytes) throw new Error(`carry artifact ${artifact.id} exceeded its byte bound`);
        hash.update(buffer.subarray(0, read.bytesRead));
        if (retainSource) {
          scriptBytes += read.bytesRead;
          if (bytes > 4 * 1024 * 1024 || scriptBytes > 32 * 1024 * 1024) {
            throw new Error('carry script census exceeds source-byte bound');
          }
          sourceChunks.push(Buffer.from(buffer.subarray(0, read.bytesRead)));
        }
      }
      const after = await fh.stat({ bigint: true });
      if (BigInt(bytes) !== before.size || canonicalJson(identity(before)) !== canonicalJson(identity(after)) ||
        await realpath(artifact.filePath) !== resolvedPath ||
        canonicalJson(identity(await stat(resolvedPath, { bigint: true }))) !== canonicalJson(identity(before))) {
        throw new Error(`carry artifact ${artifact.id} changed during capture`);
      }
      if (retainSource) scriptSources.set(artifact.id, Buffer.concat(sourceChunks).toString('utf8'));
      return { id: artifact.id, filePath: artifact.filePath, maxBytes: artifact.maxBytes,
        resolvedPath, bytes, sha256: hash.digest('hex'), identity: identity(before) };
    } finally { await fh.close(); }
  };
  const artifacts: Array<Awaited<ReturnType<typeof captureArtifact>>> = [];
  for (const artifact of [...input.artifacts].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    artifacts.push(await captureArtifact(artifact, scriptIds.has(artifact.id)));
  }
  let scriptCensus;
  if (scriptIds.size) {
    const ts = await import('typescript');
    const { extractImports, findFile } = await import('../../../../scripts/check-transitive-boundary.mjs');
    const discoveredArtifacts: typeof artifacts = [];
    const allArtifacts = [...artifacts];
    const parsedImports = new Map<string, { imports: ReturnType<typeof extractImports>;
      computed: Array<{ kind: string; line: number }> }>();
    const parseArtifact = (artifact: typeof artifacts[number]) => {
      const cached = parsedImports.get(artifact.id);
      if (cached) return cached;
      if (!scriptFormat(artifact.resolvedPath)) {
        throw new Error(`carry script census requires a supported script format (${artifact.id})`);
      }
      const parsed = ts.createSourceFile(artifact.resolvedPath, scriptSources.get(artifact.id)!, ts.ScriptTarget.Latest, true);
      if ((parsed as typeof parsed & { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length) {
        throw new Error(`carry script census cannot parse artifact ${artifact.id}`);
      }
      const computed: Array<{ kind: string; line: number }> = [];
      const result = { imports: extractImports(parsed, { onUnresolved: site => computed.push(site) }), computed };
      parsedImports.set(artifact.id, result);
      return result;
    };
    const visited = new Set<string>(), pending = [...(relativeRoots ?? [])].sort();
    for (let i = 0; i < pending.length; i++) {
      const artifactId = pending[i];
      if (visited.has(artifactId)) continue;
      visited.add(artifactId);
      const artifact = allArtifacts.find(artifact => artifact.id === artifactId)!;
      for (const site of parseArtifact(artifact).imports) {
        if (site.typeOnly || !site.spec.startsWith('.')) continue;
        const candidate = findFile(resolve(dirname(artifact.resolvedPath), site.spec));
        if (!candidate) continue;
        const resolvedPath = await realpath(candidate);
        const targets = allArtifacts.filter(artifact => artifact.resolvedPath === resolvedPath);
        if (targets.length > 1) continue; // Ambiguity stays visible in the sites below.
        let target = targets[0];
        if (!target) {
          if (allArtifacts.length >= 256) throw new Error('carry relative census exceeds artifact bound');
          const id = `relative:${createHash('sha256').update(resolvedPath).digest('hex')}`;
          if (allArtifacts.some(artifact => artifact.id === id)) throw new Error('carry relative artifact id collision');
          target = await captureArtifact({ id, filePath: candidate, maxBytes: 4 * 1024 * 1024 }, scriptFormat(resolvedPath));
          if (target.resolvedPath !== resolvedPath) throw new Error('carry relative candidate changed during capture');
          discoveredArtifacts.push(target); allArtifacts.push(target);
        }
        if (!scriptFormat(target.resolvedPath)) continue;
        if (!scriptSources.has(target.id)) {
          const reread = await captureArtifact(target, true);
          if (canonicalJson(reread) !== canonicalJson(target)) throw new Error('carry relative artifact changed during capture');
        }
        scriptIds.add(target.id); pending.push(target.id);
      }
    }
    const sites: Array<{ artifactId: string; line: number; kind: string; disposition: string;
      specifierSha256?: string; targetArtifactId?: string }> = [];
    for (const artifactId of [...scriptIds].sort()) {
      const artifact = allArtifacts.find(artifact => artifact.id === artifactId)!;
      // Node normally resolves an entry symlink before loading its module. An
      // extensionless CLI link is still a script; use its frozen real path for
      // syntax and relative candidates, retaining the link in artifact identity.
      const { imports, computed } = parseArtifact(artifact);
      for (const site of computed) sites.push({ artifactId, ...site, disposition: 'computed-specifier' });
      for (const site of imports) {
        const base = { artifactId, line: site.line, kind: site.kind,
          specifierSha256: createHash('sha256').update(site.spec).digest('hex') };
        if (site.typeOnly) { sites.push({ ...base, disposition: 'erased-type' }); continue; }
        if (isBuiltin(site.spec)) { sites.push({ ...base, disposition: 'node-builtin' }); continue; }
        if (!site.spec.startsWith('.')) { sites.push({ ...base, disposition: 'external-module' }); continue; }
        // Reuse the boundary checker's relative source candidate resolution.
        // This is NOT the native loader: export conditions, hooks, aliases,
        // indirect loaders and files read as data still need separate evidence.
        const candidate = findFile(resolve(dirname(artifact.resolvedPath), site.spec));
        const resolved = candidate ? await realpath(candidate) : null;
        const targets = resolved ? allArtifacts.filter(artifact => artifact.resolvedPath === resolved) : [];
        const target = targets.length === 1 ? targets[0] : null;
        sites.push({ ...base, disposition: !candidate ? 'unresolved-relative' : targets.length > 1 ? 'ambiguous-relative' : !target ? 'unbound-relative'
          : scriptIds.has(target.id) ? 'bound-script-candidate' : 'unscanned-artifact-candidate',
          ...(target ? { targetArtifactId: target.id } : {}) });
      }
      if (sites.length > 4096) throw new Error('carry script census exceeds import-site bound');
    }
    sites.sort((a, b) => a.artifactId.localeCompare(b.artifactId) || a.line - b.line || a.kind.localeCompare(b.kind));
    scriptCensus = { evidenceKind: 'selected-static-import-sites' as const,
      scriptArtifactIds: [...input.scriptArtifactIds!].sort(), sites, runtimeClosureEstablished: false as const,
      ...(relativeRoots ? { relativeTraversal: { rootArtifactIds: [...relativeRoots].sort(),
        scannedArtifactIds: [...visited].sort(),
        artifacts: discoveredArtifacts.sort((a, b) => a.id.localeCompare(b.id)) } } : {}) };
  }
  const body = { schemaVersion: 1 as const, evidenceKind: 'observation-only' as const,
    protocolRef: input.protocolRef, configuration: config, artifacts,
    ...(dependencyScope ? { dependencyScope } : {}), ...(scriptCensus ? { scriptCensus } : {}) };
  return { ...body, sha256: createHash('sha256').update(canonicalJson(body)).digest('hex') };
}

/** Re-read the same declared population; never update a frozen manifest to
 * accommodate drift. Like native configuration snapshots, equal observations
 * cannot rule out transient changes between reads; execution still requires
 * source/writer exclusion and independent admission checks.
 */
export async function recheckCarryArtifactManifest(
  manifest: Awaited<ReturnType<typeof captureCarryArtifactManifest>>,
  peer: SuStdioPeer,
): Promise<void> {
  manifest = structuredClone(manifest);
  const { sha256, ...body } = manifest;
  if (createHash('sha256').update(canonicalJson(body)).digest('hex') !== sha256) {
    throw new Error('carry artifact manifest binding is invalid');
  }
  await recheckCarryNativeConfiguration(peer, manifest.configuration);
  const current = await captureCarryArtifactManifest({ protocolRef: manifest.protocolRef,
    configuration: manifest.configuration,
    dependencyScope: manifest.dependencyScope,
    scriptArtifactIds: manifest.scriptCensus?.scriptArtifactIds,
    relativeScriptRoots: manifest.scriptCensus?.relativeTraversal?.rootArtifactIds,
    artifacts: manifest.artifacts.map(({ id, filePath, maxBytes }) => ({ id, filePath, maxBytes })) });
  if (current.sha256 !== sha256) {
    const changed: Array<{ id: string; fields: string[]; before: { sha256: string; identity: string[] };
      after: { sha256: string; identity: string[] } }> = [];
    let changedCount = 0;
    for (const [index, artifact] of current.artifacts.entries()) {
      const frozen = manifest.artifacts[index];
      const fields = (['filePath', 'maxBytes', 'resolvedPath', 'bytes', 'sha256', 'identity'] as const)
        .filter(field => canonicalJson(artifact[field]) !== canonicalJson(frozen[field]));
      if (!fields.length) continue;
      changedCount++;
      if (changed.length < 12) changed.push({ id: artifact.id, fields,
        before: { sha256: frozen.sha256, identity: frozen.identity },
        after: { sha256: artifact.sha256, identity: artifact.identity } });
    }
    const changedIds = changed.map(artifact => artifact.id);
    throw new Error(`carry artifacts changed after manifest freeze (${changedIds.join(',') || 'manifest metadata'}; ` +
      `changedCount=${changedCount}; observations=${JSON.stringify(changed)})`);
  }
}

/** Capture an owned native preparation peer at its last completed turn. The
 * native process is stopped before reading its rollout and native parent chain;
 * the existing bounded JSONL reader supplies exact bytes/hashes. This does not copy or
 * rewrite native history, nor prove serving-account identity or tool authority.
 * The returned cut is a snapshot, not a promise that the pathname stays frozen:
 * recheckCarrySourceSnapshot must pass before each comparison arm.
 */
export async function captureCompletedCarrySource(
  peer: SuStdioPeer,
  threadId: string,
  turnId: string,
  maxBytes?: number,
): Promise<CarrySourceSnapshot> {
  const record = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!threadId.trim() || !turnId.trim()) throw new Error('carry source requires exact native identity');
  // Ordinary launch scanning does not need the archive module's DB/zstd
  // dependencies; load the shared reader only for this source-capture path.
  const { MAX_SESSION_PORT_SOURCE_BYTES, readStableLiveJsonl } = await import('../session-port/source');
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_SESSION_PORT_SOURCE_BYTES)) {
    throw new Error('carry source byte cap must be positive and within the existing source limit');
  }
  const chain: Array<{ threadId: string; turnId: string; filePath: string; forkedFromId: string | null }> = [];
  let nextThreadId: string | null = threadId;
  while (nextThreadId !== null) {
    if (chain.length >= 32 || chain.some(source => source.threadId === nextThreadId)) {
      throw new Error('carry source parent chain is cyclic or exceeds the depth bound');
    }
    const response = await peer.request({ method: 'thread/read', params: { threadId: nextThreadId, includeTurns: true } });
    const thread = record(response.thread), turns = thread?.turns;
    const last = Array.isArray(turns) ? record(turns.at(-1)) : null;
    const expectedTurn = chain.length === 0 ? turnId : last?.id;
    if (thread?.id !== nextThreadId || record(thread.status)?.type !== 'idle' ||
      typeof expectedTurn !== 'string' || !expectedTurn.trim() ||
      !Array.isArray(turns) || turns.filter(turn => record(turn)?.id === expectedTurn).length !== 1 || last?.id !== expectedTurn ||
      last.status !== 'completed' || last.error != null || !Array.isArray(last.items) ||
      (last.itemsView !== undefined && last.itemsView !== 'full')) {
      throw new Error('carry source requires a full, idle, completed final native turn');
    }
    if (typeof thread.path !== 'string' || !isAbsolute(thread.path) || chain.some(source => source.filePath === thread.path)) {
      throw new Error('carry source native path is unavailable or duplicated');
    }
    const parent = thread.forkedFromId ?? null;
    if (parent !== null && (typeof parent !== 'string' || !parent.trim())) throw new Error('carry source native parent is malformed');
    chain.push({ threadId: nextThreadId, turnId: expectedTurn, filePath: thread.path, forkedFromId: parent as string | null });
    nextThreadId = parent as string | null;
  }
  // A successful thread/read is not writer exclusion. Both tracked teardown
  // and its process-exit receipt must finish before the source file is opened.
  await peer.close();
  await peer.done;
  const captured: CarrySourceSnapshot['ancestors'] = [];
  let remainingBytes = maxBytes ?? MAX_SESSION_PORT_SOURCE_BYTES;
  // Chain reads are sequential to enforce one aggregate byte budget. Every
  // member is still rechecked before use; this does not make the reads atomic.
  for (const source of chain) {
    if (remainingBytes <= 0) throw new Error('carry source parent chain exceeds byte cap');
    const snapshot = await readStableLiveJsonl(source.filePath, remainingBytes);
    remainingBytes -= snapshot.highWaterBytes;
    if (!snapshot.completeBytes || snapshot.completeBytes !== snapshot.highWaterBytes) {
      throw new Error('carry source is empty, short, or ends with a partial record');
    }
    let headerCount = 0, lastBoundary: Record<string, unknown> | null = null;
    let offset = 0, records = 0;
    while (offset < snapshot.bytes.length) {
      const end = snapshot.bytes.indexOf(0x0a, offset);
      const line = snapshot.bytes.subarray(offset, end).toString('utf8');
      offset = end + 1;
      const entry = record(JSON.parse(line)), payload = record(entry?.payload);
      if (!entry || !payload) throw new Error('carry source contains a malformed native record');
      if (records++ === 0 && entry.type !== 'session_meta') throw new Error('carry source lacks its native header');
      if (entry.type === 'session_meta') {
        headerCount++;
        if (payload.id !== source.threadId) throw new Error('carry source native header identity mismatch');
        if ((payload.forked_from_id ?? null) !== source.forkedFromId) throw new Error('carry source native parent identity mismatch');
      }
      if (entry.type === 'event_msg' && ['task_started', 'task_complete', 'turn_completed', 'turn_aborted'].includes(String(payload.type))) {
        lastBoundary = payload;
      }
    }
    if (headerCount !== 1 || !lastBoundary || !['task_complete', 'turn_completed'].includes(String(lastBoundary.type)) ||
      lastBoundary.turn_id !== source.turnId || lastBoundary.error != null ||
      ['error', 'failed', 'failure'].includes(String(lastBoundary.status ?? ''))) {
      throw new Error('carry source terminal record does not match the completed native cut');
    }
    captured.push({ ...source, snapshot });
  }
  return { ...captured[0], ancestors: captured.slice(1) };
}

/** Source drift is a stop condition, never a reason to silently select a new
 * cutoff or regenerate preparation after comparison results are visible. */
export async function recheckCarrySourceSnapshot(source: CarrySourceSnapshot): Promise<void> {
  const { readStableLiveJsonl } = await import('../session-port/source');
  const chain = [source, ...source.ancestors];
  if (chain.length > 32 || new Set(chain.map(member => member.threadId)).size !== chain.length ||
    chain.some((member, index) => member.forkedFromId !== (chain[index + 1]?.threadId ?? null))) {
    throw new Error('carry source parent chain no longer matches its frozen cut');
  }
  for (const member of chain) {
    const current = await readStableLiveJsonl(member.filePath, member.snapshot.highWaterBytes);
    if (current.completeBytes !== current.highWaterBytes || current.completeBytes !== member.snapshot.completeBytes ||
      current.sha256 !== member.snapshot.sha256) throw new Error('carry source changed after its frozen cut');
  }
}

/** Observe a frozen predecessor's last native request input and the remaining
 * D017 dispatch window. Reuse the ingestion parser's request deduplication and
 * context generations; cumulative session totals and file size are not history
 * size. The native count describes the LAST REQUEST, not a tokenization of the
 * next fork. These local receipts do not authenticate provider usage or authorize
 * dispatch. A later HTTP write must still be checked against this same window.
 */
export async function captureCarrySourcePreflight(input: {
  source: CarrySourceSnapshot;
  sourceId: string;
  receipts: readonly SuStdioReceipt[];
}) {
  const recipe = createCarryTrialRecipe();
  const stratum = recipe.sources.find(source => source.id === input.sourceId);
  if (!stratum) throw new Error('carry source preflight requires a registered stratum');
  const source = input.source, bytes = Buffer.from(source.snapshot.bytes);
  const receipts = structuredClone(input.receipts);
  if (createHash('sha256').update(bytes).digest('hex') !== source.snapshot.sha256) {
    throw new Error('carry source preflight bytes do not match the frozen cut');
  }
  await recheckCarrySourceSnapshot(source);
  const { parseCodexChunk, UNKNOWN_CODEX_MODEL } = await import('../interactive-usage/ingest-adapters');
  const parsed = parseCodexChunk(bytes.toString('utf8'));
  const usage = parsed.events?.at(-1);
  const missing: string[] = [];
  const sourceRef = `codex:${source.threadId}/${source.turnId}@${source.snapshot.sha256}`;
  const validUsage = usage?.turnId === source.turnId && parsed.parserState?.turnId === source.turnId &&
    usage.contextGeneration === parsed.parserState?.contextGeneration &&
    usage.model !== UNKNOWN_CODEX_MODEL && typeof usage.inputTotalTokens === 'number' &&
    Number.isSafeInteger(usage.inputTotalTokens) && usage.inputTotalTokens >= 0;
  if (!validUsage) missing.push('last-completed-request-input-unavailable');
  const history = validUsage ? {
    inputTokens: usage!.inputTotalTokens!, model: usage!.model,
    evidenceRef: `${sourceRef}#usage-byte=${usage!.relativeOffset}`,
    usageSourceId: usage!.sourceId,
    inBand: usage!.inputTotalTokens! >= stratum.history.minInputTokens && usage!.inputTotalTokens! <= stratum.history.maxInputTokens,
  } : null;
  const completions = receipts.filter(receipt => receipt.phase === 'received' && receipt.frame.method === 'turn/completed' &&
    (receipt.frame.params as { threadId?: unknown } | undefined)?.threadId === source.threadId &&
    ((receipt.frame.params as { turn?: { id?: unknown } } | undefined)?.turn)?.id === source.turnId);
  const completion = completions.length === 1 ? completions[0] : null;
  const turn = (completion?.frame.params as { turn?: { status?: unknown; error?: unknown } } | undefined)?.turn;
  // Sample here, after disk validation. Never let a caller backdate now, reuse a
  // prior process clock, or substitute thread/read/poll time for completion.
  const now = processMonotonicClock.now();
  const validCompletion = completion && completion.clockId === processMonotonicClock.id && completion.peerId.trim() &&
    Number.isSafeInteger(completion.sequence) && completion.sequence > 0 &&
    Number.isFinite(completion.atMs) && completion.atMs >= 0 && completion.atMs <= now &&
    turn?.status === 'completed' && turn.error == null;
  if (!validCompletion) missing.push('same-clock-completion-receipt-unavailable');
  const idle = validCompletion ? {
    clockId: completion.clockId, completedAtMs: completion.atMs, observedAtMs: now,
    evidenceRef: `native:${completion.peerId}:${completion.sequence}`,
    ageMs: now - completion.atMs,
    opensAtMs: completion.atMs + stratum.idle.minMs,
    closesAtMs: completion.atMs + stratum.idle.maxMs,
    closeInclusive: stratum.idle.maxInclusive,
    phase: now - completion.atMs < stratum.idle.minMs ? 'too-early' as const
      : (stratum.idle.maxInclusive ? now - completion.atMs > stratum.idle.maxMs : now - completion.atMs >= stratum.idle.maxMs)
        ? 'expired' as const : 'window-open' as const,
  } : null;
  return { recipeSha256: recipe.sha256, sourceId: stratum.id, sourceRef,
    evidenceKind: 'local-native-source-preflight' as const, dispatchAuthorized: false as const,
    history, idle, missing };
}

/**
 * Recursively collect `*.jsonl` paths under `root`.
 *
 * Does NOT follow directory symlinks. The repo guide's `find -L` incident (a symlink DAG through
 * `node_modules/@papercusp/*` that ran 32h and consumed 1.86 TB of swap) is the reason: a
 * transcript tree has no legitimate need to traverse a link, and an unbounded symlink walk is
 * indistinguishable from a hang. `maxDepth` is a second, independent bound.
 */
export async function collectTranscriptFiles(root: string, maxDepth = 8): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      return;
    }
    for await (const entry of handle) {
      // isSymbolicLink() is checked BEFORE isDirectory(): a symlink to a directory reports
      // isDirectory() === false from opendir's dirent, but being explicit keeps the intent
      // readable and survives a future switch to a stat-following API.
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        found.push(full);
      }
    }
  }
  await walk(root, 0);
  found.sort();
  return found;
}

/**
 * Derive the owner id from a transcript path: the first segment below `root`.
 * Layout is `<root>/<ownerId>/projects/<munged-cwd>/<sessionId>.jsonl`.
 */
export function ownerIdFromPath(root: string, filePath: string): string {
  const rel = relative(root, filePath);
  const first = rel.split(sep)[0];
  return first && first !== '..' ? first : 'unknown';
}

type FileOutcome = { sample: LaunchSample } | { skip: SkippedFile };

/**
 * Read ONE transcript and return its launch sample, or a typed skip.
 *
 * Exported so a caller can measure a single session without walking a tree, and so the streaming
 * guarantee can be tested in isolation.
 */
export async function measureTranscriptFile(
  filePath: string,
  options: ScanOptions,
): Promise<FileOutcome> {
  const minPromptTokens = options.minPromptTokens ?? DEFAULT_MIN_PROMPT_TOKENS;
  const includeSidechains = options.includeSidechains ?? false;
  const ownerId = ownerIdFromPath(options.root, filePath);

  if (options.ownerPrefix && !ownerId.startsWith(options.ownerPrefix)) {
    return { skip: { filePath, reason: 'filtered-out', detail: `owner ${ownerId}` } };
  }

  let sawUsageRow = false;
  let sawBelowThreshold = false;
  let sawIncompleteUsage = false;
  let sawSidechainOnly = false;
  let found: { entry: unknown; lineNumber: number; bytesBefore: number } | null = null;
  let readError: string | null = null;

  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  let bytesConsumed = 0;

  try {
    for await (const line of reader) {
      lineNumber += 1;
      // +1 for the newline the reader stripped. Approximate for multi-byte content, which is
      // fine: this figure is evidence for "the usage row sits deep in the file", not an exact
      // byte offset anyone indexes with.
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
      if (!line.trim()) {
        bytesConsumed += lineBytes;
        continue;
      }
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        bytesConsumed += lineBytes;
        continue;
      }
      const usage = extractLaunchUsage(entry);
      if (!usage) {
        bytesConsumed += lineBytes;
        continue;
      }
      sawUsageRow = true;
      if (usage.usageCountsComplete !== true) sawIncompleteUsage = true;
      if (usage.totalPromptTokens <= minPromptTokens) {
        sawBelowThreshold = true;
        bytesConsumed += lineBytes;
        continue;
      }
      if (!isLaunchCandidate(entry, usage, { minPromptTokens, includeSidechains })) {
        // Passed the token floor, so the only remaining rejection is the sidechain rule.
        sawSidechainOnly = true;
        bytesConsumed += lineBytes;
        continue;
      }
      found = { entry, lineNumber, bytesBefore: bytesConsumed };
      break;
    }
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error);
  } finally {
    // Close both ends. `reader.close()` alone leaves the underlying stream open, and a
    // partially-drained readline can still emit one more buffered line to a stale listener —
    // the exact behaviour that made an earlier ad-hoc probe print two "first" rows.
    reader.close();
    stream.destroy();
  }

  if (readError) return { skip: { filePath, reason: 'unreadable', detail: readError } };
  if (!found) {
    if (sawSidechainOnly) return { skip: { filePath, reason: 'sidechain-only' } };
    if (sawIncompleteUsage) return { skip: { filePath, reason: 'incomplete-usage' } };
    if (sawBelowThreshold) return { skip: { filePath, reason: 'all-below-threshold' } };
    if (sawUsageRow) return { skip: { filePath, reason: 'all-below-threshold' } };
    return { skip: { filePath, reason: 'no-usage-row' } };
  }

  const usage = extractLaunchUsage(found.entry)!;
  const context = extractSampleContext(found.entry);
  const day = utcDay(context.timestamp);
  if (!day) {
    return { skip: { filePath, reason: 'undatable', detail: String(context.timestamp) } };
  }
  if (options.since && day < options.since) {
    return { skip: { filePath, reason: 'filtered-out', detail: `day ${day} < since` } };
  }
  if (options.until && day > options.until) {
    return { skip: { filePath, reason: 'filtered-out', detail: `day ${day} > until` } };
  }
  if (options.modelContains && !(context.model ?? '').includes(options.modelContains)) {
    return { skip: { filePath, reason: 'filtered-out', detail: `model ${context.model}` } };
  }

  return {
    sample: {
      ...usage,
      ownerId,
      sessionId: context.sessionId ?? basename(filePath, '.jsonl'),
      filePath,
      timestamp: context.timestamp!,
      day,
      model: context.model,
      entrypoint: context.entrypoint,
      cliVersion: context.cliVersion,
      cwd: context.cwd,
      lineNumber: found.lineNumber,
      bytesBeforeSample: found.bytesBefore,
    },
  };
}

const EMPTY_SKIP_CENSUS: Record<SkipReason, number> = {
  'no-usage-row': 0,
  'all-below-threshold': 0,
  'incomplete-usage': 0,
  'sidechain-only': 0,
  'filtered-out': 0,
  undatable: 0,
  unreadable: 0,
};

/** Walk `root`, measure every transcript, and return samples plus a full skip census. */
export async function scanLaunchTranscripts(options: ScanOptions): Promise<ScanReport> {
  const files = await collectTranscriptFiles(options.root, options.maxDepth ?? 8);
  const concurrency = Math.max(1, options.concurrency ?? 8);
  const samples: LaunchSample[] = [];
  const skipped: SkippedFile[] = [];

  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= files.length) return;
      const outcome = await measureTranscriptFile(files[index]!, options);
      if ('sample' in outcome) samples.push(outcome.sample);
      else skipped.push(outcome.skip);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()));

  samples.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  const skippedByReason = { ...EMPTY_SKIP_CENSUS };
  for (const skip of skipped) skippedByReason[skip.reason] += 1;

  return {
    root: options.root,
    samples,
    filesScanned: files.length,
    filesMeasured: samples.length,
    skipped,
    skippedByReason,
  };
}
