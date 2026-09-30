'use client';

/**
 * Per-revision diff modal — plan-agent-launch P-018.
 *
 * Mirrors the deleted `GitDiffModal` (P-303), but sources the patch
 * from the `plan_revisions` snapshot pair via `plans:revision-diff`
 * instead of `git diff <hash>^!`. The renderer is identical:
 * `parseDiff` → `react-diff-view`'s `Diff`/`Hunk`; raw-patch fallback
 * when parsing fails; empty-state when the diff is empty.
 *
 * Opened by a row click in `RevisionsPanel`; the open revision id is
 * URL-backed (`?rev=<id>`) by P-020 (the caller threads the state).
 */

import { useEffect, useMemo, useState } from 'react';
import { Diff, Hunk, parseDiff, type FileData } from 'react-diff-view';
import { Modal } from '@/app/harness/Modal';
import {
  fetchPlanRevisionDiff,
  type PlanRevisionDiffResult,
} from './plans-api';

interface Props {
  /** The revision id to diff against its predecessor; null hides the
   *  modal entirely. */
  revisionId: number | null;
  onClose: () => void;
}

export default function RevisionDiffModal({ revisionId, onClose }: Props) {
  const [result, setResult] = useState<PlanRevisionDiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (revisionId === null) {
      setResult(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPlanRevisionDiff(revisionId)
      .then((r) => { if (!cancelled) setResult(r); })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [revisionId]);

  const { files, parseError } = useMemo(() => {
    if (!result) {
      return { files: [] as FileData[], parseError: null as string | null };
    }
    try {
      return {
        files: parseDiff(result.diff, { nearbySequences: 'zip' }),
        parseError: null,
      };
    } catch (e) {
      return {
        files: [] as FileData[],
        parseError: e instanceof Error ? e.message : String(e),
      };
    }
  }, [result]);

  const titleLabel =
    result === null
      ? 'Revision diff'
      : result.priorSeq === null
        ? `Revision #${result.seq} (creation)`
        : `Revision #${result.seq} vs #${result.priorSeq}`;

  return (
    <Modal
      open={revisionId !== null}
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={titleLabel}
      srOnlyTitle
      contentClassName="pc-git-diff"
    >
      <header className="pc-git-diff__head">
        <h3>{titleLabel}</h3>
        <button
          type="button"
          className="pc-git-diff__close"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
      </header>
      {loading ? <div className="pc-git-diff__loading">Loading…</div> : null}
      {error ? <div className="pc-git-diff__error">{error}</div> : null}
      {result && !loading && !error ? (
        <div className="pc-git-diff__body">
          <DiffBody diff={result.diff} files={files} parseError={parseError} />
        </div>
      ) : null}
    </Modal>
  );
}

/**
 * Body of the diff modal — parsed per-file cards when react-diff-view
 * understood the patch, otherwise the raw patch text as a fallback.
 * Exported for unit coverage.
 */
export function DiffBody({
  diff,
  files,
  parseError,
}: {
  diff: string;
  files: FileData[];
  parseError: string | null;
}) {
  const parseWarning = parseError ? (
    <div className="pc-git-diff__parse-warning">
      Couldn’t parse the diff into structured hunks. Showing raw patch below.
    </div>
  ) : null;

  if (files.length) {
    return (
      <>
        {parseWarning}
        {files.map((file, index) => (
          <DiffFileCard
            key={`${file.oldRevision}-${file.newRevision}-${file.newPath ?? file.oldPath}-${index}`}
            file={file}
          />
        ))}
      </>
    );
  }

  if (diff.trim()) {
    return (
      <>
        {parseWarning}
        <pre className="pc-git-diff__raw">{diff}</pre>
      </>
    );
  }

  return <div className="pc-git-diff__empty">No changes in this revision.</div>;
}

function DiffFileCard({ file }: { file: FileData }) {
  const { additions, deletions } = countChanges(file);
  return (
    <section className="pc-git-diff-file">
      <header className="pc-git-diff-file__head">
        <div className="pc-git-diff-file__path">
          <code>{formatFilePath(file.oldPath, file.newPath)}</code>
        </div>
        <div className="pc-git-diff-file__meta">
          <span className={`pc-git-diff-file__type pc-git-diff-file__type--${file.type}`}>
            {file.type}
          </span>
          <span className="pc-git-diff-file__stat pc-git-diff-file__stat--add">+{additions}</span>
          <span className="pc-git-diff-file__stat pc-git-diff-file__stat--del">-{deletions}</span>
        </div>
      </header>
      <div className="pc-git-diff-file__table">
        <Diff
          viewType="unified"
          diffType={file.type}
          hunks={file.hunks}
          className="pc-git-diff-table"
          hunkClassName="pc-git-diff-hunk"
          lineClassName="pc-git-diff-line"
          gutterClassName="pc-git-diff-gutter"
          codeClassName="pc-git-diff-code"
          generateLineClassName={({ defaultGenerate }) => defaultGenerate()}
        >
          {(hunks) =>
            hunks.map((hunk, hunkIndex) => (
              <Hunk
                key={`${file.newPath ?? file.oldPath}-${hunk.oldStart}-${hunk.newStart}-${hunkIndex}`}
                hunk={hunk}
              />
            ))
          }
        </Diff>
      </div>
    </section>
  );
}

/** Pure: render `a → b` only when paths differ; exported for tests. */
export function formatFilePath(oldPath: string, newPath: string): string {
  if (!oldPath) return newPath;
  if (!newPath || oldPath === newPath) return oldPath;
  return `${oldPath} → ${newPath}`;
}

/** Pure: tally + and − lines across hunks; exported for tests. */
export function countChanges(file: FileData): {
  additions: number;
  deletions: number;
} {
  return file.hunks.reduce(
    (totals, hunk) => {
      for (const change of hunk.changes) {
        if (change.type === 'insert') totals.additions += 1;
        else if (change.type === 'delete') totals.deletions += 1;
      }
      return totals;
    },
    { additions: 0, deletions: 0 },
  );
}
