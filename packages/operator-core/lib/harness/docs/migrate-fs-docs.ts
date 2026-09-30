/**
 * migrate-fs-docs — ingest a harness's existing FS docs into the typed model (P-010).
 *
 * Existing `<harness>/docs/*.md` ALREADY surface in the merged read as source=manual
 * + status=untracked (buildMergedDocs derives that for any record-less FS file), so
 * no migration is needed just to *show* them. This ingest adds VALUE: for docs that
 * declare a `documents:` frontmatter (or reference repo paths we can infer), it
 * creates an anchored manual record so they become drift-tracked. Docs with no
 * inferable subject are left record-less (the merged read keeps showing them as
 * "not drift-tracked" — we do NOT write empty rows that just mirror "the file
 * exists", per D-002's no-PG↔FS-mirror rule).
 *
 * Idempotent: re-running re-anchors from the current frontmatter; verifyAtHead
 * baselines ingested docs to the current HEAD so drift-tracking starts now (rather
 * than flagging every legacy doc for re-verify on day one).
 */

import { resolveHarnessDocPaths } from './harness-repo';
import { listDocBodies, readDocBody } from './doc-fs';
import { frontmatterDocuments, inferSubjectFromBody, anchorManualDoc } from './manual-anchor';
import { resolveWorkspaceForHarness } from '../workspace-for-harness';

export interface IngestResult {
  ok: boolean;
  error?: string;
  scanned: number;
  anchored: string[];
  skipped: string[];
}

export interface IngestOpts {
  workspaceId?: string;
  /** Baseline ingested anchored docs to current HEAD (status fresh) rather than
   *  leaving them needing verification. Default true. */
  verifyAtHead?: boolean;
}

/** Ingest one harness's FS docs → anchored manual records where a subject is declarable. */
export async function ingestHarnessDocs(harnessSlug: string, opts: IngestOpts = {}): Promise<IngestResult> {
  const verify = opts.verifyAtHead ?? true;
  const paths = await resolveHarnessDocPaths(harnessSlug);
  if (!paths) return { ok: false, error: 'unknown_harness', scanned: 0, anchored: [], skipped: [] };
  // A harness's docs live in its workspace — derive it (never a silent 'default'); the
  // path check above already validated the harness, so this resolves (P-002 / D-003).
  const workspaceId = await resolveWorkspaceForHarness(harnessSlug, opts.workspaceId);

  const files = await listDocBodies(paths.docsRoot);
  const anchored: string[] = [];
  const skipped: string[] = [];

  for (const docId of files) {
    const body = await readDocBody(paths.docsRoot, docId);
    if (body == null) {
      skipped.push(docId);
      continue;
    }
    const declared = frontmatterDocuments(body);
    const hasSubject = declared != null || inferSubjectFromBody(body).length > 0;
    if (!hasSubject) {
      // No inferable subject → leave record-less (shows as untracked in the merged read).
      skipped.push(docId);
      continue;
    }
    const res = await anchorManualDoc({ harnessSlug, docId, verify, workspaceId });
    if (res.ok && res.anchored) anchored.push(docId);
    else skipped.push(docId);
  }

  return { ok: true, scanned: files.length, anchored, skipped };
}
