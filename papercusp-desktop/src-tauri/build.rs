use std::collections::HashSet;
use std::path::Path;

/// EI-21234338815162020: the operator Vite dist contains a wholesale public/
/// copy, including `internal/docs`. The canonical sidecar builder removes that
/// duplicate because `/internal/docs/*` is served from `sidecar/internal-docs`;
/// packaging it under `sidecar/spa` is dead weight and can reintroduce private
/// build/agent documentation after the sidecar's privacy audit has already run.
///
/// A direct `tauri build` used to accept a manually refreshed raw SPA and emit a
/// correctly signed installer carrying those never-ship bytes. Fail at compile
/// time as well as at the finished-artifact audit, so bypassing the release
/// wrapper cannot silently recreate the class.
fn reject_unpruned_spa_docs(manifest_dir: &Path) {
    let duplicate_docs = manifest_dir.join("sidecar/spa/internal/docs");
    if duplicate_docs.exists() {
        panic!(
            "refusing to bundle {}: sidecar/spa/internal/docs is the raw Vite duplicate of \
             the dedicated sidecar/internal-docs tree and may carry private build docs. \
             Rebuild the sidecar with bin/build-desktop-sidecar.sh (which prunes and audits \
             the SPA) before running tauri build.",
            duplicate_docs.display(),
        );
    }
}

/// EI-160 (point 2): `src-tauri/sidecar/` is a gitignored ~2.2GB artifact
/// (bin/build-desktop-sidecar.sh). On a fresh or cleaned checkout it is
/// absent, and `generate_context!`'s `bundle.resources` globs
/// (`sidecar/spa/**/*` in the base GUI config plus the broader server
/// resources) then fail the WHOLE build —
/// cargo build / tauri dev / tauri build alike — with a cryptic
/// "path not found or didn't match any files", nothing pointing at the
/// sidecar build script.
///
/// Dev builds never spawn the sidecar (main.rs skips it under
/// debug_assertions), so a placeholder file per glob is enough to compile.
/// A REAL bundle must still run bin/build-desktop-sidecar.sh first — the
/// packaging path (bin/release-local.sh) already does, and its atomic
/// `mv -T` publish replaces this placeholder tree wholesale (P-056).
fn ensure_sidecar_placeholder(manifest_dir: &Path) {
    let sidecar = manifest_dir.join("sidecar");
    let db_sql = sidecar.join("db-sql");
    let spa = sidecar.join("spa");
    let has_serve = sidecar.join("serve.mjs").exists();
    let has_db_sql_entry = std::fs::read_dir(&db_sql)
        .ok()
        .and_then(|mut entries| entries.next())
        .is_some();
    let has_spa_entry = std::fs::read_dir(&spa)
        .ok()
        .and_then(|mut entries| entries.next())
        .is_some();
    // Validate every resource glob independently. A partially materialized
    // sidecar can contain serve.mjs while db-sql is absent (the green
    // checkpoint clean-copy shape); the old early return then let
    // tauri_build panic on sidecar/db-sql/*.
    if has_serve && has_db_sql_entry && has_spa_entry {
        return;
    }
    std::fs::create_dir_all(&db_sql).expect("create sidecar placeholder dirs");
    std::fs::create_dir_all(&spa).expect("create SPA placeholder dir");
    let note = "Placeholder created by build.rs so the bundle.resources globs match on a\n\
                fresh checkout (EI-160). Dev builds never spawn the sidecar; for a real\n\
                bundle run bin/build-desktop-sidecar.sh, which replaces this directory\n\
                atomically.\n";
    if !has_serve {
        std::fs::write(sidecar.join("PLACEHOLDER-README.txt"), note)
            .expect("write sidecar placeholder");
    }
    if !has_db_sql_entry {
        std::fs::write(db_sql.join("PLACEHOLDER-README.txt"), note)
            .expect("write db-sql placeholder");
    }
    if !has_spa_entry {
        std::fs::write(spa.join("PLACEHOLDER-README.txt"), note).expect("write SPA placeholder");
    }
    println!(
        "cargo:warning=src-tauri/sidecar/ is incomplete — placeholder resources created so \
         the build can proceed. Dev is fine (the sidecar is never spawned); DO NOT package \
         this tree without running bin/build-desktop-sidecar.sh first."
    );
}

/// EI-9412: `src-tauri/seed/` is a gitignored, out-of-band-provisioned directory
/// (papercusp-desktop/.gitignore: "Provision the seed out-of-band; git must not
/// carry it.", plan hive-seed-bundle-2026-07-04 / WI-3346). On a fresh or
/// cleaned checkout (e.g. the green-checkpoint test tree, which is reset+cleaned
/// every run and never runs `bin/ensure-release-seed.sh`) it is absent, and
/// `generate_context!`'s `bundle.resources` glob (`seed/**/*`) then panics the
/// WHOLE build — including a plain `cargo test`/`cargo build`, which never goes
/// through the Tauri CLI lifecycle (`beforeBuildCommand`) at all — with "glob
/// pattern seed/**/* path not found or didn't match any files", nothing
/// pointing at the seed-cut script. This is the exact EI-160 failure shape
/// (see `ensure_sidecar_placeholder` above) recurring for a second gitignored
/// resource glob added later without the same guard.
///
/// STILL REQUIRED after WI-6075, but for a narrower set of builds: `seed/**/*`
/// now lives only in the overlays (tauri.server.conf.json / tauri.gate.conf
/// .json), never in the base tauri.conf.json, so a plain `cargo build`/`cargo
/// test` no longer globs the seed at all. An OVERLAY build still does — and
/// `--config` is applied at compile time too (the CLI exports the merged
/// TAURI_CONFIG that `generate_context!` reads) — so the placeholder is what
/// keeps a server/gate build off a cleaned tree from panicking.
///
/// Dev/test builds never read the seed at runtime unless the offline-restore
/// path is actually exercised, so a placeholder file is enough to compile. A
/// REAL bundle must still run `bin/ensure-release-seed.sh` first — every
/// release script (release-local.sh, mac-vm-build.sh, build-windows-on-vm.sh)
/// already does, and a fresh cut replaces this placeholder tree wholesale.
fn ensure_seed_placeholder(manifest_dir: &Path) {
    let seed = manifest_dir.join("seed");
    if seed.join("manifest.json").exists() {
        return;
    }
    std::fs::create_dir_all(&seed).expect("create seed placeholder dir");
    let note = "Placeholder created by build.rs so the bundle.resources glob matches on a\n\
                fresh/cleaned checkout (EI-9412, mirrors EI-160's sidecar placeholder). Dev\n\
                and test builds never read the seed unless the offline-restore path is\n\
                exercised; for a real bundle run bin/ensure-release-seed.sh (every release\n\
                script already does), which replaces this directory wholesale.\n";
    std::fs::write(seed.join("PLACEHOLDER-README.txt"), note).expect("write seed placeholder");
    println!(
        "cargo:warning=src-tauri/seed/ has no manifest.json — placeholder created so the \
         build can proceed. Dev/test is fine; DO NOT package this tree without running \
         bin/ensure-release-seed.sh first."
    );
}

/// ship-precomputed-doc-vectors-2026-10-01 P-003: same reason as the hive seed —
/// `tauri.server.conf.json` bundles `doc-vector-seed/**/*`, and an unmatched
/// resource glob fails the build. The release cut replaces this dir with the
/// real seed (scripts/export-doc-vector-seed.mts). The runtime only loads a dir
/// holding manifest.json (doc-vector-seed-dir.ts), so this placeholder reads as
/// "no seed" and the backfill sweep embeds the docs as before.
fn ensure_doc_vector_seed_placeholder(manifest_dir: &Path) {
    let dir = manifest_dir.join("doc-vector-seed");
    if dir.join("manifest.json").exists() {
        return;
    }
    std::fs::create_dir_all(&dir).expect("create doc-vector-seed placeholder dir");
    let note = "Placeholder created by build.rs so the bundle.resources glob matches on a\n\
                fresh/cleaned checkout. The release cut writes the real precomputed doc\n\
                vectors here (scripts/export-doc-vector-seed.mts); without them a fresh\n\
                install embeds every doc section itself on first boot.\n";
    std::fs::write(dir.join("PLACEHOLDER-README.txt"), note)
        .expect("write doc-vector-seed placeholder");
}

/// EI-12083: cross-check the `AppManifest::commands(&[...])` list below against
/// the app-command permission GRANTS in `capabilities/default.json`, before
/// handing off to `tauri_build::try_build`. When a grant references a command
/// with no backing entry in `commands`, `tauri_build` panics with a ~500-line
/// wall listing every valid permission — technically correct, zero signal.
///
/// Root cause of the real 2026-07-14 incident this guards: WI-4827 landed the
/// capability grant (`allow-open-route-in-app`) and its backing command
/// (`open_route_in_app`) as TWO separate git-sync auto-commits ~6 minutes
/// apart on the shared tree. Any build that reads the tree in that window
/// (not a source bug — a transient split-commit race) hit the cryptic panic.
/// `packages/operator-core/lib/desktop-acl-command-sync.test.ts` already
/// guards the settled tree in CI; this guards the LOCAL build-time read of
/// whatever state the tree happens to be in right now.
///
/// Deliberately dependency-free (no `serde_json` in `[build-dependencies]`,
/// matching the WI's "keep it panic-only, no new deps"): a plain quoted-string
/// scan, the same technique the TS regression test already uses
/// (`/"([^"]+)"/g`) rather than a full JSON parse. `capabilities/default.json`
/// has no other field whose value happens to start with `allow-`, so scanning
/// every quoted string in the file (not just inside `"permissions"`) is safe
/// here — see the sibling TS test for the authoritative structural check.
fn check_capability_commands_are_registered(manifest_dir: &Path, commands: &[&str]) {
    let cap_path = manifest_dir.join("capabilities/default.json");
    let raw = match std::fs::read_to_string(&cap_path) {
        // An absent/unreadable capabilities file is tauri_build's own error to
        // raise (with its own accurate message) — nothing for this guard to add.
        Err(_) => return,
        Ok(s) => s,
    };
    let known: HashSet<&str> = commands.iter().copied().collect();

    let mut in_quotes = false;
    let mut current = String::new();
    let mut missing_grants: Vec<String> = Vec::new();
    for c in raw.chars() {
        if c == '"' {
            if in_quotes {
                if let Some(rest) = current.strip_prefix("allow-") {
                    // "allow-open-route-in-app" -> "open_route_in_app"; the
                    // dev-bridge command's "allow---dev-bridge-result" round-trips
                    // to "__dev_bridge_result" the same way (dash<->underscore is
                    // a 1:1 per-character swap, so this exactly inverts permId()
                    // in the TS test / Tauri's own dashed-permission generation).
                    let cmd = rest.replace('-', "_");
                    if !cmd.is_empty() && !known.contains(cmd.as_str()) {
                        missing_grants.push(current.clone());
                    }
                }
                current.clear();
            }
            in_quotes = !in_quotes;
        } else if in_quotes {
            current.push(c);
        }
    }

    if !missing_grants.is_empty() {
        panic!(
            "capabilities/default.json grants {grants} but build.rs's AppManifest::commands(&[...]) \
             list has no backing command for {grants}.\n\n\
             If you did NOT just edit these, you most likely caught the shared tree mid-edit: a \
             capability grant and its backing build.rs command can land as TWO separate git-sync \
             auto-commits a few minutes apart (the WI-4827 / EI-12083 incident). Try `git -C {dir} \
             pull` (or wait ~1 min for the second half to land) and re-run.\n\n\
             Otherwise this is a genuine omission: add the missing command name(s) to build.rs's \
             `.commands(&[...])` list, and keep \
             packages/operator-core/lib/desktop-acl-command-sync.test.ts green.",
            grants = missing_grants.join(", "),
            dir = manifest_dir.display(),
        );
    }
}

fn main() {
    // Read this at build-script RUN time, not via env! at compile time. The
    // fleet shares CARGO_TARGET_DIR across the canonical and checkpoint
    // worktrees; a cached build-script binary with a baked canonical path
    // otherwise repairs the wrong checkout and leaves the checkpoint's
    // resource globs missing.
    let manifest_dir = std::env::var_os("CARGO_MANIFEST_DIR")
        .map(std::path::PathBuf::from)
        .expect("Cargo must provide CARGO_MANIFEST_DIR to build.rs");
    println!("cargo:rerun-if-changed=sidecar/spa/internal/docs");
    reject_unpruned_spa_docs(&manifest_dir);
    ensure_sidecar_placeholder(&manifest_dir);
    ensure_seed_placeholder(&manifest_dir);
    ensure_doc_vector_seed_placeholder(&manifest_dir);
    println!("cargo:rerun-if-changed=sidecar/serve.mjs");
    // Build provenance: rebuild main.rs when the build sets a new git sha so
    // `option_env!("PAPERCUSP_BUILD_SHA")` re-bakes (the operator forwards it
    // to /api/health). Without this, cargo's cache would freeze a stale sha.
    println!("cargo:rerun-if-env-changed=PAPERCUSP_BUILD_SHA");
    // Same provenance mechanism for the shipped app VERSION (WI-2644) — see the
    // matching PAPERCUSP_BUILD_VERSION option_env! + comment in main.rs.
    println!("cargo:rerun-if-env-changed=PAPERCUSP_BUILD_VERSION");
    // Same mechanism for the static release host the shipped updater polls
    // (plan desktop-release-hosting-r2-2026-07-12; see baked_release_host() in
    // main.rs). Without this rerun key cargo would cache a main.rs compiled with
    // a STALE (or empty) host and the shipped app would silently poll the wrong
    // address — the same silent-failure class the release-host work exists to fix.
    println!("cargo:rerun-if-env-changed=PAPERCUSP_RELEASE_HOST");
    // WI-36794 — same mechanism again for the release CHANNEL and the data home
    // it resolves to (see workspaces::shared_sidecar_home()). Without these
    // rerun keys cargo would cache a main.rs compiled with a STALE (or absent)
    // channel stamp, and a side-by-side build would silently open the base
    // app's `~/.papercusp` — the exact state of the desktop in daily use.
    println!("cargo:rerun-if-env-changed=PAPERCUSP_CHANNEL");
    println!("cargo:rerun-if-env-changed=PAPERCUSP_CHANNEL_DATA_HOME");
    // EI-21467292301306028 — verify-tauri-headless can lose its first devUrl
    // port to a bind-time squatter and retry with a fresh one. The Tauri CLI's
    // changed `--config` value alone did not invalidate a warm Cargo target in
    // the observed retry, so generate_context! reused the first attempt's baked
    // origin. The verifier exports the effective URL through this explicit
    // build-script key; changing ports now forces tauri_build to regenerate the
    // context before the retry launches.
    println!("cargo:rerun-if-env-changed=PAPERCUSP_VERIFY_TAURI_DEV_URL");

    // WI-1976 / WI-2143 — allow the renderer to invoke the native-shell app commands.
    // The operator SPA loads from a REMOTE http origin (http://127.0.0.1:<port>),
    // and Tauri 2's ACL rejects app-command invoke()s from a non-local origin
    // ("<cmd> not allowed. Command not found") unless a capability grants them.
    // Because the commands are registered via tauri-specta's collect_commands!
    // (not the generate_handler! macro the build script scans), Tauri never
    // generates their allow-<command> permissions on its own — so there is
    // nothing for capabilities/default.json to grant, and every un-listed
    // command is silently dead from the webview.
    //
    // WI-1976 listed only console_launch / list_windows_by_title /
    // focus_window_by_title / __dev_bridge_result — added reactively as each
    // feature broke. That left the REST of collect_commands! (workspaces_*,
    // app_version/check_for_update/install_update, pty_*, wsl_*,
    // native_terminal_*, endpoint_ipc::*, env_switch::list_envs,
    // show_attention_notification) ACL-dead — surfacing as the recurring
    // "workspaces_list not allowed. Command not found" toast (WI-2143) and a
    // whole class of silently-broken desktop commands (version chip never
    // resolves, terminals/WSL/env-switch invoke()s rejected).
    //
    // This list MUST mirror main.rs `collect_commands![]` (module prefix
    // stripped): every specta-collected command needs its allow-<command>
    // permission generated here AND granted in capabilities/default.json.
    // The drift that caused WI-2143 is now guarded by a CI test —
    // packages/operator-core/lib/desktop-acl-command-sync.test.ts fails if
    // collect_commands!, this list, and the capability grants diverge. When you
    // add/remove a collect_commands! entry, update THIS list + the capability
    // in the same change (the test tells you exactly what drifted).
    let commands: &[&str] = &[
        // workspaces (WorkspaceSwitcher / HarnessWorkspacesButton)
        "workspaces_list",
        "workspaces_create",
        "workspaces_rename",
        "workspaces_delete",
        "workspaces_switch",
        "workspaces_open_window",
        // attention / update chip
        "show_attention_notification",
        "app_version",
        "check_for_update",
        "install_update",
        "revert_to",
        // pty (desktop terminals)
        "pty_spawn",
        "pty_write",
        "pty_resize",
        "pty_kill",
        "pty_history",
        "pty_is_alive",
        // WSL setup wizard
        "wsl_status",
        "wsl_install",
        "wsl_relaunch_elevated",
        "wsl_import",
        "wsl_bootstrap",
        "wsl_finalize_ready",
        "wsl_uninstall",
        // native console / window control (WI-1976 originals)
        "console_launch",
        "list_windows_by_title",
        "focus_window_by_title",
        // WI-3033: onboarding console routed to an external Windows
        // Terminal window (the embedded ConPTY path wedges on inbox WSL)
        "external_console_run",
        // window_title_for is a plain Rust helper, not a #[tauri::command];
        // its grant is an inert orphan kept for continuity (harmless).
        "window_title_for",
        // native terminal toggle
        "native_terminal_status",
        "native_terminal_toggle",
        // webview→shell flag relay (NativeTerminalGate) — registered to keep
        // the WI-2143 ACL-sync guard green; command is in main.rs collect_commands!
        "native_terminal_set_enabled",
        // WI-3388: resizeable/collapsible terminal dock — layout get/set
        // (registered here to keep the WI-2143 ACL-sync guard green; the
        // commands are in collect_commands! in main.rs)
        "terminal_get_layout",
        "terminal_set_layout",
        // endpoint IPC transport (currently no live JS caller, but
        // collect_commands! exposes it, so grant to stay in sync)
        "endpoint_invoke",
        "endpoint_cancel",
        "endpoint_ipc_status",
        // env switcher
        "list_envs",
        // docs search palette
        "open_docs_search_palette",
        // WI-4827: Quick Panel "open in the main app window" — the palette
        // webview invokes this to hand a full-app route to the main window
        // (Spotlight-style) instead of navigating the small popup in place.
        "open_route_in_app",
        // The dev-bridge eval return channel (debug builds). Without this
        // grant the injected eval JS's invoke() is ACL-rejected from the
        // remote http origin, so every tauri-agent-tools eval/click/dom
        // call times out — the fleet-wide "wedged shell" symptom.
        "__dev_bridge_result",
    ];

    // EI-12083: catch a capability/manifest mismatch here, with an actionable
    // message, before handing off to tauri_build (whose own error on the same
    // condition is a ~500-line permission-enum wall with zero signal about the
    // likely cause — see the function doc above).
    check_capability_commands_are_registered(&manifest_dir, commands);

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("failed to run tauri_build with the app-command manifest (WI-1976)");
}
