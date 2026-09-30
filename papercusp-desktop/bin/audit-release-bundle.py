#!/usr/bin/env python3
"""audit-release-bundle.py — WI-4419. The release bundle's LAST GATE.

Answers ONE question about the thing we are actually about to ship: does it
contain anything that must never leave this machine?

WHY IT SCANS THE ARTIFACT AND NOT THE REPO
------------------------------------------
A source-tree scan would have PASSED on the 0.0.8 cut. The repo was clean; the
leak only came into existence when bin/stage-source-tree.sh tarred the working
tree and swept up 53,225 UNTRACKED files — including 121 agent session
transcripts (.papercusp/pi-sessions/*.jsonl) carrying the operator's home path in
every record. So the gate runs against the built artifact, after the tar, or it
is measuring the wrong object.

WHY IT MUST SCAN CONTENT, NOT JUST PATHS
----------------------------------------
The mac Server bundle leaked the owner's home path in the CONTENT of 7 files and
an email in 1 — with nothing in the filenames and no credentials anywhere. A
path-only scan passes that bundle. Absolute build paths get baked into vendored
trees constantly (.bin shims, sourcemaps, .package-lock.json, compile caches), so
node_modules is exactly where machine identity hides — it is scanned, not skipped.

WHY IDENTITY IS A SET OF LITERALS
---------------------------------
"Personal information" here means THIS BUILD BOX: its unix user, its home path,
its hostname, its git identity. Those are literal strings, resolved at run time,
so a build on anyone's machine scrubs THAT machine. Deliberately NOT a generic
email/name regex: that matches a maintainer address in every vendor package.json,
and a gate that cries wolf on every build is a gate someone switches off.

PERFORMANCE — why this shells out instead of using Python's tarfile
-------------------------------------------------------------------
Streaming the 9GB tar through Python's tarfile took >18 minutes. `zstd -dc | tar
-tf -` over the same bytes takes 23 SECONDS: the cost was ~50x Python interpreter
overhead, not the data. So the hot paths are C (zstd | tar | grep) and Python only
decides. A slow gate gets disabled, which makes it worse than no gate.

Three phases, cheapest first:
  A. PATHS    — `tar -tf` (~25s). Forbidden dirs/files, identity in filenames.
  B. CONTENT  — `tar -xO | grep` (~1-3min). Identity literals + credential values.
  C. ATTRIBUTE— only if B found something: the slow per-file pass, to name the
                offending files. A failing build can afford the minutes; a
                passing one cannot.

Exit 0 clean · 1 findings (build MUST fail) · 2 unscannable (also fatal — an
unscannable bundle is not a clean one). Never prints a secret VALUE.

Usage:  audit-release-bundle.py <path/to/source.tar.zst>
        audit-release-bundle.py --scan-dir <assembled-tree>...
        audit-release-bundle.py --scan-artifact <finished-installer>...
        audit-release-bundle.py --scan-artifact --licenses <finished-installer>...
                                  (also runs scripts/check-licenses.mjs --installer-tree
                                  on the expanded trees — WI-10003906 / P-017)
        audit-release-bundle.py --distribution-census <gui|server> <platform> <artifact>...
        audit-release-bundle.py --prune-vm-release <assembled-sidecar>
        audit-release-bundle.py --audit-vm-release <assembled-sidecar>
        audit-release-bundle.py --audit-vulnerabilities <assembled-sidecar> <evidence-dir>
"""
import base64
import fnmatch
import functools
import hashlib
import json
import os
import pwd
import re
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from datetime import datetime, timezone

# ── PATH rules — the class that actually bit us: a scratch/state dir sweeping in
# wholesale. Cheap, and applied to every member name.
#
# EACH RULE CARRIES ITS OWN TAR GLOBS, and `--tar-excludes` prints them for
# bin/stage-source-tree.sh to consume. That coupling is the point. These rules
# used to exist TWICE — once here as regexes, once in the stager as a hand-kept
# tar --exclude list — and two hand-maintained copies of the same knowledge drift
# by construction: the stager's list is a postmortem log (cargo-target added after
# it blew up 0.0.5, .next after it tripled 0.0.8) and it had never heard of
# .papercusp/, which is how 121 agent transcripts shipped. Now a new rule teaches
# BOTH the thing that excludes it and the thing that catches it if the exclude
# misses. A rule with no globs (identity/credential content) is gate-only.
#
# The globs are GNU tar's --no-anchored dialect, where `*` matches `/`: the `*/X`
# form catches X at ANY depth (packages/operator-core/.papercusp), which the
# top-level allowlist cannot — the junk is nested INSIDE apps/ and packages/,
# and some of it is git-TRACKED (a .gitignore anchoring bug, fixed by su-a1a71).
FORBIDDEN_PATH = [
    ("agent-transcripts", re.compile(r"(^|/)pi-sessions/|(^|/)sessions/.*\.jsonl$"),
     ["pi-sessions"]),
    # `.papercusp` AND its siblings (`.papercusp-tmp`, `.papercusp-workspaces`): a
    # rule anchored on `.papercusp/` alone MISSED packages/operator-core/.papercusp-tmp/
    # — a node compile-cache full of this box's absolute paths, nested inside an
    # allowlisted dir, i.e. exactly the shape of the original leak.
    ("papercusp-state-dir", re.compile(r"(^|/)\.papercusp(-[a-z-]+)?/"),
     [".papercusp", ".papercusp-*"]),
    # Editor swap/backup files. A tracked `.agent-action-registry-plan.md.swp` was
    # sitting in apps/operator/docs — a binary vim swap holding whatever the author
    # last had in the buffer. Never source, never shippable.
    ("editor-swapfile", re.compile(r"(^|/)\.?[^/]*\.(swp|swo|swn)$|(^|/)[^/]*~$"),
     ["*.swp", "*.swo", "*.swn", "*~"]),
    # node-gyp build scaffolding. A compiled native module needs exactly ONE thing
    # at runtime — its addon binary, build/Release/*.node. Everything node-gyp
    # leaves beside it (Makefile, binding.Makefile, config.gypi, *.target.mk, the
    # Release/.deps/*.o.d dependency lists, Release/obj.target/ objects) records
    # this box's ABSOLUTE paths verbatim, and is needed only to RE-build, never to
    # run. That is what failed the 0.0.13 cut: 587 hits on /home/<user> across 22
    # files under node_modules/{ssh2,cpu-features}. The sidecar copy is pruned at
    # assembly (build-desktop-sidecar.sh), but source.tar.zst ships node_modules
    # too — the SAME residue by a second route — so the rule belongs here, where
    # the exclude and the gate that catches a missed exclude stay one rule.
    # Scoped to the scaffolding ONLY: no glob here can match build/Release/*.node.
    ("node-gyp-build-scaffolding",
     re.compile(r"(^|/)build/(Makefile|binding\.Makefile)$"
                r"|(^|/)build/.*\.(mk|gypi)$"
                r"|(^|/)build/Release/(\.deps|obj\.target|obj)/"),
     # BARE globs — print_tar_excludes() adds the `./X` and `*/X` forms itself, and
     # `*` matches `/`, so `*/build/*.mk` also reaches build/deps/**/x.target.mk.
     ["build/Makefile", "build/binding.Makefile", "build/config.gypi",
      "build/*.mk", "build/*.gypi",
      "build/Release/.deps", "build/Release/obj.target", "build/Release/obj"]),
    # ssh2's OPTIONAL native crypto accelerator (sshcrypto.node). Unlike the
    # scaffolding above, THIS is the addon binary — but node-gyp compiles it on
    # this box and the compiler bakes the build-box home path into a .rodata
    # __FILE__ string (/home/<user>/.cache/node-gyp/<ver>/include/node/node_object_wrap.h,
    # from an assert() macro). That is a CONTENT leak: phase B catches it (grep -a
    # over all bytes), but phase C cannot ATTRIBUTE it (the member is binary — NUL in
    # the first 4KB) and the stager's sed scrub cannot REDACT it (source_leakers skips
    # binaries), so exclusion is the only mechanism that reaches it (this failed the
    # 0.0.13 cut AFTER the scaffolding rule above cleared the path scan). Safe to drop:
    # ssh2 wraps `require('.../sshcrypto.node')` in try/catch and falls back to pure-JS
    # crypto when it is absent (node_modules/ssh2/lib/protocol/crypto.js). Scoped to
    # THIS addon BY NAME on purpose — better-sqlite3 / cpu-features addons are
    # needed-and-clean and MUST ship (better-sqlite3 has NO JS fallback), so this is
    # deliberately NOT the build/Release/*.node class the rule above preserves.
    # FOLLOW-UP (durable class fix, not release-blocking): compile native addons with
    # -ffile-prefix-map / a neutral node-gyp cache dir so __FILE__ never captures the
    # box path — that would remove the leak at the source for ALL addons.
    ("ssh2-native-crypto-addon",
     re.compile(r"(^|/)sshcrypto\.node$"),
     ["sshcrypto.node"]),
    ("scratch-or-tmp", re.compile(r"(^|/)(scratch|scratchpad|test-results|\.agent-tmp|\.vitest-tmp|\.tmp|\.tmp-[^/]*|\.pcv-socktest|\.nx|__pycache__|docs\.old\.[0-9]+|\.vite|\.vite-temp)/|(^|/)(junit\.xml|\.modules\.yaml)$"),
     ["scratch", "scratchpad", "test-results", ".agent-tmp", ".vitest-tmp", ".tmp",
      ".tmp-*", ".pcv-socktest", ".nx", "__pycache__", "docs.old.*",
      # Vite's dep-optimizer cache bakes the absolute build path into every dep it
      # pre-bundles; junit.xml carries the build hostname. Both are build output.
      ".vite", ".vite-temp", "junit.xml",
      # pnpm's metadata file. npm never reads it, and it is a map of absolute paths
      # into a store that does not exist on any other machine (WI-4427).
      ".modules.yaml"]),
    ("agent-config", re.compile(r"(^|/)(\.claude|\.harness)/"),
     [".claude", ".harness"]),
    # Internal fleet-coordination artifacts: briefs agents write to each other, and
    # the plan/handoff notes beside them. Nobody we hand a build to needs these, and
    # they are AGENT-AUTHORED CONTINUOUSLY — a new brief naming a box path lands every
    # day. Scrubbing them one by one would make this gate a treadmill that reds every
    # cut; excluding the class ends it. (apps/operator-docs is PARTLY product docs and
    # DOES ship — but not wholesale: its internal build-infra sections are excluded by
    # the "internal-infra-docs" rule below, which is the WI-4723 creds leak. Do not read
    # this rule as blessing the whole operator-docs tree.)
    ("internal-agent-artifacts", re.compile(r"(^|/)(agent-briefs|docs/plans)/"),
     ["agent-briefs", "docs/plans"]),
    # Dev-box ops infra: the systemd unit/timer templates under
    # apps/operator/scripts/systemd/ are for THIS build box's services (kopia
    # backups, the db-backup alerter, the mcp-proxy / inference-gateway units,
    # …). They are never installed by — nor needed to RUN — the shipped Tauri
    # desktop app, and several bake this box's absolute paths
    # (ExecStart=/home/<owner>/.config/kopia/…, WI-4419) that the release audit
    # forbids. EXCLUDE the class (D-004, desktop-v0-0-12): the source-scrub
    # convention is redact-must-ship / EXCLUDE-never-ship, and a dev ops unit is
    # never-ship — excluding it (vs redacting its paths, which would break it as a
    # dev unit) is the root-cause fix and keeps a future unit that names a box path
    # from re-redding the cut.
    ("dev-systemd-units", re.compile(r"(^|/)scripts/systemd/"),
     ["scripts/systemd"]),
    # Test files never ship in — nor are needed to RUN — the product: no runtime
    # code imports a *.test.* / __tests__/ module (verified across apps+libs+
    # packages). They are pure bulk in source.tar.zst, and a handful embed identity
    # literals AS TEST DATA (D-004: carry-surface-provenance-stamp.test.ts asserts
    # on `[owner:owner]` linting; bash-resource-gate/coord-hook assert the
    # `loginctl terminate-user <user>` literal) that MUST NOT be scrubbed — doing so
    # rewrites the assertion and reds the green gate. So the correct handling is
    # EXCLUDE-from-ship, not redact: the tests keep their literals in the tree (green
    # gate stays green) and simply never reach any shipped bundle (tar, AppImage
    # AppDir, mac .app). Excluding the CLASS (not the 5 current leakers) ends the
    # treadmill — the next test that names an identity can never leak into a cut.
    ("test-files",
     re.compile(r"(^|/)__tests__/|(^|/)[^/]+\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$"),
     ["__tests__",
      "*.test.ts", "*.test.tsx", "*.test.mts", "*.test.cts",
      "*.test.js", "*.test.jsx", "*.test.mjs", "*.test.cjs",
      "*.spec.ts", "*.spec.tsx", "*.spec.mts", "*.spec.cts",
      "*.spec.js", "*.spec.jsx", "*.spec.mjs", "*.spec.cjs"]),
    ("vcs", re.compile(r"(^|/)\.git/"),
     [".git"]),
    ("dotenv", re.compile(r"(^|/)\.env(\.|$)"),
     [".env", ".env.*"]),
    ("shell-rc", re.compile(r"(^|/)\.(bashrc|bash_profile|bash_history|profile|zshrc|zprofile)$"),
     [".bashrc", ".bash_profile", ".bash_history", ".profile", ".zshrc", ".zprofile"]),
    ("credential-file", re.compile(r"(^|/)(\.npmrc|\.netrc|\.git-credentials|\.gitconfig|\.mcp\.json.*)$"),
     [".npmrc", ".netrc", ".git-credentials", ".gitconfig", ".mcp.json", ".mcp.json.*"]),
    ("credential-dir", re.compile(r"(^|/)(\.ssh|\.aws|\.gnupg)/"),
     [".ssh", ".aws", ".gnupg"]),
    ("console-turd", re.compile(r"(^|/)\.papercup-console-active\."),
     [".papercup-console-active.*"]),
    ("next-build-cache", re.compile(r"(^|/)\.next/"),
     [".next"]),
    # Any tool's build cache (storybook, babel, eslint, …). These are generated on
    # THIS box and bake its absolute paths into their artifacts — every one of the
    # 8 `/home/<owner>` hits in the 0.0.8-era bundle came from
    # */node_modules/.cache/storybook/**/manager-bundle.js. Nothing in a .cache/ is
    # needed to RUN the tree (it exists to make the next BUILD faster), so this is
    # a leak class we delete rather than scrub.
    ("build-cache", re.compile(r"(^|/)\.cache/"),
     [".cache"]),
    # verdict-cli keeps live per-agent daemon/session state inside its installed
    # package. It is mutable runtime residue, not a dependency needed to run the
    # shipped source bundle; leaving it in node_modules leaks session identities
    # (and can include bearer state). Keep this rule here, alongside the dependency
    # generation prune, so tar staging and the fail-closed audit share one source
    # of truth (WI-871887 / WI-10001909).
    ("verdict-cli-runtime-state", re.compile(r"(^|/)\.verdict-data/"),
     [".verdict-data"]),
    # Pagefind search-index shards (apps/*/dist/**/pagefind/index/*.pf_index,
    # apps/operator/public/**/pagefind/**, apps/operator-docs/dist/pagefind/**).
    # Pagefind TOKENISES the docs it indexes into these binary shards — the
    # 0.0.9 cut red'd here on `\bAvi\b` ×3, the owner's own git user.name, baked
    # into en_143e775.pf_index because an internal doc names them (WI-4419). The
    # shipping markdown itself was clean; only the generated index carried it, and
    # a .pf_fragment shard would likewise carry the raw home-path of any doc that
    # cites one. Nothing SERVER-side reads these (client docs-search loads them in
    # the browser from the built static output; the docs markdown still renders and
    # search just returns empty until pagefind is re-run) — a generated, regenerable,
    # not-needed-to-RUN artifact that leaks indexed content, i.e. the .cache/ class:
    # we delete it, we do not scrub it. Scoped to the .pf_* extensions so the
    # pagefind NPM TOOL (node_modules/pagefind) and dist package-mains are untouched.
    ("pagefind-search-index", re.compile(r"\.pf_(index|fragment|meta)$"),
     ["*.pf_index", "*.pf_fragment", "*.pf_meta"]),
    # Internal engineering-docs infra sections — must NOT ship in a PUBLIC desktop
    # bundle (su-a1a71 decision 2026-07-13, WI-4419). apps/operator-docs is the
    # "Papercusp Internal" Starlight site (astro.config title), served at
    # /internal/docs: its build-system/** section documents the build-VM SSH/sudo
    # creds + admin commands + port maps, and four agent-insights runbooks document
    # the mac-VM QMP recovery / notarization / e2e pipeline. These shipped in the
    # 0.0.8 bundle carrying the mac VM's ACTUAL sudo password ('macuser') and
    # loginwindow password ('maclogin') — a real public credential leak (owner is
    # rotating). Per-secret scrubbing is whack-a-mole that re-leaks the instant
    # someone pastes the real ssh target back in; EXCLUDING the internal-infra doc
    # CLASS is the root-cause fix. The SAME content is also inlined into the
    # llms-full.txt / llms-small.txt AGGREGATE bundles (an "llms.txt" concat of the
    # whole docs site) which a section-exclude alone can't clean — so those drop too.
    # Every leaking file lives under one of these shapes across ALL of
    # src/content/docs, dist/, and the served apps/operator/public/internal/docs
    # copy (verified: this set == the entire macuser/maclogin footprint in shipping
    # paths). build-desktop-sidecar.sh:720's docs-qa copy inherits the exclusion
    # (it copies FROM the already-staged source). (The two vendored
    # node_modules/*/llms-full.txt this also drops — stream-json, stream-chain — are
    # npm `files`-array docs, NOT `exports`/`main` runtime entries, so dropping them
    # breaks nothing.) NONE of these basenames/dirs collide with a vendored RUNTIME
    # entry (checked: no build-system/ dir and no runbook basename in node_modules).
    # NB build-system has BOTH a build-system/ subtree AND a build-system.{html,md}
    # section LANDING page (Astro renders a section index as a sibling file) — the
    # dir glob prunes the subtree, the .html/.md globs catch the landing twin.
    #
    # DURABILITY (0.0.9 cut#3c ARRIVES, su-a1a71 named the residual): a per-file
    # name list is a treadmill — cut#3c's bundle still shipped two creds-FREE mac-VM
    # runbooks the named set had never heard of (copying-artifacts-off-the-mac-vm,
    # macos-ppid-1-is-not-an-orphan-signal — both disclose the mac VM alias
    # papercup-vm-mac + loopback:2222; no passwords, but internal build topology that
    # must not ship). So beyond naming those two, a basename glob `*mac-vm*` catches
    # ANY current-or-future agent-insights runbook about the mac build VM with no new
    # edit each time (it subsumes mac-vm-qmp-recovery / mac-vm-e2e-battery, kept
    # explicit as the known-critical plaintext-password file). We deliberately do NOT
    # blanket `macos-*`: a real PRODUCT doc could legitimately name macOS, so the two
    # known build-infra macos-* runbooks are listed by name, not by prefix.
    ("internal-build-infra-docs",
     re.compile(r"(^|/)build-system(/|\.(html|md)$)"
                r"|(^|/)(mac-vm-qmp-recovery|mac-vm-e2e-battery"
                r"|macos-signing-notarization-runbook"
                r"|macos-ppid-1-is-not-an-orphan-signal"
                r"|copying-artifacts-off-the-mac-vm"
                r"|federation-public-release-known-limitations"
                r"|agent-insights-index)\.(mdx|md|html)$"
                r"|(^|/)[^/]*mac-vm[^/]*\.(mdx|md|html)$"
                r"|(^|/)(llms-full|llms-small)\.txt$"),
     ["build-system", "build-system.html", "build-system.md",
      "mac-vm-qmp-recovery.*", "mac-vm-e2e-battery.*",
      "macos-signing-notarization-runbook.*",
      "macos-ppid-1-is-not-an-orphan-signal.*",
      "copying-artifacts-off-the-mac-vm.*",
      "*mac-vm*.mdx", "*mac-vm*.md", "*mac-vm*.html",
      "federation-public-release-known-limitations.*",
      "agent-insights-index.*",
      "llms-full.txt", "llms-small.txt"]),
    # Astro's content-collection build cache (apps/operator-docs/node_modules/.astro/
    # data-store.json): Astro serialises EVERY doc's rendered content into this store
    # at build time, so it inlines the same build-system creds the docs exclusion
    # above removes — and it is a regenerable build cache (the .cache/.vite class),
    # never read to RUN the tree. Delete, don't scrub. (Nested under node_modules,
    # so the top-level allowlist can't reach it — this rule can.)
    ("astro-build-cache", re.compile(r"(^|/)\.astro/"),
     [".astro"]),
    # Rust/Cargo build target dirs (apps/tui/target, apps/pui-*/target,
    # libs/**/src-tauri/target, …) at ANY depth. A cargo target bakes THIS build
    # box's absolute home path into .rustc_info.json, the *.d dep-files and the
    # release binaries — the 0.0.9 mac leg leaked /Users/<owner> ×8075 out of
    # apps/tui/target/ and this gate red'd the cut (WI-4419). The size-class
    # `./target` in stage-source-tree.sh only anchors the MONO ROOT, so a nested
    # crate target sailed straight through.
    #
    # GLOBS ARE DELIBERATELY EMPTY (gate-only) — the ONE rule in this file that
    # cannot self-emit its own exclude. print_tar_excludes() would turn a `target`
    # glob into `./target` + `*/target`, and `*/target` drops
    # node_modules/weapon-regex/core/target/ — a VENDORED package's RUNTIME entry
    # (its package.json `exports` resolve to ./core/target/js-3/weapon-regex-opt/
    # main.js), silently corrupting the shipped toolchain. So the EXCLUDE is
    # generated node_modules-SAFELY in stage-source-tree.sh (find real cargo targets
    # OUTSIDE any node_modules); THIS rule is the fast path-phase backstop that fires
    # only if that exclude ever misses, and the content identity scan is the ultimate
    # backstop. The regex is likewise node_modules-scoped so weapon-regex's legit
    # target/ (and any nested-node_modules vendored target) never trips it.
    ("cargo-build-target",
     re.compile(r"^(?!.*(?:^|/)node_modules/)(?:.*/)?target/"),
     []),
]

# ── CONTENT: real credential VALUES (grep -E, C speed). Not the word "secret".
#
# The phx_/phc_ rules absorb bin/audit-bundle.sh (now a pure delegate to this file,
# WI-10003577), which was a SEPARATE "privacy
# auditor" release-local.sh already ran on the finished .deb/.dmg — and which
# could never have caught this leak: it greps the EXTRACTED bundle, where
# source.tar.zst is still a single zstd blob. It was structurally blind to the
# 2.7 GB of plaintext inside it. One gate, every leak class, both objects.
CREDENTIAL_ERE = [
    ("anthropic-key", r"\bsk-ant-(api|oat)[0-9]{2}-[A-Za-z0-9_-]{40,}"),
    ("openai-key", r"\bsk-(proj-)?[A-Za-z0-9]{40,}"),
    ("github-token", r"\bgh[pousr]_[A-Za-z0-9]{36,}"),
    # The VALUE must look like an AWS secret (40 chars of the key alphabet), not
    # merely "30+ non-space chars after an =". The loose form matched wrangler's
    # own JavaScript — `aws_secret_access_key === …typeof` — and our OWN
    # secret-scrubber's pattern list: the gate was convicting secret-DETECTION code
    # of being a secret. A gate that cries wolf is a gate that gets an exception
    # added to shut it up, which is the failure it exists to prevent.
    ("aws-secret-key", r"aws_secret_access_key[[:space:]]*[=:][[:space:]]*[\"']?[A-Za-z0-9/+]{40}"),
    ("slack-token", r"\bxox[abprs]-[A-Za-z0-9-]{20,}"),
    # PostHog: phx_ is a WRITE-side personal key (the one that must never ship);
    # phc_ is an anonymous-capture project key — see BENIGN for the one we ship.
    ("posthog-personal-key", r"\bphx_[A-Za-z0-9_]{30,}"),
    ("posthog-project-key", r"\bphc_[A-Za-z0-9_]{30,}"),
]

# Documented false positives, each one traced to a real file. This is NOT a
# parking lot for findings you would rather not deal with: every entry names the
# thing it is silencing, and if you cannot name it, it is not benign — it is
# unclassified, and an unclassified finding fails the build.
BENIGN_ERE = [
    r"AKIAIOSFODNN7EXAMPLE",                        # AWS's own doc placeholder
    r"sk-ant-(api|oat)[0-9]{2}-(test|fake|dummy|example)",
    # @octokit/auth-token/README.md — the docs' own fake tokens
    r"gh[pousr]_(PersonalAccessToken|InstallationUserToServer|InstallallationOrActionToken)",
    # The ONE deliberately-public key every build ships (posthog-public-defaults.ts):
    # anonymous-capture only, cannot read events. Shipping it is the feature.
    # ⚠ ROTATION SYNC (WI-5013 0.0.11 cut red, 2026-07-15): this literal exists in
    # TWO places that must move together — posthog-public-defaults.ts (the shipped
    # value) and HERE. (A third copy, bin/audit-bundle.sh PUBLIC_PROJECT_KEY, drifted
    # the other way and redded the 0.0.22 cut on lost-pixel's vendor key below; that
    # script is now a pure delegate to this gate — WI-10003577.) When rotating:
    # update both in the same change.
    r"phc_nm3LSXkJKynGzsGTZfwqUywbrfsryNNNVWrxHy7Kriug",
    # Third-party vendors' OWN public anon keys, compiled into their npm packages:
    # mem0ai/dist/* and lost-pixel/dist/constants.js. Not our secrets, and not ours
    # to rotate. (That these libraries carry live telemetry keys at all is a real
    # product-privacy question — filed separately — but it is not a leak OF OURS,
    # and failing our release build on a vendor's key would teach agents to ignore
    # this gate.)
    r"phc_hgJkUVJFYtmaJqrvf6CYN67TIQ8yhXAkWzUn9AMU4yX",
    r"phc_RDNnzvANh1mNm9JKogF9UunG3Ky02YCxWP9gXScKShk",
]

# Exact-value acceptances for credential-shaped THIRD-PARTY published bytes.
# Store only SHA-256 identities, never the token-looking bytes themselves and
# never a broad regex. The first two values are deterministic string-table
# concatenations in the upstream gh 2.80.0 linux/amd64 executable (file SHA-256
# bed75733a24bea4fed8eb4315513c1f51cb2dd68aeaf798f01b9030f50fd8dd4), not
# credentials. The third is the OAuth access-token JSDoc example published twice
# in @workos-inc/node 10.10.0's src/pipes/pipes.ts and repeated by its ESM, CJS,
# declaration, and source-map outputs. It was reviewed against WorkOS's public
# v10.10.0 tag. A one-byte change is a different digest and still fails closed;
# test/release-identity-scan-archives.test.js exercises that negative control.
BENIGN_CREDENTIAL_VALUE_SHA256 = {
    "902a57265300171f27289680dac688d3c2354f0893c50f89ec0522e0e123c3fe",
    "969f9aa3fba6e5195cb91063037eb9e5b00224886de6dc1667cc3b1e38da6dfc",
    "bc3ae723f57c6b9e3fd80b699fcc420f6074b0b1718039669d22631d508ac0a7",
}

_BENIGN_CREDENTIAL_RX = [re.compile(b) for b in BENIGN_ERE]


def credential_rule(value):
    """The CREDENTIAL_ERE rule name a matched value belongs to."""
    for name, pat in CREDENTIAL_ERE:
        if re.search(pat.replace("[[:space:]]", r"\s"), value):
            return name
    return "credential"


def is_benign_credential(value):
    """True when a credential-shaped VALUE is on a documented acceptance list.

    The one classifier for both credential passes — phase B over source.tar.zst and
    scan_dir over the assembled/finished bytes — so the two can never disagree about
    what is benign (WI-10003577: a separate scanner with its own one-key list did).
    """
    if any(rx.search(value) for rx in _BENIGN_CREDENTIAL_RX):
        return True
    return hashlib.sha256(value.encode()).hexdigest() in BENIGN_CREDENTIAL_VALUE_SHA256


# Attribution reads whole members into memory to regex them. Phase B has already
# convicted the bundle by this point, so a member too big to attribute costs us a
# file NAME, never a missed leak — the build fails either way.
MAX_ATTRIBUTE_BYTES = 8 * 1024 * 1024


# ── KNOWN SENSITIVE IDENTITIES — the cross-identity blind spot fix (WI-4419).
#
# identity_literals() below resolves ONLY the box RUNNING the build. On a
# multi-box release that is a hole the size of the release: the LINUX leg hunts
# its own 'builduser' and is blind to the mac VM's 'macuser'; the mac leg
# hunts 'macuser' and is blind to 'builduser'; a value owned by NEITHER box
# (the mac loginwindow password 'maclogin') is hunted by nobody. That blind spot
# is exactly how the 0.0.8 mac bundle shipped the mac VM's sudo password
# ('macuser') and login password ('maclogin') to the public while every leg's
# per-box audit passed. So these literals are hunted on EVERY build regardless of
# which box runs it — the fixed backstop beneath the per-box scan. All are
# high-entropy by construction (≥7 chars / contain '-'), so they hunt EVERYWHERE
# incl node_modules as plain substrings (never the bare-first-name word-boundary
# path). This is a DENYLIST OF KNOWN LEAKED IDENTITIES — each entry a real value
# that has leaked or would leak cross-box — NOT a generic name regex, so it does
# not cry wolf on a vendor package.json maintainer field.
KNOWN_SENSITIVE_IDENTITIES = {
    "known-sensitive:mac-vm-user": "macuser",           # mac VM unix user AND its sudo password
    "known-sensitive:mac-vm-login": "maclogin",           # mac VM loginwindow password
    "known-sensitive:linux-build-user": "builduser",  # linux build-box unix user
    # Owner's GitHub handle. Added from a MEASURED leak, not prophylactically
    # (EI-20108164746219771): it occurs 10x inside the shipped seed corestore,
    # alongside two github_user_id values. It is owned by no box's `whoami`, so
    # identity_literals() — which resolves only the building machine — could never
    # have produced it; it is precisely the cross-identity class this denylist is
    # the backstop for. len 6, so needs_word_boundary() is False and it is hunted
    # EVERYWHERE as a plain substring, which is what we want for a handle.
    "known-sensitive:owner-github-handle": "ownerhandle",
}


# Product strings that LEGITIMATELY embed a denylisted identity literal and must
# ship (WI-38233, 2026-08-12). Each was MEASURED as a non-incidental use in the
# 0.0.16 bundle, not assumed — the two incidental ones found in the same
# sweep (a UI placeholder "ownerhandle10", a test workspace name in a prose string)
# were fixed at SOURCE instead of being listed here, which is the default and
# should stay the default.
#
#   • papercusp-cupboard.ownerhandle.workers.dev — the Cupboard worker host. The handle
#     is the Cloudflare ACCOUNT SUBDOMAIN, so it is in a hostname the shipped app
#     must resolve and connect to: it is on the wire for every user no matter what
#     these bytes say. Scrubbing it does not hide the handle, it only breaks the
#     client. Removing it for real means moving the worker to a custom domain —
#     infrastructure, not a release fix.
#     ⚠ 2026-09-05 (WI-38321): the custom domain cupboard.papercusp.com EXISTS and
#     is bound to this worker (proven by a byte-identical /listings payload), but
#     its DNS FLAPS between the Cloudflare edge and the stale 18.204.152.241 apex
#     — so the operator default cannot move to it yet, and this entry must STAY.
#     Delete it only once that flap is fixed AND the default has actually moved;
#     removing it earlier makes the gate red rather than merely unused.
#   • RETIRED 2026-09-05 (WI-38322) — the CANONICAL_HIVE_TEAM_ALLOWLIST pair, in
#     both quoting styles. It was accepted on the premise that scrubbing the team
#     allowlist would break hive invites outright. Commit 3af797a3d3 removed the
#     owner's login from that constant instead — it is merged back in at RUNTIME
#     from state.githubLogin and deduped, so nothing broke — and from then on the
#     entry accepted nothing. MEASURED 2026-09-05 in the shipped 0.0.17 sidecar:
#     both quoting styles occur 0 times, while the post-fix compiled form
#     ["papercupai"] occurs 4 (positive control). A DEAD acceptance is not merely
#     tidy-up: the rule below is ARITHMETIC, so re-adding a real login to the
#     allowlist would have had those bytes counted as authorised and PASSED —
#     the acceptance would have silently re-licensed the exact leak this entry
#     was created to disclose. Do not restore it; and do not "fix" a future audit
#     hit by re-adding a login to canonical-hive-team-allowlist.ts.
#
# This is an ACCEPTANCE, not an exclude, and it is COUNTED rather than matched: a
# file is accepted only when EVERY occurrence of the literal sits inside one of
# these strings. One unexplained occurrence and the file still FAILS — so a new
# leak of the bare handle still reds the gate, including inside these very files.
# Where a literal has two quoting styles, BOTH must be listed: only the minified
# bundle is measured above, and an unminified build emits the source form.
AUTHORISED_PRODUCT_STRINGS = ("papercusp-cupboard.ownerhandle.workers.dev",)


def _count_occurrences(path, needle):
    """Exact byte-count of `needle` in `path`.

    Used only for the AUTHORISED strings, which are long exact literals.
    Fails CLOSED: an unreadable path returns -1, which can never satisfy the
    "every occurrence is authorised" equality, so the file keeps FAILING rather
    than being quietly accepted on bytes nobody read.
    """
    try:
        with open(path, "rb") as fh:
            return fh.read().count(needle.encode("utf-8", "surrogateescape"))
    except Exception:
        return -1


def _count_literal(path, lit):
    """Occurrences of an IDENTITY LITERAL, counted exactly as the scan MATCHES it.

    This must mirror grep_l()'s asymmetry or the arithmetic below compares two
    different things. Measured on the 0.0.16 serve.mjs: the low-entropy literal
    (the owner's 3-letter git user.name) occurs 15x as a plain substring — inside
    ordinary English words such as "Available" — and ZERO times as the
    word-boundary match the scan actually uses. Counting it as a substring left 15
    phantom "unaccounted" occurrences and wrongly kept a clean file failing, which
    made the acceptance unreachable for any real bundle.

    Fails CLOSED: any error returns -1.
    """
    flag = "-oIE" if is_low_entropy(lit) else "-aoE"
    try:
        r = subprocess.run(["grep", flag, lit_ere(lit), path],
                           capture_output=True, text=True)
        if r.returncode not in (0, 1):
            return -1
        return sum(1 for ln in r.stdout.splitlines() if ln)
    except Exception:
        return -1


# ── STAGING SCRUB (WI-4419 durable; desktop-v0-0-12-release-tri-platform#D-004).
# Dev-infra and agent-authored SOURCE keep re-introducing this box's identity into
# must-ship files — [owner:owner] provenance comments in prod .ts/.sql, dev systemd
# ExecStart=/home/<user> paths, test fixtures hardcoding the build username. Those
# files cannot be pruned (they ship / run), and a per-file source edit is a
# treadmill that reds the next cut the moment a new tag lands. So bin/stage-source-
# tree.sh redacts these literals in a COPY of each leaking source file at tar time
# (a --transform overlay, streaming — never the working tree, never node_modules).
# The literal→placeholder map lives HERE, next to the identities it neutralises, so
# the stager derives it from --identity-literals and cannot drift (the same ONE-rule
# discipline as --tar-excludes). Keyed by identity KEY (stable across build boxes),
# NOT value. A value with no explicit token falls back to "redacted".
# This does NOT weaken the gate: the gate still fails on any UN-redacted identity in
# the produced bytes — the scrub removes the leak, it does not hide it.
REDACTION_BY_KEY = {
    "build-user-name": "builduser",
    "build-home-path": "/home/builduser",
    "build-hostname": "buildhost",
    "build-git-email": "owner@example.invalid",
    "build-git-name": "owner",
    "known-sensitive:mac-vm-user": "macuser",
    "known-sensitive:mac-vm-login": "maclogin",
    "known-sensitive:linux-build-user": "builduser",
    # Explicit rather than relying on the "redacted" fallback: the fallback maps
    # EVERY unlisted key to the same token, so two different leaked identities would
    # scrub to identical bytes and become indistinguishable in the staged tree.
    "known-sensitive:owner-github-handle": "ownerhandle",
}


#: The scrubber's OUTPUT vocabulary. A literal equal to one of these is never an
#: identity to hunt: the public-source cut redacts THIS FILE with the same map, so
#: KNOWN_SENSITIVE_IDENTITIES arrives there as {"builduser", "ownerhandle", …}, and
#: hunting those in a tree the scrub produced reds the gate on its own redactions
#: (measured: a fresh public-clone AppImage refused on `/home/builduser/…` and
#: `ownerhandle6` in a shipped plan-audit JSON). Mirrors GENERIC_USERS'
#: scrubber-vocabulary entries in scripts/lib/identity-leak-patterns.mjs.
_REDACTION_PLACEHOLDERS = frozenset(
    v.casefold() for v in list(REDACTION_BY_KEY.values()) + ["redacted"]
)


def is_redaction_placeholder(value):
    return bool(value) and value.casefold() in _REDACTION_PLACEHOLDERS


def _drop_placeholders(lits):
    return {k: v for k, v in lits.items() if not is_redaction_placeholder(v)}


KNOWN_SENSITIVE_IDENTITIES = _drop_placeholders(KNOWN_SENSITIVE_IDENTITIES)


# ── The owner's NAME when git can no longer supply it ────────────────────────
# DELIBERATELY the same variable the TS site gate reads
# (apps/operator/lib/release/release-content-scrub.ts, OWNER_NAME_ENV): two gates
# guarding one release must not need two different answers to the same question.
# Read at run time and never stored — writing the owner's name into a source file
# so we can search for it would BE the leak, committed to git forever.
OWNER_NAME_ENV = "PAPERCUSP_RELEASE_OWNER_NAME"

# The owner's EMAIL, same contract as the name. Needed because — unlike the TS scrub,
# which catches any address by SHAPE via IDENTITY_PATTERNS — this audit has no shape rule
# for email: `build-git-email` is its ONLY email detection. So dropping an automation
# address below without offering this would silently zero out the email class entirely.
OWNER_EMAIL_ENV = "PAPERCUSP_RELEASE_OWNER_EMAIL"

# Git identities belonging to AUTOMATION rather than to a person. Mirrors
# AUTOMATION_NAME_RE in release-content-scrub.ts — keep the two in step.
AUTOMATION_NAME_RE = re.compile(
    r"(^|[-_ ])(agent|bot|ci|runner|automation|service|actions|daemon|noreply)([-_ ]|$)|\[bot\]",
    re.I,
)


def looks_like_automation_identity(value):
    """True when a git identity is a machine's, not a person's."""
    return bool(AUTOMATION_NAME_RE.search(value.strip()))


# An ADDRESS needs its own test, and finding that out cost a wrong fix: AUTOMATION_NAME_RE
# anchors on [-_ ] boundaries, but in a `<user>@users.noreply.github.com` form the
# separators are DOTS, so `noreply` never matched and the address sailed through unchanged.
# (The first attempt at this fix shipped that regex, and the scan still exited 1.)
#
# Deliberately NOT solved by adding `.`/`@` to that name regex: widening it would start
# eating real people (`alice.service@…` would match `service` between a dot and an at-sign)
# and a false DROP on the email class is a silent loss of coverage — the failure direction
# this whole item is about. So: a targeted test for the actual conventions automation
# addresses use, leaving human-name matching untouched.
AUTOMATION_EMAIL_RE = re.compile(
    r"(^|[-_.+])(no-?reply|bot|ci|build|actions|automation|daemon|jenkins|dependabot|renovate)([-_.+]|@)"
    r"|\bnoreply\b"
    r"|users\.noreply\.github\.com$"
    r"|\[bot\]",
    re.I,
)


def looks_like_automation_email(value):
    """True when an address belongs to automation rather than to the human owner.

    A bot's public noreply address is not a private identity: it is in every commit on the
    public repo by construction, so redacting it protects nobody while guaranteeing a
    permanent false positive wherever the project legitimately hardcodes it.
    """
    return bool(AUTOMATION_EMAIL_RE.search(value.strip()))


def explicit_owner_values(env_var):
    """The owner literals ASSERTED for this run, parsed from one env var. ONE rule.

    SEPARATOR IS COMMA/SEMICOLON ONLY — deliberately NOT whitespace. A first draft split on
    \\s too and tore "Jane Doe" into "Jane" + "Doe", which is wrong twice: it never hunts
    the full name, and it injects a bare surname as its own low-entropy literal that then
    matches innocent words across the bundle. Names contain spaces; addresses do not, so
    nothing is lost by dropping whitespace as a separator.
    """
    raw = os.environ.get(env_var, "")
    return list(dict.fromkeys(v.strip() for v in re.split(r"[,;]", raw) if v.strip()))


def has_owner_name_literal(lits):
    """Can this literal set actually detect the owner's NAME?

    The name is the one identity class with NO SHAPE to fall back on. A home path or
    an email is still caught structurally even when no literal knows it; a bare first
    name is only ever a literal. So when this is false the scan cannot see the name at
    all, and a CLEAN verdict degrades to "I looked for nothing" while still reading as
    proof. Callers that SHIP must fail closed on false.

    ⚠ REQUIRES THE **EXPLICIT** VALUE, and deliberately ignores anything git supplied.
    An earlier version of this fix accepted a git-derived name so long as it did not match
    looks_like_automation_identity(). That is a DENYLIST, and a denylist fails OPEN for
    every identity nobody thought of — which stopped being hypothetical within the hour:
    this box's user.name changed from one automation identity to a differently-spelled one
    ("…-agent" → "…-buildbox"), the pattern list did not carry the new token, the bot read
    as a person, and this function returned True again while the scan hunted a machine's
    name. The same defect, one level up, with the fix already in place.

    git config names the COMMITTER. On an automated box that is by construction not the
    owner, and no pattern list can reliably separate the two. So the gate stops guessing:
    the owner identity must be ASSERTED by whoever runs the release. The heuristic is still
    worth keeping — it stops a bot's name being hunted uselessly and keeps redaction honest
    — but it is a convenience, never the thing a CLEAN verdict is allowed to rest on.
    """
    return bool(explicit_owner_values(OWNER_NAME_ENV))


def _owner_values(lits, base):
    """Every non-empty literal for one owner class — `base`, `base-2`, `base-3`, ...

    The owner side is PLURAL because a person is: measured on this repo's own history,
    three distinct non-automation addresses match the owner's name pattern. A single-value
    argument would let one invocation hunt one of them and still print an unqualified
    CLEAN — certifying the class while leaving the rest unhunted, which is the very shape
    of defect this file is being hardened against. The alternative (re-run the audit once
    per address) is an unenforceable process convention, and the next person will not know
    to follow it. Put it in the data model instead.
    """
    out = []
    for k, v in lits.items():
        if k == base or k.startswith(base + "-"):
            v = str(v).strip()
            if v:
                out.append(v)
    return out


def redaction_key(key):
    """REDACTION_BY_KEY lookup key, with the plural `-2`, `-3` suffix normalised off.

    All of one owner's addresses share a single placeholder ON PURPOSE — they are one
    identity, and the fallback's warning about distinct identities collapsing to the same
    token does not apply within a class.
    """
    return re.sub(r"-\d+$", "", key)


def identity_coverage_gaps(lits):
    """Identity classes a CLEAN verdict from this run does NOT cover.

    A pass must never claim more than it checked. The NAME class is fail-closed at both
    entry points, so reaching CLEAN proves the name was hunted. The EMAIL class is not:
    this audit has no shape-based email rule (unlike the TS scrub's IDENTITY_PATTERNS),
    so if no email literal resolves, email coverage is simply ZERO and every downstream
    reader still sees an unqualified "✓ CLEAN".

    That silence is the exact mechanism of EI-20583328178472869 — the verdict outliving
    the evidence it was based on. This file already argues the case for coverage of FILES
    ("a scan that inspects nothing is indistinguishable from a scan that found nothing");
    it had simply never applied it to the CLASSES. Call it out IN the verdict.

    Returns a list of human-readable gaps; empty means the verdict is unqualified.
    """
    gaps = []
    # Counts ASSERTED addresses only, for the same reason has_owner_name_literal does: a
    # git-derived address identifies the committer, and on this box that has twice been an
    # automation. Counting it would inflate the coverage claim with a value nobody vouched.
    emails = explicit_owner_values(OWNER_EMAIL_ENV)
    if not emails:
        gaps.append(
            f"EMAIL not covered — no owner-email literal resolved "
            f"(git user.email is unset or an automation address). "
            f"Set {OWNER_EMAIL_ENV} to hunt it (accepts a comma-separated list)."
        )
    else:
        # State the COUNT, not just "covered". A person can have several addresses, and
        # "email: covered" over one of three reads as a full pass to anyone downstream.
        gaps.append(
            f"EMAIL covered for {len(emails)} address(es) — a CLEAN result says nothing "
            f"about any owner address NOT supplied via {OWNER_EMAIL_ENV}."
        )
    return gaps


def print_coverage_gaps(gaps, indent="    "):
    """Print coverage caveats beside a CLEAN verdict, or nothing when there are none."""
    for g in gaps:
        print(f"{indent}⚠ PARTIAL COVERAGE: {g}")


#: Unix logins that identify NOBODY, so the build box's login is not hunted when it is
#: one of these (its home PATH still is, as build-home-path). MUST equal
#: GENERIC_ACCOUNTS in scripts/lib/identity-leak-patterns.mjs — pinned by
#: papercusp-desktop/test/audit-identity-literal-shape.test.js. A generic login that is
#: also a word the product uses is the failure this exists for: a fresh VM whose login
#: was `tester` red-ed the Server deb on 17 files that name the `tester` agent role
#: (prompts, blueprints, SQL) and on vendor prose (open-source-release-2026-09-29 R-15,
#: build8). A personal login stays hunted, as a whole token.
GENERIC_ACCOUNTS = frozenset({
    "root", "runner", "build", "ubuntu", "node", "vscode", "codespace", "ci", "agent",
    "linuxbrew", "dev", "user", "shared", "Shared", "pcusp", "papercusp", "papercup",
    "tester", "test", "admin", "builder", "vagrant",
})


def identity_literals():
    """Machine identity as LITERAL strings, resolved from the box doing the build."""
    lits = {}
    try:
        user = pwd.getpwuid(os.getuid()).pw_name
        if user and user not in GENERIC_ACCOUNTS:
            lits["build-user-name"] = user
            # A unix login leaks as a whole TOKEN ("tester@host", "-u tester"); the
            # path form is build-home-path's job and stays a substring hunt. Matched
            # as a bare case-folded substring, a dictionary-word login corrupts and
            # reds vendor code: on a box whose user was `tester`, scrub_text rewrote
            # Monaco's `createStereoPanner` to `creabuildusereoPanner`, and the gate
            # then flagged libicu's `smokeTestERK…` and webkit's `IPCTester`.
            _WORD_BOUNDED_LITERALS.add(user)
    except Exception:
        pass
    home = os.path.expanduser("~")
    if home and home not in ("/root", "/", "/home"):
        lits["build-home-path"] = home
    host = socket.gethostname()
    # The seed cut re-execs under `bwrap --unshare-uts --hostname <neutral>` and runs this
    # probe INSIDE that child (cut-seed-cli.ts releaseSeedRedactionValues), so gethostname()
    # returns the neutral label there — the deliberate, shipped value every SST carries in
    # rocksdb.creating.host.identity. Reporting it as build-hostname fed it to the seed
    # projection AND the staged-seed guard, which red-ed cut #4 (2026-09-01) on its own fix.
    # The real build hostname reaches the child via PAPERCUSP_SEED_REAL_HOSTNAME and is
    # merged back by the caller; the neutral label is never identity.
    neutral_host = os.environ.get("PAPERCUSP_SEED_BUILD_HOSTNAME") or "papercusp-build"
    if host and host != neutral_host and not host.startswith(("runner", "ci-", "localhost")):
        lits["build-hostname"] = host
    for key, cfg in (("build-git-email", "user.email"), ("build-git-name", "user.name")):
        try:
            v = subprocess.run(["git", "config", "--get", cfg], capture_output=True,
                               text=True, timeout=5).stdout.strip()
            if not v:
                continue
            # EI-20583328178472869: `user.name` became the git-sync bot, so this gate
            # spent every build hunting a bot's name — useless — while the owner's real
            # name went unhunted and the bundle still printed CLEAN. Recording the bot
            # would ALSO leave has_owner_name_literal() true, so the blindness would stay
            # invisible. Dropping it makes the gap loud, and main() fails closed on it.
            if key == "build-git-name" and looks_like_automation_identity(v):
                continue
            # The EMAIL class, same rule, and it fails the OPPOSITE way — which is how it
            # was found. This box's user.email is the git-sync bot's noreply address, and
            # that exact string is ALSO a hardcoded public constant in the project's own
            # source (run-git-sync.ts's committer identity), which vite bundles into
            # apps/operator-vite/dist. So the "private box identity" oracle collided with a
            # deliberate public constant and the gate could never pass: a permanent FALSE
            # POSITIVE, where the name class was a permanent FALSE NEGATIVE. One cause —
            # the box's git identity repointed at shared automation — two opposite failures.
            #
            # Redacting a bot's public noreply address protects nobody: it is in every
            # commit on the public repo by construction. Do NOT "fix" this by allowlisting
            # the address or by excluding the dist directory it happened to surface in —
            # the constant lives in SOURCE and will reappear in any other build output.
            if key == "build-git-email" and looks_like_automation_email(v):
                continue
            lits[key] = v
        except Exception:
            pass
    # Explicit answers outrank whatever the box guesses (CI, a container, or a box whose
    # git identity an automation has taken over). Read at run time, never stored.
    # BOTH accept a LIST. A person has more than one address, and often more than one
    # spelling of their name; a single-value argument silently covers the first and
    # certifies the class anyway.
    #
    for env_var, base in ((OWNER_NAME_ENV, "build-git-name"), (OWNER_EMAIL_ENV, "build-git-email")):
        values = explicit_owner_values(env_var)
        if not values:
            continue
        # Explicit answers REPLACE the box's guess for that class rather than adding to it
        # — otherwise a stale git identity would linger beside the supplied truth.
        for k in [k for k in lits if k == base or k.startswith(base + "-")]:
            del lits[k]
        for i, v in enumerate(dict.fromkeys(values)):  # de-dup, order preserved
            lits[base if i == 0 else f"{base}-{i + 1}"] = v.strip()
    return _drop_placeholders(lits)


def owner_preflight():
    """Fail before expensive staging when the owner name is not asserted.

    The archive audit already refuses to certify a bundle without this literal,
    but that check runs only after tar/zstd have spent minutes producing the
    candidate. Keep this as a cheap entrypoint over the same resolver and
    predicate used by the final audit so the producer can fail before it starts
    archive work without creating a second identity policy.
    """
    lits = identity_literals()
    if has_owner_name_literal(lits):
        count = len(explicit_owner_values(OWNER_NAME_ENV))
        print(f"==> owner-name preflight: {count} explicit owner-name literal(s) resolved")
        return 0

    print(
        "✗ REFUSING TO STAGE — no owner-name literal resolved, so the release "
        "audit cannot detect the owner's name.\n"
        "  Cause: `git config user.name` is unset or belongs to automation.\n"
        f"  Fix:   export {OWNER_NAME_ENV}='<the owner's name>' for this build.",
        file=sys.stderr,
    )
    return 2


#: Literals matched on word boundaries REGARDLESS of length — populated by
#: identity_literals() with the build box's unix login. Deliberately separate from
#: is_low_entropy(): a login is still hunted in vendor code and binaries (it is not a
#: first name), it just has to be a whole token there.
_WORD_BOUNDED_LITERALS = set()


def needs_word_boundary(lit):
    """A SHORT literal must match as a whole word or it matches half the bundle.

    The owner's git user.name here is literally "owner" — the exact thing they asked
    us to keep out of a public build ("my name is owner on this machine"). An earlier
    cut of this gate skipped any literal under 4 chars, which silently made the
    owner's own example the ONE identity it could not catch. Substring-matching
    "owner" instead would fire on every .owner/owner/Avicenna in vendored code and get
    the gate switched off, so short literals match on a word boundary:
    \\bAvi\\b hits "owner Weiss", not "video.owner".
    """
    return len(lit) < 6 and lit.isalnum()


def case_fold_ere(pat):
    """Make an ERE case-insensitive by folding each letter into a class: a → [aA].

    WHY A CHARACTER CLASS AND NOT A FLAG. This one pattern is consumed by four
    engines that do NOT share a case-insensitivity switch: GNU grep (-E), Python
    re.compile (str AND bytes), and — through --identity-literals — the `sed -E`
    scrub in bin/stage-source-tree.sh, which also has to run under BSD sed on the
    mac release VM, where `s///I` is not portable. A folded class is the one form
    every ERE dialect agrees on, so the scrub and the gate cannot disagree about
    case the way they previously disagreed about it silently.

    Apply to an ALREADY re.escape()d pattern: escape() leaves alphanumerics alone
    and only introduces non-alpha metacharacters, so folding letters afterwards
    cannot corrupt an escape sequence.
    """
    return "".join(f"[{c.lower()}{c.upper()}]" if c.isalpha() else c for c in pat)


def lit_ere(lit):
    """The ERE this identity literal is searched with (GNU grep supports \\b).

    CASE-INSENSITIVE — and it must be, which cost us a shipped leak to learn
    (EI-20589264759185712). The owner's name reached the PUBLISHED 0.0.17 Linux
    deb in lowercase, inside a SQL comment ("Surfaced for owner:"), while this gate
    read the bundle CLEAN: it was hunting \\bAvi\\b, and `owner` is not `owner`.

    Because this ONE rule feeds all three legs — the gate's own scan, the
    --source-leakers set (WHICH files the stager scrubs) and the --identity-literals
    sed map (WHAT it replaces) — case-sensitivity failed all three at once and in
    the same direction: the file was never nominated for scrubbing, so nothing
    redacted it, so the gate found nothing to fail on. Three independent-looking
    proofs, one blind spot.

    The 'it would cry wolf on vendored .owner/owner' worry that justified case-sensitivity
    is handled by a DIFFERENT mechanism that already exists: is_low_entropy() scopes
    a bare first name to OUR source via is_vendor(), so node_modules is out of scope
    before case ever matters. Measured over the real non-vendor corpus at the time of
    the fix: 69 files gained, 54 of them carrying genuine identity (test fixtures with
    `username: 'owner'`, `--account owner-owner`, the box hostname `owner-dev`), and the
    only non-identity hits were prose ABOUT this tradeoff and this gate's own tests.
    """
    body = case_fold_ere(re.escape(lit))
    return rf"\b{body}\b" if is_word_bounded(lit) else body


def is_word_bounded(lit):
    """Must this literal match as a whole token? A short bare name, or the box login."""
    return needs_word_boundary(lit) or lit in _WORD_BOUNDED_LITERALS


def _literal_in_file(path, lit):
    """Is this ONE literal in this ONE file, with the scan's binary/text asymmetry?

    Used to decide whether a seed-corestore hit carries anything BEYOND the
    owner-authorised machine label. Fails CLOSED: a path we cannot read returns
    True, so "could not prove absence" keeps the file failing rather than
    quietly accepting it.
    """
    if not os.path.isfile(path):
        return True
    flag = "-qIE" if is_low_entropy(lit) else "-aqE"
    try:
        return subprocess.run(["grep", flag, lit_ere(lit), path],
                              capture_output=True).returncode == 0
    except Exception:
        return True


def is_low_entropy(lit):
    """A literal so short/common that VENDOR code hits it by coincidence.

    Same set as needs_word_boundary — a bare first name. \\bAvi\\b is necessary but
    not sufficient: node_modules/natural ships an English POS lexicon in which
    "owner" is a dictionary entry, and @huggingface/transformers' README credits a
    DIFFERENT REAL PERSON named owner. Both are word-boundary hits and neither is
    our owner.
    """
    return needs_word_boundary(lit)


def is_vendor(name):
    """Third-party code — we did not write it, so our box's identity cannot have
    ORIGINATED in it.

    This is the scoping rule for low-entropy literals ONLY. A high-entropy literal
    (/home/<owner>, the username, the hostname, an email, a credential) is still
    hunted EVERYWHERE including node_modules — those genuinely do leak into vendor
    trees, baked in by a build running on this box, and that is exactly where the
    real 0.0.8 home-path hits were found. What we refuse to do is convict a vendor
    dictionary of containing the owner's first name.

    Our own workspace packages are symlinked under node_modules, but they are also
    present at their real path (libs/, packages/, apps/), where they ARE scanned —
    so nothing we authored escapes the name check by hiding here.
    """
    n = name.lstrip("./").replace("\\", "/")
    return (
        n.startswith("node_modules/")
        or "/node_modules/" in n
        # Vditor is copied into the built SPA outside node_modules. Its checked-in
        # distribution contains the owner media-extension token, which is upstream
        # vocabulary rather than this box owner's name. Keep high-entropy hunting
        # enabled there; only the bare-name pass inherits vendor scoping.
        or "/spa/vditor/" in "/" + n
    )


_FINGERPRINTED_DIST_ASSET_RE = re.compile(
    r"^(?P<stem>.+)-(?P<fingerprint>[A-Za-z0-9_-]{8})(?P<ext>\.[^/]+)$"
)


def semantic_path_for_low_entropy(name):
    """Remove only an opaque Vite/Rollup fingerprint before matching a short name.

    A three-letter owner name has too little entropy to convict inside an opaque
    content hash.  The real 2026-08-20 collision was
    ``dist/assets/factor-aVI-w_hC.js``: ``owner`` is a whole ERE word because the
    hash contains punctuation, but it is not a semantic filename component.

    Scope this narrowly to generated ``dist/assets`` names with the measured
    eight-character fingerprint shape.  The semantic stem remains searchable, so
    ``dist/assets/owner-abcdefgh.js`` still fails while the hash-only collision does
    not.  Paths outside that generated-asset shape remain byte-for-byte unchanged.
    """
    normalized = name.replace("\\", "/")
    if "/dist/assets/" not in "/" + normalized or "/" not in normalized:
        return name
    parent, base = normalized.rsplit("/", 1)
    match = _FINGERPRINTED_DIST_ASSET_RE.fullmatch(base)
    if not match:
        return name
    return f"{parent}/{match.group('stem')}{match.group('ext')}"


@functools.lru_cache(maxsize=512)
def lit_rx(lit):
    """Memoised: phase A now calls this per MEMBER (~248k on source.tar.zst) for
    every literal and every header field, so recompiling the pattern each time is
    the difference between a header pass that costs seconds and one that costs
    minutes. `lit_ere` is a pure function of `lit`, so caching cannot go stale."""
    return re.compile(lit_ere(lit))


_OPAQUE_ASSET_REFERENCE_RE = re.compile(
    rb"[A-Za-z0-9_.-]+-(?P<fingerprint>[A-Za-z0-9_-]{8})\.js"
)
_CODE_RESOURCES_DATA_RE = re.compile(
    rb"<data>[\t\r\n ]*(?P<digest>[A-Za-z0-9+/=\t\r\n ]+?)[\t\r\n ]*</data>"
)
_MEDIA_EXTENSION_NEIGHBOURS = (b'"mp4"', b'"webm"', b'"mov"', b'"wmv"')


def low_entropy_match_is_benign(name, data, match):
    """True only for a proven non-identity use of a short owner-name token.

    A case-folded ``owner`` correctly catches authored ``owner`` identity, but also
    collides with the owner media format and with an opaque eight-character Vite
    fingerprint. Classify OCCURRENCES, never whole generated files: the same JS
    file can carry a harmless codec token and a real authored identity.

    ``data`` is bytes so this helper is shared by tar streaming, assembled-tree
    scans, and the copy-point scrubber. Every exception below is structural and
    narrow; ordinary ``@owner`` / prose / identifiers remain release-blocking.
    """
    if is_vendor(name):
        return True

    start, end = match.span()
    token = data[start:end].lower()

    # A Vite import/reference such as factor-aVI-w_hC.js: ignore the owner token
    # only when it lies wholly inside the opaque eight-character fingerprint.
    window_start = max(0, start - 160)
    window_end = min(len(data), end + 160)
    window = data[window_start:window_end]
    for asset in _OPAQUE_ASSET_REFERENCE_RE.finditer(window):
        fp_start = window_start + asset.start("fingerprint")
        fp_end = window_start + asset.end("fingerprint")
        if fp_start <= start and end <= fp_end:
            return True

    # EI-21026798895920806: Apple's generated CodeResources is XML text, but its
    # <data> bodies are opaque SHA-1/SHA-256 digests. A random digest ending
    # `/owner=` tripped the three-letter owner-name gate on all four 0.0.18 mac
    # artifacts. Accept the OCCURRENCE only when all of these structural facts
    # hold: the file is exactly a code-signature resource manifest, the match is
    # wholly inside a syntactically valid base64 <data> element, and decoding
    # yields one of the two digest widths CodeResources records. An authored
    # <string>owner</string>, key/path, or malformed/variable-width blob remains a
    # release-blocking hit.
    normalized_name = name.replace("\\", "/")
    if normalized_name.endswith("/_CodeSignature/CodeResources"):
        for element in _CODE_RESOURCES_DATA_RE.finditer(data):
            digest_start, digest_end = element.span("digest")
            if not (digest_start <= start and end <= digest_end):
                continue
            compact = re.sub(rb"[\t\r\n ]+", b"", element.group("digest"))
            try:
                decoded = base64.b64decode(compact, validate=True)
            except (ValueError, base64.binascii.Error):
                continue
            if len(decoded) in (20, 32):
                return True

    if token != b"owner":
        return False

    # FFmpeg/AviSynth source-name regex embedded in the Markdown editor bundle.
    prefix = data[max(0, start - 1):min(len(data), end + 18)].lower()
    if prefix.startswith(b"/avi(?:file)?source"):
        return True

    # Quoted owner in an actual media-extension table. Requiring two neighbouring
    # video formats avoids treating an arbitrary identity string "owner" as safe.
    quoted = (
        start > 0 and end < len(data)
        and data[start - 1:start] in (b'"', b"'")
        and data[end:end + 1] == data[start - 1:start]
    )
    if quoted:
        local = data[max(0, start - 120):min(len(data), end + 120)].lower()
        if sum(neighbour in local for neighbour in _MEDIA_EXTENSION_NEIGHBOURS) >= 2:
            return True
    return False


def unexplained_low_entropy_matches(name, data, literals):
    """Return (literal, match) rows not covered by the narrow benign classifier."""
    out = []
    for lit in literals:
        rx = re.compile(lit_ere(lit).encode())
        for match in rx.finditer(data):
            if not low_entropy_match_is_benign(name, data, match):
                out.append((lit, match))
    return out


def file_has_unexplained_low_entropy(path, display_name, literals):
    """Mirror grep's low-entropy text-only rule for one candidate file."""
    try:
        data = open(path, "rb").read()
    except OSError:
        return True  # fail closed: unreadable cannot be certified benign
    if b"\0" in data:
        return False  # the low-entropy pass deliberately skips binary bytes
    return bool(unexplained_low_entropy_matches(display_name, data, literals))


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, **kw)


def phase_a_paths(bundle, lits):
    """Member HEADERS — names, link targets, and ownership names.

    Not just names (WI-39462). This used to be `tar -tf -`, which prints member
    paths and nothing else, and phase B greps member CONTENT. A SYMLINK member
    falls between the two: its target string lives in the header's `linkname`
    field, it has zero payload bytes, and its own path is innocuous. So the owner's
    home path, committed as a tracked symlink target, was invisible to BOTH phases
    and this audit printed `✓ CLEAN` exit 0 on a bundle carrying it.

    Measured with a paired control: the SAME literal moved into a member's content
    failed correctly (exit 1, attributed), which is what makes this a header blind
    spot rather than a weak literal set. `stage-source-tree.sh` runs this mode as
    source.tar.zst's independent audit, so this was the gap that let 0.0.17 ship.

    Streaming `tarfile` over a `zstd -dc` pipe reads every header field in ONE pass
    — no second decompression — and covers ownership/pax names here too, matching
    what `_expand_tar_stream` records for the --scan-dir path.
    """
    proc = subprocess.Popen(["zstd", "-dc", bundle],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    n = 0
    hits = []
    try:
        with tarfile.open(fileobj=proc.stdout, mode="r|") as tf:
            for member in tf:
                n += 1
                name = member.name
                for rule, rx, _globs in FORBIDDEN_PATH:
                    if rx.search(name):
                        # Product templates intentionally ship their own source,
                        # checks and fixtures: those are materialized into a NEW
                        # app and are explicitly retained by the vm-release asset
                        # allowlist. Keep implementation tests forbidden anywhere
                        # else; this is the same policy at the outer-tar boundary.
                        if (rule == "test-files"
                                and _vm_release_asset_allowed(_vm_release_rel(name))):
                            continue
                        hits.append((rule, name))
                        break
                else:
                    # Every header string that can carry an identity, with the
                    # field named in the finding so it is actionable: "in path"
                    # sends you looking at a filename, which is the wrong fix when
                    # the value is really a link target or a uid name.
                    # Search each header FIELD by its own value.  Prefixing the
                    # path onto uname/gname/link values made a path collision look
                    # like four independent header findings and defeated the
                    # low-entropy path rule below.
                    fields = [("path", name, name)]
                    if member.linkname:
                        fields.append(("link target", member.linkname,
                                       f"{name} -> {member.linkname}"))
                    if member.uname:
                        fields.append(("uid name", member.uname,
                                       f"{name} [uname={member.uname}]"))
                    if member.gname:
                        fields.append(("gid name", member.gname,
                                       f"{name} [gname={member.gname}]"))
                    for k, v in (member.pax_headers or {}).items():
                        fields.append(("pax header", f"{k}={v}",
                                       f"{name} [{k}={v}]"))
                    for rule, lit in lits.items():
                        for where, searchable, display in fields:
                            candidate = searchable
                            if where == "path" and is_low_entropy(lit):
                                candidate = semantic_path_for_low_entropy(searchable)
                            if lit_rx(lit).search(candidate):
                                hits.append((f"{rule} (in {where})", display))
                                break
                        else:
                            continue
                        break
    except tarfile.TarError as exc:
        proc.kill(); proc.wait()
        print(f"AUDIT ERROR: cannot list bundle: {exc}", file=sys.stderr)
        sys.exit(2)
    finally:
        if proc.stdout:
            proc.stdout.close()
    rc = proc.wait()
    if rc != 0:
        err = proc.stderr.read().decode("utf-8", "replace").strip() if proc.stderr else ""
        print(f"AUDIT ERROR: cannot list bundle: zstd exited {rc}: {err[:300]}",
              file=sys.stderr)
        sys.exit(2)
    return n, hits


def phase_b_content(bundle, lits):
    """Concatenated content through C grep. No filenames — that is phase C's job.

    TWO passes, because the needles have different trustworthiness:
      • BROAD  — credentials + high-entropy identity, over the WHOLE bundle.
                 A hit in node_modules is real: only a build on this box could
                 have put it there.
      • NARROW — low-entropy identity (a bare first name), over OUR TEXT SOURCE
                 ONLY. Vendored dictionaries and binary/compressed bytes are full
                 of chance three-letter matches that are not our owner.
    """
    rev = {v: k for k, v in lits.items()}
    benign = " ".join(f"-e {q(b)}" for b in BENIGN_ERE)

    def scan(pats, tar_flags=""):
        if not pats:
            return []
        grep = f"grep -aoE {' '.join(f'-e {q(p)}' for p in pats)}"
        cmd = (f"zstd -dc {q(bundle)} | tar {tar_flags} -xOf - | {grep} "
               f"| grep -avE {benign} | sort | uniq -c | sort -rn")
        return [l.strip() for l in sh(cmd).stdout.splitlines() if l.strip()]

    broad = [p for _, p in CREDENTIAL_ERE]
    broad += [lit_ere(v) for v in lits.values() if not is_low_entropy(v)]
    found = []
    for line in scan(broad):
        n, _, val = line.partition(" ")
        val = val.strip()
        rule = rev.get(val)
        if rule is None:
            for name, pat in CREDENTIAL_ERE:
                if re.fullmatch(pat.replace("[[:space:]]", r"\s"), val):
                    rule = name
                    break
        if (rule in {name for name, _pat in CREDENTIAL_ERE}
                and hashlib.sha256(val.encode()).hexdigest()
                in BENIGN_CREDENTIAL_VALUE_SHA256):
            continue
        found.append((rule or "credential-or-identity", int(n), val))
    found.extend(phase_b_low_entropy_text(bundle, lits))
    return sorted(found, key=lambda row: (-row[1], row[0], row[2]))


def phase_b_low_entropy_text(bundle, lits):
    """Count short identity literals member-by-member, excluding binary files.

    The former narrow pass concatenated every non-vendor tar member and forced
    ``grep -a``.  That contradicted ``scan_dir`` and ``source_leakers``, which both
    deliberately use grep's binary-skip behavior for a three-letter name.  On the
    real source archive, random binary bytes produced four case variants of the
    owner name and made a clean build permanently red.

    Stream each member once, preserving cross-chunk matches.  Counts are committed
    only after the whole member proves NUL-free; if a later chunk reveals binary
    content, every provisional chance match from that member is discarded.  This
    keeps the fail-closed text coverage without treating compressed bytes as prose.
    """
    needles = [
        (rule, lit, re.compile(lit_ere(lit).encode()))
        for rule, lit in lits.items()
        if is_low_entropy(lit)
    ]
    if not needles:
        return []

    # Keep enough history/future bytes for low_entropy_match_is_benign() to
    # classify a match that straddles a 1 MiB chunk boundary. ``processed_start``
    # de-duplicates the overlapping windows by absolute match start.
    context = 192
    counts = {}
    proc = subprocess.Popen(["zstd", "-dc", bundle],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        with tarfile.open(fileobj=proc.stdout, mode="r|") as tf:
            for member in tf:
                if not member.isfile() or is_vendor(member.name):
                    continue
                fh = tf.extractfile(member)
                if fh is None:
                    continue
                local = {}
                tail = b""
                total_read = 0
                processed_start = 0
                binary = False
                while True:
                    chunk = fh.read(1024 * 1024)
                    if not chunk:
                        break
                    if b"\0" in chunk:
                        binary = True
                    if binary:
                        continue
                    data = tail + chunk
                    data_start = total_read - len(tail)
                    total_read += len(chunk)
                    safe_start = data_start + max(0, len(data) - context)
                    for rule, lit, rx in needles:
                        n = 0
                        for match in rx.finditer(data):
                            absolute_start = data_start + match.start()
                            if absolute_start < processed_start or absolute_start >= safe_start:
                                continue
                            if low_entropy_match_is_benign(member.name, data, match):
                                continue
                            n += 1
                        if n:
                            local[(rule, lit)] = local.get((rule, lit), 0) + n
                    processed_start = max(processed_start, safe_start)
                    tail = data[-(context * 2):]
                if not binary and tail:
                    data_start = total_read - len(tail)
                    for rule, lit, rx in needles:
                        n = 0
                        for match in rx.finditer(tail):
                            if data_start + match.start() < processed_start:
                                continue
                            if low_entropy_match_is_benign(member.name, tail, match):
                                continue
                            n += 1
                        if n:
                            local[(rule, lit)] = local.get((rule, lit), 0) + n
                if not binary:
                    for key, n in local.items():
                        counts[key] = counts.get(key, 0) + n
    except tarfile.TarError as exc:
        proc.kill()
        proc.wait()
        raise RuntimeError(f"cannot scan low-entropy tar members: {exc}") from exc
    finally:
        if proc.stdout:
            proc.stdout.close()
    rc = proc.wait()
    if rc != 0:
        err = proc.stderr.read().decode("utf-8", "replace").strip() if proc.stderr else ""
        raise RuntimeError(f"cannot scan low-entropy tar members: zstd exited {rc}: {err[:300]}")
    return [(rule, n, lit) for (rule, lit), n in counts.items()]


def phase_c_attribute(bundle, lits, wanted, per_rule=8):
    """Only on a failing build: name the offending files. Slow, and that is fine.

    Attribution MUST convict with the same regex phase B convicted with (lit_ere)
    — never a raw substring. It used to search for the bare bytes `owner`, and the
    result was a gate that was RIGHT and USELESS at the same time: the verdict
    counted 10 real `\\bAvi\\b` hits, but the file list blamed 40 innocent vendor
    files (`AVIF` in sharp's image code, `KAviBO` inside a base64 sourcemap) and
    then hit its 200-file scan cap — so not one of the 10 real offenders was ever
    printed. That is the most dangerous state a gate can be in: a red build whose
    evidence is visibly nonsense is what teaches an engineer to reach for an
    exception instead of the leak.

    Counting is therefore per RULE, not one global cap — a noisy rule must never
    be able to starve a quiet one out of the report.
    """
    # (rule, regex, vendor_scoped) — the SAME scoping phase B convicted with, or the
    # diagnosis would name files the verdict never counted (and vice versa).
    needles = [(rule, re.compile(lit_ere(val).encode()), is_low_entropy(val))
               for rule, _n, val in wanted]
    found = {}
    proc = subprocess.Popen(["bash", "-c", f"zstd -dc {q(bundle)} | cat"], stdout=subprocess.PIPE)
    try:
        with tarfile.open(fileobj=proc.stdout, mode="r|") as tf:
            for m in tf:
                if not m.isfile() or m.size > MAX_ATTRIBUTE_BYTES:
                    continue
                f = tf.extractfile(m)
                if f is None:
                    continue
                blob = f.read()
                if b"\0" in blob[:4096]:
                    continue
                vendor = is_vendor(m.name)
                for rule, rx, scoped in needles:
                    if scoped and vendor:
                        continue
                    matches = list(rx.finditer(blob))
                    if scoped:
                        matches = [match for match in matches
                                   if not low_entropy_match_is_benign(
                                       m.name, blob, match)]
                    if matches:
                        g = found.setdefault(rule, {"n": 0, "files": []})
                        g["n"] += 1
                        if len(g["files"]) < per_rule:
                            g["files"].append(m.name)
    finally:
        proc.stdout.close()
        proc.wait()
    return found


def q(s):
    return "'" + str(s).replace("'", "'\\''") + "'"


def _innoextract_command():
    """Resolve the same Inno extractor selected by the build preflight.

    The producer/consumer contract is runtime-configurable because the host may
    carry an innoextract build newer than the distro package.  If an override is
    present, do not silently substitute the PATH copy: the preflight proved (or
    rejected) the exact override, and the artifact audit must inspect bytes with
    that same consumer.
    """
    configured = os.environ.get("PAPERCUSP_INNOEXTRACT", "").strip()
    return shutil.which(configured if configured else "innoextract")


_INNOEXTRACT_INTEGRITY_WARNING = re.compile(
    r"(?:"
    r"\bchecksum\b[^\r\n]*(?:mismatch|error|fail(?:ed|ure)?)"
    r"|\b(?:mismatch|error|fail(?:ed|ure)?)\b[^\r\n]*\bchecksum\b"
    r"|\b(?:expected|actual|got)\b[^\r\n]*\bchecksum\b"
    r"|\bchecksum\b[^\r\n]*\b(?:expected|actual|got)\b"
    r"|\b(?:could not|cannot|failed to)\s+read back\b[^\r\n]*"
    r"\b(?:multi[- ]?part|slice|part)\b"
    r"|\bintegrity\b[^\r\n]*(?:warn|fail|mismatch|error)"
    r")",
    re.IGNORECASE,
)


def _innoextract_integrity_warning(result):
    """Return a concise integrity warning emitted by innoextract, if any.

    Innoextract can report a disk-spanned read/checksum failure while still
    exiting zero and leaving a non-empty partial file behind.  Treat those
    diagnostics as a failed extraction rather than trusting the process code
    or output size.  Search both streams because the extractor has used each
    for diagnostics across releases.
    """
    output = "\n".join(
        value for value in (result.stdout, result.stderr) if value
    )
    match = _INNOEXTRACT_INTEGRITY_WARNING.search(output)
    return " ".join(match.group(0).split())[:200] if match else None


def redact(v):
    return f"{v[:8]}…{v[-4:]} (len {len(v)})" if len(v) > 16 else f"{v[:3]}… (len {len(v)})"


def print_tar_excludes():
    """The stager's exclude list, DERIVED from the gate's rules — never re-typed.

    Emits both the `./X` (mono root) and `*/X` (any depth) forms, GNU tar's
    proven idiom in this repo. Nested is the half the top-level allowlist cannot
    do: the junk lives inside apps/ and packages/, and some of it is git-tracked.
    """
    for _rule, _rx, globs in FORBIDDEN_PATH:
        for g in globs:
            print(f"./{g}")
            print(f"*/{g}")
    return 0


def _rule_rx(name):
    """The compiled regex of one FORBIDDEN_PATH rule — the single source of truth
    a non-tar caller (the sidecar prune below) reuses so it can NEVER drift from
    what the release audit itself forbids."""
    for rule, rx, _globs in FORBIDDEN_PATH:
        if rule == name:
            return rx
    print(f"AUDIT ERROR: no FORBIDDEN_PATH rule named {name!r}", file=sys.stderr)
    sys.exit(2)


#: FORBIDDEN_PATH rules the sidecar prune applies. Both are LEAK CLASSES that the
#: tar-exclude path already strips from source.tar.zst but which reach the sidecar
#: by a different route, so both must be re-applied here.
SIDECAR_PRUNE_RULES = (
    "internal-build-infra-docs",
    "pagefind-search-index",
    "papercusp-state-dir",
)


def prune_docs(dirs, rules=SIDECAR_PRUNE_RULES):
    """Delete generated leak-classes from an ASSEMBLED (un-staged) docs tree.

    Why this exists: the stager's --tar-excludes only filters source.tar.zst. The
    desktop sidecar's two doc copies (build-desktop-sidecar.sh: rendered
    public/internal/docs, and the source .mdx tree for docs-qa grounding) are
    pulled from the LIVE monorepo tree and bypass that exclude entirely — so the
    in-build audit, which scans source.tar.zst, is structurally blind to them, and
    0.0.9 shipped the mac VM's sudo/login passwords inside the sidecar while every
    leg's source audit passed CLEAN (WI-4419 follow-up). Prune the SAME paths the
    release audit forbids, using the gate's OWN rules as the single source of
    truth — no second list to drift.

    ⚠ WHY `pagefind-search-index` IS IN THAT SET (WI-37620, and it is a REGRESSION
    of a leak this file already documents): this function applied ONLY the
    internal-build-infra-docs rule, so the pagefind shards under the sidecar's
    internal-docs/ shipped unpruned. tar-excludes strips them from source.tar.zst,
    which is exactly the blind spot this function exists to cover — and it was left
    half-covered. The 0.0.14 cut then red'd on the owner's bare git user.name baked
    into internal-docs/pagefind/index/en_7148dd0.pf_index — the SAME literal in the
    SAME artifact class that red'd the 0.0.9 cut. Note the source markdown is clean:
    zero shipping .mdx contains that name standalone, so pruning docs alone could
    never have fixed it — only the generated INDEX carries the indexed word.
    """
    rxs = [_rule_rx(name) for name in rules]

    def _forbidden(rel_path):
        return any(rx.search(rel_path) for rx in rxs)

    for root in dirs:
        if not os.path.isdir(root):
            print(f"    prune-docs: {root} absent — skipping")
            continue
        removed = []
        for dirpath, dirnames, filenames in os.walk(root, topdown=True):
            keep = []
            for d in dirnames:
                rel = os.path.relpath(os.path.join(dirpath, d), root)
                # test dirs WITH a trailing slash so `.../build-system/` hits the
                # rule's `(^|/)build-system/` alternative and the whole subtree goes.
                if _forbidden(rel.replace(os.sep, "/") + "/"):
                    shutil.rmtree(os.path.join(dirpath, d), ignore_errors=True)
                    removed.append(rel + "/")
                else:
                    keep.append(d)
            dirnames[:] = keep
            for fn in filenames:
                rel = os.path.relpath(os.path.join(dirpath, fn), root)
                if _forbidden(rel.replace(os.sep, "/")):
                    os.remove(os.path.join(dirpath, fn))
                    removed.append(rel)
        print(f"    prune-docs: {root} — removed {len(removed)} internal-infra path(s)")
        for r in sorted(removed):
            print(f"        - {r}")
    return 0


# ── D-043 / P-052 VM-release runtime-only payload ───────────────────────────
#
# One classifier drives BOTH deletion and certification. This is intentionally
# separate from FORBIDDEN_PATH: that table describes privacy residue across every
# distribution, while these classes are a distribution-profile contract. Dogfood
# keeps its source-rich workflow; only an explicitly selected vm-release enters
# this path.
VM_RELEASE_BOUNDARY_PATH = os.path.join(
    "apps", "operator", "runtime", "vm-release-threat-boundary.json"
)
VM_RELEASE_ASSET_ALLOWLIST = (
    "db-sql/",                   # ordered runtime migrations; names may contain test/spec
    "internal-docs/",             # rendered/served product documentation
    "harness/hooks/",             # runtime harness hooks
    "harness/identity/",          # runtime role prompt assets
    "harness/knowledge-packs/",   # runtime knowledge assets
)
VM_RELEASE_CUPBOARD_CONTENT_ROOTS = (
    "prompts",
    "templates",
    "rubrics",
    "harness/blueprints",
    "harness/templates",
)
VM_RELEASE_FORBIDDEN_ROOTS = (
    "source.tar.zst",
    "env-sidecars",
    "seed",
    "apps/operator-docs/src/content/docs",
)
VM_RELEASE_BUILD_CONFIG_NAMES = {
    "junit.xml", "makefile", "gulpfile.js", "gruntfile.js",
    "webpack.config.js", "rollup.config.js", "vite.config.js",
    "vite.config.ts", "vitest.config.js", "vitest.config.ts",
    "jest.config.js", "jest.config.ts", "tsconfig.json",
    "tsconfig.build.json", ".eslintrc", ".eslintignore", ".prettierrc",
    ".prettierignore", ".npmignore", "package-lock.json", "yarn.lock",
    "pnpm-lock.yaml",
}
VM_RELEASE_SOURCE_SUFFIXES = (".ts", ".tsx", ".mts", ".cts")
VM_RELEASE_TEST_DIRS = {"__tests__", "test", "tests"}
VM_RELEASE_TEST_FILE_RE = re.compile(
    r"(?:^|[._-])(?:test|tests|spec|fixture)(?:[._-]|$)", re.IGNORECASE
)


def _vm_release_rel(path):
    rel = path.replace(os.sep, "/")
    # os.path.relpath() may return a single leading "./" on some callers. Do
    # not use lstrip("./"): that treats its argument as a CHARACTER SET and
    # turns `.github` into `github`, silently bypassing the build-tool rule.
    return rel[2:] if rel.startswith("./") else rel


def _vm_release_asset_allowed(rel):
    return any(rel == prefix[:-1] or rel.startswith(prefix)
               for prefix in VM_RELEASE_ASSET_ALLOWLIST)


def _vm_release_residue_class(rel, is_dir=False):
    """Return the forbidden residue class for one sidecar-relative path."""
    rel = _vm_release_rel(rel).rstrip("/")
    if not rel:
        return None
    for root in VM_RELEASE_FORBIDDEN_ROOTS:
        if rel == root or rel.startswith(root + "/"):
            return "dogfood-or-docs-source"
    # P-309: these trees are installed into persistent machine-local state by
    # the existing Cupboard bundle before service start. They are forbidden as
    # WHOLE roots here — merely removing them from the asset allowlist would
    # still let yaml/json files slip through the generic source classifier.
    for root in VM_RELEASE_CUPBOARD_CONTENT_ROOTS:
        if rel == root or rel.startswith(root + "/"):
            return "cupboard-content"

    allowed_asset = _vm_release_asset_allowed(rel)
    parts = rel.split("/")
    base = parts[-1]
    low = base.lower()

    # EI-21492557010868835: lost-pixel's production comparator is retained for
    # parity, but its config-loader closure drags esbuild's Go executable into
    # node_modules.  The vm-release calls the already-compiled comparator and
    # never builds TypeScript config, so the platform compiler is build residue,
    # not runtime.  Prune every @esbuild platform package plus esbuild's CLI bin
    # directory while preserving esbuild/lib (bundle-require imports that module
    # eagerly when lost-pixel is loaded, even though it never starts the service
    # on the comparator path).
    for index, part in enumerate(parts):
        if part == "@esbuild" and "node_modules" in parts[:index]:
            return "build-tool-residue"
    if is_dir and low == "bin" and len(parts) >= 2 \
            and parts[-2] == "esbuild" and "node_modules" in parts[:-2]:
        return "build-tool-residue"
    # D-174: npm's SHIM directory, `node_modules/.bin`, is a THIRD path to a
    # build tool's executable. Normally its entries are symlinks or small JS
    # wrappers and pruning the real package is enough — which is why this gap
    # stayed invisible: the r8 bundle carried a 9,248-byte JS shim here.
    # Measured 2026-08-29, npm instead HARDLINKED the platform binary into
    # `node_modules/lost-pixel/node_modules/.bin/esbuild` (st_nlink 3), so the
    # assembled sidecar shipped 10,178,712 bytes of ELF Go and the vm-release
    # gate went red with 26 High/Critical stdlib CVEs (go1.23.1), every one from
    # this one file. Whether an entry is a link, JS wrapper, or machine binary is
    # an npm layout detail we do not control, and `.bin` is never a runtime
    # entrypoint for this image, so prune the WHOLE shim subtree rather than
    # maintaining another name-keyed exception.
    for index, part in enumerate(parts):
        if part == ".bin" and "node_modules" in parts[:index]:
            return "build-tool-residue"

    if allowed_asset:
        return None
    if is_dir and base.lower() in VM_RELEASE_TEST_DIRS:
        return "test-tree"
    if any(part.lower() in VM_RELEASE_TEST_DIRS for part in parts[:-1]):
        return "test-tree"
    if not is_dir and VM_RELEASE_TEST_FILE_RE.search(low):
        return "test-fixture"
    if not is_dir and low.endswith(".map"):
        return "source-map"
    if not is_dir and low.endswith(VM_RELEASE_SOURCE_SUFFIXES):
        return "typescript-source"
    if not is_dir and (low in VM_RELEASE_BUILD_CONFIG_NAMES
                       or (low.startswith("tsconfig.") and low.endswith(".json"))):
        return "build-tool-residue"
    if is_dir and low in {".github", ".idea", ".vscode", "coverage"}:
        return "build-tool-residue"
    if not is_dir and (low.startswith("readme") or low.startswith("changelog")) \
            and (low.endswith(".md") or low.endswith(".mdx") or "." not in low):
        return "non-runtime-doc"
    if not is_dir and low.endswith((".md", ".mdx")):
        return "non-runtime-doc"
    return None


def _vm_release_findings(root):
    findings = []
    for dirpath, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        for name in dirnames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root)
            residue = _vm_release_residue_class(rel, is_dir=True)
            if residue:
                findings.append((residue, _vm_release_rel(rel) + "/"))
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root)
            residue = _vm_release_residue_class(rel, is_dir=False)
            if residue:
                findings.append((residue, _vm_release_rel(rel)))
    return sorted(set(findings))


def _vm_release_boundary(build_sha, version):
    return {
        "schemaVersion": 1,
        "profile": "vm-release",
        "decisionRefs": [
            "byoc-cloud-workspaces-gcp-aws-azure-2026-08-22#D-043",
            "byoc-cloud-workspaces-gcp-aws-azure-2026-08-22#D-044",
        ],
        "artifactBinding": {
            "buildSha": build_sha,
            "version": version,
            "signatureRequired": True,
            "updateMode": "replace-signed-package-or-image",
        },
        "localIsolationClaim": {
            "protectsAgainst": "ordinary-workspace-ssh-user",
            "runtimeIdentity": "distinct-non-login-service-user",
            "runtimeOwnership": "root-owned-not-readable-by-workspace-user",
            "sharedFilesystemScope": "explicit-workspace-directories-only",
        },
        "rootCloudOwnerNonGoal": {
            "adversary": "vm-root-or-cloud-account-owner",
            "protectedByVmRelease": False,
            "reason": "root-or-cloud-owner-can-extract-code-executing-on-their-vm",
        },
        "hostedBoundary": {
            "planItem": "P-039",
            "proprietaryLogicLocation": "papercusp-hosted-control-plane",
            "vmComponent": "minimal-signed-reverse-data-plane-connector",
        },
    }


def _write_json_atomic(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as out:
        json.dump(value, out, indent=2, sort_keys=True)
        out.write("\n")
    os.replace(tmp, path)


def prune_vm_release(args):
    if len(args) != 1 or not os.path.isdir(args[0]):
        print("AUDIT ERROR: --prune-vm-release needs one existing sidecar directory",
              file=sys.stderr)
        return 2
    root = os.path.realpath(args[0])
    build_sha = os.environ.get("PAPERCUSP_BUILD_SHA", "").strip()
    version = os.environ.get("PAPERCUSP_DESKTOP_VERSION", "").strip()
    if not build_sha or not version or version.lower() == "unknown":
        print("AUDIT ERROR: vm-release requires non-empty PAPERCUSP_BUILD_SHA and "
              "PAPERCUSP_DESKTOP_VERSION before pruning", file=sys.stderr)
        return 2

    removed = []
    # Top-down deletion prevents a forbidden test/docs subtree from being walked
    # and makes symlinked directories inert (unlink the link; never follow it).
    for dirpath, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        kept = []
        for name in dirnames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root)
            residue = _vm_release_residue_class(rel, is_dir=True)
            if residue:
                if os.path.islink(full):
                    os.unlink(full)
                else:
                    shutil.rmtree(full)
                removed.append((residue, _vm_release_rel(rel) + "/"))
            else:
                kept.append(name)
        dirnames[:] = kept
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root)
            residue = _vm_release_residue_class(rel, is_dir=False)
            if residue:
                os.unlink(full)
                removed.append((residue, _vm_release_rel(rel)))

    boundary_path = os.path.join(root, VM_RELEASE_BOUNDARY_PATH)
    _write_json_atomic(boundary_path, _vm_release_boundary(build_sha, version))
    print(f"    prune-vm-release: removed {len(removed)} non-runtime path(s); "
          f"wrote {VM_RELEASE_BOUNDARY_PATH}")
    by_class = {}
    for residue, _rel in removed:
        by_class[residue] = by_class.get(residue, 0) + 1
    for residue, count in sorted(by_class.items()):
        print(f"        {residue}: {count}")
    return 0


def audit_vm_release(args):
    if len(args) != 1 or not os.path.isdir(args[0]):
        print("AUDIT ERROR: --audit-vm-release needs one existing sidecar directory",
              file=sys.stderr)
        return 2
    root = os.path.realpath(args[0])
    findings = _vm_release_findings(root)
    if findings:
        print(f"\n    ✗ VM-RELEASE NON-RUNTIME RESIDUE ({len(findings)} path(s))")
        for residue, rel in findings[:80]:
            print(f"        [{residue}] {rel}")
        if len(findings) > 80:
            print(f"        … and {len(findings) - 80} more")
        return 1

    boundary_path = os.path.join(root, VM_RELEASE_BOUNDARY_PATH)
    try:
        with open(boundary_path, encoding="utf-8") as source:
            boundary = json.load(source)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"AUDIT ERROR: vm-release threat boundary missing/unreadable at "
              f"{VM_RELEASE_BOUNDARY_PATH}: {exc}", file=sys.stderr)
        return 2

    expected = _vm_release_boundary(
        boundary.get("artifactBinding", {}).get("buildSha", ""),
        boundary.get("artifactBinding", {}).get("version", ""),
    )
    binding = boundary.get("artifactBinding", {})
    if not binding.get("buildSha") or not binding.get("version") \
            or boundary != expected:
        print("AUDIT ERROR: vm-release threat boundary does not match the exact "
              "D-043/P-039 schema/claims", file=sys.stderr)
        return 2

    print("    ✓ VM-RELEASE CLEAN — no TypeScript/source maps/tests/docs-source/"
          "build-tool residue outside the runtime asset allowlist")
    print(f"    ✓ threat boundary: ordinary SSH user isolated; root/cloud owner is "
          f"an explicit non-goal; hosted connector={boundary['hostedBoundary']['planItem']}")
    return 0


VM_RELEASE_VULNERABILITY_ATTESTATION_PATH = os.path.join(
    "apps", "operator", "runtime", "vm-release-vulnerability-attestation.json"
)
VM_RELEASE_GATED_SEVERITIES = {"high", "critical"}
VM_RELEASE_GRYPE_DB_MAX_AGE_HOURS = 72

# EI-21925061645614369 — how many installed npm package directories we need to SEE on disk before
# we are willing to insist the SBOM catalogued some. This is only a walk cutoff, not a threshold:
# the assertion fires on ANY non-zero count, and this just stops the walk early on a huge tree once
# the answer is already settled. Deliberately small — a bundle with even one node_modules entry and
# zero npm in its SBOM is already a blind scan.
_SBOM_NPM_COVERAGE_MIN_PACKAGES = 8


def _parse_tool_json(command, label, env=None, timeout=60):
    """Run one metadata command and fail closed on exit/JSON/schema errors."""
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            env=env,
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError(f"{label} could not run: {exc}") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise RuntimeError(
            f"{label} exited {result.returncode}: {detail[:1000]}"
        )
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{label} returned invalid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise RuntimeError(f"{label} returned {type(value).__name__}, expected object")
    return value


def _parse_utc_timestamp(value, label):
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(f"{label} is missing")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise RuntimeError(f"{label} is not an ISO-8601 timestamp: {value}") from exc
    if parsed.tzinfo is None:
        raise RuntimeError(f"{label} has no timezone: {value}")
    return parsed.astimezone(timezone.utc)


def _vulnerability_location(match):
    artifact = match.get("artifact", {}) if isinstance(match, dict) else {}
    locations = artifact.get("locations", []) if isinstance(artifact, dict) else []
    for location in locations:
        if isinstance(location, dict) and location.get("path"):
            return str(location["path"])
        if isinstance(location, str) and location:
            return location
    return "<unknown-path>"


def audit_vulnerabilities(args):
    """Generate a real SBOM + Grype verdict for one finished vm-release tree."""
    if len(args) != 2 or not os.path.isdir(args[0]):
        print("AUDIT ERROR: --audit-vulnerabilities needs an existing sidecar "
              "directory and an external evidence directory", file=sys.stderr)
        return 2
    root = os.path.realpath(args[0])
    output = os.path.realpath(args[1])
    try:
        if os.path.commonpath([root, output]) == root:
            print("AUDIT ERROR: vulnerability evidence directory must be outside "
                  "the scanned sidecar (self-referential SBOM refused)", file=sys.stderr)
            return 2
    except ValueError:
        pass
    if os.path.exists(output) and os.listdir(output):
        print(f"AUDIT ERROR: vulnerability evidence directory is not empty: {output}",
              file=sys.stderr)
        return 2
    os.makedirs(output, exist_ok=True)

    build_sha = os.environ.get("PAPERCUSP_BUILD_SHA", "").strip()
    version = os.environ.get("PAPERCUSP_DESKTOP_VERSION", "").strip()
    if not build_sha or not version or version.lower() == "unknown":
        print("AUDIT ERROR: vulnerability verdict requires PAPERCUSP_BUILD_SHA and "
              "PAPERCUSP_DESKTOP_VERSION", file=sys.stderr)
        return 2

    syft = shutil.which("syft")
    grype = shutil.which("grype")
    if not syft or not grype:
        print("AUDIT ERROR: vm-release vulnerability verdict requires both syft "
              "and grype on PATH", file=sys.stderr)
        return 2

    metadata_env = os.environ.copy()
    metadata_env["SYFT_CHECK_FOR_APP_UPDATE"] = "false"
    metadata_env["GRYPE_CHECK_FOR_APP_UPDATE"] = "false"
    metadata_env["GRYPE_DB_AUTO_UPDATE"] = "false"
    try:
        syft_version = _parse_tool_json(
            [syft, "version", "-o", "json"], "syft version", metadata_env
        )
        grype_version = _parse_tool_json(
            [grype, "version", "-o", "json"], "grype version", metadata_env
        )
        db_status = _parse_tool_json(
            [grype, "db", "status", "-o", "json"], "grype db status", metadata_env
        )
        if db_status.get("valid") is not True:
            raise RuntimeError("grype DB reports valid != true")
        db_built = _parse_utc_timestamp(db_status.get("built"), "grype DB built")
        db_age = datetime.now(timezone.utc) - db_built
        if db_age.total_seconds() < -3600:
            raise RuntimeError(f"grype DB build time is in the future: {db_built.isoformat()}")
        if db_age.total_seconds() > VM_RELEASE_GRYPE_DB_MAX_AGE_HOURS * 3600:
            raise RuntimeError(
                f"grype DB is {db_age.total_seconds() / 3600:.1f}h old; "
                f"maximum is {VM_RELEASE_GRYPE_DB_MAX_AGE_HOURS}h"
            )
    except RuntimeError as exc:
        print(f"AUDIT ERROR: {exc}", file=sys.stderr)
        return 2

    sbom_path = os.path.join(output, "sbom.cdx.json")
    grype_path = os.path.join(output, "grype.json")
    source_version = f"{version}+{build_sha[:12]}"
    try:
        syft_result = subprocess.run(
            [
                syft,
                f"dir:{root}",
                # EI-21925061645614369 — WITHOUT this flag the vulnerability leg is blind to npm,
                # which is the largest ecosystem in the bundle. syft's `dir:` source selects the
                # catalogers tagged `directory`, and in syft 1.51 the javascript tags split:
                #
                #   javascript-lock-cataloger     declared, deno, DIRECTORY, javascript, ... npm
                #   javascript-package-cataloger  IMAGE, installed, javascript, ...
                #
                # The lock cataloger reads package-lock.json; a release bundle ships node_modules/
                # with NO lockfile at the extracted root. So the only cataloger that would read
                # node_modules/*/package.json is image-tagged and never runs here. Measured on the
                # r14 bundle: 298 SBOM components, ZERO npm, verdict "green / gatedMatches 0" — over
                # a tree carrying 26 at/above-high npm findings including a Critical
                # (form-data@4.0.0, GHSA-fjxv-7rqg-78g4). That 26 is exactly what the GCP image scan
                # attributes to papercusp-bundled, by an independent method.
                #
                # `+` ADDS to the default set rather than replacing it, so binary/golang coverage is
                # unchanged (284 golang components before and after). Cost: ~6s on a 4.3G tree.
                "--select-catalogers", "+javascript-package-cataloger",
                "--source-name", "papercusp-vm-release",
                "--source-version", source_version,
                "-o", f"cyclonedx-json={sbom_path}",
            ],
            capture_output=True,
            text=True,
            env=metadata_env,
            timeout=1800,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"AUDIT ERROR: syft scan could not run: {exc}", file=sys.stderr)
        return 2
    if syft_result.returncode != 0 or not os.path.isfile(sbom_path):
        detail = (syft_result.stderr or syft_result.stdout).strip()
        print(f"AUDIT ERROR: syft scan failed ({syft_result.returncode}): "
              f"{detail[:1000]}", file=sys.stderr)
        return 2
    # ── SBOM COVERAGE ASSERTION (EI-21925061645614369) ────────────────────────────
    # The flag above fixes the blindness; this is what stops it coming back unnoticed.
    # Cataloger tags are UPSTREAM data — one retag in a future syft and the npm leg silently
    # empties again, and an empty leg is indistinguishable from a clean one. This file's own
    # header already states the rule ("a scan that inspects nothing is indistinguishable from a
    # scan that found nothing"); the vulnerability leg simply never had it applied.
    #
    # So: derive the expectation from the TREE, not from a constant. If the bundle demonstrably
    # contains installed npm packages, the SBOM must have catalogued some. Fail CLOSED (exit 2,
    # "unscannable"), never warn — a warning here is a green build with a note nobody reads.
    npm_dirs_on_disk = 0
    for dirpath, dirnames, filenames in os.walk(root):
        if os.path.basename(dirpath) == "node_modules":
            npm_dirs_on_disk += sum(1 for d in dirnames if not d.startswith("."))
            if npm_dirs_on_disk >= _SBOM_NPM_COVERAGE_MIN_PACKAGES:
                break
    if npm_dirs_on_disk:
        try:
            with open(sbom_path, encoding="utf-8") as source:
                sbom_components = json.load(source).get("components") or []
        except (OSError, json.JSONDecodeError) as exc:
            print(f"AUDIT ERROR: SBOM unreadable for the coverage assertion: {exc}",
                  file=sys.stderr)
            return 2
        npm_in_sbom = sum(
            1 for component in sbom_components
            if isinstance(component, dict)
            and str(component.get("purl", "")).startswith("pkg:npm/")
        )
        if npm_in_sbom == 0:
            print(f"AUDIT ERROR: SBOM catalogued 0 npm packages, but the tree under {root} "
                  f"contains at least {npm_dirs_on_disk} installed npm package director"
                  f"{'y' if npm_dirs_on_disk == 1 else 'ies'}. The vulnerability leg is BLIND "
                  f"to npm and its verdict would be meaningless — refusing to emit one. "
                  f"Check syft's cataloger tags (`syft cataloger list | grep javascript`): the "
                  f"installed-package cataloger must be selected for a dir: source.",
                  file=sys.stderr)
            return 2
        print(f"    npm coverage : {npm_in_sbom} package(s) catalogued "
              f"(tree has >= {npm_dirs_on_disk})")

    try:
        with open(grype_path, "w", encoding="utf-8") as report:
            grype_result = subprocess.run(
                [grype, f"sbom:{sbom_path}", "-o", "json"],
                stdout=report,
                stderr=subprocess.PIPE,
                text=True,
                env=metadata_env,
                timeout=1800,
            )
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"AUDIT ERROR: grype scan could not run: {exc}", file=sys.stderr)
        return 2
    if grype_result.returncode != 0:
        print(f"AUDIT ERROR: grype scan failed ({grype_result.returncode}): "
              f"{(grype_result.stderr or '').strip()[:1000]}", file=sys.stderr)
        return 2
    try:
        with open(grype_path, encoding="utf-8") as source:
            grype_report = json.load(source)
        matches = grype_report["matches"]
        if not isinstance(matches, list):
            raise TypeError("matches is not a list")
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as exc:
        print(f"AUDIT ERROR: grype report is unreadable or missing matches: {exc}",
              file=sys.stderr)
        return 2

    severity_counts = {}
    gated = []
    for match in matches:
        vulnerability = match.get("vulnerability", {}) if isinstance(match, dict) else {}
        severity = str(vulnerability.get("severity", "unknown")).strip().lower()
        severity_counts[severity] = severity_counts.get(severity, 0) + 1
        if severity in VM_RELEASE_GATED_SEVERITIES:
            gated.append(match)

    summary = {
        "schemaVersion": 1,
        "policy": {
            "denySeverities": ["High", "Critical"],
            "grypeDbMaxAgeHours": VM_RELEASE_GRYPE_DB_MAX_AGE_HOURS,
            "failClosed": True,
        },
        "artifactBinding": {
            "buildSha": build_sha,
            "version": version,
        },
        "scanner": {
            "syftVersion": syft_version.get("version"),
            "grypeVersion": grype_version.get("version"),
            "grypeDbSchema": db_status.get("schemaVersion"),
            "grypeDbBuilt": db_built.isoformat().replace("+00:00", "Z"),
        },
        "evidence": {
            "sbomSha256": _sha256_file(sbom_path),
            "grypeReportSha256": _sha256_file(grype_path),
        },
        "result": {
            "status": "red" if gated else "green",
            "totalMatches": len(matches),
            "gatedMatches": len(gated),
            "bySeverity": dict(sorted(severity_counts.items())),
        },
    }
    _write_json_atomic(os.path.join(output, "summary.json"), summary)

    if gated:
        print(f"\n    ✗ VM-RELEASE VULNERABILITY GATE RED "
              f"({len(gated)} High/Critical match(es))")
        def finding_key(match):
            vulnerability = match.get("vulnerability", {})
            artifact = match.get("artifact", {})
            return (
                _vulnerability_location(match),
                str(artifact.get("name", "")),
                str(vulnerability.get("id", "")),
            )
        for match in sorted(gated, key=finding_key)[:80]:
            vulnerability = match.get("vulnerability", {})
            artifact = match.get("artifact", {})
            print(
                f"        [{vulnerability.get('severity', 'Unknown')}] "
                f"{_vulnerability_location(match)} — "
                f"{artifact.get('name', '<unknown>')}@{artifact.get('version', '<unknown>')} "
                f"{vulnerability.get('id', '<unknown>')}"
            )
        if len(gated) > 80:
            print(f"        … and {len(gated) - 80} more")
        return 1

    attestation_path = os.path.join(root, VM_RELEASE_VULNERABILITY_ATTESTATION_PATH)
    _write_json_atomic(attestation_path, summary)
    print("    ✓ VM-RELEASE VULNERABILITY GATE GREEN — zero High/Critical matches")
    print(f"    ✓ SBOM {_sha256_file(sbom_path)}; Grype report {_sha256_file(grype_path)}")
    return 0


# Archives whose CONTENTS are invisible to a byte-level grep: the payload is
# compressed, so a plaintext identity literal inside is simply not present in the
# file's bytes. `grep -a` fixes binary files; only expansion fixes these.
# `.dump` is here because pg_dump's custom format is zlib-compressed internally.
# `.deb` is here because of a MEASURED false CLEAN, not on principle (EI-20108164746219771):
# the 0.0.15 SERVER .deb greps 0 on its raw bytes and 3 once decompressed. Without
# this entry the file is never handed to the expander at all, so the leak was
# reported as a pass — the exact "not inspected reads as clean" failure the archive
# pass exists to remove, reintroduced by an omission in the suffix list rather than
# by a gap in the machinery.
ARCHIVE_SUFFIXES = (
    ".tar.zst", ".tar.gz", ".tgz", ".tar.bz2", ".tar.xz", ".tar",
    ".zip", ".jar", ".asar", ".gz", ".zst", ".bz2", ".xz", ".dump",
    ".deb",
)


def _iter_archives(dirs):
    """Every archive file under the scanned roots, as absolute paths."""
    for root in dirs:
        if not os.path.isdir(root):
            continue
        for dirpath, _dirnames, filenames in os.walk(root):
            for fn in filenames:
                low = fn.lower()
                if low.endswith(ARCHIVE_SUFFIXES):
                    yield os.path.join(dirpath, fn)


#: An expanded archive is treated as an OS ROOTFS when it has `usr/` plus at least
#: one other top-level system directory. Deliberately conservative — requiring the
#: PAIR keeps a source tree that merely happens to contain a `usr/` fixture from
#: being waved through, and everything here is still subject to the high-entropy
#: pass, which is what actually catches a leaked path/email/hostname.
SYSTEM_IMAGE_MARKERS = ("etc", "bin", "sbin", "lib", "var", "root")


def _looks_like_system_image(root):
    """Is this expanded archive an OS rootfs (a WSL/container image) rather than ours?"""
    try:
        top = {e.name for e in os.scandir(root) if e.is_dir()}
    except OSError:
        return False
    return "usr" in top and bool(top & set(SYSTEM_IMAGE_MARKERS))


def _expand_tar_memberwise(path, dest):
    """Read a tar by MEMBER, never by path.

    `tarfile.extractall` MATERIALISES member paths, so one member whose link
    escapes the destination makes the whole call raise — Python >=3.12's default
    `data` filter is right to refuse it. But "I refused to write this member" is
    not "I could not read these bytes", and conflating the two is expensive: a
    vendored security FIXTURE (tar-fs ships test/fixtures/invalid.tar, a tar whose
    links deliberately escape the root) halted the 0.0.14 release at minute 22 of
    a 22-minute cut on an archive whose bytes are perfectly readable (WI-37620).

    Reading members individually needs no path TRUST at all: only regular-file
    payloads are written, under a SANITISED relative path ('/', '.' and '..'
    components dropped), so nothing lands outside dest and no link is ever
    followed — strictly safer than extractall, not a relaxation of it. The
    sanitised path deliberately keeps the member's own name, because the caller
    reports findings as `archive!member` and "some archive is dirty" is not
    actionable. Member NAMES and link targets additionally go into a manifest, so
    an identity literal embedded in a member's PATH is scanned too: coverage
    extractall never had, because the scan greps file CONTENTS and a materialised
    directory name is not content.

    THE MANIFEST MUST CARRY OWNERSHIP, NOT JUST PATHS (WI-39458, MEASURED).
    `tar` stamps the BUILDING USER's name into every member's uid/gid NAME fields
    (`uname`/`gname`) unless told otherwise, and those fields are metadata: they
    are not any member's payload and not any member's path, so neither the
    content grep nor the name manifest could ever see them. Measured 2026-08-16
    on a PGDATA-shaped fixture whose contents were clean: this gate expanded the
    archive (`1 archive(s) expanded and scanned` — NOT a suffix-list miss) and
    printed `✓ CLEAN` exit 0, while `tar -tv` showed the build-box username on
    every member. The paired control — the SAME archive shape with the SAME
    literal moved into a member's CONTENT — failed correctly, which is what makes
    this a blind spot in the manifest rather than a weak literal set.

    It bites COMPRESSED tars specifically. In a plain `.tar` the header bytes are
    on disk in the clear, so the raw `grep -a` pass already reads them; gzip/zstd
    /xz hide them, and those are exactly the tars that ship (`db-seed.tar.gz`,
    `papercup-runtime.tar.gz`). The real leak this caught was `db-seed.tar.gz`,
    now also fixed at source in embedded-postgres-server/bin/build-seed.mjs —
    both halves are kept deliberately, because a source fix protects the archives
    we build and this one protects every archive we merely SHIP.

    ⚠ EVERY tar-like format MUST reach this function, or its metadata coverage is
    a fiction for whatever format skipped it. `.tar.zst` did skip it until
    WI-39462: `_expand_archive` matched a `.tar.zst` suffix branch BEFORE the
    `tarfile.is_tarfile()` branch that routes here, and expanded it with a shell
    `tar -xf`, which writes NO manifest at all. That silently exempted the single
    largest artifact we ship — `source.tar.zst`, the whole source tree — from
    linkname, member-name AND uname/gname scanning, so the ownership fix above
    never actually covered it. Measured on identical tar bytes: `.tar` produced a
    manifest carrying the leak, `.tar.zst` produced none. Route by CONTENT
    (is it a tar?), never by how it happens to be compressed.

    Returns False when a payload genuinely cannot be read — unknown is not absent.
    """
    with tarfile.open(path) as tf:
        return _expand_tar_stream(tf, dest, label=path)


def _expand_tar_stream(tf, dest, label="<tar>"):
    """The memberwise core of `_expand_tar_memberwise`, over an OPEN tarfile.

    Split out so a compression `tarfile` cannot open natively (zstd) can be piped
    in as a stream and get BYTE-IDENTICAL treatment — one scanner, no drift. It is
    written to work under `mode='r|'` (non-seekable) as well as random access:
    members are visited once, in order, and `extractfile` is called only on the
    member currently being iterated, which is the one case streaming mode supports.
    """
    os.makedirs(dest, exist_ok=True)
    names = []
    for idx, member in enumerate(tf):
        names.append(member.name)
        if member.linkname:
            names.append(member.linkname)
        # Ownership NAMES (see the docstring). Numeric uid/gid are deliberately
        # NOT recorded: an integer cannot carry an identity literal, and
        # emitting them would only add noise to a manifest that is grepped.
        if member.uname:
            names.append(member.uname)
        if member.gname:
            names.append(member.gname)
        # PAX headers are free-form key/value metadata (`tar --xattrs`, ACLs,
        # SCHILY.* records). Same argument as uname/gname: metadata, greppable
        # by nothing else, and a natural landing spot for a build path.
        for k, v in (member.pax_headers or {}).items():
            names.append(f"{k}={v}")
        if not member.isfile():
            continue
        src = tf.extractfile(member)
        if src is None:
            # A regular file whose payload will not open IS a hole in the scan.
            print(f"    scan-dir: {label}: member {member.name!r} payload unreadable")
            return False
        parts = [p for p in member.name.replace("\\", "/").split("/")
                 if p not in ("", ".", "..")]
        out = os.path.join(dest, *parts) if parts else os.path.join(dest, f"member{idx}")
        # Two members can sanitise to one path ('a/../b' and 'b'); never clobber.
        while os.path.exists(out):
            out = f"{out}.{idx}"
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "wb") as fh:
            shutil.copyfileobj(src, fh)
    with open(os.path.join(dest, "__member_names__.txt"), "w",
              encoding="utf-8", errors="replace") as fh:
        fh.write("\n".join(names))
    return True


def _expand_archive(path, dest):
    """Expand ONE archive into dest.

    Returns True when the contents were made available for scanning, False when
    the format could not be opened. A False is NOT treated as 'nothing to see' —
    the caller fails the gate on it, because an archive the scan cannot read is
    exactly the blind spot this pass exists to remove (unknown is not absent).
    """
    os.makedirs(dest, exist_ok=True)
    low = path.lower()
    try:
        if low.endswith(".zip") or low.endswith(".jar") or low.endswith(".asar"):
            with zipfile.ZipFile(path) as zf:
                zf.extractall(dest)  # noqa: S202 — scanned then discarded, never executed
            return True
        if low.endswith(".tar.zst"):
            # `tarfile` has no zstd codec, which is why this used to be a shell
            # `zstd -dc | tar -xf -`. That shelled-out form had TWO defects, both
            # measured (WI-39462), and both produced a false CLEAN rather than an
            # error — so neither was ever visible in a build log:
            #
            #  1. It bypassed _expand_tar_memberwise entirely, so NO
            #     __member_names__.txt was written. Linknames, member names and
            #     uname/gname all went unscanned for `source.tar.zst` — the whole
            #     shipped source tree, and the largest artifact we produce. A
            #     symlink whose TARGET is the owner's home path has no content
            #     bytes and an innocuous name, so it was invisible to every phase.
            #  2. sh() runs shell=True against /bin/sh (dash — no pipefail), so the
            #     pipeline reported only `tar`'s status. A failing `zstd` feeding an
            #     empty stream to a `tar` that exits 0 returned True having
            #     extracted NOTHING. Identical to the hole the .deb branch below
            #     documents and guards; this branch never got the same treatment.
            #
            # Streaming the pipe into tarfile(mode='r|') fixes both at once: the
            # SAME memberwise reader handles it (no drift, no format exemption),
            # and zstd's own exit status is checked explicitly instead of being
            # swallowed by a pipeline. Route by CONTENT, not by compression.
            proc = subprocess.Popen(
                ["zstd", "-dc", path], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                with tarfile.open(fileobj=proc.stdout, mode="r|") as tf:
                    ok = _expand_tar_stream(tf, dest, label=path)
            except tarfile.TarError as exc:
                proc.kill()
                proc.wait()
                print(f"    scan-dir: cannot expand {path}: {exc}")
                return False
            finally:
                if proc.stdout:
                    proc.stdout.close()
            rc = proc.wait()
            if rc != 0:
                err = (proc.stderr.read().decode("utf-8", "replace").strip()
                       if proc.stderr else "")
                print(f"    scan-dir: cannot expand {path}: zstd exited {rc}: {err[:200]}")
                return False
            return ok
        if low.endswith(".deb"):
            # A .deb is an `ar` archive whose payload is a NESTED data.tar.{zst,xz,gz}.
            # Extracting the ar members would leave that nested tarball unexpanded, and
            # this pass does NOT recurse — so the naive fix would re-create the very
            # false CLEAN it was written to remove. `dpkg-deb --fsys-tarfile` streams
            # the payload as a plain tar whatever the inner compression, collapsing
            # both layers in one hop.
            #
            # executable=/bin/bash + pipefail is LOAD-BEARING, not style: sh() runs
            # shell=True against /bin/sh (dash here), which has no pipefail, so a
            # pipeline reports only the LAST command's status. Without this, a box
            # with no dpkg-deb would fail the first stage, hand tar an empty stream,
            # and — if tar exited 0 — return True having extracted NOTHING. That is a
            # false CLEAN produced by the repair itself, so the check must be exact.
            if not shutil.which("dpkg-deb"):
                print(f"    scan-dir: cannot expand {path}: dpkg-deb not on PATH "
                      f"(a .deb this gate cannot open is a hole, not a pass)")
                return False
            r = sh(f"set -o pipefail; dpkg-deb --fsys-tarfile {q(path)} "
                   f"| tar -xf - -C {q(dest)}", executable="/bin/bash")
            if r.returncode != 0:
                print(f"    scan-dir: cannot expand {path}: "
                      f"dpkg-deb/tar exited {r.returncode}: {r.stderr.strip()[:200]}")
                return False
            # The control archive carries maintainer/packager fields — a natural
            # landing spot for a build-box identity, and invisible in the fsys payload.
            ctrl = os.path.join(dest, "__control__")
            os.makedirs(ctrl, exist_ok=True)
            rc = sh(f"set -o pipefail; dpkg-deb --ctrl-tarfile {q(path)} "
                    f"| tar -xf - -C {q(ctrl)}", executable="/bin/bash")
            if rc.returncode != 0:
                # The payload IS readable, so this is not the uninspectable case —
                # but say so rather than let a silently-skipped control archive read
                # as scanned.
                print(f"    scan-dir: {os.path.basename(path)}: payload expanded, "
                      f"control archive unreadable (exit {rc.returncode}) — "
                      f"maintainer fields NOT scanned")
            return True
        if tarfile.is_tarfile(path):
            # Member-wise on purpose — see _expand_tar_memberwise. A hostile member
            # must not be able to halt a release on bytes that are readable.
            return _expand_tar_memberwise(path, dest)
        if low.endswith(".zst"):
            return sh(f"zstd -dc {q(path)} > {q(os.path.join(dest, 'payload'))}").returncode == 0
        if low.endswith(".gz"):
            return sh(f"gzip -dc {q(path)} > {q(os.path.join(dest, 'payload'))}").returncode == 0
        if low.endswith(".bz2"):
            return sh(f"bzip2 -dc {q(path)} > {q(os.path.join(dest, 'payload'))}").returncode == 0
        if low.endswith(".xz"):
            return sh(f"xz -dc {q(path)} > {q(os.path.join(dest, 'payload'))}").returncode == 0
        if low.endswith(".dump"):
            # pg_dump custom format — zlib-compressed internally. pg_restore -f -
            # renders it as SQL text, which is what we need to scan.
            return sh(
                f"pg_restore -f {q(os.path.join(dest, 'payload.sql'))} {q(path)}"
            ).returncode == 0
    except Exception as e:  # noqa: BLE001 — any failure means "could not inspect"
        print(f"    scan-dir: cannot expand {path}: {type(e).__name__}: {e}")
        return False
    return False


#: Compiled native addons. A build-box path inside one is baked in by the COMPILER
#: (an assert()/__FILE__ expansion in .rodata), so it is reachable by neither of the
#: gate's other two remedies: `strip` cannot remove it (verified: `strip
#: --strip-debug` leaves it — it is .rodata, not debug info), and the file cannot be
#: pruned because it is loaded at runtime.
SCRUBBABLE_BINARY_SUFFIXES = (".node", ".so", ".dylib")


def _high_entropy_pairs():
    """(literal, placeholder) pairs, LONGEST FIRST so '/home/<user>' is scrubbed
    before the bare '<user>' nested inside it. Low-entropy literals are excluded:
    a bare first name matches by chance in compiled bytes (WI-37553)."""
    lits = identity_literals()
    lits.update(KNOWN_SENSITIVE_IDENTITIES)
    return sorted(
        ((v, REDACTION_BY_KEY.get(redaction_key(k), "redacted")) for k, v in lits.items()
         if v and not is_low_entropy(v)),
        key=lambda p: -len(p[0]),
    )


def _identity_pairs():
    """All identity/redaction pairs, longest first and de-duplicated by literal."""
    lits = identity_literals()
    lits.update(KNOWN_SENSITIVE_IDENTITIES)
    seen = set()
    pairs = []
    for key, value in sorted(lits.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        if not value or value in seen:
            continue
        seen.add(value)
        pairs.append((value, REDACTION_BY_KEY.get(redaction_key(key), "redacted")))
    return pairs


def _scrub_one(p, pairs):
    """Length-preserving identity scrub of ONE file, in place. Returns the hit
    list ([] when nothing matched, so the caller can stay quiet).

    Shared by --scrub-binaries and --scrub-app-binary so the two can never drift
    on the byte-length invariant, which is the property that makes this safe:
    every ELF/Mach-O offset, section size and relocation stays valid because the
    placeholder is truncated/padded to the literal's exact length.
    """
    try:
        data = open(p, "rb").read()
    except OSError:
        return []
    orig = data
    hits = []
    for lit, placeholder in pairs:
        b = lit.encode()
        if b not in data:
            continue
        rep = placeholder.encode()[:len(b)].ljust(len(b), b"_")
        if is_word_bounded(lit):
            # Same token rule as the scan: a dictionary-word login must not rewrite
            # a symbol that merely contains it (e.g. `IPCTester`, `smoketester`).
            rx = re.compile(rb"\b" + re.escape(b) + rb"\b")
            n = len(rx.findall(data))
            if not n:
                continue
            hits.append(f"{lit} x{n}")
            data = rx.sub(lambda _m: rep, data)
            continue
        hits.append(f"{lit} x{data.count(b)}")
        data = data.replace(b, rep)
    if not hits or data == orig:
        return []
    assert len(data) == len(orig), "scrub must preserve byte length"
    # Write a NEW inode and rename over it, never in place: the sidecar copier
    # hardlinks where the FS supports it, and an in-place write would reach
    # through every link.
    tmp_p = p + ".scrub.tmp"
    with open(tmp_p, "wb") as fh:
        fh.write(data)
    shutil.copymode(p, tmp_p)
    os.replace(tmp_p, p)
    return hits


#: Text file suffixes the sidecar doc scrub rewrites. Deliberately a SUFFIX
#: allowlist and not "anything grep calls text": the sidecar tree also holds
#: compiled addons and seed bundles, and those belong to --scrub-binaries, whose
#: byte-length invariant this function does NOT honor.
SCRUBBABLE_TEXT_SUFFIXES = (
    ".md", ".mdx", ".html", ".htm", ".txt", ".json",
    ".js", ".mjs", ".cjs", ".ts", ".tsx", ".sql", ".sh", ".py",
    ".yml", ".yaml", ".toml", ".xml", ".css", ".scss", ".rs",
)


def scrub_text(paths):
    """Redact build-box identity from explicitly selected SHIPPING TEXT.

    WHY THIS EXISTS — the gap between --prune-docs and --scan-dir:
    prune_docs() deletes by PATH (FORBIDDEN_PATH rules), while scan_dir() fails by
    CONTENT (identity needles). Those are different predicates, so a doc whose path
    is not internal-build-infra but whose TEXT quotes this box's home path passes the
    prune and then reds the gate. Measured on the 0.0.16 cut: 65 assembled files —
    28 source .mdx plus their rendered .md/.html twins — carried the build-home-path
    and the mac VM logins while every path rule passed clean.

    WHY SCRUB RATHER THAN PRUNE OR EDIT THE SOURCE: these docs SHIP on purpose (the
    app serves internal-docs via bin/host-docs.ts, and the .mdx source grounds
    docs-qa), so pruning removes a real feature. And per the STAGING SCRUB doctrine
    above, a per-file source edit is a treadmill — agents author new insight docs
    continuously and each new absolute path reds the next cut. Redacting a COPY at
    build time is the same remedy bin/stage-source-tree.sh already applies to
    source.tar.zst; this closes the sidecar half of that blind spot, which is
    precisely the route WI-4419 documents as bypassing the staged-source audit.

    Unlike _scrub_one() this does NOT preserve byte length: nothing here is linked
    or offset-addressed, and padding a placeholder out to the literal's width with
    underscores would corrupt readable prose for no benefit.

    High- and low-entropy literals are rewritten with the SAME case-folded regex the
    gate hunts. Low-entropy occurrences first pass through
    low_entropy_match_is_benign(), shared with every scan path, so owner media tokens
    and opaque Vite fingerprints survive while authored ``owner`` identity does not.
    Explicit file arguments are accepted for stage-source-tree's already-proven text
    leakers; directory walks remain suffix-scoped and prune node_modules.
    """
    pairs = _identity_pairs()
    if not pairs:
        print("    scrub-text: no identity resolved — nothing to scrub")
        return 0

    def scrub_one(p, display_name):
        try:
            data = open(p, "rb").read()
        except OSError:
            return []
        if b"\0" in data:
            return []
        orig = data
        hits = []
        for lit, placeholder in pairs:
            rx = re.compile(lit_ere(lit).encode())
            low = is_low_entropy(lit)
            replaced = 0

            def replacement(match):
                nonlocal replaced
                if low and low_entropy_match_is_benign(display_name, data, match):
                    return match.group(0)
                replaced += 1
                return placeholder.encode()

            data = rx.sub(replacement, data)
            if replaced:
                hits.append(f"{lit} x{replaced}")
        if not hits or data == orig:
            return []
        # New inode + rename, never an in-place write: callers may hand us a
        # hardlinked sidecar/staging copy whose source of truth must stay untouched.
        tmp_p = p + ".scrub.tmp"
        with open(tmp_p, "wb") as fh:
            fh.write(data)
        shutil.copymode(p, tmp_p)
        os.replace(tmp_p, p)
        return hits

    total_files = 0
    for root in paths:
        if not os.path.exists(root):
            print(f"    scrub-text: {root} absent — skipping")
            continue
        scrubbed = []
        if os.path.isfile(root):
            hits = scrub_one(root, os.path.basename(root))
            if hits:
                scrubbed.append((os.path.basename(root), hits))
        else:
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames[:] = [d for d in dirnames if d != "node_modules"]
                for fn in filenames:
                    if not fn.endswith(SCRUBBABLE_TEXT_SUFFIXES):
                        continue
                    p = os.path.join(dirpath, fn)
                    rel = os.path.relpath(p, root)
                    hits = scrub_one(p, rel)
                    if hits:
                        scrubbed.append((rel, hits))
        total_files += len(scrubbed)
        print(f"    scrub-text: {root} — scrubbed {len(scrubbed)} file(s)")
        for rel, hits in sorted(scrubbed):
            print(f"        ✂ {rel}: {', '.join(hits)}")
    print(f"    scrub-text: {total_files} file(s) rewritten")
    return 0


def scrub_app_binary(paths):
    """Scrub build-box identity out of explicitly named packaged executables.

    This is deliberately separate from --scrub-binaries: that flag walks a TREE
    selecting compiled addons by SCRUBBABLE_BINARY_SUFFIXES, while this flag takes
    explicit FILE paths and can never sweep a directory. Callers that must sanitize
    an extension-less executable (for example, a packaged Windows .exe or another
    release artifact) use this narrow form.

    Byte length is preserved exactly because the executable may already be linked;
    changing its size would invalidate offsets, sections, and relocations.
    """
    pairs = _high_entropy_pairs()
    if not pairs:
        print("    scrub-app-binary: no high-entropy literals on this box — nothing to do")
        return 0
    scrubbed = 0
    for p in paths:
        if not os.path.isfile(p):
            print(f"    scrub-app-binary: {p} absent — skipping")
            continue
        hits = _scrub_one(p, pairs)
        if hits:
            scrubbed += 1
            print(f"    ✂ scrubbed {os.path.basename(p)}: {', '.join(hits)}")
    print(f"    scrub-app-binary: {scrubbed} executable(s) scrubbed")
    return 0


def scrub_binaries(dirs):
    """Scrub build-box identity literals out of COMPILED NATIVE ADDONS, in place.

    The gate's remedy line offers two fixes — "prune the leaking file … or scrub the
    value". For a compiled addon only the second is available, which is why this
    exists (WI-37620): the 0.0.14 cut red'd on
    node_modules/ssh2/…/Release/sshcrypto.node carrying the builder's node-gyp
    include path, sitting in .rodata between a __PRETTY_FUNCTION__ and its
    neighbours — i.e. an assert() __FILE__ expansion. Deleting the file happens to
    be safe for THAT package (ssh2 wraps the require in try/catch and falls back to
    JS crypto), but that is a property of ssh2, not of addons, so a delete rule
    would be one un-guarded require away from shipping a broken app. Scrubbing is
    safe for ALL of them and keeps the accelerator.

    Deliberately restricted to compiled addons: a literal in TEXT belongs to a
    source that should be fixed, and silently rewriting source would hide it.

    Byte-length is PRESERVED exactly (placeholder truncated/padded), so every ELF
    offset, section size and relocation stays valid — the bytes changed are an
    assert message, never read for control flow. Literals are applied
    LONGEST-FIRST so '/home/<user>' is scrubbed before the bare '<user>' inside it.
    """
    pairs = _high_entropy_pairs()
    if not pairs:
        print("    scrub-binaries: no high-entropy literals on this box — nothing to do")
        return 0

    scrubbed = 0
    for root in dirs:
        if not os.path.isdir(root):
            print(f"    scrub-binaries: {root} absent — skipping")
            continue
        for dirpath, _dirnames, filenames in os.walk(root):
            for fn in filenames:
                if not fn.endswith(SCRUBBABLE_BINARY_SUFFIXES):
                    continue
                p = os.path.join(dirpath, fn)
                hits = _scrub_one(p, pairs)
                if hits:
                    scrubbed += 1
                    print(f"    ✂ scrubbed {os.path.relpath(p, root)}: {', '.join(hits)}")
    print(f"    scrub-binaries: {scrubbed} compiled addon(s) scrubbed")
    return 0


def _scan_coverage(dirs):
    """Count what a `grep -r` pass over `dirs` will ACTUALLY read.

    Deliberately mirrors grep's own recursion rules rather than estimating
    optimistically: `grep -r` does not descend into a symlinked DIRECTORY and does
    not follow a symlinked FILE found during recursion, and `os.walk(...,
    followlinks=False)` matches that exactly. So this is the scan's real coverage
    — the number that makes a CLEAN falsifiable — not an upper bound on it.

    A SYMLINK'S TARGET IS ITSELF IDENTITY-BEARING CONTENT (WI-39462). A symlink has
    no payload — the target string lives in the directory entry — so `grep -r`
    never reads it and no working-tree scan we own could ever see it. That is not
    hypothetical: the owner's absolute home path sat COMMITTED in this repo as two
    tracked symlink blobs (mode 120000) and shipped inside every release's
    source.tar.zst, while every scan reported CLEAN. Naming the symlink in a ⚠
    coverage line (which this function already did) is NOT enough — the leaking
    path was printed in that very warning and the gate still exited 0.

    So targets are returned for SCANNING, not just for reporting, and files are
    included alongside directories: a symlinked FILE is skipped by grep for exactly
    the same reason and carries a target string just the same.

    Returns (regular_file_count, [symlinked dirs skipped], [(path, target) links]).
    """
    n_files = 0
    symlinked_dirs = []
    links = []

    def _record(p):
        try:
            links.append((p, os.readlink(p)))
        except OSError:
            # A link we cannot read is a hole, not a pass — surface it as such
            # rather than dropping it silently.
            links.append((p, "<unreadable link target>"))

    for root in dirs:
        # The scan roots THEMSELVES can be symlinks (a build stages its BuildRoot
        # out of links), and os.walk reports nothing about the root's own nature.
        if os.path.islink(root):
            _record(root)
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            for d in dirnames:
                p = os.path.join(dirpath, d)
                if os.path.islink(p):
                    symlinked_dirs.append(p)
                    _record(p)
            for f in filenames:
                p = os.path.join(dirpath, f)
                if os.path.islink(p):
                    _record(p)
                else:
                    n_files += 1
    return n_files, symlinked_dirs, links


def scan_dir(dirs):
    """Ultimate backstop: identity-scan the ASSEMBLED bytes that actually ship,
    honoring NO path-exclude. If a known-sensitive or build-box identity literal
    is on disk in what ships, FAIL — exclude list or not.

    The existing phase-B scan is meant to be this backstop, but it reads
    source.tar.zst (the staged tree), which is CLEAN, so it never sees the sidecar
    the .app also ships. Pointing the identity scan at the assembled sidecar closes
    exactly the gap the 0.0.9 ARRIVES probe caught, at BUILD time. High-entropy
    literals (home paths, usernames, the known mac-VM creds) are hunted EVERYWHERE
    incl node_modules; a low-entropy bare first name is hunted non-vendor only —
    the same anti-false-positive scoping as phase B/C.
    """
    # ── THE PASS PATH MUST PROVE IT DID WORK (EI-20097383942651504) ────────────
    # This gate used to print "✓ CLEAN" and exit 0 for a directory that DOES NOT
    # EXIST: every root was skipped, no bytes were read, `files` stayed empty, and
    # empty read as clean. A release gate wired to a typo'd, renamed or unset-var
    # path is then a rubber stamp that can never fail — the most dangerous shape a
    # check can have, because its output is identical to a real pass. Found by
    # fat-fingering an unset shell variable into a scan path during the 0.0.14 cut.
    #
    # Same family as the `-I` hole this scan already closed (grep_l's docstring:
    # "A scan that inspects nothing is indistinguishable from a scan that found
    # nothing") — that fix taught the scan to READ binaries but left it free to
    # read NOTHING AT ALL. "Found no problems" and "looked at nothing" must not be
    # the same exit code, so coverage is asserted here and REPORTED on success.
    if not dirs:
        print("AUDIT ERROR: --scan-dir needs at least one directory", file=sys.stderr)
        return 2
    missing = [d for d in dirs if not os.path.isdir(d)]
    if missing:
        print(f"\n    ✗ SCAN TARGET MISSING — refusing to report CLEAN on a "
              f"directory that does not exist ({len(missing)} of {len(dirs)})\n",
              file=sys.stderr)
        for d in missing:
            print(f"        {d}", file=sys.stderr)
        print("\n  A gate pointed at a path that isn't there scans nothing and would "
              "'pass' forever.\n  Fix the caller's path (an unset shell variable "
              "expands to an empty argument).", file=sys.stderr)
        return 2

    lits = identity_literals()

    # ── THE QUERY SET MUST BE PROVEN TOO, NOT JUST THE CORPUS ──────────────────
    # This function already refuses to call CLEAN on a missing directory, on 0 files,
    # and on bytes nobody read — three hard-won guards, all asserting that the scan
    # READ everything. None of them asserts that it KNEW WHAT TO LOOK FOR.
    #
    # That is the gap EI-20583328178472869 fell through: git `user.name` became the
    # git-sync bot, so the owner's bare first name silently left `low` below, and this
    # backstop then read every byte, matched nothing, and reported CLEAN — passing all
    # three coverage guards on the way. Full corpus coverage, empty query.
    #
    # The name is the ONLY literal with no shape to fall back on (a home path or an
    # address is still caught structurally), so its absence cannot be recovered
    # downstream. Same principle as grep_l's "a scan that inspects nothing is
    # indistinguishable from a scan that found nothing" — applied to the NEEDLES.
    #
    # NOTE this runs BEFORE the KNOWN_SENSITIVE_IDENTITIES merge on purpose: that
    # denylist carries a github handle and VM logins but NO name entry, so merging
    # first would make a blind scan look equipped.
    if not has_owner_name_literal(lits):
        print("\n    ✗ REFUSING TO CERTIFY — no owner-name literal resolved, so this\n"
              "      backstop cannot hunt the owner's name and CLEAN would be meaningless.\n"
              f"      Fix: export {OWNER_NAME_ENV}='<the owner's name>' for this build.\n",
              file=sys.stderr)
        return 2

    lits.update(KNOWN_SENSITIVE_IDENTITIES)
    high = sorted({v for v in lits.values() if not is_low_entropy(v)})
    low = sorted({v for v in lits.values() if is_low_entropy(v)})
    print("==> identity-scan of assembled tree (honors NO path-exclude — WI-4419)")
    print(f"    high-entropy (all files):  {', '.join(high) or '(none)'}")
    print(f"    low-entropy (non-vendor):  {', '.join(low) or '(none)'}")

    covered, symlinked_dirs, links = _scan_coverage(dirs)
    print(f"    coverage: {covered:,} file(s) reachable by the scan")

    # Symlink TARGETS, scanned as content (WI-39462). Collected before the ⚠ below
    # so that a link which is both untraversable AND leaking is reported as a
    # FINDING, not merely as a coverage caveat.
    link_hits = []
    if links:
        print(f"    symlinks: reading {len(links):,} link target(s) "
              f"(a target string is content no grep can reach)")
        for p, target in links:
            for rule, lit in lits.items():
                # Low-entropy literals (a bare first name) are NOT hunted here: a
                # path component legitimately matching a common first name would
                # red the gate on nothing, the same anti-false-positive scoping the
                # content passes use. A home path / user / host in a target is
                # high-entropy and unambiguous.
                if is_low_entropy(lit):
                    continue
                if lit_rx(lit).search(target):
                    link_hits.append((rule, p, target))
                    break

    if symlinked_dirs:
        # `grep -r` does not descend into a symlinked directory, so these ship but
        # are NOT scanned. Naming them keeps the blind spot visible instead of
        # letting it hide inside a CLEAN.
        print(f"    ⚠ {len(symlinked_dirs)} symlinked director(ies) are NOT traversed "
              f"by this scan (grep -r does not follow them):")
        for d in symlinked_dirs[:10]:
            print(f"        {d}")
        if len(symlinked_dirs) > 10:
            print(f"        … and {len(symlinked_dirs) - 10:,} more")
    if covered == 0:
        print(f"\n    ✗ SCAN READ NOTHING — refusing to report CLEAN on 0 files\n",
              file=sys.stderr)
        for d in dirs:
            print(f"        {d}", file=sys.stderr)
        print("\n  The director(ies) exist but hold no regular files the scan can "
              "read.\n  A directory of SYMLINKS scans as empty for exactly this "
              "reason — point the gate\n  at the assembled tree, not at a staging "
              "dir of links.", file=sys.stderr)
        return 2

    files = set()

    def grep_l(pats, scoped, roots, label=None, binary=True):
        """P-012: `-a` (treat binary as text), NEVER `-I` — for HIGH-entropy literals.

        This used to pass `-I` for everything, which SKIPS binary files entirely — so
        the scan billed as "the assembled bytes that actually ship" silently never
        looked at a database dump, a corestore, or any compiled artifact, and printed
        "✓ CLEAN". A scan that inspects nothing is indistinguishable from a scan
        that found nothing. phase_b_content already used `-a` for this reason.

        ⚠ BUT `-a` IS WRONG FOR A LOW-ENTROPY LITERAL (`binary=False`), and applying
        it to one made the gate cry wolf at scale (WI-37553). A bare first name is
        ~3 characters; word-boundary-matched across GIGABYTES of compiled and
        compressed bytes it matches CONSTANTLY by chance, and such a hit carries no
        information. Measured on the 0.0.14 AppDir: 9 of 16 "leaks" were noise —
        glibc's own `libm.so.6` matched; the GitHub CLI matched a Go symbol in
        `mimetype/internal/magic` naming the owner VIDEO FORMAT; and the seed's git
        bundles matched random bytes inside zlib-compressed packfile data while
        containing ZERO plaintext author lines. That noise very nearly cost days of
        work removing a real feature to fix nothing.

        The asymmetry is the point, and it costs the gate NO power: a high-entropy
        literal (home path, username, email, hostname) stays hunted EVERYWHERE
        including binaries, because such a string cannot appear by chance. Only the
        low-entropy name is restricted to TEXT, where a word-boundary match is
        actually evidence. This is the P-012 fix kept intact, not walked back.
        """
        if not pats:
            return
        for root in roots:
            if not os.path.isdir(root):
                print(f"    scan-dir: {root} absent — skipping")
                continue
            cmd = ["grep", "-ralE" if binary else "-rlIE"]
            if scoped:
                cmd.append("--exclude-dir=node_modules")
            for p in pats:
                cmd += ["-e", lit_ere(p)]
            cmd.append(root)
            r = subprocess.run(cmd, capture_output=True, text=True)
            for line in r.stdout.splitlines():
                if line.strip():
                    hit = line.strip()
                    if not binary:
                        display_name = os.path.relpath(hit, root)
                        if not file_has_unexplained_low_entropy(
                                hit, display_name, pats):
                            continue
                    files.add(f"{label}!{os.path.relpath(hit, root)}" if label else hit)

    grep_l(high, False, dirs)
    grep_l(low, True, dirs, binary=False)

    # ── CREDENTIALS in the bytes that ship (WI-10003577) ─────────────────────
    # CREDENTIAL_ERE used to run ONLY in phase B, over source.tar.zst. This backstop
    # — the one every platform leg points at the assembled sidecar / finished
    # installer — hunted identity literals and nothing else, so a real key in the
    # SHIPPED node_modules was invisible to it. The only finished-bytes key check was
    # bin/audit-bundle.sh: mac-only, PostHog-only, with its own one-key allowlist
    # that drifted from BENIGN_ERE and redded the 0.0.22 cut on lost-pixel's vendor
    # key. Same rules and the same acceptances as phase B (is_benign_credential),
    # binary-aware (`-a`), everywhere including node_modules: a credential cannot
    # match by chance the way a bare first name does.
    cred_hits = []

    def grep_credentials(roots, label=None):
        pats = [arg for _name, pat in CREDENTIAL_ERE for arg in ("-e", pat)]
        for root in roots:
            if not os.path.isdir(root):
                continue
            # -Z: NUL after the filename, so a path containing ':' cannot be split
            # into a wrong (path, value) pair.
            r = subprocess.run(["grep", "-raoZE", *pats, root], capture_output=True)
            if r.returncode > 1:
                print(f"    credentials: grep failed on {root} (exit {r.returncode}): "
                      f"{r.stderr.decode('utf-8', 'replace')[:300]}", file=sys.stderr)
                cred_hits.append(("scan-error", label or root, "(grep failed)"))
                continue
            for raw in r.stdout.split(b"\n"):
                path_b, sep, val_b = raw.partition(b"\0")
                if not sep:
                    continue
                val = val_b.decode("utf-8", "replace")
                if is_benign_credential(val):
                    continue
                path = os.fsdecode(path_b)
                shown = f"{label}!{os.path.relpath(path, root)}" if label else path
                cred_hits.append((credential_rule(val), shown, val))

    grep_credentials(dirs)

    # P-012 archive pass: a compressed archive's payload is not present in its own
    # bytes, so no grep — binary-aware or not — can see inside it. Expand, scan the
    # contents, discard. An archive we cannot open is reported and FAILS: the whole
    # point of this pass is that "not inspected" must stop reading as "clean".
    archives = sorted(set(_iter_archives(dirs)))
    uninspectable = []
    if archives:
        print(f"    archives: expanding {len(archives)} archive(s) to scan contents")
        with tempfile.TemporaryDirectory(prefix="papercusp-audit-arch-") as tmp:
            for idx, arc in enumerate(archives):
                dest = os.path.join(tmp, f"a{idx}")
                if not _expand_archive(arc, dest):
                    uninspectable.append(arc)
                    continue
                grep_l(high, False, [dest], label=arc)
                grep_credentials([dest], label=arc)
                # A SYSTEM IMAGE (an OS rootfs tarball, e.g. the WSL runtime) is
                # vendor content end to end, so a bare first name inside it is never
                # evidence — it is some upstream author's. Measured on the 0.0.14
                # AppDir: the only low-entropy hit in papercup-runtime.tar.gz was
                # `asm/vmx.h` line 21, the Linux kernel header crediting KVM's
                # co-creator, who happens to share the owner's first name. That is
                # the same class the gate already excludes node_modules for.
                # HIGH-entropy literals are STILL hunted here (see the call above):
                # a real build path, email or hostname baked into a rootfs is a
                # genuine leak and must still fail.
                # ⚠ Detected per-archive rather than by excluding directory NAMES:
                # `--exclude-dir` matches a BASENAME, so excluding `lib`/`include`
                # would also blind the scan inside our OWN source.tar.zst.
                if _looks_like_system_image(dest):
                    print(f"    archives: {os.path.basename(arc)} is an OS image — "
                          f"low-entropy (bare-name) pass skipped as vendor; "
                          f"high-entropy pass still applied")
                else:
                    grep_l(low, True, [dest], label=arc, binary=False)
                shutil.rmtree(dest, ignore_errors=True)

    if uninspectable:
        print(f"\n    ✗ {len(uninspectable)} ARCHIVE(S) COULD NOT BE INSPECTED — "
              f"refusing to report CLEAN on bytes nobody read\n")
        for f in uninspectable[:40]:
            print(f"        {f}")
        print("\n  An archive this gate cannot open is a hole in the identity scan, not a pass.")
        print("  Either teach _expand_archive its format, or stop shipping it.")
        return 1

    # ── Owner-authorised seed content (WI-37553, [owner 2026-08-10]) ───────────
    # The seed corestore IS the pot's own hive log, and this alpha ships the pot
    # READABLE by explicit owner decision (the same call as WI-3232's
    # epoch-keys.json). TWO different things put the build box's machine label in
    # there and only ONE of them is content — the distinction is the whole reason
    # this is an acceptance and not an exclude:
    #   • 000011.log — a `presence` row inside a hypercore BLOCK:
    #     "machine_label":"<hostname>-<user>". That is signed log content; the
    #     merkle tree covers those bytes, so editing them breaks
    #     content-addressing outright. Owner ruled: "Ship it — it's the pot's
    #     content."
    #   • *.sst — RocksDB TABLE PROPERTIES (`host.identity`, sitting beside
    #     `creating.db.identity` / `data.size` / `filter.policy`). NOT hypercore
    #     data and NOT content-addressed: RocksDB stamps the creating machine's
    #     hostname into every SST it writes. This one SHOULD be stripped at
    #     source (DBOptions::db_host_id = ""), but rocksdb-native exposes no such
    #     option today — tracked separately, and it is why the owner's "strip it
    #     if that is possible" resolves to "not yet" rather than "never".
    # Accepts ONLY those two literals, ONLY under a seed corestore path, and
    # NEVER inside an archive member (which we cannot re-read to prove the
    # negative). Every other identity literal still hard-fails there — a home
    # path, git email or git name in the seed is a real leak and is NOT covered
    # by the owner's ruling. Measured on the 0.0.14 seed those three are at ZERO,
    # so this keeps genuine power instead of blanket-excluding the directory,
    # which is what the "never add an exclude" rule below exists to prevent.
    seed_ok = {lits[k] for k in ("build-hostname", "build-user-name") if k in lits}
    accepted = []
    if files and seed_ok:
        others = [p for p in (high + low) if p not in seed_ok]
        kept = set()
        for f in sorted(files):
            norm = f.replace(os.sep, "/")
            if "!" in f or "/seed/corestore/" not in norm:
                kept.add(f)
                continue
            unauth = [p for p in others if _literal_in_file(f, p)]
            if unauth:
                print(f"    seed: {os.path.basename(f)} carries NON-authorised "
                      f"identity ({', '.join(unauth)}) — still FAILING")
                kept.add(f)
            else:
                accepted.append(f)
        files = kept
    if accepted:
        print(f"\n    ⚠ ACCEPTED {len(accepted)} seed-corestore file(s) carrying the "
              f"build-box machine label — owner-authorised; the pot ships READABLE.")
        for f in accepted[:10]:
            print(f"        {f}")
        print("      Hypercore block content cannot be edited without breaking "
              "content-addressing;\n      the *.sst copies are RocksDB host.identity "
              "table properties (strippable only at source).\n"
              "      Any OTHER identity literal here would still have failed.")

    # ── Authorised product strings (WI-38233) ─────────────────────────────────
    # See AUTHORISED_PRODUCT_STRINGS for WHY each entry ships. The rule here is
    # arithmetic, not pattern-matching: count every occurrence of each identity
    # literal in the file, count how many of those occurrences are inside an
    # authorised string, and accept ONLY on equality. Anything unaccounted for
    # keeps the file failing. Never applied inside an archive member ("!"), whose
    # bytes we cannot re-read to prove the negative.
    authorised = []
    if files:
        kept = set()
        for f in sorted(files):
            if "!" in f:
                kept.add(f)
                continue
            unexplained = []
            for lit in (high + low):
                n = _count_literal(f, lit)
                if n == 0:
                    continue
                if n < 0:
                    unexplained.append(f"{lit} (unreadable)")
                    continue
                covered = 0
                for ok_str in AUTHORISED_PRODUCT_STRINGS:
                    if lit in ok_str:
                        c = _count_occurrences(f, ok_str)
                        if c > 0:
                            covered += c * ok_str.count(lit)
                if covered != n:
                    unexplained.append(f"{lit} x{n - covered} unaccounted")
            if unexplained:
                kept.add(f)
            else:
                authorised.append(f)
        files = kept
    if authorised:
        print(f"\n    ⚠ ACCEPTED {len(authorised)} file(s) whose ONLY identity hits are "
              f"authorised product strings (WI-38233):")
        for f in authorised[:10]:
            print(f"        {os.path.basename(f)}")
        print("      Every occurrence was counted and matched to an authorised string;\n"
              "      one unaccounted occurrence would still have FAILED the file.")

    # Symlink-target findings are reported SEPARATELY and are deliberately NOT run
    # through the seed / authorised-product-string acceptance passes above: both
    # re-READ the offending file to prove the negative by counting occurrences, and
    # a symlink has no content to re-read. Accepting one on a content argument would
    # be accepting it on evidence that does not exist.
    if link_hits:
        print(f"\n    ✗ SYMLINK TARGET(S) CARRY SENSITIVE IDENTITY — MUST NOT SHIP "
              f"({len(link_hits)} link(s))\n")
        for rule, p, target in link_hits[:40]:
            print(f"        [{rule}]  {p} -> {target}")
        if len(link_hits) > 40:
            print(f"        … and {len(link_hits) - 40:,} more")
        print("\n  A symlink's TARGET is committed content: the git blob of a mode-120000")
        print("  entry IS the target string, so an absolute path here ships the build")
        print("  box's layout. `grep -r` never reads a symlink, which is why this could")
        print("  sit in the tree unnoticed — do not 'fix' it by re-hiding it from the scan.")
        print("  Fix the SOURCE: make the link repo-relative, or stop tracking it.")

    if cred_hits:
        print(f"\n    ✗ ASSEMBLED BUNDLE CARRIES A CREDENTIAL — MUST NOT SHIP "
              f"({len(cred_hits)} hit(s))\n")
        for rule, where, val in cred_hits[:40]:
            # Never echo a live secret into a build log: enough to find it, no more.
            print(f"        [{rule}]  {where}  ({val[:10]}…)")
        if len(cred_hits) > 40:
            print(f"        … and {len(cred_hits) - 40:,} more")
        print("\n  Fix the SOURCE (prune the file from the sidecar copy, or scrub the value).")
        print("  A third party's OWN published public key may be accepted in BENIGN_ERE /")
        print("  BENIGN_CREDENTIAL_VALUE_SHA256 WITH the file it comes from named — never a broad pattern.")

    if not files and not link_hits and not cred_hits:
        print("    ✓ CLEAN — no sensitive/build-box identity or credential in the assembled bundle "
              f"({covered:,} file(s), {len(links):,} link target(s), "
              f"{len(archives)} archive(s) expanded and scanned)")
        print_coverage_gaps(identity_coverage_gaps(lits))
        return 0
    if files:
        print(f"\n    ✗ ASSEMBLED BUNDLE CARRIES SENSITIVE IDENTITY — MUST NOT SHIP "
              f"({len(files)} file(s))\n")
        for f in sorted(files)[:40]:
            print(f"        {f}")
        if len(files) > 40:
            print(f"        … and {len(files) - 40:,} more")
        print("\n  This scan IGNORES the path-exclude list BY DESIGN (scan the bytes that ship).")
        print("  Fix the SOURCE: prune the leaking file from the sidecar copy in")
        print("  build-desktop-sidecar.sh, or scrub the value — never add an exclude here.")
    return 1


#: The FINISHED artifacts we publish — installer CONTAINERS, not tree members.
#:
#: ⚠ DELIBERATELY NOT MERGED INTO ARCHIVE_SUFFIXES, and that separation is the
#: whole design (WI-39458). `_iter_archives` walks the WHOLE scanned tree, so
#: teaching it `.exe` would hand it every vendored Windows helper binary in
#: node_modules and every .NET assembly — none of which any expander can open —
#: and each would then become "uninspectable", i.e. a RED on every cut. That
#: converts a false PASS into a permanent false FAILURE, which is not a fix.
#:
#: A container is instead named EXPLICITLY by the caller, one artifact at a
#: time, so the fail-closed rule below applies to the handful of files we are
#: about to publish and to nothing else.
ARTIFACT_SUFFIXES = (".exe", ".msi", ".dmg", ".appimage", ".zip", ".bin",
                     ".deb", ".tar.gz", ".tgz", ".tar.zst", ".app.tar.gz")

#: An expansion that "succeeded" while recovering almost nothing is the SAME
#: false-clean this entrypoint exists to remove, one level deeper — and it is
#: not hypothetical. Pointed at an Inno Setup PE, `7z` misdetects the stub as
#: gzip, exits 0, and recovers ~49KB of a 4.5MB installer. Scanning that 1%
#: and reporting CLEAN would be strictly worse than not scanning at all,
#: because the verdict reads as evidence. So coverage is ASSERTED, not assumed:
#: a container must yield a plausible fraction of its own size or it is
#: uninspectable. Installers are compressed, so a real expansion is normally
#: LARGER than the container and this floor has generous headroom.
ARTIFACT_MIN_EXPANSION_RATIO = 0.10


def _tree_bytes(root):
    """Total bytes of regular files under `root` (symlinks not followed)."""
    total = 0
    for dirpath, _dirnames, filenames in os.walk(root, followlinks=False):
        for fn in filenames:
            p = os.path.join(dirpath, fn)
            if os.path.islink(p):
                continue
            try:
                total += os.path.getsize(p)
            except OSError:
                pass
    return total


def _tree_census(root, exclude_top_level=()):
    """Logical and unique-inode bytes for an expanded artifact tree.

    A release tree can contain hardlinks. Counting only directory-entry sizes
    overstates what is physically installed, while counting only unique inodes
    understates the logical footprint users and package manifests observe. The
    distribution contract intentionally records both, so keep the two measures
    together at the one archive-expansion seam every platform already reuses.
    """
    logical = 0
    unique = 0
    files = 0
    symlinks = 0
    seen = set()
    excluded = set(exclude_top_level)
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        if os.path.abspath(dirpath) == os.path.abspath(root) and excluded:
            dirnames[:] = [dirname for dirname in dirnames if dirname not in excluded]
        for filename in filenames:
            path = os.path.join(dirpath, filename)
            try:
                stat = os.lstat(path)
            except OSError:
                continue
            if os.path.islink(path):
                symlinks += 1
                continue
            if not os.path.isfile(path):
                continue
            files += 1
            logical += stat.st_size
            identity = (stat.st_dev, stat.st_ino)
            if identity not in seen:
                seen.add(identity)
                unique += stat.st_size
    return {
        "files": files,
        "symlinks": symlinks,
        "logicalBytes": logical,
        "uniqueInodeBytes": unique,
    }


def _tar_member_census(fileobj, mode="r|*"):
    files = 0
    total = 0
    with tarfile.open(fileobj=fileobj, mode=mode) as archive:
        for member in archive:
            if member.isfile():
                files += 1
                total += member.size
    return {"archiveFileMembers": files, "archiveMemberBytes": total}


def _artifact_member_census(path, expanded):
    """Member bytes from the archive directory, not the expanded tree.

    This is deliberately distinct from `_tree_census`: a hardlink member has
    zero payload bytes in tar but contributes another logical file after
    extraction. Formats whose native directory is not directly readable fall
    back loudly to the expanded-tree measure; Linux deb/tar and zip artifacts
    use their real member tables.
    """
    low = path.lower()
    if low.endswith(".deb"):
        process = subprocess.Popen(
            ["dpkg-deb", "--fsys-tarfile", path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            result = _tar_member_census(process.stdout)
        finally:
            if process.stdout:
                process.stdout.close()
        stderr = (process.stderr.read() if process.stderr else b"")
        rc = process.wait()
        if rc != 0:
            raise RuntimeError(
                f"dpkg-deb could not read payload members (exit {rc}): "
                f"{stderr.decode(errors='replace')[:200]}"
            )
        return {**result, "archiveMemberBytesSource": "deb-data-tar"}
    if low.endswith((".tar.gz", ".tgz", ".app.tar.gz")):
        with open(path, "rb") as source:
            return {
                **_tar_member_census(source, "r:gz"),
                "archiveMemberBytesSource": "tar-directory",
            }
    if low.endswith(".tar.zst"):
        process = subprocess.Popen(
            ["zstd", "-dc", "--", path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            result = _tar_member_census(process.stdout)
        finally:
            if process.stdout:
                process.stdout.close()
        stderr = (process.stderr.read() if process.stderr else b"")
        rc = process.wait()
        if rc != 0:
            raise RuntimeError(
                f"zstd could not read payload members (exit {rc}): "
                f"{stderr.decode(errors='replace')[:200]}"
            )
        return {**result, "archiveMemberBytesSource": "tar-directory"}
    if low.endswith(".zip"):
        with zipfile.ZipFile(path) as archive:
            members = [member for member in archive.infolist() if not member.is_dir()]
        return {
            "archiveFileMembers": len(members),
            "archiveMemberBytes": sum(member.file_size for member in members),
            "archiveMemberBytesSource": "zip-directory",
        }
    census = _tree_census(expanded)
    return {
        "archiveFileMembers": census["files"],
        "archiveMemberBytes": census["logicalBytes"],
        "archiveMemberBytesSource": "expanded-tree-fallback",
    }


def _expand_installer(path, dest):
    """Expand ONE finished installer container. Returns (ok, method).

    The tool LADDER is ordered by specificity, because a generic extractor that
    merely exits 0 is the failure mode here, not a missing extractor:

      • `.exe` → innoextract FIRST. This project's Windows installer is Inno
        Setup 6 (build-windows-cross.sh packs it with ISCC under wine and emits
        `bundle/inno/`), and the Server role DISK-SPANS into a `setup.exe` stub
        plus `-setup-N.bin` slices. innoextract given the stub follows those
        sibling slices itself, which is the only way the ~2.2GB payload is ever
        actually read. 7z is tried after it, for a genuine NSIS installer.
      • `.AppImage` → its embedded runtime's `--appimage-extract` first. The
        AppImages this project emits use zstd-compressed SquashFS, which the
        host's 7z can identify but cannot extract. The runtime is the producer's
        own format reader and this mode extracts without launching AppRun.
      • `.dmg` → 7z first; libdmg-hfsplus fallback for DMGs produced by this
        repo's mac cross-builder. 7z can decode their outer UDIF but reports
        Data Error on some valid HFS+ members; the producer's hfsplus reader
        can extract those same members from the raw partition.
      • `.msi` / `.bin` → 7z, whose MSI/Udf handlers cover them.
      • anything `_expand_archive` already knows (.zip/.tar.*/.deb) → that, so
        the two entrypoints cannot drift in how they read a format they share.

    Returns ok=False when nothing could open it. The CALLER fails closed on that
    — an installer this gate cannot open is a hole in the identity scan, not a
    pass, exactly as for a tree archive.
    """
    os.makedirs(dest, exist_ok=True)
    low = path.lower()

    if low.endswith(".exe"):
        innoextract = _innoextract_command()
        if innoextract:
            # -e writes payloads, -t makes checksum mismatches fatal, and -s
            # silences listings (NOT warnings). Unknown-file extraction stays
            # enabled by default; never add --no-extract-unknown here.
            r = sh(f"{q(innoextract)} -e -t -s --output-dir {q(dest)} {q(path)}")
            integrity_warning = _innoextract_integrity_warning(r)
            if integrity_warning:
                print(
                    "    scan-artifact: innoextract reported an integrity "
                    f"warning: {integrity_warning}"
                )
                # Do not fall through to a generic extractor after a selected
                # Inno reader reports damaged disk-span bytes.  A second tool
                # can misread the same stub/slices and turn this warning into a
                # false certification.
                return False, f"innoextract ({innoextract}) integrity warning"
            if r.returncode == 0 and _tree_bytes(dest) > 0:
                return True, f"innoextract ({innoextract})"
        if shutil.which("7z"):
            r = sh(f"7z x -y -bd -o{q(dest)} -tnsis {q(path)}")
            if r.returncode == 0 and _tree_bytes(dest) > 0:
                return True, "7z -tnsis"
            # Generic last rung: a self-extracting `.exe` is commonly a zip/7z/cab
            # with a PE stub glued in front, and 7z identifies those by content.
            # It is safe to try LAST precisely because the caller's expansion-ratio
            # floor catches 7z's known failure mode here — misdetecting an Inno PE
            # as gzip and "succeeding" with a ~49KB fragment of a 4.5MB installer.
            r = sh(f"7z x -y -bd -o{q(dest)} {q(path)}")
            if r.returncode == 0 and _tree_bytes(dest) > 0:
                return True, "7z"
        return False, "none"

    if low.endswith(".appimage"):
        if os.access(path, os.X_OK):
            # `--appimage-extract` is handled by the embedded AppImage runtime;
            # it does NOT execute the packaged AppRun. Run inside `dest` because
            # the runtime always writes a fixed `squashfs-root/` sibling. Silence
            # its one-line-per-member stdout — scan_dir below is the auditable
            # coverage report, and a 15k-file member list only obscures failures.
            r = subprocess.run(
                [path, "--appimage-extract"],
                cwd=dest,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
            extracted = os.path.join(dest, "squashfs-root")
            if r.returncode == 0 and _tree_bytes(extracted) > 0:
                return True, "AppImage runtime"
            detail = (r.stderr or "").strip().replace("\n", " ")[:200]
            print(f"    scan-artifact: AppImage runtime extraction failed for {path}: "
                  f"exit {r.returncode}{f': {detail}' if detail else ''}")
        else:
            print(f"    scan-artifact: {path} is not executable; "
                  "cannot invoke its AppImage extraction runtime")
        # Keep 7z as a compatibility fallback for older gzip/xz AppImages it can
        # genuinely expand. The caller's ratio floor rejects its known partial
        # extraction shapes, so a false zero cannot become a clean verdict.
        if shutil.which("7z"):
            r = sh(f"7z x -y -bd -o{q(dest)} {q(path)}")
            if r.returncode == 0 and _tree_bytes(dest) > 0:
                return True, "7z"
        return False, "AppImage runtime+7z"

    if low.endswith(".dmg"):
        if not shutil.which("7z"):
            print(f"    scan-artifact: cannot expand {path}: 7z not on PATH "
                  f"(a container this gate cannot open is a hole, not a pass)")
            return False, "none"
        r = sh(f"7z x -y -bd -o{q(dest)} {q(path)}")
        if r.returncode == 0 and _tree_bytes(dest) > 0:
            return True, "7z"

        # EI-21026285649061558 — libdmg-hfsplus parity with the PRODUCER.
        # build-mac-cross.sh creates these DMGs as:
        #   raw HFS+ image → hfsplus addall → `dmg` UDIF compression.
        # The host 7z can list the final DMG and inflate its outer partition,
        # but its nested HFS reader reports Data Error on valid large/sparse
        # members (measured on the 0.0.18 GUI+Server DMGs). Accepting its partial
        # tree would certify bytes nobody read. Instead, force 7z to decode ONLY
        # the outer DMG layer (`-tDmg`), then hand the raw HFS+ partition to the
        # exact tool family that wrote it. The same PAPERCUSP_MAC_CROSS_TOOLS
        # seam/default as build-mac-cross.sh prevents a parallel tool locator.
        mac_tools = os.environ.get(
            "PAPERCUSP_MAC_CROSS_TOOLS",
            os.path.join(os.path.expanduser("~"), ".papercusp", "mac-cross-tools"),
        )
        hfsplus = os.path.join(mac_tools, "hfsplus")
        outer = dest + ".dmg-outer"
        shutil.rmtree(dest, ignore_errors=True)
        shutil.rmtree(outer, ignore_errors=True)
        os.makedirs(dest, exist_ok=True)
        os.makedirs(outer, exist_ok=True)
        try:
            if not os.access(hfsplus, os.X_OK):
                print(f"    scan-artifact: 7z could not fully extract {path}, and "
                      f"libdmg-hfsplus reader is missing/not executable at {hfsplus}")
                return False, "7z+libdmg-hfsplus"
            r = sh(f"7z x -y -bd -tDmg -o{q(outer)} {q(path)}")
            raw_parts = []
            if r.returncode == 0:
                for dirpath, _dirnames, filenames in os.walk(outer):
                    for filename in filenames:
                        candidate = os.path.join(dirpath, filename)
                        if os.path.isfile(candidate) and os.path.getsize(candidate) > 0:
                            raw_parts.append(candidate)
            if len(raw_parts) != 1:
                print(f"    scan-artifact: outer DMG decode yielded {len(raw_parts)} "
                      f"nonempty raw partitions for {path}; expected exactly one")
                return False, "7z -tDmg+libdmg-hfsplus"
            r = subprocess.run(
                [hfsplus, raw_parts[0], "extractall"],
                cwd=dest,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
            if r.returncode == 0 and _tree_bytes(dest) > 0:
                return True, "7z -tDmg + libdmg-hfsplus"
            detail = (r.stderr or "").strip().replace("\n", " ")[:200]
            print(f"    scan-artifact: libdmg-hfsplus extraction failed for {path}: "
                  f"exit {r.returncode}{f': {detail}' if detail else ''}")
            return False, "7z -tDmg+libdmg-hfsplus"
        finally:
            # The raw partition is larger than both the DMG and extracted tree;
            # it is only an intermediate reader seam and must not double the
            # audit's disk footprint while scan_dir walks the real payload.
            shutil.rmtree(outer, ignore_errors=True)

    if low.endswith((".msi", ".bin")):
        if not shutil.which("7z"):
            print(f"    scan-artifact: cannot expand {path}: 7z not on PATH "
                  f"(a container this gate cannot open is a hole, not a pass)")
            return False, "none"
        r = sh(f"7z x -y -bd -o{q(dest)} {q(path)}")
        if r.returncode == 0 and _tree_bytes(dest) > 0:
            return True, "7z"
        return False, "7z"

    # Shared formats go through the ONE expander both entrypoints use.
    if not _expand_archive(path, dest):
        return False, "archive-pass"

    # ── A WRAPPER IS NOT THE PAYLOAD (WI-39458) ──────────────────────────────
    # The published Windows Server artifact is a `.zip` whose three members are
    # an Inno Setup STUB (`…-setup.exe`, ~4.5MB) plus its DiskSpan slices
    # (`…-setup-1.bin` ~2.0GB, `…-setup-2.bin` ~140MB). Expanding the zip alone
    # therefore "succeeds", passes the size-ratio check comfortably (~2.2GB out
    # of a 2.2GB container), and leaves ~100% of the real payload sitting in two
    # blobs that the scan can only grep as opaque bytes. That is the SAME false
    # clean this entrypoint exists to remove, one level down — and it is the
    # exact artifact this item was filed on, so failing to recurse here would
    # ship a fix that does not fix the reported case.
    #
    # ⚠ RECURSION IS DELIBERATELY NARROW — an installer STUB, not every `.exe`.
    # The expanded payload legitimately contains program executables we bundle
    # (node.exe, gh.exe). Blanket-recursing on `.exe` would hand those to an
    # expander that cannot open them, mark them uninspectable, and red every
    # cut — re-creating, inside this entrypoint, precisely the regression that
    # keeps `.exe` out of ARCHIVE_SUFFIXES. So only a file that names itself a
    # setup stub is treated as a container.
    #
    # SNAPSHOT FIRST: the loop writes new directories INTO `dest`, and walking a
    # tree while extending it can descend into what the loop just produced — an
    # inner installer that itself contains a stub would then recurse without
    # bound. Collect, then expand.
    stubs = []
    for dirpath, _dirnames, filenames in os.walk(dest, followlinks=False):
        for fn in filenames:
            if _looks_like_installer_stub(fn):
                stubs.append((dirpath, fn))
    for dirpath, fn in stubs:
        stub = os.path.join(dirpath, fn)
        inner = os.path.join(dest, f"__inner__{fn}")
        ok, how = _expand_installer(stub, inner)
        if not ok:
            print(f"    scan-artifact: {os.path.basename(path)} wraps installer "
                  f"{fn!r}, which could NOT be expanded (tried: {how}) — "
                  f"its payload is a hole, not a pass")
            return False, f"archive-pass+{how}"
        print(f"    scan-artifact: {os.path.basename(path)} wraps {fn!r} — "
              f"expanded its payload via {how}")
    return True, "archive-pass"


#: A file that NAMES ITSELF an installer stub. Kept as its own predicate so the
#: narrowness above is testable and cannot quietly widen into "every .exe".
def _looks_like_installer_stub(name):
    low = name.lower()
    if low.endswith((".msi", ".dmg", ".appimage")):
        return True
    # Tauri/Inno emit `<Product>_<version>_<arch>-setup.exe`; the DiskSpan
    # slices beside it are `-setup-N.bin` and are pulled in BY the stub, so they
    # must NOT be expanded independently (innoextract needs the stub to find
    # them, and 7z on a raw slice recovers a misdetected fragment).
    return low.endswith("-setup.exe") or low.endswith("setup.exe")


def _windows_server_runtime_violations(expanded):
    """Check the inputs the native Server reads BEFORE staging its WSL runtime.

    Reuse the existing finished-container expansion: a source-tree check cannot
    catch Wine/Inno wildcard omission of .sidecar-build-stamp. Bind the stamp to
    the actual extracted serve.mjs, not merely a well-formed claimed hash.
    """
    runtimes = []
    for directory, _dirs, files in os.walk(expanded, followlinks=False):
        if os.path.basename(directory) == "sidecar" and os.path.basename(os.path.dirname(directory)) == "app":
            runtimes.append(directory)
    if len(runtimes) != 1:
        return [f"expected one extracted app/sidecar runtime, found {len(runtimes)}"]
    runtime = runtimes[0]
    stamp_path = os.path.join(runtime, ".sidecar-build-stamp")
    serve_path = os.path.join(runtime, "serve.mjs")
    if not os.path.isfile(stamp_path) or os.path.islink(stamp_path):
        return ["required Windows Server .sidecar-build-stamp is absent or not a regular file"]
    if not os.path.isfile(serve_path) or os.path.islink(serve_path):
        return ["required Windows Server serve.mjs is absent or not a regular file"]
    try:
        with open(stamp_path, encoding="utf-8") as source:
            stamp = json.load(source)
    except (OSError, ValueError, UnicodeError):
        return ["Windows Server .sidecar-build-stamp is unreadable or invalid JSON"]
    claimed = stamp.get("serveSha256") if isinstance(stamp, dict) else None
    if not isinstance(claimed, str) or re.fullmatch(r"[0-9a-fA-F]{64}", claimed) is None:
        return ["Windows Server .sidecar-build-stamp has no valid 64-hex serveSha256"]
    if _sha256_file(serve_path) != claimed.lower():
        return ["Windows Server .sidecar-build-stamp does not match extracted serve.mjs"]
    return []


def scan_artifact(paths):
    """Identity-scan FINISHED installer artifacts — the bytes we actually publish.

    WHY THIS EXISTS SEPARATELY FROM --scan-dir (WI-39458, measured):
    `--scan-dir` scans an assembled TREE and expands the archives it finds inside
    it. Handed a finished installer it therefore does the one thing this gate is
    written to prevent — it greps the container as opaque bytes, expands ZERO
    archives, and reports a POSITIVE clean. Measured 2026-08-16 on the published
    0.0.17 `Papercusp Server_..._x64-setup.zip` (2,240,463,722 B): the gate printed
    "✓ CLEAN … 3 file(s), 0 archive(s) expanded and scanned" and exited 0, while the
    installer's own payload carried the build-box username. ~100% of the shipped
    bytes were never read. The paired control — the same artifact EXTRACTED, then
    `--scan-dir`'d — exits 1 DIRTY. The same bytes cannot be both, so the CLEAN
    verdicts were false.

    Note the AppImage behaved CORRECTLY in that same measurement (7z failed on it,
    coverage was 0, and the gate REFUSED with exit 2). The machinery was never the
    problem; nothing was routing installers INTO it.

    The contract here is fail-closed on three separate ways of learning nothing:
    a container that cannot be opened, one that opens but yields no files, and one
    that opens but recovers an implausible fraction of itself. Once expanded, the
    tree is handed to `scan_dir` — the same literal set, coverage assertion, nested
    archive pass and acceptances — so there is no second scanner to drift.
    """
    require_windows_runtime = "--require-windows-server-runtime" in paths
    want_licenses = "--licenses" in paths
    # Absolute from here on: expanders run their tools with cwd=<scratch dir> (the
    # AppImage runtime MUST, it writes a fixed squashfs-root/), so a caller-relative
    # path resolved there is ENOENT — a manual `--scan-artifact bundle/appimage/X`
    # crashed with a traceback instead of a verdict (R-15, 2026-09-30).
    paths = [os.path.abspath(path) for path in paths
             if path not in ("--require-windows-server-runtime", "--licenses")]
    if not paths:
        print("AUDIT ERROR: --scan-artifact needs at least one artifact", file=sys.stderr)
        return 2
    missing = [p for p in paths if not os.path.isfile(p)]
    if missing:
        print(f"\n    ✗ ARTIFACT MISSING — refusing to report CLEAN on a file that "
              f"does not exist ({len(missing)} of {len(paths)})\n", file=sys.stderr)
        for p in missing:
            print(f"        {p}", file=sys.stderr)
        print("\n  A gate pointed at a path that isn't there scans nothing and would "
              "'pass' forever.\n  Fix the caller's path (an unset shell variable "
              "expands to an empty argument).", file=sys.stderr)
        return 2

    unknown = [p for p in paths if not p.lower().endswith(ARTIFACT_SUFFIXES)]
    if unknown:
        # Not a silent skip: an artifact shape this entrypoint has never been
        # taught is precisely the thing that must not sail through as clean.
        print(f"\n    ✗ UNRECOGNISED ARTIFACT TYPE — refusing to certify "
              f"({len(unknown)} of {len(paths)})\n", file=sys.stderr)
        for p in unknown:
            print(f"        {p}", file=sys.stderr)
        print("\n  Teach ARTIFACT_SUFFIXES + _expand_installer this container, or "
              "stop publishing it.", file=sys.stderr)
        return 2

    print("==> identity-scan of FINISHED artifacts (the published bytes — WI-39458)")
    with tempfile.TemporaryDirectory(prefix="papercusp-audit-artifact-") as tmp:
        dests = []
        uninspectable = []
        runtime_violations = []
        for idx, art in enumerate(paths):
            dest = os.path.join(tmp, f"art{idx}")
            size = os.path.getsize(art)
            ok, method = _expand_installer(art, dest)
            got = _tree_bytes(dest) if ok else 0
            ratio = (got / size) if size else 0.0
            if not ok or got == 0:
                uninspectable.append((art, f"could not expand (tried: {method})"))
                continue
            if ratio < ARTIFACT_MIN_EXPANSION_RATIO:
                uninspectable.append((
                    art,
                    f"expanded via {method} but recovered only {got:,} of {size:,} B "
                    f"({ratio:.1%}) — below the {ARTIFACT_MIN_EXPANSION_RATIO:.0%} floor",
                ))
                continue
            print(f"    {os.path.basename(art)}: expanded via {method} — "
                  f"{got:,} B from a {size:,} B container ({ratio:.0%})")
            if require_windows_runtime:
                runtime_violations.extend(
                    (art, violation)
                    for violation in _windows_server_runtime_violations(dest)
                )
            dests.append(dest)

        if uninspectable:
            print(f"\n    ✗ {len(uninspectable)} ARTIFACT(S) COULD NOT BE INSPECTED — "
                  f"refusing to report CLEAN on bytes nobody read\n", file=sys.stderr)
            for f, why in uninspectable[:40]:
                print(f"        {f}\n            {why}", file=sys.stderr)
            print("\n  An archive this gate cannot open is a hole in the identity scan, "
                  "not a pass.", file=sys.stderr)
            print("  Either teach _expand_installer its format, or stop shipping it.",
                  file=sys.stderr)
            return 2

        if runtime_violations:
            for artifact, violation in runtime_violations:
                print(
                    f"RUNTIME CLOSURE VIOLATION [{os.path.basename(artifact)}]: {violation}",
                    file=sys.stderr,
                )
            return 1
        if want_licenses:
            # REPORT-ONLY for now [owner 2026-09-29, WI-10003906]: "lets disable the
            # blocking for now". The verdict is printed on every release so findings are
            # visible, but it does not stop the release. The AppImage (730 unreviewed bundled
            # Ubuntu libs) and the Windows/macOS Server installers are not calibrated yet.
            # To make it blocking again, return license_rc when it is non-zero.
            license_rc = license_scan_trees(dests)
            if license_rc != 0:
                print(f"    ⚠ license scan exit {license_rc} — REPORT-ONLY, release not stopped "
                      f"(see LICENSE_GATE lines above)", file=sys.stderr)
        return scan_dir(dests)


def license_scan_trees(dests):
    """License verdict over the SAME expanded installer trees (plan
    open-source-release-2026-09-29 P-017, WI-10003906).

    The npm and Cargo lockfile checks cover the dependency graph; a finished installer
    also ships payloads no lockfile names (the Node runtime, PostgreSQL tools, gh,
    kopia, a container rootfs, AI model weights). The policy lives in ONE place —
    scripts/check-licenses.mjs in the superproject — so this only hands it the trees
    this function's caller already expanded. Exit codes pass through: 1 = a denied or
    unreviewed payload, 2 = not measured. Both stop the release.
    """
    repo = os.environ.get("PAPERCUSP_REPO_ROOT") or os.path.realpath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
    )
    script = os.path.join(repo, "scripts", "check-licenses.mjs")
    node = shutil.which("node")
    if not node or not os.path.isfile(script):
        print(f"AUDIT ERROR: --licenses needs node on PATH and {script} "
              f"(set PAPERCUSP_REPO_ROOT to the superproject)", file=sys.stderr)
        return 2
    print("==> license scan of FINISHED artifacts (P-017)")
    cmd = [node, script, "--strict"]
    for dest in dests:
        cmd += ["--installer-tree", dest]
    try:
        return subprocess.run(cmd, timeout=3600).returncode
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"AUDIT ERROR: license scan could not run: {exc}", file=sys.stderr)
        return 2


def _sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _relative_inventory(root):
    files = set()
    dirs = set()
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        rel_dir = os.path.relpath(dirpath, root).replace(os.sep, "/")
        if rel_dir != ".":
            dirs.add(rel_dir)
        for dirname in dirnames:
            rel = os.path.relpath(os.path.join(dirpath, dirname), root)
            dirs.add(rel.replace(os.sep, "/"))
        for filename in filenames:
            rel = os.path.relpath(os.path.join(dirpath, filename), root)
            files.add(rel.replace(os.sep, "/"))
    return files, dirs


def _distribution_contract():
    default = os.path.normpath(os.path.join(
        os.path.dirname(__file__), "..", "src-tauri", "distribution-contract.json"
    ))
    path = os.environ.get("PAPERCUSP_DISTRIBUTION_CONTRACT", default)
    with open(path, "r", encoding="utf-8") as source:
        return path, json.load(source)


def _distribution_artifact_format(path):
    """Stable contract key for a finished installer/container."""
    lower = path.lower()
    for suffix, name in (
        (".appimage", "appimage"),
        (".deb", "deb"),
        (".dmg", "dmg"),
        (".msi", "msi"),
        (".exe", "exe"),
    ):
        if lower.endswith(suffix):
            return name
    return os.path.splitext(lower)[1].lstrip(".") or "unknown"


def _distribution_payload_root(expanded, artifact_format):
    """Return the installed-tree root, not an extractor-owned wrapper dir.

    AppImage's runtime always materializes ``squashfs-root`` below the selected
    extraction directory. Debian and the other installer readers materialize
    their filesystem payload directly at ``expanded``. Contract paths are
    installed paths, so the wrapper must never become part of their lookup.
    """
    if artifact_format == "appimage":
        squashfs_root = os.path.join(expanded, "squashfs-root")
        if os.path.isdir(squashfs_root):
            return squashfs_root
    return expanded


def distribution_census(argv):
    """Expand finished artifacts, enforce the role contract, and emit byte facts.

    Usage: --distribution-census <gui|server> <linux|macos|windows> <artifact...>

    The identity auditor already owns every installer/archive reader. Extending
    that seam avoids a second extractor that can disagree about what an archive
    contains. Linux is fully enforced now; macOS/Windows calls stay fail-closed
    until their per-platform resource roots and fresh size ceilings are recorded
    on their next release cuts (P-011).
    """
    if len(argv) < 3:
        print(
            "AUDIT ERROR: --distribution-census needs "
            "<gui|server> <linux|macos|windows> <artifact...>",
            file=sys.stderr,
        )
        return 2
    role, platform, *artifacts = argv
    if role not in ("gui", "server") or platform not in ("linux", "macos", "windows"):
        print(
            f"AUDIT ERROR: invalid distribution role/platform: {role}/{platform}",
            file=sys.stderr,
        )
        return 2
    missing = [path for path in artifacts if not os.path.isfile(path)]
    if missing:
        print(f"AUDIT ERROR: missing distribution artifact(s): {missing}", file=sys.stderr)
        return 2

    contract_path, contract = _distribution_contract()
    role_contract = contract[role]
    identity = role_contract["installedIdentities"]
    resource_key = f"{platform}ResourceRoot"
    if resource_key not in identity:
        print(
            f"AUDIT ERROR: {role}/{platform} has no {resource_key} in {contract_path}; "
            "record the fresh artifact layout before certifying it",
            file=sys.stderr,
        )
        return 2

    reports = []
    any_violations = False
    with tempfile.TemporaryDirectory(prefix="papercusp-distribution-census-") as tmp:
        for index, artifact in enumerate(artifacts):
            expanded = os.path.join(tmp, f"artifact-{index}")
            ok, method = _expand_installer(artifact, expanded)
            artifact_format = _distribution_artifact_format(artifact)
            expanded_bytes = _tree_bytes(expanded) if ok else 0
            artifact_bytes = os.path.getsize(artifact)
            if not ok or expanded_bytes == 0:
                print(
                    f"AUDIT ERROR: cannot expand distribution artifact {artifact} "
                    f"(tried: {method})",
                    file=sys.stderr,
                )
                return 2
            if artifact_bytes and expanded_bytes / artifact_bytes < ARTIFACT_MIN_EXPANSION_RATIO:
                print(
                    f"AUDIT ERROR: distribution expansion recovered only "
                    f"{expanded_bytes}/{artifact_bytes} bytes from {artifact}",
                    file=sys.stderr,
                )
                return 2

            # The privacy scanner deliberately expands a Debian control archive
            # into __control__ so maintainer fields are inspected. dpkg never
            # installs those files, so distribution size/accounting must census
            # only the fsys payload. The archive-member read below likewise uses
            # dpkg-deb --fsys-tarfile, keeping both measures on the installed set.
            payload_root = _distribution_payload_root(expanded, artifact_format)
            census_excludes = {"__control__"} if artifact_format == "deb" else set()
            tree = _tree_census(payload_root, census_excludes)
            try:
                members = _artifact_member_census(artifact, expanded)
            except Exception as exc:
                print(f"AUDIT ERROR: cannot census archive members in {artifact}: {exc}", file=sys.stderr)
                return 2

            resource_root = os.path.join(
                payload_root, *identity[resource_key].lstrip("/\\").replace("\\", "/").split("/")
            )
            violations = []
            if not os.path.isdir(resource_root):
                violations.append(f"installed resource root is absent: {identity[resource_key]}")
                resource_files, resource_dirs = set(), set()
            else:
                resource_files, resource_dirs = _relative_inventory(resource_root)

            if role == "gui":
                allowed = []
                for entry in role_contract["resourceAllowlist"]:
                    if platform not in entry.get("platforms", []):
                        continue
                    prefix = entry["glob"].split("/**", 1)[0].rstrip("/")
                    allowed.append((prefix, entry.get("optional", False)))
                for prefix, optional in allowed:
                    if optional:
                        continue
                    if not any(path == prefix or path.startswith(prefix + "/") for path in resource_files):
                        violations.append(f"required GUI allowlist root is empty/absent: {prefix}")
                for path in sorted(resource_files):
                    if not any(path == prefix or path.startswith(prefix + "/") for prefix, _ in allowed):
                        violations.append(f"GUI resource escaped the allowlist: {path}")
                for raw_prefix in role_contract["forbiddenResourcePrefixes"]:
                    prefix = raw_prefix.rstrip("/")
                    if any(
                        path == prefix or path.startswith(prefix + "/")
                        for path in resource_files | resource_dirs
                    ):
                        violations.append(f"GUI contains forbidden Server resource: {raw_prefix}")

                budgets = role_contract["budgets"]
                platform_budget = budgets["platforms"].get(platform, {})
                format_budgets = platform_budget.get("formats")
                if isinstance(format_budgets, dict):
                    format_budget = format_budgets.get(artifact_format)
                    if not isinstance(format_budget, dict):
                        format_budget = {}
                        violations.append(
                            f"{platform}/{artifact_format} has no explicit measured budget"
                        )
                else:
                    # Backward compatibility for pending platforms and older
                    # single-format contracts. Linux now declares formats.
                    format_budget = platform_budget
                download_ceiling = format_budget.get(
                    "downloadCeilingBytes", budgets.get("initialDownloadCeiling")
                )
                unpacked_ceiling = format_budget.get("unpackedCeilingBytes")
                if download_ceiling is None or unpacked_ceiling is None:
                    violations.append(
                        f"{platform} has no explicit compressed+unpacked ceilings; "
                        "fresh measurement is still pending"
                    )
                else:
                    if artifact_bytes > download_ceiling:
                        violations.append(
                            f"compressed artifact {artifact_bytes} exceeds ceiling {download_ceiling}"
                        )
                    if tree["uniqueInodeBytes"] > unpacked_ceiling:
                        violations.append(
                            f"unique-inode unpacked bytes {tree['uniqueInodeBytes']} "
                            f"exceed ceiling {unpacked_ceiling}"
                        )
                artifact_sha = _sha256_file(artifact)
                if artifact_sha == format_budget.get("sourceArtifactSha256"):
                    if artifact_bytes != format_budget.get("downloadBytes"):
                        violations.append("baseline artifact downloadBytes no longer matches its own sha")
                    if tree["uniqueInodeBytes"] != format_budget.get("unpackedBytes"):
                        violations.append("baseline artifact unpackedBytes no longer matches its own sha")
            else:
                artifact_sha = _sha256_file(artifact)
                for required in role_contract["requiredResources"]:
                    required_path = required.rstrip("/")
                    if required.endswith("/"):
                        if required_path not in resource_dirs:
                            violations.append(f"Server required directory is absent: {required}")
                    elif required_path not in resource_files:
                        violations.append(f"Server required file is absent: {required}")
                fragment_patterns = {
                    pattern
                    for pack in role_contract.get("optionalPacks", [])
                    for pattern in pack.get("forbidden", [])
                }
                for path in sorted(resource_files):
                    name = os.path.basename(path)
                    if any(fnmatch.fnmatch(name, pattern) for pattern in fragment_patterns):
                        violations.append(f"Server model download fragment survived: {path}")

            report = {
                "ok": not violations,
                "role": role,
                "platform": platform,
                "artifactFormat": artifact_format,
                "artifact": os.path.abspath(artifact),
                "artifactSha256": artifact_sha,
                "compressedArtifactBytes": artifact_bytes,
                "unpackedLogicalBytes": tree["logicalBytes"],
                "unpackedUniqueInodeBytes": tree["uniqueInodeBytes"],
                "expandedFiles": tree["files"],
                "expandedSymlinks": tree["symlinks"],
                **members,
                "expansionMethod": method,
                "violations": violations,
            }
            reports.append(report)
            any_violations = any_violations or bool(violations)

    result = {"ok": not any_violations, "contract": contract_path, "reports": reports}
    print(json.dumps(result, sort_keys=True))
    if any_violations:
        for report in reports:
            for violation in report["violations"]:
                print(
                    f"DISTRIBUTION VIOLATION [{role}/{platform}] {violation}",
                    file=sys.stderr,
                )
        return 1
    return 0


def print_identity_literals():
    """Emit `value<TAB>redaction<TAB>wordboundary(0/1)<TAB>sed_ere` for every identity
    literal the gate hunts — build-box identity + the known cross-box sensitive set — so
    bin/stage-source-tree.sh scrubs EXACTLY what this gate would later fail on, from
    the one source of truth (no second list to drift). LONGEST value first so an
    overlapping pair is applied safely (/home/<user> before the bare <user> inside
    it). A value with no explicit REDACTION_BY_KEY token falls back to 'redacted'.

    COLUMN 4 (sed_ere) is the ready-to-use `sed -E` pattern — lit_ere() with the
    delimiter escaped — and it exists so the scrub inherits this gate's CASE rule
    instead of re-deriving it. The stager used to rebuild the pattern itself from
    column 1, which is how the scrub stayed case-SENSITIVE after the gate stopped
    being (EI-20589264759185712): two hand-kept derivations of "the same" rule, and
    the quiet one wins. Columns 1-3 stay for compatibility; a stager that reads only
    them still works, it is just the older, case-sensitive behaviour.
    """
    lits = identity_literals()
    lits.update(KNOWN_SENSITIVE_IDENTITIES)
    seen = set()
    for key, val in sorted(lits.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        if val in seen:
            continue
        seen.add(val)
        red = REDACTION_BY_KEY.get(redaction_key(key), "redacted")
        wb = "1" if needs_word_boundary(val) else "0"
        # `/` is the stager's s/// delimiter; escape it so a home path cannot end
        # the substitution early. Every other metacharacter is already re.escape()d.
        sed_ere = lit_ere(val).replace("/", r"\/")
        print(f"{val}\t{red}\t{wb}\t{sed_ere}")
    return 0


def source_leakers(argv):
    """Print the must-ship SOURCE files (relative to MONO) that carry a build-box /
    known-sensitive identity literal, for the stager to redact-overlay at tar time.

    Same scoping the gate convicts with, so the stager scrubs exactly the set that
    would otherwise red the cut: low-entropy literals (a bare first name) are hunted
    in OUR source only; high-entropy literals everywhere EXCEPT node_modules — a
    vendored high-entropy hit is a delete-exclude class (build caches, handled by
    --tar-excludes), never something we rewrite inside a third-party package. Paths
    matching a FORBIDDEN_PATH rule are skipped: they do not ship, so scrubbing +
    re-adding one would smuggle a non-shipper into the bundle."""
    if not argv:
        print("AUDIT ERROR: --source-leakers needs <MONO> <dir...>", file=sys.stderr)
        return 2
    mono, roots = argv[0], argv[1:]
    lits = identity_literals()
    lits.update(KNOWN_SENSITIVE_IDENTITIES)
    high = sorted({v for v in lits.values() if not is_low_entropy(v)})
    low = sorted({v for v in lits.values() if is_low_entropy(v)})
    forbidden = [rx for _r, rx, _g in FORBIDDEN_PATH]
    # FORBIDDEN_PATH is the gate's PRIVACY exclude set (== --tar-excludes), so a
    # candidate under one of those never ships and is already skipped above. The
    # stager ALSO drops a SIZE/heavy class (bin/stage-source-tree.sh) that is not
    # in FORBIDDEN_PATH — build logs, tsbuildinfo, editor/turbo dirs, the docs-site
    # dist, cargo-target twins, the papercusp-desktop self-reference. A candidate in
    # one of THOSE is a build artifact that will not ship either, so scrubbing +
    # re-adding it would smuggle a non-shipper into the bundle. Mirror that heavy
    # class here (target/.next/.cache/.astro/pagefind are already FORBIDDEN_PATH).
    size_skip = [
        "*.log", "*.tsbuildinfo", "*.DS_Store",
        "*/.turbo/*", "*/.idea/*", "*/.vscode/*",
        "*/operator-docs/dist/*", "operator-docs/dist/*",
        "*cargo-target*", "papercusp-desktop/*", "*/papercusp-desktop/*",
    ]
    leakers = set()

    def hunt(pats, low_entropy=False):
        if not pats:
            return
        for root in roots:
            if os.path.basename(root.rstrip("/")) == "node_modules":
                continue  # never scrub vendored code
            aroot = os.path.join(mono, root)
            if not os.path.exists(aroot):
                continue
            # `-I` (skip binaries) is DELIBERATE here, unlike in scan_dir: this hunts
            # SOURCE files to hand to the scrubber, and you do not text-scrub a binary.
            # scan_dir audits the bytes that SHIP and must use `-a` (P-012).
            cmd = ["grep", "-rIlE", "--exclude-dir=node_modules"]
            for p in pats:
                cmd += ["-e", lit_ere(p)]
            cmd.append(aroot)
            r = subprocess.run(cmd, capture_output=True, text=True)
            for line in r.stdout.splitlines():
                line = line.strip()
                if not line:
                    continue
                rel = os.path.relpath(line, mono).replace(os.sep, "/")
                if any(rx.search(rel) or rx.search("/" + rel) for rx in forbidden):
                    continue
                if any(fnmatch.fnmatch(rel, g) for g in size_skip):
                    continue
                if low_entropy and not file_has_unexplained_low_entropy(
                        line, rel, pats):
                    continue
                leakers.add(rel)

    hunt(high)
    hunt(low, low_entropy=True)
    for rel in sorted(leakers):
        print(rel)
    return 0


def main():
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    if sys.argv[1] == "--tar-excludes":
        return print_tar_excludes()
    if sys.argv[1] == "--owner-preflight":
        return owner_preflight()
    if sys.argv[1] == "--identity-literals":
        return print_identity_literals()
    if sys.argv[1] == "--source-leakers":
        return source_leakers(sys.argv[2:])
    if sys.argv[1] == "--prune-docs":
        return prune_docs(sys.argv[2:])
    if sys.argv[1] == "--prune-vm-release":
        return prune_vm_release(sys.argv[2:])
    if sys.argv[1] == "--audit-vm-release":
        return audit_vm_release(sys.argv[2:])
    if sys.argv[1] == "--audit-vulnerabilities":
        return audit_vulnerabilities(sys.argv[2:])
    if sys.argv[1] == "--scrub-binaries":
        return scrub_binaries(sys.argv[2:])
    if sys.argv[1] == "--scrub-text":
        return scrub_text(sys.argv[2:])
    if sys.argv[1] == "--scrub-app-binary":
        return scrub_app_binary(sys.argv[2:])
    if sys.argv[1] == "--scan-dir":
        return scan_dir(sys.argv[2:])
    if sys.argv[1] == "--scan-artifact":
        return scan_artifact(sys.argv[2:])
    if sys.argv[1] == "--distribution-census":
        return distribution_census(sys.argv[2:])
    bundle = sys.argv[1]
    if not os.path.isfile(bundle):
        print(f"AUDIT ERROR: no such bundle: {bundle}", file=sys.stderr)
        return 2
    for tool in ("zstd", "tar", "grep"):
        if not shutil.which(tool):
            print(f"AUDIT ERROR: {tool} not on PATH — cannot scan", file=sys.stderr)
            return 2

    lits = identity_literals()
    print(f"==> auditing {os.path.basename(bundle)}")
    print(f"    identity of this build box: {', '.join(sorted(lits)) or '(none resolved)'}")

    # FAIL CLOSED when the owner's NAME cannot be resolved (EI-20583328178472869).
    #
    # This audit's whole value is that a CLEAN verdict is EVIDENCE. Without a name
    # literal it cannot hunt the one identity class with no shape to fall back on, so
    # "✓ CLEAN" degrades to "I looked for nothing" while still reading as proof to the
    # human and to the publish script's `|| exit`. That is strictly worse than no gate:
    # it turns an unverified bundle into an apparently-verified one.
    #
    # The KNOWN_SENSITIVE_IDENTITIES denylist below does NOT cover this: it carries the
    # owner's github handle and some VM logins, but no name entry — so with git blind,
    # nothing whatsoever hunts the bare first name that `needs_word_boundary` exists for.
    #
    # Exit 2 (cannot check), never 1 (found leaks): a caller must be able to tell a blind
    # gate from a clean one.
    if not has_owner_name_literal(lits):
        print(
            "    ✗ REFUSING TO CERTIFY — no owner-name literal resolved, so this scan\n"
            "      cannot detect the owner's name in the bundle and a CLEAN verdict would\n"
            "      be meaningless.\n"
            f"      Cause: `git config user.name` is unset or belongs to an automation.\n"
            f"      Fix:   export {OWNER_NAME_ENV}='<the owner's name>' for this build.",
            file=sys.stderr,
        )
        return 2
    # Cross-box blind-spot backstop (WI-4419): hunt the KNOWN leaked identities on
    # EVERY build, not just the ones belonging to the box running this scan.
    lits.update(KNOWN_SENSITIVE_IDENTITIES)
    print(f"    + {len(KNOWN_SENSITIVE_IDENTITIES)} known cross-box sensitive identities "
          f"(hunted on every build regardless of build host)")

    members, path_hits = phase_a_paths(bundle, lits)
    print(f"    [A] paths    — {members:,} members, {len(path_hits):,} finding(s)")

    content_hits = phase_b_content(bundle, lits)
    print(f"    [B] content  — {len(content_hits):,} distinct value(s) matched")

    if not path_hits and not content_hits:
        print("    ✓ CLEAN — no forbidden paths, no build-box identity, no credentials")
        print_coverage_gaps(identity_coverage_gaps(lits))
        return 0

    print(f"\n    ✗ THIS BUNDLE MUST NOT SHIP\n")

    if path_hits:
        grouped = {}
        for rule, name in path_hits:
            top = "/".join(name.split("/")[:3])
            g = grouped.setdefault((rule, top), {"n": 0, "eg": name})
            g["n"] += 1
        print("  FORBIDDEN PATHS")
        for (rule, top), g in sorted(grouped.items(), key=lambda kv: -kv[1]["n"]):
            print(f"    [{rule}]  {g['n']:,}×  under {top}")
            print(f"        e.g. {g['eg']}")

    if content_hits:
        print("\n  IN FILE CONTENT")
        for rule, n, val in content_hits[:20]:
            shown = val if rule.startswith("build-") else redact(val)
            print(f"    [{rule}]  {n:,}×  {shown}")
        print("\n  attributing to files (slow pass — only runs on a failing build)…")
        attributed = phase_c_attribute(bundle, lits, content_hits)
        for rule, n, _val in content_hits[:20]:
            g = attributed.get(rule)
            if not g:
                # Convicted in phase B but attributable to no file: the value lives in
                # a member over MAX_ATTRIBUTE_BYTES, or in one phase C reads as binary.
                print(f"    [{rule}]  {n:,}× — NOT attributable to a file "
                      f"(member >{MAX_ATTRIBUTE_BYTES // 1024 // 1024}MB, or binary)")
                continue
            print(f"    [{rule}]  {g['n']:,} file(s)")
            for name in g["files"]:
                print(f"        {name}")
            if g["n"] > len(g["files"]):
                print(f"        … and {g['n'] - len(g['files']):,} more")

    # Header ownership findings have a different producer and therefore a different
    # repair than path/content findings. Pointing them at the staging allowlist is
    # actionable-looking but cannot change tar's uname/gname fields (EI-21823231988075351).
    header_metadata_hits = [
        (rule, name) for rule, name in path_hits
        if rule.endswith(" (in uid name)") or rule.endswith(" (in gid name)")
    ]
    source_or_content_hits = [
        (rule, name) for rule, name in path_hits
        if (rule, name) not in header_metadata_hits
    ]
    if source_or_content_hits or content_hits:
        print("\n  Fix the SOURCE — the allowlist in bin/stage-source-tree.sh. Do NOT add an")
        print("  exception here to make the build pass: that is the bug this gate exists to catch.")
    if header_metadata_hits:
        print("\n  Fix the ARCHIVE PRODUCER — the finding is tar header ownership metadata,")
        print("  not a staged path or file-content leak. Recreate the affected archive with:")
        print("    tar --owner=0 --group=0 --numeric-owner ...")
        print(f"  Affected archive: {os.path.basename(bundle)}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
