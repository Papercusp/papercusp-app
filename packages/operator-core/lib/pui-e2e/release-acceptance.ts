/**
 * Installed-TUI release acceptance (pui-first-party-public-release P-012 / D-018).
 *
 * The REQUIRED matrix is derived from apps/tui/PUBLIC_RELEASE_UX.md: its
 * platform × backend table and its capability replacement map. The only
 * curated data is apps/tui/release/acceptance-matrix.json, which says which
 * acceptance tags prove each backend cell and capability row. The two must
 * name exactly the same rows, or every candidate is refused.
 *
 * Evidence is harvested by release-acceptance-reporter.ts from the PTY
 * suites' `PUI_*_ACCEPTANCE <json>` lines, each paired with the final state of
 * the test that printed it. A row counts for a candidate only when its test
 * passed, its module drove the PRODUCTION operator, and the binary it drove is
 * the one installed from that candidate's archive (same sha256, inside the
 * install root). Anything else — a fake operator, a cargo build, a skipped or
 * failed test — is lower-level coverage, never release evidence.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM package: the release CLI runs this under tsx, where `__dirname` is undefined.
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const UX_CONTRACT = path.join(REPO_ROOT, 'apps/tui/PUBLIC_RELEASE_UX.md');
export const ACCEPTANCE_MATRIX = path.join(REPO_ROOT, 'apps/tui/release/acceptance-matrix.json');

/** Printed once per suite by the code that started its operator. */
export const HARNESS_TAG = 'PUI_ACCEPTANCE_HARNESS';
const ACCEPTANCE_TAG = /^(?:PUI|AUTO_BAR)_[A-Z0-9_]+_ACCEPTANCE$/;
// A record starts at a line beginning `<TAG> {`. Vitest batches console writes
// that land close together into ONE log, so a chunk can hold several records.
const RECORD_START = /^([A-Z][A-Z0-9_]*) (?=\{)/gm;

export interface RequiredMatrix {
  backends: string[];
  platforms: Array<{ platform: string; cells: Record<string, string> }>;
  capabilities: string[];
}

export interface Exclusion {
  capability: string;
  /** Omitted = every platform. */
  platforms?: string[];
  reason: string;
  /** `owner:<name>` — an agent cannot approve a release exclusion. */
  approvedBy: string;
  /** `<plan-slug>#D-NNN`, the decision that records the approval. */
  decisionRef: string;
}

export interface AcceptanceMatrixFile {
  schemaVersion: 1;
  platforms: Record<string, { artifact: string }>;
  backends: Record<string, { engine: string; journeys: string[] }>;
  capabilities: Record<string, string[]>;
  exclusions: Exclusion[];
}

export interface HarnessStamp {
  operator: 'production' | 'fake';
  binary?: string;
  binarySha256?: string;
}

export interface EvidenceRow {
  tag: string;
  test: string;
  module: string;
  state: 'passed' | 'failed' | 'skipped' | 'pending';
  harness: HarnessStamp | null;
  /** A PUBLIC_RELEASE_UX.md platform label, stamped by the release runner. */
  platform: string | null;
  /** `scripted`, or the real engine the leg ran (claude/codex/omp). */
  engine: string;
  model: string | null;
  binary: string | null;
  binaryRealpath: string | null;
  binarySha256: string | null;
  /** The journey's own correlation: its chat and the operator routes it hit. */
  correlation: { chatId: string | null; traffic: unknown[] } | null;
  /** The test printed this tag but its JSON did not parse. */
  unparsed?: true;
}

export interface Candidate {
  sourceSha: string;
  artifact: string;
  archive: string;
  archiveSha256: string;
  installRoot: string;
  installedBinarySha256: string;
  advertise: Array<{ platform: string; backend: string }>;
}

export interface CellVerdict {
  platform: string;
  backend: string;
  required: boolean;
  status: 'advertised' | 'refused' | 'not-advertised';
  missing: string[];
  note?: string;
}

export interface CapabilityVerdict {
  capability: string;
  platform: string;
  status: 'pass' | 'missing' | 'excluded';
  missing: string[];
  exclusion?: Exclusion;
}

export interface Verdict {
  ok: boolean;
  candidate: Candidate;
  refusals: string[];
  cells: CellVerdict[];
  capabilities: CapabilityVerdict[];
  evidence: JudgedEvidence[];
}

export interface JudgedEvidence {
  tag: string;
  test: string;
  module: string;
  platform: string | null;
  engine: string;
  qualifies: boolean;
  reason: string | null;
  correlation: EvidenceRow['correlation'];
}

function sectionTable(markdown: string, heading: string): string[][] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) throw new Error(`PUBLIC_RELEASE_UX.md has no '## ${heading}' section`);
  const rows: string[][] = [];
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('## '); i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) {
      if (rows.length) break;
      continue;
    }
    const cells = line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    rows.push(cells);
  }
  if (rows.length < 2) throw new Error(`'## ${heading}' has no table rows`);
  return rows;
}

/** The release commitments, read from the UX contract rather than copied. */
export function parseRequiredMatrix(markdown: string): RequiredMatrix {
  const [header, ...body] = sectionTable(markdown, 'Release platform and backend matrix');
  if (header[0] !== 'Public target' || header[1] !== 'Packaging/runtime' || header.length < 3) {
    throw new Error(`unexpected platform matrix header: ${header.join(' | ')}`);
  }
  const backends = header.slice(2);
  const platforms = body.map((cells) => ({
    platform: cells[0],
    cells: Object.fromEntries(backends.map((backend, index) => [backend, cells[index + 2] ?? ''])),
  }));
  const [capabilityHeader, ...capabilityBody] = sectionTable(markdown, 'Capability replacement interaction map');
  if (capabilityHeader[0] !== 'Required capability') {
    throw new Error(`unexpected capability map header: ${capabilityHeader.join(' | ')}`);
  }
  return { backends, platforms, capabilities: capabilityBody.map((cells) => cells[0]) };
}

export function loadRequiredMatrix(file = UX_CONTRACT): RequiredMatrix {
  return parseRequiredMatrix(readFileSync(file, 'utf8'));
}

export function loadAcceptanceMatrix(file = ACCEPTANCE_MATRIX): AcceptanceMatrixFile {
  return JSON.parse(readFileSync(file, 'utf8')) as AcceptanceMatrixFile;
}

/**
 * Every `<TAG> <json>` record in one console chunk. A record's JSON runs to the
 * next record start (or the end), so a pretty-printed payload still parses. A
 * record whose JSON does not parse is returned with `payload: null`.
 */
function taggedRecords(content: string): Array<{ tag: string; payload: Record<string, unknown> | null }> {
  const starts = [...content.matchAll(RECORD_START)];
  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : content.length;
    const body = content.slice(start.index + start[0].length, end).trim();
    try {
      const payload = JSON.parse(body) as unknown;
      return { tag: start[1], payload: payload && typeof payload === 'object' ? payload as Record<string, unknown> : null };
    } catch {
      return { tag: start[1], payload: null };
    }
  });
}

/**
 * The acceptance records in one console chunk. `unparsed` names tags whose JSON
 * did not parse, so a caller can report them instead of losing them silently.
 */
export function parseAcceptanceLines(content: string): {
  lines: Array<{ tag: string; payload: Record<string, unknown> }>;
  unparsed: string[];
} {
  const lines: Array<{ tag: string; payload: Record<string, unknown> }> = [];
  const unparsed: string[] = [];
  for (const record of taggedRecords(content)) {
    if (!ACCEPTANCE_TAG.test(record.tag)) continue;
    if (record.payload) lines.push({ tag: record.tag, payload: record.payload });
    else unparsed.push(record.tag);
  }
  return { lines, unparsed };
}

/** The last harness stamp in one console chunk, if any. */
export function parseHarnessLine(content: string): HarnessStamp | null {
  let stamp: HarnessStamp | null = null;
  for (const record of taggedRecords(content)) {
    if (record.tag !== HARNESS_TAG || !record.payload) continue;
    const candidate = record.payload as unknown as HarnessStamp;
    if (candidate.operator === 'production' || candidate.operator === 'fake') stamp = candidate;
  }
  return stamp;
}

/** The curated mapping must name exactly the doc's rows, in both directions. */
export function matrixDrift(required: RequiredMatrix, matrix: AcceptanceMatrixFile): string[] {
  const drift: string[] = [];
  const compare = (what: string, doc: string[], mapped: string[]) => {
    for (const name of doc) if (!mapped.includes(name)) drift.push(`${what} '${name}' is in PUBLIC_RELEASE_UX.md but not in acceptance-matrix.json`);
    for (const name of mapped) if (!doc.includes(name)) drift.push(`${what} '${name}' is in acceptance-matrix.json but not in PUBLIC_RELEASE_UX.md`);
  };
  compare('platform', required.platforms.map((row) => row.platform), Object.keys(matrix.platforms));
  compare('backend', required.backends, Object.keys(matrix.backends));
  compare('capability', required.capabilities, Object.keys(matrix.capabilities));
  return drift;
}

function exclusionProblem(exclusion: Exclusion, required: RequiredMatrix): string | null {
  if (!required.capabilities.includes(exclusion.capability)) return `names no required capability row`;
  if (!/^owner:[^\s:]+$/.test(exclusion.approvedBy ?? '')) return `is not owner-approved (approvedBy '${exclusion.approvedBy ?? ''}')`;
  if (!/^[a-z0-9][a-z0-9-]*#D-\d{3,}$/.test(exclusion.decisionRef ?? '')) return `cites no plan decision (decisionRef '${exclusion.decisionRef ?? ''}')`;
  if (!exclusion.reason?.trim()) return 'gives no reason';
  return null;
}

/** Why a harvested row cannot stand for this candidate, or null when it can. */
export function disqualification(row: EvidenceRow, candidate: Candidate): string | null {
  if (row.unparsed) return 'its acceptance line did not parse';
  if (row.state !== 'passed') return `its test ${row.state === 'pending' ? 'did not finish' : row.state}`;
  if (!row.harness) return 'its suite declared no acceptance harness';
  if (row.harness.operator !== 'production') return `its suite drove a ${row.harness.operator} operator`;
  if (row.binarySha256 !== candidate.installedBinarySha256) return 'it drove a different binary than this candidate installs';
  const root = candidate.installRoot.endsWith(path.sep) ? candidate.installRoot : candidate.installRoot + path.sep;
  if (!row.binaryRealpath?.startsWith(root)) return 'it did not drive the installed artifact';
  return null;
}

export function judgeEvidence(rows: EvidenceRow[], candidate: Candidate): JudgedEvidence[] {
  return rows.map((row) => {
    const reason = disqualification(row, candidate);
    return { tag: row.tag, test: row.test, module: row.module, platform: row.platform, engine: row.engine,
      qualifies: reason === null, reason, correlation: row.correlation };
  });
}

export function checkReleaseAcceptance(
  required: RequiredMatrix,
  matrix: AcceptanceMatrixFile,
  candidate: Candidate,
  rows: EvidenceRow[],
  legs?: ReadonlyArray<{ engine: string; status: number | null }>,
): Verdict {
  const refusals = matrixDrift(required, matrix);
  // A passing tagged journey cannot hide a failure elsewhere in its test
  // process. Null is an interrupted/timed-out process, never a successful leg.
  if (legs?.length === 0) refusals.push('no installed-product acceptance legs ran');
  for (const leg of legs ?? []) {
    if (leg.status !== 0) refusals.push(`installed-product ${leg.engine} test leg did not exit successfully (status ${leg.status})`);
  }
  const qualifying = rows.filter((row) => disqualification(row, candidate) === null);
  const proven = (tag: string, platform: string, engine?: string) =>
    qualifying.some((row) => row.tag === tag && row.platform === platform && (engine === undefined || row.engine === engine));

  const exclusions: Exclusion[] = [];
  for (const exclusion of matrix.exclusions ?? []) {
    const problem = exclusionProblem(exclusion, required);
    if (problem) refusals.push(`exclusion for '${exclusion.capability}' ${problem}`);
    else exclusions.push(exclusion);
  }

  const advertised = new Set(candidate.advertise.map((cell) => `${cell.platform}\u0000${cell.backend}`));
  if (advertised.size === 0) refusals.push('the candidate advertises no platform/backend combination');
  for (const cell of candidate.advertise) {
    const row = required.platforms.find((entry) => entry.platform === cell.platform);
    if (!row || !required.backends.includes(cell.backend)) {
      refusals.push(`advertised ${cell.platform} × ${cell.backend} is not a combination in PUBLIC_RELEASE_UX.md`);
    } else if (matrix.platforms[cell.platform]?.artifact !== candidate.artifact) {
      refusals.push(`advertised ${cell.platform} × ${cell.backend} ships the ${matrix.platforms[cell.platform]?.artifact ?? 'unknown'} artifact, not this ${candidate.artifact} candidate`);
    }
  }

  const cells: CellVerdict[] = [];
  for (const { platform, cells: requirement } of required.platforms) {
    for (const backend of required.backends) {
      const spec = matrix.backends[backend];
      const journeys = spec?.journeys ?? [];
      const missing = spec ? journeys.filter((tag) => !proven(tag, platform, spec.engine)) : ['(no journeys mapped)'];
      if (spec && journeys.length === 0) missing.push('(no journeys mapped)');
      const verdict: CellVerdict = { platform, backend, required: requirement[backend] === 'Required', status: 'not-advertised', missing };
      if (advertised.has(`${platform}\u0000${backend}`)) {
        verdict.status = missing.length ? 'refused' : 'advertised';
        for (const tag of missing) {
          refusals.push(`${platform} × ${backend} is advertised without installed-product evidence for ${tag}`);
        }
      } else if (verdict.required) {
        verdict.note = missing.length
          ? 'Required, not advertised: no installed-product evidence for this candidate'
          : 'Required, not advertised: evidence exists but the candidate did not declare it';
      }
      cells.push(verdict);
    }
  }

  const capabilities: CapabilityVerdict[] = [];
  const advertisedPlatforms = [...new Set(candidate.advertise.map((cell) => cell.platform))];
  for (const platform of advertisedPlatforms) {
    for (const capability of required.capabilities) {
      const exclusion = exclusions.find((entry) =>
        entry.capability === capability && (!entry.platforms || entry.platforms.includes(platform)));
      if (exclusion) {
        capabilities.push({ capability, platform, status: 'excluded', missing: [], exclusion });
        continue;
      }
      const tags = matrix.capabilities[capability] ?? [];
      const missing = tags.length ? tags.filter((tag) => !proven(tag, platform)) : ['(no installed-product test mapped)'];
      capabilities.push({ capability, platform, status: missing.length ? 'missing' : 'pass', missing });
      for (const tag of missing) {
        refusals.push(`required capability '${capability}' on ${platform} has no installed-product evidence for ${tag}`);
      }
    }
  }

  return {
    ok: refusals.length === 0,
    candidate,
    refusals,
    cells,
    capabilities,
    evidence: judgeEvidence(rows, candidate),
  };
}

/** The PUBLIC_RELEASE_UX.md platform label for the machine this runs on. */
export function detectPlatform(
  os = process.platform,
  arch = process.arch,
  procVersion = (() => { try { return readFileSync('/proc/version', 'utf8'); } catch { return ''; } })(),
): string | null {
  if (os === 'linux' && arch === 'x64') return /microsoft/i.test(procVersion) ? 'Windows 11 via WSL2 x86_64' : 'Linux x86_64';
  if (os === 'darwin' && arch === 'arm64') return 'macOS arm64';
  if (os === 'darwin' && arch === 'x64') return 'macOS x86_64';
  return null;
}
