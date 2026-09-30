/**
 * listening-socket-apps — attribute a listening socket to the workspace app /
 * harness that is serving it, and render the URL a human can actually open.
 *
 * ── Why this exists (EI-21967021435856392) ───────────────────────────────────
 * An owner asked for a change to "our cloud web portal" and gave a rough port.
 * Locating it cost ~25 tool calls, because nothing mapped an app NAME to the URL
 * serving it: `harness_registry` knows each project's `path`, the listen table
 * knows each port's `pid`, and no join existed. Worse, the search that FEELS
 * decisive — grepping the workspace for a string from the UI — returns a
 * confident false negative for any app that reaches another app's surfaces
 * through an embedded pane, pointing the agent at exactly the wrong app.
 *
 * The join that answers it is short and fully DERIVED, which is why this is a
 * resolver and not a new hand-maintained registry field (the derived-truth
 * ladder: derive > pin > attest > curate):
 *
 *     socket (port, address) → pid → /proc/<pid>/cwd → registry project → slug
 *
 * ── Why not a `localUrl` field on the registry project row ───────────────────
 * Two independent reasons, both measured on this host:
 *
 *  1. It would be a SECOND copy of a truth the running system already owns, and
 *     it would drift the moment an app moved ports. `localEndpoint` already
 *     exists on the project row and means something DIFFERENT — the harness
 *     SIDECAR's op-dispatch endpoint (P-005), advertised by the sidecar for
 *     `POST /api/op/<name>`. A Next.js app in `.papercusp/apps` has no sidecar
 *     and never advertises one, so reusing that field would conflate two
 *     lifecycles; adding a parallel one would need a writer on every launch path.
 *
 *  2. The obvious static sources are WRONG here, not merely incomplete. The
 *     portal's `package.json` says `next dev --webpack` (no port — Next's
 *     default is 3000) while it actually serves 3801, and its `/proc/<pid>/environ`
 *     carries `PORT=3070` INHERITED from the operator that spawned it. An agent
 *     trusting either one reports a confidently wrong port. Only the socket knows.
 *
 * ── The honest-null contract, inherited from listening-sockets.ts ────────────
 * The kernel reveals a socket's owner, and `/proc/<pid>/cwd`, only to the same
 * uid. So "no app" has several distinct causes that must NOT be collapsed into
 * one silent null — see {@link AppUnknownReason}. A row whose owner belongs to
 * another user is not an unattributed row; it is an unreadable one.
 */

/** A registry project an observed socket can be attributed to. */
export interface AppProject {
  slug: string;
  /** Absolute path to the project root, as recorded in `harness_registry`. */
  path: string;
}

/** The app a socket was attributed to. */
export interface SocketApp {
  slug: string;
  /** The registry path that matched — the LONGEST match, so a sub-harness wins. */
  path: string;
}

/**
 * Why a socket could not be attributed. Each value is a genuinely different
 * state and a caller may need to act differently on it; collapsing them into a
 * bare `app: null` is the confident-wrong-answer failure this module exists to
 * avoid.
 */
export type AppUnknownReason =
  /** No attribution seam was supplied, so the join was never attempted. */
  | 'not-attempted'
  /** The socket's owner belongs to another uid, so neither pid nor cwd is readable. */
  | 'owner-not-visible'
  /** Owner is visible but `/proc/<pid>/cwd` could not be read (process exited, or raced). */
  | 'cwd-unreadable'
  /** The cwd resolved fine and simply sits outside every registered project. */
  | 'no-registry-project'
  /** The registry itself could not be loaded, so NO row could be attributed. */
  | 'registry-unavailable';

/** Reads `/proc/<pid>/cwd`; returns null when unreadable. Injected for testing. */
export type CwdReader = (pid: number) => string | null;

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.replace(/\/+$/, '') : p;
}

/**
 * Is `candidate` the same path as `root`, or contained within it?
 *
 * The boundary check is load-bearing, not defensive tidiness: this workspace's
 * apps directory literally contains BOTH `…/apps/portal` and
 * `…/apps/portal-checkpoint`, so a plain `candidate.startsWith(root)` attributes
 * every checkpoint-tree socket to the live app — silently, and in the direction
 * that sends someone editing the wrong tree.
 */
export function isWithinPath(root: string, candidate: string): boolean {
  const r = stripTrailingSlash(root);
  const c = stripTrailingSlash(candidate);
  if (!r || !c) return false;
  return c === r || c.startsWith(`${r}/`);
}

/**
 * The project owning `cwd`, or null. When projects nest — this registry holds
 * both `…/papercusp` and its `…/papercusp/libs/papercusp` sub-harness — the
 * LONGEST matching path wins, so a socket started inside a sub-harness is
 * attributed to that sub-harness rather than its parent repo.
 */
export function matchProjectForPath(cwd: string, projects: readonly AppProject[]): AppProject | null {
  let best: AppProject | null = null;
  for (const project of projects) {
    if (!project?.path || !project?.slug) continue;
    if (!isWithinPath(project.path, cwd)) continue;
    if (!best || stripTrailingSlash(project.path).length > stripTrailingSlash(best.path).length) {
      best = project;
    }
  }
  return best;
}

/**
 * The URL to actually open for a listener, or null when the bind address is not
 * something a local client can dial.
 *
 * Wildcard binds are rewritten to loopback because "0.0.0.0" is not an address
 * you can put in a browser. The scheme is ASSUMED http: the listen table records
 * no scheme, and every dev server in this workspace is plain http. Treat it as
 * the address to try, not a promise about TLS.
 */
export function viewableUrl(address: string, port: number): string | null {
  if (!Number.isInteger(port) || port <= 0) return null;
  const addr = address.trim();
  if (!addr) return null;
  // IPv4 (and `*`) wildcards.
  if (addr === '0.0.0.0' || addr === '*') return `http://127.0.0.1:${port}`;
  // IPv6 wildcards, bracketed or bare.
  if (addr === '::' || addr === '[::]' || addr === '*:' || addr === '::ffff:0.0.0.0') {
    return `http://[::1]:${port}`;
  }
  const bare = addr.startsWith('[') && addr.endsWith(']') ? addr.slice(1, -1) : addr;
  // `%scope` suffixes (fe80::1%eth0) are not dialable without the scope; keep them
  // bracketed rather than inventing an address.
  if (bare.includes(':')) return `http://[${bare}]:${port}`;
  return `http://${bare}:${port}`;
}

/** The minimal socket shape this module needs; keeps it decoupled from the parser. */
export interface AttributableSocket {
  port: number;
  address: string;
  pid: number | null;
  pids: number[];
  ownerVisible: boolean;
}

export interface SocketAttribution {
  app: SocketApp | null;
  appUnknownReason: AppUnknownReason | null;
  localUrl: string | null;
}

/**
 * Attribute one socket. `projects: null` means the registry could not be read —
 * distinct from an empty registry, which legitimately attributes nothing.
 */
export function attributeSocket(
  socket: AttributableSocket,
  projects: readonly AppProject[] | null,
  readCwd: CwdReader,
): SocketAttribution {
  const localUrl = viewableUrl(socket.address, socket.port);
  if (projects === null) {
    return { app: null, appUnknownReason: 'registry-unavailable', localUrl };
  }
  if (!socket.ownerVisible) {
    return { app: null, appUnknownReason: 'owner-not-visible', localUrl };
  }

  // Try every listener in a SO_REUSEPORT group, not just the representative: a
  // cluster's workers share a cwd, but the representative may exit between the
  // `ss` read and the /proc read, and a group where ONE worker is still readable
  // is a resolvable group.
  const candidates = socket.pids.length > 0 ? socket.pids : socket.pid != null ? [socket.pid] : [];
  let sawCwd = false;
  for (const pid of candidates) {
    const cwd = readCwd(pid);
    if (!cwd) continue;
    sawCwd = true;
    const project = matchProjectForPath(cwd, projects);
    if (project) {
      return { app: { slug: project.slug, path: project.path }, appUnknownReason: null, localUrl };
    }
  }
  return {
    app: null,
    appUnknownReason: sawCwd ? 'no-registry-project' : 'cwd-unreadable',
    localUrl,
  };
}
