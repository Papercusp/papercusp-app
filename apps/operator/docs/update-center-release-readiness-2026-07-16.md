# Update Center — Release-Readiness Report v2 (per-platform go/no-go)

**Plan:** `update-center-3-platform-test-suite-2026-07-15` · **Candidate:** desktop `0.0.11-alpha` (carries the WI-5004/5007/5008/5010 resolution-layer fixes) · **As of:** 2026-07-16

> Test method (all platforms): a disposable, **isolated** prior-version install
> (fresh `$HOME`, its own embedded Postgres) driven headlessly, pointed at a
> **local update rail** (`http://127.0.0.1:8044`) via the runtime
> `PAPERCUSP_RELEASE_HOST` override — **zero outward writes**, no dependency on
> the real R2 host or a public publish. Both update artifacts are
> cryptographically pre-verified (tauri prehashed-minisign: BLAKE2b-512 + ed25519
> against the baked updater pubkey) before every drive.

## Verdict summary

| Platform | Forward update | Revert (rollback) | DB grace (fwd + down) | Channel/degradation | **Go/No-Go** |
|---|---|---|---|---|---|
| **Linux (x86_64)** | ✅ PASS | ✅ PASS | ✅ PASS | ✅ PASS | **GO** |
| **macOS** | artifact+manifest ✅ verified | — | — | protocol-sim ✅ | **SCOPED GO** (see below) |
| **Windows** | artifact ✅ signed | — | — | (server-side ✅) | **PENDING VM E2E** |

## Linux — GO (fully exercised end-to-end)

Driven on an isolated `0.0.10` AppImage → local rail serving the real `0.0.11`
artifact + a sha-verified genuine `0.0.10` for rollback.

- **P-001 forward update** ✅ — chip detects `0.0.11` → confirm → 4.2 GB download →
  tauri-plugin-updater in-place `$APPIMAGE` rewrite → self-relaunch as `0.0.11`
  (operator sha `9f4917b9`). Binary physically swapped, app came back on the new version.
- **P-002 revert / rollback** ✅ — popover **Revert** on the `0.0.10` row → download →
  backup + downgrade-swap → relaunch as `v0.0.10` (sha `6f48aa0d`). The exact
  owner-flagged path ("we implemented a rollback feature… test that thoroughly") —
  swap works in both directions.
- **P-003 .deb fallback UX** ✅ (code-verified) — `install_update` **and** `revert_to`
  early-fail `no_compatible_assets` on a non-AppImage install; `UpdateChip` catches
  both (install → opens releases page, revert → "reinstall manually" toast). No silent
  hang on a `.deb`/`.rpm` install.
- **P-010 forward-migrate DB grace** ✅ — the `0.0.11` binary migrated the
  `0.0.10`-created data dir cleanly: ledger **477 → 488** (migrations 604–614), zero errors.
- **P-011 downgrade DB grace** ✅ — after revert, the `0.0.10` binary booted **clean on
  the newer 488-row ledger it never created** — the filename-keyed runner ignores
  unknown-future rows (604–614). No down-migrations needed, no crash.
- **P-012 additive-only audit** ✅ — the 11-migration delta (604–614) is 100%
  additive; exact file↔ledger match (no dup/skip). Because P-011 showed no breakage,
  the conditional "schema-newer-than-binary guard" is **not required**.
- **P-013 state survival** ✅ — the planted marker row survived **both** swaps
  (workspace/registry/credentials persistence proven across the full cycle).
- **P-040 channel matrix** ✅ — `alpha` → offers `0.0.11`; `beta`/`stable`/`aarch64`
  → `204 no_candidate` (graceful, no false "unreachable"); already-current → `204 up_to_date`.
- **P-041 server poller** ⚠️ GUI path (`latest.json`) proven E2E; the Server path
  (`latest-server.json`) is inert until Server-role artifacts are cut — see Gaps.
- **P-042 degradation matrix** ✅ — every failure mode degrades to a safe `204` (never a
  crash or a false update offer) with a **distinct diagnostic** `X-Update-Reason`:
  malformed manifest → `fetch_failed`; unset base URL → `manifest_unconfigured` (WI-4364);
  missing signature / empty platforms → `no_candidate`. The WI-5010 fix (unreachable
  ≠ "no releases yet") is confirmed live — `fetch_failed` and `no_candidate` are cleanly separated.

**Resolution-layer fixes confirmed live in the candidate:** WI-5007 (`is_current`
now marks `0.0.11` ● Current in the popover), WI-5008 (Revert resolves off the
release host, not dead GitHub), WI-5010 (unreachable-vs-no-releases messaging).

## macOS — SCOPED verification done; literal GUI click-through deferred (owner-review item)

**P-020 (artifact, DONE):** the `0.0.11` `.app.tar.gz` + `.sig` landed (2026-07-17 17:08Z)
and is fully verified — `gitDirty:false`, sha256 + minisign signature PASS
(`bin/verify-provenance.sh`), host string + buildSha (`c5d1caf3`) + version independently
re-confirmed with `LC_ALL=C grep` directly on the extracted binary (belt-and-suspenders,
not just the automated gate). Staged to a local test rail (`http://127.0.0.1:8044` on the
mac VM) serving a hand-written `latest.json`.

**P-021 (in-app update E2E) — SCOPED, not the literal click-through.** Mid-drive, the
isolated-`$HOME` E2E rig collided with another agent's live rig sharing the same mac VM
(the app's `shared_sidecar_home()==real_home()` design silently takes over the shared
sidecar/Postgres when an isolation attempt doesn't fully take — filed as **EI-14941**).
The incident was resolved cleanly with no data loss (root cause: `open` doesn't propagate
an env override across this VM's unusually slow — GPU-less-WKWebView — boot sequence,
so a short `launchctl setenv` window reverts before the child process forks). Repeating
the live-rig attempt risked colliding a second time with another agent's active
~20:30Z-critical-path work, so — per fleet-lead ruling — the literal "install → click
update → relaunch → revert" pass is **deferred to a coordinated clean window** on that VM,
and a narrower, still-real verification was substituted for this report:

- The rail's `latest.json` **signature field is byte-identical** to the actual `.sig` file
  shipped with the verified `0.0.11` artifact (not hand-typed/approximated).
- The rail's `latest.json` is **byte-identical** to what the production
  `buildLatestManifest()` function (`libs/generic/tauri-release-kit`) generates from the
  same inputs — confirmed by importing and running the real function, not reimplementing it.
- The real, exported update-check decision functions (`visibleChannels`, `platformKeyFor`,
  `resolveChannel` from `updates-manifest.ts`) were imported live and run against the
  staged manifest: a `0.0.8` client on `darwin-x86_64`/`darwin-aarch64` with no channel
  param resolves to **200 OFFER → 0.0.11** with the correct signature + URL; a `0.0.11`
  client resolves to **204 up_to_date**; an unsupported platform resolves to **404**.

This confirms the manifest/signature/update-check *mechanism* is correct end-to-end for
macOS, but does **not** substitute for actually clicking through the update in a running
GUI and watching it relaunch — that remains open pending a safe VM window.

**P-022 (DB spot-checks) — BLOCKED**, same reason: this needs a real running app driving
an actual migration/rollback, which the protocol-level verification above cannot stand in
for. Flagged for the same clean-window pass as the literal P-021 GUI leg.

**Owner-relevant ask:** is the scoped mechanism-level verification above sufficient to
call macOS GO for this release, with the literal click-through + DB spot-check following
in a scheduled window — or should macOS wait for the full pass before shipping? (Raised by
fleet lead su-19c9c729 per their ruling on this incident.)

## Windows — artifact validated; VM E2E pending

- **P-030 (artifact)** — the Windows GUI `-setup.exe` **exists and is validly signed**:
  `Papercusp GUI_0.0.11_x64-setup.exe` (1.9 GB) + `.sig` cryptographically **VERIFY=PASS**
  against the baked updater pubkey (keyid `449908a7d47d3a5d`, the same key that signed
  the passing Linux artifact). Build provenance is clean: `gitDirty:false`, gitHead
  `8e5411de`, buildSha `da9e455e-9f4917b9` (matches the Linux 0.0.11 operator sha). The
  Server `-setup.exe` also verifies. So the Windows auto-update artifact will pass the
  updater's signature check.
- **Server-side manifest resolution** for a Windows client is covered by the same
  platform-agnostic manifest path proven on Linux (`platformKeyFor` accepts `windows`;
  the channel/degradation matrix is platform-independent).
- **P-031/P-032 (Windows-native in-app update + revert + DB spot-checks)** — the only
  remaining Windows gap; these require driving the actual swap on the **Windows VM**
  (`ssh :2223`), which additionally has a low-disk escalation open in the cut lane.
  Not doable from Linux; owned by the cut lane (su-b0fbf).

## Gaps / recommendations

1. **Server-product auto-update** (`latest-server.json`) is untested — this GUI cut
   produces no Server-role artifacts, so the Server tray poller has nothing to poll.
   Not a blocker for the **GUI** release; flag it if the Server product ships on the
   same cadence.
2. **macOS** — the artifact + manifest/update-check mechanism is verified (see above), but
   the literal GUI click-through + DB spot-checks (P-021 full pass / P-022) are deferred to
   a coordinated clean window on the shared mac VM (avoiding a repeat of the EI-14941
   collision with another agent's live rig). Needs an explicit owner call on whether the
   scoped verification is sufficient to ship on, per the ask above.
3. **Windows** is the only remaining go/no-go input needing VM E2E, pending WSL
   co-tenancy sequencing on that VM (tracked separately).

## Bottom line

**Linux desktop Update Center is GO for public release** — forward update, rollback,
DB migration grace in both directions, and the full channel/degradation matrix are all
exercised and passing on the `0.0.11` candidate. **macOS** artifact + manifest/update-check
mechanism is verified; the literal in-app click-through and DB spot-checks await a
coordinated window on the shared test VM (owner input requested on whether to ship on the
scoped verification meanwhile). **Windows** is GO-pending purely on VM E2E scheduling, with
the test harness staged and waiting.
