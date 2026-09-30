/**
 * pot-git/integrator-tick.ts — P-203: the RUNTIME DRIVER for the staging
 * integrator (p2p-git-live-activation-2026-07-09 P-203).
 *
 * Every OTHER piece of the integrator already exists as a pure library:
 * `integrator.ts` (G-5 merge-queue), `integration-requests.ts` (G-5c trust
 * gate + ratify queue), `staging-advance.ts` (G-5d signed, epoch-fenced
 * announcement). NONE of it runs on a schedule yet — this module is that
 * missing tick, composed exactly the way `github-bridge-tick.ts` composes its
 * own already-landed legs (D-003: no new scheduler — the caller rides the
 * existing `system:git-sync` tick, mode-gated to `hiveGit.mode != legacy`).
 *
 * ONE TICK:
 *   1. Owning-hive key gate (F6/D-022) — only the single owner computes and
 *      publishes canonical staging. Other members publish their own heads and
 *      follow owner-countersigned staging. Presence elections cannot authorize
 *      takeover when that owner is unavailable.
 *   2. Read every verified member's current namespace work head.
 *   3. `gateMemberHeadsForIntegration` (G-5c): steer-tier / owner-ratified
 *      heads integrate now; below-steer heads QUEUE for ratification — never
 *      silently merged, never silently dropped.
 *   4. `integrateMemberHeads` (G-5): pure merge-queue integration, publishes
 *      the new staging in the integrator's own namespace.
 *   5. On advance: sign a staging-advance announcement (G-5d). `epoch` is the
 *      caller's current granted lease epoch (never invented here — this
 *      module only STAMPS it); `seq` is the caller-persisted per-epoch
 *      counter, bumped by one on every publish. The caller EMITS the
 *      announcement hive-wide (`events:emit { event:
 *      STAGING_ADVANCE_EVENT_KEY, scope: 'hive' }`) and persists the new
 *      `{ epoch, seq }` watermark — mirroring how the bridge leg persists
 *      `last_admitted` on `routines.metadata`.
 *
 * Never throws — every failure is folded into `errors` and the tick reports
 * `ran: false` rather than wedging the enclosing git-sync tick.
 */
import type { CommsTier } from '../../trust/comms-trust';
import type { LockAuthorityDeps } from '../../authority/lock-authority';
import { requireHiveEffectAuthority, type HiveEffectAuthority } from './hive-effect-authority';
import {
  defaultRunGit,
  hiveGitRepoPath,
  readNamespaceRefForDevices,
  readNamespaceRef,
  type RunGit,
} from './storage';
import { WORK_REF, integrateMemberHeads, type IntegrationResult, type MemberHead } from './integrator';
import { gateMemberHeadsForIntegration, type GateableHead } from './integration-requests';
import { signStagingAdvance, type SignedStagingAdvance } from './staging-advance';
import type { SignedProtocolContext, SignedSnapshotFloor } from './signed-context';
import { readSigrefs, acceptFetchedSigrefs, reconcileFetchedHeads, SIGREFS_REF } from './sigrefs';

export interface IntegratorTickInput {
  potHomeSlug: string;
  workspaceId: string;
  /** The (hive, managed repo) key under the pot-git root — matches
   *  `hiveGitRepoPath` / `BridgeTickInput.repoKey`'s convention. */
  repoKey: string;
  /** The current verified member device set (sigrefs-verified upstream — same
   *  contract `collectMemberHeads` / `gateMemberHeadsForIntegration` assume). */
  memberDevicePubkeysBase64: string[];
  /** THIS device's identity pubkey (base64) — the integrator device when we
   *  hold the lease; the namespace staging publishes under. */
  integratorDevicePubkeyBase64: string;
  /** The current granted lease epoch (G-0 handoff / lock-authority) — stamped
   *  into the announcement, never invented here. */
  epoch: number;
  /** The caller-persisted per-epoch advance counter (0 before the first
   *  publish in this epoch). This tick signs `priorSeq + 1` on advance. */
  priorSeq: number;
  /**
   * The staging sha of the last EMITTED announcement, or null when nothing was
   * ever announced (prod: `resolveAnnouncementWatermark` — the integrator's own
   * persisted announcement record, falling back to the local
   * `worktree_bridge.stagingSha` acceptance watermark). Announcement firing is judged against THIS,
   * not merely against whether the merge moved the integrator's namespace ref
   * this pass — because own-head-publish (G-2a) writes the very same
   * `ns/<integrator>/refs/heads/staging` ref whenever the integrator machine's
   * checked-out branch IS `staging` (the normal git-sync case), integration's
   * base is then always pre-advanced to the member head, `advanced` stays
   * false forever, and NO announcement ever fires even though canonical
   * logically moved (live-caught on the hello-world-3-pot canary: member head
   * 8 commits ahead, integrator green, zero announcements). `undefined` keeps
   * the legacy advanced-only behavior (existing tests/callers unaffected).
   */
  lastAnnouncedStagingSha?: string | null;
  /**
   * WI-10003820 — the GitHub bridge's P-005-ADMITTED github-origin head (the
   * `routines.metadata.github_bridge.last_admitted` watermark), keyed by the
   * synthetic github-origin namespace (`githubOriginNamespaceKey(remote)`).
   *
   * github-ingress.ts S-3: "the bridge layer feeds this head to the integrator
   * EXPLICITLY, gated by the P-005 ingress admission, never via the
   * sigrefs-verified member reconcile". The synthetic device has no keypair,
   * so it can never hold a sigrefs floor or a comms tier: routing it through
   * `collectGateableHeads` + the G-5c gate would drop or queue it forever.
   * Admission IS its gate — the caller passes ONLY the admitted watermark,
   * never the raw namespace head (an ingressed-but-blocked head stays out).
   *
   * Before this input existed nothing consumed the admitted head, so on a
   * BRIDGED hive a PR merged on GitHub (or any upstream push) never reached
   * canonical staging (measured: P-505 run 31, Phase E healthy leg).
   * `null`/absent ⇒ no external head this pass (non-bridged hive, or nothing
   * admitted yet).
   */
  admittedGithubOriginHead?: MemberHead | null;
  /** Device signer seam (prod: `bytes => signWithDeviceKey(keychainId, bytes)`). */
  sign: (bytes: Buffer) => Promise<Buffer>;
  /** Comms-trust seam (prod: `resolveAuthorCommsTier(...).then(r => r.tier)`). */
  resolveTier: (devicePubkeyBase64: string) => CommsTier | null | Promise<CommsTier | null>;
  resolveAuthorGithubUserId?: (devicePubkeyBase64: string) => number | null | Promise<number | null>;
  nowMs?: number;
  /** Context bound into v2 staging-advance signatures when supplied. */
  context?: SignedProtocolContext;
  /** D-022: only the owning hive may integrate; an advisory election is insufficient. */
  authority?: HiveEffectAuthority | null;
  acceptedSnapshots?: Readonly<Record<string, SignedSnapshotFloor>>;
  deps?: {
    runGit?: RunGit;
    repoPath?: string;
    /** Optional additional local gate; cannot replace owning-hive authorization. */
    isIntegrator?: () => Promise<boolean>;
    lockAuthorityDeps?: LockAuthorityDeps;
    /** Threaded to `gateMemberHeadsForIntegration` (its own `sql` override). */
    sql?: Parameters<typeof gateMemberHeadsForIntegration>[0]['sql'];
  };
}

export interface IntegratorTickOutcome {
  ran: boolean;
  /** Set when this device is not (currently) the integrator lease holder —
   *  the correct, common no-op outcome on every non-authority member's tick. */
  skipped?: 'not-integrator';
  integration: IntegrationResult | null;
  gated: { integrated: number; queued: number; errors: number } | null;
  /** Set ONLY when staging advanced this tick. The caller MUST emit it
   *  hive-wide and persist `{ epoch, seq: announcement.seq }` as the new
   *  watermark — mirroring `lastAdmitted` in the github-bridge-tick leg. */
  announcement: SignedStagingAdvance | null;
  errors: string[];
}

/** One read per member of its current namespace work head (skips members with
 *  none yet) — the gate-ready `{devicePubkeyBase64, sha}` shape, distinct from
 *  `collectMemberHeads`'s already-hexed `MemberHead[]` (the gate needs the RAW
 *  identity pubkey to resolve trust + re-derives the hex itself on admit). */
async function collectGateableHeads(
  repoPath: string,
  memberDevicePubkeysBase64: string[],
  runGit: RunGit,
): Promise<GateableHead[]> {
  // Members publish their CHECKED-OUT branch ref (own-head-publish G-2a) and —
  // since the WI-3499 live drill — the canonical WORK_REF alias alongside it.
  // A namespace written by a pre-alias publisher only has the branch ref, so
  // when WORK_REF is absent fall back to the store's default-branch ref;
  // without the fallback such a member is silently invisible to the gate
  // (live-caught on the tower↔mac rig: every ns had only refs/heads/master).
  const head = await runGit(['symbolic-ref', '-q', 'HEAD'], repoPath);
  const defaultRef = head.code === 0 ? head.stdout.trim() : null;
  const out: GateableHead[] = [];
  // TWO `for-each-ref` calls at worst, not two `git` spawns PER MEMBER — see
  // readNamespaceRefForDevices (EI-18808838427010743). The fallback scan is
  // skipped entirely unless some member is actually missing WORK_REF, so the
  // healthy all-aliased case costs exactly one spawn.
  const workShas = await readNamespaceRefForDevices(repoPath, memberDevicePubkeysBase64, WORK_REF, runGit);
  const needFallback =
    defaultRef !== null &&
    defaultRef !== WORK_REF &&
    memberDevicePubkeysBase64.some((dev) => !workShas.has(dev));
  const fallbackShas = needFallback
    ? await readNamespaceRefForDevices(repoPath, memberDevicePubkeysBase64, defaultRef, runGit)
    : new Map<string, string>();
  for (const dev of memberDevicePubkeysBase64) {
    // `??` preserves the original precedence: the fallback is consulted ONLY
    // when this device has no WORK_REF, never as an override.
    const sha = workShas.get(dev) ?? fallbackShas.get(dev) ?? null;
    if (sha) out.push({ devicePubkeyBase64: dev, sha });
  }
  return out;
}

/**
 * WI-10003781 — the staging this integrator last ANNOUNCED, for
 * `IntegratorTickInput.lastAnnouncedStagingSha`.
 *
 * The local worktree bridge's accepted watermark cannot serve alone: the
 * bridge leg runs AFTER the integrator leg and is the only writer of that
 * watermark, so any integrator pass that runs before the announcing tick's
 * bridge leg persists reads the PREVIOUS staging and signs the same sha again
 * under seq+1. Measured on P-505 run 26: two overlapping hello-world-3-pot
 * ticks announced 2d936ad7f978 as seq 54 and seq 55, 23s apart. A local
 * terminal rejection or a timed-out bridge leg would repeat that every tick.
 *
 * The integrator's own record is authoritative only for the publication term
 * it was written under (same epoch, authority device and store generation):
 * a new term, or a record written before this field existed, falls back to the
 * bridge watermark (the prior behavior).
 */
export function resolveAnnouncementWatermark(
  prior: {
    epoch: number;
    authorityDevice?: string;
    storeGeneration?: string;
    stagingSha?: string | null;
  } | null,
  term: { epoch: number; authorityDevice: string; storeGeneration: string },
  bridgeAcceptedStagingSha: string | null,
): string | null {
  if (
    prior?.stagingSha &&
    prior.epoch === term.epoch &&
    prior.authorityDevice === term.authorityDevice &&
    prior.storeGeneration === term.storeGeneration
  ) {
    return prior.stagingSha;
  }
  return bridgeAcceptedStagingSha;
}

export async function runIntegratorTick(input: IntegratorTickInput): Promise<IntegratorTickOutcome> {
  const errors: string[] = [];
  const runGit = input.deps?.runGit ?? defaultRunGit;
  const repoPath = input.deps?.repoPath ?? hiveGitRepoPath(input.potHomeSlug, input.repoKey);
  const nowMs = input.nowMs ?? Date.now();
  const empty: IntegratorTickOutcome = { ran: false, integration: null, gated: null, announcement: null, errors };

  // 1. Owner-key gate, before any mutation (including integration queue writes).
  const isIntegrator = input.deps?.isIntegrator ?? (async () => true);
  let iAmIntegrator: boolean;
  try {
    await requireHiveEffectAuthority(input.authority, input.context ?? { hive_id: '', repo_key: input.repoKey },
      ['integrator-tick', repoPath, input.integratorDevicePubkeyBase64]);
    iAmIntegrator = await isIntegrator();
  } catch (e) {
    errors.push(
      `isIntegrator check failed (skipping this tick — safe: the real authority still runs its own): ${
        e instanceof Error ? e.message : e
      }`,
    );
    return { ...empty, skipped: 'not-integrator' };
  }
  if (!iAmIntegrator) return { ...empty, skipped: 'not-integrator' };

  // 2. Collect every member's current work head (gate-ready shape).
  let heads: GateableHead[];
  try {
    heads = await collectGateableHeads(repoPath, input.memberDevicePubkeysBase64, runGit);
    if (input.context) {
      const scope = { hive_id: input.context.hive_id, repo_key: input.context.repo_key };
      const verified = await Promise.all(heads.map(async (head) => {
        const device = head.devicePubkeyBase64;
        const floor = input.acceptedSnapshots?.[device];
        // The ref-announcement receiver is the authority that mints this
        // durable floor. Without one the device is ineligible by definition,
        // so reading/parsing its sigrefs and namespace OID cannot change the
        // verdict. Papercusp currently has dozens of repos with one dormant
        // peer lacking a floor; doing those Git reads every tick amplified the
        // same prerequisite miss across the whole registry.
        if (!floor) {
          errors.push(`unaccepted signed snapshot for ${device.slice(0, 12)} — waiting for verified ref announcement`);
          return null;
        }
        const [signed, oid] = await Promise.all([
          readSigrefs(repoPath, device, runGit), readNamespaceRef(repoPath, device, SIGREFS_REF, runGit),
        ]);
        if (!signed || oid !== floor.sigrefs_oid || signed.store_generation !== floor.store_generation ||
            signed.version !== floor.version ||
            !acceptFetchedSigrefs(signed, device, null, { expectedContext: scope }).ok ||
            (await reconcileFetchedHeads(repoPath, device, signed, runGit)).length !== 0) {
          errors.push(`unaccepted signed snapshot for ${device.slice(0, 12)} — waiting for verified ref announcement`);
          return null;
        }
        return head;
      }));
      heads = verified.filter((head): head is GateableHead => head !== null);
    }
  } catch (e) {
    errors.push(`collecting member work heads failed: ${e instanceof Error ? e.message : e}`);
    return empty;
  }

  // 3. G-5c trust gate: partition into integrate-now vs queued-for-ratification.
  const gated = await gateMemberHeadsForIntegration({
    workspaceId: input.workspaceId,
    potSlug: input.potHomeSlug,
    repoKey: input.repoKey,
    heads,
    resolveTier: input.resolveTier,
    resolveAuthorGithubUserId: input.resolveAuthorGithubUserId,
    sql: input.deps?.sql,
    nowMs,
  });
  errors.push(...gated.errors.map((e) => `gate ${e.devicePubkeyBase64.slice(0, 12)}: ${e.error}`));

  // 3b. WI-10003820: the bridge's P-005-admitted github-origin head joins the
  // set EXPLICITLY (github-ingress.ts S-3) — admission is its gate, so it
  // bypasses the sigrefs floor and the device-tier gate above. A head whose
  // commit is not in this store (a pruned or re-seeded store) is reported and
  // skipped, never handed to merge-tree as a phantom parent.
  const toIntegrate: MemberHead[] = [...(gated.integrate as MemberHead[])];
  const githubHead = input.admittedGithubOriginHead;
  if (githubHead?.sha) {
    const present = await runGit(['cat-file', '-e', `${githubHead.sha}^{commit}`], repoPath);
    if (present.code === 0) {
      toIntegrate.push({ deviceHex: githubHead.deviceHex, sha: githubHead.sha });
    } else {
      errors.push(
        `admitted github-origin head ${githubHead.sha.slice(0, 12)} is not in the store — not integrated this pass`,
      );
    }
  }

  // 4. G-5 integration of the admitted heads only.
  let integration: IntegrationResult;
  try {
    integration = await integrateMemberHeads(
      repoPath,
      input.integratorDevicePubkeyBase64,
      toIntegrate,
      { runGit, scope: input.context, authority: input.authority },
    );
  } catch (e) {
    errors.push(`integrateMemberHeads failed: ${e instanceof Error ? e.message : e}`);
    return {
      ran: true,
      integration: null,
      gated: { integrated: gated.integrate.length, queued: gated.queued.length, errors: gated.errors.length },
      announcement: null,
      errors,
    };
  }

  // 5. G-5d: sign + return the announcement on advance (caller emits + persists).
  // "Advance" is judged against the last ANNOUNCED staging when the caller
  // provides it (see lastAnnouncedStagingSha) — the per-pass ref motion alone
  // misses the integrator-is-also-the-author case, where own-head-publish
  // pre-advances the integration base every tick and `advanced` never trips.
  const announcedBehind =
    input.lastAnnouncedStagingSha !== undefined &&
    integration.staging !== null &&
    integration.staging !== input.lastAnnouncedStagingSha;
  let announcement: SignedStagingAdvance | null = null;
  if ((integration.advanced || announcedBehind) && integration.staging) {
    try {
      announcement = await signStagingAdvance(
        {
          devicePubkeyBase64: input.integratorDevicePubkeyBase64,
          epoch: input.epoch,
          seq: input.priorSeq + 1,
          stagingSha: integration.staging,
          nowMs,
          context: input.context,
          authority: input.authority ?? undefined,
        },
        input.sign,
      );
    } catch (e) {
      errors.push(`signStagingAdvance failed (staging advanced locally but was NOT announced): ${
        e instanceof Error ? e.message : e
      }`);
    }
  }

  return {
    ran: true,
    integration,
    gated: { integrated: gated.integrate.length, queued: gated.queued.length, errors: gated.errors.length },
    announcement,
    errors,
  };
}
