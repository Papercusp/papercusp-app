/**
 * hive-policy-author — the OWNER-side "sign + write a Hive policy" core
 * (shared-hive-owner-enforcement-2026-06-19 EN-1, build steps 3 + 4).
 *
 * The authoring authority is TWO things that coincide on the owner's Swarm:
 *   1. the GitHub CLAIM (claim_status='claimed' ∧ viewer ∈ claimed_by_github_user_ids)
 *      — checked by the API route (endpoint-route/routes/pot/policy-set.ts), NOT here.
 *   2. holding the Hive PRIVATE KEY — only the owning Swarm can {@link signWithHiveKey};
 *      this module is where that signing capability is exercised. A claimed viewer on a
 *      Swarm that does NOT hold the key gets `not_owner_swarm` (sign throws) — correct:
 *      only the canonical owner Swarm can author the authoritative signed policy.
 *
 * The signature binds {domain, workspaceId, potHomeSlug, policyVersion, canonicalPolicyJson}
 * (hive-policy-schema.hivePolicySignedBytes) so it cannot be replayed across Hives or
 * versions. The member-side projection verifies the SAME bytes against the Hive identity
 * pubkey. policy_version is monotone (current + 1) — a secondary order; fed_hlc is the
 * federated LWW winner (migration 314).
 *
 * All collaborators are injectable seams for hermetic unit tests.
 */
import {
  type HivePolicy,
  canonicalizeHivePolicy,
  hivePolicySignedBytes,
} from './hive-policy-schema';
import {
  type ResolvedHivePolicy,
  getHivePolicy,
  upsertHivePolicyRow,
} from './hive-policy-store';
import { loadHivePubkey, signWithHiveKey } from './identity/hive-keypair';
import { resolveHiveWorkspaceId } from './hive-store';

export type AuthorHivePolicyResult =
  | { ok: true; policy: ResolvedHivePolicy }
  | { ok: false; code: 'not_owner_swarm' | 'no_owner_pubkey' | 'write_failed'; detail?: string };

export interface AuthorHivePolicyInput {
  workspaceId: string;
  /** The Hive's home_slug (its hive identity handle). */
  potHomeSlug: string;
  /** The full new policy document (an OPEN record; unknown keys are preserved + signed). */
  policy: HivePolicy;
}

export interface AuthorHivePolicySeams {
  /**
   * Resolve the CALLER's ambient workspaceId to the one the Hive's row + keypair are
   * actually stamped with (WI-5321/WI-5061 design constraint — see hive-store.ts's
   * resolveHiveWorkspaceId doc). Default: resolveHiveWorkspaceId. Runs BEFORE every
   * other seam below; its result is what readCurrent/sign/loadOwnerPubkey/write all
   * receive — never the raw input.workspaceId.
   */
  resolveWorkspaceId?: (workspaceId: string, potHomeSlug: string) => Promise<string>;
  /** Read the current policy (for the version bump). Default: getHivePolicy. */
  readCurrent?: (workspaceId: string, potHomeSlug: string) => Promise<ResolvedHivePolicy | null>;
  /** Sign bytes with the Hive private key (throws if this Swarm isn't the owner). */
  sign?: (workspaceId: string, potHomeSlug: string, bytes: Buffer) => Promise<Buffer>;
  /** The Hive owner pubkey (raw-32 base64); null if this Swarm doesn't hold the key. */
  loadOwnerPubkey?: (workspaceId: string, potHomeSlug: string) => Promise<string | null>;
  /** Persist the signed row. Default: upsertHivePolicyRow. */
  write?: (input: {
    workspaceId: string;
    potHomeSlug: string;
    policyJson: string;
    ownerPubkey: string;
    signature: string;
    policyVersion: number;
  }) => Promise<ResolvedHivePolicy>;
}

/**
 * Sign + persist a new Hive policy on the OWNER Swarm. Returns the resolved row (which
 * then federates to members via the capture trigger + the hive-policy projection). The
 * caller (API route) MUST have already passed the GitHub claim gate; this enforces the
 * keypair-ownership half. Idempotent-ish: each call bumps policy_version by 1.
 */
export async function authorHivePolicy(
  input: AuthorHivePolicyInput,
  seams: AuthorHivePolicySeams = {},
): Promise<AuthorHivePolicyResult> {
  const {
    resolveWorkspaceId = resolveHiveWorkspaceId,
    readCurrent = getHivePolicy,
    sign = signWithHiveKey,
    loadOwnerPubkey = loadHivePubkey,
    write = upsertHivePolicyRow,
  } = seams;

  // 0. WI-5321/WI-5061: resolve the caller's ambient workspaceId to whatever the
  // Hive's row + keypair are ACTUALLY stamped with (fast path: unchanged when they
  // already match). Every step below uses this resolved id, consistently, for both
  // the keychain lookup and the signature binding.
  const workspaceId = await resolveWorkspaceId(input.workspaceId, input.potHomeSlug);

  // 1. Keypair-ownership gate: only the Swarm that holds the Hive secret can author.
  const ownerPubkey = await loadOwnerPubkey(workspaceId, input.potHomeSlug);
  if (!ownerPubkey) {
    return { ok: false, code: 'not_owner_swarm', detail: 'this Swarm does not hold the Hive private key' };
  }

  // 2. Monotone version bump.
  const current = await readCurrent(workspaceId, input.potHomeSlug);
  const policyVersion = (current?.policyVersion ?? 0) + 1;

  // 3. Canonicalize + sign the binding {domain, ws, slug, version, canonicalJson}.
  const canonicalPolicyJson = canonicalizeHivePolicy(input.policy);
  const bytes = hivePolicySignedBytes({
    workspaceId,
    potHomeSlug: input.potHomeSlug,
    policyVersion,
    canonicalPolicyJson,
  });

  let signature: string;
  try {
    const sig = await sign(workspaceId, input.potHomeSlug, bytes);
    signature = Buffer.from(sig).toString('base64');
  } catch (err: unknown) {
    // signWithHiveKey throws when this Swarm doesn't hold the key (defense in depth vs step 1).
    return { ok: false, code: 'not_owner_swarm', detail: err instanceof Error ? err.message : String(err) };
  }

  // 4. Persist the signed row (federates via the capture trigger + stamp).
  try {
    const policy = await write({
      workspaceId,
      potHomeSlug: input.potHomeSlug,
      policyJson: canonicalPolicyJson,
      ownerPubkey,
      signature,
      policyVersion,
    });
    return { ok: true, policy };
  } catch (err: unknown) {
    return { ok: false, code: 'write_failed', detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Read → mutate → re-sign a Hive policy in one owner-authored step. The OWNER-side
 * WRITE accessor EN-3 (membership/moderation) uses to APPEND to the signed policy —
 * e.g. add a github id to `moderation.bannedGithubIds` or a ref to `moderation.takedownList`
 * — without hand-rolling the read-current + bump-version + re-sign dance (which is the
 * easy way to drop an unknown forward-compat key or break the signature). `mutate`
 * receives the CURRENT typed policy (or `{}` if none) and returns the FULL new policy;
 * unknown keys it leaves on the object are preserved + re-signed. Same authority +
 * federation as {@link authorHivePolicy}.
 */
export type MutateHivePolicyIfChangedResult =
  | AuthorHivePolicyResult
  | { ok: true; unchanged: true; policy: ResolvedHivePolicy };

/**
 * Idempotent variant of {@link mutateHivePolicy} (WI-2039866): read the current signed
 * policy, derive the next one, and SKIP the re-sign when the canonical JSON is
 * byte-identical. Every re-sign bumps `policy_version` and federates a policy op to
 * every peer, so a caller that runs on EVERY BOOT (the canonical-hive share path) must
 * use this — the tower's policy had reached version 8081 from boot churn alone, one
 * signed op per restart, each carrying the same bytes.
 *
 * Returns `{ ok: true, unchanged: true, policy }` (the CURRENT row) when skipped; the
 * ordinary {@link AuthorHivePolicyResult} otherwise. A missing current policy always
 * authors (there is nothing to compare against).
 */
export async function mutateHivePolicyIfChanged(
  input: {
    workspaceId: string;
    potHomeSlug: string;
    mutate: (current: HivePolicy) => HivePolicy;
  },
  seams: AuthorHivePolicySeams = {},
): Promise<MutateHivePolicyIfChangedResult> {
  const resolveWorkspaceId = seams.resolveWorkspaceId ?? resolveHiveWorkspaceId;
  const workspaceId = await resolveWorkspaceId(input.workspaceId, input.potHomeSlug);
  const readCurrent = seams.readCurrent ?? getHivePolicy;
  const current = await readCurrent(workspaceId, input.potHomeSlug);
  const nextPolicy = input.mutate(current?.policy ?? {});
  if (current && canonicalizeHivePolicy(nextPolicy) === current.policyJson) {
    return { ok: true, unchanged: true, policy: current };
  }
  return authorHivePolicy(
    { workspaceId, potHomeSlug: input.potHomeSlug, policy: nextPolicy },
    seams,
  );
}

export async function mutateHivePolicy(
  input: {
    workspaceId: string;
    potHomeSlug: string;
    mutate: (current: HivePolicy) => HivePolicy;
  },
  seams: AuthorHivePolicySeams = {},
): Promise<AuthorHivePolicyResult> {
  // WI-5321/WI-5061: resolve BEFORE the read-current below, else this fn's own
  // ambient-scoped read misses the Hive's true (historical) row the same way the
  // keypair-ownership gate inside authorHivePolicy would — same fast-path/fallback
  // as there, so the common case costs nothing extra beyond what already ran.
  const resolveWorkspaceId = seams.resolveWorkspaceId ?? resolveHiveWorkspaceId;
  const workspaceId = await resolveWorkspaceId(input.workspaceId, input.potHomeSlug);
  const readCurrent = seams.readCurrent ?? getHivePolicy;
  const current = await readCurrent(workspaceId, input.potHomeSlug);
  const nextPolicy = input.mutate(current?.policy ?? {});
  return authorHivePolicy(
    { workspaceId, potHomeSlug: input.potHomeSlug, policy: nextPolicy },
    seams,
  );
}
