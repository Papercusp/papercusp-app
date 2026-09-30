/**
 * P-021 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03, D-007 #1): the REPAIR
 * MANIFEST — one row per signature leg of a frozen candidate, naming what the leg is about,
 * which repo paths it names, whether those paths have been admitted onto the frozen lineage
 * yet, and the exact `release:repair-queue { op:'admit', paths:[…] }` command that would.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────────────────
 * D-007 rules that knowing is not left to prose: an agent looking at a red gate must be able to
 * read, off the gate-red work-item itself, (a) which legs hold the candidate, (b) which files
 * each leg is about, (c) whether a fix for that leg has ALREADY reached the judged lineage, and
 * (d) the one command that lands a fix there. Every one of those was previously reconstructed
 * by hand from the queue row, the GATE_HELD_BY line and the admission ledger — three surfaces
 * with three vintages, which is the exact spread the owner brief exists to end.
 *
 * ── SHAPE ────────────────────────────────────────────────────────────────────────────────
 * Pure derivation. `buildRepairManifest` reads ONLY the queue row (signature, legs, admissions)
 * plus optional per-leg evidence the caller already holds (a lint leg's output tail, or
 * explicitly supplied subject paths). It performs no I/O, so the same function renders the
 * manifest on the work-item, in `dev:pipeline_position`, in the owner brief and on /admin/git,
 * and those four cannot disagree. `withRepairManifest` is what the ONE production write path
 * (`writeFrozenCandidateRepairQueue`) calls, so the manifest is rebuilt on every persisted
 * queue change — a freeze, an admission, a re-measurement — and reports whether the SIGNATURE
 * changed, which is the trigger D-007 names for re-writing the work-item.
 *
 * Status per leg, in priority order:
 *   green-at-<sha>      the leg's lifecycle state (repair-leg-lifecycle.ts) is `fixed` — a
 *                       MEASUREMENT at a later head moved it out of the failing set;
 *   admitted-in-#N@sha  no green measurement yet, but an admission on the ledger carries at
 *                       least one of the leg's subject paths — the fix is ON the lineage and
 *                       awaiting re-verification;
 *   red-at-candidate    neither.
 *
 * Subject paths are EVIDENCE, never a guess: a `test-file` leg's id IS its path; a lint /
 * post-suite leg's paths come only from the output it reported (or from paths the caller
 * supplies); a `seed` leg (the whole-gate recipe) names no path. A leg whose paths are unknown
 * carries `subjectSource:'none'` and NO admit command — rendering a fabricated command would be
 * worse than rendering none.
 */
import {
  normalizeRepoPath,
  type FrozenCandidateRepairQueue,
  type FrozenRepairAdmission,
  type RepairSignatureEntry,
  type RepairSignatureKind,
} from './frozen-candidate-repair-queue';
import type { FrozenRepairLegState } from './repair-leg-lifecycle';

export const REPAIR_MANIFEST_SCHEMA_VERSION = 1 as const;
/** Row cap — mirrors FROZEN_REPAIR_LEG_CAP's order of magnitude; the signature is already capped upstream. */
export const REPAIR_MANIFEST_ROW_CAP = 64;
/** Subject-path cap per leg: a lint leg reporting hundreds of files is rendered as the first N + a count. */
export const REPAIR_MANIFEST_SUBJECT_PATH_CAP = 40;

export type RepairManifestStatus =
  | { kind: 'red-at-candidate' }
  | { kind: 'admitted'; admission: number; toRepairHead: string; paths: string[] }
  | { kind: 'green'; head: string };

export type RepairManifestSubjectSource = 'leg-id' | 'leg-output' | 'supplied' | 'none';

export interface RepairManifestClaim {
  actor: string;
  atMs: number;
}

export interface RepairManifestRow {
  legId: string;
  kind: RepairSignatureKind;
  workspace?: string;
  recipe: string;
  /** Repo-relative paths the leg names; the admission allowlist a fixer would pass. */
  subjectPaths: string[];
  /** How many subject paths the cap hid (0 when none). */
  subjectPathsTruncated: number;
  subjectSource: RepairManifestSubjectSource;
  status: RepairManifestStatus;
  /** `red-at-candidate` | `admitted-in-#N@<sha8>` | `green-at-<sha8>` — the D-007 vocabulary. */
  statusLabel: string;
  /** The exact command that admits this leg's subject paths; null when no path is known. */
  admitCommand: string | null;
  /** Claiming a leg claims its paths (D-007): who holds this leg, if anyone. */
  claim: RepairManifestClaim | null;
}

export interface RepairManifest {
  schemaVersion: typeof REPAIR_MANIFEST_SCHEMA_VERSION;
  candidate: string;
  repairHead: string;
  /** Deterministic over the signature's (kind,id) pairs — equal fingerprints ⇒ same legs. */
  signatureFingerprint: string;
  builtAtMs: number;
  rows: RepairManifestRow[];
  rowsTruncated: number;
}

export interface BuildRepairManifestInput {
  queue: Pick<FrozenCandidateRepairQueue, 'candidate' | 'repairHead' | 'signature' | 'legs' | 'admissions'>;
  nowMs: number;
  /** Per-leg output tails (e.g. `gate_health.repairTickLegs[].outputTail`) to mine for reported paths. */
  legOutputs?: Readonly<Record<string, string | undefined>>;
  /** Per-leg subject paths the caller KNOWS (wins over every other source). */
  subjectPaths?: Readonly<Record<string, readonly string[] | undefined>>;
  /**
   * npm-workspace NAME → repo-relative DIRECTORY (`npm-workspace-dirs.ts`). Passed IN rather
   * than read here so this function stays a pure derivation.
   *
   * WI-10002500: without it, paths mined from a workspace-task leg's output stay
   * WORKSPACE-relative (`lib/foo.test.ts`, as vitest prints them) while the admission ledger is
   * REPO-relative (`packages/operator-core/lib/foo.test.ts`). The two can never compare equal,
   * so `admissionCovering` missed every time and EVERY workspace-task leg reported
   * `red-at-candidate` for the life of the queue — including legs whose fix had already landed.
   */
  workspaceDirs?: Readonly<Record<string, string>>;
  /** The previous manifest, so leg claims survive a rebuild. */
  previous?: RepairManifest | null;
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

export function repairSignatureFingerprint(signature: readonly Pick<RepairSignatureEntry, 'kind' | 'id'>[]): string {
  return signature
    .map((entry) => `${entry.kind}:${entry.id}`)
    .sort()
    .join('\n');
}

/**
 * Paths a gate leg REPORTED, mined from its output tail. Deliberately conservative: a token must
 * look like a repo-relative path with at least one directory and an extension, and vendored /
 * escaping tokens are dropped. Missing a path costs a fixer one manual `paths:[…]`; inventing one
 * would put a wrong file on the admission allowlist, which is the failure D-008 exists to stop.
 */
export function extractSubjectPathsFromLegOutput(output: string | undefined | null): string[] {
  if (!output) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  // Trailing lookahead admits `(`: tsc's `file.ts(44,1): error` shape sits beside `file.ts:12:3`.
  const re = /(?:^|[\s"'`(\[,])((?:[A-Za-z0-9_@.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})(?=$|[\s:"'`()\],;])/gm;
  for (const m of output.matchAll(re)) {
    const raw = m[1];
    if (!raw) continue;
    if (raw.includes('..') || raw.startsWith('/') || raw.startsWith('node_modules/') || raw.includes('/node_modules/')) continue;
    if (raw.startsWith('.papercusp/') || raw.startsWith('tmp/')) continue;
    const normalized = normalizeRepoPath(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * Lift a path MINED from a leg's output into repo-relative form (WI-10002500).
 *
 * A workspace task runs with its own package directory as cwd, so its runner prints paths
 * relative to THAT (`lib/foo.test.ts`), while everything the queue ledgers is relative to the
 * repo root. Joining the two spaces silently never matches, which is indistinguishable from
 * "nobody has fixed this leg" — the reading that kept a 14h freeze looking uniform.
 *
 * Conservative by construction: it only ever PREFIXES, and only when the path is not already
 * repo-relative. `workspaceDir` unknown ⇒ returned unchanged, so a caller that supplies no map
 * gets exactly the previous behaviour. Deliberately NOT a suffix match against the ledger: that
 * would mark leg A admitted because a DIFFERENT workspace admitted its own `lib/index.ts`, and a
 * false `admitted-in-#N` tells the next agent to stop repairing a leg nobody has touched.
 */
function toRepoRelativeLegPath(
  minedPath: string,
  workspaceDir: string | undefined,
  knownWorkspaceDirs: readonly string[],
): string {
  if (!workspaceDir) return minedPath;
  if (minedPath === workspaceDir || minedPath.startsWith(`${workspaceDir}/`)) return minedPath;
  // Some legs (lint, tsc) already print repo-relative paths, and a leg's output can name a file
  // in a SIBLING workspace. Either way the path is already in the ledger's space — leave it.
  for (const dir of knownWorkspaceDirs) {
    if (minedPath.startsWith(`${dir}/`)) return minedPath;
  }
  return `${workspaceDir}/${minedPath}`;
}

function resolveSubjectPaths(
  entry: RepairSignatureEntry,
  input: BuildRepairManifestInput,
): { paths: string[]; source: RepairManifestSubjectSource } {
  const supplied = input.subjectPaths?.[entry.id];
  if (supplied && supplied.length > 0) {
    const normalized = Array.from(new Set(supplied.map((p) => normalizeRepoPath(p)).filter((p) => p.length > 0)));
    if (normalized.length > 0) return { paths: normalized, source: 'supplied' };
  }
  if (entry.kind === 'test-file') {
    const p = normalizeRepoPath(entry.id);
    if (p) return { paths: [p], source: 'leg-id' };
  }
  if (entry.kind === 'seed') return { paths: [], source: 'none' };
  const mined = extractSubjectPathsFromLegOutput(input.legOutputs?.[entry.id]);
  if (mined.length > 0) {
    // WI-10002500: mined paths are in the LEG's path space; the admission ledger and the
    // `admitCommand` this manifest renders are both repo-relative. Lift them once, here, so both
    // consumers are fixed by the same line.
    const dirs = input.workspaceDirs;
    const workspaceDir = entry.workspace && dirs ? dirs[entry.workspace] : undefined;
    const knownDirs = dirs ? Object.values(dirs) : [];
    const lifted = Array.from(
      new Set(mined.map((p) => toRepoRelativeLegPath(p, workspaceDir, knownDirs))),
    );
    return { paths: lifted, source: 'leg-output' };
  }
  return { paths: [], source: 'none' };
}

function admissionCovering(
  admissions: readonly FrozenRepairAdmission[] | undefined,
  subjectPaths: readonly string[],
): { index: number; admission: FrozenRepairAdmission; paths: string[] } | null {
  if (!admissions || admissions.length === 0 || subjectPaths.length === 0) return null;
  const subjects = new Set(subjectPaths.map((p) => normalizeRepoPath(p)));
  // Newest admission wins: the ledger keeps the NEWEST entries when capped, and the latest
  // admission carrying a path is the one whose repairHead the re-verification will judge.
  for (let i = admissions.length - 1; i >= 0; i -= 1) {
    const admission = admissions[i]!;
    const hit = (admission.paths ?? []).filter((p) => subjects.has(normalizeRepoPath(p)));
    if (hit.length > 0) return { index: i + 1, admission, paths: hit };
  }
  return null;
}

function legState(
  legs: readonly FrozenRepairLegState[] | undefined,
  legId: string,
): FrozenRepairLegState | null {
  if (!legs) return null;
  return legs.find((l) => l.id === legId) ?? null;
}

export function renderAdmitCommand(paths: readonly string[]): string {
  return `release:repair-queue { op: 'admit', paths: ${JSON.stringify([...paths])} }`;
}

export function buildRepairManifest(input: BuildRepairManifestInput): RepairManifest {
  const { queue } = input;
  const signature = queue.signature ?? [];
  const previousRows = new Map<string, RepairManifestRow>();
  if (input.previous && input.previous.candidate === queue.candidate) {
    for (const row of input.previous.rows) previousRows.set(row.legId, row);
  }
  const rows: RepairManifestRow[] = [];
  const capped = signature.slice(0, REPAIR_MANIFEST_ROW_CAP);
  for (const entry of capped) {
    const subject = resolveSubjectPaths(entry, input);
    const visible = subject.paths.slice(0, REPAIR_MANIFEST_SUBJECT_PATH_CAP);
    const state = legState(queue.legs, entry.id);
    let status: RepairManifestStatus;
    if (state && state.state === 'fixed') {
      status = { kind: 'green', head: state.resolvedHead ?? state.lastMeasuredHead };
    } else {
      const covering = admissionCovering(queue.admissions, subject.paths);
      status = covering
        ? {
            kind: 'admitted',
            admission: covering.index,
            toRepairHead: covering.admission.toRepairHead,
            paths: covering.paths,
          }
        : { kind: 'red-at-candidate' };
    }
    const statusLabel =
      status.kind === 'green'
        ? `green-at-${shortSha(status.head)}`
        : status.kind === 'admitted'
          ? `admitted-in-#${status.admission}@${shortSha(status.toRepairHead)}`
          : 'red-at-candidate';
    const prior = previousRows.get(entry.id);
    rows.push({
      legId: entry.id,
      kind: entry.kind,
      ...(entry.workspace ? { workspace: entry.workspace } : {}),
      recipe: entry.recipe,
      subjectPaths: visible,
      subjectPathsTruncated: Math.max(0, subject.paths.length - visible.length),
      subjectSource: subject.source,
      status,
      statusLabel,
      admitCommand: subject.paths.length > 0 ? renderAdmitCommand(subject.paths) : null,
      claim: prior?.claim ?? null,
    });
  }
  return {
    schemaVersion: REPAIR_MANIFEST_SCHEMA_VERSION,
    candidate: queue.candidate,
    repairHead: queue.repairHead,
    signatureFingerprint: repairSignatureFingerprint(signature),
    builtAtMs: input.nowMs,
    rows,
    rowsTruncated: Math.max(0, signature.length - capped.length),
  };
}

export interface WithRepairManifestResult<Q extends BuildRepairManifestInput['queue']> {
  queue: Q & { manifest: RepairManifest };
  manifest: RepairManifest;
  /** The leg set differs from the previous manifest's (or there was none): the D-007 re-write trigger. */
  signatureChanged: boolean;
  /** Any leg's status label moved (an admission landed, a leg went green). */
  statusChanged: boolean;
}

/**
 * Rebuild the manifest for a queue row about to be persisted, carrying claims from the row's
 * previous manifest. Called from the ONE production write path so it cannot go stale.
 */
export function withRepairManifest<Q extends BuildRepairManifestInput['queue'] & { manifest?: RepairManifest | null }>(
  queue: Q,
  nowMs: number,
  extras: Pick<BuildRepairManifestInput, 'legOutputs' | 'subjectPaths' | 'workspaceDirs'> = {},
): WithRepairManifestResult<Q> {
  const previous = queue.manifest ?? null;
  const manifest = buildRepairManifest({ queue, nowMs, previous, ...extras });
  const signatureChanged =
    !previous ||
    previous.candidate !== manifest.candidate ||
    previous.signatureFingerprint !== manifest.signatureFingerprint;
  const prevLabels = new Map((previous?.rows ?? []).map((r) => [r.legId, r.statusLabel] as const));
  const statusChanged =
    signatureChanged || manifest.rows.some((r) => prevLabels.get(r.legId) !== r.statusLabel);
  return { queue: { ...queue, manifest }, manifest, signatureChanged, statusChanged };
}

export type ClaimRepairManifestLegResult =
  | { ok: true; manifest: RepairManifest; row: RepairManifestRow; paths: string[]; released?: boolean }
  | { ok: false; reason: 'no-such-leg'; legIds: string[] }
  | { ok: false; reason: 'held-by-other'; holder: RepairManifestClaim; row: RepairManifestRow }
  | { ok: false; reason: 'already-green'; row: RepairManifestRow };

/**
 * Claiming a leg claims its paths (D-007). Idempotent for the same actor; refuses a leg another
 * actor holds (coordinate, do not contest — the same rule as work-item claims). `release:true`
 * gives the leg up; only the holder may release.
 */
export function claimRepairManifestLeg(
  manifest: RepairManifest,
  input: { legId: string; actor: string; atMs: number; release?: boolean },
): ClaimRepairManifestLegResult {
  const idx = manifest.rows.findIndex((r) => r.legId === input.legId);
  if (idx < 0) return { ok: false, reason: 'no-such-leg', legIds: manifest.rows.map((r) => r.legId) };
  const row = manifest.rows[idx]!;
  if (input.release) {
    if (row.claim && row.claim.actor !== input.actor) {
      return { ok: false, reason: 'held-by-other', holder: row.claim, row };
    }
    const nextRow: RepairManifestRow = { ...row, claim: null };
    const rows = manifest.rows.slice();
    rows[idx] = nextRow;
    return { ok: true, manifest: { ...manifest, rows }, row: nextRow, paths: row.subjectPaths, released: true };
  }
  if (row.status.kind === 'green') return { ok: false, reason: 'already-green', row };
  if (row.claim && row.claim.actor !== input.actor) {
    return { ok: false, reason: 'held-by-other', holder: row.claim, row };
  }
  const nextRow: RepairManifestRow = {
    ...row,
    claim: row.claim ?? { actor: input.actor, atMs: input.atMs },
  };
  const rows = manifest.rows.slice();
  rows[idx] = nextRow;
  return { ok: true, manifest: { ...manifest, rows }, row: nextRow, paths: row.subjectPaths };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseStatus(raw: unknown): RepairManifestStatus | null {
  if (!isRecord(raw) || typeof raw.kind !== 'string') return null;
  if (raw.kind === 'red-at-candidate') return { kind: 'red-at-candidate' };
  if (raw.kind === 'green' && typeof raw.head === 'string') return { kind: 'green', head: raw.head };
  if (
    raw.kind === 'admitted' &&
    typeof raw.admission === 'number' &&
    typeof raw.toRepairHead === 'string' &&
    Array.isArray(raw.paths)
  ) {
    return {
      kind: 'admitted',
      admission: raw.admission,
      toRepairHead: raw.toRepairHead,
      paths: raw.paths.filter((p): p is string => typeof p === 'string'),
    };
  }
  return null;
}

const SUBJECT_SOURCES: readonly RepairManifestSubjectSource[] = ['leg-id', 'leg-output', 'supplied', 'none'];

/** Tolerant parse of a persisted manifest: a malformed blob reads as ABSENT, never as a partial manifest. */
export function parseRepairManifest(raw: unknown): RepairManifest | null {
  if (!isRecord(raw)) return null;
  if (raw.schemaVersion !== REPAIR_MANIFEST_SCHEMA_VERSION) return null;
  if (typeof raw.candidate !== 'string' || typeof raw.repairHead !== 'string') return null;
  if (typeof raw.signatureFingerprint !== 'string' || typeof raw.builtAtMs !== 'number') return null;
  if (!Array.isArray(raw.rows)) return null;
  const rows: RepairManifestRow[] = [];
  for (const r of raw.rows) {
    if (!isRecord(r) || typeof r.legId !== 'string' || typeof r.kind !== 'string') return null;
    const status = parseStatus(r.status);
    if (!status) return null;
    const subjectPaths = Array.isArray(r.subjectPaths)
      ? r.subjectPaths.filter((p): p is string => typeof p === 'string')
      : [];
    const source = SUBJECT_SOURCES.includes(r.subjectSource as RepairManifestSubjectSource)
      ? (r.subjectSource as RepairManifestSubjectSource)
      : 'none';
    const claim =
      isRecord(r.claim) && typeof r.claim.actor === 'string' && typeof r.claim.atMs === 'number'
        ? { actor: r.claim.actor, atMs: r.claim.atMs }
        : null;
    rows.push({
      legId: r.legId,
      kind: r.kind as RepairSignatureKind,
      ...(typeof r.workspace === 'string' ? { workspace: r.workspace } : {}),
      recipe: typeof r.recipe === 'string' ? r.recipe : '',
      subjectPaths,
      subjectPathsTruncated: typeof r.subjectPathsTruncated === 'number' ? r.subjectPathsTruncated : 0,
      subjectSource: source,
      status,
      statusLabel: typeof r.statusLabel === 'string' ? r.statusLabel : 'red-at-candidate',
      admitCommand: typeof r.admitCommand === 'string' ? r.admitCommand : null,
      claim,
    });
  }
  return {
    schemaVersion: REPAIR_MANIFEST_SCHEMA_VERSION,
    candidate: raw.candidate,
    repairHead: raw.repairHead,
    signatureFingerprint: raw.signatureFingerprint,
    builtAtMs: raw.builtAtMs,
    rows,
    rowsTruncated: typeof raw.rowsTruncated === 'number' ? raw.rowsTruncated : 0,
  };
}

export interface RepairManifestSummary {
  legs: number;
  red: number;
  admitted: number;
  green: number;
  claimed: number;
  /** Legs whose subject paths are unknown — a fixer must name the paths by hand. */
  pathless: number;
}

export function summarizeRepairManifest(manifest: RepairManifest): RepairManifestSummary {
  let red = 0;
  let admitted = 0;
  let green = 0;
  let claimed = 0;
  let pathless = 0;
  for (const row of manifest.rows) {
    if (row.status.kind === 'green') green += 1;
    else if (row.status.kind === 'admitted') admitted += 1;
    else red += 1;
    if (row.claim) claimed += 1;
    if (row.subjectPaths.length === 0) pathless += 1;
  }
  return { legs: manifest.rows.length, red, admitted, green, claimed, pathless };
}

/**
 * The one rendering every surface uses (work-item comment, owner brief, /admin/git prose):
 * a markdown table plus the legend a first-time reader needs, nothing else.
 */
export function renderRepairManifest(manifest: RepairManifest, opts: { heading?: boolean } = {}): string {
  const s = summarizeRepairManifest(manifest);
  const lines: string[] = [];
  if (opts.heading !== false) {
    lines.push(
      `REPAIR MANIFEST — frozen candidate ${shortSha(manifest.candidate)} @ repairHead ${shortSha(manifest.repairHead)} ` +
        `(${s.legs} leg${s.legs === 1 ? '' : 's'}: ${s.red} red · ${s.admitted} admitted · ${s.green} green` +
        `${s.claimed ? ` · ${s.claimed} claimed` : ''}${s.pathless ? ` · ${s.pathless} pathless` : ''}; built ${new Date(manifest.builtAtMs).toISOString()})`,
    );
    lines.push('');
  }
  lines.push('| leg | kind | status | subject paths | claim | admit with |');
  lines.push('|---|---|---|---|---|---|');
  for (const row of manifest.rows) {
    const paths =
      row.subjectPaths.length === 0
        ? row.kind === 'seed'
          ? '(whole gate — no path)'
          : '(unknown — name the paths you fix)'
        : row.subjectPaths.join('<br>') + (row.subjectPathsTruncated ? `<br>… +${row.subjectPathsTruncated} more` : '');
    const claim = row.claim ? `${row.claim.actor} (${new Date(row.claim.atMs).toISOString()})` : '—';
    const admit = row.admitCommand ? `\`${row.admitCommand}\`` : '—';
    lines.push(`| ${row.legId} | ${row.kind} | ${row.statusLabel} | ${paths} | ${claim} | ${admit} |`);
  }
  if (manifest.rowsTruncated > 0) lines.push(`| … +${manifest.rowsTruncated} more legs | | | | | |`);
  lines.push('');
  lines.push(
    'red-at-candidate = no fix on the lineage yet · admitted-in-#N@sha = an admission carrying this leg\'s paths ' +
      'advanced repairHead to sha and the leg awaits re-verification · green-at-sha = measured passing at sha. ' +
      'Claiming a leg claims its paths (`release:repair-queue { op: \'claim-leg\', leg }`). A fix committed to ' +
      'staging is NOT judged until it is admitted (D-010).',
  );
  return lines.join('\n');
}
