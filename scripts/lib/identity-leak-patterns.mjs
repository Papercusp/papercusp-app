/**
 * identity-leak-patterns.mjs — the ONE detector for the whole IDENTITY-LEAK FAMILY in
 * shipped source, shared by the gate lints and the edit-time hook (EI-18670349543629060,
 * EI-18670296139788697, EI-18759401203875869).
 *
 * THREE CLASSES, THREE GATE LINTS, ONE MODULE. Each class has a `find*` matcher below and a
 * gate script that imports it — never its own copy:
 *
 *   class 1  named owner-provenance tags   `findOwnerNameLeaks`     check-no-owner-name-tags.mjs
 *   class 2  hardcoded home paths          `findBoxIdentityPaths`   check-no-box-identity.mjs
 *   class 3  bare box-identity literals    `findIdentityLiterals`   check-no-identity-literals.mjs
 *
 * All three are also run by the EDIT-TIME advisory hook
 * (apps/operator/scripts/hooks/cc/pretooluse-content-lint.mjs), which is the point of hosting
 * them together: classes 2 and 3 were gate-only until EI-18759401203875869, and the leak that
 * proved it — a `/home/<user>/…` path written into a doc — was in exactly those two classes while
 * class 1, the only one with edit-time coverage, did not apply. Five consecutive red gates and 60
 * stranded commits, over one hardcoded home directory, because the cheapest possible detector ran
 * only in the most expensive possible place. If you add a class-4 lint, put its matcher HERE and
 * give it hook coverage in the same change — the hook suite asserts that pairing.
 *
 * WHY THIS MODULE EXISTS (two bugs, one root)
 *
 * 1. THE MATCHER WAS TOO NARROW. check-no-owner-name-tags.mjs anchored only on the
 *    BRACKET form `[owner:<name> …]`, and justified that narrowness well: `[owner:` is a
 *    structured marker, so matching inside it is exact and has no false-positive surface.
 *    Sound — but agents do not only write the bracket form. Of the 11 leaks that red-ed the
 *    green gate on 2026-07-26, THREE were parenthetical section headers:
 *
 *      * OWNER RULE (Jane, 2026-07-25): "…"
 *      * OWNER MANDATE (Jane, 2026-07-25, verbatim): "…"
 *
 *    These leak the same person and evaded the guard entirely.
 *
 * 2. THE FEEDBACK ARRIVED HOURS LATE. The three identity lints ran only as a
 *    green-checkpoint leg, so a one-line tag red-ed the gate and froze `main` — 4h10m with
 *    41 commits buffered on 2026-07-26 — before anyone saw it. That is the same shape as
 *    EI-18147177863084708, which moved these lints from release-CUT time to checkpoint
 *    time for exactly this reason. This module is the next hop: EDIT time, in the author's
 *    own turn, seconds after they type it.
 *
 * The two consumers MUST agree on what a leak is, or the edit-time advisory becomes a liar
 * that green-lights what the gate later rejects. Hence one detector, imported by both:
 *   - scripts/check-no-owner-name-tags.mjs                       (the gate lint, blocking)
 *   - apps/operator/scripts/hooks/cc/pretooluse-content-lint.mjs (edit-time, advisory)
 *
 * THIS FILE OBEYS ITS OWN RULE. It is tracked source, so it is packed into
 * source.tar.zst and scanned by bin/audit-release-bundle.py. It therefore cannot spell a
 * real contributor's name even to illustrate the bug — every example above and below is a
 * PLACEHOLDER for that reason, not by accident.
 *
 * THE RULE: in shipped source cite the tier and the date, never the person.
 *   [owner:Jane 2026-07-13]                 ->  [owner 2026-07-13]
 *   OWNER MANDATE (Jane, 2026-07-13): "…"   ->  OWNER MANDATE (2026-07-13): "…"
 * The NAMED form stays correct on carry surfaces (work items, facts, checkpoints, plans) —
 * those are internal and never packed into the bundle.
 */

import { execFileSync } from 'node:child_process';
import os from 'node:os';

/**
 * Names that identify NOBODY: the stand-ins a test fixture or doc example uses on purpose,
 * precisely because they name no real person. A fixture asserting that the release scrubber
 * strips `[owner:Jane …]` must be able to say `[owner:Jane …]`.
 *
 * This is a list of PLACEHOLDERS, not an allowlist of people. A real contributor's name does
 * not go here — strip it from the tag instead. Adding your name here is the bug this gate
 * exists to catch.
 */
export const PLACEHOLDER_NAMES = new Set([
  'jane', 'john', 'jdoe', 'jane-doe', 'johndoe', 'alice', 'bob', 'carol', 'dave',
  'someone', 'somebody', 'name', 'owner', 'user', 'example', 'test', 'testuser',
  'placeholder', 'redacted', 'anon', 'anonymous', 'foo', 'bar',
]);

/**
 * Not shipped / not source / regenerated. Mirrors check-no-box-identity.mjs so every rule
 * agrees on what "shipped" means. Exported so the edit-time hook skips the same paths the
 * gate skips — otherwise the hook nags about a `[owner:<name>]` tag on a CARRY surface,
 * where the named form is CORRECT, and agents learn to ignore it.
 */
export const SKIP = [
  /(^|\/)node_modules\//, /(^|\/)\.git\//, /(^|\/)dist(-\w+)?\//, /(^|\/)build\//,
  /(^|\/)coverage\//, /(^|\/)_retired\//, /(^|\/)\.papercusp\//, /(^|\/)docs\.old\.\d+\//,
  /(^|\/)agent-briefs\//, /^docs\/plans\//, /(^|\/)public\/internal\/docs\//,
  /(^|\/)\.harness\//, /(^|\/)\.tmp(-[^/]*)?\//, /(^|\/)\.claude\//,
  // Dot-prefixed TOOL CACHES (`.tsx-tmp/`, `.content-fixer-tmp/`): regenerated V8
  // compile-cache blobs, same category as dist/ and build/ above. The `.tmp(-…)/`
  // entry on the previous line matches a `.tmp` PREFIX and so misses these, which
  // END in `-tmp` — measured 2026-08-31: 410 tracked cache files (275 in
  // .content-fixer-tmp/, 135 in .tsx-tmp/) carried this box's home path and made
  // check-no-box-identity.mjs report 412 findings when only 2 were real source.
  // Matched by SHAPE, not by a hardcoded pair, so a future `.<tool>-tmp/` is covered.
  /(^|\/)\.[\w.-]+-tmp\//,
  /(^|\/)__pycache__\//, /\.pyc$/,
  /\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf|zst|gz|tgz|zip|pdf|mp[34]|wav|lock)$/i,
  /(^|\/)package-lock\.json$/, /(^|\/)junit\.xml$/,
  /^(HANDOFF|BRIEF|FLEET|SELF-BRIEF|LIVE)-.*\.md$/,
  /^shared-pot-release-testing\//,
  /(^|\/)\.papercusp-\w+\//, /\.(swp|swo|swn)$/,
];

/** True when `file` is outside the shipped-source set these rules police. */
export function isSkippedPath(file) {
  return SKIP.some((re) => re.test(file));
}

/**
 * FORM 1 — `[owner:<name>` , the named provenance tag. The sanctioned `[owner 2026-07-13]`
 * (no colon) and `[owner:2026-07-13]` (bare date) forms carry no name and do not match.
 * `[self-imposed]`, `[peer:su-…]`, `[inferred]` name no human and are untouched.
 */
const BRACKET_TAG = /\[owner:\s*([A-Za-z][A-Za-z0-9._'-]*)/gi;

/**
 * FORM 2 — the parenthetical section header `OWNER MANDATE (<Name>, <date>…)`.
 *
 * The bracket rule got its zero-false-positive guarantee from a structured marker, and this
 * one keeps that discipline rather than hunting bare names (which is what makes the release
 * audit noisy enough to get switched off). Three independent anchors must ALL hold:
 *   (a) an `owner <directive-noun>` phrase immediately followed by `(`,
 *   (b) the first token inside the paren is Capitalized and contains NO DIGIT — so a
 *       work-item ref `(WI-5811, …)`, a session id `(su-707…)` and a bare date `(2026-07-25)`
 *       cannot match, and lower-case prose like `OWNER RULE (see the docs)` cannot either,
 *   (c) that token is terminated by `,` `)` or whitespace-then-digit — i.e. it sits in the
 *       attribution slot, not mid-sentence.
 */
const PAREN_TAG =
  /\bowner\s+(?:mandate|rule|ask|directive|decision|request|order|instruction|say|says|said|wants?)\b\s*\(\s*([A-Za-z][A-Za-z'.-]*)(?=\s*[,)]|\s+\d)/gi;

/**
 * Cheap whole-file pre-filter: skip the overwhelming majority of files without running the
 * real matchers. Deliberately NOT a bare /owner/i — `ownerId` appears in thousands of files
 * in this tree, so that would reject almost nothing and cost more than it saves.
 */
export const FAST_REJECT =
  /\[owner:|owner\s+(?:mandate|rule|ask|directive|decision|request|order|instruction|say|says|said|wants?)\s*\(/i;

/** A peer tag cites a session id (`[peer:su-b0fbf…]`), never a person — not a leak. */
const isSessionId = (n) => /^su-/i.test(n);
/** A bare date after the colon (`[owner:2026-07-13]`) names nobody. */
const isDateLike = (n) => /^\d/.test(n);
/** A placeholder identifies nobody on purpose. */
const isPlaceholder = (n) => PLACEHOLDER_NAMES.has(n.toLowerCase());
/**
 * Form-2 only: a person's given name is Capitalized and digit-free. Rejects `WI-5811`,
 * `su-707…`, `2026-07-25` and every other ref/id that can sit in an attribution slot.
 */
const looksLikePersonName = (n) => n.length >= 2 && /^[A-Z][A-Za-z'.-]*$/.test(n);

/**
 * Find named owner-provenance tags in `text`.
 *
 * @param {string} text file contents (or, at edit time, just the incoming edit)
 * @returns {{line:number,name:string,form:'bracket'|'paren',text:string}[]} one row per leak
 */
export function findOwnerNameLeaks(text) {
  if (!text || !FAST_REJECT.test(text)) return [];
  const findings = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const m of line.matchAll(BRACKET_TAG)) {
      const name = m[1];
      if (isPlaceholder(name) || isSessionId(name) || isDateLike(name)) continue;
      findings.push({ line: i + 1, name, form: 'bracket', text: line.trim().slice(0, 120) });
    }
    for (const m of line.matchAll(PAREN_TAG)) {
      const name = m[1];
      if (isPlaceholder(name) || isSessionId(name) || isDateLike(name)) continue;
      if (!looksLikePersonName(name)) continue;
      findings.push({ line: i + 1, name, form: 'paren', text: line.trim().slice(0, 120) });
    }
  }
  return findings;
}

/** How the leak was written, for the fix hint. */
export function renderLeak(f) {
  return f.form === 'bracket' ? `[owner:${f.name} …]` : `OWNER … (${f.name}, …)`;
}

/** The one fix text, so the gate and the edit-time advisory teach the same thing. */
export const FIX_HINT =
  'FIX: strip the NAME, keep the tier and the date.\n' +
  '      [owner:Jane 2026-07-13]                ->  [owner 2026-07-13]\n' +
  '      OWNER MANDATE (Jane, 2026-07-13): "…"  ->  OWNER MANDATE (2026-07-13): "…"\n' +
  'The named form stays correct on CARRY SURFACES (work items, facts, checkpoints,\n' +
  'plans) — those are internal and never packed into the bundle. Do NOT silence this\n' +
  'by adding the name to PLACEHOLDER_NAMES: shipping that name is the bug.';

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * CLASS 2 — HARDCODED HOME PATHS  (`/home/<user>/…`, `/Users/<user>/…`, and the munged form)
 *
 * Ported VERBATIM out of scripts/check-no-box-identity.mjs (EI-18759401203875869); that script
 * now imports these instead of carrying its own copy, for the same reason class 1 is shared — an
 * edit-time advisory that disagrees with the gate is worse than no advisory at all.
 *
 * MACHINE-AGNOSTIC BY DESIGN, unlike class 3: this matches a path SHAPE, not a value, so it
 * behaves identically on every contributor's checkout. That is deliberate — a lint keyed to one
 * machine only works on one machine, which is the bug it is preventing. See
 * check-no-box-identity.mjs's header for the full rationale and the 0.0.8 cut that motivated it.
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/** Home dirs that are NOT a person: shared installs, CI runners, containers. */
export const GENERIC_USERS = new Set([
  "linuxbrew",
  "dev",
  "runner",
  "user",
  "ubuntu",
  "root",
  "node",
  "builder",
  "vscode",
  "codespace",
  "shared",
  "Shared",
  "ci",
  "agent",
  // Service/VM accounts that belong to the PRODUCT, not to a person: the account
  // inside a deployed frame, the WSL distro, the Windows VM's stock account, and
  // the placeholder a doc/test uses on purpose. Naming these is not a leak.
  // Keep this list to non-personal accounts only — it is not a place to silence
  // a real name to make the build pass.
  "pcusp",
  "papercusp",
  "papercup",
  "tester",
  "User",
  "x",
  // IMAGE-BUILD accounts that our OWN infra creates, plus the stock account of the
  // builder that creates them (infra/images/workspace-host.pkr.hcl). They surface in
  // home-path shape only because that file DEFINES the account rather than consuming
  // one — the useradd/usermod pair that sets the account's home, the `install -d`
  // that creates it, and the build-user cleanup in the image-finalise step.
  //
  // A path a file CREATES inside the image it builds is not a path borrowed from
  // somebody's box: it is correct on every machine, which is exactly the property
  // this rule's header says a hardcoded home path lacks. `packer` is HashiCorp's
  // canonical build account — the same class as `runner` / `builder` above.
  //
  // Not an exception added to make a build pass: neither name belongs to a person,
  // and neither can reach the release bundle's audit, which resolves THIS box's
  // identity at run time and never looks for a generic home path at all.
  "papercusp-workspace",
  // The THIRD workspace-host identity (D-248, 2026-09-03) — the non-login account the bundled
  // agent CLIs execute as, and the owner of the delivered agent credential home. Same class and
  // same provenance as `papercusp-workspace` directly above: `workspace-host-bootstrap.ts`
  // CREATES it (useradd/usermod/install -d) rather than consuming a home borrowed from a box, so
  // `/home/papercusp-agent` is correct on every machine that runs the generated script.
  //
  // Listed alongside its sibling deliberately. The two accounts were ONE until D-248 split them,
  // and the split is what keeps the customer's SSH login out of the runtime (D-043) — so a
  // future reader finding one name here and not the other should suspect a half-reverted split,
  // not an oversight in this list.
  "papercusp-agent",
  "packer",
  // Stand-ins that name nobody: test fixtures and doc examples.
  "test",
  "testuser",
  "owner",
  "host",
  "whoever",
  "all",
  "paper",
  "submission",
  // The canonical fake identities. The identity SCRUBBER's own tests
  // (release-content-scrub.test.ts, gate-release-site.test.ts) must contain
  // realistic-looking home paths — that is the input they scrub — so the rule
  // "no /home/<user>/ in source" fires on the one place a fake home path is the
  // entire point. These name no person; they are the John-Doe set.
  "jdoe",
  "alice",
  "bob",
  "buildbot",
  "otheruser",
  "someuser",
  // ⚠ THE SCRUBBER'S OWN OUTPUT VOCABULARY (WI-6992). These are the values
  // REDACTION_BY_KEY in papercusp-desktop/bin/audit-release-bundle.py substitutes
  // FOR this box's identity — `build-user-name` -> `builduser`,
  // `build-hostname` -> `buildhost`. They are redactions, not people.
  //
  // Omitting them was a live false-RED, not a theoretical gap: on 2026-08-02 a
  // 2.94 MB bench fixture was scrubbed using exactly this sanctioned vocabulary,
  // and this rule then flagged the REDACTED file — 10 hits on `-home-builduser-`
  // — which red-pinned the green gate and held `main` for the whole fleet. The
  // scrub was correct; the guard disagreed with the scrubber. The module header
  // says these two halves "MUST agree or it's a false-green"; this is the same
  // drift in the false-red direction, and it costs exactly as much.
  //
  // Adding them is NOT an exception to make a build pass: a value the release
  // scrubber EMITS can never be a leak, by construction.
  //
  // `macuser` / `maclogin` are the same class (REDACTION_BY_KEY's
  // `known-sensitive:mac-vm-user` / `mac-vm-login`) and were found by the drift
  // test added with this fix, not by hand — which is the point of pinning the
  // agreement rather than patching the one value that happened to bite.
  //
  // `ownerhandle` (REDACTION_BY_KEY's `known-sensitive:owner-github-handle`) is
  // the third instance of that same pattern, and it arrived exactly the way the
  // drift test predicted: the handle was added to the python denylist from a
  // MEASURED leak (EI-20108164746219771, 10 occurrences in the shipped seed
  // corestore), its redaction token was declared, and this set was not updated —
  // so the sanctioned scrub output would have red-pinned check-no-box-identity
  // the first time a staged file put it in a `/home/<user>/` position. The test
  // caught it before a cut did; adding the token here is the fix, not a silencer.
  "builduser",
  "buildhost",
  "macuser",
  "maclogin",
  "ownerhandle",
  // WI-4776: illustrative placeholder SEGMENTS used in docs to show the SHAPE of
  // a path (e.g. `/absolute/home/path` in a tool-arg example) — the word after
  // /home/ there is not a username at all, just prose continuing the sentence.
  "path",
]);

/** Anonymous by construction: a redaction (`/home/.../`, `/home/<user>/`) or a
 *  1–2 char stand-in a test/doc uses precisely because it names nobody. */
export const isRedactedUser = (user) =>
  /^[.<{$%]/.test(user) || user === '$USER' || user === 'USER' || user.length <= 2;

/** `/home/instructions.txt` is a FILE that lives in /home — not a person's home
 *  directory. A home dir never carries a file extension, so a segment ending in
 *  one names nobody and cannot be a box-identity leak. (The real thing this lint
 *  hunts is always `/home/<user>/…` or a bare `/home/<user>`, and neither has an
 *  extension — so this costs the check nothing.) */
const isFileInHome = (seg) => /\.[A-Za-z0-9]{1,5}$/.test(seg);

// A slash inside a word or relative path is not an absolute home root. Keep
// delimiters (including file-URL slashes) eligible without consuming them, so
// redaction preserves the surrounding text and the capture groups stay stable.
const HOME_PATH = /(?<![A-Za-z0-9._-])\/(home|Users)\/([A-Za-z0-9._-]+)(?=[/'"`\s\\)\]:,;]|$)/g;

/** A home path ending a SENTENCE swallows the full stop: `/home/jdoe.` captures the
 *  user as "jdoe." — which then matches no placeholder and no real user, and reports a
 *  fake identity as a real leak. A `.` is legal INSIDE a username (`john.doe`) but a
 *  home directory never ENDS in one, so a trailing dot is always punctuation. Strip it
 *  before classifying (the lookahead can't: it must still allow the dot mid-name). */
const stripTrailingDots = (user) => user.replace(/\.+$/, '');

/** The SAME home dir with its slashes munged to dashes — the form Claude uses to
 *  name a session/project directory (`/home/dev/x` → `-home-dev-x`). This lint
 *  passed a clean 0 while `apps/tui/src/transcript.rs` sat there holding the
 *  owner's real home path in exactly this shape: a slash-based regex cannot see a
 *  string that has no slashes in it, and the release gate caught it only at CUT
 *  time, inside a 2.6GB tarball — the most expensive possible moment to learn it.
 *
 *  Anchored to a quote / slash / whitespace boundary so ordinary kebab-case
 *  ("some-home-page-header") cannot trip it, and the user segment stops at the
 *  first dash — for a dashed username that yields a prefix, which is all we need:
 *  it is not a GENERIC_USER, so we flag the line and print it. */
const MUNGED_HOME = /(^|["'`/\s])-(home|Users)-([A-Za-z0-9._]+)(?=-)/g;

/** Cheap whole-text pre-filter, same as the per-file one the gate script applied: text with no
 *  `/home/`-shaped bigram anywhere cannot hold this class, so skip the line scan entirely. */
export const BOX_IDENTITY_FAST_REJECT = /[/-](home|Users)[/-]/;

/**
 * Find hardcoded home paths in `text`.
 *
 * @param {string} text file contents (or, at edit time, just the incoming edit)
 * @returns {{line:number,user:string,text:string}[]} one row per leak
 */
export function findBoxIdentityPaths(text) {
  if (!text || !BOX_IDENTITY_FAST_REJECT.test(text)) return [];
  const findings = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(HOME_PATH)) {
      const user = stripTrailingDots(m[2]);
      if (GENERIC_USERS.has(user) || isRedactedUser(user) || isFileInHome(user)) continue;
      findings.push({ line: i + 1, user, text: line.trim().slice(0, 110) });
    }
    for (const m of line.matchAll(MUNGED_HOME)) {
      const user = m[3];
      if (GENERIC_USERS.has(user) || isRedactedUser(user)) continue;
      findings.push({ line: i + 1, user, text: line.trim().slice(0, 110) });
    }
  });
  return findings;
}

/** The one fix text for class 2, shared by the gate lint and the edit-time advisory. */
export const BOX_IDENTITY_FIX_HINT =
  'FIX by deriving the path, not by adding an exception:\n' +
  '    node/ts   os.homedir()  ·  path relative to import.meta.url / __dirname\n' +
  '    shell     "$HOME"  ·  git -C "$(dirname "$0")" rev-parse --show-toplevel\n' +
  '    systemd   %h\n' +
  '    config    a machine-local ~/.papercusp/*.env, read at run time';

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * CLASS 3 — BARE BOX-IDENTITY LITERALS  (this box's git name/email, hostname, OS account)
 *
 * Ported VERBATIM out of scripts/check-no-identity-literals.mjs (EI-18759401203875869), which
 * now imports these. MUST MIRROR identity_literals() / needs_word_boundary() / is_vendor() from
 * papercusp-desktop/bin/audit-release-bundle.py — memory ef6e21c4 / WI-4419: "the two MUST agree
 * or it's a false-green." Keep them in lockstep if either changes.
 *
 * ⛔ THE MIRROR IS `identity_literals()` ONLY — it deliberately does NOT include the python's
 * `KNOWN_SENSITIVE_IDENTITIES`, and widening it to do so would FREEZE `main`. Read this before
 * "fixing" the asymmetry (EI-19462813694036210 was filed proposing exactly that):
 *
 *   WHAT LOOKS WRONG. `--identity-literals` prints 7 literals; `resolveIdentityLiterals()` resolves
 *   4 keys. That reads as a narrower detector shipping a false-green. It is not. The python's
 *   `identity_literals()` is itself build-box-only ("resolved from the box doing the build") and
 *   THIS PORT MIRRORS IT EXACTLY. The extra 3 come from the CALL SITES, which each do
 *   `lits.update(KNOWN_SENSITIVE_IDENTITIES)` — a cross-box set (the mac-VM aliases) that is a
 *   different mechanism, not a wider version of this one.
 *
 *   WHY IT IS NOT PORTED. All four of those call sites operate on SHIPPED BYTES, never the working
 *   tree: scan the assembled sidecar (`scan_dir`), audit the built bundle, and emit the list so
 *   `bin/stage-source-tree.sh` (see its L315) can `--transform` a REDACTED COPY of each leaking
 *   file at tar time. The remedy for that set is redaction-at-package-time; the tree is left
 *   un-scrubbed ON PURPOSE. The KNOWN_SENSITIVE_IDENTITIES block comment says so: those files
 *   "cannot be pruned (they ship / run), and a per-file source edit is a treadmill that reds the
 *   next cut the moment a new tag lands."
 *
 *   WHAT ARMING IT WOULD COST. This module backs THREE blocking gate lints, so adding that set
 *   arms them all at once against the working tree. Measured 2026-08-03 over `git ls-files`:
 *   `known-sensitive:mac-vm-user` occurs in 31 tracked files and `mac-vm-login` in 8 — nearly all
 *   mac-VM runbooks under apps/operator-docs plus their GENERATED html/md projections. That is 31
 *   instant findings red-pinning `main`, to re-create the exact per-file-source-edit treadmill the
 *   design above rejected.
 *
 *   SO: this class hunts THIS BOX's identity at edit time. Cross-box known-sensitive literals are
 *   handled by stage-time redaction + the assembled-bytes backstop. Both directions of drift are
 *   pinned by `identity-literals-python-parity.test.ts` — if you add a build-* key to the python,
 *   that test fails until this port catches up; if you add a KNOWN_SENSITIVE_IDENTITIES entry, it
 *   fails until you consciously re-affirm that it stays unported.
 *
 * WHY THIS CLASS IS BOX-SPECIFIC (deliberately unlike class 2): it has to know what "this box's
 * identity" actually IS in order to search for it, exactly as the release audit does — both
 * resolve git config / hostname / OS account AT RUN TIME, and neither hardcodes a value. On a CI
 * runner with a bot/absent git identity it degrades to a no-op, which is expected, not a bug: the
 * box that matters is the one that actually cuts releases.
 *
 * THE LITERALS ARE A PARAMETER, NOT AN INTERNAL LOOKUP. `findIdentityLiterals` takes the resolved
 * entries so a caller can pass SYNTHETIC ones. That seam is what makes this class testable at all:
 * this module is tracked source, so it is scanned by the very lint it implements, and a fixture
 * spelling a real box identity would fail the gate from inside the guard written to prevent that.
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/** Accounts/hosts that identify NOBODY — mirrors identity_literals()'s own
 *  exclusions (`user not in (root, runner, build, ubuntu)`, `host not startswith
 *  (runner, ci-, localhost)`) plus class 2's GENERIC_USERS, so a CI runner or
 *  shared box never self-flags. */
export const GENERIC_ACCOUNTS = new Set([
  'root', 'runner', 'build', 'ubuntu', 'node', 'vscode', 'codespace', 'ci', 'agent',
  'linuxbrew', 'dev', 'user', 'shared', 'Shared', 'pcusp', 'papercusp', 'papercup',
  'tester', 'test', 'admin', 'builder', 'vagrant',
]);
// ↑ MUST equal GENERIC_ACCOUNTS in papercusp-desktop/bin/audit-release-bundle.py
//   (pinned by papercusp-desktop/test/audit-identity-literal-shape.test.js).

/** A host that names no machine of ours. */
export const isGenericHost = (h) => /^(runner|ci-|localhost)/i.test(h);

/**
 * identity_literals() ported from audit-release-bundle.py — same sources, same exclusions,
 * automation filtering, and explicit owner overrides. Returns `{ key: value }` for whatever
 * resolves on THIS box (possibly empty on a bare/CI box).
 *
 * @param {(cmd: string, args: string[]) => string} [readCmd] injection seam for tests
 * @param {NodeJS.ProcessEnv} [env] runtime identity env; injectable for tests
 * @returns {Record<string,string>}
 */
const AUTOMATION_NAME_RE =
  /(^|[-_ ])(agent|bot|ci|runner|automation|service|actions|daemon|noreply)([-_ ]|$)|\[bot\]/i;
const AUTOMATION_EMAIL_RE =
  /(^|[-_.+])(no-?reply|bot|ci|build|actions|automation|daemon|jenkins|dependabot|renovate)([-_.+]|@)|\bnoreply\b|users\.noreply\.github\.com$|\[bot\]/i;
const OWNER_NAME_ENV = "PAPERCUSP_RELEASE_OWNER_NAME";
const OWNER_EMAIL_ENV = "PAPERCUSP_RELEASE_OWNER_EMAIL";

function explicitOwnerValues(env, envVar) {
  return [
    ...new Set(
      String(env[envVar] ?? "")
        .split(/[,;]/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function replaceIdentityClass(target, source, base) {
  const overrides = Object.entries(source).filter(
    ([key]) => key === base || key.startsWith(`${base}-`),
  );
  if (overrides.length === 0) return;
  for (const key of Object.keys(target)) {
    if (key === base || key.startsWith(`${base}-`)) delete target[key];
  }
  for (const [key, value] of overrides) target[key] = value;
}

/**
 * Resolve the three useful views from one read of git config. `box` mirrors the machine/git
 * values after the release audit drops automation identities; `owner` contains only explicit
 * owner assertions; `all` applies those assertions as per-class overrides, exactly as the audit
 * does. Keeping the views together lets the broad repo lint retain its established box scope,
 * while the sidecar-copy lint applies asserted owner values only where the source bypasses the
 * source-archive scrub.
 *
 * @param {(cmd: string, args: string[]) => string} [readCmd] injection seam for tests
 * @param {NodeJS.ProcessEnv} [env] runtime identity env; injectable for tests
 * @returns {{box:Record<string,string>,owner:Record<string,string>,all:Record<string,string>}}
 */
export function resolveIdentityLiteralScopes(readCmd, env = process.env) {
  const run =
    readCmd ??
    ((cmd, args) =>
      execFileSync(cmd, args, { encoding: "utf8", timeout: 5000 }).toString());
  const box = {};
  try {
    const account = os.userInfo().username;
    if (account && !GENERIC_ACCOUNTS.has(account)) {
      box["build-user-name"] = account;
      WORD_BOUNDED_LITERALS.add(account);
    }
  } catch {
    /* best-effort */
  }
  try {
    const host = os.hostname();
    if (host && !isGenericHost(host)) box["build-hostname"] = host;
  } catch {
    /* best-effort */
  }
  for (const [key, cfg] of [
    ["build-git-email", "user.email"],
    ["build-git-name", "user.name"],
  ]) {
    try {
      const v = run("git", ["config", "--get", cfg]).trim();
      if (!v) continue;
      if (key === "build-git-name" && AUTOMATION_NAME_RE.test(v)) continue;
      if (key === "build-git-email" && AUTOMATION_EMAIL_RE.test(v)) continue;
      box[key] = v;
    } catch {
      /* unset — nothing to hunt */
    }
  }

  const owner = {};
  for (const [envVar, base] of [
    [OWNER_NAME_ENV, "build-git-name"],
    [OWNER_EMAIL_ENV, "build-git-email"],
  ]) {
    explicitOwnerValues(env, envVar).forEach((value, index) => {
      owner[index === 0 ? base : `${base}-${index + 1}`] = value;
    });
  }

  const all = { ...box };
  replaceIdentityClass(all, owner, "build-git-name");
  replaceIdentityClass(all, owner, "build-git-email");
  return { box, owner, all };
}

/**
 * Resolve one identity scope. Existing callers default to `box`; release-gate consumers that
 * need Python-audit parity request `all`, and narrowly scoped callers can request `owner`.
 *
 * @param {(cmd: string, args: string[]) => string} [readCmd] injection seam for tests
 * @param {{scope?:'box'|'owner'|'all',env?:NodeJS.ProcessEnv}} [opts] requested identity scope
 * @returns {Record<string,string>}
 */
export function resolveIdentityLiterals(readCmd, opts = {}) {
  const scopes = resolveIdentityLiteralScopes(readCmd, opts.env ?? process.env);
  return scopes[opts.scope ?? "box"];
}

/** needs_word_boundary() ported verbatim: a SHORT alnum literal must match as a
 *  whole word (case-sensitive) or it drowns in false positives — a three-letter
 *  first name also hits a matching file extension, a longer proper noun that
 *  starts with it, and vendored POS-lexicon entries (same rationale as class 1's
 *  refusal to hunt bare names). */
export const needsWordBoundary = (lit) => lit.length < 6 && /^[A-Za-z0-9]+$/.test(lit);

/** is_vendor() ported verbatim: a low-entropy (short/common) literal is only
 *  hunted OUTSIDE node_modules — a bare first name is not vendor's fault to
 *  carry; a high-entropy literal (email, hostname, a longer account name) is still
 *  hunted everywhere, because that DOES mean our own build baked it in. */
export const isVendorPath = (p) => p.startsWith('node_modules/') || p.includes('/node_modules/');

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The match rule for one literal — word-anchored and case-sensitive when low-entropy. */
/** Box unix logins: matched as whole tokens regardless of length. Mirrors
 *  _WORD_BOUNDED_LITERALS in papercusp-desktop/bin/audit-release-bundle.py — a
 *  dictionary-word login (`tester`) as a substring rewrites vendor identifiers
 *  (`createStereoPanner`); the home-path form is CLASS 2's job. */
const WORD_BOUNDED_LITERALS = new Set();

export function literalPattern(lit) {
  return needsWordBoundary(lit) || WORD_BOUNDED_LITERALS.has(lit)
    ? new RegExp(`\\b${escapeRegExp(lit)}\\b`) // case-sensitive, same as the audit
    : new RegExp(escapeRegExp(lit));
}

/**
 * Find bare box-identity literals in `text`.
 *
 * @param {string} text file contents (or, at edit time, just the incoming edit)
 * @param {[string,string][]} entries `Object.entries(resolveIdentityLiterals())` — or synthetic
 *   ones in a test. Empty ⇒ no findings (the bare/CI-box no-op).
 * @param {{vendor?: boolean}} [opts] `vendor` ⇒ the path is under node_modules, so low-entropy
 *   literals are not hunted (is_vendor() scoping).
 * @returns {{line:number,key:string,text:string}[]} one row per leak
 */
export function findIdentityLiterals(text, entries, opts = {}) {
  if (!text || !entries || entries.length === 0) return [];
  const vendor = opts.vendor === true;
  const findings = [];
  const lines = text.split('\n');
  for (const [key, lit] of entries) {
    const lowEntropy = needsWordBoundary(lit);
    if (lowEntropy && vendor) continue; // is_vendor() scoping — bare short names only outside vendor
    const rx = new RegExp(literalPattern(lit).source, 'g');
    for (let i = 0; i < lines.length; i++) {
      if (rx.test(lines[i])) {
        findings.push({ line: i + 1, key, text: lines[i].trim().slice(0, 120) });
      }
      rx.lastIndex = 0;
    }
  }
  return findings;
}

/** The one fix text for class 3, shared by the gate lint and the edit-time advisory. */
export const IDENTITY_LITERAL_FIX_HINT =
  'FIX: remove the literal, or use the sanctioned provenance form that keeps the meaning\n' +
  '  without the name — `[owner:<name> <date>]` -> `[owner <date>]` (see\n' +
  '  check-no-owner-name-tags.mjs) — never add an exception to make the build pass.';

/**
 * Class 3 polices a WIDER path set than its two siblings, so it needs its own skip predicate.
 * Ported verbatim from check-no-identity-literals.mjs's SKIP: `scratchpad/` and `scratch/` are
 * excluded because — unlike classes 1 and 2 — this rule hunts BARE literals with no structural
 * anchor (no `[owner:` tag, no `/home/` shape), which widens its surface to catch things like a
 * scratch investigation artifact that RECORDS a past leak as data (e.g. a lexicon-audit dump),
 * which is not itself a leak. Neither dir is in stage-source-tree.sh's ship allowlist, so
 * excluding them costs nothing real. The rule's own script is excluded because it necessarily
 * describes the class in prose.
 */
export const IDENTITY_LITERAL_EXTRA_SKIP = [
  /^scratchpad\//,
  /^scratch\//,
  /^scripts\/check-no-identity-literals\.mjs$/,
];

/** True when `file` is outside the shipped-source set the CLASS-3 rule polices. */
export function isSkippedPathForIdentityLiterals(file) {
  return isSkippedPath(file) || IDENTITY_LITERAL_EXTRA_SKIP.some((re) => re.test(file));
}

/**
 * The sidecar copies these CC hook files directly from the live tree after source.tar.zst has
 * been scrubbed. Keep the explicit-owner check on this exact copy set; its source is the
 * `CC_HOOK_SRC_DIR` block in papercusp-desktop/bin/build-desktop-sidecar.sh.
 */
const SIDECAR_COPIED_IDENTITY_PATHS = [
  /^apps\/operator\/scripts\/hooks\/cc\/[^/]+\.(?:sh|py|mjs)$/,
];

/** True when `file` is copied verbatim into the sidecar outside the source-archive scrub. */
export function isSidecarCopiedIdentityPath(file) {
  return SIDECAR_COPIED_IDENTITY_PATHS.some((re) => re.test(file));
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
 * THE REDACTOR — the INVERSE of the three matchers above (WI-6992)
 *
 * WHY IT LIVES HERE, NEXT TO THE DETECTORS
 * Some shipped source is GENERATED from live workspace prose — doc sections, session turns,
 * plans — which legitimately contains real names, home paths and this box's identity. The
 * generator cannot simply refuse that input (it IS the data), so it must SCRUB it. That makes
 * redaction the exact inverse of detection, and the two must agree by construction or the
 * generator emits a file the gate then rejects. Hosting the redactor beside the matchers means
 * it reuses THE SAME regexes and THE SAME exclusion sets — GENERIC_USERS, PLACEHOLDER_NAMES,
 * literalPattern(), needsWordBoundary() — rather than a second opinion about what a leak is.
 *
 * This is the same reasoning that put the gate lint and the edit-time hook on one detector, and
 * it was learned the same way: on 2026-08-02 a 2.94 MB bench fixture
 * (packages/operator-core/lib/memory/bench/fixtures/prose-corpus.v1.json) was committed carrying
 * 26 named provenance tags, 113 bare box literals and 24 home paths, because its generator had
 * no redaction whatsoever. All three identity lints red-pinned the green gate and held `main`
 * for the whole fleet ~6.8h. The artifact was scrubbed by hand; this function is so that the
 * NEXT regeneration cannot re-arm the trap.
 *
 * THE INVARIANT, which the test suite pins:
 *     findOwnerNameLeaks(redactIdentityLeaks(s))   === []
 *     findBoxIdentityPaths(redactIdentityLeaks(s)) === []
 *     findIdentityLiterals(redactIdentityLeaks(s, e), e) === []
 * for any string `s`. A change to any matcher that breaks it fails that suite immediately,
 * which is the drift alarm.
 * ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * What each resolved identity literal is replaced BY.
 *
 * Mirrors REDACTION_BY_KEY in papercusp-desktop/bin/audit-release-bundle.py — the release
 * scrubber's own vocabulary — so a file scrubbed at GENERATION time and the same file scrubbed
 * at TAR time come out reading the same way. Every value here is also accepted by the matchers
 * above (see the GENERIC_USERS entries for `builduser` / `buildhost`), which is the property
 * that makes a redacted file lint clean.
 */
export const IDENTITY_REDACTIONS = {
  'build-user-name': 'builduser',
  'build-hostname': 'buildhost',
  'build-git-email': 'owner@example.invalid',
  'build-git-name': 'owner',
};

/** Fallback for a literal with no explicit mapping — mirrors the audit's own default. */
export const IDENTITY_REDACTION_FALLBACK = 'redacted';

/** The stand-in for a home-directory owner, e.g. `/home/jdoe/x` -> `/home/builduser/x`. */
export const REDACTED_HOME_USER = 'builduser';

/** Class-1 redaction forms. Same anchors as the matchers, but they CONSUME the attribution
 *  separator so `OWNER RULE (Jane, 2026-07-13)` collapses to `OWNER RULE (2026-07-13)`
 *  rather than leaving a dangling comma. */
const BRACKET_TAG_REDACT = /\[owner:\s*([A-Za-z][A-Za-z0-9._'-]*)/gi;
const PAREN_TAG_REDACT =
  /(\bowner\s+(?:mandate|rule|ask|directive|decision|request|order|instruction|say|says|said|wants?)\b\s*\(\s*)([A-Za-z][A-Za-z'.-]*)(?:\s*,\s*|\s+(?=\d)|(?=\)))/gi;

/** Resolved lazily and cached: resolveIdentityLiterals() shells out to git, and a caller
 *  scrubbing thousands of rows must not pay that per row. */
let _defaultIdentityEntries;

/**
 * Strip every identity-leak class this module detects, returning source-safe text.
 *
 * Order is deliberate: class 1 first (so a name inside a provenance tag is removed as a TAG,
 * yielding `[owner <date>]`, not turned into `[owner:owner <date>]` by the literal pass), then
 * class 3 (this box's exact literals — the most specific), then class 2 (the shape-based
 * catch-all, which also covers OTHER boxes' home paths that class 3 cannot know about).
 *
 * @param {string} text the prose to scrub
 * @param {[string,string][]} [entries] `Object.entries(resolveIdentityLiterals())`; omitted =
 *   resolved once and cached. Pass explicitly to scrub against SYNTHETIC literals in a test —
 *   this module is tracked source, so a fixture may not spell a real box identity.
 * @returns {string} text with no class-1/2/3 leak remaining
 */
export function redactIdentityLeaks(text, entries) {
  if (typeof text !== 'string' || text === '') return text;
  const ents = entries ?? (_defaultIdentityEntries ??= Object.entries(resolveIdentityLiterals()));
  let out = text;

  // CLASS 1 — strip the NAME, keep the tier and the date (the sanctioned FIX_HINT form).
  if (FAST_REJECT.test(out)) {
    out = out.replace(BRACKET_TAG_REDACT, (m, name) =>
      isPlaceholder(name) || isSessionId(name) || isDateLike(name) ? m : '[owner',
    );
    out = out.replace(PAREN_TAG_REDACT, (m, head, name) =>
      isPlaceholder(name) || isSessionId(name) || isDateLike(name) || !looksLikePersonName(name)
        ? m
        : head,
    );
  }

  // CLASS 3 — this box's own literals, matched EXACTLY as the guard matches them (same
  // word-boundary + case rule via literalPattern), so nothing is over- or under-replaced.
  for (const [key, lit] of ents) {
    if (!lit) continue;
    out = out.replace(
      new RegExp(literalPattern(lit).source, 'g'),
      IDENTITY_REDACTIONS[key] ?? IDENTITY_REDACTION_FALLBACK,
    );
  }

  // CLASS 2 — home paths by SHAPE, including the slash-munged form.
  if (BOX_IDENTITY_FAST_REJECT.test(out)) {
    out = out.replace(HOME_PATH, (m, root, rawUser) => {
      const user = stripTrailingDots(rawUser);
      if (GENERIC_USERS.has(user) || isRedactedUser(user) || isFileInHome(user)) return m;
      // Keep whatever punctuation stripTrailingDots() removed — it is sentence text, not path.
      return `/${root}/${REDACTED_HOME_USER}${rawUser.slice(user.length)}`;
    });
    out = out.replace(MUNGED_HOME, (m, pre, root, user) =>
      GENERIC_USERS.has(user) || isRedactedUser(user) ? m : `${pre}-${root}-${REDACTED_HOME_USER}`,
    );
  }

  return out;
}
