'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2, ChevronRight, ChevronDown } from 'lucide-react';
import { Diff, Hunk, parseDiff, type FileData } from 'react-diff-view';
import { GitTooltip } from './GitTooltip';

interface CommitMeta {
  sha: string;
  author: string;
  email: string;
  ts: number;
  parents: string[];
  subject: string;
  body: string;
  patch: string;
  patchTruncated?: boolean;
  patchTotalBytes?: number;
}

interface HunkFile {
  path: string;
  /** Parsed react-diff-view file data when the patch is small enough to render structurally. */
  parsed: FileData | null;
  /** Parsing failures fall back to the raw per-file patch instead of blanking the file. */
  parseError: string | null;
  /** True if this file's patch is too large to render through react-diff-view. */
  oversize: boolean;
  /** Raw per-file patch slice — shown as <pre> when oversize or unparseable. */
  rawPatch: string;
  added: number;
  removed: number;
}


// Per-file raw patch size cap above which we skip react-diff-view and render a
// <pre> block. Even parsed hunks can mean thousands of DOM rows for generated
// files (e.g. .papercusp/issues.json with 1700+ changed lines).
const PER_FILE_DIFF_LIMIT = 96 * 1024; // 96 KB raw patch per file

// Hard ceiling on the number of files we'll attempt to render at all.
const MAX_FILES_RENDERED = 200;

function formatFilePath(oldPath: string, newPath: string): string {
  if (!oldPath) return newPath;
  if (!newPath || oldPath === newPath) return oldPath;
  return `${oldPath} → ${newPath}`;
}

function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isDiffMetadataLine(line: string): boolean {
  return (
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('index ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('similarity index') ||
    line.startsWith('rename ') ||
    line.startsWith('copy ') ||
    line.startsWith('Binary files ') ||
    line.startsWith('GIT binary patch') ||
    line.startsWith('literal ') ||
    line.startsWith('delta ')
  );
}

/**
 * O(n) unified-diff splitter. It preserves a raw per-file patch for the
 * oversize/unparseable fallback, while small files are parsed once for
 * react-diff-view. The previous viewer rebuilt synthetic before/after files
 * and then diffed those strings again in React, which duplicated work.
 */
function splitDiff(patch: string): HunkFile[] {
  const files: HunkFile[] = [];
  const lines = patch.split('\n');

  let currentPath = '(file)';
  let raw: string[] = [];
  let added = 0;
  let removed = 0;
  let started = false;

  const flush = () => {
    if (!started) return;
    const rawPatch = raw.join('\n');
    const oversize = rawPatch.length > PER_FILE_DIFF_LIMIT;
    let parsed: FileData | null = null;
    let parseError: string | null = null;

    if (!oversize && rawPatch.trim()) {
      try {
        parsed = parseDiff(rawPatch, { nearbySequences: 'zip' })[0] ?? null;
      } catch (e) {
        parseError = toErrorMessage(e);
      }
    }

    files.push({
      path: parsed ? formatFilePath(parsed.oldPath, parsed.newPath) : currentPath,
      parsed,
      parseError,
      oversize,
      rawPatch,
      added,
      removed,
    });
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      const pathMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      currentPath = pathMatch?.[2] ?? pathMatch?.[1] ?? '(file)';
      raw = [line];
      added = 0;
      removed = 0;
      started = true;
      continue;
    }
    if (!started) continue;
    raw.push(line);

    if (line.startsWith('@@') || isDiffMetadataLine(line)) {
      continue;
    }
    if (line.startsWith('-')) {
      removed++;
    } else if (line.startsWith('+')) {
      added++;
    }
  }
  flush();
  return files;
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function DiffFileViewer({ file }: { file: FileData }) {
  return (
    <Diff
      viewType="unified"
      diffType={file.type}
      hunks={file.hunks}
      className="h-git-diff-table"
      hunkClassName="h-git-diff-hunk"
      lineClassName="h-git-diff-line"
      gutterClassName="h-git-diff-gutter"
      codeClassName="h-git-diff-code"
      // react-diff-view ignores `lineClassName` unless this forwards the
      // generated class string, so keep the passthrough for our 11px row style.
      generateLineClassName={({ defaultGenerate }) => defaultGenerate()}
    >
      {(hunks) =>
        hunks.map((hunk, hunkIndex) => (
          <Hunk
            key={`${file.newPath || file.oldPath}-${hunk.oldStart}-${hunk.newStart}-${hunkIndex}`}
            hunk={hunk}
          />
        ))
      }
    </Diff>
  );
}

function RawPatchFallback({ file }: { file: HunkFile }) {
  return (
    <>
      {file.parseError ? (
        <div className="h-git-diff-warning">
          Couldn’t parse this file into structured hunks. Showing raw patch.
        </div>
      ) : null}
      <pre className="h-git-raw-patch">{file.rawPatch}</pre>
    </>
  );
}

export function CommitDetail({
  sha,
  showCommitUrl,
  remoteCommitUrl,
  onClose,
  inline,
}: {
  sha: string;
  /** Function building the API URL for the commit detail (returns full diff/patch). */
  showCommitUrl: (sha: string) => string;
  /** Optional builder for an external view URL (e.g. github.com/owner/repo/commit/SHA). */
  remoteCommitUrl?: (sha: string) => string;
  onClose: () => void;
  /**
   * When true, renders the drawer directly in the component tree instead of
   * portaling to document.body. Use for two-pane layouts where the caller
   * owns the containing box. The overlay backdrop is suppressed.
   */
  inline?: boolean;
}) {
  const [meta, setMeta] = useState<CommitMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** Async-split state: gated so we can show "parsing diff…" while it's pending. */
  const [files, setFiles] = useState<HunkFile[] | null>(null);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  // A commit whose every changed path is excluded by the server's default
  // diff filter (.papercusp/**, lockfiles, snapshots) comes back with an empty
  // patch. Automatically retry once with ?full=1 instead of making the user
  // click through a second "show diff" affordance.
  const [fullForSha, setFullForSha] = useState<string | null>(null);
  const full = fullForSha === sha;

  // Resolve to a plain string so the effect doesn't re-run on every parent
  // render. Callers commonly pass an inline arrow `(sha) => `/api/.../${sha}``
  // whose identity changes each render — including it in deps caused an
  // infinite abort/refetch loop and left the UI stuck on "loading diff…".
  const baseUrl = showCommitUrl(sha);
  const fetchUrl = full
    ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}full=1`
    : baseUrl;

  // One fetch per commit, aborted on cleanup. React 19 strict-mode dev
  // double-mounts this component (mount → unmount → mount); without an
  // abort, BOTH mounts' fetches stay alive and hit the server — two
  // identical git/show requests per click. Each effect run owns its own
  // controller, so the live run's fetch is simply never aborted; only
  // superseded runs are. No shared guard, so none of the races the old
  // flag/mountedRef approaches hit.
  useEffect(() => {
    setMeta(null);
    setError(null);
    setFiles(null);
    setCopied(false);
    const ctrl = new AbortController();
    // Bound the fetch — the route can hang when PG is unreachable or the
    // dev server is mid-compile; without this the modal sits on
    // "loading diff…" forever. 30s gives big patches room while still
    // surfacing real hangs (the server itself caps git show at 30s).
    const signal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(30_000)]);
    fetch(fetchUrl, { signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (d.error) setError(d.error);
        else setMeta(d);
      })
      .catch((e) => {
        // Superseded by a newer fetch (commit switch / unmount) — the
        // live effect run owns the UI now; stay silent.
        if (ctrl.signal.aborted) return;
        const name = (e as Error).name;
        if (name === 'TimeoutError' || name === 'AbortError') {
          setError('Server took >30s to respond. PG may be unreachable or the dev server is mid-compile.');
        } else {
          setError(String(e));
        }
      });
    return () => { ctrl.abort(); };
  }, [fetchUrl]);

  // Parse the patch off the synchronous render path. For multi-MB patches
  // splitDiff can still take 200-800 ms; pushing it into a microtask lets
  // the "parsing diff…" frame paint instead of leaving the user stuck on
  // "loading diff…" while the main thread is busy.
  useEffect(() => {
    if (!meta) return;
    setExpanded({});
    // An empty patch is a real, common state: a merge/empty commit, or — the
    // usual case in harness repos — a commit whose every changed path is
    // excluded by default (.papercusp/**, lockfiles, snapshots). For non-merge
    // commits, retry with `full=1` automatically so the diff surface shows the
    // patch as soon as it is available instead of hiding it behind a button.
    if (!meta.patch) {
      if (!full && meta.parents.length <= 1) {
        setFiles(null);
        setFullForSha(sha);
        return;
      }
      setFiles([]);
      return;
    }
    setFiles(null);
    const id = setTimeout(() => {
      try {
        const parsed = splitDiff(meta.patch);
        setFiles(parsed);
        const initial = Object.fromEntries(
          parsed.slice(0, MAX_FILES_RENDERED).map((_, i) => [i, true]),
        ) as Record<number, boolean>;
        setExpanded(initial);
      } catch (e) {
        setError(`diff parse failed: ${String(e)}`);
      }
    }, 0);
    return () => { clearTimeout(id); };
  }, [full, meta, sha]);

  const toggleFile = useCallback((idx: number) => {
    setExpanded((prev) => ({ ...prev, [idx]: !prev[idx] }));
  }, []);

  const expandAll = useCallback(() => {
    if (!files) return;
    const all: Record<number, boolean> = {};
    for (let i = 0; i < Math.min(files.length, MAX_FILES_RENDERED); i++) all[i] = true;
    setExpanded(all);
  }, [files]);

  const collapseAll = useCallback(() => setExpanded({}), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const filesToShow = useMemo(() => {
    if (!files) return [] as HunkFile[];
    return files.slice(0, MAX_FILES_RENDERED);
  }, [files]);

  const fileCount = files?.length ?? 0;
  const hiddenCount = Math.max(0, fileCount - MAX_FILES_RENDERED);
  const displaySha = meta?.sha ?? sha;

  const copySha = async () => {
    try {
      let copiedSha = false;
      if (navigator.clipboard && window.isSecureContext) {
        try {
          await navigator.clipboard.writeText(displaySha);
          copiedSha = true;
        } catch {
          copiedSha = false;
        }
      }
      if (!copiedSha) {
        const textarea = document.createElement('textarea');
        textarea.value = displaySha;
        textarea.setAttribute('readonly', 'true');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1300);
    } catch {
      setCopied(false);
    }
  };

  const drawer = (
    <section
      className={`h-git-detail-drawer${inline ? ' h-git-detail-drawer--inline' : ''}`}
      onClick={inline ? undefined : (e) => e.stopPropagation()}
      aria-label="Commit diff"
    >
        <header className="h-git-detail-head">
          <div className="h-git-detail-id">
            <span>commit</span>
            <code>{displaySha.slice(0, 12)}</code>
          </div>

          <div className="h-git-detail-title-stack">
            <strong>{meta?.subject ?? 'Loading commit…'}</strong>
            <div className="h-git-detail-meta">
              <span>{meta?.author ?? 'resolving author'}</span>
              <span>{meta ? formatTs(meta.ts) : 'loading timestamp'}</span>
              <span>{fileCount} file{fileCount === 1 ? '' : 's'}</span>
              {meta?.parents.length ? <span>{meta.parents.length} parent{meta.parents.length === 1 ? '' : 's'}</span> : null}
              {meta?.patchTruncated ? <span style={{ color: 'var(--bad)' }}>patch truncated</span> : null}
            </div>
          </div>

          <div className="h-git-detail-actions">
            <button type="button" className="h-git-detail-copy" onClick={copySha}>
              {copied ? 'copied' : 'copy sha'}
            </button>
            <GitTooltip label="Close (esc)">
              <button className="h-btn-icon" onClick={onClose} aria-label="Close commit detail">
                <X size={14} />
              </button>
            </GitTooltip>
          </div>
        </header>

        {!meta && !error && (
          <div className="h-empty h-git-detail-loading">
            <Loader2 size={16} className="h-empty-icon" />
            <span>loading diff…</span>
          </div>
        )}
        {meta && !files && !error && (
          <div className="h-empty h-git-detail-loading">
            <Loader2 size={16} className="h-empty-icon" />
            <span>parsing diff…</span>
          </div>
        )}
        {error && <div className="h-empty h-git-error">{error}</div>}

        {meta && files && (
          <div className="h-git-detail-body">
            {meta.body && (
              <pre className="h-git-detail-message">{meta.body}</pre>
            )}
            {files.length === 0 && !error && (
              <div className="h-git-detail-empty">
                {meta.parents.length > 1
                  ? 'Merge commit — no combined diff to display.'
                  : 'Empty commit — no file changes.'}
              </div>
            )}
            {filesToShow.length > 0 && (
              <div className="h-git-detail-toolbar">
                <button type="button" className="h-git-detail-copy" onClick={expandAll}>expand all</button>
                <button type="button" className="h-git-detail-copy" onClick={collapseAll}>collapse all</button>
              </div>
            )}
            {filesToShow.map((f, idx) => {
              const isOpen = !!expanded[idx];
              return (
                <div key={`${f.path}:${idx}`} className="h-git-file-card">
                  <button
                    type="button"
                    className="h-git-file-head h-git-file-head-button"
                    onClick={() => toggleFile(idx)}
                    aria-expanded={isOpen}
                  >
                    {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <span>{f.path}</span>
                    <span className="h-git-file-stats">
                      {f.parsed ? (
                        <span className={`h-git-file-kind h-git-file-kind--${f.parsed.type}`}>
                          {f.parsed.type}
                        </span>
                      ) : null}
                      <span style={{ color: 'var(--good)' }}>+{f.added}</span>
                      <span style={{ color: 'var(--bad)' }}>−{f.removed}</span>
                    </span>
                    {f.oversize ? (
                      <span className="h-git-file-note">
                        large — raw patch ({formatBytes(f.rawPatch.length)})
                      </span>
                    ) : null}
                    {f.parseError ? (
                      <span className="h-git-file-note" title={f.parseError}>
                        raw patch
                      </span>
                    ) : null}
                  </button>
                  {isOpen ? (
                    <div className="h-git-diff-table-wrap">
                      {f.parsed && f.parsed.hunks.length ? (
                        <DiffFileViewer file={f.parsed} />
                      ) : (
                        <RawPatchFallback file={f} />
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {hiddenCount > 0 && (
              <div className="h-git-detail-empty">
                … {hiddenCount} more file{hiddenCount === 1 ? '' : 's'} not rendered (showing first {MAX_FILES_RENDERED}).
              </div>
            )}
          </div>
        )}
      </section>
  );

  if (inline) return drawer;

  // Portal to <body> so the overlay's `position: fixed; inset: 0` is
  // viewport-relative. Ancestors of the git panel (resizable-panels,
  // animation wrappers) apply CSS transforms which establish a
  // containing block for fixed positioning — without the portal, the
  // overlay gets visually trapped inside the small git panel.
  const overlay = (
    <div
      role="dialog"
      aria-modal="true"
      className="h-git-detail-overlay"
      onClick={onClose}
    >
      {drawer}
    </div>
  );
  if (typeof document === 'undefined') return overlay;
  return createPortal(overlay, document.body);
}
