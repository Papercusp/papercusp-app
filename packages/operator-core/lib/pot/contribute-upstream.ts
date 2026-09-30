/**
 * contributeUpstream — the OWNER-AUTHORIZED upstream-contribution flow
 * (per-hive-learning-loops-2026-06-14 P-072; D-006/D-007/D-008).
 *
 * The OUTWARD-FACING leg of platform mode ("Papercusp inside Papercusp"). Where
 * platform:enable (P-071) stood Papercusp's own repo up as a private self-managed
 * shared Pot that dogfoods locally, this sends a LOCAL improvement UPSTREAM —
 * the collaboration flywheel D-007 ratified, via BOTH proven round-trips:
 *
 *   kind:'knowledge-pack' (the Comb path) — distill the self-pot's ORGANIC
 *     learnings into a pack dir (knowledge_packs:export's core) and LIST it on the
 *     Comb (knowledge_packs:publish's core). The listing lands PENDING behind the
 *     D-007 operator-approval moderation gate — never auto-public.
 *
 *   kind:'pr' (the fork-PR path) — commit + push the local change to the USER'S
 *     OWN FORK (never canonical Papercusp), then open a human-reviewed PR
 *     fork→canonical via the existing octokit PR host (open-fork-pr's core). A
 *     user's loop NEVER direct-pushes to canonical Papercusp (D-007).
 *
 * SAFETY MODEL — "prepared, not sent" by default:
 *   - Every LIVE outward action (git push, gh PR create, Comb publish) is gated
 *     behind `confirm: true` AND the required credentials/remote being present.
 *     Without confirm, or without creds, this returns `{ ok, prepared: true,
 *     needs: [...] }` — it NEVER throws and NEVER auto-fires an outward action.
 *   - The Comb publish stays PENDING (moderation-gated). The PR targets the
 *     user's fork → upstream (human-reviewed). Neither path can direct-push to
 *     canonical Papercusp.
 *
 * Every external effect (resolve the self-pot member, export, publish,
 * pushToFork, openPr, resolve gh token) is an injectable seam so the whole flow
 * is unit-testable with NO real IO — mirrors enable-platform-mode.ts's pattern.
 *
 * The fork URL is supplied as a LOCAL CONFIG SEAM: the self-pot member's
 * registry `fork_remote` (set via the fork-remote config write — a pure registry
 * mutation, no outward action; see lib/harness/git-sync/fork-remote.ts). Absent a
 * fork_remote, the PR path returns prepared with `needs: ['fork_remote']` rather
 * than direct-pushing the canonical repo.
 */
import { loadHarnessRegistry, type ProjectEntry } from '../harness-registry';
import { activeWorkspaceId } from '../workspace-registry';
import { PLATFORM_SELF_POT_SLUG, PAPERCUSP_CANONICAL_REPO_URL } from './enable-platform-mode';
import { exportHiveLearningsToPack, type ExportPackResult } from '../knowledge-packs/export';
import { publishListingToCupboard, type CupboardPublishResult } from '../cupboard/publish-listing';
import {
  resolveRepoCoordsFromDir,
  gitOriginUrl,
  fetchGithubRepoMeta,
} from '../cupboard/resolve-repo-coords';
import { openForkPr, type OpenForkPrResult } from '../harness/open-fork-pr';
import { parseRemote } from '../pr-host/github';
import { getGhAuthToken } from '../identity/gh-token';

// ── Shared shapes ──────────────────────────────────────────────────────────────

export type ContributeKind = 'knowledge-pack' | 'pr';

/**
 * The resolved self-pot member checkout the contribution operates over: the
 * member harness whose `hive_slug` is the platform self-pot home. Carries the
 * working-tree path + the upstream/fork coords the two paths read.
 */
export interface SelfPotMember {
  /** The member harness slug (e.g. `papercusp-platform`). */
  memberSlug: string;
  /** The pot home slug (e.g. `papercusp-platform-pot`). */
  potSlug: string;
  /** Absolute path of the member's working tree (the push source / export target). */
  path: string;
  /** Normalized HTTPS clone URL of the upstream (canonical Papercusp). */
  upstreamRemote?: string;
  /** Upstream default branch the PR targets (else 'main'). */
  defaultBranch?: string;
  /** The user's OWN fork remote — the contribution lane (D-007b). Absent ⇒ no fork. */
  forkRemote?: string;
}

export interface ContributeUpstreamInput {
  /** Which round-trip: the Comb knowledge-pack, or the fork→canonical PR. */
  kind: ContributeKind;
  /**
   * Fire the LIVE outward action (push + PR / Comb publish). When false/omitted,
   * the flow returns a "prepared, not sent" result — it resolves what it WOULD do
   * and what it needs, but performs ZERO outward action (D-007 gate).
   */
  confirm?: boolean;
  workspaceId?: string;
  /** Override the self-pot base slug (default `papercusp-platform`). */
  slug?: string;

  // ── knowledge-pack path inputs ──
  /** Kebab-case pack id (becomes the Comb listing_ref). Required for kind:'knowledge-pack'. */
  packId?: string;
  title?: string;
  description?: string;
  version?: string;
  /** Re-export installed-pack content too (explicit opt-in). Default false (organic only). */
  includePackRows?: boolean;

  // ── pr path inputs ──
  /** The local feature branch holding the change's commits. Required for kind:'pr'. */
  featureBranch?: string;
  prTitle?: string;
  prBody?: string;

  // ── injectable seams (real defaults below) — every external effect is a seam ──
  /** Resolve the platform self-pot member checkout. Default: registry read. */
  resolveSelfPotMember?: (
    slug: string,
    workspaceId: string,
  ) => Promise<SelfPotMember | null>;
  /** Distill the pot's learnings into a pack dir. Default: exportHiveLearningsToPack. */
  exportPack?: typeof exportHiveLearningsToPack;
  /** List the exported pack on the Comb (lands PENDING). Default: the publish core. */
  publishPack?: (member: SelfPotMember, args: {
    packId: string;
    title: string;
    description: string;
  }) => Promise<PublishPackOutcome>;
  /** Commit + push to the fork and open the cross-fork PR. Default: openForkPr. */
  pushAndOpenPr?: (member: SelfPotMember, args: {
    featureBranch: string;
    title: string;
    body: string;
    token: string;
  }) => Promise<OpenForkPrResult>;
  /** Resolve the gh token (credential presence gate). Default: getGhAuthToken. */
  resolveGhToken?: () => Promise<{ ok: true; token: string } | { ok: false; reason: string }>;
  /**
   * PR-4 (b): track the WI↔PR row when a fork→canonical PR opens (the manual
   * contribute path the brief calls out alongside the autonomous hook). Default:
   * the real producer (`upsertFeaturePrOnOpen`) keyed by the member harness +
   * featureBranch, attributed to the operator. BEST-EFFORT — a write failure
   * never fails the (already-opened) PR.
   */
  recordFeaturePr?: (row: {
    workspaceId: string;
    harnessSlug: string;
    featureId: string;
    prUrl: string;
  }) => Promise<void>;
}

export type PublishPackOutcome =
  | { ok: true; listingId?: string; reviewStatus: string }
  | { ok: false; error: string; detail?: unknown };

/**
 * The result. `prepared:true` ⇒ the outward action was NOT fired (no confirm, or
 * a missing prerequisite in `needs`); `sent:true` ⇒ the live action ran. Both are
 * `ok` shapes — a prepared result is a SUCCESS (the flow correctly declined to
 * fire), not an error.
 */
export type ContributeUpstreamResult =
  | {
      ok: true;
      kind: ContributeKind;
      prepared: true;
      /** Why nothing was sent: missing confirm and/or prerequisites. */
      needs: string[];
      /** What WOULD happen if re-run with confirm + the prerequisites satisfied. */
      plan: Record<string, unknown>;
      summary: string;
    }
  | {
      ok: true;
      kind: ContributeKind;
      sent: true;
      /** The outward-action outcome (PENDING listing / fork-PR coords). */
      result: Record<string, unknown>;
      summary: string;
    }
  | {
      ok: false;
      kind: ContributeKind;
      error: string;
      message?: string;
    };

// ── Default seams ───────────────────────────────────────────────────────────────

/**
 * Resolve the platform self-pot member from the workspace registry: the member
 * harness whose `hive_slug` is the self-pot home AND that holds a real working
 * tree (the home harness itself has no upstream checkout). The home slug is
 * `<base>-pot`; the member is `<base>` (createPotFromRepo's deriveSlugs).
 */
export async function defaultResolveSelfPotMember(
  slug: string,
  workspaceId: string,
): Promise<SelfPotMember | null> {
  const reg = await loadHarnessRegistry(workspaceId);
  const potSlug = `${slug}-pot`;
  // Prefer the member whose hive_slug points at the self-pot home AND has an
  // upstream remote (the cloned Papercusp checkout). Fall back to any member of
  // the pot with a path, so a fork-only / coords-less member still resolves.
  const members = reg.projects.filter(
    (p: ProjectEntry) => p.hive_slug === potSlug && p.harness_kind !== 'hive' && p.path,
  );
  const member =
    members.find((p) => Boolean(p.github_remote)) ?? members[0];
  if (!member) return null;
  return {
    memberSlug: member.slug,
    potSlug,
    path: member.path,
    ...(member.github_remote ? { upstreamRemote: member.github_remote } : {}),
    ...(member.github_default_branch ? { defaultBranch: member.github_default_branch } : {}),
    ...(member.fork_remote ? { forkRemote: member.fork_remote } : {}),
  };
}

/** Default publish seam: resolve the member repo's GitHub coords, then publish a
 *  PENDING knowledge-pack listing via the one server-side publish core. */
async function defaultPublishPack(
  member: SelfPotMember,
  args: { packId: string; title: string; description: string },
): Promise<PublishPackOutcome> {
  const coords = await resolveRepoCoordsFromDir(member.path, {
    getOriginUrl: gitOriginUrl,
    fetchRepoMeta: fetchGithubRepoMeta,
  });
  if (!coords || 'error' in coords) {
    return {
      ok: false,
      error: 'repo_coords_unresolvable',
      ...(coords && 'error' in coords ? { detail: coords.error } : {}),
    };
  }
  const res: CupboardPublishResult = await publishListingToCupboard({
    listing_kind: 'knowledge-pack',
    listing_ref: args.packId,
    project_ref: `${coords.github_owner}/${coords.github_name}`,
    github_repository_id: coords.github_repository_id,
    github_owner: coords.github_owner,
    github_name: coords.github_name,
    github_url: coords.github_url,
    title: args.title,
    description: args.description,
  });
  if (!res.ok) return { ok: false, error: res.error, detail: res.detail };
  const data = res.data as { id?: string; review_status?: string };
  return { ok: true, listingId: data.id, reviewStatus: data.review_status ?? 'pending' };
}

/** Default PR seam: commit + push the feature branch to the user's fork and open
 *  the cross-fork PR fork→canonical via the octokit PR host (open-fork-pr core). */
async function defaultPushAndOpenPr(
  member: SelfPotMember,
  args: { featureBranch: string; title: string; body: string; token: string },
): Promise<OpenForkPrResult> {
  // The PR ALWAYS targets the canonical upstream (never the fork as base): the
  // self-pot's upstream remote when known, else canonical Papercusp.
  const upstreamUrl = member.upstreamRemote ?? PAPERCUSP_CANONICAL_REPO_URL;
  const parsed = parseRemote(upstreamUrl);
  if (!parsed) {
    return { ok: false, error: `cannot parse upstream remote: ${upstreamUrl}` };
  }
  return openForkPr({
    upstreamRemote: `github.com/${parsed.owner}/${parsed.repo}`,
    upstreamOwner: parsed.owner,
    upstreamRepo: parsed.repo,
    baseBranch: member.defaultBranch ?? 'main',
    featureBranch: args.featureBranch,
    localRepoPath: member.path,
    title: args.title,
    body: args.body,
    token: args.token,
  });
}

async function defaultResolveGhToken(): Promise<
  { ok: true; token: string } | { ok: false; reason: string }
> {
  const r = await getGhAuthToken();
  return r.kind === 'ok' ? { ok: true, token: r.token } : { ok: false, reason: r.error.kind };
}

/**
 * Default PR-4 producer seam: UPSERT the WI↔PR row for a manual fork→canonical
 * contribution, attributed to the resolved operator. Dynamic imports keep this
 * module's static graph IO-free (the rest of the flow is seam-injected). The
 * operator id is resolved best-effort (null when gh can't answer); the whole
 * thing swallows errors — the PR already opened.
 */
async function defaultRecordFeaturePr(row: {
  workspaceId: string;
  harnessSlug: string;
  featureId: string;
  prUrl: string;
}): Promise<void> {
  const { upsertFeaturePrOnOpen } = await import('../harness/feature-pr-producer');
  const { getAuthenticatedGithubUser } = await import('../identity/resolve-local-github-identity');
  let authorGithubUserId: number | null = null;
  try {
    const user = await getAuthenticatedGithubUser();
    if (user) authorGithubUserId = user.id;
  } catch {
    /* identity best-effort — record the PR even without the operator id */
  }
  await upsertFeaturePrOnOpen({ ...row, authorGithubUserId });
}

// ── The composition ────────────────────────────────────────────────────────────

export async function contributeUpstream(
  input: ContributeUpstreamInput,
): Promise<ContributeUpstreamResult> {
  const workspaceId = input.workspaceId ?? activeWorkspaceId();
  const slug = input.slug ?? PLATFORM_SELF_POT_SLUG;
  const resolveMember = input.resolveSelfPotMember ?? defaultResolveSelfPotMember;
  const exportPack = input.exportPack ?? exportHiveLearningsToPack;
  const publishPack = input.publishPack ?? defaultPublishPack;
  const pushAndOpenPr = input.pushAndOpenPr ?? defaultPushAndOpenPr;
  const resolveGhToken = input.resolveGhToken ?? defaultResolveGhToken;
  const recordFeaturePr = input.recordFeaturePr ?? defaultRecordFeaturePr;

  // Resolve the self-pot member checkout. No self-pot ⇒ platform mode was never
  // enabled — a clean error, never a throw (the user must platform:enable first).
  let member: SelfPotMember | null;
  try {
    member = await resolveMember(slug, workspaceId);
  } catch (e) {
    return {
      ok: false,
      kind: input.kind,
      error: 'self_hive_resolve_failed',
      message: e instanceof Error ? e.message : String(e),
    };
  }
  if (!member) {
    return {
      ok: false,
      kind: input.kind,
      error: 'self_hive_not_found',
      message: `No platform self-pot '${slug}-pot' member checkout in this workspace — run platform:enable first.`,
    };
  }

  if (input.kind === 'knowledge-pack') {
    return contributeKnowledgePack(input, member, { exportPack, publishPack });
  }
  return contributePr(input, member, { pushAndOpenPr, resolveGhToken, recordFeaturePr, workspaceId });
}

// ── kind: 'knowledge-pack' (the Comb path) ──────────────────────────────────────

async function contributeKnowledgePack(
  input: ContributeUpstreamInput,
  member: SelfPotMember,
  seams: {
    exportPack: typeof exportHiveLearningsToPack;
    publishPack: (
      member: SelfPotMember,
      args: { packId: string; title: string; description: string },
    ) => Promise<PublishPackOutcome>;
  },
): Promise<ContributeUpstreamResult> {
  const packId = input.packId;
  const title = input.title;
  const description = input.description;

  // Arg validation up front — a missing required field is a `needs`, not a throw.
  const missing: string[] = [];
  if (!packId) missing.push('packId');
  if (!title) missing.push('title');
  if (!description) missing.push('description');

  // Always export FIRST — distilling the pack dir is a local write (no outward
  // action), so it runs even when not confirmed, to surface what would be sent.
  let exported: ExportPackResult | null = null;
  if (packId && title && description) {
    try {
      exported = await seams.exportPack({
        potSlug: member.potSlug,
        packId,
        title,
        description,
        ...(input.version ? { version: input.version } : {}),
        targetDir: member.path,
        ...(input.includePackRows !== undefined ? { includePackRows: input.includePackRows } : {}),
      });
    } catch (e) {
      return {
        ok: false,
        kind: 'knowledge-pack',
        error: 'export_failed',
        message: e instanceof Error ? e.message : String(e),
      };
    }
    if (!exported.ok) {
      return {
        ok: false,
        kind: 'knowledge-pack',
        error: exported.error ?? 'export_failed',
        message: 'Nothing to export — the self-pot has no organic learnings yet.',
      };
    }
  }

  // GATE: fire the Comb publish ONLY when confirmed AND the export succeeded.
  if (!input.confirm || missing.length > 0) {
    const needs = [...missing, ...(input.confirm ? [] : ['confirm'])];
    return {
      ok: true,
      kind: 'knowledge-pack',
      prepared: true,
      needs,
      plan: {
        action: 'export → publish (Comb)',
        potSlug: member.potSlug,
        memberPath: member.path,
        ...(exported?.ok ? { exported: exported.exported, packDir: exported.packDir } : {}),
        moderation: 'the Comb listing publishes PENDING (operator approval gates public visibility, D-007)',
      },
      summary:
        `Prepared a knowledge-pack contribution${exported?.ok ? ` (${exported.exported} learning(s) exported)` : ''}` +
        ` — NOT published. Re-run with ${needs.map((n) => `${n}${n === 'confirm' ? ':true' : ''}`).join(' + ')} to list it on the Comb (PENDING).`,
    };
  }

  // SEND: list the pack on the Comb. It lands PENDING (moderation-gated) — the
  // publish core enforces this; we surface the review status.
  const pub = await seams.publishPack(member, { packId: packId!, title: title!, description: description! });
  if (!pub.ok) {
    return {
      ok: false,
      kind: 'knowledge-pack',
      error: pub.error,
      message: typeof pub.detail === 'string' ? pub.detail : undefined,
    };
  }
  return {
    ok: true,
    kind: 'knowledge-pack',
    sent: true,
    result: {
      ...(pub.listingId ? { listingId: pub.listingId } : {}),
      reviewStatus: pub.reviewStatus,
      ...(exported?.ok ? { exported: exported.exported } : {}),
    },
    summary:
      `Knowledge-pack listed on the Comb as ${pub.reviewStatus.toUpperCase()}` +
      ` — an operator must approve it before it is publicly visible (D-007 moderation gate).`,
  };
}

// ── kind: 'pr' (the fork→canonical PR path) ────────────────────────────────────

async function contributePr(
  input: ContributeUpstreamInput,
  member: SelfPotMember,
  seams: {
    pushAndOpenPr: (
      member: SelfPotMember,
      args: { featureBranch: string; title: string; body: string; token: string },
    ) => Promise<OpenForkPrResult>;
    resolveGhToken: () => Promise<{ ok: true; token: string } | { ok: false; reason: string }>;
    recordFeaturePr: (row: {
      workspaceId: string;
      harnessSlug: string;
      featureId: string;
      prUrl: string;
    }) => Promise<void>;
    workspaceId: string;
  },
): Promise<ContributeUpstreamResult> {
  const featureBranch = input.featureBranch;
  const title = input.prTitle;
  const body = input.prBody;

  // Prerequisites — each missing one is a `needs`, never a throw:
  //   - featureBranch + title + body (the change to send),
  //   - fork_remote (D-007: the contribution lane pushes the user's fork; without
  //     it we MUST NOT direct-push canonical Papercusp),
  //   - a gh token (push + PR create both need it),
  //   - confirm.
  const needs: string[] = [];
  if (!featureBranch) needs.push('featureBranch');
  if (!title) needs.push('prTitle');
  if (!body) needs.push('prBody');
  if (!member.forkRemote) needs.push('fork_remote');

  // Credential presence gate — resolved even when not confirmed, so a prepared
  // result tells the owner whether gh auth is the blocker.
  const token = await seams.resolveGhToken();
  if (!token.ok) needs.push('gh_auth');

  if (!input.confirm) needs.push('confirm');

  // GATE: fire the live push + PR ONLY when confirmed, every prereq present, and
  // a fork is configured (NEVER direct-push canonical Papercusp — D-007).
  if (needs.length > 0) {
    return {
      ok: true,
      kind: 'pr',
      prepared: true,
      needs,
      plan: {
        action: 'commit/push → fork → open PR fork→canonical',
        memberSlug: member.memberSlug,
        memberPath: member.path,
        upstream: member.upstreamRemote ?? PAPERCUSP_CANONICAL_REPO_URL,
        baseBranch: member.defaultBranch ?? 'main',
        forkRemote: member.forkRemote ?? null,
        ...(featureBranch ? { featureBranch } : {}),
        safety:
          'pushes the user\'s fork (never canonical Papercusp); the PR is human-reviewed fork→upstream (D-007)',
        ...(member.forkRemote
          ? {}
          : { forkHint: 'configure the self-pot member\'s fork_remote (lib/harness/git-sync/fork-remote.ts setForkRemote) — a local registry write, no outward action' }),
      },
      summary:
        `Prepared a fork-PR contribution — NOT sent.` +
        ` Re-run with ${needs.map((n) => `${n}${n === 'confirm' ? ':true' : ''}`).join(' + ')} satisfied` +
        ` to push to your fork and open a PR into canonical Papercusp.`,
    };
  }

  // SEND: push to the fork + open the cross-fork PR. openForkPr ensures the fork,
  // pushes the branch to it (NOT canonical), and opens fork→upstream. The token
  // is guaranteed present here (the gate above added 'gh_auth' to needs otherwise).
  const pr = await seams.pushAndOpenPr(member, {
    featureBranch: featureBranch!,
    title: title!,
    body: body!,
    token: (token as { ok: true; token: string }).token,
  });
  if (!pr.ok) {
    return { ok: false, kind: 'pr', error: 'fork_pr_failed', message: pr.error };
  }
  // PR-4 (b): track this fork→PR (WI→PR row) the moment it opens, attributed to
  // the operator — so it shows in the report GUI + the merge stamps via the row.
  // The featureBranch is this contribution's stable key. Best-effort: the PR
  // already exists, so a producer failure must NOT fail the contribution.
  try {
    await seams.recordFeaturePr({
      workspaceId: seams.workspaceId,
      harnessSlug: member.memberSlug,
      featureId: featureBranch!,
      prUrl: pr.prUrl,
    });
  } catch {
    /* best-effort — the PR opened; tracking is non-fatal */
  }
  return {
    ok: true,
    kind: 'pr',
    sent: true,
    result: {
      forkOwner: pr.forkOwner,
      forkFullName: pr.forkFullName,
      forkCreated: pr.created,
      prNumber: pr.prNumber,
      prUrl: pr.prUrl,
    },
    summary:
      `Opened PR #${pr.prNumber} (${pr.forkFullName} → canonical Papercusp) — ${pr.prUrl}.` +
      ` Pushed to your fork, never canonical; the PR is human-reviewed upstream (D-007).`,
  };
}
