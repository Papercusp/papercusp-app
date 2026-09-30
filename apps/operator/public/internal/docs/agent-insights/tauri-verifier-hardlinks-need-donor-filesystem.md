# Tauri verifier hardlink snapshots need the donor filesystem
URL: /internal/docs/agent-insights/tauri-verifier-hardlinks-need-donor-filesystem

Keep dependency hardlinks on their donor filesystem and bulk verifier state on TMPDIR.

## Failure and cause

The headless verifier copied its operator source under TMPDIR and invoked the existing pinned-deps hardlink snapshot. On this host the repository and /tmp are different filesystems. The dependency helper correctly refused before desktop startup. A first same-device workaround moved every verifier artifact to the donor device; this unnecessarily moved the frozen SPA and temporary database onto the constrained root filesystem too.

## Current behavior

scripts/verify-tauri-headless.sh selects OPERATOR\_SNAPSHOT\_PARENT with select\_verifier\_snapshot\_root. It preserves a compatible TMPDIR; otherwise it uses the repository's ignored .papercusp/tmp and verifies its device. Only the operator source/dependency snapshot uses that parent. WORK stays on TMPDIR, so the SPA, WebView profile and optional isolated database retain the larger temp volume.

Both scratch roots receive the same live-owner marker, including boot-only handoff. Normal teardown, generated stop.sh and snapshot-allocation failure clean the operator snapshot container. Existing .papercusp snapshot exclusions prevent recursive copies. No new invocation flag is needed.

## Verification and limits

EI-22588292228855829 records the original cross-device refusal and a real boot that subsequently snapshotted dependencies successfully. The current focused source-snapshot/SPA-isolation/boot-only-ownership suite passes17tests, including executable chooser cases for same-device preference, cross-device fallback and an incompatible fallback.

Filesystem compatibility does not prove capacity. The first all-bulk fallback hit ENOSPC during npm startup. The separate aggregate estimate/reservation preflight remains tracked as EI-22589054433344154; EI-22588975697224744 records the actual startup incident. A third real boot is verifying the split-root layout; do not infer GUI success from a successful copy or these unit tests.

Re-run node scripts/test-files.mjs apps/operator/lib/verify-tauri-headless-source-snapshot.test.ts apps/operator/lib/verify-tauri-headless-spa-isolation.test.ts apps/operator/lib/verify-tauri-headless-boot-only-ownership.test.ts, then use the normal verifier entrypoint. Preserve its per-run ownership and teardown.
