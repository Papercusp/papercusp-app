/**
 * manual-anchor — the manual-doc authoring/anchoring path (P-006).
 *
 * A manual doc declares what it documents via a `documents:` frontmatter key, or
 * we infer it from the repo paths the body references. `last_verified_sha` is set
 * when a human verifies (→ the drift baseline). An UNANCHORED manual doc is allowed
 * but surfaces as "not drift-tracked" — the old silent-rot mode made VISIBLE, not
 * hidden.
 */

import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { repoHeadSha, runGit } from './git-runner';
import { resolveHarnessDocPaths } from './harness-repo';
import { readDocBody } from './doc-fs';
import { makeFeatureCommitLookup } from './feature-commits';
import { parseDocumentsField, resolveAllAnchorPaths, frontmatterDocuments, type SubjectRef } from './subject-ref';
import { upsertDocRecord, getDocRecord, verifyDoc, type HarnessDocRecord } from './doc-record';
import { resolveWorkspaceForHarness } from '../workspace-for-harness';

// Re-exported for existing callers (agent-tools/docs/author, migrate-fs-docs, tests) —
// the implementation now lives in subject-ref.ts (WI-1576), the dependency-light pure
// module, so a caller that only needs frontmatter parsing doesn't drag in this file's
// PG-backed anchoring machinery.
export { frontmatterDocuments };

/**
 * Infer subject refs from the repo paths a doc body references — best-effort: any
 * inline-code or fenced-block token that looks like a repo file path
 * (has a slash + a known code extension). A secondary signal when the author
 * didn't declare `documents:`. Returns [] when nothing path-like is found.
 */
export function inferSubjectFromBody(body: string): SubjectRef[] {
  const found = new Set<string>();
  // `path/like/this.ts` in inline code, or after a fence info-string.
  const codeTokens = body.match(/`([^`]+)`/g) ?? [];
  const fenceTitles = body.match(/```[^\n]*\b(?:title|file)=["']?([^\s"'`]+)/gi) ?? [];
  const cand: string[] = [
    ...codeTokens.map((t) => t.replace(/`/g, '').trim()),
    ...fenceTitles.map((t) => /["']?([^\s"'`]+)$/.exec(t)?.[1] ?? ''),
  ];
  for (const c of cand) {
    if (/^[\w./-]+\/[\w./-]+\.(ts|tsx|js|jsx|rs|py|go|sql|mjs|cjs|json|md|mdx|css|sh)$/i.test(c)) {
      found.add(c);
    }
  }
  return found.size ? [{ kind: 'path', globs: [...found] }] : [];
}

export interface AnchorManualDocInput {
  harnessSlug: string;
  docId: string;
  /** Explicit subject refs; when omitted, read from frontmatter then inferred. */
  documents?: unknown;
  /** Set the verify baseline to HEAD now (a human confirming the doc is current). */
  verify?: boolean;
  title?: string;
  workspaceId?: string;
  /**
   * The doc's canonical prose (P-008 / D-025) — the whole .mdx text, frontmatter included.
   *
   * Supplying it makes this call the PG-canonical write: the row carries the prose, and the
   * file becomes a projection of it. It also lets the caller anchor a doc whose file does
   * not exist yet, which is required now that docs:author writes PG BEFORE the file — the
   * inference path below would otherwise read a file that is not there and silently anchor
   * nothing. Omit to leave existing prose untouched (the re-anchor / sweep path).
   */
  content?: string;
}

export type AnchorResult =
  | { ok: true; record: HarnessDocRecord; subjectRef: SubjectRef[]; anchored: boolean }
  | { ok: false; error: string };

/**
 * Anchor (or re-anchor) a manual doc: resolve its subject_ref (arg → frontmatter →
 * inference), denormalise anchor_paths, and upsert a source=manual record. With
 * verify=true, stamp last_verified_sha=HEAD and mark fresh; otherwise an anchored
 * doc is 'review' (verify to establish a baseline) and an unanchored doc is
 * 'untracked' (visibly not drift-tracked).
 */
export async function anchorManualDoc(input: AnchorManualDocInput): Promise<AnchorResult> {
  const docId = input.docId.trim().replace(/^\.?\//, '');
  if (!docId) return { ok: false, error: 'doc_id_required' };

  const paths = await resolveHarnessDocPaths(input.harnessSlug);
  if (!paths) return { ok: false, error: 'unknown_harness' };
  const { repoRoot, docsRoot } = paths;
  // A harness's docs live in its workspace — derive it (never a silent 'default'); the
  // path check above already validated the harness, so this resolves (P-002 / D-003).
  const workspaceId = await resolveWorkspaceForHarness(input.harnessSlug, input.workspaceId);

  let documents = input.documents;
  if (documents == null) {
    // Prefer the caller's canonical prose over the file. Under PG-canonical authoring the
    // row is written BEFORE the file exists, so reading disk here would infer from a
    // missing file and anchor nothing — the doc would ship silently untracked.
    const body = input.content ?? (await readDocBody(docsRoot, docId));
    if (body) {
      documents = frontmatterDocuments(body);
      if (documents == null) {
        // INFERENCE ONLY (no explicit `documents:`): a body code-span that looks like a
        // path is a GUESS. Keep only guesses that resolve to a real repo file — else the
        // inference scoops up placeholders (`lib/foo.ts`), illustrative examples
        // (`utils/normalizeX.ts`), and untrackable home/env paths (`~/.claude/…`,
        // `CODEX_HOME/…`) and stores them as dead anchors (docs-audit 2026-06-23, #4).
        // Explicit `documents:` paths are NOT filtered — a wrong one there is an author
        // bug we want surfaced, not silently dropped.
        const inferred = inferSubjectFromBody(body);
        if (inferred.length) {
          // EI-6592: a doc's own prose legitimately quotes its OWN path sometimes (a
          // changelog note naming the tracking item about itself, e.g.) — never treat
          // that as a meaningful subject. Left unguarded, this is how a body-inferred
          // doc self-widens WITHOUT BOUND: `reconcileAllDocAnchors` (sweep-after-sync.ts)
          // re-runs this same inference on a recurring cadence with the doc's CURRENT
          // body, so once a doc mentions its own path (to explain "what changed" about
          // itself), every future reconcile tick re-discovers and re-persists that
          // self-mention as a permanent anchor — confirmed live on
          // docs/archive/signal-fusion-activation-A-D.md (oddsmith), whose anchor set
          // came to include its own path after a re-verification note quoted it.
          const selfRepoRelPath = relative(repoRoot, join(docsRoot, docId)).split(sep).join('/');
          const real = inferred
            .flatMap((r) => (r.kind === 'path' ? r.globs : []))
            .filter((g) => g !== selfRepoRelPath && existsSync(join(repoRoot, g)));
          if (real.length) documents = real;
        }
      }
    }
  }

  const subjectRef = parseDocumentsField(documents);
  const deps = { runGit, repoRoot, resolveFeatureCommits: makeFeatureCommitLookup(input.harnessSlug, workspaceId) };
  const anchorPaths = await resolveAllAnchorPaths(subjectRef, deps);
  const anchored = subjectRef.length > 0;

  let lastVerifiedSha: string | null = null;
  if (input.verify && anchored) {
    lastVerifiedSha = await repoHeadSha(repoRoot);
  }

  const status = !anchored ? 'untracked' : lastVerifiedSha ? 'fresh' : 'review';
  const record = await upsertDocRecord({
    harnessSlug: input.harnessSlug,
    docId,
    workspaceId,
    source: 'manual',
    subjectRef,
    anchorPaths,
    lastVerifiedSha,
    ...(lastVerifiedSha ? { lastVerifiedAt: new Date().toISOString() } : {}),
    status,
    statusDetail: anchored ? (lastVerifiedSha ? null : 'anchored — verify to set a baseline') : 'not drift-tracked (no subject_ref)',
    ...(input.title ? { title: input.title } : {}),
    // Absent means "leave the prose alone", never "the prose is empty" — the re-anchor and
    // freshness-sweep callers hold no opinion about the body and must not blank it.
    ...(input.content !== undefined ? { content: input.content } : {}),
  });
  return { ok: true, record, subjectRef, anchored };
}

/** Verify a manual doc against HEAD (re-verify action) — sets baseline + fresh. */
export async function verifyManualDoc(
  harnessSlug: string,
  docId: string,
  workspaceId?: string,
): Promise<{ ok: true; verifiedSha: string } | { ok: false; error: string }> {
  const id = docId.trim().replace(/^\.?\//, '');
  // Validate the harness FIRST (returns unknown_harness), then derive its workspace — never
  // a silent 'default' for an omitted scope (P-002 / D-003).
  const paths = await resolveHarnessDocPaths(harnessSlug);
  if (!paths) return { ok: false, error: 'unknown_harness' };
  workspaceId = await resolveWorkspaceForHarness(harnessSlug, workspaceId);
  const existing = await getDocRecord(harnessSlug, id, workspaceId);
  if (!existing) return { ok: false, error: 'unknown_doc' };
  if (!existing.subjectRef || existing.subjectRef.length === 0) {
    return { ok: false, error: 'unanchored — declare documents: before verifying' };
  }
  const head = await repoHeadSha(paths.repoRoot);
  if (!head) return { ok: false, error: 'no_head_sha' };
  await verifyDoc(harnessSlug, id, head, workspaceId);
  return { ok: true, verifiedSha: head };
}
