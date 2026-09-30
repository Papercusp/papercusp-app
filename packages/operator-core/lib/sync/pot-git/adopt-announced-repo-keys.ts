/**
 * pot-git/adopt-announced-repo-keys — adopt the POT OWNER's announced repoKey
 * for a locally-minted pot home (A3, EI-18788176839043286).
 *
 * WHY A SECOND PASS EXISTS AT ALL. `join-hive.ts` already adopts the owner's key
 * from the member join link, which covers every pot a device JOINED. It does not
 * cover a pot home this device minted ITSELF — and that is not an edge case: the
 * canonical `papercusp` pot is minted independently on EVERY install by
 * `ensure-papercusp-hive`, with no upstream coords, so it derives the bare slug.
 * The day the OTHER device's twin gains a GitHub binding, that device re-keys to
 * `gh-<id>` and the two silently stop talking — which is exactly the live
 * rig/tower split this whole work-item is about.
 *
 * WHY IT KEYS ON `homeRepoKey` AND NOT `memberRepos`/`memberLinks`. Those carry
 * the member's UPSTREAM GitHub coords, so a peer can only adopt from them if it
 * already holds the same coords to match on. The pot home is precisely the entry
 * that frequently has NONE (that is why it derives the bare slug in the first
 * place), so it can correlate against nothing — the correlation key and the
 * missing data are the same thing. `homeRepoKey` sidesteps it: the announce's
 * `hive_id` IS the correlator, so a device whose local pot home carries that slug
 * adopts directly.
 *
 * WHY OVERRIDING A PIN HERE IS SAFE. `adoptRepoKey` only overrides a pin stamped
 * `pot_repo_key_source: 'local'` (or an unstamped legacy pin, treated as local) —
 * a value this device GUESSED. A key already adopted from a peer is never
 * re-derived. That stamp is written by `pin-repo-keys.ts` for exactly this
 * reason, which is also why this pass must run AFTER it: the backfill writes the
 * guess down, this pass corrects it against the owner.
 *
 * ⚠ WHY A FEDERATED-IDENTITY ENTRY IS SKIPPED ENTIRELY (live regression fixed
 * 2026-08-02). `byPotId` is keyed only by `potId` and is last-write-wins across
 * EVERY discovered hive descriptor sharing that potId — including a WEAKER
 * peer's own bare-slug self-announce. An entry that already carries its own
 * `github_repository_id`/`github_remote` (see {@link hasFederatedIdentity}) can
 * derive its identity with certainty and IS, or is as good as, the owner — it
 * must never adopt from that map, strong or not. Live on 2026-08-02: the
 * tower's own `papercusp` entry (id `1223568103`) was flipped from the correct
 * `gh-1223568103` to the rig's bare `papercusp`, stamped `'peer'`, because the
 * only gate was `pot_repo_key_source === 'local'` — which a correctly-derived
 * value also carries. This pass now (a) never adopts INTO a federated-identity
 * entry, and (b) actively RESTORES one if a prior (buggy) pass already
 * corrupted it — the corruption is otherwise permanent: `canonicalRepoKey`
 * treats any existing pin as authoritative forever, so the ordinary pin-first
 * backfill (`pinRepoKeysForWorkspace`) never revisits an already-pinned entry.
 *
 * ⚠ (b) RUNS UNCONDITIONALLY — it is NOT gated on the announce set (fixed
 * 2026-08-02). The restore compares an entry against its OWN upstream coords, so
 * it needs no peer announcement; it originally sat behind two early returns
 * ("the directory threw" and "nothing announced a home key") that fired before
 * the registry was even loaded. That made the guarantee above false in precisely
 * the states where it is load-bearing — a fresh install, an offline device, a
 * boot with no directory wired, and the COLD-JOIN state itself — so a device
 * could stay permanently mis-keyed while this module read as having fixed it.
 * Only the ADOPT half (a) legitimately depends on `byPotId`.
 *
 * ⚠ WHAT ADOPTION ALONE DOES NOT FIX. Re-keying makes this device ASK for the
 * right repo; it does not stop a peer from serving a SUPERSEDED store under the
 * old key. The live incident stayed invisible for 7 days precisely because the
 * abandoned `papercusp.git` kept answering fetches, so a fully-disconnected
 * joiner reported `ok:true`. Detection is tracked separately (a superseded store
 * must stop answering; bootstrap `ok:true` must mean "converged with the pot").
 *
 * Fail-soft by contract: this runs on the boot path and never throws — a failure
 * leaves keys exactly as they are and the next boot retries.
 */

import {
  loadHarnessRegistry,
  saveHarnessRegistry,
  type HarnessRegistry,
  type ProjectEntry,
} from '../../harness-registry';
import { adoptRepoKey, deriveRepoKey, hasFederatedIdentity } from './repo-identity';

/** The only shape this needs from a discovered hive (hive-directory.ts). */
export interface AnnouncedHomeKey {
  potId: string;
  /** Set when the announce is a LOCAL GUESS at the slug rather than the owner's
   *  authored one — never adopt from it (see DiscoveredHive.potIdSynthetic). */
  potIdSynthetic?: boolean;
  homeRepoKey?: string;
}

export interface AdoptAnnouncedRepoKeysDeps {
  loadRegistry?: (workspaceId?: string) => Promise<HarnessRegistry>;
  saveRegistry?: (reg: HarnessRegistry, workspaceId?: string) => Promise<unknown>;
  /** The verified discovered-hive set (default: the live directory's). */
  listAnnounced?: () => Promise<AnnouncedHomeKey[]> | AnnouncedHomeKey[];
}

export interface AdoptAnnouncedRepoKeysResult {
  /** Entries whose key changed to the owner's announced value. */
  adopted: { slug: string; from: string | undefined; to: string }[];
  /** Entries with their own upstream coords whose OWN derived identity was
   *  restored — either because a prior (buggy) pass had mis-adopted a
   *  weaker peer's announced value over it, or any other drift. These never
   *  came from `byPotId`; see {@link hasFederatedIdentity}. */
  restoredOwnIdentity: { slug: string; from: string | undefined; to: string }[];
  /** Entries already carrying the announced key (or already peer-adopted). */
  unchanged: number;
  wrote: boolean;
  error?: string;
}

/**
 * A pot HOME this device owns locally — the only entries this pass touches. A
 * joiner-side VIEW (`remote_hive`) is excluded: it is materialized by join-hive,
 * which already adopts from the link, and it owns no store of its own.
 */
function isLocalPotHome(p: ProjectEntry): boolean {
  if (p.remote_hive === true) return false;
  return p.harness_kind === 'hive' || p.self_repo === true;
}

/**
 * Reconcile every locally-minted pot home in `workspaceId` against the owner's
 * announced `homeRepoKey`. Idempotent: once a key is adopted it is stamped
 * `'peer'` and a second pass changes nothing.
 */
export async function adoptAnnouncedRepoKeysForWorkspace(
  workspaceId: string,
  deps: AdoptAnnouncedRepoKeysDeps = {},
): Promise<AdoptAnnouncedRepoKeysResult> {
  const load = deps.loadRegistry ?? loadHarnessRegistry;
  const save = deps.saveRegistry ?? saveHarnessRegistry;
  try {
    const listAnnounced =
      deps.listAnnounced ??
      (async () => {
        // Lazily imported so this module stays usable without the directory (and
        // so a boot with none wired is a clean no-op, not a throw) — the same
        // lazy-`await import` seam hive-membership-store.ts uses for this.
        const { getHiveDirectory } = await import('../../hive-directory-deps');
        return getHiveDirectory().listDiscoveredHives({ includeExpired: true });
      });

    // ⚠ AN ABSENT / FAILING DIRECTORY MUST NOT SKIP THE RESTORE PASS (fixed
    // 2026-08-02, the live tower corruption below). These two conditions used to
    // `return` early, BEFORE the registry was even loaded — which silently made
    // this module's own claim (b) ("actively RESTORES a corrupted entry") false in
    // exactly the states that matter most:
    //   · a device that discovers no peers — a fresh install, an offline laptop,
    //     or the COLD-JOIN state this whole lane exists to make work;
    //   · a boot with no directory wired (the lazy-import no-op path above);
    //   · any transient throw out of the directory.
    // The restore half is PURELY LOCAL — it compares an entry against its OWN
    // upstream coords and needs no announcement whatsoever — so gating it behind
    // "some peer announced something" was a precondition it never had. And the
    // corruption it repairs is otherwise PERMANENT (`canonicalRepoKey` treats any
    // existing pin as authoritative forever, so the pin-first backfill never
    // revisits it), which is why an unreachable repair reads as a fixed bug while
    // the device stays broken. Measured on the tower 2026-08-02: `papercusp` sat
    // pinned to the rig's bare `papercusp`/'peer' despite carrying
    // github_repository_id 1223568103, with a 4.0G store written under the wrong
    // key. Only the ADOPT half legitimately depends on the announce set.
    let announced: AnnouncedHomeKey[] = [];
    try {
      announced = await listAnnounced();
    } catch {
      // Directory unavailable ⇒ nothing to adopt FROM, but the local restore below
      // is still both valid and necessary. Fall through with an empty announce set.
      announced = [];
    }

    // Only announces that actually carry a home key and a TRUSTWORTHY slug.
    const byPotId = new Map<string, string>();
    for (const h of announced) {
      if (!h.homeRepoKey || h.potIdSynthetic) continue;
      byPotId.set(h.potId, h.homeRepoKey);
    }

    const reg = await load(workspaceId);
    const adopted: { slug: string; from: string | undefined; to: string }[] = [];
    const restoredOwnIdentity: { slug: string; from: string | undefined; to: string }[] = [];
    let unchanged = 0;
    // A key that was already correct but is only now provable as the OWNER's
    // (source 'local' → 'peer'). Worth persisting — it stops a later pass from
    // re-deriving — but it is not a re-key and must not be reported as one.
    let restamped = 0;

    for (const entry of reg.projects) {
      if (!isLocalPotHome(entry)) continue;

      if (hasFederatedIdentity(entry)) {
        // This entry can derive its OWN identity with certainty from real
        // upstream coords — it must never adopt from `byPotId` (see the
        // header). Force it back to its own derivation; an already-correct
        // entry is a true no-op, so this is safe to run every boot.
        const ownKey = deriveRepoKey(entry);
        const before = entry.pot_repo_key;
        if (before === ownKey) {
          unchanged += 1;
          continue;
        }
        entry.pot_repo_key = ownKey;
        entry.pot_repo_key_source = 'local';
        restoredOwnIdentity.push({ slug: entry.slug, from: before, to: ownKey });
        continue;
      }

      const announcedKey = byPotId.get(entry.slug);
      if (!announcedKey) continue;

      const before = entry.pot_repo_key;
      const beforeSource = entry.pot_repo_key_source;
      const next = adoptRepoKey(entry, announcedKey);
      // Nothing to write. This is the STEADY STATE and it must stay a true
      // no-op: this runs on every boot, and persisting an identical registry
      // each time would be a pointless write on the hot boot path.
      if (next.key === before && next.source === beforeSource) {
        unchanged += 1;
        continue;
      }
      entry.pot_repo_key = next.key;
      entry.pot_repo_key_source = next.source;
      if (next.key === before) {
        restamped += 1;
        unchanged += 1;
        continue;
      }
      adopted.push({ slug: entry.slug, from: before, to: next.key });
    }

    if (adopted.length === 0 && restoredOwnIdentity.length === 0) {
      if (restamped > 0) await save(reg, workspaceId).catch(() => {});
      return { adopted, restoredOwnIdentity, unchanged, wrote: restamped > 0 };
    }

    await save(reg, workspaceId);
    for (const a of adopted) {
      console.log(
        `[pot-git] ${a.slug}: adopted the pot owner's announced repoKey '${a.to}'` +
          `${a.from ? ` (was '${a.from}')` : ''} — this device was federating under a ` +
          `key no peer shares; its old bare store is abandoned and the repo will ` +
          `cold-join the pot under the new key (EI-18788176839043286).`,
      );
    }
    for (const r of restoredOwnIdentity) {
      console.log(
        `[pot-git] ${r.slug}: restored its own federated repoKey '${r.to}'` +
          `${r.from ? ` (was '${r.from}')` : ''} — this entry has its own upstream coords ` +
          `and must never adopt a peer's announced value over them (EI-18788176839043286).`,
      );
    }
    return { adopted, restoredOwnIdentity, unchanged, wrote: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.warn(
      `[pot-git] workspace '${workspaceId}': announced-repoKey adoption failed (${error}) — ` +
        `keys are unchanged and the next boot retries.`,
    );
    return { adopted: [], restoredOwnIdentity: [], unchanged: 0, wrote: false, error };
  }
}
