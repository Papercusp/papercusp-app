/**
 * locks:queue — read-only inspection of who's holding/waiting on what.
 *
 * Does NOT take the workspace advisory lock — read-only over MVCC.
 */

import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { ensureBootstrap, getTxPool, readQueue } from './su-lock-store';
import { acquireWithContentionRetry } from './contention-retry';
import { resolveExternalPathLockIdentity } from './external-path';
import { holderContextReader, resolveHolderAdvisoryMap } from '../coordination/holder-advisory';

export default defineTool({
  name: 'locks:queue',
  description:
    'Read active locks and pending waiters. Active rows include lock_id for locks:release. This is a workspace-global diagnostic: omit harness. Omit coordination_domain to scan every checkout; pass a physical repository root to scope one checkout. Filter overlapping paths: omit paths for all rows, while paths:[] matches nothing. external_paths accepts absolute current-user home or XDG_RUNTIME_DIR files; managed Papercusp repository files resolve to their physical repository domain + repo-relative key, while ordinary files use @external/home/* or @external/runtime/* keys, matching locks:acquire. Optionally filter by owner or include_completed=true for terminal waiters from the last 24h.',
  guidance: {
    when: 'Diagnostics — "what are the other agents doing?" or "why am I blocked?". Cheap, MVCC read.',
    notWhen: 'Before every acquire — locks:acquire already returns busy context. Use queue when the user asks.',
    chaining: 'Workspace-global diagnostic — omit harness; omit coordination_domain for every checkout or pass a physical repository root for one checkout. Omit paths for all rows or pass exact paths (paths:[] is intentionally empty); optionally filter owner?/include_completed?. For a home or XDG_RUNTIME_DIR file locked via locks:acquire external_paths, pass the same absolute path as external_paths here; it resolves to the same repository-relative or reserved external key. Release a held row with its returned lock_id via locks:release; paths alone is not a release selector.',
    seeAlso: [
      'locks:list (named-resource holders, not file-lock contention)',
      'coord:roster { view:"live" } (what the other agents are doing overall)',
    ],
    // EI-20206554322712742: a caller filtering ONE file reached for the intuitive
    // singular `path` and got a bare unrecognized-key rejection. The report called
    // it a prompt/schema mismatch, but no prompt pairs `path` with locks:queue —
    // every prompt in the tree writes `locks:queue { paths: [...] }`. The shape is
    // BORROWED, exactly like `mode` on locks:acquire (EI-21988514956470475): the
    // sibling locks:acquire_granular really does take a scalar `path`, so the guess
    // is a reasonable generalisation from a real signature, and only the FAILURE
    // path can correct it. Zero prompt weight (argRedirects is excluded from
    // describeFromGuidance), paid for only on the rejection that needs it.
    argRedirects: {
      // A RENAME, not a drop — the same shape as acquire's `reason` redirect: dropping
      // the key silently turns a one-file filter into an unfiltered workspace-wide scan,
      // which returns rows and therefore reads as success rather than as a second error.
      path: 'this tool spells that `paths` and takes an ARRAY, never a scalar — RENAME the key rather than dropping it: paths: ["<repo-relative/file>"]. Dropping it does not fail, it silently widens the read to EVERY row in the workspace, so a one-file question comes back answered about everything. The singular `path` is the sibling locks:acquire_granular { path, mode: IS|IX|S|SIX|X } (directory/subtree intention lock), which is where the shape is borrowed from. Note paths:[] is intentionally empty and matches NOTHING — omit paths entirely for the unfiltered scan.',
    },
  },
  capability: 'locks:read',
  requirePrincipal: false,
  // EI-20229273881874423: this diagnostic owns its read pool and never reads
  // ctx.tx. Do not retain the ambient workspace transaction while the lock
  // queue is saturated; a queued org-app acquisition makes self-verification
  // fail before the diagnostic handler can run.
  skipWorkspaceTx: true,
  // EI-20246680224449070: ptool consumes this diagnostic as JSON. The generic
  // result door appends a truncation footer to a large queue snapshot, which
  // would turn the machine-readable body into invalid JSON.
  skipResultDoor: 'programmatic-caller',
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    coordination_domain: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe('physical repository root used to scope the diagnostic read to one checkout'),
    paths: z.array(z.string()).optional(),
    external_paths: z
      .array(z.string().min(1))
      .max(50)
      .optional()
      .describe(
        'absolute files below the current user home or XDG_RUNTIME_DIR; managed Papercusp repository files use their repository-domain identity, while ordinary files map to @external/home/* or @external/runtime/* keys — the same mapping locks:acquire uses — then merge into the paths filter',
      ),
    owner: z.string().optional(),
    include_completed: z.boolean().optional(),
  }),
  async handler(args, ctx) {
    await ensureBootstrap();
    const sql = getTxPool();

    // EI-22075918402561858 / EI-22439115152462582: `paths` is repo-relative;
    // an ordinary external file locked via locks:acquire's external_paths lives
    // under a distinct reserved key that a raw absolute path never matches.
    // Managed repository files instead use their physical domain + relative
    // path. Resolve external_paths through the identical helper acquire uses and
    // merge into the paths filter so every holder is inspectable through this
    // diagnostic too. Only enter the merge when the caller actually supplied
    // a filter — omitting both stays an unfiltered scan, and an explicit
    // paths:[] (with no external_paths) must keep failing closed exactly as before.
    let paths = args.paths;
    let coordinationDomain = args.coordination_domain ?? null;
    if (args.external_paths !== undefined) {
      try {
        const externalIdentities = args.external_paths.map((path) =>
          resolveExternalPathLockIdentity(path),
        );
        const managedDomains = [
          ...new Set(
            externalIdentities
              .map((identity) => identity.coordinationDomain)
              .filter((domain): domain is string => domain !== undefined),
          ),
        ];
        if (managedDomains.length > 1) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error:
                  `external_paths span multiple managed repositories (${managedDomains.join(', ')}); ` +
                  'scope the diagnostic to one repository at a time.',
              }),
            }],
          };
        }
        let explicitDomain = args.coordination_domain;
        if (explicitDomain !== undefined) {
          try {
            explicitDomain = realpathSync(explicitDomain);
          } catch {
            // Keep the original value so a missing/non-repository scope is
            // rejected below rather than treated as a canonical match.
          }
        }
        if (managedDomains.length === 1 &&
            explicitDomain !== undefined &&
            explicitDomain !== managedDomains[0]) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error:
                  `external path resolves inside managed repository ${JSON.stringify(managedDomains[0])}, ` +
                  `but coordination_domain is ${JSON.stringify(args.coordination_domain)}; ` +
                  'scope the diagnostic to the managed repository root.',
              }),
            }],
          };
        }
        if (managedDomains.length === 1 &&
            externalIdentities.some((identity) => identity.coordinationDomain === undefined)) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error:
                  'external_paths mix a managed repository file with an ordinary HOME/runtime file; ' +
                  'query those namespaces separately.',
              }),
            }],
          };
        }
        // A managed repository's absolute path must be read under the same
        // physical domain + repo-relative key as the native edit hook.
        if (managedDomains.length === 1 &&
            externalIdentities.every((identity) => identity.coordinationDomain !== undefined) &&
            args.coordination_domain === undefined) {
          coordinationDomain = managedDomains[0]!;
        }
        if (managedDomains.length === 1 && explicitDomain === managedDomains[0]) {
          coordinationDomain = managedDomains[0]!;
        }
        paths = [...(args.paths ?? []), ...externalIdentities.map((identity) => identity.path)];
      } catch (err: unknown) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
            },
          ],
        };
      }
    }

    // EI-7454: readQueue scopes a 1s statement_timeout to this read (plan §6.1) —
    // under fleet-load DB contention a plain indexed SELECT can transiently trip
    // it (pg 57014) even though the query itself is cheap. Retry-with-backoff
    // (same helper file-lock-guard.ts already uses for the analogous acquire-path
    // 57014/55P03) rides out the dip instead of surfacing a raw tool error to a
    // diagnostic-only read.
    const result = await acquireWithContentionRetry(() =>
      readQueue(sql, {
        // WI-5979: this is a diagnostic read, not an enforcement decision.
        // The serving operator's repo root can differ from the checkout whose
        // file lock is being inspected (:3070 vs :3170), so a caller-scoped
        // domain silently turns a held path into an empty result. The store's
        // null domain spans those namespaces and returns each row's domain for
        // attribution; acquire/release paths remain domain-scoped.
        // Omit the filter for the workspace-global diagnostic default; callers
        // that need one checkout can pass the same physical root used by
        // locks:acquire. This keeps the cross-checkout read available without
        // rejecting a valid coordination_domain argument.
        coordinationDomain,
        paths,
        owner: args.owner,
        includeCompleted: args.include_completed,
      }),
    );

    /**
     * P-027 / D-055 A4 — "you are queued behind a holder and need to know WHAT you
     * are queued behind, not merely THAT you are."
     *
     * Decorates the ACTIVE LOCKS, because those are the rows that actually block:
     * a waiter ahead of you is queued, not holding. One resolution per DISTINCT
     * holder, so a peer holding twelve paths costs one.
     *
     * ⚠ NO `subjectRef` HERE, AND THAT IS CORRECT RATHER THAN AN OMISSION. D-094's
     * subtraction removes the subject from `competing`, which is a list of ITEM
     * refs (WI-/EI-/plan-item). A lock's subject is a FILE PATH, which can never
     * appear in that list, so there is nothing to subtract — passing the path
     * would be a no-op that implies a relationship between the two namespaces
     * that does not exist. `locks:acquire`'s own busy enrichment (P-012,
     * enrich-busy.ts) omits it for the same reason.
     *
     * ⚠ ADVISORY: this is a read-only diagnostic and cannot alter a lock verdict.
     * `requirePrincipal: false` above makes an unattributable caller legitimate,
     * so the guarded reader yields null and the rows return undecorated.
     */
    const reader = holderContextReader(ctx as Parameters<typeof holderContextReader>[0]);
    const advisory = await resolveHolderAdvisoryMap(
      result.active_locks.map((l) => l.owner),
      reader,
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            active_locks: result.active_locks.map((l) => {
              const holder_context = advisory.forRow(l.owner);
              return {
                ...l,
                acquired_ts: l.acquired_ts.toISOString(),
                expires_ts: l.expires_ts.toISOString(),
                ...(holder_context ? { holder_context } : {}),
              };
            }),
            waiting: result.waiting.map((w) => ({
              ...w,
              queued_ts: w.queued_ts.toISOString(),
              wait_until: w.wait_until.toISOString(),
            })),
            // Keep the machine-readable shape stable when terminal waiters were
            // not requested. Consumers commonly project `.completed[]`; an
            // omitted field turns an empty diagnostic into a projection error.
            completed: (result.completed ?? []).map((w) => ({
              ...w,
              queued_ts: w.queued_ts.toISOString(),
              wait_until: w.wait_until.toISOString(),
            })),
          }),
        },
      ],
    };
  },
});
