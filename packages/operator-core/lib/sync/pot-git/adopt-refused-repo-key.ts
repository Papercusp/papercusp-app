/**
 * pot-git/adopt-refused-repo-key — adopt the canonical repoKey a PEER named
 * when it refused our fetch as `superseded-repo-key:<K>` (WI-6364, fix C's
 * joiner half).
 *
 * THE THIRD ADOPTION CHANNEL. A3 (EI-18788176839043286) established the rule
 * that makes two devices agree on a repoKey — the owner MINTS, everyone else
 * ADOPTS — and gave it two carriers, both of which need something the diverged
 * device may not have:
 *
 *   1. the JOIN LINK's `repo_key` (join-hive.ts) — requires a fresh join, which
 *      an already-established member never performs again;
 *   2. the ANNOUNCE frame's `home_repo_key` (adopt-announced-repo-keys.ts) —
 *      requires the announce to be arriving and to carry the field, i.e. the
 *      owner already running a build that publishes it.
 *
 * This is the third, and it is the one that needs NOTHING but the connection
 * the joiner is already making: the store's holder tells the requester, on the
 * very dial that would otherwise have been served stale bytes, what its store
 * is actually named. The refusal is not merely loud — it CARRIES ITS OWN
 * REPAIR, which is what turns fix C from a diagnostic into a self-healing one.
 *
 * WHY A PEER'S REFUSAL IS TRUSTWORTHY ENOUGH TO ACT ON. It is not a claim about
 * the pot's identity in general — it is a first-hand statement about the state
 * of the responder's OWN disk ("the store you asked for is one I abandoned; the
 * one I write is K"), made by the device that would have served the bytes. That
 * is strictly better evidence than the requester's own derivation, which is a
 * guess assembled from local registry fields. Two guards keep it honest:
 *
 *   - an existing `'peer'` pin is NEVER overridden. That pin came from the
 *     OWNER (link or announce); a member device that has itself diverged must
 *     not be able to drag a correctly-adopted joiner back off it.
 *   - the key is re-validated (`isValidRepoKey`, inside
 *     {@link parseSupersededRepoKeyRefusal}) before it is written, because it
 *     arrives from another machine and becomes a filesystem path component and
 *     a git ref component.
 *
 * And it stays subordinate to A3: the pin is stamped `'peer'`, and
 * `adoptRepoKey`'s rule 1 lets a later OWNER-announced key override it anyway.
 * So the worst case of trusting a wrong peer is a lateral move that the owner's
 * announce then corrects — never a cemented divergence.
 *
 * The re-key takes effect on the NEXT tick, deliberately: the running tick's
 * `repoPath`/`repoKey` were resolved before the dial, and swapping a store path
 * mid-leg is exactly the kind of half-applied state a fail-soft routine must
 * not create. Nothing is lost — the next fire is ~5 minutes away and the ladder
 * is resumable by contract.
 *
 * Fail-soft: runs inside a git-sync tick, so it never throws.
 */

import {
  loadHarnessRegistry,
  saveHarnessRegistry,
  type HarnessRegistry,
} from '../../harness-registry';
import { canonicalRepoKey, parseSupersededRepoKeyRefusal } from './repo-identity';

export interface AdoptRefusedRepoKeyDeps {
  loadRegistry?: (workspaceId?: string) => Promise<HarnessRegistry>;
  saveRegistry?: (reg: HarnessRegistry, workspaceId?: string) => Promise<unknown>;
}

export interface AdoptRefusedRepoKeyResult {
  /** The key adopted, or null when nothing was written. */
  adopted: string | null;
  /** The key this entry was on before (undefined ⇒ it had no pin). */
  from?: string;
  /** Why no write happened — for the caller's log line. */
  skipped?:
    | 'not-a-superseded-refusal'
    | 'no-such-entry'
    | 'already-canonical'
    | 'owner-pin-wins'
    | 'registry-error';
}

/**
 * Adopt the canonical key out of a peer's refusal for the registry entry
 * `slug`. `refusalMessage` is the raw duplex destroy-error text
 * (`pot-git serve refused: superseded-repo-key:gh-123`) — pass it verbatim; a
 * message that is not a superseded refusal is a clean no-op.
 */
export async function adoptRefusedRepoKey(
  slug: string,
  refusalMessage: unknown,
  deps: AdoptRefusedRepoKeyDeps = {},
  workspaceId?: string,
): Promise<AdoptRefusedRepoKeyResult> {
  const announcedKey = parseSupersededRepoKeyRefusal(refusalMessage);
  if (!announcedKey) return { adopted: null, skipped: 'not-a-superseded-refusal' };

  const load = deps.loadRegistry ?? loadHarnessRegistry;
  const save = deps.saveRegistry ?? saveHarnessRegistry;
  try {
    const reg = await load(workspaceId);
    const entry = reg.projects.find((p) => p.slug === slug);
    if (!entry) return { adopted: null, skipped: 'no-such-entry' };

    // Already right — the common case once a re-key has landed, and it must be
    // a true no-op: this runs on every refused dial.
    if (canonicalRepoKey(entry) === announcedKey) {
      return { adopted: null, skipped: 'already-canonical' };
    }
    // The owner's own word outranks a member's report of its disk.
    if (entry.pot_repo_key_source === 'peer') {
      return { adopted: null, skipped: 'owner-pin-wins' };
    }

    const from = entry.pot_repo_key;
    entry.pot_repo_key = announcedKey;
    entry.pot_repo_key_source = 'peer';
    await save(reg, workspaceId);
    return { adopted: announcedKey, ...(from ? { from } : {}) };
  } catch {
    return { adopted: null, skipped: 'registry-error' };
  }
}
