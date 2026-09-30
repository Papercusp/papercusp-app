/**
 * github-bridge-tick — ONE bridge pass for a bridged hive's managed repo
 * (github-bridge-hive-egress-2026-07-02 P-008, composing P-001/P-002/P-005/P-006).
 *
 * Rides the `system:git-sync` tick (D-003: no new scheduler): git-sync-action
 * calls this as a checkpointed step when the member's hive `hiveGit.mode` is
 * `bridged` AND FLAGS.GITHUB_BRIDGE is on. The pass:
 *
 *   1. INGRESS (P-002): fetch origin branch(es) into the synthetic
 *      github-origin namespace — FF-only; a rewrite surfaces as `nonFF`.
 *   2. ADMISSION (P-005): judge each newly-ingressed head against contribution
 *      revocation; the `lastAdmitted` watermark advances ONLY on admitted heads
 *      (persisted by the caller — git-sync-action keeps it in routine metadata).
 *   3. EGRESS (P-001): publish the hive canonical staging ref FF-only+CAS to
 *      the remote resolveForkPushTarget picks (fork wins — D-007b; no fork +
 *      no upstream write ⇒ egress skipped, commit-only semantics preserved).
 *   4. DIVERGENCE (P-006): fold the residues into the `github-bridge`
 *      escalation row — reported, never applied; origin is NEVER force-pushed.
 *
 * Push races between two members that both think they hold the bridge are SAFE
 * by construction (egress is FF-only + CAS: one wins, the other reports
 * rejectedNonFF/upToDate) — the integrator-lease affinity (D-002) is an
 * optimization seam (`isBridgeWriter`), not a correctness requirement.
 *
 * Every mechanism is an injectable seam; the default wiring is the real one.
 * Never throws — the tick reports, the routine records.
 */
import { hiveGitRepoPath, defaultRunGit, type RunGit } from './storage';
import { ingressOriginBranches, type IngressResult, type IngressInput } from './github-ingress';
import { admitGithubOriginHead, type AdmissionResult, type AdmissionInput } from './github-ingress-admission';
import { egressCanonicalRefs, type EgressResult, type EgressInput } from './github-egress';
import {
  collectDivergenceSignals,
  classifyDivergence,
  recordDivergenceVerdict,
  type DivergenceVerdict,
} from './github-divergence';
import { resolveForkPushTarget, type ForkPushTarget } from '../../harness/git-sync/fork-remote';

/** The URL-scoped helper key used by GitHub checkouts created by Papercusp. */
export const GITHUB_CREDENTIAL_HELPER_KEY = 'credential.https://github.com.helper';

const GITHUB_REMOTE_RE = /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/i;

/**
 * Route only GitHub network commands through a helper selected from the
 * registered checkout's local config. The bridge operates in a bare store, so
 * changing its cwd would lose the destination for fetch/update refs; process-
 * local `-c` values preserve the bare-store cwd and also survive the spawner
 * sidecar, which receives the exact argv unchanged.
 *
 * The empty value is intentional: Git supports multiple credential helpers,
 * and the machine-global helper may return a different GitHub account before
 * the checkout-pinned helper gets a chance to answer. Resetting the key first
 * makes the checkout's selected helper authoritative for this one command.
 */
export function withGithubCredentialHelper(runGit: RunGit, helper: string | null | undefined): RunGit {
  const selected = helper?.trim();
  if (!selected || /[\r\n]/.test(selected)) return runGit;

  return (args, cwd, opts) => {
    if (!args.some((arg) => GITHUB_REMOTE_RE.test(arg))) return runGit(args, cwd, opts);
    return runGit(
      ['-c', `${GITHUB_CREDENTIAL_HELPER_KEY}=`, '-c', `${GITHUB_CREDENTIAL_HELPER_KEY}=${selected}`, ...args],
      cwd,
      opts,
    );
  };
}

/** The canonical staging mirror the worktree bridge maintains in the bare repo. */
export const BRIDGE_CANONICAL_REF = 'refs/hive/staging';
/** Where the canonical staging egresses to on the GitHub remote. */
export const BRIDGE_REMOTE_STAGING_REF = 'refs/heads/staging';

export interface BridgeTickInput {
  /** P517 single owning-hive publication authority (ingress remains readable by peers). */
  scope?: import('./signed-context').SignedProtocolScope;
  authority?: import('./hive-effect-authority').HiveEffectAuthority | null;
  potHomeSlug: string;
  workspaceId: string;
  /** The member repo key under the pot-git root (usually the member slug). */
  repoKey: string;
  /** Registry coords: the upstream GitHub remote (read + candidate push). */
  githubRemote?: string;
  /** Registered full checkout used to repair shallow bare-store ancestry locally. */
  historySourcePath?: string;
  /** Registry `fork_remote` — when set, egress pushes the fork, never upstream. */
  forkRemote?: string;
  /** Branches to ingress (WITHOUT refs/heads/); e.g. ['main']. */
  branches: string[];
  /** GitHub `permissions.push` on the upstream (null/undefined = unknown). */
  upstreamWrite?: boolean | null;
  /**
   * The last non-empty `credential.https://github.com.helper` value from the
   * registered checkout's local config. The bridge's bare store does not have
   * that checkout config, so network commands apply it process-locally.
   */
  githubCredentialHelper?: string | null;
  /** The last ADMITTED github-origin head (caller-persisted watermark). */
  lastAdmitted: string | null;
  /**
   * EI-18751829787526583: the last ACCEPTED worktree-bridge watermark
   * (`worktree_bridge.stagingSha` — the local "branch tip" canonical is
   * supposed to track). When set and the bare-store canonical ref (read
   * fresh below) is a STRICT ANCESTOR of it — i.e. canonical exists but is
   * behind — the tick surfaces `egress-canonical-stale` so a frozen-but-green
   * bridge is detectable instead of silently reading `divergence: clear`.
   * Omit when the caller has no watermark to compare against (staleness
   * detection is then simply skipped, exactly like today).
   */
  expectedCanonicalSha?: string | null;
  deps?: {
    runGit?: RunGit;
    repoPath?: string;
    ingress?: (i: IngressInput) => Promise<IngressResult>;
    admit?: (i: AdmissionInput) => Promise<AdmissionResult>;
    egress?: (i: EgressInput) => Promise<EgressResult>;
    record?: (hive: string, ws: string, v: DivergenceVerdict) => Promise<void>;
    /** D-002 affinity seam: only the bridge writer egresses (default: true —
     *  FF-only+CAS makes a stray second writer safe, just noisy). */
    isBridgeWriter?: () => Promise<boolean>;
  };
}

export interface BridgeTickOutcome {
  ran: boolean;
  /** Why the pass (or a leg) was skipped. */
  skipped?: 'no_github_remote' | 'not_bridge_writer';
  egressTarget: ForkPushTarget['target'] | 'skipped';
  ingressed: { updated: number; upToDate: number; nonFF: number; absent: number };
  admissions: Array<{ head: string; admit: boolean; basis: AdmissionResult['basis'] }>;
  /** The advanced watermark — caller persists it. Unchanged when nothing admitted. */
  lastAdmitted: string | null;
  egress: { pushed: number; upToDate: number; rejectedNonFF: number; blockedSecrets: number } | null;
  /** WI-5738: the sha egress ACTUALLY landed on the remote staging ref this
   *  tick (or that the remote already held). This is the only local, truthful
   *  watermark of what GitHub has — the origin-freshness watchdog measured
   *  against the INGRESS mirror of `github_default_branch` instead, which on
   *  papercusp is `main`. main is fast-forwarded hourly by the RELEASE
   *  pipeline, so both of the watchdog's staleness signals were permanently
   *  neutralised (ahead-count stayed ~24 < 50, and the tracked tip never aged
   *  past ~1h) while the actual egress target, origin/staging, sat frozen for
   *  five days. Same ingress-vs-egress conflation as the incident write-up's
   *  own framing error. */
  egressHead?: string | null;
  verdict: DivergenceVerdict;
  errors: string[];
}

/** Resolve the bare repo's canonical staging sha (null = not established yet). */
async function readCanonicalSha(repoPath: string, runGit: RunGit): Promise<string | null> {
  const r = await runGit(['rev-parse', '--verify', '--quiet', BRIDGE_CANONICAL_REF], repoPath);
  const sha = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * EI-18751829787526583: is `ancestorSha` a STRICT ancestor of `descendantSha`
 * (both objects already local — no fetch)? Returns the commit count strictly
 * between them (0 when equal or not an ancestor — the caller only acts on a
 * positive count). Never throws: a missing object / non-commit ref reads as
 * "not an ancestor" rather than failing the whole tick.
 */
async function countStrictlyBehind(
  repoPath: string,
  ancestorSha: string,
  descendantSha: string,
  runGit: RunGit,
): Promise<number> {
  if (ancestorSha === descendantSha) return 0;
  const isAncestor = await runGit(['merge-base', '--is-ancestor', ancestorSha, descendantSha], repoPath);
  if (isAncestor.code !== 0) return 0; // diverged / not an ancestor / object missing — not our case
  const count = await runGit(['rev-list', '--count', `${ancestorSha}..${descendantSha}`], repoPath);
  const n = Number.parseInt(count.stdout.trim(), 10);
  return count.code === 0 && Number.isFinite(n) && n > 0 ? n : 0;
}

export async function runGithubBridgeTick(input: BridgeTickInput): Promise<BridgeTickOutcome> {
  const errors: string[] = [];
  const runGit = withGithubCredentialHelper(input.deps?.runGit ?? defaultRunGit, input.githubCredentialHelper);
  const repoPath = input.deps?.repoPath ?? hiveGitRepoPath(input.potHomeSlug, input.repoKey);
  const record = input.deps?.record ?? ((h, w, v) => recordDivergenceVerdict(h, w, v));

  const empty: BridgeTickOutcome = {
    ran: false,
    egressTarget: 'skipped',
    ingressed: { updated: 0, upToDate: 0, nonFF: 0, absent: 0 },
    admissions: [],
    lastAdmitted: input.lastAdmitted,
    egress: null,
    verdict: classifyDivergence([]),
    errors,
  };

  // No GitHub remote at all → nothing to bridge (a p2p-only-shaped repo).
  if (!input.githubRemote) return { ...empty, skipped: 'no_github_remote' };

  // The two seam outcomes must stay DISTINGUISHABLE (WI-10002587):
  //   - `false`  → a deliberate affinity skip, reported as `skipped: 'not_bridge_writer'`.
  //   - a throw  → an unknown answer, NOT a "no". Record the error and PROCEED: the seam is
  //     an optimization (see the header), and publication stays guarded where it matters —
  //     egress is FF-only + CAS, and `requireHiveEffectAuthority` in github-egress fails closed
  //     without the P517 owning-hive authority. Failing closed here would silently turn a
  //     flaky affinity lookup into "this member never bridges" while reading like a normal skip.
  if (input.deps?.isBridgeWriter) {
    let isWriter: boolean | null = null;
    try {
      isWriter = await input.deps.isBridgeWriter();
    } catch (e) {
      errors.push(
        `isBridgeWriter seam failed (proceeding — egress stays guarded by FF-only CAS and the hive-effect authority): ${
          e instanceof Error ? e.message : e
        }`,
      );
    }
    if (isWriter === false) return { ...empty, skipped: 'not_bridge_writer' };
  }

  // 1. INGRESS — always from the UPSTREAM remote (the fork is a push target,
  //    never the read source: legacy humans/PR merges land upstream).
  const ingress = await (input.deps?.ingress ?? ingressOriginBranches)({
    repoPath,
    remoteUrl: input.githubRemote,
    historySourcePath: input.historySourcePath,
    branches: input.branches,
    runGit,
  });
  errors.push(...ingress.errors.map((e) => `ingress${e.branch ? ` ${e.branch}` : ''}: ${e.message}`));

  // Ingress that failed for EVERY requested branch means the REMOTE is
  // unreachable, not that a branch diverged — and every structured residue is
  // then empty for the wrong reason, so the tick would classify `clear` while
  // the bridge is inert. Surface it as its own signal (oddsmith, 2026-07-19).
  const ingressReachedNothing =
    input.branches.length > 0 &&
    ingress.updated.length === 0 &&
    ingress.upToDate.length === 0 &&
    ingress.nonFF.length === 0 &&
    ingress.absent.length === 0 &&
    ingress.errors.length > 0;
  const remoteUnreachable = ingressReachedNothing
    ? {
        remoteUrl: input.githubRemote ?? null,
        branches: [...input.branches],
        errors: ingress.errors.map((e) => e.message),
        // Every failing branch traced to a process-level spawn/timeout fault
        // (the git transport never even ran), not an actual credential/URL
        // problem — surfaced so the divergence policy doesn't tell an owner
        // to "fix the remote" for a transient env hiccup (2026-07-20, three
        // harnesses hit `spawn git ENOENT` right after a bg-host restart,
        // all self-cleared within minutes; EI-18152354175913564).
        transient: ingress.errors.length > 0 && ingress.errors.every((e) => e.transient === true),
      }
    : null;

  // 2. ADMISSION — judge each moved head; advance the watermark only on admits.
  const admissions: BridgeTickOutcome['admissions'] = [];
  const admissionResults: Array<{ head: string; result: AdmissionResult }> = [];
  let lastAdmitted = input.lastAdmitted;
  for (const u of ingress.updated) {
    const result = await (input.deps?.admit ?? admitGithubOriginHead)({
      repoPath,
      lastAdmitted,
      head: u.to,
      workspaceId: input.workspaceId,
      potHomeSlug: input.potHomeSlug,
      runGit,
    });
    admissionResults.push({ head: u.to, result });
    admissions.push({ head: u.to, admit: result.admit, basis: result.basis });
    if (result.admit) lastAdmitted = u.to;
    errors.push(...result.errors.map((e) => `admission ${u.to.slice(0, 12)}: ${e}`));
  }

  // 3. EGRESS — canonical staging, FF-only + CAS, to the D-007b-resolved target.
  const target = resolveForkPushTarget({
    forkRemote: input.forkRemote,
    upstreamRemote: input.githubRemote,
    upstreamWrite: input.upstreamWrite,
  });
  let egress: EgressResult | null = null;
  // A live target with NO canonical ref is a fault, not a quiet no-op: left
  // unsignalled it reports `egress: null` + verdict 'clear' on every tick while
  // origin freezes indefinitely (the hello-world-3-pot canary sat ~22h / 8
  // commits behind reading green). Surface it so divergence escalates.
  let canonicalMissing: { canonicalRef: string; watermarkSha: string | null } | null = null;
  // EI-18751829787526583: canonical EXISTS but is a strict ancestor of the
  // accepted worktree-bridge watermark — the sibling gap to canonicalMissing.
  let canonicalStale: { canonicalSha: string; expectedSha: string; behindCount: number } | null = null;
  let canonicalShaForWatermark: string | null = null;
  if (target.target !== 'none') {
    const canonicalSha = await readCanonicalSha(repoPath, runGit);
    canonicalShaForWatermark = canonicalSha;
    if (canonicalSha) {
      if (input.expectedCanonicalSha && input.expectedCanonicalSha !== canonicalSha) {
        const behindCount = await countStrictlyBehind(repoPath, canonicalSha, input.expectedCanonicalSha, runGit);
        if (behindCount > 0) {
          canonicalStale = { canonicalSha, expectedSha: input.expectedCanonicalSha, behindCount };
          errors.push(
            `egress: canonical ref ${BRIDGE_CANONICAL_REF} is STALE in ${repoPath} — ${behindCount} commit(s) behind ` +
              `the accepted watermark ${input.expectedCanonicalSha.slice(0, 12)} (publishing the stale content this tick; ` +
              `the catch-up pin re-anchors canonical on the next git-sync tick)`,
          );
        }
      }
      egress = await (input.deps?.egress ?? egressCanonicalRefs)({
        scope: input.scope,
        authority: input.authority,
        repoPath,
        remoteUrl: target.remote,
        refs: [{ sha: canonicalSha, remoteRef: BRIDGE_REMOTE_STAGING_REF }],
        runGit,
        // WI-5738: the runtime secrets-guard path exemptions apply HERE too.
        // Without this the egress guard consulted none, so the no-restart
        // escape hatch existed only on the guard that was NOT wedged.
        workspaceId: input.workspaceId,
      });
      errors.push(...egress.errors.map((e) => `egress: ${e}`));
      if (egress.exemptedFindings.length > 0) {
        console.warn(
          `[github-bridge] ${input.potHomeSlug}: egress — ${egress.exemptedFindings.length} secret-scanner finding(s) ` +
            `suppressed by a runtime path exemption: ${egress.exemptedFindings
              .slice(0, 5)
              .map((f) => `${f.path}:${f.line} [${f.rule}]`)
              .join('; ')}`,
        );
      }
    } else {
      canonicalMissing = { canonicalRef: BRIDGE_CANONICAL_REF, watermarkSha: input.lastAdmitted };
      errors.push(
        `egress: canonical ref ${BRIDGE_CANONICAL_REF} is absent in ${repoPath} — nothing egressed (origin stays frozen until the integrator or the catch-up pin establishes it)`,
      );
    }
  }

  // 4. DIVERGENCE — fold residues, write/clear the escalation (best-effort).
  const verdict = classifyDivergence(
    collectDivergenceSignals({
      egress,
      ingress,
      admissions: admissionResults,
      canonicalMissing,
      canonicalStale,
      remoteUnreachable,
    }),
  );
  await record(input.potHomeSlug, input.workspaceId, verdict);

  return {
    ran: true,
    egressTarget: target.target === 'none' ? 'skipped' : target.target,
    ingressed: {
      updated: ingress.updated.length,
      upToDate: ingress.upToDate.length,
      nonFF: ingress.nonFF.length,
      absent: ingress.absent.length,
    },
    admissions,
    lastAdmitted,
    egress: egress
      ? {
          pushed: egress.pushed.length,
          upToDate: egress.upToDate.length,
          rejectedNonFF: egress.rejectedNonFF.length,
          blockedSecrets: egress.blockedSecrets.length,
        }
      : null,
    egressHead:
      egress?.pushed.find((p) => p.remoteRef === BRIDGE_REMOTE_STAGING_REF)?.to ??
      (egress?.upToDate.includes(BRIDGE_REMOTE_STAGING_REF) ? canonicalShaForWatermark : null),
    verdict,
    errors,
  };
}
