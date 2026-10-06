/**
 * merged-read — the unified per-harness docs tree (P-007). Merges the FS doc
 * BODIES (git-synced files) with the PG doc RECORDS (source / drift status /
 * augmented overlay), so generated + manual + augmented docs coexist with source
 * badges, freshness, and the overlay — superseding the FS-only project-docs read.
 *
 * The spine is the UNION of FS files and record doc_ids: a file with no record is
 * an unanchored manual doc ("not drift-tracked"); a record with no file is an
 * orphan (body deleted) flagged bodyMissing so it's visible, not silently lost.
 */

import { resolveHarnessDocPaths } from './harness-repo';
import { listDocBodies, readDocBody, chooseDefaultDoc } from './doc-fs';
import { listDocRecords, type DocSource, type DocStatus, type HarnessDocRecord } from './doc-record';
import { recomputeDocStatus } from './freshness-sweep';
import { runGit } from './git-runner';
import { makeFeatureCommitLookup } from './feature-commits';
import { stringifySubjectRefs, type SubjectRef } from './subject-ref';
import { resolveWorkspaceForHarness } from '../workspace-for-harness';

export interface MergedDocEntry {
  docId: string;
  source: DocSource;
  status: DocStatus;
  statusDetail: string | null;
  subjectRef: SubjectRef[];
  /** Human-readable subject_ref ("F-3; src/a.ts :: fn"). */
  subjectLabel: string;
  anchorPaths: string[];
  generatedFromSha: string | null;
  lastVerifiedSha: string | null;
  lastVerifiedAt: string | null;
  hasOverlay: boolean;
  title: string | null;
  /** Record exists but the body file is gone. */
  bodyMissing: boolean;
  /** No PG record at all — an untracked FS doc (the old silent-rot mode, now visible). */
  tracked: boolean;
}

export interface MergedDocsResult {
  ok: boolean;
  reason?: 'unknown_harness' | 'no_docs_dir' | 'empty';
  projectPath?: string;
  docsRoot?: string;
  /** doc_ids, sorted (back-compat superset of the old DocsResponse.files). */
  files: string[];
  entries: MergedDocEntry[];
  activePath: string | null;
  /** The active doc's body (markdown). */
  content: string | null;
  /** The active doc's full record/overlay (overlay only fetched for the active doc). */
  activeEntry: (MergedDocEntry & { overlay: string | null }) | null;
}

function entryFromRecord(docId: string, rec: HarnessDocRecord | undefined, bodyMissing: boolean): MergedDocEntry {
  if (!rec) {
    return {
      docId,
      source: 'manual',
      status: 'untracked',
      statusDetail: 'not drift-tracked',
      subjectRef: [],
      subjectLabel: '',
      anchorPaths: [],
      generatedFromSha: null,
      lastVerifiedSha: null,
      lastVerifiedAt: null,
      hasOverlay: false,
      title: null,
      bodyMissing,
      tracked: false,
    };
  }
  return {
    docId,
    source: rec.source,
    status: rec.status,
    statusDetail: rec.statusDetail,
    subjectRef: rec.subjectRef,
    subjectLabel: stringifySubjectRefs(rec.subjectRef),
    anchorPaths: rec.anchorPaths,
    generatedFromSha: rec.generatedFromSha,
    lastVerifiedSha: rec.lastVerifiedSha,
    lastVerifiedAt: rec.lastVerifiedAt,
    hasOverlay: rec.overlay != null && rec.overlay.trim() !== '',
    title: rec.title,
    bodyMissing,
    tracked: true,
  };
}

export interface BuildMergedDocsOpts {
  activePath?: string;
  workspaceId?: string;
  /** Recompute the ACTIVE doc's status from git on read (cheap — 1 doc). Default false (use cache). */
  recomputeActive?: boolean;
}

/** Build the merged docs tree for a harness. */
export async function buildMergedDocs(harnessSlug: string, opts: BuildMergedDocsOpts = {}): Promise<MergedDocsResult> {
  const paths = await resolveHarnessDocPaths(harnessSlug);
  if (!paths) {
    return { ok: false, reason: 'unknown_harness', files: [], entries: [], activePath: null, content: null, activeEntry: null };
  }
  const { repoRoot, docsRoot } = paths;
  // A harness's docs live in its workspace — derive it (never a silent 'default'); the
  // path check above already validated the harness, so this resolves (P-002 / D-003).
  const workspaceId = await resolveWorkspaceForHarness(harnessSlug, opts.workspaceId);

  const [fsFiles, records] = await Promise.all([
    listDocBodies(paths.sources ? paths : docsRoot),
    listDocRecords(harnessSlug, workspaceId),
  ]);

  // Union of FS files + record doc_ids.
  const fsSet = new Set(fsFiles);
  const allIds = new Set<string>([...fsFiles, ...records.keys()]);
  const ids = [...allIds].sort();

  const entries: MergedDocEntry[] = ids.map((docId) =>
    entryFromRecord(docId, records.get(docId), /*bodyMissing*/ !fsSet.has(docId)),
  );

  if (ids.length === 0) {
    return { ok: true, reason: 'empty', projectPath: repoRoot, docsRoot, files: [], entries: [], activePath: null, content: null, activeEntry: null };
  }

  const requested = opts.activePath && ids.includes(opts.activePath) ? opts.activePath : chooseDefaultDoc(ids);
  const activePath = requested ?? null;

  let content: string | null = null;
  let activeEntry: (MergedDocEntry & { overlay: string | null }) | null = null;
  if (activePath) {
    content = fsSet.has(activePath) ? await readDocBody(paths.sources ? paths : docsRoot, activePath) : null;
    const rec = records.get(activePath);
    let base = entries.find((e) => e.docId === activePath)!;

    // Optionally refresh just the active doc's status from git (accurate for the
    // doc actually being viewed) without sweeping the whole tree.
    if (opts.recomputeActive && rec && rec.subjectRef.length > 0) {
      const { status, detail } = await recomputeDocStatus(rec, {
        runGit,
        repoRoot,
        resolveFeatureCommits: makeFeatureCommitLookup(harnessSlug, workspaceId),
      });
      base = { ...base, status, statusDetail: detail };
    }
    activeEntry = { ...base, overlay: rec?.overlay ?? null };
  }

  return { ok: true, projectPath: repoRoot, docsRoot, files: ids, entries, activePath, content, activeEntry };
}
