/**
 * locks:list — discover registered named resources + their live state.
 *
 * The authoritative answer to "what named locks exist, how strict is each,
 * and who holds them right now" (P-013 + P-014). Returns the registry
 * (resource, rule_text, enforcement) and the live holders for the caller's
 * coordination domain, with a draining flag per resource. Pass `resource`
 * to scope to one.
 *
 * EI-22073686775053989: each `resources[]` row is DENORMALIZED with its own
 * `holders` array (and a `held` boolean) — never rely on `holders` existing
 * ONLY as the top-level flat array. Before this fix, `resources[]` rows
 * carried no `owner`/`holders` field at all, so both natural-looking reads
 * (`r.owner`, `r.holders ?? []`) silently produced a confident, well-formed
 * "free" for a resource that was actually held — neither raised, neither
 * looked empty. `holders` is ALSO still returned flat at the top level
 * (unchanged shape, useful when scanning across resources or for ad hoc /
 * unregistered names that never appear as a `resources[]` row) — the two are
 * kept in sync from one merge, never two independent computations.
 *
 * EI-20192110087737961: the result also carries `fileLocks` — a MEASURED
 * summary of the other lock plane (see file-lock-summary.ts). This tool is the
 * primary lock read surface, so an agent reads it and concludes "nothing is
 * locked"; `holders: []` is about NAMED RESOURCES and says nothing about files.
 * The prior remedy was prose (`fileLockHint`), and it did not hold: it shipped
 * 2026-08-03 and this item was filed 2026-08-11 by an agent who read this tool,
 * concluded it "did not show repository file locks", and went and found
 * `locks:queue` on their own. A sentence next to an empty array loses to the
 * empty array; a number next to it does not.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { readIdentity } from './identity';
import { hostGlobalLockDomain, workspaceScopedLockDomain } from './coordination-domain';
import {
  getTxPool,
  getResource,
  listResources,
  listLiveResourceDomains,
  readResourceQueue,
  type ResourceHolder,
  type ResourceRegistryRow,
} from './su-lock-store';
import { shapeLocksList } from './list-shape';
import { readFileLockSummary } from './file-lock-summary';

function holderJson(h: ResourceHolder, callerOwnerId: string) {
  return {
    resource: h.resource,
    owner: h.owner,
    owner_label: h.owner_label,
    mode: h.mode,
    status: h.status,
    // A resumed owner can recover the handle needed by locks:heartbeat_resource
    // after its original acquire result fell out of context. Lock IDs are
    // owner-checked capabilities, so never expose another holder's value.
    lock_id: h.owner === callerOwnerId ? h.lock_id : null,
    reason: h.reason,
    acquired_ts: h.acquired_ts.toISOString(),
    expires_ts: h.expires_ts.toISOString(),
  };
}

function registryJson(r: ResourceRegistryRow) {
  return {
    resource: r.resource,
    description: r.description,
    rule_text: r.rule_text,
    enforcement: r.enforcement,
  };
}

export default defineTool({
  name: 'locks:list',
  description:
    'List registered named resources (name, rule, enforcement level) and who currently holds each, with a draining flag. Your own holder rows include lock_id for locks:heartbeat_resource; other owners’ IDs are null. This is a workspace-global lock diagnostic: omit workspace/harness and pass resource only when narrowing. The authoritative discovery surface for resource locks — only registered names are acquirable. Browse a large registry with `q` (name substring) and/or `limit`: both narrow resources[] only, never holders[]; registryCount reports the narrowing.',
  guidance: {
    when: 'Before acquiring a named resource (to learn the exact name + the rule), or to see who holds a resource / whether it is draining. This is workspace-global: omit workspace/harness and pass only resource. The fileLocks block measures the FILE plane on this same call — holders[] alone never answers "is a peer on this file".',
    notWhen: 'Full file-lock rows or a release handle — that is locks:queue; this carries a bounded fileLocks summary only.',
    chaining: 'Workspace-global diagnostic (omit workspace/harness) → locks:list { resource? | q?, limit? } → locks:acquire_resource { resource, mode }. After resuming a held resource, use your holder row’s lock_id with locks:heartbeat_resource { lock_id, ttl_sec }; peer IDs are redacted.',
    // EI-20206183390542424 (+ its independent re-filing EI-22367587259064593).
    // Measured in harness_shared.tool_invocations: `paths` 48 calls / 37 distinct
    // agents, `mine` 18/17, `harness` 12/12, `workspace` 11/10 — all rejected.
    //
    // Note what does NOT work: description, `when` AND `chaining` above each already
    // say "omit workspace/harness", and 22 agents passed them anyway. Always-on prose
    // is read while CHOOSING a tool, not while repairing a rejected call, so it cannot
    // reach the caller who has already guessed. argRedirects is the only channel on
    // the FAILURE path, and it costs nothing against the prompt-weight budget.
    argRedirects: {
      // The biggest cluster by far, and a genuine tool-switch: locks:list is the
      // RESOURCE plane (registered named resources), locks:queue is the FILE plane.
      // `when` above already warns that holders[] never answers "is a peer on this
      // file" — this delivers that same sentence where it is actionable.
      paths: {
        tool: 'locks:queue',
        args: { paths: ['<repo-relative path>'] },
        note: 'locks:list is the RESOURCE plane (registered named resources like git-sync:<slug>); FILE locks are a different plane and live in locks:queue { paths: [...] }. This tool carries only a bounded `fileLocks` SUMMARY, never per-path rows, so there is nothing here for `paths` to filter. Use locks:queue for "who holds this file".',
      },
      // EI-20222565902879889 — the SINGULAR of the cluster above. Measured in
      // tool_invocations at 1 call / 1 agent (2026-08-22, invalid_input) and never
      // repeated, so it is not sized like `paths`; it is here because it is the SAME
      // plane confusion with the same remedy, the redirect renders only on the failure
      // path (no always-on prompt-weight cost), and it makes this tool's coverage of
      // its measured rejecting keys complete rather than nearly complete.
      //
      // It also carries one thing the plural entry cannot: the caller who typed `path`
      // is holding ONE file and is the caller most likely to retry with a SCALAR, which
      // locks:queue's own schema rejects — a second round-trip. So the note names the
      // array shape explicitly.
      path: {
        tool: 'locks:queue',
        args: { paths: ['<repo-relative path>'] },
        note: 'locks:list is the RESOURCE plane (registered named resources like git-sync:<slug>); FILE locks are a different plane and live in locks:queue. Note the arg there is PLURAL and takes an ARRAY even for a single file: locks:queue { paths: ["<one/path.ts>"] } — a scalar is rejected. This tool carries only a bounded `fileLocks` SUMMARY, never per-path rows, so there is nothing here for `path` to select. Use locks:queue for "who holds this file".',
      },
      workspace:
        'this tool has NO `workspace` arg and needs none — it is a workspace-global diagnostic that already reads your session scope, so the rows are that workspace\'s. DROP the key. Narrow with `resource` (exact registered name) or `q` + `limit` (substring browse); there is no cross-workspace listing.',
      harness:
        'the resource-lock registry is workspace-global, NOT harness-scoped, so there is nothing for `harness` to select — DROP the key rather than looking for its correct spelling. Narrow with `resource`, or `q`/`limit` over resource NAMES (the git-sync:<slug> family is per-install, so `q: "<slug>"` is usually the filter you actually wanted).',
      mine:
        'there is no self-filter — DROP the key and read `holders[]`, which already names the holder of every resource; match your own ownerId against it. `q`/`limit` narrow resources[] only and never narrow holders[], so a bounded browse still shows every holder of what it returns.',
    },
    seeAlso: [
      'locks:acquire_resource (acquire a resource you found)',
      'locks:queue (file-lock contention, not named resources)',
    ],
  },
  capability: 'locks:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    resource: z.string().min(1).max(200).optional(),
    // EI-20197228449443651: the registry is NOT a small bounded set (518 rows
    // live, dominated by the `git-sync:<slug>` family), but the only reads
    // were ONE exact `resource` or the whole firehose — so a caller wanting to
    // browse had no expressible request, and the rejected `{limit:100}` call
    // that filed this item was a reasonable ask the surface could not state.
    // Named to match the established `q`/`limit` convention on work_items:list,
    // issues:list and routines:list rather than inventing a third spelling.
    q: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Case-insensitive substring filter over resource NAMES. Narrows resources[] only. Ignored (and reported as such) when `resource` is passed — that is the exact-match selector.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe(
        'Max registry rows returned, applied AFTER `q`. Bounds resources[] only; holders[] is never narrowed by it. Read registryCount to tell a bounded read from a complete one.',
      ),
  }),
  // context-trimming-tiers P-023: trimmed/standard sessions get clipped
  // registry rules + lean holder rows (see list-shape.ts). NOT hook-consumed
  // (only locks:acquire/release/check_command are), so the {data} conversion
  // is safe.
  shape: {
    // AUDITED 2026-09-16 (WI-2145871). BOTH row axes are pinned, deliberately:
    // `shapeLocksList` runs two INDEPENDENT allowlists (projectHolder,
    // projectResource) and each has silently dropped a field once already —
    // `coordination_domain` (EI-21733256625452096) and `holders`/`held`
    // (EI-22073686775053989), in separate incidents. One axis cannot guard the
    // other, which is what `alsoRows` exists for.
    //
    // Field lists are the UNCONDITIONAL keys only. `reason` (`c.reason > 0`) and
    // `description` (`c.description > 0`) are CONDITIONAL spreads and are
    // excluded on purpose: checkTrimmedContract asserts PRESENCE, so pinning a
    // key the shaper emits only at some tiers would fail at the others. `rule`
    // is the OUTPUT key, built from `r.rule_text`.
    //
    // `alsoRows` is also what makes this pin reachable at all: the shaper's entry
    // guard requires BOTH `resources` and `holders` to be arrays, and a
    // single-axis check can only ever supply one — it would early-return and
    // grade its own fixture green.
    // A single-axis pin is NOT a usable fallback here: the entry guard needs
    // both `resources` and `holders` to be arrays, so one axis alone
    // early-returns and grades its own fixture green.
    contract: {
      rows: 'holders',
      fields: ['resource', 'owner', 'mode', 'status', 'expires_ts', 'coordination_domain', 'lock_id'],
      alsoRows: { resources: ['resource', 'enforcement', 'rule', 'holders', 'held'] },
    },
    standard: (data) => shapeLocksList(data, 'standard'),
    trimmed: (data) => shapeLocksList(data, 'trimmed'),
  },
  async handler(args, ctx) {
    const { ownerId: callerOwnerId, coordinationDomain: callerDomain } = readIdentity(ctx);
    const pool = getTxPool();

    const considered = args.resource
      ? [await getResource(pool, args.resource)].filter((r): r is ResourceRegistryRow => r !== null)
      : await listResources(pool);

    // EI-20197228449443651: `q`/`limit` narrow the REGISTRY view only, and
    // `holders[]` is deliberately left un-narrowed by both. Every prior fix in
    // this file (EI-18674647773291145, WI-5960, EI-21733256625452096,
    // EI-22073686775053989) was the same defect — an under-reported holder
    // reading as "this resource is free" — and this file's own rule is that
    // over-reporting a holder is safe (a reader waits) while under-reporting
    // reads as permission to write on a resource a peer holds, on rows whose
    // enforcement is merely `advisory`. A browse filter must never be able to
    // manufacture that false empty, so it cannot touch the holder plane.
    const qIgnoredResourceScoped = Boolean(args.resource && args.q);
    const needle = args.resource ? undefined : args.q?.toLowerCase();
    const matched =
      needle === undefined
        ? considered
        : considered.filter((r) => r.resource.toLowerCase().includes(needle));
    const limit = args.resource ? undefined : args.limit;
    const registry = limit === undefined ? matched : matched.slice(0, limit);

    // EI-18674647773291145 Defect 2 / WI-5960: a special-domain resource (a
    // host-global one like 'release-deploy', OR a workspace-scoped one like
    // `git-sync:<slug>`) is acquired under a DIFFERENT domain than the
    // caller-tree-scoped one readIdentity resolves — querying only the
    // caller's domain here is exactly what produced a false `holders: []`
    // for a lock provably held elsewhere (observed live for both families:
    // 'release-deploy' under EI-18674647773291145, `git-sync:<slug>` under
    // WI-5960 — an su that had genuinely acquired the tree-pause lock saw
    // `locks:list` report it as unheld).
    //
    // EI-21733256625452096: those two fixes each taught the SCOPED branch one
    // more name-shaped special case, and the branch stayed wrong for every
    // resource whose name does not advertise its domain. `libs-papercusp-submodule`
    // is the live case: git-sync acquires EVERY lock in its set — the restart
    // barrier, `git-sync:<slug>`, AND each `trigger_config.extra_lock_resources`
    // name — under one `cd = workspaceId || '*'` (git-sync-action.ts's
    // `handleGitSync`), but the extras match neither HOST_GLOBAL_RESOURCES nor
    // isWorkspaceScopedResource(), so this branch looked in the caller's tree
    // domain and reported `holders: []` for a lock held, exclusive and
    // unexpired, under the workspace domain (falsified against
    // agent_resource_locks 21:20:11Z, reproduced 8 min apart).
    //
    // So stop INFERRING the one right domain from the name and query all the
    // domains actually in play, exactly as the unscoped branch already did.
    // The asymmetry was the whole defect: the same call answered truthfully
    // when unscoped and falsely when scoped to one resource. Over-reporting a
    // holder from another domain is safe (a reader waits); under-reporting
    // reads as permission to write on a resource a peer holds, and enforcement
    // on these rows is `advisory`, so nothing downstream would stop it.
    //
    // EI-24434173247501787: those three are still only the domains THIS process
    // computes. A caller-tree domain is the serving operator's checkout, so a
    // lease taken through the other operator (:3070 vs :3170) sits in a domain
    // none of them names, and this read reported `holders: []` for a rig held
    // exclusive. Union in every domain that actually holds a live lease.
    const hgDomain = hostGlobalLockDomain();
    const wsDomain = workspaceScopedLockDomain();
    const liveDomains = await listLiveResourceDomains(pool, args.resource);
    const domains = [...new Set([callerDomain, hgDomain, wsDomain, ...liveDomains])];

    const queues = await Promise.all(
      domains.map(async (coordinationDomain) => ({
        coordinationDomain,
        queue: await readResourceQueue(pool, { coordinationDomain, resource: args.resource }),
      })),
    );
    // Stamp the domain each row came from: merging several domains makes an
    // unlabelled holder list ambiguous about WHICH namespace holds the lock,
    // and that is precisely what a reader needs in order to act on it.
    const holders = queues.flatMap(({ coordinationDomain, queue }) =>
      queue.holders.map((h) => ({ ...holderJson(h, callerOwnerId), coordination_domain: coordinationDomain })),
    );
    const draining = queues.some(({ queue }) => queue.draining);

    // EI-22073686775053989: denormalize `holders` onto each registry row —
    // built from the SAME `holders` array above (one merge, not a second
    // independent computation), so the nested and flat views can never
    // disagree. A resource that appears in `resources[]` but never had a
    // matching holder gets `holders: []` here, which is now a MEASURED empty
    // (this resource has zero live holders across every domain queried),
    // never the structurally-guaranteed default `[]` the bug report caught.
    const resourcesWithHolders = registry.map((r) => {
      const resourceHolders = holders.filter((h) => h.resource === r.resource);
      return {
        ...registryJson(r),
        holders: resourceHolders,
        held: resourceHolders.length > 0,
      };
    });

    // EI-20192110087737961: measure the OTHER plane and return it inline.
    // Read unconditionally, including on a `{resource}`-scoped call: the
    // question this answers ("is anything holding a FILE right now") does not
    // narrow with the resource filter, and a caller who scoped their call is if
    // anything MORE likely to read the resulting `holders: []` as a verdict
    // about their file. Failure is reported as `activeCount: null` +
    // `unreadable`, never as `0`.
    const fileLocks = await readFileLockSummary(pool);

    // {data} envelope so the payload-tier shapers apply.
    return {
      data: {
        ok: true,
        resources: resourcesWithHolders,
        // EI-20197228449443651: a caller's `limit` bounds a ROW LIST, never an
        // aggregate — so the narrowing is reported ON the aggregate rather than
        // left to be inferred from row count. Without this, `resources[]`
        // holding 100 of 518 rows is indistinguishable from a registry that
        // has 100 resources, and a bounded read reads as a complete census.
        // `returned` counts what the HANDLER produced: a trimmed/standard
        // payload tier may clip further, and says so in its own marker row.
        // A zero `matched` under a `q` is a MEASURED empty (nothing matched),
        // never "the registry is empty" — `total` is there to tell them apart.
        registryCount: {
          total: considered.length,
          matched: matched.length,
          returned: registry.length,
          truncatedByLimit: registry.length < matched.length,
          qApplied: needle !== undefined,
          qIgnoredResourceScoped,
        },
        holders,
        draining,
        fileLocks,
        // EI-19400582907190258: this result enumerates the NAMED-RESOURCE lock
        // plane only (dev:restart, db:migrate, git-sync:<slug>, …) — rows carry
        // no `path` field at all. A caller asking "does a peer hold THIS FILE"
        // (the file-lock plane — locks:acquire/locks:acquireGranular/locks:queue)
        // gets zero matches here no matter what, which reads exactly like "safe
        // to edit" and is not. Stamp the plane + a pointer directly on the
        // result so that reading is caught even when the tool's own `notWhen`
        // guidance was skipped — an empty `holders: []` here proves nothing
        // about a specific file.
        plane: 'resource' as const,
        // EI-20192110087737961: this sentence used to be the WHOLE remedy, and
        // it demonstrably was not enough — it shipped 2026-08-03 and an agent
        // still filed "locks:list did not show repository file locks" on
        // 2026-08-11. It now describes the measured `fileLocks` block beside
        // it rather than standing in for one.
        fileLockHint:
          'resources[]/holders[] are the NAMED-RESOURCE plane and can never answer "does a peer hold this FILE" — read fileLocks (measured on this call) for that, then locks:queue { paths: [...] } for full rows incl. lock_id and waiters. fileLocks.activeCount === null means the read FAILED, not zero.',
      },
    };
  },
});
