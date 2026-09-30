/**
 * p2p-lane-fence.ts — the single, reusable source of truth for the p2p/federation/
 * rig title exclusion fence a single-box drain fleet's claim spec needs (WI-5268,
 * hardening the fix history from WI-5265/WI-5272).
 *
 * History: the `backlog-drain` fleet's claim spec has had this fence REGRESSED
 * TWICE by hand-edits that silently dropped the p2p/federation/rig excludes
 * (stripped at rev5, restored at rev6, regressed again at rev9, fixed again at
 * rev10). Nothing stopped a NEXT hand-edit from doing it a third time — the
 * fence lived only as ad hoc glob clauses typed directly into the spec JSON via
 * scheduler:set_claim_spec, with no shared source any two edits could diverge
 * from or agree with, and no test would fail if a future edit dropped a clause.
 *
 * This module is that shared source: `P2P_LANE_EXCLUSION_TERMS` names exactly
 * what a single-box fleet must exclude, and `buildP2pLaneFence()` composes it
 * into a `FilterNode` any TypeScript caller can splice into a `view.filter`
 * `all: [...]` list instead of re-typing per-term glob/word clauses by hand.
 * p2p-lane-fence.test.ts pins its CONTENT against representative
 * p2p/federation/rig-titled items, so a future edit that shrinks or drops a
 * term fails a test instead of silently leaking rig-only work to a single-box
 * fleet member who can't execute it (WI-5265's original incident).
 *
 * WI-6050: the ORIGINAL gap this history left open — a leader authoring a spec
 * over MCP (raw JSON, `scheduler:set_claim_spec`) cannot `import
 * buildP2pLaneFence()`, so the fence could still only ever be reached by
 * hand-retyping its terms, which regressed a THIRD time (rev9 leaked WI-5639).
 * `claim-spec.ts`'s `CLAIM_SPEC_FENCE_MACROS` registry now closes that: a spec
 * author sets `view:{ fence:"p2p-lane" }` and `validateClaimSpec` expands it
 * from THIS module's current `P2P_LANE_EXCLUSION_TERMS` at write time — a name
 * that cannot drift, instead of terms that could.
 *
 * Uses the `word` filter op (EI-18690730909662985), not `glob`: a whole-word
 * match avoids `glob`'s bare-substring false positive (e.g. a `*p2p*` glob
 * wrongly excluding a fleet literally named "nonp2p-bug-drain", whose own
 * title mentions its own name) and is already case-insensitive, so — unlike the
 * live rev10 spec's separate `*p2p*`/`*P2P*` glob pairs — one entry here covers
 * both cases.
 */
import type { FilterNode } from './claim-spec';

/**
 * The exact terms a single-box drain fleet's claim spec must exclude by TITLE —
 * cross-machine p2p/federation/rig-only work a single-box fleet member cannot
 * execute (per the owner directive that P2P/federation is deferred post-V1 for
 * release-readiness fleets). Whole-word matched (case-insensitive) via the
 * `word` filter op — see the module doc for why `word`, not `glob`.
 *
 * Mirrors the live `backlog-drain` fleet's rev10 title-glob terms
 * (`*p2p*`/`*P2P*`, `*hared-hive*`, `*federation*`/`*Federation*`,
 * `*holepunch*`, `*teering lease*`) collapsed to their case-insensitive
 * whole-word equivalents.
 */
export const P2P_LANE_EXCLUSION_TERMS = [
  // Core p2p / federation vocabulary.
  'p2p',
  'shared-hive',
  'federation',
  // EI-13285: the `word` op matches EXACT words, not stems — 'federation' never
  // matches the (very common in this pot's titles) inflected form "Federated".
  // Confirmed 2026-08-02 against the live backlog (`title ~* '\yfederated\y'`,
  // harness papercusp): every one of ~60 open/closed hits is genuine p2p/hive
  // federation-lane work (hive-membership federation, mem0 federation, feature/
  // work-item federation, replication liveness), none a homonym — so this is a
  // pure widening of the SAME p2p-federation term, not a new homonym risk (unlike
  // the rejected `rig`/`tower`/`announce`/`dial` anti-terms below). EI-13285
  // itself ("Federated issue ID collision replaced a newly captured local
  // improvement with an unrelated remote issue") leaked through this exact gap
  // into fleet nonp2p-bug-drain-0801's lane.
  'federated',
  // WI-7184: the VERB inflections. EI-13285 diagnosed this exact class ("the
  // `word` op matches EXACT words, not stems") and then stopped one inflection
  // short — so the same gap re-opened for "federate", and EI-19328707367010003
  // ("Remote work-offers FEDERATE with HOURS of latency", paths under
  // packages/operator-core/lib/p2p/) was served to single-box fleet
  // nonp2p-bug-drain-0801 on 2026-08-02. Measured against the live papercusp
  // backlog with the `word` op's own boundary semantics (`_` is a BOUNDARY, not
  // a word char — see the underscore test): 37 items carry federate/federates/
  // federating, 23 of them caught by NO existing term, and reading all 23 titles
  // there is not one homonym — seat-offer delegation, outbox drain, membership
  // teardown, cross-machine content writes, delegated-spawn receipts. "Federate"
  // has exactly one meaning in this pot.
  //
  // All three remaining inflections land together ON PURPOSE: federation +
  // federated + federate + federates + federating is EVERY English inflection of
  // this stem, so the stem is CLOSED here rather than extended a fourth time by
  // whoever meets the next one. A term family this unambiguous should never need
  // another incremental widening.
  'federate',
  'federates',
  'federating',
  'holepunch',
  'steering lease',
  // Replication subsystem. In this pot "replication" IS the p2p transport surface
  // (replication_soak, no_replicator, connected_never_replicated, the
  // [replication-liveness] EI stream) — not database replication.
  // WI-5639 leaked into fleet nonp2p-bug-drain-0725 purely because this term was
  // absent; it is the single highest-value entry in this list.
  'replication',
  // Named p2p stack components. These were live in nonp2p-bug-drain-0725's
  // hand-typed rev9 spec but were MISSING from this supposedly-canonical fence —
  // so importing the fence as it stood would have WIDENED the leak, not closed
  // it. Folded in here so the shared source is a true superset and the next
  // editor has nothing left to hand-type.
  'swarm',
  'hyperswarm',
  'hyperdht',
  'hyperbee',
  'dht',
  'udx',
  'relay',
  // The pot-git transport (WI-6995). `pot-git` IS the p2p git wire in this pot —
  // fetch/serve/dial planes, repoKey rendezvous, packfile transfer — so a
  // single-box member can execute none of it. Measured against the live papercusp
  // backlog on 2026-08-02: 13 open critical/major bugs in a drain fleet's lane that
  // NONE of the terms above already caught, and every one of them genuine p2p
  // transport work (WI-5163, WI-5168, WI-5210, WI-6364, WI-6415, EI-18745600910177355,
  // EI-18802104888674071, EI-18804225902691617, …). This was the single largest
  // remaining leak, the `replication`-shaped hole one layer down.
  'pot-git',
  // The ref-announce leg of that transport. Hyphenated and unambiguous; a bare
  // `announce` is deliberately NOT a term here — see the anti-terms note below.
  'ref-announce',
  // Zero live matches today, folded in because it is unambiguous p2p wire
  // vocabulary and costs nothing: the cheap half of "make the shared source a true
  // superset so the next editor has nothing left to hand-type".
  'duplex',
  // EI-19928699840338901 (fleet-lead-instrumentation-audit P-008): the SUBSTRATE
  // vocabulary under the transport terms above. `hypercore` is the sibling of
  // `hyperbee`/`hyperswarm`/`hyperdht` already here, and admitting the family
  // piecemeal is what left this gap. Measured 2026-08-09 against the live papercusp
  // backlog (open, issue-family, not already caught by a term above): hypercore 2
  // net-new. One of the two is a nit-severity Windows-build observation (EI-12901,
  // "the ~4GB seed is incompressible hypercore blocks so lzma64 grinds") rather than
  // hypercore work — recorded rather than hidden, because it is the one honest cost
  // of taking the library name. The other, WI-6076, is genuine wire work
  // (replicate()/protomux core pairing).
  'hypercore',
  // hyperblobs/hyperdrive/autobase have ZERO live matches — folded in on the
  // `duplex` precedent above: unambiguous named components of the same stack, so
  // they cost nothing today and close the family rather than leaving the next
  // editor to meet them one at a time.
  'hyperblobs',
  'hyperdrive',
  'autobase',
] as const;

/**
 * ANTI-TERMS — words that LOOK like they belong above and must stay out (WI-6995).
 *
 * `word` matching fixed `glob`'s substring false positives (EI-18690730909662985),
 * but it cannot fix a HOMONYM: a whole-word match on a term this pot also uses for
 * non-p2p things over-fences the general backlog, which the "does NOT exclude an
 * unrelated item" test exists to prevent. Each was proposed in good faith on
 * 2026-08-02 and measured against the live backlog before being rejected:
 *
 * - `rig` (17 net-new in-lane hits) — this pot calls MANY things a rig:
 *   `perf-regression-rig.test.ts` (EI-12796), desktop/rig build health (WI-6212),
 *   a Windows incident (EI-16182). The module doc above means the FEDERATION rig,
 *   and those titles already carry `federation`/`vm-federation`, so they are
 *   already fenced — adding `rig` buys nothing and costs three false exclusions.
 * - `tower` (10) — "tower" is this BOX. EI-18744086836082840 ("Tower load rising
 *   unbounded … on 112 cores, heavy-command admission rejecting agents") is about
 *   as on-lane as a single-box bug gets, and a `tower` term would hide it.
 * - `announce` (7) — bare, it catches publish-guard's secrets scan (WI-6254) and an
 *   identity-resolution presence failure (EI-18768167802573425). `ref-announce`
 *   above covers the p2p sense without the collateral.
 * - `dial` (5) — every live hit already carries `pot-git`, so it is redundant, and
 *   "dial" is ordinary enough English to be a homonym risk for no gain.
 * - `hive` (WI-7184) — the most tempting proposal on this list, and the one that
 *   would do the most damage. This pot runs a LOCAL coding hive as well as the
 *   federated shared-hive, and the word is load-bearing for both: EI-1443
 *   ("generic-hive bee completes + posts a completion but never calls
 *   work_items:complete") is a local bee-lifecycle bug, and WI-7154
 *   ("harness-scoped memories are systematically outranked by hive+user") is a
 *   mem0 recall-scope bug — both squarely executable on one box, both hidden by a
 *   bare `hive` term. `shared-hive` above already carries the federated sense.
 *   Measured while fixing WI-7184: of 9 in-lane critical/major hits for
 *   hive|seat|offer|delegated, 4 were non-p2p homonyms.
 *
 * EI-19928699840338901 proposed a SUBSTRATE tranche — corestore, seed cut / seed
 * cuts / sparse seed, bootstrap peer, peer — reporting "~10 p2p-substrate bugs inside
 * the non-p2p lane". Re-measured 2026-08-09 (fleet-lead-instrumentation-audit P-008,
 * which exists to re-verify carried findings rather than act on them): the count is
 * real, the CONCLUSION does not survive. Those terms catch predominantly single-box
 * work, because this repo BUNDLES a corestore seed into the desktop release — so the
 * storage vocabulary leads a second life in release engineering that `hyperbee`/
 * `hyperswarm`/`hyperdht` simply do not have. `hypercore` itself was accepted above;
 * the rest are rejected here:
 *
 * - `corestore` (13 net-new open) — the largest and most tempting. Its hits are
 *   overwhelmingly LOCAL: a git-tracked-blob history purge (WI-3065), a desktop
 *   bundle-size review (WI-5640), a single-process advisory lock on the own-log
 *   Corestore (WI-4236), and the local operator's fd-lock colliding with the release
 *   cut (EI-9796, EI-12625, EI-17145, EI-17165). Even the item's own motivating
 *   CRITICAL, EI-19899917753028359, is a LOCAL deadlock — bg-host holding the
 *   corestore write lock against a booted:false report on the same box. Fencing it
 *   would have hidden a critical the fleet could actually fix.
 * - `seed cut` / `seed cuts` / `sparse seed` (5 / 1 / 2) — the RELEASE pipeline, not
 *   the wire. WI-10773 is "take a real release seed cut and MEASURE the size drop";
 *   WI-36770 is bg-host self-recycling at an 11-12GB heap. Both are single-box.
 * - `peer` (10 net-new open bugs; 1 critical, 3 major) — the `hive` mistake with a
 *   bigger blast radius: "peer" is THE word this system uses for ANOTHER AGENT. Of
 *   the four critical/major hits, exactly ONE is p2p (EI-18769415639448677, admitting
 *   a peer on a hive topic); the other three are ordinary single-box bugs whose
 *   titles merely say "a peer's committed drop" (EI-19460048118267666), "a peer's
 *   verified fact" (EI-19478538852465365), "PEER agents' session turns" (WI-9592).
 *   3-of-4 false at critical/major is the worst ratio ever measured on this list.
 * - `replicate` / `replicates` — the tempting STEM-CLOSING fix, by exact analogy with
 *   federation→federated→federate. It does NOT transfer: unlike "federate", which has
 *   one meaning in this pot, "replicate" is a common debugging VERB here — "replicate
 *   the floor set", "the spike replicates 2/2 boots". `replication` (a noun that only
 *   ever names the transport) stays; its verb inflections do not. A pattern that held
 *   twice is not thereby a rule.
 *
 * A term belongs above only if a whole-word title match implies work a single-box
 * member CANNOT execute. If it merely CORRELATES with p2p, it belongs here instead.
 */
export const P2P_LANE_REJECTED_ANTI_TERMS = [
  'rig',
  'tower',
  'announce',
  'dial',
  'hive',
  'corestore',
  'seed cut',
  'seed cuts',
  'sparse seed',
  'peer',
  'replicate',
  'replicates',
] as const;

/**
 * Build the `not: { any: [...] } }` FilterNode excluding every
 * {@link P2P_LANE_EXCLUSION_TERMS} TITLE, SUMMARY, or source-PLAN match. Compose this into a
 * spec's `view.filter` `all: [...]` array alongside the kind/state/plan
 * clauses, instead of hand-typing a title/summary/plan glob/word exclusion per term
 * — that hand-typing is exactly the drift this module exists to stop.
 *
 * EI-20240035377782004: checks `summary` as well as `title` — title-ONLY was
 * the live scope leak. Fleet nonp2p-bug-drain-luna-max-0811's rev3 spec (built
 * from this function, title-only at the time) admitted EI-20239498607103954,
 * whose TITLE is generic but whose SUMMARY explicitly says "accepted P-205 Mac
 * peer", "federation drills", "vm-rig MCP parity" — a P2P item a single-box
 * fleet member cannot execute, let straight through because the fence never
 * looked at the field carrying the tell. Every term now excludes on EITHER
 * field matching (an `any` of `any`s, flattened into one list so the overall
 * shape stays `not: { any: [...] } }`), so a term hit in EITHER field excludes
 * the item — never a false admission just because the leak happened to be
 * worded into summary instead of title.
 *
 * WI-5280: source-plan provenance is the structural third leg. A P2P plan can
 * deliberately use neutral item titles and summaries (the live recurrence was
 * four consecutive F2/F4/F5/F6 items from
 * `p2p-public-release-endgame-2026-09-01`), so content-only matching cannot
 * describe a non-P2P lane. The claim-spec `plan` field resolves the indexed
 * `source_plan_slug` plus its legacy payload fallbacks in both evaluators. Apply
 * the same whole-word terms there: `p2p-public-*` is excluded, while
 * `nonp2p-*` remains admitted because `word` requires an alphanumeric boundary.
 */
export function buildP2pLaneFence(): FilterNode {
  return {
    not: {
      any: P2P_LANE_EXCLUSION_TERMS.flatMap((value) => [
        { field: 'title', op: 'word', value } as const,
        { field: 'summary', op: 'word', value } as const,
        { field: 'plan', op: 'word', value } as const,
      ]),
    },
  };
}

/**
 * Structured-plan-only variant for a lane that already owns its title rules and
 * cannot safely treat every keyword in an issue summary as a P2P classification.
 * It reuses the same shared term source, but matches only the resolved `plan`
 * field (indexed source_plan_slug or its supported payload fallback).
 */
export function buildP2pPlanLaneFence(): FilterNode {
  return {
    not: {
      any: P2P_LANE_EXCLUSION_TERMS.map((value) => ({ field: 'plan', op: 'word', value }) as const),
    },
  };
}
