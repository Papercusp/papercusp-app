/**
 * pot-git/secrets-guard-exemptions.ts — WI-5591: the RUNTIME, no-restart
 * escape hatch for the own-head publish guard's secrets scanner.
 *
 * Root cause this closes: secrets-guard.ts's FIXTURE_FILES is a hardcoded TS
 * Set — clearing a false-positive wedge requires a human to edit that source
 * AND restart papercup-bg-host (tsx has no hot-reload there). Because
 * checkPublishGuard's guard baseline never advances past a REFUSED range
 * (own-head-publish.ts: `guardBaseline = priorSha ?? genesisBaselineSha`, and
 * priorSha only moves forward on an ADMITTED publish), the same offending
 * historical blob is rescanned and re-refused on EVERY future tick — a false
 * positive permanently freezes ALL git egress for the hive until that manual
 * fix lands (hit 3x in 2 days, EI-13924).
 *
 * This table (migration 644) is a data-driven sibling of FIXTURE_FILES:
 * INSERT a path exemption and the very next tick (no restart, no deploy)
 * treats that path as exempt from the secrets scan — same semantics, orders
 * of magnitude faster remedy. FIXTURE_FILES itself is UNCHANGED (defense in
 * depth for the scanner's own known self-referential fixtures); this module
 * is the operator/agent-facing lever for the NEXT unforeseen false positive.
 *
 * `workspaceId` is taken EXPLICITLY (not `activeWorkspaceId()`'s ambient
 * lookup) because the caller chain (git-sync-action.ts's per-tick loop)
 * already threads a concrete workspaceId through runOwnHeadPublishLeg for
 * exactly this reason — a background tick must not depend on request-scoped
 * ambient context being set correctly.
 *
 * WI-10002785 — the table is HOST-LOCAL, so a waiver adjudicated on one machine
 * re-refused on every joined peer folding the same history (the P-203 Mac VM refused
 * refs/heads/staging on 34 findings the tower had waived). The fix rides the one record
 * that is already owner-signed, federated and verified on apply: the pot's policy
 * (`harness_shared.pot_policy`, `policy.secretsGuard.pathExemptions`). The loader is the
 * UNION of this host's table rows and every verified pot-policy waiver in the workspace;
 * {@link shareSecretsGuardPathExemptions} signs local waivers into a pot the calling
 * Swarm owns. A member can still add a LOCAL row for its own host, but it cannot widen
 * what any other peer's guard accepts — only the pot key signs a replicated waiver.
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import {
  type HivePolicy,
  type HivePolicySecretsGuardExemption,
  parseHivePolicyJson,
  policySecretsGuardExemptions,
  withSecretsGuardExemptions,
  withoutSecretsGuardExemptions,
} from '../../hive-policy-schema';
import type { AuthorHivePolicySeams } from '../../hive-policy-author';

type Sql = postgres.Sql;

const TABLE = 'harness_shared.secrets_guard_path_exemptions';

export interface SecretsGuardExemption {
  path: string;
  reason: string;
  createdBy: string;
  createdAt: string;
  /** 'local' = this host's table row; 'pot-policy' = an owner-signed waiver a pot's policy carries. */
  source: 'local' | 'pot-policy';
  /** The pot whose signed policy carries this waiver (source 'pot-policy' only). */
  potHomeSlug?: string;
}

function pgOf(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

async function readLocalRows(
  workspaceId: string,
  sql?: Sql,
): Promise<Array<{ path: string; reason: string; created_by: string; created_at: string }>> {
  const s = pgOf(sql);
  return (await s`
    SELECT path, reason, created_by, created_at
      FROM ${s(TABLE)}
     WHERE workspace_id = ${workspaceId}
     ORDER BY created_at DESC
  `) as Array<{ path: string; reason: string; created_by: string; created_at: string }>;
}

/** Every well-formed waiver carried by a pot policy in `workspaceId`. The rows in
 *  pot_policy are ALREADY verified — a forged/unsigned policy is dropped at projection
 *  apply and never lands (projections/hive-policy.ts), so this reader does not re-verify. */
async function readPotPolicyExemptions(
  workspaceId: string,
  sql?: Sql,
): Promise<Array<{ potHomeSlug: string; exemption: HivePolicySecretsGuardExemption }>> {
  const s = pgOf(sql);
  const rows = (await s`
    SELECT harness_slug, policy_json FROM harness_shared.pot_policy WHERE workspace_id = ${workspaceId}
  `) as Array<{ harness_slug: string; policy_json: string }>;
  const out: Array<{ potHomeSlug: string; exemption: HivePolicySecretsGuardExemption }> = [];
  for (const r of rows) {
    for (const exemption of policySecretsGuardExemptions(parseHivePolicyJson(r.policy_json))) {
      out.push({ potHomeSlug: r.harness_slug, exemption });
    }
  }
  return out;
}

/** All exempted paths for `workspaceId` — this host's rows ∪ every verified pot-policy
 *  waiver — as a Set for O(1) lookup. Each source fails CLOSED to empty on its own
 *  error: a DB hiccup must never silently exempt more than intended (the scanner stays
 *  strict on read failure), and a partial read only ever exempts LESS. */
export async function loadSecretsGuardPathExemptions(workspaceId: string, sql?: Sql): Promise<ReadonlySet<string>> {
  const out = new Set<string>();
  try {
    for (const r of await readLocalRows(workspaceId, sql)) out.add(r.path);
  } catch {
    /* fail closed for this source */
  }
  try {
    for (const r of await readPotPolicyExemptions(workspaceId, sql)) out.add(r.exemption.path);
  } catch {
    /* fail closed for this source */
  }
  return out;
}

/** List exemptions with full detail (reason/who/when/source) — for an admin/agent view. */
export async function listSecretsGuardPathExemptions(workspaceId: string, sql?: Sql): Promise<SecretsGuardExemption[]> {
  const local: SecretsGuardExemption[] = (await readLocalRows(workspaceId, sql)).map((r) => ({
    path: r.path,
    reason: r.reason,
    createdBy: r.created_by,
    createdAt: String(r.created_at),
    source: 'local',
  }));
  const signed: SecretsGuardExemption[] = (await readPotPolicyExemptions(workspaceId, sql)).map(
    ({ potHomeSlug, exemption }) => ({
      path: exemption.path,
      reason: exemption.reason,
      createdBy: exemption.createdBy ?? '',
      createdAt: exemption.createdAt ?? '',
      source: 'pot-policy',
      potHomeSlug,
    }),
  );
  return [...local, ...signed];
}

/** Outcome of signing (or unsigning) waivers into ONE pot's policy. */
export type PotWaiverOutcome =
  | { potHomeSlug: string; outcome: 'signed'; policyVersion: number }
  | { potHomeSlug: string; outcome: 'unchanged'; policyVersion: number }
  | { potHomeSlug: string; outcome: 'not_owner_swarm' | 'no_owner_pubkey' | 'write_failed'; detail?: string };

export interface SecretsGuardShareSeams {
  /** Forwarded to mutateHivePolicyIfChanged (resolve/read/sign/pubkey/write). */
  author?: AuthorHivePolicySeams;
}

async function mutatePotWaivers(
  workspaceId: string,
  potHomeSlug: string,
  mutate: (current: HivePolicy) => HivePolicy,
  seams: SecretsGuardShareSeams,
): Promise<PotWaiverOutcome> {
  const { mutateHivePolicyIfChanged } = await import('../../hive-policy-author');
  const res = await mutateHivePolicyIfChanged({ workspaceId, potHomeSlug, mutate }, seams.author ?? {});
  if (!res.ok) return { potHomeSlug, outcome: res.code, detail: res.detail };
  if ('unchanged' in res && res.unchanged) {
    return { potHomeSlug, outcome: 'unchanged', policyVersion: res.policy.policyVersion };
  }
  return { potHomeSlug, outcome: 'signed', policyVersion: res.policy.policyVersion };
}

/**
 * Sign `entries` into `potHomeSlug`'s owner-signed policy so every member of the pot
 * honours them (WI-10002785). Only the Swarm holding the pot key can sign — a member
 * gets `not_owner_swarm` and its waiver stays local. Idempotent: re-sharing an identical
 * set re-signs nothing (`unchanged`).
 */
export async function shareSecretsGuardPathExemptions(
  input: { workspaceId: string; potHomeSlug: string; entries: readonly HivePolicySecretsGuardExemption[] },
  seams: SecretsGuardShareSeams = {},
): Promise<PotWaiverOutcome> {
  return mutatePotWaivers(
    input.workspaceId,
    input.potHomeSlug,
    (current) => withSecretsGuardExemptions(current, input.entries),
    seams,
  );
}

/** Remove the waivers for `paths` from `potHomeSlug`'s signed policy (re-arms scanning
 *  on every member once the re-signed policy replicates). Owner Swarm only. */
export async function unshareSecretsGuardPathExemptions(
  input: { workspaceId: string; potHomeSlug: string; paths: readonly string[] },
  seams: SecretsGuardShareSeams = {},
): Promise<PotWaiverOutcome> {
  return mutatePotWaivers(
    input.workspaceId,
    input.potHomeSlug,
    (current) => withoutSecretsGuardExemptions(current, input.paths),
    seams,
  );
}

/**
 * The pots in `workspaceId` whose Hive private key THIS Swarm holds (i.e. it can sign
 * their policy). A key lookup error counts as "not owned": signing would fail anyway,
 * and the caller then keeps the waiver local rather than guessing.
 */
export async function listOwnedPotHomes(workspaceId: string): Promise<string[]> {
  const [{ listHives }, { loadHivePubkey }] = await Promise.all([
    import('../../hive-store'),
    import('../../identity/hive-keypair'),
  ]);
  const owned: string[] = [];
  for (const h of await listHives(workspaceId)) {
    const pk = await loadHivePubkey(h.workspaceId, h.homeSlug).catch(() => null);
    if (pk && pk === h.pubkeyBase64) owned.push(h.homeSlug);
  }
  return owned;
}

/** The local table rows as signable waiver entries (the one-shot `share` of legacy rows). */
export async function localRowsAsWaiverEntries(
  workspaceId: string,
  sql?: Sql,
): Promise<HivePolicySecretsGuardExemption[]> {
  return (await readLocalRows(workspaceId, sql)).map((r) => ({
    path: r.path,
    reason: r.reason,
    ...(r.created_by ? { createdBy: r.created_by } : {}),
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/** Add (or update the reason on) a path exemption — takes effect on the very
 *  next publish-guard tick, no restart required. */
export async function addSecretsGuardPathExemption(input: {
  workspaceId: string;
  path: string;
  reason: string;
  createdBy: string;
}): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO ${sql(TABLE)} (workspace_id, path, reason, created_by)
    VALUES (${input.workspaceId}, ${input.path}, ${input.reason}, ${input.createdBy})
    ON CONFLICT (workspace_id, path) DO UPDATE
      SET reason = EXCLUDED.reason, created_by = EXCLUDED.created_by, created_at = now()
  `;
}

/** Remove a path exemption (re-arm the scan for that path). */
export async function removeSecretsGuardPathExemption(workspaceId: string, path: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`DELETE FROM ${sql(TABLE)} WHERE workspace_id = ${workspaceId} AND path = ${path}`;
}

/**
 * Does `path` match any exemption entry?
 *
 * WI-5738: exact-equality was the ONLY matching rule, which made the escape
 * hatch useless against the incident class it exists for. The 2026-07-20 wedge
 * was one accidentally-committed AppImage extraction — **4,174 scanned files**
 * under a single directory. Clearing that by exact path would need thousands of
 * INSERTs enumerated by hand from a scan the operator cannot easily run, so in
 * practice the "no-restart remedy" did not apply to the very shape of accident
 * that produced it.
 *
 * Three entry forms, in order of specificity — deliberately NOT a general glob
 * engine (an exemption is a security-relevant waiver; a surprising match is a
 * silent leak, so the grammar stays small enough to be obvious on sight):
 *   - `a/b/c.js`   exact path (unchanged — every existing row keeps its meaning)
 *   - `a/b/`       directory PREFIX — everything at or below `a/b/`
 *   - `a/b/**`     the same directory prefix, spelled gitignore-style
 *
 * Note both prefix forms require the trailing separator, so `a/b/` can never
 * accidentally exempt a sibling like `a/bc.js`.
 */
export function isPathExempt(exemptions: ReadonlySet<string>, path: string): boolean {
  if (exemptions.size === 0) return false;
  if (exemptions.has(path)) return true;
  for (const entry of exemptions) {
    const prefix = entry.endsWith('/**') ? entry.slice(0, -2) : entry.endsWith('/') ? entry : null;
    if (prefix && path.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Partition findings into { blocking, exempted } using `isPathExempt`. The one
 * place this split is expressed, so the publish guard and the GitHub egress
 * guard cannot drift apart on what an exemption means (they did: before
 * WI-5738 egress consulted no exemptions at all).
 */
export function partitionExemptFindings<T extends { path: string }>(
  findings: readonly T[],
  exemptions: ReadonlySet<string>,
): { blocking: T[]; exempted: T[] } {
  if (exemptions.size === 0) return { blocking: [...findings], exempted: [] };
  const blocking: T[] = [];
  const exempted: T[] = [];
  for (const f of findings) (isPathExempt(exemptions, f.path) ? exempted : blocking).push(f);
  return { blocking, exempted };
}
