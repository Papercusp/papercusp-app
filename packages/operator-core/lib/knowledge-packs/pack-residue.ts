/**
 * pack-residue — the ONE rule for "this text is not fit to ship in a knowledge
 * pack" (memory-corpus-hygiene P-006 / D-017).
 *
 * WHY THIS EXISTS SEPARATELY FROM THE RELEASE-BUNDLE AUDIT
 *
 * `papercusp-desktop/bin/audit-release-bundle.py` already scans the cut for
 * identity — but its rule is BUILD-BOX identity: the unix user, hostname and
 * git identity of the machine doing the build, resolved at run time. That is a
 * different hazard from the one here. A knowledge-pack item is authored by the
 * FLEET, out of our own ledger, so the residue it carries is internal
 * REFERENCES — work-item ids, `harness:<slug>` scope literals, recurrence
 * signature hashes. None of those are machine identity, so the release audit
 * passes them through, and they land on a fresh install as dangling pointers
 * into a ledger the reader has never seen.
 *
 * Measured 2026-08-03: all three items in the live `fleet-lessons` pack carried
 * a provenance footer naming EI-8288 / EI-9411 / harness:@singleton /
 * harness:papercusp-workspace plus a 12-hex signature — and the release audit
 * did not flag any of it, because none of it is this box's identity.
 *
 * The producing path was fixed at source (renderCandidateLearningFile no longer
 * renders any of it). This module is the RECURRENCE GUARD for the class: it is
 * asserted over the committed builtin packs by pack-residue.test.ts, and the
 * fleet-lessons exporter refuses to export a pack that trips it. One rule, two
 * call sites — never a second copy that can drift (the same one-rule discipline
 * audit-release-bundle.py applies to its tar-excludes / identity-literals).
 *
 * DELIBERATELY NARROW. Each rule below is a class we have actually observed
 * shipping, with a falsifiable pattern. This is not a general prose linter, and
 * it must stay cheap enough to run over every pack item on every test run.
 */

// The identity half of the admission gate reuses the ONE shared identity-leak
// detector rather than carrying its own matcher — see the "Box identity" section
// below for why a second copy is the bug this import exists to avoid.
import {
  findBoxIdentityPaths,
  findIdentityLiterals,
  findOwnerNameLeaks,
  resolveIdentityLiterals,
} from '../../../../scripts/lib/identity-leak-patterns.mjs';

export interface PackResidueRule {
  /** Stable id — what the failure is called when it fires. */
  id: string;
  /** The pattern. Global + multiline so every occurrence is reported. */
  pattern: RegExp;
  /** Why this must not ship, phrased for whoever just tripped it. */
  why: string;
}

/**
 * NOTE on the hex rule's width: a recurrence signature is a 12-hex digest
 * (e.g. `5741efa1c7dd`). The bound is `{12,}` rather than `{7,}` so ordinary
 * prose — and a legitimate lesson that quotes a short git sha — does not trip
 * it. A shipped pack item has no business quoting a 12+ hex digest at all.
 */
export const PACK_RESIDUE_RULES: readonly PackResidueRule[] = [
  {
    id: 'ledger-id',
    pattern: /\b(?:EI|WI)-\d+\b/g,
    why:
      'internal work-item ids are dangling references on any install but ours — ' +
      'the reader cannot resolve them, so they are noise that looks like a citation',
  },
  {
    id: 'scope-literal',
    pattern: /\bharness:[A-Za-z0-9@._-]+/g,
    why:
      'a `harness:<slug>` scope literal names OUR boxes/workspaces — ' +
      'it is meaningless to a stranger and leaks our topology',
  },
  {
    id: 'session-id',
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    why:
      'an agent-session / run UUID names one ephemeral process on OUR fleet — ' +
      'D-008 lists agent-session ids as tier-3 THIS-BOX, and it is unresolvable off-box',
  },
  {
    // WI-8482 / P-008. The class-3 identity leg hunts THIS box's literals
    // (hostname, git identity), so a remote-access target for a DIFFERENT
    // machine — the mac rig, a qemu VM — was never in its sights and shipped
    // clean. Measured over the organic corpus: the gate admitted rows carrying
    // `ssh <owner>@<ip>` verbatim, which is the first class D-005 names and
    // which D-008 restates as tier-3 ("credentials/access topology").
    id: 'access-topology',
    pattern:
      /(?:\b(?:ssh|scp|rsync|sftp)\s+[^\n]{0,40}?[A-Za-z0-9._-]+@[A-Za-z0-9._-]+)|(?:\b[A-Za-z0-9._-]+@(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?)/g,
    why:
      'a remote-access target (ssh/scp/rsync host, user@ip) is credentials-and-' +
      'access topology — D-005 keeps it never-distributable and D-008 lists it ' +
      'as tier-3 THIS-BOX; shipping it publishes how to reach our machines',
  },
  {
    id: 'signature-hash',
    pattern: /\b[0-9a-f]{12,}\b/g,
    why:
      'a recurrence signature digest is an internal grouping key — ' +
      'it carries no transferable meaning and cannot be looked up off-fleet',
  },
] as const;

export interface PackResidueHit {
  /** Which rule fired. */
  rule: string;
  /** The offending text, verbatim. */
  match: string;
  /** Why it must not ship (from the rule). */
  why: string;
}

/**
 * Every residue occurrence in `text`, in rule order. Empty array = fit to ship.
 *
 * Returns the offending SUBSTRINGS, not just a boolean, so a caller can name
 * exactly what tripped — a bare "this pack has residue" is the kind of finding
 * that gets worked around instead of fixed.
 *
 * OVERLAP SUPPRESSION: rules are ordered most-specific-first, and a span already
 * claimed by an earlier rule is not re-reported by a later one. Without this, a
 * session UUID reports TWICE — once correctly as `session-id`, and again as
 * `signature-hash`, because a UUID's final group is exactly 12 hex characters.
 * A refusal message that names one offending string under two different rules
 * (with two different `why`s, one of them wrong) is precisely the kind of noisy
 * finding that gets the gate switched off instead of the item fixed.
 */
export function findPackResidue(text: string): PackResidueHit[] {
  const hits: PackResidueHit[] = [];
  const claimed: Array<[number, number]> = [];
  for (const rule of PACK_RESIDUE_RULES) {
    // Fresh lastIndex per call: the module-level regexes are /g and stateful.
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (claimed.some(([s, e]) => start < e && end > s)) continue;
      claimed.push([start, end]);
      hits.push({ rule: rule.id, match: m[0], why: rule.why });
    }
  }
  return hits;
}

/* ────────────────────────────────────────────────────────────────────────
 * Box identity — REUSED from the shared detector, never a second matcher
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * P-009 requires the identity half of this gate to reuse the release gate's rule
 * as the single source of truth, "never a second hand-kept list". That detector
 * already exists and is already shared: `scripts/lib/identity-leak-patterns.mjs`
 * is a 1:1 port of `audit-release-bundle.py`'s `identity_literals()` /
 * `needs_word_boundary()` / `is_vendor()`, imported by all three gate lints, by
 * the edit-time advisory hook, and by the prose-corpus redactor. Its header is
 * explicit that another copy is the bug ("the two MUST agree or it's a
 * false-green"), so this module imports those matchers rather than
 * reimplementing them — an earlier draft of THIS file reimplemented the literal
 * matcher, which was exactly the mistake the header warns about.
 *
 * Three of that module's classes map onto D-008's tier-3 THIS-BOX list:
 *
 *   D-008 tier-3 term        class    matcher                needs entries?
 *   absolute paths           2        findBoxIdentityPaths    no (shape-based)
 *   hostnames, git identity  3        findIdentityLiterals    YES (this box's values)
 *   (named owner provenance) 1        findOwnerNameLeaks      no
 *
 * Class 2 being SHAPE-based matters here beyond the shipped-source case it was
 * written for: a fleet lesson can cite a VM's or a peer's absolute path, which
 * is tier-3 residue that no list of THIS box's literals could ever catch.
 *
 * Everything here stays PURE — `findIdentityLiterals` takes the resolved entries
 * as a parameter, so the impure `resolveIdentityLiterals()` (it shells out to
 * `git config`) is the CALLER's job, resolved once and cached.
 *
 * (The import itself sits at the top of the file; this is its rationale.)
 */

/**
 * `Object.entries(resolveIdentityLiterals())` — this box's identity as
 * `[key, value]` pairs. Empty on a CI/bare box with no resolvable git identity,
 * which degrades the class-3 leg to a no-op exactly as the release gate does.
 */
export type IdentityEntries = readonly (readonly [string, string])[];

/** Cached: `resolveIdentityLiterals()` shells out to `git config`, and the
 *  admission gate runs once per pack ITEM. */
let cachedIdentityEntries: IdentityEntries | undefined;

/**
 * This box's identity entries for the class-3 leg, resolved once per process.
 *
 * The ONE impure function in this module — kept here, beside the gate, so all
 * three call sites share one resolution rather than each growing its own. The
 * matchers stay parameterised so tests can pass SYNTHETIC entries: this file is
 * tracked source scanned by the very lints it reuses, so a fixture must never
 * spell a real box identity.
 *
 * Returns `[]` on a bare/CI box with no resolvable identity — the same
 * documented no-op the release gate and the three lints degrade to. That is why
 * the verdict reports `identityLiteralsScanned` separately: "nothing to hunt"
 * and "found nothing" must not read alike.
 */
export function resolvePackIdentityEntries(): IdentityEntries {
  if (cachedIdentityEntries) return cachedIdentityEntries;
  try {
    cachedIdentityEntries = Object.entries(resolveIdentityLiterals()) as IdentityEntries;
  } catch {
    cachedIdentityEntries = [];
  }
  return cachedIdentityEntries;
}

/**
 * Tier-3 identity residue in `text`, via the shared detector.
 *
 * `match` names the CLASS (the identity key, a truncated user segment) and never
 * the raw literal: this text lands in logs, coord messages and test failures, so
 * echoing the hostname we just refused would re-leak precisely what we caught.
 */
export function findIdentityResidue(
  text: string,
  identityEntries?: IdentityEntries,
): PackResidueHit[] {
  const hits: PackResidueHit[] = [];

  for (const f of findBoxIdentityPaths(text)) {
    hits.push({
      rule: 'box-identity-path',
      match: `/home/<${f.user.slice(0, 2)}…>`,
      why:
        "an absolute home path names one machine's filesystem layout — D-008 lists " +
        'absolute paths as tier-3 THIS-BOX, excluded from everything we ship',
    });
  }

  for (const f of findOwnerNameLeaks(text)) {
    hits.push({
      rule: 'owner-name',
      match: '<owner-name>',
      why:
        "a NAMED owner-provenance tag ships a real person's name to a stranger — " +
        'cite the tier and the date, never the person (the named form is correct ' +
        'only on internal carry surfaces, which a pack is not)',
    });
  }

  if (identityEntries && identityEntries.length > 0) {
    for (const f of findIdentityLiterals(text, identityEntries as [string, string][])) {
      hits.push({
        rule: 'box-identity',
        match: `<${f.key}>`,
        why:
          `this text carries THIS BOX's ${f.key} literal — D-008 excludes tier-3 ` +
          'THIS-BOX content (hostnames, absolute paths, VM aliases, agent-session ' +
          'ids, credentials) from anything we ship',
      });
    }
  }

  return hits;
}

/* ────────────────────────────────────────────────────────────────────────
 * Shape floor — is this even a lesson?
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Minimum body length for a shippable pack item.
 *
 * The number is P-001's own shape taxonomy: fragment <60 / fact 60–300 /
 * longform 300+. A pack item must be at least a FACT — below that there is not
 * room for a claim plus the context that makes it transferable.
 *
 * ⚠ READ THIS BEFORE CITING THE FRAGMENT CLASS: D-013 disproved the
 * "sub-60-char rows are extraction debris" premise for `memory_canonical` —
 * those rows are mem0 GRAPH ENTITY NODES working as designed, which is why
 * P-003 (the reversible purge) was DROPPED as unsafe. This floor is NOT that
 * purge and must never be pointed at the corpus. It applies to a different
 * population: a curated pack BODY, distilled by `candidate-review` from a
 * recurring lesson, which is never an entity node. Its job is to catch a
 * DEGENERATE distillation — a stub or truncated draft — before it ships, which
 * is a quality floor, not a residue rule.
 */
export const PACK_ITEM_MIN_TEXT_CHARS = 60;

/**
 * Learning kinds that must not ship in a public pack.
 *
 * `user` is a fact about OUR owner (their preferences, their habits, their
 * name) — asserting it into a stranger's memory store is wrong regardless of
 * how transferable the sentence looks, and it is the one kind whose whole
 * purpose is to be person-specific.
 *
 * Deliberately NOT excluded: `project` and `reference`. Under D-008 (owner,
 * verbatim: "ship dev-infra too") the shipping rule is TWO tiers — tier 1
 * PRODUCT and tier 2 DEV-INFRASTRUCTURE both ship, and only tier 3 THIS-BOX is
 * held back. Excluding a kind because it looks like dev-infra would contradict
 * a ratified owner decision, so kind is not used as a tier discriminator here.
 */
export const PACK_INADMISSIBLE_KINDS: readonly string[] = ['user'];

/** Shape faults in a candidate pack item. Empty array = well-shaped. */
export function findPackShapeFaults(item: {
  title: string;
  text: string;
  kind?: string;
}): PackResidueHit[] {
  const hits: PackResidueHit[] = [];
  const body = item.text.trim();
  if (body.length < PACK_ITEM_MIN_TEXT_CHARS) {
    hits.push({
      rule: 'below-length-floor',
      match: `${body.length} chars`,
      why:
        `a shippable pack item needs at least ${PACK_ITEM_MIN_TEXT_CHARS} characters of body ` +
        "(P-001's fact threshold) — shorter than that is a stub or a truncated " +
        'distillation, with no room for the context that makes a lesson transferable',
    });
  }
  if (!item.title.trim()) {
    hits.push({
      rule: 'missing-title',
      match: '(empty)',
      why: 'the title is prefixed onto the seeded memory text — an empty one ships a headless row',
    });
  }
  if (item.kind && PACK_INADMISSIBLE_KINDS.includes(item.kind)) {
    hits.push({
      rule: 'inadmissible-kind',
      match: item.kind,
      why:
        `kind '${item.kind}' is a fact about OUR owner, not transferable knowledge — ` +
        "it must not be asserted into a stranger's memory store",
    });
  }
  return hits;
}

/* ────────────────────────────────────────────────────────────────────────
 * The gate
 * ──────────────────────────────────────────────────────────────────────── */

export interface PackAdmissionOpts {
  /**
   * This box's identity entries (`Object.entries(resolveIdentityLiterals())`).
   *
   * OMITTED ⇒ the class-3 leg (hostname / git identity) DOES NOT RUN, and the
   * caller is told so via `identityLiteralsScanned: false`. It is deliberately
   * not optional-and-silent: a scan that quietly did nothing is
   * indistinguishable from one that found nothing, which is the shape of every
   * false-green documented in this repo.
   *
   * The shape-based legs (absolute paths, named owner tags) ALWAYS run — they
   * need no per-box values.
   */
  identityEntries?: IdentityEntries;
}

export interface PackAdmissionVerdict {
  /** True ⇒ fit to ship. */
  ok: boolean;
  /** Every reason it is not, across every leg. */
  hits: PackResidueHit[];
  /**
   * Did the class-3 (this-box literal) leg actually run? A `false` here weakens
   * an `ok: true` — the shape legs still ran, but the hostname/git-identity
   * literals were never hunted.
   */
  identityLiteralsScanned: boolean;
}

/**
 * THE pack-admission gate (P-009): shape floor + box-identity scan +
 * dangling-ledger-id/scope/session residue, over one candidate pack item.
 *
 * One rule, every call site — the curation loop's `materializeCandidateIntoPack`
 * (so nothing enters a pack ungated), the `gen:fleet-lessons` exporter, and the
 * assertion over the committed builtin packs. Never a second copy that can
 * drift, which is the same one-rule discipline `audit-release-bundle.py`
 * applies to its own tar-excludes and identity literals.
 */
export function checkPackAdmission(
  item: { title: string; text: string; kind?: string },
  opts: PackAdmissionOpts = {},
): PackAdmissionVerdict {
  // The TITLE is scanned too: it is prefixed onto the seeded memory text
  // (memoryTextOf), so residue there ships just as surely as residue in the body.
  const hits = [
    ...findPackShapeFaults(item),
    ...findShippableTextFaults(`${item.title}\n${item.text}`, opts),
  ];
  return { ok: hits.length === 0, hits, identityLiteralsScanned: identityScanRan(opts) };
}

/** Did the class-3 leg have anything to hunt with? */
function identityScanRan(opts: PackAdmissionOpts): boolean {
  return opts.identityEntries !== undefined && opts.identityEntries.length > 0;
}

/**
 * The TEXT-level legs of the gate — residue + tier-3 identity, without the
 * item-shape floor.
 *
 * Exists because two callers hold different granularities of the same artifact.
 * `checkPackAdmission` has a PARSED item, so it can also apply the shape floor.
 * The `gen:fleet-lessons` exporter holds the RAW pack FILE (frontmatter and
 * all), where a shape floor would be meaningless — an empty `title` argument
 * would trip `missing-title` on every file, and the "body" it measures would
 * include the frontmatter. Scanning the raw file is not a downgrade, though: it
 * is strictly WIDER for the residue/identity classes, because it also covers the
 * frontmatter, which is shipped text that no parsed-item view exposes.
 */
export function findShippableTextFaults(
  text: string,
  opts: PackAdmissionOpts = {},
): PackResidueHit[] {
  return [...findPackResidue(text), ...findIdentityResidue(text, opts.identityEntries)];
}

/** One-line-per-hit rendering for a CLI refusal or a test failure message. */
export function formatPackResidue(hits: readonly PackResidueHit[]): string {
  return hits.map((h) => `  [${h.rule}] ${JSON.stringify(h.match)} — ${h.why}`).join('\n');
}
