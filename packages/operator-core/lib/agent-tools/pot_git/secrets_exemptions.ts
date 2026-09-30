/**
 * pot_git:secrets_exemptions — WI-5591: the operator/agent lever for the
 * own-head publish guard's RUNTIME secrets-guard path exemption table
 * (harness_shared.secrets_guard_path_exemptions, migration 644).
 *
 * Root cause this tool exists to close: a false-positive credential-shape
 * match in the publish-guard secrets scanner permanently freezes ALL git
 * egress for a hive (own_head_publish.refused:'secrets') because the guard
 * baseline never advances past a refused range — the SAME historical blob is
 * rescanned and re-refused forever. Before this table, the only remedy was a
 * human editing the hardcoded FIXTURE_FILES source Set and restarting
 * papercup-bg-host. This tool lets an agent (or the operator UI later)
 * add/list/remove a path exemption directly — no code edit, no restart; the
 * very next git-sync tick picks it up.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  name: 'pot_git:secrets_exemptions',
  profile: 'engineer',
  crossWorkspace: true,
  description:
    "Owner: the no-restart escape hatch for the pot-git secrets scanner (own-head publish + GitHub egress guards) — clears a false positive that would otherwise freeze git egress for the hive. Actions: list {} | add {path, reason, pot?} — exempt from the next git-sync tick; on the pot-owner Swarm also signs it into the pot policy so every member honours it | remove {path} — re-arm + unsign | share {pot?, path?} — sign existing local rows into the pot policy.",
  capability: 'audit:write',
  guidance: {
    when:
      "own_head_publish.refused === 'secrets' (harness_shared.routines.metadata->'own_head_publish'->>'refused') AND you have ADJUDICATED the flagged finding as a false positive (a detector fixture, a documented example credential, a placeholder — never a REAL live secret) — {action:'add', path, reason}.",
    notWhen:
      "The finding might be a genuine leaked credential — rotate/revoke it and fix the source instead. A false-positive class across many DIFFERENT trees — that needs a rule fix in secrets-guard.ts, not N exemptions. A prefix is a broad waiver: scope it to the actual accident.",
    chaining:
      "{action:'list'} (don't duplicate a row) → ADJUDICATE: `npx tsx scripts/adjudicate-publish-refusal.mts --commit <own_head_publish.blockedAtCommit> --exemptions` replays the guard and prints every finding it saw, so 'false positive' is MEASURED, not assumed — exit 2 means the scanner is UNUSABLE, never read that as clean → {action:'add', path, reason} → the next git-sync tick (or dev:restart) retries the publish.",
    seeAlso: ['pot_git:integration_requests (a different G-10-adjacent queue — below-tier member heads, not secrets)'],
  },
  requirePrincipal: false,
  agentRoles: ['operator'],
  args: z
    .object({
      action: z.enum(['list', 'add', 'remove', 'share']),
      pot: z
        .string()
        .optional()
        .describe("Pot home slug whose owner-signed policy should carry the waiver. Omit when this Swarm owns exactly one pot; required when it owns several."),
      workspaceId: z
        .string()
        .optional()
        .describe('Workspace id — UNSCOPED (--all-workspaces) sessions only; a workspace-scoped session always acts on its own workspace and is refused if this names another. Defaults to the active workspace when omitted.'),
      path: z
        .string()
        .optional()
        .describe("Repo-relative path: an exact file, or a directory prefix (`dir/` / `dir/**`) to exempt a whole tree (WI-5738 — one bad extraction was 4,174 files). Required for action:'add'/'remove'."),
      reason: z
        .string()
        .optional()
        .describe("Why this path is a false positive. Required for action:'add' (recorded for audit)."),
    })
    .refine((a) => a.action !== 'add' || (Boolean(a.path) && Boolean(a.reason)), {
      message: "action:'add' needs path and reason",
    })
    .refine((a) => a.action !== 'remove' || Boolean(a.path), {
      message: "action:'remove' needs path",
    }),
  async handler(args, ctx) {
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const {
      listSecretsGuardPathExemptions,
      addSecretsGuardPathExemption,
      removeSecretsGuardPathExemption,
      listOwnedPotHomes,
      localRowsAsWaiverEntries,
      shareSecretsGuardPathExemptions,
      unshareSecretsGuardPathExemptions,
    } = await import('../../sync/pot-git/secrets-guard-exemptions');
    // SELF-CONFINEMENT (WI-6641). `crossWorkspace: true` above exists ONLY so an
    // UNSCOPED psu gets the getOrgPg admin handle (this table is not RLS-scoped) —
    // the same reason memory:* and autonomy:record_disposition carry it. For that to
    // be true rather than merely intended, a SCOPED principal must be unable to reach
    // another workspace's rows: refuse an explicit `workspaceId` that names one, and
    // pin `ws` to the principal's own workspace. Refuse rather than silently clamp —
    // a waiver written to a workspace the caller did not name is worse than an error.
    // This is what makes the tool eligible for SCOPED_SAFE_CROSSWORKSPACE, so the
    // agents who actually trip the guard can run the documented recovery.
    const principalWs = ctx?.principal?.workspaceId;
    const scopedWs = principalWs && principalWs !== '*' ? principalWs : null;
    if (scopedWs && args.workspaceId && args.workspaceId !== scopedWs) {
      return {
        isError: true,
        content: [{
          type: 'text' as const,
          text: `workspace_forbidden: this session is scoped to workspace "${scopedWs}" and cannot target "${args.workspaceId}". Omit workspaceId to act on your own workspace, or use an unscoped (--all-workspaces) superuser session to target another.`,
        }],
      };
    }
    const ws = scopedWs ?? args.workspaceId ?? activeWorkspaceId();
    const createdBy = ctx?.principal?.slug ?? ctx?.principal?.workspaceId ?? 'agent';
    // WI-10002785: which pot's signed policy should carry a waiver. An explicit `pot` wins;
    // otherwise the ONE pot this Swarm owns. Zero owned (a member) or several (ambiguous)
    // leaves the waiver local and SAYS so — never a guessed pot.
    const resolvePot = async (): Promise<{ pot: string } | { replicated: false; reason: string; ownedPots?: string[] }> => {
      if (args.pot) return { pot: args.pot };
      const owned = await listOwnedPotHomes(ws);
      if (owned.length === 1) return { pot: owned[0]! };
      return owned.length === 0
        ? { replicated: false, reason: 'no_owned_pot: this Swarm holds no pot key, so the waiver stays local to this host' }
        : { replicated: false, reason: 'ambiguous_pot: pass `pot`', ownedPots: owned };
    };
    let payload: Record<string, unknown>;
    if (args.action === 'list') {
      const exemptions = await listSecretsGuardPathExemptions(ws);
      payload = { ok: true, workspaceId: ws, count: exemptions.length, exemptions };
    } else if (args.action === 'add') {
      await addSecretsGuardPathExemption({ workspaceId: ws, path: args.path!, reason: args.reason!, createdBy: String(createdBy) });
      const target = await resolvePot();
      const replication = 'pot' in target
        ? await shareSecretsGuardPathExemptions({
            workspaceId: ws,
            potHomeSlug: target.pot,
            entries: [{ path: args.path!, reason: args.reason!, createdBy: String(createdBy), createdAt: new Date().toISOString() }],
          })
        : target;
      payload = { ok: true, workspaceId: ws, added: args.path, replication };
    } else if (args.action === 'share') {
      const target = await resolvePot();
      if (!('pot' in target)) {
        payload = { ok: false, workspaceId: ws, replication: target };
      } else {
        const entries = (await localRowsAsWaiverEntries(ws)).filter((e) => !args.path || e.path === args.path);
        const replication = await shareSecretsGuardPathExemptions({ workspaceId: ws, potHomeSlug: target.pot, entries });
        payload = { ok: replication.outcome === 'signed' || replication.outcome === 'unchanged', workspaceId: ws, shared: entries.length, replication };
      }
    } else {
      await removeSecretsGuardPathExemption(ws, args.path!);
      // Unsign from every pot whose signed policy still carries this path — otherwise the
      // "re-armed" path stays waived via the union. A pot this Swarm cannot sign for is
      // reported (not_owner_swarm): the path stays waived until that pot's owner removes it.
      const carriers = [...new Set(
        (await listSecretsGuardPathExemptions(ws))
          .filter((e) => e.source === 'pot-policy' && e.path === args.path)
          .map((e) => e.potHomeSlug!),
      )];
      const unsigned = [];
      for (const pot of carriers) {
        unsigned.push(await unshareSecretsGuardPathExemptions({ workspaceId: ws, potHomeSlug: pot, paths: [args.path!] }));
      }
      payload = { ok: true, workspaceId: ws, removed: args.path, unsigned };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  },
});
