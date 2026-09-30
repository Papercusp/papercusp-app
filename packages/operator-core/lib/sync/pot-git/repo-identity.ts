/**
 * pot-git/repo-identity.ts — the CANONICAL cross-device repoKey for a managed
 * (member) repo (WI-5168, cross-machine-coord-parity-and-trust-2026-07-01's
 * G-8 sibling defect).
 *
 * BUG THIS FIXES: every device's LOCAL harness-registry `slug` for the SAME
 * repo can differ — `join-pot` derives it from that device's own local
 * registry, so a slug collision on one device forces a different slug there
 * (e.g. a tower registers `hello-world-3`, a joining VM registers
 * `hello-world` for the same `octocat/Hello-World`). git-sync-action.ts used
 * to key BOTH the bare-store path (`hiveGitRepoPath`) and the wire `req`
 * frame's `repoKey` (serve-wiring.ts) on this local slug directly, so a G-8
 * fetch asked the peer for a repoKey the peer's own store was never created
 * under — the fetch NEVER rendezvouses for any two devices whose install
 * slugs differ (i.e. nearly always).
 *
 * FIX: derive the wire+store repoKey from a FEDERATED identity both devices
 * agree on — GitHub's immutable numeric repository id — exactly the same
 * identity `deriveHiveMemberRepoRefs`/`hiveMatchesRepo` (hive-member-repos.ts)
 * already treat as authoritative for cross-device repo correlation, and for
 * the same reason. Encoded `gh-<id>` (a legal, safe single git-ref/path
 * component per storage.ts's `assertSafeComponent`).
 *
 * `github_repository_id` is itself best-effort (harness-registry.ts: "needs
 * API auth at registration"), so this degrades in two steps, each still
 * IDENTICAL across devices for the same upstream:
 *   1. `github_repository_id` present (the common case — hive homes publish
 *      to GitHub by DEFAULT per hive-repo-init.ts) → `gh-<id>`.
 *   2. Else `github_remote` resolves to `owner/repo` → `gh-<owner>--<repo>`
 *      (lowercased, sanitized) — still a genuine cross-device match as long
 *      as both sides parsed the same upstream URL, just without the
 *      collision-immunity an id-keyed identity gives against a rename.
 *   3. Else (no upstream known at all — a genuinely local-only repo) falls
 *      back to the local `slug`, same as before this fix: a repo with no
 *      shared upstream identity cannot rendezvous cross-device regardless of
 *      key scheme, so this is a pre-existing limitation, not a regression.
 */

import { parseGithubUrl } from '../../harness/clone-github';

/**
 * Where a pin CAME FROM — the difference between a guess and the truth.
 *
 * `'local'`  — this device DERIVED the key from its own registry entry. It is
 *              only a guess at the federated identity: correct when the entry
 *              carries the pot's upstream coords, merely conventional when it
 *              does not (the bare-slug rung).
 * `'peer'`   — this device ADOPTED the key the pot's OWNER announced (the join
 *              link's `repo_key`). This is the authoritative value: it is what
 *              the store on the owner's disk and the repo on the wire are
 *              actually named.
 *
 * The distinction exists because a LOCAL pin must never be allowed to freeze a
 * WRONG key in place. See {@link adoptRepoKey}.
 */
export type RepoKeySource = 'local' | 'peer';

/** The minimal shape this needs from a harness-registry `ProjectEntry`. */
export interface RepoIdentityEntry {
  slug: string;
  github_repository_id?: number;
  github_remote?: string;
  /** The PINNED federated repoKey — see {@link canonicalRepoKey}. When set it
   *  wins over every derivation below, permanently. */
  pot_repo_key?: string;
  /** Provenance of `pot_repo_key` — see {@link RepoKeySource}. Absent ⇒ treat
   *  as `'local'` (every pin minted before adoption existed was a derivation). */
  pot_repo_key_source?: RepoKeySource;
}

/** A repoKey is used verbatim as a filesystem path component AND as a git ref
 *  component (`hiveGitRepoPath` / the wire `req` frame), so a pin read back
 *  from the registry is validated against the same charset `storage.ts`'s
 *  `assertSafeComponent` enforces. Checked here rather than imported so this
 *  module stays pure (no fs). A malformed pin is IGNORED, not thrown — this
 *  runs inside a git-sync tick, which must never die on bad stored state. */
const SAFE_REPO_KEY = /^[A-Za-z0-9._-]{1,200}$/;
export function isValidRepoKey(v: unknown): v is string {
  return typeof v === 'string' && SAFE_REPO_KEY.test(v) && v !== '.' && v !== '..';
}
const validPin = isValidRepoKey;

/** Sanitize an owner/repo pair into a single safe path/ref component. GitHub
 *  owner/repo charset is `[A-Za-z0-9-]` (plus `.`/`_` in repo names), so this
 *  is defense-in-depth, not expected to ever actually strip anything. */
function safeSegment(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/**
 * EVERY repoKey this entry could legitimately have been keyed under, BEST RUNG
 * FIRST — the three-step ladder in the module header, materialized rather than
 * short-circuited.
 *
 * {@link deriveRepoKey} answers "what would this entry derive TODAY"; this
 * answers "what has this entry EVER been able to derive", which is the question
 * {@link supersededRepoKeys} needs. They are one list read two ways precisely so
 * they cannot drift: a fourth rung added here is automatically both derivable
 * and recognizable-as-abandoned, and a change to rung ORDER can never make the
 * derivation and the abandonment set disagree about which rung is canonical.
 */
export function repoKeyLadder(entry: RepoIdentityEntry): string[] {
  const rungs: string[] = [];
  const id = entry.github_repository_id;
  if (typeof id === 'number' && Number.isFinite(id) && id > 0) {
    rungs.push(`gh-${id}`);
  }
  if (entry.github_remote) {
    const parsed = parseGithubUrl(entry.github_remote);
    if (parsed) {
      rungs.push(`gh-${safeSegment(parsed.owner)}--${safeSegment(parsed.repo)}`);
    }
  }
  // Rung 3, the bare local slug, was the ONE rung not passed through a safety
  // transform — so it was the only rung able to emit a repoKey that is not a
  // legal path component. A submodule entry (slug 'papercusp/libs/generic/cache',
  // no upstream coords) therefore derived a SLASHED key, and every pot-git
  // bootstrap-tick for it died in storage.ts's assertSafeComponent: 5569 failures
  // in 24h on the tower, i.e. total federation failure for every submodule.
  //
  // Note this module already OWNED the predicate that catches it (isValidRepoKey,
  // used as `validPin`) — canonicalRepoKey rejects a slashed value as a PIN and
  // then falls through to this ladder, which handed the same value straight back.
  // The key was refused at one door and re-admitted through the other.
  //
  // isValidRepoKey is tested FIRST so every slug that is already a legal key is
  // pushed BYTE-IDENTICAL. A repoKey names both a cross-device rendezvous and an
  // on-disk store, so silently re-spelling a WORKING key would strand its store
  // and orphan its peers (EI-18788176839043286) — the exact failure pinning was
  // introduced to prevent. Only a slug that could never have worked is rewritten,
  // and the rewrite is deterministic, so two devices flatten it identically.
  rungs.push(isValidRepoKey(entry.slug) ? entry.slug : safeSegment(entry.slug));
  return [...new Set(rungs)];
}

/**
 * DERIVE a repoKey from `entry`'s current upstream coords — the best rung of
 * {@link repoKeyLadder}. Exported for the PIN-MINTING sites only
 * (`pinRepoKey`); everything on a hot path must call {@link canonicalRepoKey},
 * which honours an existing pin first.
 */
export function deriveRepoKey(entry: RepoIdentityEntry): string {
  // The ladder always ends with `entry.slug`, so it is never empty.
  return repoKeyLadder(entry)[0]!;
}

/**
 * True when `entry` carries real upstream coords (`github_repository_id` or
 * `github_remote`) — i.e. rung 1 or 2 of {@link repoKeyLadder} is available,
 * so this entry can derive its OWN federated identity with confidence rather
 * than falling back to the bare local `slug` (rung 3, merely conventional).
 *
 * Exists so a caller like `adoptAnnouncedRepoKeysForWorkspace` can tell "this
 * entry IS self-sufficient — it should mint, never adopt" apart from "this
 * entry has nothing of its own — it is exactly who adoption is for" (see that
 * module's header). Conflating the two let a self-sufficient entry adopt a
 * WEAKER peer's bare-slug guess over its own correct `gh-<id>` (live
 * 2026-08-02: the tower's own `papercusp` entry flipped from `gh-1223568103`
 * to the rig's bare `papercusp`, source `'peer'`, because the adopt pass had
 * no way to recognize the tower didn't need to adopt anything at all).
 */
export function hasFederatedIdentity(entry: RepoIdentityEntry): boolean {
  const id = entry.github_repository_id;
  if (typeof id === 'number' && Number.isFinite(id) && id > 0) return true;
  return !!entry.github_remote && !!parseGithubUrl(entry.github_remote);
}

/**
 * The canonical cross-device repoKey for `entry` — see module header. Pure
 * (no IO): callers already have `entry` from `loadHarnessRegistry()`.
 *
 * PIN-FIRST (EI-18788176839043286, 2026-07-27). A repoKey names BOTH the bare
 * store on disk and the repo on the wire, so it must be STABLE for the life of
 * the repo. Deriving it fresh on every call made it a function of MUTABLE local
 * registry state, which produced a silent, total federation failure:
 *
 *   A pot minted local-only (`ensure-papercusp-hive` creates the canonical
 *   `papercusp` home with NO upstream coords) derives step 3, the bare `slug`.
 *   The day THAT device acquires an upstream binding it starts deriving
 *   `gh-<id>` instead — a different store path and a different wire key — so it
 *   silently abandons its old store and orphans every peer still keyed on the
 *   old one. Live: the tower re-keyed `papercusp` → `gh-1223568103` on
 *   2026-07-20 and the P-302 rig, whose entry never gained the id, sat on
 *   `papercusp` converging the tower's ABANDONED store for 7 days while
 *   reporting `ok:true`. Same class for any user's pot created local-first and
 *   published to GitHub later: every existing member is orphaned.
 *
 * So a pin, once minted, WINS over every derivation — permanently, including
 * over a `github_repository_id` that shows up later. The ladder below is only
 * for a repo that has never been pinned.
 */
export function canonicalRepoKey(entry: RepoIdentityEntry): string {
  if (validPin(entry.pot_repo_key)) return entry.pot_repo_key;
  return deriveRepoKey(entry);
}

/**
 * The value to persist as `entry.pot_repo_key` when minting/joining a repo:
 * the existing pin when there is one (NEVER re-mint — that is the bug this
 * exists to prevent), else today's derivation. Idempotent, so a caller may run
 * it on every boot to backfill entries that predate pinning.
 *
 * NOTE for the one-time reconcile of ALREADY-diverged installs: adopting a
 * peer's key must go through the pot's announced identity (`member_repos`,
 * hive-announce.ts), not through this function — this only freezes what the
 * device would compute for itself right now.
 */
export function pinRepoKey(entry: RepoIdentityEntry): string {
  return validPin(entry.pot_repo_key) ? entry.pot_repo_key : deriveRepoKey(entry);
}

/** What {@link adoptRepoKey} decided, so a caller can persist the provenance
 *  alongside the key (and log a re-key, which strands the old store). */
export interface AdoptedRepoKey {
  key: string;
  source: RepoKeySource;
  /** True when this REPLACES a different key already pinned on the entry — the
   *  store at the old key is abandoned and the repo re-bootstraps from the peer. */
  rekeyedFrom?: string;
}

/**
 * ADOPT the pot owner's announced repoKey (A3 — federating the pin,
 * EI-18788176839043286). This is the rule that makes two devices actually AGREE
 * rather than agree by luck.
 *
 * Pinning alone (`pinRepoKey`) only froze each device's OWN derivation, which
 * makes a key stable but not shared: a pot created local-first pins the bare
 * `slug` on its creator, while a device joining after that pot is published to
 * GitHub derives — and pins — `gh-<id>`. Both sides are now permanently stable
 * and permanently DIFFERENT, which is the same silent total federation failure
 * as before, just frozen. The only way out is for one side to stop deriving:
 * the OWNER mints the key, every other device adopts it verbatim.
 *
 * Hence the precedence, which is deliberately NOT "first pin wins":
 *   1. An `announced` key from the owner ALWAYS wins — including over a key this
 *      device already pinned LOCALLY. A local pin is a guess; letting a guess
 *      outrank the owner's actual store name is exactly how a diverged pair gets
 *      cemented, and it would make the boot backfill (`pinRepoKeysForWorkspace`)
 *      actively harmful — it would freeze every already-diverged install the
 *      instant it ran.
 *   2. An existing `'peer'` pin is kept when nothing is announced, so losing the
 *      announce (offline, an older owner build) never regresses a device back to
 *      its own derivation.
 *   3. Otherwise fall back to `pinRepoKey` — an existing local pin, else today's
 *      derivation.
 *
 * Re-keying is not free: the bare store at the OLD key is left behind and the
 * repo cold-joins the peer under the new one. That is the CORRECT outcome (the
 * old store was, by construction, one nobody else was talking to) but the caller
 * should log `rekeyedFrom` — it is the single highest-signal line for anyone
 * debugging why a store suddenly changed path.
 */
export function adoptRepoKey(
  entry: RepoIdentityEntry,
  announcedKey: unknown,
): AdoptedRepoKey {
  const current = validPin(entry.pot_repo_key) ? entry.pot_repo_key : undefined;
  if (isValidRepoKey(announcedKey)) {
    return {
      key: announcedKey,
      source: 'peer',
      ...(current && current !== announcedKey ? { rekeyedFrom: current } : {}),
    };
  }
  if (current && entry.pot_repo_key_source === 'peer') {
    return { key: current, source: 'peer' };
  }
  return { key: pinRepoKey(entry), source: 'local' };
}

// ─── superseded stores (WI-6364, fix C) ──────────────────────────────────────

/**
 * The keys that name a store for `entry` but are NO LONGER what this device
 * writes under — its ABANDONED aliases.
 *
 * Re-keying is a documented, expected event ({@link adoptRepoKey}'s
 * `rekeyedFrom`, and `canonicalRepoKey`'s own account of the tower gaining a
 * `github_repository_id` on 2026-07-20). What was NOT accounted for is that the
 * bare store at the old key stays on disk and keeps ANSWERING fetches: the
 * serve path's only gate is "does this path have a HEAD", which an abandoned
 * store passes forever. A peer still pinned on the old key therefore gets a
 * real, internally-consistent pack from a store frozen at the moment of the
 * re-key, and every artifact on its side reports success. Live on the tower
 * 2026-07-27: `papercusp.git` (2.5 GB, every ref frozen at 2026-07-20) served
 * alongside the live `gh-1223568103.git` for seven days.
 *
 * WHY THE LADDER AND NOT "anything != canonical": one bare store per
 * `(potHomeSlug, repoKey)` means MANY unrelated repos legitimately live under
 * one pot (a member repo, `hive-canary`, …). Treating every non-canonical key
 * as abandoned would refuse all of them. A LOWER RUNG OF THIS ENTRY'S OWN
 * LADDER is exactly and only the set of names this entry itself once minted, so
 * the verdict is derived from the same code that produced the divergence.
 */
export function supersededRepoKeys(entry: RepoIdentityEntry): string[] {
  const canonical = canonicalRepoKey(entry);
  return repoKeyLadder(entry).filter((k) => k !== canonical && isValidRepoKey(k));
}

/** A requested repoKey identified as one entry's abandoned alias. */
export interface SupersededRepoKeyVerdict {
  /** The key the peer asked for — the abandoned one. */
  requested: string;
  /** The key that entry is keyed under NOW — what the peer should ask for. */
  canonical: string;
  /** The registry entry whose re-key stranded `requested` (diagnostics). */
  entrySlug: string;
}

/**
 * Decide whether `requestedKey` addresses a SUPERSEDED store, given every
 * registry entry served under one pot. Pure; the serve path's decision function.
 *
 * TWO GUARDS, both load-bearing:
 *  1. A key that is the CANONICAL key of ANY entry is never superseded — checked
 *     FIRST, across the whole set. Without it, one entry's abandoned alias could
 *     shadow another entry's live key (an adopted pin need not be on its own
 *     ladder, so the two sets are not disjoint by construction) and this fix
 *     would refuse a healthy fetch — strictly worse than the bug it closes.
 *  2. Only a lower rung of an entry's OWN ladder qualifies — see
 *     {@link supersededRepoKeys}.
 *
 * Returns null for "serve it" so the caller's default stays today's behavior.
 */
export function findSupersededRepoKey(
  requestedKey: string,
  entries: readonly RepoIdentityEntry[],
): SupersededRepoKeyVerdict | null {
  if (!isValidRepoKey(requestedKey)) return null;
  for (const entry of entries) {
    if (canonicalRepoKey(entry) === requestedKey) return null; // guard 1 — live key
  }
  for (const entry of entries) {
    if (supersededRepoKeys(entry).includes(requestedKey)) {
      return { requested: requestedKey, canonical: canonicalRepoKey(entry), entrySlug: entry.slug };
    }
  }
  return null;
}

/**
 * Refusal-reason prefix for a superseded-store request. The reason CARRIES THE
 * CANONICAL KEY, which is what makes this refusal self-healing rather than
 * merely loud: the requester adopts the key out of the refusal and its next
 * tick dials the store that is actually being written to. Rides the existing
 * `refuse` frame (a plain string), so it is a zero-wire-change addition — a
 * peer on an older build simply sees an unfamiliar refusal reason and retries,
 * which is strictly better than being served week-old bytes.
 */
export const SUPERSEDED_REPO_KEY_REFUSAL_PREFIX = 'superseded-repo-key:';

/** Build the refusal reason a server sends for {@link findSupersededRepoKey}. */
export function supersededRepoKeyRefusal(canonicalKey: string): string {
  return `${SUPERSEDED_REPO_KEY_REFUSAL_PREFIX}${canonicalKey}`;
}

/**
 * Recover the canonical key a peer named in its refusal, or null.
 *
 * Parses out of the FULL destroy-error text a requester actually holds
 * (`pot-git serve refused: superseded-repo-key:gh-123`), not just a bare
 * reason — that string is the only form the dialing side ever sees
 * (serve-wiring's `handleRefuse` destroys the duplex with it and
 * `runBootstrapLeg` reads `duplex.errored.message`). ALWAYS re-validates:
 * this value comes off the wire from another device and is about to become a
 * filesystem path component and a git ref component.
 */
export function parseSupersededRepoKeyRefusal(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  const at = message.indexOf(SUPERSEDED_REPO_KEY_REFUSAL_PREFIX);
  if (at < 0) return null;
  const key = message.slice(at + SUPERSEDED_REPO_KEY_REFUSAL_PREFIX.length).trim();
  return isValidRepoKey(key) ? key : null;
}
