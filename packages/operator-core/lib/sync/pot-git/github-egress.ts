/**
 * pot-git/github-egress.ts — the EGRESS half of the GitHub bridge
 * (github-bridge-hive-egress-2026-07-02 P-001; design S-1/S-2/S-4, D-001/D-002).
 *
 * Publishes the hive's COMPUTED CANONICAL refs (the integrator's staging, the
 * green-gated release ref, release tags) from the pot-git bare store OUT to the
 * GitHub remote — the D-009 "GitHub is the release channel, not the transport"
 * boundary made concrete. Device namespaces NEVER egress (S-2: noise + privacy);
 * only the refs the integrator/release layers computed.
 *
 * INVARIANTS (same class as G-5d/G-7c):
 *   - FF-ONLY, NEVER FORCE (S-4). Every push is un-forced, so the remote itself
 *     rejects a non-fast-forward — GitHub's atomic old-sha check is the CAS.
 *     Before pushing we ALSO verify locally that the remote's current head is an
 *     ancestor of what we publish, so a diverged origin (a human push, a legacy
 *     member's git-sync merge) is REPORTED as `rejectedNonFF` — the P-006
 *     divergence policy (ingress-merge via the integrator; escalation) owns what
 *     happens next. This module never overwrites GitHub-side history, full stop.
 *   - SINGLE WRITER (S-1/D-002): the CALLER gates on the integrator
 *     owning-hive key — every push requires fresh owner authorization (F6/D-022).
 *     FF/CAS protects ref ancestry; it does not grant cross-machine authority, by
 *     the same layering as integrator.ts.
 *   - SECRETS GATE: the DELTA being published (changed files between the remote's
 *     current head and the egress target) runs through secrets-guard
 *     (`scanForSecrets` — the exemption-aware file-set entrypoint, NEVER the raw
 *     per-line `scanTextForSecrets`) before any bytes leave. Findings BLOCK that ref —
 *     fail-closed, like release-promotion's posture: an outward publish must
 *     never leak a credential. (This is the first live wiring of secrets-guard —
 *     it was built for exactly this boundary.)
 *   - TAGS are create-only (an existing remote tag never moves — un-forced tag
 *     pushes to an existing tag are rejected by the remote, reported per-tag).
 *
 * WHERE THE PUSH TARGET COMES FROM: the caller resolves it with the EXISTING
 * `resolveForkPushTarget` seam (harness/git-sync/fork-remote.ts — D-007b: a
 * configured fork ALWAYS wins; upstream only with write; else none) and passes
 * the resolved remote URL in. This module takes a URL, not a policy — legacy
 * contribution semantics stay in the one module that already owns them.
 *
 * Fail-soft: never throws; every failure folds into the per-ref result. Pure
 * over storage.ts's RunGit seam — integration tests run against local bare
 * "origin" repos, no network.
 */

import {
  type RunGit,
  type RunGitStdin,
  NETWORK_RUN_GIT_TIMEOUT_MS,
  defaultRunGit,
  defaultRunGitStdin,
} from './storage';
import { type SecretFinding, scanForSecrets } from './secrets-guard';
import { loadSecretsGuardPathExemptions, partitionExemptFindings } from './secrets-guard-exemptions';
import { requireHiveEffectAuthority, type HiveEffectAuthority } from './hive-effect-authority';
import type { SignedProtocolScope } from './signed-context';

/** Per-tick BUDGET on delta blobs scanned for secrets per egressed ref.
 *  WI-5738: this used to be a cliff — exceeding it blocked the ref outright
 *  (`overflow`), which meant a merely LARGE backlog was refused forever, since
 *  the range only shrinks through the push being refused. It is now a budget:
 *  the walk pushes the prefix it verified and resumes next tick, so a big
 *  backlog DRAINS instead of deadlocking. Nothing unscanned is ever pushed. */
export const DEFAULT_MAX_SCAN_FILES = 5_000;

/** Blobs larger than this are skipped by the secret scan (binary/asset noise;
 *  entropy scans on megabytes are slow) — counted, never silently dropped. */
export const MAX_SCAN_BLOB_BYTES = 1_048_576;

/** One canonical ref to publish: a local sha → a fully-qualified remote ref. */
export interface EgressRef {
  /** The local sha to publish (e.g. the integrator's staging head). */
  sha: string;
  /** Fully-qualified destination, e.g. `refs/heads/staging`. */
  remoteRef: string;
}

/** One release tag to publish (create-only). */
export interface EgressTag {
  /** Tag name WITHOUT the refs/tags/ prefix, e.g. `release-2026-07-02`. */
  name: string;
  /** The sha the tag points at. */
  sha: string;
}

export interface EgressInput {
  /** Trusted runtime scope and live owner signer; missing authority fails closed. */
  scope?: SignedProtocolScope;
  authority?: HiveEffectAuthority | null;
  /** The pot-git bare repo (storage.ts hiveGitRepoPath). */
  repoPath: string;
  /**
   * The push destination URL — resolved by the CALLER via resolveForkPushTarget
   * (fork wins / upstream-with-write / none). A local path works (tests).
   */
  remoteUrl: string;
  /** Canonical refs to publish. */
  refs: EgressRef[];
  /** Release tags to publish (create-only). */
  tags?: EgressTag[];
  runGit?: RunGit;
  /** Seam for the stdin-fed `cat-file --batch` plumbing the secrets scan uses
   *  (see readScannableBlobs). Defaults to defaultRunGitStdin. */
  runGitStdin?: RunGitStdin;
  /**
   * ALL-OR-NOTHING: publish `spec.sha` or publish nothing for that ref.
   *
   * The default (false) is the WI-5738 incremental-drain semantic the BRIDGE
   * wants: a blocked or budget-exhausted scan still publishes the verified
   * PREFIX, so one fat or dirty commit cannot wedge the whole backlog forever.
   * That is right for a continuously-advancing branch like canonical staging.
   *
   * It is WRONG for a ref whose identity IS a specific commit — the fork PR
   * branch (github-fork-egress) names one ratified head, so publishing a
   * partial prefix under that name creates a branch that misrepresents what was
   * ratified, and leaves it on the fork after a refusal that promised nothing
   * would leave. Those callers set this true: the prefix is still computed (so
   * blockedSecrets still reports exactly where it stopped), but nothing is
   * pushed unless the scan verified all the way to the requested sha.
   */
  requireExactTarget?: boolean;
  /** Secret-scan the published delta (default true — S-2). */
  scanSecrets?: boolean;
  /** Cap on delta files scanned per ref (default DEFAULT_MAX_SCAN_FILES).
   *  WI-5738: this is now a per-tick scan BUDGET (partial progress + resume),
   *  not a cliff that refuses the whole push. */
  maxScanFiles?: number;
  /**
   * WI-5738: workspace whose runtime secrets-guard path exemptions
   * (harness_shared.secrets_guard_path_exemptions) apply to this scan — the
   * same no-restart escape hatch own-head-publish already honours. Egress
   * previously consulted NO exemptions at all, so the one guard that was
   * actually wedged was also the one an operator had no lever for. Omitted =>
   * no runtime exemptions (only secrets-guard's static FIXTURE_FILES).
   */
  workspaceId?: string;
  /** Injectable for tests; defaults to the real DB-backed loader. */
  loadPathExemptions?: (workspaceId: string) => Promise<ReadonlySet<string>>;
}

export interface EgressPushed {
  remoteRef: string;
  /** The remote's sha before our push (null = the ref did not exist). */
  from: string | null;
  to: string;
}

export interface EgressNonFF {
  remoteRef: string;
  /** What the remote currently holds (null = unknown / unfetchable). */
  remoteSha: string | null;
  localSha: string;
  reason: string;
}

export interface EgressSecretBlock {
  remoteRef: string;
  findings: SecretFinding[];
  /** True when the delta exceeded maxScanFiles — blocked as overflow, not leak. */
  overflow: boolean;
  /** Oversized blobs skipped by the scan (informational). */
  skippedLargeBlobs: number;
  /** WI-5738: the EXACT commit that failed the scan. Everything before it was
   *  verified and pushed — a block is now attributable to one commit instead of
   *  "somewhere in this range". */
  blockedAtCommit?: string;
  /** How far the ref still advanced despite the block (null = not at all). */
  advancedTo?: string | null;
}

/** A failure in the remote transport, distinct from local scan errors and
 * policy outcomes such as non-FF or secret blocks. */
export interface EgressRemoteError {
  message: string;
  /** `defaultRunGit`'s code -1 means the process never reached the remote. */
  transient: boolean;
}

export interface EgressResult {
  ok: boolean;
  pushed: EgressPushed[];
  /** Remote already at the target sha. */
  upToDate: string[];
  /** Diverged origin — NEVER forced; P-006 divergence policy owns the follow-up. */
  rejectedNonFF: EgressNonFF[];
  /** Refs blocked by the secrets gate — nothing left the machine for these. */
  blockedSecrets: EgressSecretBlock[];
  /** WI-5738: findings suppressed by a runtime path exemption — surfaced for
   *  audit so an exemption quietly holding the plane open is never invisible. */
  exemptedFindings: SecretFinding[];
  tagsPushed: string[];
  tagsRejected: { name: string; reason: string }[];
  /** Remote transport failures that must not be folded into a clear verdict. */
  remoteErrors: EgressRemoteError[];
  errors: string[];
}

/** `git ls-remote <url> <ref>` → sha, or null when the ref doesn't exist there.
 *  A transport failure returns { error } so callers can distinguish "absent"
 *  from "unreachable" (pushing at an unreachable remote is pointless noise). */
async function lsRemote(
  repoPath: string,
  remoteUrl: string,
  ref: string,
  runGit: RunGit,
): Promise<{ sha: string | null } | { error: string; transient: boolean }> {
  const r = await runGit(['ls-remote', remoteUrl, ref], repoPath);
  if (r.code !== 0) return { error: r.stderr.trim() || `ls-remote exited ${r.code}`, transient: r.code === -1 };
  const line = r.stdout.split('\n').find((l) => l.trim());
  if (!line) return { sha: null };
  const sha = line.trim().split(/\s+/)[0];
  return { sha: sha && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null };
}

async function haveObject(repoPath: string, sha: string, runGit: RunGit): Promise<boolean> {
  const r = await runGit(['cat-file', '-e', `${sha}^{commit}`], repoPath);
  return r.code === 0;
}

async function isAncestor(repoPath: string, ancestor: string, descendant: string, runGit: RunGit): Promise<boolean> {
  const r = await runGit(['merge-base', '--is-ancestor', ancestor, descendant], repoPath);
  return r.code === 0;
}

/**
 * Every blob INTRODUCED by the pushed range (base..target; base=null → all of
 * target's history) as { path, content } for the secrets scan.
 *
 * Why per-commit and not endpoint-diff: a push publishes HISTORY — a secret
 * committed then deleted inside the range rides out in the pack even though an
 * endpoint diff never shows it. So we walk `rev-list base..target` and collect
 * each commit's introduced blobs (diff-tree vs its parents), deduped by blob
 * sha. Blobs already reachable from `base` are excluded by rev-list itself.
 *
 * Bounds: unique blobs beyond `maxFiles` → overflow (the caller fails CLOSED);
 * blobs over MAX_SCAN_BLOB_BYTES or containing NUL (binary) are skipped and
 * counted, not scanned.
 */
async function collectCommitBlobs(
  repoPath: string,
  commit: string,
  seen: Set<string>,
  runGit: RunGit,
): Promise<{ blobs: Map<string, string> } | { error: string }> {
  // -m: diff merges against EACH parent (a merge can introduce blobs too);
  // --root: a parentless commit diffs against the empty tree.
  const raw = await runGit(['diff-tree', '-r', '-m', '--root', '--no-commit-id', commit], repoPath);
  if (raw.code !== 0) return { error: raw.stderr.trim() || `diff-tree ${commit} exited ${raw.code}` };
  const blobs = new Map<string, string>();
  for (const line of raw.stdout.split('\n')) {
    const m = line.match(/^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) ([A-Z])\d*\t(.+?)(?:\t.*)?$/);
    if (!m) continue;
    const [, dstSha, status, path] = m;
    if (status === 'D' || /^0+$/.test(dstSha)) continue; // deletion — no new blob
    if (seen.has(dstSha) || blobs.has(dstSha)) continue;
    blobs.set(dstSha, path);
  }
  return { blobs };
}

/** Read a blob set as scannable text. Blobs over MAX_SCAN_BLOB_BYTES or
 *  containing NUL (binary) are skipped and counted, never silently dropped.
 *
 *  TWO git spawns TOTAL, regardless of how many blobs (EI-18655490965643060).
 *  This used to spawn `cat-file -s` + `cat-file -p` PER BLOB, serially — so a
 *  backlog cost 2xB sequential process spawns. Draining one 5000-blob budget
 *  slice took ~5m15s of pure fork/exec churn (bg-host pegged near 100% CPU at
 *  near-zero disk I/O), and because this leg runs inside the git-sync DBOS
 *  workflow on the `routines-critical` queue, that whole window blocked every
 *  subsequent git-sync fire for the harness — indistinguishable from a wedged
 *  pipeline. Batched via the `cat-file --batch` family, the same shape
 *  publish-guard.ts and foreign-mirror-quarantine.ts already use. */
async function readScannableBlobs(
  repoPath: string,
  blobs: ReadonlyMap<string, string>,
  runGitStdin: RunGitStdin,
): Promise<{ files: { path: string; content: string }[]; skippedLarge: number }> {
  let skippedLarge = 0;
  const files: { path: string; content: string }[] = [];
  if (blobs.size === 0) return { files, skippedLarge };

  // 1. One batch-check pass: type + size for the whole set. Non-blob entries
  //    (a submodule gitlink) and `<oid> missing` lines are skipped, exactly as
  //    the per-blob `cat-file -s` non-zero exit did before.
  const check = await runGitStdin(
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)', '--buffer'],
    repoPath,
    [...blobs.keys()].join('\n') + '\n',
  );
  if (check.code !== 0) return { files, skippedLarge };

  const wanted: string[] = [];
  for (const line of check.stdout.toString('utf8').split('\n')) {
    const [oid, type, sizeS] = line.trim().split(/\s+/);
    if (!oid || type !== 'blob') continue;
    if (Number(sizeS ?? 0) > MAX_SCAN_BLOB_BYTES) {
      skippedLarge += 1;
      continue;
    }
    wanted.push(oid);
  }
  if (wanted.length === 0) return { files, skippedLarge };

  // 2. One batch pass for the contents. Frame format is
  //    `<oid> SP <type> SP <size> LF <contents> LF`, so walk it by BYTE offset
  //    off the Buffer — decoding first would desync the stream on any
  //    non-ASCII content.
  const batch = await runGitStdin(['cat-file', '--batch', '--buffer'], repoPath, wanted.join('\n') + '\n');
  if (batch.code !== 0) return { files, skippedLarge };

  const buf = batch.stdout;
  let off = 0;
  while (off < buf.length) {
    const nl = buf.indexOf(0x0a, off);
    if (nl < 0) break;
    const [oid, type, sizeS] = buf.toString('utf8', off, nl).trim().split(/\s+/);
    off = nl + 1;
    if (!oid || type !== 'blob') continue; // `<oid> missing` — no content frame follows
    const size = Number(sizeS ?? 0);
    if (!Number.isFinite(size) || size < 0 || off + size > buf.length) break; // truncated/desynced — stop, never mis-attribute bytes
    const content = buf.subarray(off, off + size);
    off += size + 1; // +1 for the frame's trailing LF
    const path = blobs.get(oid);
    if (path === undefined) continue;
    if (content.includes(0)) continue; // binary — no line-oriented secrets
    files.push({ path, content: content.toString('utf8') });
  }
  return { files, skippedLarge };
}

export interface SafeEgressResolution {
  /** The furthest sha in (base, target] whose whole prefix scanned clean.
   *  Equals `base` (or null) when even the first commit is blocked. */
  safeSha: string | null;
  /** Set when a commit in the range failed the scan — everything BEFORE it is
   *  still safe to push, and `safeSha` points there. */
  blocked: { commit: string; findings: SecretFinding[] } | null;
  /** True when the per-tick scan budget ran out before reaching `target`. NOT a
   *  refusal: `safeSha` advanced, and the next tick resumes from it. */
  budgetExhausted: boolean;
  exempted: SecretFinding[];
  skippedLarge: number;
  scannedBlobs: number;
  error?: string;
}

/**
 * Walk (base, target] OLDEST-FIRST and return the furthest sha whose entire
 * prefix scans clean.
 *
 * WI-5738 — why this replaces the old judge-the-whole-range-at-once shape.
 * The previous implementation collected every blob in the range, scanned them
 * as one set, and refused the WHOLE push on any finding or on exceeding
 * `maxFiles` (`overflow`). Because the range is `(origin/staging, canonical]`
 * — i.e. baselined on egress's own last SUCCESS — a refusal was terminal by
 * construction: the range could only shrink through the push it was blocking,
 * while every new commit made it bigger. On 2026-07-20 one accidentally
 * committed AppImage extraction put 358 commits and >5,000 blobs permanently
 * inside the range; egress then refused every tick for five days, reporting
 * `blockedSecrets: 1` with health surfaces reading green.
 *
 * Two properties fix that class outright:
 *   1. PARTIAL PROGRESS. A bad commit blocks only itself and its descendants;
 *      everything before it still ships, so the baseline advances and the
 *      judged range keeps shrinking. Attribution is exact (`blocked.commit`)
 *      instead of "something in these 358 commits".
 *   2. A BUDGET, NOT A CLIFF. Exhausting `maxFiles` now stops the walk and
 *      pushes what was verified, instead of refusing everything. A large
 *      backlog drains over several ticks rather than deadlocking — and a
 *      first-ever publish of a big repo can no longer be permanently
 *      un-pushable.
 *
 * Blob reads are deduped ACROSS commits (`seen`), so the walk costs the same
 * object reads the old single-pass collection did. A single commit that alone
 * exceeds the budget is still scanned in full when no progress has been made
 * yet — otherwise one fat commit would deadlock the walk at zero.
 */
export async function resolveSafeEgressSha(input: {
  repoPath: string;
  base: string | null;
  target: string;
  maxFiles: number;
  runGit: RunGit;
  runGitStdin?: RunGitStdin;
  exemptions?: ReadonlySet<string>;
}): Promise<SafeEgressResolution> {
  const { repoPath, base, target, maxFiles, runGit } = input;
  const runGitStdin = input.runGitStdin ?? defaultRunGitStdin;
  const exemptions = input.exemptions ?? new Set<string>();
  const res: SafeEgressResolution = {
    safeSha: base,
    blocked: null,
    budgetExhausted: false,
    exempted: [],
    skippedLarge: 0,
    scannedBlobs: 0,
  };
  // --reverse => oldest first, so `safeSha` only ever moves forward along a
  // first-parent-consistent prefix of the range.
  const range = base ? [`${base}..${target}`] : [target];
  const revs = await runGit(['rev-list', '--reverse', ...range], repoPath);
  if (revs.code !== 0) return { ...res, error: revs.stderr.trim() || `rev-list exited ${revs.code}` };
  const commits = revs.stdout.split('\n').map((l) => l.trim()).filter(Boolean);

  const seen = new Set<string>();
  for (const commit of commits) {
    if (res.scannedBlobs >= maxFiles && res.safeSha !== base) {
      // Budget spent AND we have something to show for it — ship the verified
      // prefix now and resume here next tick.
      res.budgetExhausted = true;
      return res;
    }
    const collected = await collectCommitBlobs(repoPath, commit, seen, runGit);
    if ('error' in collected) return { ...res, error: collected.error };
    const { files, skippedLarge } = await readScannableBlobs(repoPath, collected.blobs, runGitStdin);
    for (const sha of collected.blobs.keys()) seen.add(sha);
    res.skippedLarge += skippedLarge;
    res.scannedBlobs += collected.blobs.size;

    // MUST be the file-set entrypoint, never the per-line primitive: only
    // `scanForSecrets` applies the fixture-path exemption (isFixtureFile).
    // Calling `scanTextForSecrets` directly here froze origin/staging for
    // hours (P-402 / EI-13924, 2026-07-19).
    const { blocking, exempted } = partitionExemptFindings(scanForSecrets(files), exemptions);
    res.exempted.push(...exempted);
    if (blocking.length > 0) {
      res.blocked = { commit, findings: blocking };
      return res; // safeSha stays at the last clean commit — its ancestors still ship
    }
    res.safeSha = commit;
  }
  return res;
}

/**
 * Publish canonical refs (+ release tags) to the GitHub remote. FF-only, never
 * forced, secrets-gated. Per-ref best-effort: one blocked/rejected ref never
 * stops the others. `ok` = no transport errors (rejections/blocks are POLICY
 * outcomes, reported in their own buckets, and do not clear `ok`).
 */
export async function egressCanonicalRefs(input: EgressInput): Promise<EgressResult> {
  const runGit = input.runGit ?? defaultRunGit;
  const scan = input.scanSecrets !== false;
  const maxScanFiles = input.maxScanFiles ?? DEFAULT_MAX_SCAN_FILES;
  const exemptions =
    scan && input.workspaceId
      ? await (input.loadPathExemptions ?? loadSecretsGuardPathExemptions)(input.workspaceId)
      : new Set<string>();
  const res: EgressResult = {
    ok: true,
    exemptedFindings: [],
    pushed: [],
    upToDate: [],
    rejectedNonFF: [],
    blockedSecrets: [],
    tagsPushed: [],
    tagsRejected: [],
    remoteErrors: [],
    errors: [],
  };

  const authorize = async (effect: string[]): Promise<boolean> => {
    try {
      await requireHiveEffectAuthority(input.authority, input.scope ?? { hive_id: '', repo_key: '' }, effect);
      return true;
    } catch (error) {
      res.ok = false;
      res.errors.push(error instanceof Error ? error.message : String(error));
      return false;
    }
  };
  // Refuse before network preflight, then revalidate at each actual push.
  if (!(await authorize(['egress', input.repoPath]))) return res;

  for (const spec of input.refs) {
    // 1. Where is the remote now?
    const remote = await lsRemote(input.repoPath, input.remoteUrl, spec.remoteRef, runGit);
    if ('error' in remote) {
      res.ok = false;
      const message = `ls-remote ${spec.remoteRef}: ${remote.error}`;
      res.remoteErrors.push({ message, transient: remote.transient });
      res.errors.push(message);
      continue;
    }
    const remoteSha = remote.sha;
    if (remoteSha === spec.sha) {
      res.upToDate.push(spec.remoteRef);
      continue;
    }

    // 2. FF check against the remote's current head. If we don't hold the
    //    remote's objects (a GitHub-side commit we never ingressed), fetch just
    //    that head into a private landing ref (ours to clobber, like the
    //    bootstrap quarantine) so ancestry + delta-scan can run.
    if (remoteSha !== null) {
      if (!(await haveObject(input.repoPath, remoteSha, runGit))) {
        // Generous network timeout (not the 60s local-op default) — a genuine
        // bulk transfer over a real connection to GitHub (github-bridge-
        // ingress-timeout-too-short-2026-07-20, EI-18189246091367226).
        const f = await runGit(
          ['fetch', input.remoteUrl, `+${remoteSha}:refs/egress-remote/head`],
          input.repoPath,
          { timeoutMs: NETWORK_RUN_GIT_TIMEOUT_MS },
        );
        if (f.code !== 0 || !(await haveObject(input.repoPath, remoteSha, runGit))) {
          if (f.code !== 0) {
            res.remoteErrors.push({
              message: `fetch ${spec.remoteRef}: ${f.stderr.trim() || `exited ${f.code}`}`,
              transient: f.code === -1,
            });
          }
          // Can't establish ancestry → fail CLOSED as a non-FF (never push blind).
          res.rejectedNonFF.push({
            remoteRef: spec.remoteRef,
            remoteSha,
            localSha: spec.sha,
            reason: 'remote head unfetchable — ancestry unverifiable, refusing blind push',
          });
          continue;
        }
      }
      if (!(await isAncestor(input.repoPath, remoteSha, spec.sha, runGit))) {
        res.rejectedNonFF.push({
          remoteRef: spec.remoteRef,
          remoteSha,
          localSha: spec.sha,
          reason: 'origin diverged from canonical — ingress-merge via the integrator (S-4), never force',
        });
        continue;
      }
    }

    // EI-20440191013804843: validate the credential-helper/write plane before
    // paying for the secrets scan or attempting the real update. GitHub can
    // accept ls-remote with one credential and then reject every write because
    // gh's active account has an unverified email or lacks a required scope
    // (notably `workflow`). `git push --dry-run` exercises the same receive-pack
    // authentication and policy checks without mutating the remote, so the
    // actionable rejection is recorded on this tick instead of being discovered
    // only after the whole egress pipeline has run.
    const preflight = await runGit(
      ['push', '--dry-run', input.remoteUrl, `${spec.sha}:${spec.remoteRef}`],
      input.repoPath,
      { timeoutMs: NETWORK_RUN_GIT_TIMEOUT_MS },
    );
    if (preflight.code !== 0) {
      res.ok = false;
      const message =
        `push preflight ${spec.remoteRef}: ` +
        (preflight.stderr.trim() || `exited ${preflight.code}`);
      res.remoteErrors.push({ message, transient: preflight.code === -1 });
      res.errors.push(message);
      continue;
    }

    // 3. Secrets gate over the published delta (fail-closed) — INCREMENTAL
    //    (WI-5738): resolve the furthest safe sha instead of accepting or
    //    refusing the whole range, so one bad commit blocks only itself and the
    //    baseline still advances. See resolveSafeEgressSha's header for why the
    //    all-or-nothing shape was self-perpetuating.
    let pushSha = spec.sha;
    if (scan) {
      const verdict = await resolveSafeEgressSha({
        repoPath: input.repoPath,
        base: remoteSha,
        target: spec.sha,
        maxFiles: maxScanFiles,
        runGit,
        runGitStdin: input.runGitStdin,
        exemptions,
      });
      if (verdict.error) {
        res.ok = false;
        res.errors.push(`secret-scan collect ${spec.remoteRef}: ${verdict.error}`);
        continue;
      }
      res.exemptedFindings.push(...verdict.exempted);
      if (verdict.blocked) {
        res.blockedSecrets.push({
          remoteRef: spec.remoteRef,
          findings: verdict.blocked.findings,
          overflow: false,
          skippedLargeBlobs: verdict.skippedLarge,
          blockedAtCommit: verdict.blocked.commit,
          advancedTo: verdict.safeSha !== remoteSha ? verdict.safeSha : null,
        });
      } else if (verdict.budgetExhausted) {
        // Not a refusal — a partial drain. Recorded so a stalled-looking
        // watermark is explainable without reading the code.
        res.errors.push(
          `egress ${spec.remoteRef}: scan budget (${maxScanFiles} blobs) reached before the target; ` +
            `pushing the verified prefix ${verdict.safeSha?.slice(0, 12)} — the remainder drains on following ticks`,
        );
      }
      // All-or-nothing callers publish the requested sha or nothing at all —
      // never a partial prefix under a ref whose name means one exact commit.
      if (input.requireExactTarget && verdict.safeSha !== spec.sha) continue;
      // Nothing verified beyond what the remote already has → nothing to push.
      if (!verdict.safeSha || verdict.safeSha === remoteSha) continue;
      pushSha = verdict.safeSha;
    }

    // 4. The push — UN-FORCED, so the remote's own atomic old-sha check is the
    //    CAS: a race (someone pushed between our ls-remote and now) rejects
    //    non-FF and lands in rejectedNonFF for the next tick to reconcile.
    //    Generous network timeout — a genuine bulk transfer, not a local op
    //    (github-bridge-ingress-timeout-too-short-2026-07-20, EI-18189246091367226).
    if (!(await authorize(['push-ref', input.repoPath, spec.remoteRef, pushSha]))) continue;
    const push = await runGit(
      ['push', input.remoteUrl, `${pushSha}:${spec.remoteRef}`],
      input.repoPath,
      { timeoutMs: NETWORK_RUN_GIT_TIMEOUT_MS },
    );
    if (push.code === 0) {
      res.pushed.push({ remoteRef: spec.remoteRef, from: remoteSha, to: pushSha });
    } else {
      // A concurrent writer can land this exact target between the initial
      // ls-remote and our push. Git then reports the losing CAS as a push
      // failure (for example, "cannot lock ref ... is at <target> but
      // expected <old>"), even though the desired state is already true.
      // Re-read the authoritative remote ref before classifying the failure;
      // an exact-target match is an idempotent success, not a transport error
      // or divergence signal. If the proof fails, retain the existing
      // fail-closed classification below.
      const afterPush = await lsRemote(input.repoPath, input.remoteUrl, spec.remoteRef, runGit);
      if (!('error' in afterPush) && afterPush.sha === pushSha) {
        res.upToDate.push(spec.remoteRef);
        continue;
      }
    // `failed to push some refs` is Git's GENERIC trailer for every rejected
    // push (permission/ruleset failures included), not proof of a non-FF. The
    // pre-push ancestry check above already proved this update fast-forwardable;
    // classify only stderr carrying an actual non-FF/fetch-first reason. A
    // permission failure must stay a transport error so metadata preserves the
    // actionable cause instead of falsely escalating divergence.
      if (/non-fast-forward|fetch first/i.test(push.stderr)) {
      res.rejectedNonFF.push({
        remoteRef: spec.remoteRef,
        remoteSha: null,
        localSha: spec.sha,
        reason: `push rejected: ${push.stderr.trim().split('\n')[0] ?? 'non-fast-forward'}`,
      });
    } else {
      res.ok = false;
      const message = `push ${spec.remoteRef}: ${push.stderr.trim() || `exited ${push.code}`}`;
      res.remoteErrors.push({ message, transient: push.code === -1 });
      res.errors.push(message);
    }
    }
  }

  // 5. Release tags — create-only. An un-forced push to an EXISTING tag is
  //    rejected by the remote; we pre-check to report it as policy, not error.
  for (const tag of input.tags ?? []) {
    const tagRef = `refs/tags/${tag.name}`;
    const remote = await lsRemote(input.repoPath, input.remoteUrl, tagRef, runGit);
    if ('error' in remote) {
      res.ok = false;
      const message = `ls-remote ${tagRef}: ${remote.error}`;
      res.remoteErrors.push({ message, transient: remote.transient });
      res.errors.push(message);
      continue;
    }
    if (remote.sha === tag.sha) {
      res.upToDate.push(tagRef);
      continue;
    }
    if (remote.sha !== null) {
      res.tagsRejected.push({ name: tag.name, reason: 'tag exists on remote with a different sha — tags never move' });
      continue;
    }
    if (!(await authorize(['push-tag', input.repoPath, tagRef, tag.sha]))) continue;
    const push = await runGit(
      ['push', input.remoteUrl, `${tag.sha}:${tagRef}`],
      input.repoPath,
      { timeoutMs: NETWORK_RUN_GIT_TIMEOUT_MS },
    );
    if (push.code === 0) res.tagsPushed.push(tag.name);
    else {
      const message = `push ${tagRef}: ${push.stderr.trim() || `exited ${push.code}`}`;
      res.tagsRejected.push({ name: tag.name, reason: message.split('\n')[0] ?? message });
      res.remoteErrors.push({ message, transient: push.code === -1 });
    }
  }

  return res;
}
