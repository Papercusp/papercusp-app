/**
 * Which local git-sync install (slug) a hive-wide `pot-git:ref-announce`
 * fed-event row is addressed to.
 *
 * WHY THIS EXISTS (P-203 Leg A, live two-machine rig 2026-09-02): the
 * ref-announce plane is deliberately repoKey-INDEPENDENT (WI-6364 — a store
 * re-key must not break it) and is emitted once per hive
 * (`harness_slug = potHomeSlug`, `fed_event.key = REF_ANNOUNCE_EVENT_KEY`).
 * The signed payload carries `{ device, sigrefs_oid, version }` and NOTHING
 * that names the repo. That was sound while a hive held ONE repo. The tower's
 * papercusp hive holds the superproject PLUS ~40 submodule installs, every one
 * of them a git-sync slug reading the SAME event rows — so when the VM (which
 * mirrors only the superproject) announced `main@1313e36c v2181`, all 40
 * submodule slugs took it as their own, dialed the VM for their own repoKey
 * (`papercusp-libs-generic-rrf`, …) and were refused `no-such-repo`, 16 times
 * per 10 minutes, forever (the EI-15335 cursor holds below a failed row). The
 * same conflation fed the convergence probe: submodule slugs judged themselves
 * `local ABSENT < announced v2181` against a superproject announcement, and
 * the VM's superproject slug compared its counter against the max of 41
 * unrelated per-repo counters.
 *
 * The repair is an ENVELOPE tag, not a payload change: the publisher stamps
 * `fed_event.repo = <its install slug>` beside `key`/`payload`/`source`
 * (precedent: the staging-advance fed-event carries `repo_key` the same way),
 * and every reader routes on it through `refAnnounceTargetsRepo`. The signed
 * payload and its wire schema are untouched — a wrong or missing tag can only
 * misroute a dial or skip an announcement, never forge a snapshot, so it does
 * not belong under the signature.
 *
 * Untagged rows (an announcer running pre-fix code — the VM's pinned witness
 * build) are attributed to the pot's HOME repo only: that is the only repo a
 * single-repo announcer could have meant, and it is exactly the assignment
 * that stops the submodule fan-out. The tag is the install slug rather than
 * the repoKey on purpose (the plane must stay key-independent); the home
 * install's slug equals `potHomeSlug` on every member, which is what makes
 * the untagged fallback well-defined.
 */

export interface RefAnnounceRepoScope {
  /** This git-sync install's slug — `papercusp`, `papercusp/libs/generic/rrf`, … */
  slug: string;
  /** The pot's home slug — the hive the announcement was emitted into. */
  potHomeSlug: string;
}

/** The envelope field name. Exported so the publisher and the readers cannot drift. */
export const REF_ANNOUNCE_REPO_FIELD = 'repo';

/** Read the repo tag off a `fed_event` envelope; `null` when absent or malformed. */
export function refAnnounceRepoTag(fedEvent: unknown): string | null {
  if (!fedEvent || typeof fedEvent !== 'object') return null;
  const tag = (fedEvent as Record<string, unknown>)[REF_ANNOUNCE_REPO_FIELD];
  return typeof tag === 'string' && tag.length > 0 ? tag : null;
}

/**
 * Should the install described by `scope` act on this announcement row?
 *  - tagged ⇒ only the install whose slug matches the tag;
 *  - untagged ⇒ only the pot's home install (`slug === potHomeSlug`).
 */
export function refAnnounceTargetsRepo(fedEvent: unknown, scope: RefAnnounceRepoScope): boolean {
  const tag = refAnnounceRepoTag(fedEvent);
  if (tag === null) return scope.slug === scope.potHomeSlug;
  return tag === scope.slug;
}

/** The envelope fields a publisher stamps beside `key`/`payload`/`source`. */
export function refAnnounceRepoEnvelope(slug: string): { [REF_ANNOUNCE_REPO_FIELD]: string } {
  return { [REF_ANNOUNCE_REPO_FIELD]: slug };
}
