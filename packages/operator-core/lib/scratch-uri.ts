/**
 * Scratch URI scheme — Phase 4 T2.3 (tool-output-as-resource).
 *
 * URI shape:
 *   papercusp://scratch/<workspace>/<toolName>/<runId>/<basename>
 *
 * Filesystem mapping:
 *   ~/.papercusp/scratch/<workspace>/<toolName>/<runId>/<basename>
 *
 * Designed so a tool emitting 200MB+ outputs (CSV exports, repomix
 * bundles, large screenshots) doesn't inline bytes in the SSE
 * stream. The handler writes to scratch, returns `outputRef:
 * <uri>`, the framework emits a `chunk` event with the URI and
 * includes a resource link in the MCP `tools/call` response.
 *
 * Path traversal validation is mandatory at BOTH write AND read.
 * See validateScratchUri / safeScratchFilesystemPath below.
 *
 * Plan ref: phase-4-endpoint-system-2026-05-12.md § T2.3.
 */

import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export const SCRATCH_SCHEME = 'papercusp://scratch';

/** Strict basename — no separators, no special names, no leading/trailing dot. */
const BASENAME_REGEX = /^[A-Za-z0-9._-]+$/;
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOL_NAME_REGEX = /^[A-Za-z0-9._:-]+$/;
const WORKSPACE_REGEX = /^[A-Za-z0-9._:-]+$/;

export interface ScratchUriParts {
  workspaceId: string;
  toolName: string;
  runId: string;
  basename: string;
}

export class ScratchUriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScratchUriError';
  }
}

/**
 * Validate + parse a `papercusp://scratch/<ws>/<tool>/<run>/<file>` URI.
 * Throws ScratchUriError on any traversal-suspect input. Caller is
 * additionally responsible for verifying the workspace exists in the
 * registry — this validator only checks shape.
 */
export function parseScratchUri(uri: string): ScratchUriParts {
  if (!uri.startsWith(`${SCRATCH_SCHEME}/`)) {
    throw new ScratchUriError(`scratch URI must start with "${SCRATCH_SCHEME}/", got "${uri.slice(0, 32)}…"`);
  }
  const rest = uri.slice(`${SCRATCH_SCHEME}/`.length);
  // Reject CR/LF/null/percent-encoded percent up front — paranoia
  // about consumers that might URL-decode somewhere down the line.
  if (/[\r\n\0%]/.test(rest)) {
    throw new ScratchUriError(`scratch URI contains forbidden characters`);
  }
  const segs = rest.split('/');
  if (segs.length !== 4) {
    throw new ScratchUriError(
      `scratch URI must have exactly 4 segments (workspace/tool/run/basename); got ${segs.length}`,
    );
  }
  const [workspaceId, toolName, runId, basename] = segs;

  if (!WORKSPACE_REGEX.test(workspaceId) || workspaceId === '.' || workspaceId === '..') {
    throw new ScratchUriError(`scratch URI: workspace "${workspaceId}" has invalid shape`);
  }
  if (!TOOL_NAME_REGEX.test(toolName) || (!toolName.includes('.') && !toolName.includes(':')) || toolName === '.' || toolName === '..') {
    // Tool names use the same namespace-separator rule as the MCP
    // tool registry (dot or colon). Reject literal "." / ".." too.
    throw new ScratchUriError(`scratch URI: toolName "${toolName}" missing namespace separator or has invalid charset`);
  }
  if (!UUID_V4_REGEX.test(runId)) {
    throw new ScratchUriError(`scratch URI: runId "${runId}" is not a UUID`);
  }
  validateBasename(basename);
  return { workspaceId, toolName, runId, basename };
}

/**
 * Validate a basename for scratch storage. Used by both URI parsing
 * (read path) AND by handlers writing into scratch (write path).
 * Throws on `..`, absolute paths, embedded separators, special names,
 * or leading/trailing dot.
 */
export function validateBasename(basename: string): void {
  if (!basename || basename.length === 0) {
    throw new ScratchUriError(`scratch basename must not be empty`);
  }
  if (basename.length > 255) {
    throw new ScratchUriError(`scratch basename exceeds 255 chars`);
  }
  if (!BASENAME_REGEX.test(basename)) {
    throw new ScratchUriError(`scratch basename "${basename}" contains forbidden characters (allowed: A-Za-z0-9._-)`);
  }
  if (basename === '.' || basename === '..') {
    throw new ScratchUriError(`scratch basename cannot be "." or ".."`);
  }
  if (basename.startsWith('.') || basename.endsWith('.')) {
    throw new ScratchUriError(`scratch basename cannot start or end with "."`);
  }
}

/**
 * Resolve a scratch URI to an absolute filesystem path. Performs
 * `path.resolve` containment check on top of the URI-parser's regex
 * validation — defense in depth.
 *
 * Caller MUST verify the workspace exists in the registry before
 * trusting the result. This function only enforces shape + containment.
 */
export function safeScratchFilesystemPath(uri: string): string {
  const parts = parseScratchUri(uri);
  const wsRoot = scratchRootForWorkspace(parts.workspaceId);
  const candidate = resolve(wsRoot, parts.toolName, parts.runId, parts.basename);
  // Containment: the resolved path MUST live under BOTH the workspace's
  // scratch root AND the global scratch base. Checking only the
  // workspace root is insufficient — a workspace named ".." would
  // first escape via scratchRootForWorkspace, then satisfy the
  // per-workspace containment trivially (round-11 audit bug #26).
  const globalRoot = scratchRoot();
  const inWorkspace = candidate === wsRoot || candidate.startsWith(wsRoot + sep);
  const inGlobal = candidate === globalRoot || candidate.startsWith(globalRoot + sep);
  if (!inWorkspace || !inGlobal) {
    throw new ScratchUriError(
      `scratch URI resolved outside its scratch root (candidate=${candidate}, wsRoot=${wsRoot}, globalRoot=${globalRoot})`,
    );
  }
  return candidate;
}

/**
 * Build a scratch URI from parts. Validates shape on the way out
 * so callers can't accidentally construct an unreadable URI.
 */
export function buildScratchUri(parts: ScratchUriParts): string {
  // Reuse the parse-side validators by parsing what we'd build.
  const uri = `${SCRATCH_SCHEME}/${parts.workspaceId}/${parts.toolName}/${parts.runId}/${parts.basename}`;
  parseScratchUri(uri);
  return uri;
}

/** Filesystem root for a single workspace's scratch dir. */
export function scratchRootForWorkspace(workspaceId: string): string {
  if (!WORKSPACE_REGEX.test(workspaceId) || workspaceId === '.' || workspaceId === '..') {
    throw new ScratchUriError(`scratch root: workspace "${workspaceId}" has invalid shape`);
  }
  return join(scratchRoot(), workspaceId);
}

/**
 * Filesystem root for ALL workspaces — the parent of every workspace dir.
 *
 * Default: `~/.papercusp/scratch`. Overridable via the
 * `PAPERCUSP_SCRATCH_ROOT` env var, which is the only seam tests use
 * (Linux's `os.homedir()` reads `/etc/passwd` not `$HOME`, so an
 * env-var swap can't redirect homedir-derived paths).
 */
export function scratchRoot(): string {
  const override = process.env.PAPERCUSP_SCRATCH_ROOT;
  if (override && override.trim().length > 0) return override.trim();
  return join(homedir(), '.papercusp', 'scratch');
}
