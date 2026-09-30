/**
 * dev:listening_ports — what is listening on a TCP port, and which process owns
 * it. Plan `bash-to-tool-substitution-2026-07-26`, D-010 item 3 / D-017.
 *
 * A SEPARATE VERB from dev:service_health on purpose (D-017): service_health
 * probes a FIXED endpoint registry and feeds an alarm path, while this answers a
 * point-in-time question about an ARBITRARY port. The corpus that motivated it
 * is full of ephemeral, agent-allocated ports no registry could contain.
 *
 * The honest-null contract lives in `guidance.returns` — deliberately, because
 * the prompt-weight budget counts description + when + notWhen + chaining and
 * NOT returns/seeAlso, and this semantics is too important to trim.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  listListeningSockets,
  ListeningSocketsError,
  LISTENING_SOCKETS_DEFAULT_LIMIT,
} from '../../listening-sockets';
import { loadHarnessRegistry } from '../../harness-registry';
import type { AppProject } from '../../listening-socket-apps';

/**
 * Registry projects for socket→app attribution. Returns null — NOT [] — when the
 * registry cannot be read, so every row reports `registry-unavailable` rather
 * than the indistinguishable "no app owns this".
 *
 * Ephemeral foreign-clone rows are deliberately KEPT: the registry's own note
 * says slug-scoped lookups should still resolve them, and this is a lookup
 * ("which project is this cwd inside"), not the listing/default-inference
 * enumeration that must filter them out. A socket served from a sandboxed clone
 * is genuinely served from that clone.
 */
async function loadAppProjects(): Promise<readonly AppProject[] | null> {
  try {
    const reg = await loadHarnessRegistry();
    return reg.projects
      .filter((p): p is typeof p & { slug: string; path: string } => Boolean(p?.slug && p?.path))
      .map((p) => ({ slug: p.slug, path: p.path }));
  } catch {
    return null;
  }
}

export default defineTool({
  name: 'dev:listening_ports',
  profile: 'engineer',
  description:
    'What is listening on a TCP port, WHICH PROCESS owns it, and WHICH APP it serves — the `ss -tlnp` / `lsof -iTCP:<port> -sTCP:LISTEN` / `netstat -tlnp` answer, structured, joined to the workspace app registry. Filter by `port` (what owns this port), `pid` (which ports does this process listen on), or `app` (WHAT URL SERVES THIS APP — a registry slug like "portal"). Owner resolution is same-uid only: a socket owned by another user is reported as listening with ownerVisible:false, which is NOT the same as nothing being bound.',
  capability: 'intel:read',
  guidance: {
    when: 'You need to know whether something is bound to a port and who owns it — diagnosing EADDRINUSE, finding the pid squatting a port, confirming a server you started actually bound, or checking which ports a pid opened. Works for ANY port, including ephemeral ones you just allocated. ALSO the one call for "where do I view app X" — `app:"<slug>"` returns its live `localUrl`; never port-scan or guess a port from package.json for that.',
    notWhen: 'NOT for "is my service healthy" — dev:service_health probes the known endpoints and is the right tool for a registered service. This reports only TCP sockets in LISTEN state: no UDP, no established connections, no traffic.',
    returns:
      '{ sockets[], matched, totalListening, truncated, ownerHidden }. Each socket: { port, address, family, pid, pids[], listeners, command, ownerVisible, reserved }.\n\nOne row per (port, address, command), NOT per socket: a SO_REUSEPORT cluster binds one socket per worker (the operator on :3070 has 16), so `pids` lists every listener and `listeners` counts them. `pid` is the representative — filtering by `pid` matches any worker in the group.\n\nREAD ownerVisible BEFORE pid. The kernel reveals a socket owner only to the same uid, so:\n  • listening + ownerVisible:true  → `pid`/`command` are the real owner.\n  • listening + ownerVisible:false → the port IS bound, by ANOTHER USER (root system services, Postgres on :5432, …). pid/command are null because they are unreadable, NOT because the port is free. Do not report it as unowned.\n  • no row at all → nothing is listening on that port.\nOn this host ~60% of listening sockets fall in the middle case, so conflating it with the third is a confident wrong answer. `reserved:true` marks a RESERVED_SERVICE_PORTS core-service port — never squat it. `ownerHidden` counts matched rows in the middle case.\n\nAPP ATTRIBUTION. Each socket also carries { app, appUnknownReason, localUrl }. `app` is { slug, path } — the harness_registry project whose path CONTAINS the owning process\'s /proc/<pid>/cwd, longest match winning so a sub-harness beats its parent repo. `localUrl` is the address to open (wildcard binds rewritten to loopback; scheme ASSUMED http — the listen table records none).\n\nThis is DERIVED per call, never stored, because the static sources are wrong: an app\'s package.json may declare no port (or a stale one) while it serves another, and its /proc environ can carry a PORT inherited from the operator that spawned it. The socket is the only truth.\n\n`app:null` always carries a reason, and they are NOT interchangeable: `owner-not-visible` (another uid — unreadable, not unowned) · `cwd-unreadable` (owner visible, cwd read raced or was denied) · `no-registry-project` (cwd resolved, genuinely outside every registered project) · `registry-unavailable` (the registry read FAILED, so NO row could be attributed — never read this as "no app") · `not-attempted`.\n\nWith an `app` filter the result adds `appFilter: { slug, known, path }`. Read it before concluding anything from zero rows: `known:false` means no such registry slug (check the name), `known:true` with zero sockets means the app is registered but NOTHING IS SERVING IT — start it at `path`. An empty `sockets` array alone cannot tell those apart.',
    seeAlso: [
      'dev:service_health (is a KNOWN service healthy — probes the endpoint registry)',
      'dev:processes (the agent-kind process inventory; not a general ps)',
      'capability:bash_output (did MY background job finish, and what did it print)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'cup'],
  args: z.object({
    port: z.number().int().positive().max(65535).optional().describe('Only sockets bound to this port.'),
    pid: z.number().int().positive().optional().describe('Only sockets owned by this pid (same-uid processes only).'),
    app: z
      .string()
      .min(1)
      .optional()
      .describe('Only sockets served by this workspace app/harness registry slug, e.g. "portal".'),
    limit: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe(`Max rows (default ${LISTENING_SOCKETS_DEFAULT_LIMIT}). This host has ~240 listening sockets.`),
  }),
  result: z
    .object({
      sockets: z.unknown().optional(),
      matched: z.unknown().optional(),
      totalListening: z.unknown().optional(),
      truncated: z.unknown().optional(),
      ownerHidden: z.unknown().optional(),
    })
    .passthrough(),
  async handler(args) {
    try {
      const result = await listListeningSockets({
        port: args.port,
        pid: args.pid,
        app: args.app,
        limit: args.limit,
        apps: { projects: await loadAppProjects() },
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...result }, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof ListeningSocketsError ? err.message : String(err);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: false, reason: 'listen_table_unreadable', message }) },
        ],
        isError: true,
      };
    }
  },
});
