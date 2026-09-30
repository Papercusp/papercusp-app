/**
 * pot-git/rekey-link-joined-repo-keys — repair an invite-LINK-joined entry that
 * a pre-WI-10003277 build left keyed on its bare slug (WI-10003590).
 *
 * THE STRANDING. An invite-link join (join-shared-harness.ts / the join-link
 * route) writes the member's registry entry. Before WI-10003277 that entry could
 * land WITHOUT `github_repository_id` / `github_remote` (the boot-time heal wrote
 * a bare `{ slug, path }`), so `repoKeyLadder` fell to its bare-slug rung and
 * `pin-repo-keys.ts` froze that guess as a `'local'` pin. WI-10003277 fixed the
 * WRITER, but a fix that only runs at join time cannot reach an entry that was
 * already written:
 *   · `canonicalRepoKey` treats any existing pin as authoritative forever;
 *   · `healLinkJoinedEntries` / `enrichJoinedClones` complete the link-joined
 *     SHAPE but have no upstream coords to hand it (they pass `{}`);
 *   · `adopt-announced-repo-keys.ts` skips `remote_hive` entries entirely, and
 *     its restore half only fires for an entry that ALREADY carries coords.
 * So the member keys pot-git on its slug forever and never bootstraps the
 * owner's `gh-<id>` store. Measured on the P-505 rig VM 2026-09-28: the
 * `hello-world-3-pot` entry sat at `{ pot_repo_key:'hello-world-3-pot',
 * source:'local' }` with no coords while its own clone's `.papercusp/shared.json`
 * carried `github_repository_id: 1303510992`; physical Phase A then died on
 * "cannot quarantine missing repo …/gh-1303510992.git". Hand-setting the coords +
 * pin made the very next git-sync tick bootstrap the store.
 *
 * THE REPAIR, per `joined_via_link` entry:
 *   1. BACKFILL missing upstream coords from the clone's own
 *      `.papercusp/shared.json` — the same binding `boot_federate` reads, written
 *      by the pot owner and committed into the repo. Existing values are never
 *      overwritten (same rule as `linkJoinedPatch`).
 *   2. RE-KEY a `'local'` pin that is a LOWER rung of the entry's own ladder to
 *      the ladder's best rung. This is the same "an entry with its own upstream
 *      coords derives its identity with certainty" rule adopt-announced's restore
 *      half applies to pot homes; it deliberately does NOT consult the announced
 *      `homeRepoKey` map, which is last-write-wins across every peer's
 *      self-announce (a weaker member's bare-slug announce can win it — the
 *      2026-08-02 tower corruption).
 *
 * WHAT IS NEVER TOUCHED.
 *   · A `'peer'` pin — a key adopted from the owner is never re-derived.
 *   · A pin that is not on the entry's own ladder at all — not a derivation this
 *     device made, so not ours to correct.
 *   · Any entry that is not `joined_via_link` — above all a pot HOME. Re-keying
 *     a home when it gains a GitHub binding is precisely the drift pinning exists
 *     to forbid (it orphans every member: EI-18788176839043286). A link-joined
 *     member owns no identity of its own; its correct key is the owner's.
 *
 * Re-keying abandons the bare store at the old key and the repo cold-joins the
 * pot under the new one — the correct outcome, since nobody else was talking to
 * the old store. `rekeyed` is logged with `from`, the highest-signal line for
 * anyone asking why a store changed path.
 *
 * Runs on the boot path AHEAD of `pinRepoKeysForWorkspace`, so an entry that was
 * never pinned gains its coords first and is pinned correctly on the first try.
 * Fail-soft by contract: never throws; a failure leaves the registry untouched
 * and the next boot retries.
 */

import {
  loadHarnessRegistry,
  saveHarnessRegistry,
  type HarnessRegistry,
  type ProjectEntry,
} from '../../harness-registry';
import { parseGithubUrl } from '../../harness/clone-github';
import { loadSharedConfigFromProjectDir } from '../../harness/load-shared-config';
import type { HarnessSharedConfig } from '../../harness/harness-shared-config-types';
import { deriveRepoKey, isValidRepoKey, repoKeyLadder } from './repo-identity';

export interface RekeyLinkJoinedRepoKeysDeps {
  loadRegistry?: (workspaceId?: string) => Promise<HarnessRegistry>;
  saveRegistry?: (reg: HarnessRegistry, workspaceId?: string) => Promise<unknown>;
  /** Read a clone's `.papercusp/shared.json` (default: the validated reader). */
  readSharedConfig?: (projectDir: string) => HarnessSharedConfig | null;
}

export interface RekeyLinkJoinedRepoKeysResult {
  /** Entries that gained upstream coords from their clone's shared.json. */
  backfilled: { slug: string; fields: ('github_remote' | 'github_repository_id')[] }[];
  /** Entries whose stale 'local' lower-rung pin moved to the ladder's best rung. */
  rekeyed: { slug: string; from: string; to: string }[];
  wrote: boolean;
  error?: string;
}

/** The coords a link-joined entry lacks that its clone's shared.json supplies.
 *  Empty when nothing is missing or the clone carries no binding. */
function coordsPatch(
  entry: ProjectEntry,
  shared: HarnessSharedConfig | null,
): Partial<Pick<ProjectEntry, 'github_remote' | 'github_repository_id'>> {
  if (!shared) return {};
  const patch: Partial<Pick<ProjectEntry, 'github_remote' | 'github_repository_id'>> = {};
  if (typeof entry.github_repository_id !== 'number') {
    patch.github_repository_id = shared.github_repository_id;
  }
  if (!entry.github_remote) {
    const parsed = parseGithubUrl(shared.github_remote);
    // Same shape upsertLinkJoinedEntry writes, so every reader sees one form.
    if (parsed) patch.github_remote = `https://github.com/${parsed.owner}/${parsed.repo}`;
  }
  return patch;
}

/**
 * The key a stale pin should move to, or null when the pin must stay: absent,
 * peer-adopted, already the best rung, or not one of this entry's own rungs.
 */
function staleLocalPinTarget(entry: ProjectEntry): { from: string; to: string } | null {
  const pin = entry.pot_repo_key;
  if (!isValidRepoKey(pin)) return null;
  if (entry.pot_repo_key_source === 'peer') return null;
  const best = deriveRepoKey(entry);
  if (pin === best) return null;
  if (!repoKeyLadder(entry).includes(pin)) return null;
  return { from: pin, to: best };
}

/**
 * Reconcile every `joined_via_link` entry in `workspaceId`: backfill its coords
 * from the clone's shared.json, then re-key a stale lower-rung 'local' pin.
 * Idempotent — a repaired entry is a true no-op on every later boot, and nothing
 * is written unless something changed.
 */
export async function rekeyLinkJoinedRepoKeysForWorkspace(
  workspaceId: string,
  deps: RekeyLinkJoinedRepoKeysDeps = {},
): Promise<RekeyLinkJoinedRepoKeysResult> {
  const load = deps.loadRegistry ?? loadHarnessRegistry;
  const save = deps.saveRegistry ?? saveHarnessRegistry;
  const readShared = deps.readSharedConfig ?? ((dir: string) => loadSharedConfigFromProjectDir(dir));
  try {
    const reg = await load(workspaceId);
    const backfilled: RekeyLinkJoinedRepoKeysResult['backfilled'] = [];
    const rekeyed: RekeyLinkJoinedRepoKeysResult['rekeyed'] = [];

    for (const entry of reg.projects) {
      if (entry.joined_via_link !== true) continue;

      const needsCoords =
        typeof entry.github_repository_id !== 'number' || !entry.github_remote;
      if (needsCoords && entry.path) {
        let shared: HarnessSharedConfig | null = null;
        try {
          shared = readShared(entry.path);
        } catch {
          shared = null; // an unreadable clone is not fatal; the pin is left as-is
        }
        const patch = coordsPatch(entry, shared);
        const fields = Object.keys(patch) as ('github_remote' | 'github_repository_id')[];
        if (fields.length > 0) {
          Object.assign(entry, patch);
          backfilled.push({ slug: entry.slug, fields });
        }
      }

      const target = staleLocalPinTarget(entry);
      if (!target) continue;
      entry.pot_repo_key = target.to;
      entry.pot_repo_key_source = 'local';
      rekeyed.push({ slug: entry.slug, ...target });
    }

    if (backfilled.length === 0 && rekeyed.length === 0) {
      return { backfilled, rekeyed, wrote: false };
    }

    await save(reg, workspaceId);
    for (const b of backfilled) {
      console.log(
        `[pot-git] ${b.slug}: backfilled ${b.fields.join(' + ')} from the clone's ` +
          `.papercusp/shared.json — an older invite-link join left this entry without ` +
          `upstream coords (WI-10003590).`,
      );
    }
    for (const r of rekeyed) {
      console.log(
        `[pot-git] ${r.slug}: re-keyed a stale local pin '${r.from}' → '${r.to}' — this ` +
          `link-joined member was keyed on a lower rung of its own identity ladder, so it ` +
          `never reached the pot owner's store; the old store is abandoned and the repo ` +
          `cold-joins under the new key (WI-10003590).`,
      );
    }
    return { backfilled, rekeyed, wrote: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.warn(
      `[pot-git] workspace '${workspaceId}': link-joined repoKey reconcile failed (${error}) — ` +
        `keys are unchanged and the next boot retries.`,
    );
    return { backfilled: [], rekeyed: [], wrote: false, error };
  }
}
