/**
 * pot-git/pin-repo-keys — freeze every registry entry's pot-git repoKey
 * (EI-18788176839043286, 2026-07-27).
 *
 * WHY THIS EXISTS. A pot-git repoKey names BOTH the bare store on disk
 * (`hiveGitRepoPath`) and the repo on the wire (the `req` frame), so two
 * devices in one pot converge only while they agree on it. It used to be
 * DERIVED — fresh on every call, from the device's own mutable harness-registry
 * entry (`canonicalRepoKey`'s ladder: `gh-<id>` > `gh-<owner>--<repo>` > the
 * bare local slug). A derived name is not an identity: the moment the inputs
 * change on one device, that device silently starts using a DIFFERENT name for
 * the same repo.
 *
 * That is not hypothetical — it is the live failure this module was written
 * for. `ensure-papercusp-hive` mints the canonical pot home with NO upstream
 * coords, so it derives step 3, the bare slug. When that device later publishes
 * to GitHub (`pot/_create.ts` stamps `github_repository_id` on the SAME entry)
 * the key flips to `gh-<id>` — a new store path and a new wire key — abandoning
 * the old store. Every peer still on the old key is orphaned, and the failure
 * is SILENT IN THE WORST WAY: the abandoned store is still on disk and still
 * answers fetches, so the orphaned joiner keeps reporting `ok:true`. The P-302
 * rig sat exactly like this for 7 days — fully disconnected from the pot's live
 * git, publishing nothing for 18 days, every health signal green.
 *
 * WHAT THIS DOES. Once per boot, write down the key each entry is ALREADY
 * using (`pinRepoKey`, which returns an existing pin unchanged and otherwise
 * derives). Behaviourally a no-op TODAY — nothing about the current tick
 * changes — but from then on the key is pinned, so no later change to
 * `github_repository_id` / `github_remote` / the slug can re-key a live pot out
 * from under its peers. It is the half of the fix that protects ALREADY
 * ESTABLISHED pots; `pot/_create.ts` (after publish) and `join-hive.ts` (after
 * the link coords) pin the new-create and new-join paths.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not try to REPAIR a pot whose
 * devices have already diverged (the rig/tower pair today) — it freezes what
 * this device currently uses, which is the safe, local, unambiguous action.
 * Retroactively agreeing on a shared key is A3's job: the owner publishes the
 * key its store is really named (`repo_key` on the member join link) and every
 * other device ADOPTS it (`adoptRepoKey`). Which is exactly why every pin
 * written here is stamped `pot_repo_key_source: 'local'` — it marks the pin as
 * this device's own GUESS, so an announced key is allowed to override it later.
 * Without that stamp this pass would be actively HARMFUL: it would cement every
 * already-diverged install on its wrong key the first time it ran, and A3 could
 * never repair anything. A tempting
 * alternative — "pin to whichever bare store already exists on disk" — sounds
 * more accurate but is ambiguous exactly where it matters: a device mid-drift
 * holds BOTH stores (the tower has `papercusp.git` AND `gh-1223568103.git`) and
 * there is no local way to tell which one its peers are using.
 *
 * Fail-soft by contract: this runs on the boot path, so it never throws — a
 * failure leaves entries unpinned (i.e. exactly today's behaviour) and the next
 * boot retries.
 */

import {
  loadHarnessRegistry,
  saveHarnessRegistry,
  type HarnessRegistry,
} from '../../harness-registry';
import { pinRepoKey } from './repo-identity';

export interface PinRepoKeysDeps {
  loadRegistry?: (workspaceId?: string) => Promise<HarnessRegistry>;
  saveRegistry?: (reg: HarnessRegistry, workspaceId?: string) => Promise<unknown>;
}

export interface PinRepoKeysResult {
  /** Entries that gained a pin on this pass. */
  pinned: { slug: string; repoKey: string }[];
  /** Entries that already carried a pin and were left untouched. */
  alreadyPinned: number;
  /** True when the registry was written (i.e. `pinned` was non-empty). */
  wrote: boolean;
  /** Set when the pass failed; the registry is then guaranteed untouched. */
  error?: string;
}

/**
 * Pin every unpinned entry in `workspaceId`'s registry to the repoKey it is
 * already using. Idempotent: a second run pins nothing and writes nothing.
 */
export async function pinRepoKeysForWorkspace(
  workspaceId: string,
  deps: PinRepoKeysDeps = {},
): Promise<PinRepoKeysResult> {
  const load = deps.loadRegistry ?? loadHarnessRegistry;
  const save = deps.saveRegistry ?? saveHarnessRegistry;
  try {
    const reg = await load(workspaceId);
    const pinned: { slug: string; repoKey: string }[] = [];
    let alreadyPinned = 0;

    for (const entry of reg.projects) {
      if (entry.pot_repo_key) {
        alreadyPinned += 1;
        continue;
      }
      // pinRepoKey is the SAME resolution canonicalRepoKey would perform right
      // now, so writing it changes nothing about this tick — it only removes the
      // ability for a later coord change to move it.
      const repoKey = pinRepoKey(entry);
      entry.pot_repo_key = repoKey;
      // 'local' = this device's own derivation, NOT the owner's announced key.
      // A3's `adoptRepoKey` relies on this to know it may override the pin.
      entry.pot_repo_key_source = 'local';
      pinned.push({ slug: entry.slug, repoKey });
    }

    if (pinned.length === 0) return { pinned, alreadyPinned, wrote: false };

    await save(reg, workspaceId);
    console.log(
      `[pot-git] workspace '${workspaceId}': pinned ${pinned.length} repoKey(s) so they ` +
        `can no longer drift (EI-18788176839043286): ` +
        `${pinned
          .slice(0, 5)
          .map((p) => `${p.slug}=${p.repoKey}`)
          .join(', ')}${pinned.length > 5 ? ', …' : ''}`,
    );
    return { pinned, alreadyPinned, wrote: true };
  } catch (e) {
    // Boot path: never throw. Unpinned entries behave exactly as they do today.
    const error = e instanceof Error ? e.message : String(e);
    console.warn(
      `[pot-git] workspace '${workspaceId}': repoKey pin pass failed (${error}) — ` +
        `entries stay unpinned and the next boot retries.`,
    );
    return { pinned: [], alreadyPinned: 0, wrote: false, error };
  }
}
