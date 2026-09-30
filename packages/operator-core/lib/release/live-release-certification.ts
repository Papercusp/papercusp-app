/**
 * Exact-SHA certification projected from the live-federation gate's durable
 * verdict bank.
 *
 * P-010 deliberately keeps code promotion and specialized live qualification
 * as two separate stages. The green-checkpoint may advance `main` after its
 * code/test invariants pass; an ordinary deploy may consume that pin only when
 * the live-federation writer has certified the same immutable source.
 *
 * This module is a reader over the existing JSONL bank, not a second scheduler
 * or state store. The writer remains `papercusp-desktop/bin/live-federation-
 * gate.sh`; all deployment paths share this one fail-closed interpretation.
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const LIVE_RELEASE_CERTIFICATION_SCHEMA_VERSION = 2 as const;
export const LIVE_RELEASE_CERTIFICATION_BANK_ENV = 'PAPERCUSP_LIVE_CERTIFICATION_BANK';

/**
 * EI-24610020645182418 — how many consecutive exact-source runs of ONE target may end with the
 * same dirty tree before that dirt is read as deterministic.
 *
 * The certification rig builds a fresh checkout at the target sha, so dirt the build itself
 * leaves behind (a `package-lock.json` rewritten by an install whose lock disagrees with a
 * `package.json`, WI-10004232) recurs on every run. It used to classify as `unqualified`, which
 * release-trigger treats as "not judged yet" and relaunches every 15-minute tick: 93f1c720 ran
 * six ~45-minute heavy builds, each ending `certification-source-dirty-at-build-end` with the
 * single dirty path ` M package-lock.json`. One retry still absorbs genuinely transient dirt;
 * the second identical result is reported as `failed`, which stops the relaunch and surfaces
 * as `live-certification-failed` until a new green pin supersedes it.
 */
export const LIVE_CERTIFICATION_SOURCE_DIRT_REPEAT_LIMIT = 2;

/** The gate's per-run list of paths `git status --porcelain` reported dirty after the build. */
export const LIVE_CERTIFICATION_BUILD_END_DIRT_FILE = 'dirty-files-build-end.txt';

export interface LiveFederationVerdictRecord {
  schema_version?: number;
  epoch?: number;
  verdict?: string;
  head?: string;
  desktop_head?: string;
  source_mode?: string;
  source_head?: string;
  source_desktop_head?: string;
  source_dirty_files?: number;
  terminal_dirty_files?: number;
  certification_target_sha?: string;
  certification_expires_epoch?: number;
  line?: string;
  /**
   * WI-483569 — per-leg outcomes as the gate writes them (live-federation-gate.sh §5). Previously
   * this field reached here ONLY through the index signature below, which is exactly why nothing
   * ever read it: a green was accepted on the strength of the word GREEN alone.
   */
  legs?: Record<string, unknown>;
  [key: string]: unknown;
}

export type LiveReleaseCertificationStatus =
  | 'certified'
  | 'missing'
  | 'target-mismatch'
  | 'failed'
  | 'expired'
  | 'unqualified'
  | 'unreadable';

export interface LiveReleaseCertification {
  status: LiveReleaseCertificationStatus;
  targetSha: string;
  certified: boolean;
  reason: string;
  bankPath: string | null;
  evidence: LiveFederationVerdictRecord | null;
  invalidLines: number;
}

export interface ReadLiveReleaseCertificationOptions {
  bankPath?: string;
  nowMs?: number;
  readText?: (filePath: string) => Promise<string>;
  /** Resolve the dirty paths a record's run left behind; `null` when unknown. */
  resolveDirtyPaths?: DirtyPathResolver;
}

export type DirtyPathResolver = (record: LiveFederationVerdictRecord) => readonly string[] | null;

const SHA_RE = /^[0-9a-f]{7,64}$/i;

export function liveReleaseCertificationBankPath(): string {
  return (
    process.env[LIVE_RELEASE_CERTIFICATION_BANK_ENV]?.trim() ||
    path.join(homedir(), '.papercusp', 'live-fed-gate', 'verdicts.jsonl')
  );
}

/**
 * A leg outcome that means "this leg ran and passed". The gate emits `PASS` and the WI-971
 * variant `PASS-971`; every other token it can write is either a failure (`FAIL`), an
 * un-run marker (`?`), or a SKIPPED*-shaped decline (`SKIPPED`, `SKIPPED-ATTESTATION-WALL`,
 * `SKIPPED-CONTENT-RED`, `SKIPPED-STARVATION`). Anchored and hyphen-delimited so a future
 * `SKIPPED-PASSTHROUGH`-style token cannot be read as a pass.
 */
const PASS_SHAPED_LEG = /^PASS(-|$)/i;

/**
 * WI-483569 — DOES THIS GREEN RECORD EVIDENCE THAT FEDERATION WAS ACTUALLY EXERCISED?
 *
 * A GREEN verdict is a claim about the RUN, not about coverage. The gate can reach GREEN with its
 * federation legs disabled: when no `Package=papercusp-gui` .deb exists to repack, it sets
 * SKIP_MATRIX=1 and RUN_LOCAL_MATRIX=0 at one site, and the surviving from-repo leg — which runs
 * from SOURCE, not from the package — carries the run to a clean verdict. Measured 2026-08-28: all
 * four GREENs in the retained 374-row bank were exactly that shape. WI-478707 stops the gate
 * PRODUCING them; this stops the deploy path CONSUMING them, so neither a future false-green path
 * nor the greens already banked can mint a certificate.
 *
 * THE BAR IS THE CHEAP PER-RUN LEG, DELIBERATELY NOT THE HEAVY ONE. `content_matrix` is the
 * federation smoke every window is expected to run; `local_matrix` is the containerized
 * multi-frame matrix on a 144h cadence (MATRIX_TTL_H) that a given window is usually not even due
 * to run. Requiring local_matrix here would make ordinary deploys wait on a ~4h weekly job — a
 * rule so expensive it would be routed around, which is worse than no rule. Requiring
 * content_matrix costs a correctly-behaving pipeline nothing and kills the entire observed
 * false-green class.
 *
 * Fails CLOSED on a record that cannot answer the question (no `legs`, no `content_matrix`), per
 * this module's stated fail-closed contract: "not measured" and "measured green" must never
 * collapse to the same answer — that collapse is the whole defect.
 */
export function assessFederationLegCoverage(record: LiveFederationVerdictRecord | null): {
  ok: boolean;
  reason: string;
} {
  const legs = record?.legs;
  if (!legs || typeof legs !== 'object' || Array.isArray(legs)) {
    return {
      ok: false,
      reason:
        'the GREEN record does not report which legs ran (no `legs` object), so it cannot evidence that federation was exercised',
    };
  }
  const raw = (legs as Record<string, unknown>).content_matrix;
  const contentMatrix = typeof raw === 'string' ? raw.trim() : '';
  if (!contentMatrix) {
    return {
      ok: false,
      reason:
        'the GREEN record reports no content-matrix leg outcome, so it cannot evidence that federation was exercised',
    };
  }
  if (!PASS_SHAPED_LEG.test(contentMatrix)) {
    return {
      ok: false,
      reason:
        `the GREEN record's content-matrix federation leg is ${JSON.stringify(contentMatrix)}, not a PASS — ` +
        'the run reached GREEN without exercising federation, so it certifies coverage nothing produced (WI-478707/WI-483569)',
    };
  }
  return { ok: true, reason: '' };
}

/** The bank stores short SHAs. Prefix equality is therefore the exact relation. */
export function certificationShaMatches(left: string | null | undefined, right: string): boolean {
  const a = left?.trim().toLowerCase() ?? '';
  const b = right.trim().toLowerCase();
  if (!SHA_RE.test(a) || !SHA_RE.test(b)) return false;
  return a.startsWith(b) || b.startsWith(a);
}

function result(
  status: LiveReleaseCertificationStatus,
  targetSha: string,
  reason: string,
  evidence: LiveFederationVerdictRecord | null,
  invalidLines: number,
  bankPath: string | null,
): LiveReleaseCertification {
  return {
    status,
    targetSha,
    certified: status === 'certified',
    reason,
    bankPath,
    evidence,
    invalidLines,
  };
}

function recordTargets(record: LiveFederationVerdictRecord, targetSha: string): boolean {
  return (
    certificationShaMatches(record.certification_target_sha, targetSha) ||
    certificationShaMatches(record.source_head, targetSha) ||
    certificationShaMatches(record.head, targetSha)
  );
}

/**
 * Count the newest consecutive exact-source rebuilds of `targetSha` that ended with the SAME
 * dirty tree. Only rebuilt records are runs; freshness/no-op tokens are skipped rather than
 * breaking the streak. A clean run, or dirt with different counts or paths, ends it. Paths are
 * compared only when both runs resolve them, so a pruned work directory degrades to counts.
 */
function sourceDirtStreak(
  parsed: readonly LiveFederationVerdictRecord[],
  targetSha: string,
  resolveDirtyPaths: DirtyPathResolver,
): { runs: number; paths: readonly string[] | null } {
  let runs = 0;
  let first: { start: unknown; terminal: unknown; paths: readonly string[] | null } | null = null;
  for (let i = parsed.length - 1; i >= 0; i -= 1) {
    const record = parsed[i]!;
    if (!recordTargets(record, targetSha) || record.source_mode !== 'rebuilt') continue;
    if (
      !certificationShaMatches(record.source_head, targetSha) ||
      !certificationShaMatches(record.head, targetSha) ||
      (record.source_dirty_files === 0 && record.terminal_dirty_files === 0)
    ) {
      break;
    }
    const paths = resolveDirtyPaths(record);
    const normalized = paths ? [...new Set(paths.map((p) => p.trim()).filter(Boolean))].sort() : null;
    if (!first) {
      first = { start: record.source_dirty_files, terminal: record.terminal_dirty_files, paths: normalized };
    } else if (
      record.source_dirty_files !== first.start ||
      record.terminal_dirty_files !== first.terminal ||
      (first.paths && normalized && first.paths.join('\n') !== normalized.join('\n'))
    ) {
      break;
    }
    runs += 1;
  }
  return { runs, paths: first?.paths ?? null };
}

/** The gate writes each run's work directory under the system temp dir; nothing else is read. */
const GATE_WORK_DIR_RE = /^\/tmp\/live-fed-gate-[\w.-]+$/;

/** Read a run's build-end dirt list from its gate work directory; `null` once it is pruned. */
export function readBuildEndDirtyPaths(record: LiveFederationVerdictRecord): readonly string[] | null {
  const work = typeof record.work === 'string' ? record.work : '';
  if (!GATE_WORK_DIR_RE.test(work)) return null;
  try {
    return readFileSync(path.join(work, LIVE_CERTIFICATION_BUILD_END_DIRT_FILE), 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
  } catch {
    return null;
  }
}

/**
 * Assess the newest bank record attributable to `targetSha`.
 *
 * Append order is authoritative. A newer exact-source red invalidates an older
 * green. Non-verdict/freshness records do not inherit certification: they lack
 * the immutable build evidence and therefore return `unqualified` rather than
 * silently falling back to an older result.
 */
export function assessLiveReleaseCertification(
  rawBank: string,
  targetSha: string,
  nowMs = Date.now(),
  bankPath: string | null = null,
  resolveDirtyPaths: DirtyPathResolver = () => null,
): LiveReleaseCertification {
  const normalizedTarget = targetSha.trim().toLowerCase();
  if (!SHA_RE.test(normalizedTarget)) {
    return result(
      'unreadable',
      normalizedTarget,
      `target sha is not a usable git object id: ${JSON.stringify(targetSha)}`,
      null,
      0,
      bankPath,
    );
  }
  if (!Number.isFinite(nowMs)) {
    return result('unreadable', normalizedTarget, 'evaluation instant is not finite', null, 0, bankPath);
  }

  const lines = rawBank.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const parsed: LiveFederationVerdictRecord[] = [];
  let invalidLines = 0;
  let newestLineInvalid = false;
  lines.forEach((line, index) => {
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      parsed.push(value as LiveFederationVerdictRecord);
    } catch {
      invalidLines += 1;
      if (index === lines.length - 1) newestLineInvalid = true;
    }
  });

  // A torn newest append may contain a newer red or revocation. Falling back to
  // the previous green would manufacture authorization from unreadable state.
  if (newestLineInvalid) {
    return result(
      'unreadable',
      normalizedTarget,
      'the newest verdict-bank line is not valid JSON; refusing to infer certification from older state',
      null,
      invalidLines,
      bankPath,
    );
  }
  if (parsed.length === 0) {
    return result('missing', normalizedTarget, 'the verdict bank contains no readable records', null, invalidLines, bankPath);
  }

  const evidence = [...parsed].reverse().find((record) => recordTargets(record, normalizedTarget)) ?? null;
  if (!evidence) {
    return result(
      'target-mismatch',
      normalizedTarget,
      'the verdict bank contains no record attributable to the requested green pin',
      null,
      invalidLines,
      bankPath,
    );
  }

  if (evidence.schema_version !== LIVE_RELEASE_CERTIFICATION_SCHEMA_VERSION) {
    return result(
      'unqualified',
      normalizedTarget,
      `the newest target record uses certification schema ${String(evidence.schema_version ?? 'legacy')}, expected ${LIVE_RELEASE_CERTIFICATION_SCHEMA_VERSION}`,
      evidence,
      invalidLines,
      bankPath,
    );
  }
  if (evidence.source_mode !== 'rebuilt') {
    return result(
      'unqualified',
      normalizedTarget,
      `the live gate did not rebuild this source (source_mode=${String(evidence.source_mode ?? 'missing')})`,
      evidence,
      invalidLines,
      bankPath,
    );
  }
  if (
    !certificationShaMatches(evidence.source_head, normalizedTarget) ||
    !certificationShaMatches(evidence.head, normalizedTarget) ||
    !certificationShaMatches(evidence.source_head, evidence.head ?? '')
  ) {
    return result(
      'target-mismatch',
      normalizedTarget,
      'the build-start sha, terminal sha, and requested green pin are not the same source',
      evidence,
      invalidLines,
      bankPath,
    );
  }
  if (
    evidence.certification_target_sha &&
    !certificationShaMatches(evidence.certification_target_sha, normalizedTarget)
  ) {
    return result(
      'target-mismatch',
      normalizedTarget,
      'the run declared a different certification target',
      evidence,
      invalidLines,
      bankPath,
    );
  }
  if (
    !certificationShaMatches(evidence.source_desktop_head, evidence.desktop_head ?? '')
  ) {
    return result(
      'unqualified',
      normalizedTarget,
      'the desktop submodule changed between build start and terminal verdict',
      evidence,
      invalidLines,
      bankPath,
    );
  }
  if (evidence.source_dirty_files !== 0 || evidence.terminal_dirty_files !== 0) {
    const dirt = sourceDirtStreak(parsed, normalizedTarget, resolveDirtyPaths);
    const counts = `start=${String(evidence.source_dirty_files)}, terminal=${String(evidence.terminal_dirty_files)}`;
    const paths = dirt.paths ? `; dirty: ${dirt.paths.join(', ')}` : '';
    if (dirt.runs >= LIVE_CERTIFICATION_SOURCE_DIRT_REPEAT_LIMIT) {
      return result(
        'failed',
        normalizedTarget,
        `the exact-source build left the same tracked files dirty on ${dirt.runs} consecutive certification runs (${counts}${paths}) — the dirt is deterministic at this sha, so a re-run cannot certify it; fix the source and let a new green pin supersede it`,
        evidence,
        invalidLines,
        bankPath,
      );
    }
    return result(
      'unqualified',
      normalizedTarget,
      `the certified source was not clean (${counts}${paths}); run ${dirt.runs} of ${LIVE_CERTIFICATION_SOURCE_DIRT_REPEAT_LIMIT} before identical dirt counts as deterministic`,
      evidence,
      invalidLines,
      bankPath,
    );
  }

  const verdict = evidence.verdict?.trim().toUpperCase() ?? '';
  if (verdict === 'RED') {
    return result(
      'failed',
      normalizedTarget,
      'the newest exact-source live-federation verdict is RED',
      evidence,
      invalidLines,
      bankPath,
    );
  }
  if (verdict !== 'GREEN') {
    return result(
      'unqualified',
      normalizedTarget,
      `the newest exact-source record is not a certifying verdict (${verdict || 'missing'})`,
      evidence,
      invalidLines,
      bankPath,
    );
  }

  // WI-483569 — a GREEN is a claim about the run, not proof of federation coverage. Checked here,
  // AFTER the verdict branches and BEFORE expiry, so an uncovered green is reported as the
  // coverage gap it is rather than surviving to be judged on its expiry date.
  const coverage = assessFederationLegCoverage(evidence);
  if (!coverage.ok) {
    return result('unqualified', normalizedTarget, coverage.reason, evidence, invalidLines, bankPath);
  }

  const expiresEpoch = evidence.certification_expires_epoch;
  if (!Number.isFinite(expiresEpoch) || (expiresEpoch ?? 0) <= 0) {
    return result(
      'unqualified',
      normalizedTarget,
      'the GREEN record has no usable writer-owned certification expiry',
      evidence,
      invalidLines,
      bankPath,
    );
  }
  if (nowMs >= (expiresEpoch as number) * 1_000) {
    return result(
      'expired',
      normalizedTarget,
      `the exact-source live certification expired at ${new Date((expiresEpoch as number) * 1_000).toISOString()}`,
      evidence,
      invalidLines,
      bankPath,
    );
  }

  return result(
    'certified',
    normalizedTarget,
    `live federation certified exact source ${evidence.source_head}`,
    evidence,
    invalidLines,
    bankPath,
  );
}

export async function readLiveReleaseCertification(
  targetSha: string,
  opts: ReadLiveReleaseCertificationOptions = {},
): Promise<LiveReleaseCertification> {
  const bankPath = opts.bankPath ?? liveReleaseCertificationBankPath();
  const readText = opts.readText ?? ((filePath: string) => readFile(filePath, 'utf8'));
  try {
    return assessLiveReleaseCertification(
      await readText(bankPath),
      targetSha,
      opts.nowMs ?? Date.now(),
      bankPath,
      opts.resolveDirtyPaths ?? readBuildEndDirtyPaths,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return result(
      code === 'ENOENT' ? 'missing' : 'unreadable',
      targetSha.trim().toLowerCase(),
      code === 'ENOENT'
        ? `live-certification verdict bank does not exist at ${bankPath}`
        : `could not read live-certification verdict bank at ${bankPath}: ${error instanceof Error ? error.message : String(error)}`,
      null,
      0,
      bankPath,
    );
  }
}

