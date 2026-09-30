/**
 * records.ts — the STRUCTURED lifecycle records that replace free-text
 * `coord:send` prose (coord-lifecycle-automation-2026-06-04 D-004 / D-006).
 *
 * The plan's central finding: ~79% of free-text coord `messages` is
 * *predictable lifecycle* (completion, claim, intent/window, finding…). The
 * fix is to stop narrating those in prose and instead carry the same
 * information as a typed record whose `render*()` (see ./render) produces the
 * coord notification deterministically. These Zod schemas are the field design
 * — derived from the REAL corpus (`harness_shared.coord_event_log`, 2026-06-04
 * scan), so a record never loses what the prose said (D-006).
 *
 * A completion message in the wild looked like:
 *   "fleet-as-supervised-blackboard-2026-06-04 BUILT+TESTED (su-d3187): all 5
 *    phases/8 decisions, 67 green tests, migs 146/147/148. Additive, loads next
 *    :3070 restart. SEAMS: governor opt-in, supervise not auto-wired…"
 * — which decomposes cleanly into the fields below.
 */

import { z } from 'zod';
// P-008 (d): type-only, so the payload contract and the resolver cannot disagree
// about the stored shape without a compile error — and so no runtime import cycle
// is created between this module and the facts substrate.
import { COMPLETION_CLAIMS_CONTRACT, CompletionClaimSchema } from '../completion-claims';
import type { CompletionClaimBaseline } from '../completion-claim-recheck';
import type { ResolvedAssumption } from '../agent-facts/assumptions';
// A leaf module with no imports of its own, so this edge cannot form a cycle.
import type { PersistedSelfReviewJudgement } from '../work-item-self-review';
// Pure and import-free, so the residue-ref helper below parses ids with the SAME detector
// the hydration path uses, and this module still adds no runtime import chain.
import { detectBodyRefs } from '../agent-tools/coordination/ref-hydrate';

/** The lifecycle categories this layer renders (the D-003 automation table). */
export const LIFECYCLE_CATEGORIES = [
  'completion',
  'claim',
  'intent',
  'window',
  'handoff',
  'finding',
] as const;
export type LifecycleCategory = (typeof LIFECYCLE_CATEGORIES)[number];

/**
 * HOW the work was verified. WI-4536 originally made this a CLOSED ENUM, but it sits among
 * free-text siblings (`testsRun`, `testResult`) and callers naturally write a concise label
 * such as "macOS Tauri smoke" here. Keep the canonical labels discoverable and queryable,
 * while accepting any non-empty label so a useful verification record is never rejected at
 * the completion boundary. Detailed evidence still belongs in `testsRun` / `testResult`.
 *   unit            — a unit test suite
 *   integration     — an integration test (real PG / containers / a live dependency)
 *   live-drove-ui   — drove the running UI (e.g. the Tauri shell) and observed it
 *   live-service    — restarted/probed a real running process or service (non-UI)
 *   manual          — verified by hand (ran the build/command, inspected real output)
 *   already-passing — no new verification; the existing suite already covered it
 */
export const CompletionVerifiedHowSchema = z
  .string()
  .min(1)
  .describe(
    "HOW it was verified — a non-empty label. Prefer 'unit' | 'integration' | 'live-drove-ui' | 'live-service' | 'manual' | 'already-passing' for queryable coarse modes; concise free-text labels are also accepted. `live-service` means a real running process/service was restarted or probed without driving UI. Put detailed evidence in `testsRun` / `testResult`.",
  );

/**
 * The complete repair contract shown for malformed coverage input.
 *
 * EI-22158326197204788: this text is deliberately PATH-NEUTRAL. `CompletionCoverageSchema`
 * (below) is mounted at two accepted positions — nested `completion.verification.coverage`
 * (canonical) and the flat top-level `completion.coverage` alias (line ~677) — and this same
 * constant is reused verbatim at BOTH mount points via that schema's own `.describe()`. A
 * hardcoded path here was wrong at whichever mount point it didn't name (previously it always
 * said "at completion.verification.coverage", which misdescribed the field when introspected
 * at its top-level `completion.coverage` mount). Callers who need a concrete location for a
 * MISSING coverage record are told the specific accepted paths at the call site instead (see
 * the `verificationCoverageError` messages in complete.ts), where the caller and the correct
 * mount are actually known together.
 */
export const COMPLETION_COVERAGE_CONTRACT =
  'Coverage contract: population, checked, notChecked, and notApplicable are the partition buckets; residue is a separate list, never a fifth bucket. Every population entry must appear verbatim in exactly one status bucket. All buckets are string arrays; an explicit empty residue array (residue:[]) declares zero residue, and residue:[\'none\'] remains accepted as a compatibility form. Universal-verification closes must include the residue array.';

/**
 * Keep the conditional requirement visible in tools:find as well as in the
 * runtime refusal. JSON Schema can describe the coverage object's shape, but
 * it cannot express that a verification-shaped item's universal terminal claim
 * turns this otherwise-optional field into a required one.
 */
export const COMPLETION_COVERAGE_CALL_CONSTRAINT =
  "terminal state=done|resolved|passed => coverage required; population once; residue:[]|residue:['none']";

function isCoverageRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string' && entry.trim().length > 0)
  );
}

/**
 * WI-213058: Zod's nested field errors used to reveal this contract one rule at a time
 * (and made `residue` look like a fifth partition bucket). Emit one actionable contract
 * error for malformed shape input before the child array schemas produce generic errors.
 * Semantic partition accounting is hasEnumeratedVerificationCoverage below.
 */
export function hasMalformedCoverageShape(value: unknown): boolean {
  if (!isCoverageRecord(value) || !isStringArray(value.population)) return true;

  for (const key of ['checked', 'notChecked', 'notApplicable'] as const) {
    const bucket = value[key];
    if (bucket !== undefined && (!Array.isArray(bucket) || !bucket.every((entry) => typeof entry === 'string' && entry.trim()))) {
      return true;
    }
  }

  const residue = value.residue;
  // An empty array has the right shape and is the natural explicit zero-residue
  // form. Shape preflight should only collapse scalar/non-string bucket values
  // into the repair contract.
  return residue !== undefined && !isStringArray(residue);
}

/**
 * A valid coverage record accounts for every named population entry and states
 * the residue explicitly. `residue: []` is the natural zero-residue form and
 * `residue: ['none']` remains accepted for compatibility; omission is not
 * silently treated as complete coverage.
 *
 * It lives here, beside the schema, rather than in complete.ts so a caller that
 * only judges a partition (an LLM scenario oracle) does not import the whole
 * completion tool and its dependency graph.
 */
export function hasEnumeratedVerificationCoverage(coverage: CompletionCoverage | undefined): boolean {
  if (!coverage?.population?.length || coverage.residue === undefined) return false;
  const population = coverage.population;
  const populationSet = new Set(population);
  // A population is an enumeration, not a bag of labels. Duplicate names make an
  // apparently complete partition ambiguous, even when the status buckets are otherwise
  // balanced.
  if (populationSet.size !== population.length) return false;

  const statusEntries = [
    ...(coverage.checked ?? []),
    ...(coverage.notChecked ?? []),
    ...(coverage.notApplicable ?? []),
  ];
  const statusCounts = new Map<string, number>();
  for (const entry of statusEntries) {
    // Unknown entries and repeated entries both violate the exact partition. Keep the
    // comparison verbatim: callers must copy population strings exactly, not normalize or
    // replace them with prose descriptions.
    if (!populationSet.has(entry)) return false;
    statusCounts.set(entry, (statusCounts.get(entry) ?? 0) + 1);
  }

  return population.every((entry) => statusCounts.get(entry) === 1) && statusEntries.length === population.length;
}

/** Bounds the store reads a close's residue check can cost (a real close cites ~1-3). */
export const RESIDUE_REFS_MAX = 12;

/**
 * D-041 (goal-agent-behavior-feedback-2026-09-06, R-18): the work-item refs a close cites
 * as its follow-ups. Filing is not disposing. Measured 6/6 in S35: the su model filed the
 * out-of-scope defect with no `assign_to`, cited the new id only in `summary` or `deferred`,
 * and closed with `coverage.residue: []`. A guard that reads only `residue` sees nothing, so
 * `followUps` gathers every field that NAMES a follow-up (residue, deferred,
 * requirementDisposition[].followUp). `summaryRefs` stays separate because a summary also
 * cites history the closer never filed. `known` ids (the item being closed) are skipped.
 */
export interface ResidueCitations {
  followUps: string[];
  summaryRefs: string[];
}

export function residueCitations(
  input: {
    residue?: readonly string[] | null;
    deferred?: readonly string[] | null;
    requirementDisposition?: readonly { followUp?: string | null }[] | null;
    summary?: string | null;
  },
  known: readonly string[] = [],
): ResidueCitations {
  const skip = new Set(known.map((k) => k.trim().toUpperCase()));
  const idsIn = (text: string) =>
    detectBodyRefs(text, RESIDUE_REFS_MAX).flatMap((r) => (r.kind === 'work-item' && !skip.has(r.id) ? [r.id] : []));
  const followUps = [
    ...new Set(
      [
        ...(input.residue ?? []),
        ...(input.deferred ?? []),
        ...(input.requirementDisposition ?? []).map((d) => d.followUp ?? ''),
      ].flatMap(idsIn),
    ),
  ].slice(0, RESIDUE_REFS_MAX);
  const named = new Set(followUps);
  const summaryRefs = idsIn(input.summary ?? '')
    .filter((id) => !named.has(id))
    .slice(0, Math.max(0, RESIDUE_REFS_MAX - followUps.length));
  return { followUps, summaryRefs };
}

/** A cited ref's ownership, as the caller read it from the store. */
export interface ResidueRefOwnership {
  id: string;
  /** The item is in a settled state, so nothing is left to own. */
  settled: boolean;
  assignee: string | null;
  createdBy: string | null;
  /** Epoch ms; undefined when unknown. */
  createdAtMs?: number;
}

/**
 * The cited follow-ups that are still OPEN with NO assignee, in citation order. Every
 * `followUps` ref counts. A summary-only ref counts only when this closer filed it at or
 * after `sinceMs` (when it took the closed item), since only then is it this work's residue.
 * A ref absent from `ownership` is not judged: the store could not answer, or the id does
 * not resolve, which the unresolved-ref advisory reports on its own.
 */
export function unownedResidueRefs(
  cited: ResidueCitations,
  ownership: readonly ResidueRefOwnership[],
  closer: { ownerId: string; sinceMs?: number },
): string[] {
  const byId = new Map(ownership.map((o) => [o.id.trim().toUpperCase(), o]));
  const unowned = (id: string) => {
    const o = byId.get(id);
    return Boolean(o && !o.settled && !o.assignee?.trim());
  };
  const filedByCloser = (id: string) => {
    const o = byId.get(id);
    return Boolean(
      o && o.createdBy === closer.ownerId && closer.sinceMs !== undefined &&
        o.createdAtMs !== undefined && o.createdAtMs >= closer.sinceMs,
    );
  };
  return [...cited.followUps.filter(unowned), ...cited.summaryRefs.filter((id) => unowned(id) && filedByCloser(id))];
}

/**
 * WI-37960: coverage evidence for a verification-shaped completion.
 *
 * A universal claim ("every page", "all facts", "nothing invented") is not
 * auditable from a sentence alone. The population must be enumerated, each
 * entry must be assigned a checked/not-checked/not-applicable status, and the
 * residue must be explicit (use `residue: []` or the compatibility form
 * `residue: ['none']` when there is none).
 * The completion gate performs the cross-field accounting check; this schema
 * keeps the durable shape typed and shared by both completion aliases.
 */
export const CompletionCoverageSchema = z
  .preprocess(
    (raw, ctx) => {
      if (raw !== undefined && hasMalformedCoverageShape(raw)) {
        ctx.addIssue({ code: 'custom', message: COMPLETION_COVERAGE_CONTRACT });
        return z.NEVER;
      }
      return raw;
    },
    z.object({
  population: z
    .array(z.string().min(1))
    .min(1)
    .describe('The complete, uniquely named population. Copy each entry verbatim into exactly one status bucket.'),
  checked: z
    .array(z.string().min(1))
    .optional()
    .describe('Population entries verified as checked; entries must be copied verbatim and appear at most once.'),
  notChecked: z
    .array(z.string().min(1))
    .optional()
    .describe('Population entries not verified; entries must be copied verbatim and appear at most once.'),
  notApplicable: z
    .array(z.string().min(1))
    .optional()
    .describe('Population entries that do not apply; entries must be copied verbatim and appear at most once.'),
  residue: z
    .array(z.string().min(1))
    .optional()
    .describe("A separate residue list, never a partition bucket; for universal closes it must be present and may be empty. Use [] or ['none'] for zero residue."),
    }),
  )
  .describe(`${COMPLETION_COVERAGE_CONTRACT} Omitted status buckets mean empty buckets.`);
export type CompletionCoverage = z.infer<typeof CompletionCoverageSchema>;

/** Caller-facing contract for the server-generated verification tree stamp. */
export const COMPLETION_TREE_STAMP_CONTRACT =
  'Server-stamped verification metadata: `work_items:complete` records `treeStamp` from the observed checkout when available; callers must omit `treeStamp`. When present in persisted evidence, `headSha` is a full lowercase 40- or 64-character commit SHA; short hashes are invalid.';

/** Caller-facing contract for the server-generated settlement receipt. */
export const COMPLETION_SETTLEMENT_MANIFEST_CONTRACT =
  'Server-stamped settlement metadata: `work_items:complete` derives `settlementManifest` from the observed checkout; callers must omit `settlementManifest` (including `completion.verification.settlementManifest`). When present in persisted evidence, it contains version=1, a positive generation, a 64-hex evidenceHash, repositoryRoot, a full 40- or 64-character headSha, normalizedPaths, and contentIdentity[]. Do not send intuitive artifact fields such as schemaVersion, artifactPath, artifactSha256, head, or boolean contentIdentity.';

/** Server-observed Git blob identities for each declared changed path. */
export type CompletionTreeContentIdentity = {
  path: string;
  workingTreeBlobSha: string | null;
  headBlobSha: string | null;
  /**
   * WI-42441: set ONLY when `headBlobSha` is null because the server could not READ
   * the HEAD side (an uninitialized submodule, an unreadable object store) — never
   * when the commit genuinely lacks the path. Readers use its presence to tell a
   * server-side resolution failure from the closer's tree being wrong; the two carry
   * opposite remedies, and conflating them is what made this class silent three times.
   */
  headBlobUnresolvable?: string;
  /**
   * EI-21937921955988010: the checkout that OWNS this path, when it is not the
   * stamp's top-level `repositoryRoot`. A completion legitimately spans several
   * repositories here — the suite apps (portal/email/calendar/phone) each live in
   * their own checkout under `~/.papercusp-workspaces/<ws>/.papercusp/apps/*` while
   * infra lands in the papercusp repo — so a single-root stamp could not prove every
   * declared path and the whole stamp was discarded, closing the item as `proposed`
   * with no diagnostic. Each entry now carries the root and HEAD it was proven
   * against; the top-level pair remains the primary (highest-match) root so
   * pre-existing readers keep working unchanged.
   */
  repositoryRoot?: string;
  headSha?: string;
  /**
   * EI-21937921955988010: this path belongs to NO git checkout, so blob identity is
   * not merely unavailable — it is undefined for it. The canonical case is an
   * evidence artifact (`~/.papercusp/evidence/<id>/*.png`), which
   * `verifiedHow: 'live-drove-ui'` REQUIRES the closer to cite and which the identity
   * floor then counted as an unproven citation. Excluded from the floor rather than
   * failed by it; never set for a path that has an owning repository.
   */
  outOfRepoArtifact?: true;
};

/**
 * WI-1409142: one blob-sha slot, shared by the tree stamp and the settlement
 * manifest so the two cannot drift — they describe the SAME observation.
 *
 * Deliberately a PLAIN `.nullable()` (required key, nullable value) with no
 * `.transform()`/`.preprocess()`, and that constraint is not stylistic: this schema
 * reaches `work_items:complete`'s `args`, which is converted to JSON Schema at
 * registration AND on every `tools/list`. A trailing transform is unrepresentable
 * there and takes down tool discovery for EVERY client, not just this tool.
 *
 * Tolerating the absent-key shape therefore belongs in the reader, not here — see
 * `normalizeStoredSettlementManifest()` in completion-settlement-reconciler.ts. It
 * exists because a recursive `jsonb_strip_nulls` on the terminal payload write used
 * to DELETE a legitimately-null `headBlobSha` (a declared path not yet in HEAD — the
 * ordinary state when an agent closes before git-sync sweeps), leaving the key
 * missing, failing `safeParse`, and stranding 110 closes at authority='proposed'.
 * Both write sites now exempt `_completionEvidence`, so new rows keep their nulls;
 * the reader-side normalization is what lets the ALREADY-STORED rows settle without
 * a backfill.
 */
const completionBlobShaSlot = z
  .string()
  .regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/)
  .nullable();

/**
 * EI-18682004530991057 (proposal 3) — what tree a completion's verification was
 * observed against. See the `treeStamp` field on
 * {@link CompletionVerificationEvidenceSchema} for why this is server-stamped.
 *
 * Deliberately carries ONLY what can be observed EXACTLY and CHEAPLY. It does not
 * carry a dirty/clean verdict: every spawn-free way to compute one is a heuristic
 * (an mtime newer than `.git/index` cannot distinguish "touched" from "modified"),
 * and a heuristic verdict written into a durable record that later readers trust
 * WITHOUT re-checking is worse than an absent field — it manufactures exactly the
 * confident-but-wrong reading this whole evidence surface exists to prevent. The
 * honest half ships; the guessed half does not.
 */
export const CompletionTreeStampSchema = z
  .object({
    /**
     * Canonical local checkout root that owns `headSha`. Optional only so pre-fix
     * persisted SHA-only records remain readable; new server stamps always include it.
     */
    repositoryRoot: z
      .string()
      .min(1)
      .optional()
      .describe('Server-recorded checkout root for the observed `headSha`; callers must omit this field.'),
    /**
     * Full HEAD commit sha of the integration checkout at close time, read directly
     * from the git refs (never via a `git` subprocess — see completionTreeStamp()).
     */
    headSha: z
      .string()
      .regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/)
      .describe('Server-recorded full lowercase 40- or 64-character commit SHA; short hashes are invalid.'),
    /**
     * Server-observed Git blob identities for the declared changed paths. A null
     * identity is intentional evidence of an unavailable/missing side (for example
     * a dirty worktree file that is absent from HEAD); it must never be treated as a
     * match by a reader.
     */
    contentIdentity: z
      .array(
        z.object({
          path: z.string().min(1),
          workingTreeBlobSha: completionBlobShaSlot,
          headBlobSha: completionBlobShaSlot,
          /**
           * EI-22344624691081449: caller-declared intentional deletion. A
           * deletion is proven only when both blob identities are null, and
           * the server stamps this marker rather than inferring intent from
           * absence alone.
           */
          deletion: z.literal(true).optional(),
          /**
           * WI-42441: why the HEAD side could not be READ, when that is the reason
           * `headBlobSha` is null. A null alone conflates "the commit genuinely does
           * not carry this path" with "the server could not resolve it" — and those
           * two demand opposite remedies, so the closer was blamed for a resolution
           * bug. Present ONLY for the unresolvable case; a genuine absence leaves it
           * unset, which is what keeps the two distinguishable downstream.
           */
          headBlobUnresolvable: z.string().min(1).optional(),
          /**
           * EI-21937921955988010: per-entry owning checkout + HEAD, present when this
           * path was proven against a repository OTHER than the stamp's top-level
           * `repositoryRoot`. Plain optional strings for the same JSON-Schema reason
           * the blob slots above are plain `.nullable()`.
           */
          repositoryRoot: z.string().min(1).optional(),
          headSha: z
            .string()
            .regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/)
            .optional(),
          /** EI-21937921955988010: path owned by no checkout (an evidence artifact). */
          outOfRepoArtifact: z.literal(true).optional(),
        }),
      )
      .min(1)
      .max(60)
      .optional()
      .describe('Server-recorded per-path Git blob identities; present only when declared content was observed.'),
  })
  .describe(COMPLETION_TREE_STAMP_CONTRACT);
export type CompletionTreeStamp = z.infer<typeof CompletionTreeStampSchema>;

/** Durable receipt used to reconcile a proposed code completion with git-sync. */
export const CompletionSettlementManifestSchema = z.object({
  version: z.literal(1),
  generation: z.number().int().positive(),
  evidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
  repositoryRoot: z.string().min(1),
  headSha: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/),
  normalizedPaths: z.array(z.string().min(1)).min(1).max(60),
  contentIdentity: z.array(z.object({
    path: z.string().min(1),
    workingTreeBlobSha: completionBlobShaSlot,
    headBlobSha: completionBlobShaSlot,
    /** EI-22344624691081449: caller-declared intentional deletion. */
    deletion: z.literal(true).optional(),
  })).min(1).max(60),
  residualPaths: z.array(z.object({
    path: z.string().min(1),
    reason: z.enum(['identity-unavailable', 'missing-from-commit', 'content-mismatch']),
  })).max(60).optional(),
});
export type CompletionSettlementManifest = z.infer<typeof CompletionSettlementManifestSchema>;

/**
 * EI-21905322780107586: `coerceFilesChanged` (completion-coerce.ts) splits a scalar
 * `filesChanged` string on `,`/`;`/newline to rescue a genuine comma-separated path
 * LIST (EI-21471221125941096). That rescue has no way to tell a real list from
 * narrative prose describing several changes in ONE paragraph — a fragment such as
 * `"foo.ts (funcA added, funcB changed"` survives the split with no delimiter of
 * its own and is then recorded verbatim as a `filesChanged` PATH. Unresolved, it
 * even earns a "did you mean" fuzzy suggestion from the missing-path warning,
 * which reads as false confirmation that the token was a real near-miss path.
 *
 * A bare repo-relative path never combines internal whitespace with a parenthesis
 * or comma — that combination is the signature of prose, not a filename. Reject it
 * the same way `loop:checkpoint`'s `walls[]` rejects an unrecognized shape: loudly,
 * at the call boundary, with the repair named — never silently recorded as
 * fabricated evidence and never silently dropped.
 *
 * EI-22191579345441592: a GLOB PATTERN is the second, disjoint shape that is not a
 * path either, and it has no whitespace to trip the check above — an audit found
 * `"packages/.../projections/**\/*.ts (writer contract sweep)"` declared as one of
 * `filesChanged`'s FOUR entries, TWO of which were glob patterns rather than paths.
 * A glob is a claim about a POPULATION ("I swept N files"), not a claim that one
 * path exists, and every downstream blob-containment audit iterates `filesChanged`
 * as its population: `git rev-parse --verify --quiet <sha>:<entry>` on a glob
 * resolves to nothing, which is INDISTINGUISHABLE from "absent from the candidate"
 * — so the entry either silently drops out of the audited population (the
 * dangerous direction: the audit looks complete over a SUBSET and nothing says
 * so) or is misreported as a missing file. Reject the same way: loudly, at the
 * call boundary, with the repair named (enumerate the files the glob matched —
 * the caller has them, `git diff --name-only` produced them).
 *
 * Deliberately narrow to `*`, `?`, `{`, `}` — NOT `[`/`]`. This repo has real,
 * legitimate paths built from bracketed segments (Next.js dynamic routes, e.g.
 * `apps/web/app/api/zero-proxy/[...path]/route.ts`), so treating a bracket as a
 * glob indicator would reject genuine filesChanged evidence on exactly the kind
 * of change this check must never obstruct.
 */
const FILES_CHANGED_GLOB_CHARS = /[*?{}]/;

function isPathShapedFilesChangedEntry(entry: string): boolean {
  const hasWhitespace = /\s/.test(entry);
  const hasProsePunctuation = entry.includes('(') || entry.includes(')') || entry.includes(',');
  if (hasWhitespace && hasProsePunctuation) return false;
  if (FILES_CHANGED_GLOB_CHARS.test(entry)) return false;
  return true;
}

const FILES_CHANGED_NOT_PATH_SHAPED_MESSAGE =
  'filesChanged entries for managed-checkout files must be bare repo-relative paths, not prose and not a glob ' +
  'pattern. For a deliverable outside all managed checkouts, use its absolute path. Such absolute ' +
  'paths are recorded as `outOfRepoArtifact` and are not verified against Git; do not use a repo-relative ' +
  'alias for an out-of-tree deliverable because it is indistinguishable from a missing checkout path. An entry ' +
  "containing whitespace together with '(', ')', or ',' reads like a description that survived " +
  "splitting a comma-separated string, not a filename; an entry containing '*', '?', '{', or '}' is a " +
  'glob describing many files, not a claim that one path exists — every downstream blob-containment ' +
  'audit iterates filesChanged as its population and a glob entry resolves to nothing there, ' +
  'indistinguishable from "absent". Put the description in `summary` / `whatLanded` instead, enumerate ' +
  'what a glob matched, and pass filesChanged as an array of bare paths, e.g. ' +
  'filesChanged: ["path/to/file.ts", "path/to/other.ts"].';

const FilesChangedSchema = z
  .array(z.string().min(1).refine(isPathShapedFilesChangedEntry, { message: FILES_CHANGED_NOT_PATH_SHAPED_MESSAGE }))
  .optional()
  .describe(
    'Use repo-relative paths for files in managed checkouts. For an out-of-tree deliverable, use its absolute path; work_items:complete records it as outOfRepoArtifact and excludes it from Git blob and settlement checks. External contents are not hashed. Do not use a repo-relative alias for an out-of-tree file because it is indistinguishable from a missing checkout path.',
  );

/**
 * P-021 / D-014 — the requirement-by-requirement disposition of the originating ask.
 *
 * `requirement` must be a VERBATIM span of the originating item body, never a
 * paraphrase: paraphrase is where silent narrowing hides ("make the retry robust"
 * becomes "added a retry"), and a literal quote is checkable as a substring while a
 * paraphrase is a matter of opinion. The check lives in
 * `agent-tools/work_items/requirement-disposition.ts`.
 */
const RequirementDispositionSchema = z
  .array(
    z.object({
      requirement: z
        .string()
        .min(1)
        .describe('VERBATIM quote from the originating item body — never a paraphrase.'),
      disposition: z.enum(['implemented', 'not-applicable', 'deferred', 'rejected']),
      citations: z
        .array(z.string().min(1))
        .optional()
        .describe('Repo-relative paths that must RESOLVE; required for `implemented`.'),
      followUp: z
        .string()
        .min(1)
        .optional()
        .describe('Filed work-item ref (WI-/EI-/F-); required for `deferred`.'),
      note: z.string().min(1).optional(),
    }),
  )
  .describe(
    'Requirement-by-requirement disposition of the ask. Each `requirement` is a VERBATIM ' +
    'quote from the originating item body (substring-checked, never paraphrased), each ' +
    '`implemented` cites a path that resolves, each `deferred` names a filed follow-up ref.',
  );

/**
 * EI-18793465701838962: a bug close must retain the claim that was tested, the
 * live rival, and the observation that separated them. Free-form "root cause"
 * prose cannot distinguish a pre-fix test from a post-hoc explanation.
 */
function normalizedRootCauseClaim(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Shared by the successful-close gate and its compact discovery contract. */
export const ROOT_CAUSE_SUCCESSFUL_CLOSE_STATES = ['done', 'resolved', 'passed'] as const;
export const ROOT_CAUSE_DISTINGUISHING_TEST_CONSTRAINT =
  'non-empty procedure; no prose template required';
export const ROOT_CAUSE_PREDICTED_OBSERVATIONS_CONSTRAINT =
  'predictedObservations arms must be meaningfully different';
/**
 * Version of the causal-evidence contract enforced for NEW successful defect
 * closes. The additional fields remain optional in the storage schema so
 * historical v1 completion records continue to parse; the completion handler
 * applies the v2 requirement only at a new successful-close boundary and
 * stamps the version on records that pass.
 */
export const ROOT_CAUSE_VERIFICATION_CONTRACT_VERSION = 2 as const;
export const ROOT_CAUSE_VERIFICATION_V2_REQUIRED_FIELDS = [
  'testProcedure',
  'predictedObservations.hypothesis',
  'predictedObservations.alternativeHypothesis',
  'actualObservation',
  'evidenceRefs',
] as const;

export const RootCauseVerificationSchema = z
  .object({
    contractVersion: z.literal(ROOT_CAUSE_VERIFICATION_CONTRACT_VERSION).optional(),
    hypothesis: z.string().trim().min(1).describe('The claimed originating cause.'),
    alternativeHypothesis: z.string().trim().min(1).describe('A rival explanation that predicts a different result.'),
    distinguishingTest: z
      .string()
      .trim()
      .min(1)
      .describe(ROOT_CAUSE_DISTINGUISHING_TEST_CONSTRAINT),
    testResult: z.string().trim().min(1).describe('The actual pre-fix observable.'),
    testProcedure: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Exact procedure used to distinguish the two hypotheses; required on new successful defect closes.'),
    predictedObservations: z
      .object({
        hypothesis: z.string().trim().min(1),
        alternativeHypothesis: z.string().trim().min(1),
      })
      .strict()
      .optional()
      .describe('The observation predicted under each hypothesis; required on new successful defect closes.'),
    actualObservation: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('What the distinguishing procedure actually observed; required on new successful defect closes.'),
    evidenceRefs: z
      .array(z.string().trim().min(1).max(2_000))
      .min(1)
      .max(50)
      .optional()
      .describe('Durable references supporting the procedure and actual observation; required on new successful defect closes.'),
  })
  .strict()
  .meta({
    'x-papercusp-call-constraint':
      `successful bug/capability-gap close (state=${ROOT_CAUSE_SUCCESSFUL_CLOSE_STATES.join('|')}) => required; ` +
      `contractVersion=${ROOT_CAUSE_VERIFICATION_CONTRACT_VERSION}; required fields: hypothesis, alternativeHypothesis, ` +
      `distinguishingTest, testResult, ${ROOT_CAUSE_VERIFICATION_V2_REQUIRED_FIELDS.join(', ')}; ` +
      `hypothesis!=alternativeHypothesis; ${ROOT_CAUSE_PREDICTED_OBSERVATIONS_CONSTRAINT}; ` +
      `distinguishingTest: ${ROOT_CAUSE_DISTINGUISHING_TEST_CONSTRAINT}`,
  })
  .superRefine((record, ctx) => {
    if (normalizedRootCauseClaim(record.hypothesis) === normalizedRootCauseClaim(record.alternativeHypothesis)) {
      ctx.addIssue({
        code: 'custom',
        path: ['alternativeHypothesis'],
        message: 'alternativeHypothesis must be meaningfully different from hypothesis.',
      });
    }
    const predicted = record.predictedObservations;
    if (
      predicted &&
      normalizedRootCauseClaim(predicted.hypothesis) ===
        normalizedRootCauseClaim(predicted.alternativeHypothesis)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['predictedObservations', 'alternativeHypothesis'],
        message: `${ROOT_CAUSE_PREDICTED_OBSERVATIONS_CONSTRAINT}.`,
      });
    }
  });
export type RootCauseVerification = z.infer<typeof RootCauseVerificationSchema>;

/** Return every missing v2 field in one pass; never rejects historical reads. */
export function missingRootCauseVerificationV2Fields(
  record: RootCauseVerification | null | undefined,
): string[] {
  if (!record) return [...ROOT_CAUSE_VERIFICATION_V2_REQUIRED_FIELDS];
  return [
    ...(!record.testProcedure?.trim() ? ['testProcedure'] : []),
    ...(!record.predictedObservations?.hypothesis?.trim() ? ['predictedObservations.hypothesis'] : []),
    ...(!record.predictedObservations?.alternativeHypothesis?.trim()
      ? ['predictedObservations.alternativeHypothesis']
      : []),
    ...(!record.actualObservation?.trim() ? ['actualObservation'] : []),
    ...(!record.evidenceRefs?.length ? ['evidenceRefs'] : []),
  ];
}

/** Caller-declared result of this close, not a server-verified causal attribution. */
export const CompletionWorkOutcomeSchema = z.enum([
  'introduced-change',
  'verified-existing',
  'duplicate',
  'invalid-or-expected',
  'other-no-new-change',
]);
export type CompletionWorkOutcome = z.infer<typeof CompletionWorkOutcomeSchema>;

export const CompletionVerificationEvidenceSchema = z.object({
  /** Files/modules changed, for audit queries without reading completion prose. */
  filesChanged: FilesChangedSchema,
  /**
   * EI-22344624691081449: paths intentionally removed by this completion.
   * Kept separate from `filesChanged` so absence can be proven as a deletion
   * rather than misclassified as a missing or fabricated changed path.
   */
  filesDeleted: FilesChangedSchema,
  /** Exact command/probe run, or the concrete already-fixed verification. */
  testsRun: z.string().min(1).optional(),
  /** Result summary, e.g. "9/9 green" or "HTTP 200 smoke passed". */
  testResult: z.string().min(1).optional(),
  /** Verification mode, coarse enough for leader/Queen completion audits. */
  verifiedHow: CompletionVerifiedHowSchema.optional(),
  /**
   * Whether this close introduced a durable change, as DECLARED by its closer.
   * Optional for older callers; omission means unknown, never "introduced-change".
   * Evidence sufficiency (`completionAuthority`) is a separate dimension.
   */
  workOutcome: CompletionWorkOutcomeSchema.optional(),
  /** Whether this completion added or changed tests. */
  addedTests: z
    .boolean()
    .optional()
    .describe(
      'A boolean FLAG — did this completion add or change tests? true/false, NOT a description of ' +
      'what was added (put that prose in `testsRun` / `testResult`).',
    ),
  /** Enumerated population + per-entry status for universal verification claims (WI-37960). */
  coverage: CompletionCoverageSchema.optional().meta({
    'x-papercusp-call-constraint': COMPLETION_COVERAGE_CALL_CONSTRAINT,
  }),
  /** P-021 / D-014: requirement-by-requirement disposition against the originating ask. */
  requirementDisposition: RequirementDispositionSchema.optional(),
  /**
   * EI-19319623239777505: the caller's free-text `completion.summary`, carried alongside
   * the structured fields it sits next to. Before this field existed, `summary` was NEVER
   * persisted anywhere durable — not on a normal close (work_items:complete never passed
   * a `completionRef`, deliberately, per P-004 — see complete.ts) and not on a second
   * (already-terminal) close either (the attestation's `completionRef` fell back to
   * `opts.completionRef ?? null`, which complete.ts also never populates). The caller's
   * narrative was echoed back in the tool's RETURN value only, never written to the row —
   * so a later reader (an audit, a leader brief, a fresh agent picking the item back up)
   * had no way to recover WHAT was done, only whether it met the `committed` evidence bar.
   * Deliberately does NOT affect `isSufficientEvidence`/`authorityForCompletion` (both key
   * only on `verifiedHow` + `testsRun`/`testResult`) — this is purely an additional,
   * non-authority-bearing carry-through of the prose the caller already wrote.
   */
  summary: z.string().min(1).optional(),
  /**
   * EI-18682004530991057 (proposal 3) — the commit the verification was run against,
   * stamped by the SERVER at close time rather than asked of the caller.
   *
   * Why it is not optional-in-spirit: `testResult: "172 passed / 0 failed"` names no
   * particular code. On this shared checkout every agent edits ONE working tree, so a
   * result recorded without a commit is not weak evidence, it is unanchored evidence —
   * a later reader cannot tell whether it describes the code they are looking at, an
   * older revision, or a tree that was mid-edit by a peer when the suite ran. The
   * sibling EI-18681435059177620 measured this directly: three measurements of one file
   * were each invalidated by an edit landing on top, producing both a false alarm AND a
   * false all-clear inside 25 minutes.
   *
   * SERVER-STAMPED on purpose. Asking the caller for it would put the one field a
   * reviewer most needs to trust in the hands of the party whose claim is being checked,
   * and it is the field most likely to be filled in from memory — the same failure mode
   * `filesChanged` already exhibits (EI-20093150500083378: 8 of 12 declared paths did not
   * exist). A caller-supplied sha is a testimonial; an observed one is evidence.
   *
   * Absent whenever it could not be observed (no repo root, unreadable/ambiguous git
   * refs). Absence means "not observed", never "clean" or "unknown-but-fine".
   */
  treeStamp: CompletionTreeStampSchema.optional().describe(COMPLETION_TREE_STAMP_CONTRACT),
  /** Server-derived causal receipt for code completions awaiting git-sync settlement. */
  settlementManifest: CompletionSettlementManifestSchema.optional().describe(COMPLETION_SETTLEMENT_MANIFEST_CONTRACT),
  /**
   * EI-22175397357614106 — structured, machine-checkable assertions the close makes about
   * the source, so a claim that is present, well-formed and WRONG can be caught.
   *
   * Every other evidence check here is a PRESENCE test. The measured gap: WI-37365 closed
   * `committed` asserting a verb had reached the live seeded tool surface when it had not,
   * and that false close then became the premise for a downstream falsifier armed against
   * a verb no session could call.
   *
   * Caller-supplied, unlike `treeStamp`/`settlementManifest` above — and deliberately so,
   * because it is NOT asked to be believed. The caller supplies the CLAIM and the server
   * supplies the VERDICT by re-evaluating it against the tree (`evaluateCompletionClaims`),
   * which is what separates this from `filesChanged`-style testimony. A falsified claim
   * arrives back as the `claimsFalsified` finding and DOWNGRADES the close.
   */
  claims: z.array(CompletionClaimSchema).max(50).optional().describe(COMPLETION_CLAIMS_CONTRACT),
});
export type CompletionVerificationEvidence = z.infer<typeof CompletionVerificationEvidenceSchema>;

/**
 * Bound the server-generated copy of checkpoint prose carried onto a terminal
 * completion. The checkpoint itself may be much larger, but completion evidence
 * must remain a compact, durable narrative rather than another unbounded note.
 */
export const CHECKPOINT_PROSE_SNAPSHOT_MAX_CHARS = 8_000;

/**
 * EI-21478999218933285: the row-persisted close record is deliberately wider
 * than the caller-facing `verification` object. These narrative fields remain
 * top-level completion inputs, but ride beside verification evidence under
 * `_completionEvidence` so work_items:get can recover the whole close later.
 * They never participate in completion-authority calculation.
 */
export type PersistedCompletionEvidence = CompletionVerificationEvidence & {
  /** Contrastive causal record required for successful bug/capability-gap closes. */
  rootCauseVerification?: RootCauseVerification;
  whatLanded?: string[];
  deferred?: string[];
  coordNotes?: string;
  /**
   * WI-41769 — the arm-B self-review verdict, SERVER-computed rather than caller-supplied.
   *
   * Same reason `whatLanded`/`deferred`/`coordNotes` live here (EI-21478999218933285): it
   * otherwise survives only in this call's transient return value, so a later
   * `work_items:get` gives a confident but false "nothing recorded" for a close the gate
   * genuinely judged. Stored on the narrative side deliberately — like those fields, it
   * describes the close and must NEVER promote an evidence-free completion to `committed`.
   */
  selfReviewJudgement?: PersistedSelfReviewJudgement;
  /**
   * EI-21462047954123123 — the terminal cleanup in `work_items:complete` CLEARS the
   * item checkpoint, while completion evidence routinely CITES that checkpoint ("the
   * checkpoint carries ..."), so the pointer was voided by the very call that wrote
   * it. Before the clear, any checks rows are folded HERE — a surface an auditor
   * already reads — so "see the checkpoint" becomes "see _completionEvidence". The
   * clear keeps its deliberate invariant (no checks-only checkpoint survives on a
   * closed item); the CONTENT moves instead of dying silently. Server-computed,
   * narrative-side: never participates in completion-authority calculation.
   */
  checkpointChecksCarried?: Array<{
    claim: string;
    recheck?: string;
    verified?: string;
    observed?: string;
    contested?: string;
  }>;
  /**
   * EI-22959550187023490 — prose sections from the checkpoint are copied before
   * terminal cleanup clears the replace-on-write note. This is server-generated,
   * bounded, and narrative-only; structured `## Checks` rows remain in
   * `checkpointChecksCarried` and neither field affects completion authority.
   */
  checkpointProseSnapshot?: string;
  /**
   * WI-2142447 — the CLOSE-TIME verdict for each declared `claims` entry, recorded at the
   * moment the close computed it.
   *
   * Server-computed and narrative-side for the same reason as `selfReviewJudgement` above:
   * it describes the close and must NEVER promote an evidence-free completion to
   * `committed`. The GRADE is already carried by the `claimsFalsified` finding at close
   * time; this is the record that finding leaves behind.
   *
   * It exists because the post-close sweep's finding is a TRANSITION (`holds` then,
   * `falsified` now), and nothing about the current tree can tell a claim that has GONE
   * false from one that was already false when written and was already graded for it.
   * Re-deriving the baseline later from the close's `treeStamp` would be an inference that
   * fails silently whenever that sha is unreachable; recording the verdict where it is
   * computed is an observation. See `completion-claim-recheck.ts`.
   */
  claimVerdicts?: CompletionClaimBaseline;
};

/**
 * EI-10867 — the ONE key under which a terminal row's structured verification evidence
 * is stored, for BOTH work-item families (`harness_features_consolidated.payload` and
 * `engineer_issues.payload`, each jsonb).
 *
 * This constant used to be declared PRIVATELY and IDENTICALLY in work-items.ts and
 * issues-engineer.ts. That duplication is precisely how the write path and the audit
 * path drifted: the writers agreed on `_completionEvidence`, while the
 * (since-deleted) `audit:'no-evidence'` reader keyed on `terminal_completion_ref` — a column the
 * completion gate FORCES to be non-null — so the audit could never return a row it was
 * named for (4,119 unverified terminal rows read as clean). Both families now import
 * this single key, so a write and an audit cannot disagree about where evidence lives.
 */
export const TERMINAL_COMPLETION_EVIDENCE_KEY = '_completionEvidence';

/**
 * EI-18736669939338784 — the key under which a SECOND (or third…) terminal close of an
 * already-completed item is recorded, for both families, beside (never on top of)
 * {@link TERMINAL_COMPLETION_EVIDENCE_KEY}.
 *
 * Why this exists: the terminal UPDATE stamps `terminal_owner` / `terminal_completion_ref`
 * / `authority` unconditionally, and merges evidence with jsonb `||` — a TOP-LEVEL key
 * merge, so an incoming `_completionEvidence` REPLACES the stored object wholesale rather
 * than deep-merging it. A second closer therefore silently destroyed the first closer's
 * record and was told `ok:true`. Observed live on WI-6112: a rich structured close
 * (verifiedHow:'integration', 4 filesChanged, testsRun) was overwritten 1.9s later by a
 * bare-string close from a different agent, leaving the row reading as an unverified
 * assertion. 107 cross-owner overwrites in the preceding 30 days; 28 with that exact
 * damage signature.
 *
 * The inversion that makes it dangerous: completion-integrity audits read whatever closed
 * LAST, so absent this the WEAKER record wins by arriving later — a bare assertion erases
 * a verification.
 *
 * Bounded, newest-last (same discipline as `payload.reopenHistory`).
 */
export const COMPLETION_ATTESTATIONS_KEY = '_completionAttestations';

/**
 * P-008 (d) / D-050 / D-079 — the ONE key under which a terminal close's RESOLVED
 * assumption declaration is stored, for both work-item families.
 *
 * Declared beside {@link TERMINAL_COMPLETION_EVIDENCE_KEY} and for the same reason
 * that constant's header gives: two private, identical copies is precisely how a
 * write path and its reader drift. P-011's conflicting-assumption detector reads
 * this key; nothing may re-declare it locally.
 *
 * ⚠ Until P-008 (d) this key did not exist and `assumptions` was NOT PERSISTED AT
 * ALL — required on every terminal close, format-checked by two zod refines, then
 * referenced zero times downstream. D-050's claim that the gate enforced "an
 * assumption was STATED... strictly more than the nothing that preceded it" was
 * therefore false as built: a declaration that is validated and discarded is
 * exactly nothing, plus a required field.
 */
export const TERMINAL_ASSUMPTIONS_KEY = '_assumptions';

/**
 * What lands under {@link TERMINAL_ASSUMPTIONS_KEY}.
 *
 * `'none'` is stored VERBATIM rather than as an empty array: D-016's whole
 * argument for the literal is that an explicit "this rests on nothing recorded"
 * is a real answer, and flattening it to `[]` would make it indistinguishable
 * from a close that predates the field.
 */
export interface StoredAssumptionDeclaration {
  /** The literal 'none', or the resolved entries (see `ResolvedAssumption`). */
  declared: 'none' | ResolvedAssumption[];
  /** When resolution ran — the ISO instant the conditions below were true. */
  resolvedAt: string;
}

/**
 * EI-18764241942332131: Postgres' jsonb TEXT-INPUT parser refuses a literal NUL
 * code point inside a JSON string with `unsupported Unicode escape sequence` —
 * text columns simply cannot represent it. `JSON.stringify` happily round-trips a
 * raw NUL (it survives as the six-character escape sequence in the output text),
 * so the failure is deferred all the way to the `::text::jsonb` cast at write
 * time, and the NUL itself is invisible in every surface an agent would inspect
 * it with (renders as nothing or a plain space, survives a plain JSON round-trip)
 * — so the resulting Postgres error names neither the offending field nor the
 * offending byte.
 *
 * Deep-strips every embedded NUL from the string leaves of an arbitrary JSON-ish
 * value (object / array / string / primitive); everything else is returned
 * unchanged (by reference, when nothing needed stripping). `stripped:true` tells
 * a caller at least one NUL was actually removed, so it can surface a
 * loud-but-non-blocking warning instead of silently rewriting an agent's evidence
 * (EI-24 record-and-warn discipline). PURE — no PG required to unit-test.
 *
 * Implementation note for future editors: the NUL character below is produced at
 * runtime by calling the string-from-character-code constructor with zero. Do not
 * replace that call with a literal character typed into this source file: several
 * editors and terminals display an embedded raw NUL byte as an ordinary blank
 * space, so a hand-typed literal is easy to get wrong without any visual sign,
 * and this repository lints tracked source files against containing one.
 */
export function stripNulBytesDeep<T>(value: T): { value: T; stripped: boolean } {
  const NUL = String.fromCharCode(0);
  let stripped = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (!v.includes(NUL)) return v;
      stripped = true;
      return v.split(NUL).join('');
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  const walked = walk(value);
  return { value: (stripped ? walked : value) as T, stripped };
}

/**
 * The jsonb a terminal write merges into `payload`: structured completion evidence
 * plus the resolved assumption declaration.
 *
 * ⚠ SHARED BY BOTH FAMILIES ON PURPOSE. `completionEvidencePayloadJson` existed as
 * two byte-identical private copies — one in work-items.ts, one in
 * issues-engineer.ts — which is the *precise* duplication this module's
 * {@link TERMINAL_COMPLETION_EVIDENCE_KEY} header describes as how a write path and
 * its reader drift apart. Adding assumptions to both copies would have made it
 * three. One builder, both families, no third copy.
 *
 * Returns null when there is nothing to merge, so the caller's `IS NULL` branch
 * leaves `payload` untouched. PURE.
 *
 * EI-18764241942332131: also the DEFENSE-IN-DEPTH backstop for {@link stripNulBytesDeep}
 * — every terminal-state write's evidence/assumptions merge funnels through this one
 * function (both families), so sanitizing HERE protects every caller, not just
 * `work_items:complete` (which additionally sanitizes at its own tool boundary — see
 * `agent-tools/work_items/complete.ts` — so the state write and the completion record
 * it accompanies can never disagree about whether a NUL-bearing close landed).
 */
export function terminalPayloadMergeJson(
  evidence: PersistedCompletionEvidence | undefined,
  assumptions?: StoredAssumptionDeclaration | undefined,
  blueprintResult?: { operationId: string; specificationRevision: string; output: unknown; evidenceRef: string },
): string | null {
  const merge: Record<string, unknown> = {};
  if (evidence && Object.keys(evidence).length > 0) merge[TERMINAL_COMPLETION_EVIDENCE_KEY] = evidence;
  if (assumptions) merge[TERMINAL_ASSUMPTIONS_KEY] = assumptions;
  if (blueprintResult) merge.blueprintResult = blueprintResult;
  if (Object.keys(merge).length === 0) return null;
  const { value: sanitized } = stripNulBytesDeep(merge);
  return JSON.stringify(sanitized);
}

/**
 * Read a stored assumption declaration off a payload. Defensive double-parse: the
 * column is jsonb but arrives as a string down some facade legs, and a nested JSON
 * string has been observed in the wild for the evidence key. PURE.
 */
export function readStoredAssumptions(payload: unknown): StoredAssumptionDeclaration | null {
  let obj = payload;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  let v = (obj as Record<string, unknown>)[TERMINAL_ASSUMPTIONS_KEY];
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const d = (v as StoredAssumptionDeclaration).declared;
  // 'none' or an array, nothing else — an out-of-band write must read as "no
  // declaration", never as a shape P-011's detector would mis-consume.
  if (d !== 'none' && !Array.isArray(d)) return null;
  return v as StoredAssumptionDeclaration;
}

/**
 * One non-authoritative terminal close recorded under {@link COMPLETION_ATTESTATIONS_KEY}.
 *
 * `outcome` says which side of the conflict this row was:
 *  · `attested`   — THIS close did not become the row's authoritative record (it was not
 *                   strictly richer than the one already stored). Nothing was destroyed.
 *  · `superseded` — this close WAS the authoritative record and was replaced by a later,
 *                   strictly-richer one; archived here so the upgrade is not a deletion.
 */
export interface CompletionAttestation {
  at: string;
  by: string | null;
  /** The terminal state this closer asked for (may differ from the state that stands). */
  state: string;
  completionRef: string | null;
  completionAuthority: string | null;
  evidence: PersistedCompletionEvidence | null;
  /**
   * P-008 (d) / D-079 R4: the assumptions THIS close declared.
   *
   * Carried here as well as under {@link TERMINAL_ASSUMPTIONS_KEY} because the
   * terminal UPDATE merges payload with jsonb `||` — a TOP-LEVEL key merge — so a
   * second closer REPLACES the stored object wholesale (EI-18736669939338784: 27
   * cross-owner second closes, 12 lost evidence, 15 mis-attributed). Without this
   * a losing closer's declaration would be destroyed by exactly the mechanism
   * that already destroyed evidence, in the same field, one release later.
   */
  assumptions: StoredAssumptionDeclaration | null;
  outcome: 'attested' | 'superseded';
}

/**
 * COMPLETION (D-004) — the single biggest token + signal win. A work_item
 * transitioning to done emits this instead of the agent hand-writing a
 * "DONE + tested, migration 137…" prose dump. Every field maps to a phrase
 * the corpus prose carried.
 */
export const CompletionRecordSchema = z.object({
  /** The plan / brief / work-item id, e.g. "fleet-as-supervised-blackboard-2026-06-04" or "F-012". */
  workItem: z.string().min(1),
  /** Optional human title when the id isn't self-describing. */
  title: z.string().optional(),
  /** One-line "what happened" — the headline (e.g. "all 5 phases/8 decisions, 67 green tests"). */
  summary: z.string().min(1),
  /** Freeform status verb: 'done' | 'built+tested' | 'landed' | 'shipped'. Default 'done'. */
  status: z.string().min(1).default('done'),
  /** What landed — files / modules each with a one-line description. */
  whatLanded: z.array(z.string().min(1)).optional(),
  /** Migrations applied, e.g. ["146 spawned_agents supervision", "147 fleet_governor"]. */
  migrations: z.array(z.string().min(1)).optional(),
  /** Tests — counts / status, e.g. "67 green tests" or "32 tests green (vitest integration)". */
  tests: z.string().min(1).optional(),
  /** Queryable verification evidence; aliases below keep legacy callers cheap. */
  verification: CompletionVerificationEvidenceSchema.optional(),
  /** Required on successful bug/capability-gap closes; persisted with terminal evidence. */
  rootCauseVerification: RootCauseVerificationSchema.optional().meta({
    'x-papercusp-call-constraint':
      `successful bug/capability-gap close (state=${ROOT_CAUSE_SUCCESSFUL_CLOSE_STATES.join('|')}) => required; ` +
      `contractVersion=${ROOT_CAUSE_VERIFICATION_CONTRACT_VERSION}; required fields: hypothesis, alternativeHypothesis, ` +
      `distinguishingTest, testResult, ${ROOT_CAUSE_VERIFICATION_V2_REQUIRED_FIELDS.join(', ')}; ` +
      `hypothesis!=alternativeHypothesis; ${ROOT_CAUSE_PREDICTED_OBSERVATIONS_CONSTRAINT}; ` +
      `distinguishingTest: ${ROOT_CAUSE_DISTINGUISHING_TEST_CONSTRAINT}`,
  }),
  /** Top-level alias for the structured verification coverage record (WI-37960). */
  coverage: CompletionCoverageSchema.optional().meta({
    'x-papercusp-call-constraint': COMPLETION_COVERAGE_CALL_CONSTRAINT,
  }),
  filesChanged: FilesChangedSchema,
  /** Top-level alias for `verification.filesDeleted`; intentional removals. */
  filesDeleted: FilesChangedSchema,
  testsRun: z.string().min(1).optional(),
  testResult: z.string().min(1).optional(),
  verifiedHow: CompletionVerifiedHowSchema.optional(),
  addedTests: z
    .boolean()
    .optional()
    .describe(
      'A boolean FLAG — did this completion add or change tests? true/false, NOT a description of ' +
        'what was added (put that prose in `testsRun` / `testResult`).',
    ),
  /**
   * Arm-B pilot self-review (plan `directed-pair-work-items-2026-08-25`, D-020/D-021).
   *
   * OPTIONAL, and must stay optional: arms A and C — and every ordinary close outside the
   * pilot — record a valid completion without it. Making it required would strand every
   * caller of `work_items:complete`, which is the one verb no agent in the fleet can route
   * around (the `lint:required-field-strands` class).
   *
   * An EMPTY `findings` array is a legitimate recorded outcome, not an omission: a review
   * that turned nothing up is a data point, and the gate reports it as `rubberStampRisk`
   * rather than refusing it. Refusing a zero-findings review would teach agents to invent
   * findings, which is worse than the rubber-stamping it was meant to catch.
   */
  selfReview: z
    .object({
      /** What was re-read — the diff, the changed files. Corroborated against the ledger. */
      lookedAt: z.string().min(1).optional(),
      /** What the review turned up. `[]` is meaningful; see the note above. */
      findings: z.array(z.string().min(1)).optional(),
      /** What was fixed because of the review — the arm's review YIELD. */
      changedAsResult: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  /** Deploy note, e.g. "additive, loads next :3070 restart" | "restarted :3070". */
  deploy: z.string().min(1).optional(),
  /**
   * The DEFERRED / surfaced-not-done / seams set. CRITICAL: the "surface every
   * deferred item" policy lives or dies here — a completion that silently drops
   * its deferrals is the exact failure the policy guards against. Rendered
   * prominently (see render.ts).
   */
  deferred: z.array(z.string().min(1)).optional(),
  /**
   * Genuinely-contextual residual (D-006): peer-addressed nuance, design notes
   * the structured fields can't hold. Stays free-text by design — NOT every
   * completion has this; most don't.
   */
  coordNotes: z.string().min(1).optional(),
  /** Plan slug for routing / coord:inbox grouping. */
  planSlug: z.string().min(1).optional(),
  /** Who completed it (display only; defaults from the firing agent's identity). */
  agent: z.string().min(1).optional(),
  /**
   * EI-8993 (dup-close accountability): the SURVIVING work-item id when this
   * completion closes the item as a duplicate. WI-3646 was wrongly dup-closed
   * THREE times by three different agents, each only saying "dup of WI-3543" in
   * free-text `summary` — no structured link, no notification, so the mistake
   * was undetectable by tooling and kept recurring. Setting this makes
   * `work_items:complete` auto-create a `duplicates` coord_links edge (this
   * item → duplicateOf) and auto-subscribe the item's current assignee (if any,
   * and not the closer) so the completion's existing watcher fan-out reaches
   * them even if they weren't already following it. The target must exist and
   * differ from the item being closed — validated at complete time, not
   * rendered here.
   */
  duplicateOf: z.string().min(1).optional(),
});
export type CompletionRecord = z.infer<typeof CompletionRecordSchema>;

/**
 * CLAIM / start (D-003, 5%) — "taking X". Auto-emitted when a work_item /
 * plan-item is claimed, so the agent doesn't hand-write "Executing … overnight".
 */
export const ClaimRecordSchema = z.object({
  /** The work-item / plan-item id being claimed. */
  workItem: z.string().min(1),
  /** Optional scope / approach note ("NEW test files only, no source edits"). */
  summary: z.string().min(1).optional(),
  planSlug: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
});
export type ClaimRecord = z.infer<typeof ClaimRecordSchema>;

/**
 * INTENT (D-003, part of the 29% — the biggest category) — the "heads-up /
 * now working on X" an agent declares via `coord:declare-intent`. Auto-emitted
 * so peers see it in the inbox (push) without the agent hand-writing a separate
 * "heads-up, I'm on X" coord:send. Distinct from WINDOW: an intent is a
 * statement of focus, not a scoped file-hold with a DONE.
 */
export const IntentRecordSchema = z.object({
  /** One-line "what I'm working on now". */
  intent: z.string().min(1),
  /** Files / area currently in scope, if declared. */
  files: z.array(z.string().min(1)).optional(),
  planSlug: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
});
export type IntentRecord = z.infer<typeof IntentRecordSchema>;

/**
 * WINDOW (D-003, part of the 29%) — the coordination window. "hold lib/ until
 * I post DONE" becomes a typed window claim that auto-broadcasts open /
 * draining / done. Pairs with the Gray intention-lock
 * (locks-correctness-hardening D-005).
 */
export const WINDOW_PHASES = ['open', 'draining', 'done'] as const;
export type WindowPhase = (typeof WINDOW_PHASES)[number];

export const WindowRecordSchema = z.object({
  /** The scope held — a path / glob / area, e.g. "libs/papercusp/packages/locks/*". */
  scope: z.string().min(1),
  /** Lifecycle phase of the window. */
  phase: z.enum(WINDOW_PHASES),
  /** One line on what you're doing in the window. */
  intent: z.string().min(1),
  planSlug: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
});
export type WindowRecord = z.infer<typeof WindowRecordSchema>;

/**
 * HANDOFF (D-008, the event-reaction motivating case) — the shared
 * `formatHandoff` layer. A handoff is structured (item + context + next step),
 * delivered + tracked; the render is shared so the pane render and the coord
 * notification agree.
 */
export const HandoffRecordSchema = z.object({
  /** The item being handed off (work-item id / brief / area). */
  item: z.string().min(1),
  /** Recipient agent / role, if directed; omitted ⇒ broadcast handoff. */
  to: z.string().min(1).optional(),
  /** Context the receiver needs to pick it up. */
  context: z.string().min(1),
  /** The concrete next step. */
  nextStep: z.string().min(1).optional(),
  planSlug: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
});
export type HandoffRecord = z.infer<typeof HandoffRecordSchema>;

/**
 * FINDING / health (D-003, 2%) — a discovered problem. Auto-emitted alongside
 * a work_item[kind=bug] / the watchdog event, so findings stop living only in
 * prose.
 */
export const FindingRecordSchema = z.object({
  /** One-line finding title. */
  title: z.string().min(1),
  /** Severity, freeform ('low'|'medium'|'high'|'critical' by convention). */
  severity: z.string().min(1).optional(),
  /** Detail / repro / where. */
  detail: z.string().min(1).optional(),
  /** The work_item id minted for it, if any (the bug). */
  workItemId: z.string().min(1).optional(),
  planSlug: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
});
export type FindingRecord = z.infer<typeof FindingRecordSchema>;
