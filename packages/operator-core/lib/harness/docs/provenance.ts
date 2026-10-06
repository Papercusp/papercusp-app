/**
 * provenance — capture a generated doc's drift anchor as a byproduct of generation
 * (P-004 / D-001). When the documenter writes docs/features/F-<id>.md it calls
 * harness_docs:record with what it read (the feature + the files/symbols); we stamp
 * generated_from_sha = the harness repo's current HEAD, resolve the anchor paths,
 * and upsert the record. Provenance is recorded, never reverse-engineered.
 *
 * A regeneration re-calls this with the new HEAD; upsertDocRecord preserves any
 * human overlay + the augmented source (D-003/P-005).
 */

import { parseDocumentsField, parseSubjectRef, resolveAllAnchorPaths, type SubjectRef } from './subject-ref';
import { runGit, repoHeadSha } from './git-runner';
import { resolveHarnessDocPaths } from './harness-repo';
import { readDocBody } from './doc-fs';
import { makeFeatureCommitLookup } from './feature-commits';
import { upsertDocRecord, type HarnessDocRecord } from './doc-record';
import { resolveWorkspaceForHarness } from '../workspace-for-harness';

export interface RecordGeneratedDocInput {
  harnessSlug: string;
  /** docsRoot-relative path of the generated doc, e.g. 'features/F-3.md'. */
  docId: string;
  /** The subject refs the documenter read (feature ids / paths / symbols). */
  documents?: unknown;
  title?: string;
  workspaceId?: string;
}

export type RecordGeneratedDocResult =
  | { ok: true; record: HarnessDocRecord; generatedFromSha: string; subjectRef: SubjectRef[]; anchorPaths: string[] }
  | { ok: false; error: string };

/** Infer a feature subject ref from a `features/F-NNN.md` doc id when the
 *  documenter didn't pass explicit provenance. */
function inferFromDocId(docId: string): SubjectRef[] {
  const m = /(?:^|\/)((?:F|WI)-\d+)\.(?:md|mdx)$/i.exec(docId);
  if (m) {
    const r = parseSubjectRef(m[1]);
    return r ? [r] : [];
  }
  return [];
}

/**
 * Doc records use the docs-root-relative filename as their identity. The docs
 * author emits `.mdx` paths, but callers commonly pass the page id without its
 * extension (the form returned by the read/search surfaces), so canonicalize
 * that shorthand before touching the record store.
 */
function normalizeDocId(raw: string): string {
  const trimmed = raw.trim().replace(/^\.?\//, '');
  if (!trimmed || /\.mdx?$/i.test(trimmed)) return trimmed;
  return `${trimmed}.mdx`;
}

export async function recordGeneratedDoc(input: RecordGeneratedDocInput): Promise<RecordGeneratedDocResult> {
  const docId = normalizeDocId(input.docId);
  if (!docId) return { ok: false, error: 'doc_id_required' };

  const paths = await resolveHarnessDocPaths(input.harnessSlug);
  if (!paths) return { ok: false, error: 'unknown_harness' };
  const { repoRoot } = paths;
  if (paths.sources && Object.hasOwn(paths.sources, docId.split('/')[0])) {
    return { ok: false, error: 'file_authoritative_source — use manual anchoring, not generated content' };
  }
  if ((await readDocBody(paths.sources ? paths : paths.docsRoot, docId)) === null) return { ok: false, error: 'unknown_doc' };

  // A harness's docs live in its workspace — derive it (never a silent 'default'); the
  // repo-root check above already validated the harness, so this resolves (P-002 / D-003).
  const workspaceId = await resolveWorkspaceForHarness(input.harnessSlug, input.workspaceId);

  const head = await repoHeadSha(repoRoot);
  if (!head) return { ok: false, error: 'no_head_sha' };

  let subjectRef = parseDocumentsField(input.documents);
  if (subjectRef.length === 0) subjectRef = inferFromDocId(docId);

  const deps = { runGit, repoRoot, resolveFeatureCommits: makeFeatureCommitLookup(input.harnessSlug, workspaceId) };
  const anchorPaths = await resolveAllAnchorPaths(subjectRef, deps);

  const record = await upsertDocRecord({
    harnessSlug: input.harnessSlug,
    docId,
    workspaceId,
    source: 'generated',
    subjectRef,
    anchorPaths,
    generatedFromSha: head,
    // A freshly generated doc is fresh by construction; if it has no anchor it
    // records as generated-but-untracked (visible, not silently "fresh").
    status: subjectRef.length > 0 ? 'fresh' : 'untracked',
    statusDetail: subjectRef.length > 0 ? null : 'generated without a subject_ref — not drift-tracked',
    ...(input.title ? { title: input.title } : {}),
  });

  // P-009: the documenter just wrote/refreshed the doc file — queue its
  // harness surface into the doc-section embedding store (coalesced,
  // fire-and-forget, VITEST-inert; the record never blocks on it).
  try {
    const { queueHarnessDocSectionSync } = await import('../../search/doc-embed-sync');
    queueHarnessDocSectionSync(input.harnessSlug);
  } catch {
    // fail-open
  }

  return { ok: true, record, generatedFromSha: head, subjectRef, anchorPaths };
}
