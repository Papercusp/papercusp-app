/**
 * The seed's table-exclusion POLICY, in a module with NO dependencies.
 *
 * ── WHY THIS IS ITS OWN FILE ──
 * Two very different layers need this list, and they must not be able to drift:
 *   • `seed-provider-corestore.ts` — the cut itself (mint + the shipped-suffix guard).
 *   • `boot.ts` — the LIVE operator, which is what actually appends the head snapshot a
 *     no-outage cut ships (it holds the corestore write lock, so the cutter cannot).
 * `boot.ts` imports `corestore` as a TYPE ONLY. Importing the seed provider just to
 * reach this constant would add a real runtime dependency on `corestore` +
 * `@papercusp/seed-bundle` to the substrate boot path — every desktop launch pays it —
 * and would invert the layering (boot ← seed provider). A dependency-free constants
 * module is the seam that lets both sides share ONE list.
 *
 * `seed-provider-corestore.ts` re-exports this, so existing importers and tests that
 * reach for `SEED_EXCLUDED_TABLES` there are unaffected.
 */

/**
 * Tables cut OUT of the shipped seed (EI-20108164746219771).
 *
 * `presence` is heartbeat state keyed `<github_user_id>/<machine_label>`, carrying the
 * build box's machine label into every published SERVER installer. It is RUNTIME state
 * re-announced on a keep-alive every `DEFAULT_REFRESH_MS` (30s — presence-announce.ts),
 * so dropping it costs a joiner at most one heartbeat of staleness.
 *
 * ⚠ That 30s keep-alive is the ENTIRE justification for filtering a table out of a
 * snapshot appended to the owner's LIVE log. Readers fold FORWARD from the newest
 * complete snapshot, so a row omitted from it is unreachable for anyone who seeds from
 * that snapshot — for `presence` that is a self-healing staleness window, but for a
 * table with real history it is silent DATA LOSS. Do not add a table here without
 * establishing that something regenerates its rows.
 *
 * ⚠ `usage` IS DELIBERATELY **NOT** HERE, and an earlier revision of this constant had
 * it — wrongly. The first census reported "usage=3 identity-bearing", but that probe
 * matched FIELD NAMES (a key literally called `device_pubkey`), not the owner's identity.
 * Re-measured against the release gate's OWN denylist, `usage` carries ZERO identity
 * values. It is also `contributor_usage_events`: an append-only, federated ledger that
 * is the source of truth for tier-C contributor stats. Excluding it would have discarded
 * 1517 legitimate ledger rows to remove nothing — and, per the paragraph above, would
 * have destroyed them in the owner's live log too.
 * ⚠ DELIBERATELY NOT `hive-members` (the membership ROSTER — required, owner-authorised)
 * and NOT `NEVER_RATE_LIMITED_TABLE_TAGS` (it also holds contributors / hive-members /
 * hive-settings, all of which the seed REQUIRES).
 *
 * ⛔ TABLE-LEVEL EXCLUSION IS NOT THE WHOLE FIX. The same corrected census found identity
 * inside two tables that CANNOT be dropped because they are required content:
 *   hive-members  → value paths `github_username`, `device_attestations[].device_label`
 *   hive-policy   → value path `policy_json`
 * Those need a field-level decision (scrub the device label; the owner's handle in the
 * roster is plausibly intended and owner-authorised), NOT another entry here. Tracked on
 * the item — do not "finish" this fix by widening this list.
 */
export const SEED_EXCLUDED_TABLES: readonly string[] = ['presence'];

/**
 * Tables whose own-log rows something REGENERATES on a short cadence, so a snapshot set
 * that left them out is still a complete seed for a fold that keeps them.
 *
 * `presence` is re-announced every `DEFAULT_REFRESH_MS` (30s, presence-announce.ts), and
 * the own log is single-writer, so its only presence rows are THIS machine's heartbeat.
 * A fold seeded from a presence-filtered set therefore regains every presence row within
 * one keep-alive of the tail it folds.
 *
 * WHY THIS EXISTS (WI-10002836, measured 2026-09-24 on the tower): every snapshot set on
 * the papercusp pot's own log was a release-cut head snapshot, and each excludes
 * `SEED_EXCLUDED_TABLES`. The unfiltered periodic compaction refused to seed from any of
 * them (`conflictingSnapshotExclusion`), so it folded all 7.76M ops from 0 — about 30
 * minutes, ending in an OOM recycle of bg-host at 99.5%. Readers already seed from these
 * same sets (they seed from the newest set, whatever it excluded).
 *
 * Every `SEED_EXCLUDED_TABLES` entry MUST be listed here (pinned by
 * seed-excluded-tables.test.ts): excluding a table from the live log is only safe when
 * its rows come back on their own, which is exactly what this set asserts.
 */
export const SELF_REGENERATING_TABLES: ReadonlySet<string> = new Set(['presence']);

/**
 * Tables whose rows are STRUCTURAL to the hive — the roster, the owner's signed policy
 * and settings, the epoch keys a joiner decrypts with, and the contributor ledgers. A row
 * dropped from one of these breaks the joiner outright (no owner in the roster, no epoch
 * key for the ciphertext it seeded), so an identity literal found inside such a row is
 * REDACTED IN PLACE (`[build-identity]` / `[email]`) and the row is kept.
 *
 * Every table NOT listed here is pot CONTENT (issues, features, plans, coordination…).
 * A content row whose VALUE carries a hunted owner-identity literal is dropped from the
 * public seed whole rather than redacted (p2p-public-release-endgame-2026-09-01 D-002,
 * EI-22086776666843792): the seed is an untrusted cache, and a dropped row replicates
 * normally after admission, whereas a redacted value is what the seeded joiner keeps.
 *
 * ⚠ Do NOT add a content table here to "keep more rows": that reintroduces the redact
 * path whose two blind spots (case, object keys) shipped the owner's name in build #5.
 */
export const SEED_REDACT_IN_PLACE_TABLES: ReadonlySet<string> = new Set([
  'hive-members',
  'hive-policy',
  'hive-settings-by-key',
  'hive-epoch-keys',
  'contributors',
  'usage',
]);
