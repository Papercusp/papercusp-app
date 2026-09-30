/**
 * Keep THIS BOX's identity out of anything we publish. (WI-4446; the TS sibling
 * of `papercusp-desktop/bin/audit-release-bundle.py`, which does the same job for
 * the installer bundle.)
 *
 * [owner 2026-07-12] "same as #2 but for personal information like my name is owner
 *  on this machine, we dont want that included in our public release builds."
 *
 * WHY THE RELEASE-HISTORY PAGE NEEDS THIS AT ALL — it was NOT obvious:
 * The page's content comes from our own Postgres, so it feels internal and safe.
 * It is not. Work-item titles and plan bodies are written BY AGENTS, ON THIS BOX,
 * and they are full of it:
 *
 *   • a work-item title quoting a command:  "Run `bash /home/<user>/.papercusp/…`"
 *   • a plan's decision log:                "D-001 [owner:<FirstName> 2026-07-11] …"
 *
 * The first generated page carried the owner's home path AND his first name,
 * straight to the beta testers the page exists for. That is precisely the leak the
 * owner asked us to prevent — arriving through the door nobody was watching,
 * because the PII gate guards the INSTALLER and this is a web page.
 *
 * ⛔ NOTHING HERE IS HARDCODED. The literals are resolved from the machine at run
 * time (unix user, home path, hostname, git identity) — writing the owner's actual
 * name into a source file to search for it would BE the leak, committed to git
 * forever. Same reasoning, same resolution, as the Python gate's identity_literals().
 */

import { execFileSync } from 'node:child_process';
import * as os from 'node:os';

export interface IdentityLiteral {
  /** What it is — used in the redaction placeholder and in gate output. */
  kind: 'user' | 'home' | 'hostname' | 'git-name' | 'git-email';
  value: string;
}

/**
 * ⚠ THE ENUMERATED LITERALS ABOVE ARE ONLY THE IDENTITIES WE ALREADY KNEW ABOUT.
 * The leak is always the one we did not enumerate — proven, on the real page:
 *
 * The scrub resolved the box's git email (`user.email`) and redacted it faithfully.
 * But the plans' YAML frontmatter carries `owner: <a DIFFERENT personal address>` —
 * two more of the owner's real email addresses, neither of which is this box's git
 * identity, so neither literal existed and both sailed onto pages bound for beta
 * testers. Enumerating harder would not have helped: there is no list of every
 * address a human has ever used.
 *
 * So the scrub gates on the SHAPE of an identity, not only on known values. An
 * email address is PII whoever it belongs to; `/home/<anyone>` reveals the box
 * whoever the user is. These run AFTER the enumerated literals (which are more
 * specific and produce better placeholders), and — this is the point — they are
 * checked by the GATE too, so an unknown identity fails the publish instead of
 * shipping.
 */
export interface IdentityPattern {
  kind: 'email' | 'unix-home' | 'mac-home' | 'windows-home';
  pattern: RegExp;
  placeholder: string;
}

/**
 * The ONE address we deliberately PUBLISH — the owner's contact link on the
 * holding page [owner 2026-07-28: "include a mailto email link to <his gmail>"].
 *
 * ⚠ READ THIS BEFORE REUSING IT. Everything above exists because this exact
 * address leaked onto this exact page once already — `findIdentityLeaks`' own
 * comment notes that a weaker gate "would have called the page with the owner's
 * gmail address on it CLEAN". So publishing it is a deliberate REVERSAL of that
 * rule, and it is deliberately hard to widen:
 *
 *   - It is opt-IN per render (`ScrubOptions.allowEmails`), never global. The
 *     normal release pages pass nothing, so a plan body that happens to carry
 *     this same address is STILL scrubbed and STILL fails the gate — which is
 *     the actual leak we were burned by (plan frontmatter `owner:`).
 *   - Every OTHER address stays fully scrubbed and gate-failing, unchanged.
 *
 * Do NOT turn this into a list of "our" addresses, and do NOT hoist it into a
 * default. The value of the rail is that the allowance is one literal, in one
 * place, on one page.
 */
export const PUBLISHED_CONTACT_EMAIL = 'ownerhandle@gmail.com';

/**
 * Marks a page as the deliberately-minimal holding page. Emitted into the
 * holding page's <head>; the publish gate keys its email allowance off THIS,
 * so the allowance cannot silently apply to a normal release page.
 */
export const HOLDING_PAGE_MARKER = '<meta name="papercusp-page-mode" content="holding">';

export interface ScrubOptions {
  /**
   * Addresses to leave INTACT (exact match). Opt-in per render — see
   * PUBLISHED_CONTACT_EMAIL. Anything not listed is scrubbed as before.
   */
  allowEmails?: readonly string[];
}

/**
 * Hide the allowed addresses behind a sentinel so neither the enumerated
 * literals nor the shape patterns can touch them, then restore afterwards.
 *
 * Masking FIRST (before the literals) is what makes this correct when the
 * allowed address is ALSO this box's git identity: the literal pass would
 * otherwise replace it with `[email]` before the shape pass ever ran.
 *
 * The sentinel uses control characters precisely because they cannot occur in
 * an email, a path, or sane HTML — so it can never be produced by, or collide
 * with, the content being scrubbed.
 */
function maskAllowed(text: string, allow: readonly string[]): { masked: string; restore: (s: string) => string } {
  const used: string[] = [];
  let masked = text;
  allow.forEach((addr) => {
    if (!addr) return;
    const token = `\x00PC-ALLOWED-${used.length}\x00`;
    const next = masked.split(addr).join(token);
    if (next !== masked) {
      used.push(addr);
      masked = next;
    }
  });
  return {
    masked,
    restore: (s: string) => used.reduce((acc, addr, i) => acc.split(`\x00PC-ALLOWED-${i}\x00`).join(addr), s),
  };
}

export const IDENTITY_PATTERNS: IdentityPattern[] = [
  // Any email address, not just this box's. Over-redacting a doc's `you@example.com`
  // costs nothing; under-redacting the owner's inbox costs him the thing he asked
  // us to prevent.
  //
  // ⚠ The quantifiers are BOUNDED to RFC maxima (local ≤64, domain ≤255, TLD ≤24)
  // ON PURPOSE — do NOT relax them back to `+`. The unbounded form
  // (`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`) backtracks catastrophically:
  // its overlapping classes make matching O(n²)+ on a long email-ish run with no
  // valid match (a base64 data-URI, a big plan body), and scrubIdentity runs it over
  // EVERY release page. That single regex was 40s of a 45s `record-release-cli`
  // page-regen — the "why does regenerating a simple page take 45s" bug. Bounding the
  // repeats caps per-start-position backtracking to a constant, so it is linear again.
  { kind: 'email', pattern: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g, placeholder: '[email]' },
  // Someone's home directory — ours is an enumerated literal and is redacted first;
  // these catch a path belonging to a VM, a build box, or another human entirely.
  { kind: 'unix-home', pattern: /\/home\/[A-Za-z0-9._-]+/g, placeholder: '~' },
  { kind: 'mac-home', pattern: /\/Users\/[A-Za-z0-9._-]+/g, placeholder: '~' },
  { kind: 'windows-home', pattern: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g, placeholder: '~' },
];

/** Generic values that are not anybody's identity — matching them would redact
 *  half the page and teach the next person to switch the gate off. */
const GENERIC_USERS = new Set(['root', 'runner', 'build', 'ubuntu', 'user', 'admin']);
const GENERIC_HOMES = new Set(['/root', '/', '/home']);

/**
 * Git identities belonging to AUTOMATION rather than to a human owner.
 *
 * The owner-name literal is resolved from `git config user.name` — a setting an
 * unrelated automation is free to change. When git-sync began committing under a
 * stable bot identity, `user.name` stopped being the owner's name; and because the
 * GATE derives from these same literals, the scrub and its proof went blind to the
 * highest-cost leak class *at the same instant*, with nothing failing loudly.
 *
 * Measured when it was caught (EI-20583328178472869): the live published page
 * carried 707 `[owner]` redactions and 0 raw names, while a fresh regen of the same
 * content carried 2 and 38 — 444 files across the site holding the owner's bare
 * first name — and `gate-release-site` still printed CLEAN, exit 0.
 *
 * Redacting a bot's name accomplishes nothing, so these are excluded. Excluding
 * them is also what lets `hasOwnerNameLiteral()` below distinguish "there is
 * nothing to hide here" from "I no longer know who the owner is" — two states this
 * module previously could not tell apart, and which must not share a verdict.
 * Same shape as GENERIC_USERS above.
 */
const AUTOMATION_NAME_RE =
  /(^|[-_ ])(agent|bot|ci|runner|automation|service|actions|daemon|noreply)([-_ ]|$)|\[bot\]/i;

/** True when a git identity is a machine's, not a person's. */
export function looksLikeAutomationIdentity(value: string): boolean {
  return AUTOMATION_NAME_RE.test(value.trim());
}

/**
 * An explicit owner name for this publish, for when the box's git identity is not
 * the owner's (a bot identity, a CI runner, a container).
 *
 * Read from the environment AT RUN TIME and never stored — the same rule that
 * governs everything else here: writing the owner's actual name into a source file
 * to search for it would BE the leak, committed to git forever.
 */
export const OWNER_NAME_ENV = 'PAPERCUSP_RELEASE_OWNER_NAME';

/**
 * Can this literal set actually detect the owner's NAME?
 *
 * The name is the one identity class with no shape to fall back on. An email or a
 * home path is still caught by IDENTITY_PATTERNS even when no literal knows it — a
 * bare first name is only ever a literal. So when no owner-name literal resolves,
 * the scrub cannot redact the name and the gate cannot see it, and a "CLEAN"
 * verdict degrades to "I looked for nothing" while still reading as proof.
 *
 * Callers that publish MUST fail closed on `false`.
 */
export function hasOwnerNameLiteral(literals: IdentityLiteral[]): boolean {
  return literals.some((l) => l.kind === 'git-name' && l.value.trim() !== '');
}

/**
 * A SHORT literal must match as a whole word or it matches half the page.
 *
 * The owner's git user.name on this box is a 3-letter first name — the exact thing
 * he asked us to keep out. A length floor would silently make his own example the
 * one identity we could never catch. Substring-matching it instead would fire on
 * every innocent occurrence inside ordinary words. So: short literals match on a
 * word boundary, case-sensitively.
 */
export function needsWordBoundary(value: string): boolean {
  return value.length < 6 && /^[a-zA-Z0-9]+$/.test(value);
}

/**
 * Always CASE-INSENSITIVE — and this is a deliberate divergence from the Python
 * bundle gate, which matches a short name case-SENSITIVELY.
 *
 * That gate is scanning vendored source, where a case-insensitive 3-letter name
 * collides with real things (`video.owner`, an `owner` codec constant), and a gate
 * that cries wolf on node_modules gets switched off. This scrub runs on a PAGE WE
 * HAND TO BETA TESTERS, where the trade-off inverts: the cost of a false positive
 * is one over-redacted word that nobody misses; the cost of a false negative is
 * the owner's name in front of strangers.
 *
 * The real page proved it. Case-sensitive matching sailed past BOTH of these:
 *     "…verbatim in assembly/<NAME>-NOTES-DRAFT-3-REVIEW.md"   ← upper-cased
 *     "host <name>-dev pid 33417"                              ← lower-cased, hyphenated
 * Same name, different case, still him. The word boundary keeps it honest (it will
 * not fire inside a longer word), and the hyphen in `<name>-dev` IS a boundary, so
 * that one now redacts too.
 */
export function literalPattern(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return needsWordBoundary(value)
    ? new RegExp(`\\b${escaped}\\b`, 'gi')
    : new RegExp(escaped, 'gi');
}

/** This machine's identity, as literal strings. Resolved from the box, never stored. */
export function identityLiterals(): IdentityLiteral[] {
  const lits: IdentityLiteral[] = [];

  try {
    const user = os.userInfo().username;
    if (user && !GENERIC_USERS.has(user)) lits.push({ kind: 'user', value: user });
  } catch {
    /* no unix user (container) — nothing to hide */
  }

  const home = os.homedir();
  if (home && !GENERIC_HOMES.has(home)) lits.push({ kind: 'home', value: home });

  const host = os.hostname();
  if (host && !/^(runner|ci-|localhost)/.test(host)) lits.push({ kind: 'hostname', value: host });

  /**
   * The owner's NAME resolves in precedence order:
   *   1. OWNER_NAME_ENV — an explicit run-time answer, for a box whose git identity is
   *      not the owner's: CI, a container, or (the case that caused this) a box whose
   *      `user.name` an unrelated automation has taken over.
   *   2. `git config user.name` — but ONLY when it is a person's.
   *
   * An automation name is DROPPED rather than recorded, and that asymmetry is the whole
   * fix. Recording it looks harmless — you redact a bot's name, which merely accomplishes
   * nothing — but it also leaves `hasOwnerNameLiteral()` TRUE, so the gate keeps certifying
   * pages whose highest-cost leak class it can no longer see. Dropping it converts a silent
   * blindness into a VISIBLE one that the gate fails closed on. Prefer the loud gap.
   *
   * `git-email` is deliberately left alone: an address is still caught by shape via
   * IDENTITY_PATTERNS even when no literal knows it, so a bot email cannot go blind the way
   * a bare first name can. Narrow fix, narrow blast radius.
   */
  const explicitOwner = (process.env[OWNER_NAME_ENV] ?? '').trim();
  if (explicitOwner) lits.push({ kind: 'git-name', value: explicitOwner });

  for (const [kind, key] of [
    ['git-name', 'user.name'],
    ['git-email', 'user.email'],
  ] as const) {
    try {
      const v = execFileSync('git', ['config', '--get', key], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!v) continue;
      if (kind === 'git-name') {
        // NEVER take the owner's NAME from git. This is not the automation heuristic
        // being cautious — it is that the heuristic CANNOT BE TRUSTED as a gate input.
        //
        // Measured (EI-20583328178472869): this box's user.name changed mid-session from
        // one automation spelling to another ("…-agent" → "…-buildbox"). The second was
        // absent from AUTOMATION_NAME_RE, so the bot read as a PERSON, hasOwnerNameLiteral
        // went true, and the site gate resumed certifying CLEAN while hunting a machine's
        // name — the original defect, with the fix in place. A denylist of bot-name shapes
        // fails OPEN for every spelling nobody enumerated, and its incompleteness is silent.
        //
        // git config names the COMMITTER. On an automated box that is by construction not
        // the owner. So the name comes from OWNER_NAME_ENV or it does not come at all, and
        // hasOwnerNameLiteral() goes false, and callers that publish fail closed on it.
        // The Python sibling (audit-release-bundle.py) enforces the SAME rule one layer
        // later — do NOT "align" the two by copying its heuristic back to here. Its
        // identity_literals() still reads `user.name` and drops it only when
        // looks_like_automation_identity() matches, the very denylist rejected above; but
        // that surviving literal can never CERTIFY anything, because
        // has_owner_name_literal() ignores the literal set entirely and returns
        // bool(explicit_owner_values(OWNER_NAME_ENV)). A CLEAN verdict there rests on the
        // explicit owner name or on nothing, exactly as it does here. The git-derived
        // literal is kept only so a bot's name still gets REDACTED.
        //
        // Measured on this box 2026-09-18: its own git user.name is NOT matched by that
        // denylist, so the bot name IS recorded as build-git-name — and the gate still
        // refuses (exit 2, CANNOT CHECK) when no owner env is set. That independence is
        // the property this side leans on; it is pinned by
        // audit-release-bundle-fails-closed.test.ts. (The box's name is deliberately NOT
        // spelled out here: a bare box-identity literal is precisely what
        // lint:no-identity-literals refuses, and that lint is repo-wide.)
        //
        // One REAL divergence remains, and it is deliberate: the Python accepts a LIST of
        // owner names (`build-git-name`, `-2`, …) because a person has several spellings,
        // where this side takes a single string. Widen here before assuming one spelling
        // covers the owner.
        continue;
      }
      lits.push({ kind, value: v });
    } catch {
      /* no git identity configured */
    }
  }

  return lits;
}

/**
 * ⚠ NO ANGLE BRACKETS. The scrub runs on FINISHED HTML (see release-history-page's
 * `shell`), which is the right place — but it means a `<owner>`-shaped placeholder
 * would be injected as a raw, unescaped tag. A browser parses `<owner>` as an
 * unknown element and renders NOTHING: the redacted text would silently vanish
 * from the page instead of showing that something was withheld. Brackets, not tags.
 */
const PLACEHOLDER: Record<IdentityLiteral['kind'], string> = {
  user: '[user]',
  home: '~',
  hostname: '[host]',
  'git-name': '[owner]',
  'git-email': '[email]',
};

/**
 * Redact this box's identity out of text bound for publication.
 *
 * Order matters: the HOME PATH is redacted before the USERNAME, because the home
 * path CONTAINS the username (`/home/alice` ⊃ `alice`). Redacting the username
 * first would leave `/home/<user>` — which still says "this is a linux box and
 * here is the shape of its home dir", and, worse, would make the home-path
 * literal un-matchable afterwards, so the gate downstream would report CLEAN on
 * text that had in fact been half-scrubbed. Longest literal first, always.
 */
export function scrubIdentity(
  text: string,
  literals: IdentityLiteral[],
  opts: ScrubOptions = {},
): string {
  // Mask any deliberately-published address BEFORE the literal pass — see
  // maskAllowed. Default is an empty allowance, i.e. exactly the old behaviour.
  const { masked, restore } = maskAllowed(text, opts.allowEmails ?? []);
  const ordered = [...literals].sort((a, b) => b.value.length - a.value.length);
  let out = masked;
  for (const lit of ordered) {
    out = out.replace(literalPattern(lit.value), PLACEHOLDER[lit.kind]);
  }
  // Then the shape-based patterns, for every identity we could not enumerate.
  for (const p of IDENTITY_PATTERNS) {
    out = out.replace(p.pattern, p.placeholder);
  }
  return restore(out);
}

/**
 * The GATE. Find this box's identity in text that is about to be published.
 *
 * The scrub is the fix; this is the PROOF. They are deliberately separate: a scrub
 * that silently missed a case would be invisible, so we re-read the finished bytes
 * and look again. Gate the output, not the intent — the same rule the whole
 * release rail runs on (LABELED != PACKED).
 */
export function findIdentityLeaks(
  text: string,
  literals: IdentityLiteral[],
  opts: ScrubOptions = {},
): Array<{ kind: IdentityLiteral['kind'] | IdentityPattern['kind']; count: number }> {
  // Same masking as the scrub, so the gate agrees with it about the ONE address
  // we publish on purpose — and still fails on every other one. Default empty.
  const { masked: text2 } = maskAllowed(text, opts.allowEmails ?? []);
  text = text2;
  const hits: Array<{ kind: IdentityLiteral['kind'] | IdentityPattern['kind']; count: number }> = [];
  for (const lit of literals) {
    const matches = text.match(literalPattern(lit.value));
    if (matches && matches.length > 0) hits.push({ kind: lit.kind, count: matches.length });
  }
  // The gate MUST look for the un-enumerated shapes too. A gate that only knows
  // the literals the scrub already knows can never catch the scrub's blind spot —
  // it would have called the page with the owner's gmail address on it CLEAN.
  for (const p of IDENTITY_PATTERNS) {
    const matches = text.match(p.pattern);
    if (matches && matches.length > 0) hits.push({ kind: p.kind, count: matches.length });
  }
  return hits;
}
