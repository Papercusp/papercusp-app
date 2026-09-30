#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(unix)]
use tempfile::tempdir;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .expect("apps/tui lives below repo root")
        .to_path_buf()
}

#[test]
fn canonical_installer_owns_both_artifacts_and_never_kills_sessions() {
    let root = repo_root();
    let canonical_path = root.join("apps/tui/scripts/install-update.sh");
    let canonical = std::fs::read_to_string(&canonical_path).unwrap();
    assert!(canonical.contains("cargo install --path \"$ROOT/apps/tui\""));
    assert!(
        canonical.contains("cargo install"),
        "cargo installs both pui and pui-audio bins"
    );
    assert!(canonical.contains("apps/pui-zellij-plugin/Cargo.toml"));
    assert!(canonical.contains("pui-install.json"));
    assert!(canonical.contains("write-install-manifest.py"));
    assert!(!canonical.contains("json.dump"));
    for forbidden in ["pkill", "killall", "kill-session"] {
        assert!(
            !canonical.contains(forbidden),
            "installer must not contain {forbidden}"
        );
    }

    let legacy =
        std::fs::read_to_string(root.join("apps/pui-zellij-plugin/scripts/build-install.sh"))
            .unwrap();
    assert!(legacy.contains("tui/scripts/install-update.sh"));
    assert!(!legacy.contains("cargo build"));

    let launcher = std::fs::read_to_string(
        root.join("packages/operator-core/lib/endpoint-route/routes/adv/launch-pui.ts"),
    )
    .unwrap();
    assert!(launcher.contains("./apps/tui/scripts/install-update.sh"));
    assert!(!launcher.contains("cd apps/tui && cargo install --path ."));
}

#[test]
fn public_packager_stages_audio_as_a_sibling_and_rejects_alsa_on_pui() {
    let script =
        std::fs::read_to_string(repo_root().join("apps/tui/scripts/package-release.sh")).unwrap();
    assert!(script.contains("$UNIT/bin/pui-audio"));
    assert!(script.contains("audio must stay isolated in bin/pui-audio"));
    assert!(script.contains("readelf -d \"$UNIT/bin/pui\""));
}

#[test]
fn installer_help_is_side_effect_free_and_names_the_generation_manifest() {
    let script = repo_root().join("apps/tui/scripts/install-update.sh");
    let output = Command::new("bash")
        .arg(script)
        .arg("--help")
        .output()
        .unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("pui-install.json"));
    assert!(stdout.contains("never stops a process or zellij session"));
    assert!(stdout.contains("guidance-only"));
    assert!(output.stderr.is_empty());
}

#[test]
fn installer_verifies_artifacts_before_downgrading_guidance_only_doctor_findings() {
    let script =
        std::fs::read_to_string(repo_root().join("apps/tui/scripts/install-update.sh")).unwrap();
    let verify = script
        .find("python3 \"$MANIFEST_WRITER\" verify")
        .expect("installer must verify the written manifest and artifact hashes");
    let doctor = script
        .find("DOCTOR_OUTPUT=\"")
        .expect("installer must capture the doctor result before classifying it");
    assert!(
        verify < doctor,
        "manifest/hash verification must precede guidance-only doctor handling"
    );
    assert!(script.contains("PUI local install: OK"));
    assert!(script.contains("installed successfully; pui doctor reported guidance-only findings"));
    assert!(script.contains("pui doctor did not confirm the installed local artifacts"));
    assert!(script.contains("exit \"$DOCTOR_STATUS\""));
}

#[cfg(unix)]
fn write_executable(path: &Path, body: &str) {
    std::fs::write(path, body).unwrap();
    let mut permissions = std::fs::metadata(path).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(path, permissions).unwrap();
}

#[cfg(unix)]
#[test]
fn installer_keeps_guidance_only_doctor_failure_nonfatal_after_hash_verification() {
    let root = repo_root();
    let scratch = tempdir().unwrap();
    let fake_bin = scratch.path().join("fake-bin");
    let cargo_home = scratch.path().join("cargo-home");
    let target = scratch.path().join("target");
    let companion = scratch.path().join("pui-companion.wasm");
    let manifest = scratch.path().join("pui-install.json");
    std::fs::create_dir_all(&fake_bin).unwrap();

    write_executable(
        &fake_bin.join("cargo"),
        r#"#!/bin/sh
set -eu
case "$1" in
  build)
    mkdir -p "$FAKE_TARGET/wasm32-wasip1/release"
    printf '%s' 'companion' > "$FAKE_TARGET/wasm32-wasip1/release/pui_companion.wasm"
    ;;
  metadata)
    printf '{"target_directory":"%s"}\n' "$FAKE_TARGET"
    ;;
  install)
    mkdir -p "$CARGO_HOME/bin"
    cat > "$CARGO_HOME/bin/pui" <<'PUI'
#!/bin/sh
printf '%s\n' 'PUI local install: OK' 'zellij panes: STALE (1)'
exit 1
PUI
    chmod 755 "$CARGO_HOME/bin/pui"
    ;;
  *)
    echo "unexpected fake cargo invocation: $*" >&2
    exit 1
    ;;
esac
"#,
    );
    write_executable(
        &fake_bin.join("git"),
        r#"#!/bin/sh
set -eu
case "$3" in
  rev-parse) printf '%s\n' 'fake-source-sha' ;;
  status) exit 0 ;;
  *) echo "unexpected fake git invocation: $*" >&2; exit 1 ;;
esac
"#,
    );
    let original_path = std::env::var("PATH").unwrap();
    let path = format!("{}:{original_path}", fake_bin.display());

    let output = Command::new("bash")
        .arg(root.join("apps/tui/scripts/install-update.sh"))
        .env("CARGO_HOME", &cargo_home)
        .env("FAKE_TARGET", &target)
        .env("PUI_COMPANION_WASM", &companion)
        .env("PUI_INSTALL_MANIFEST", &manifest)
        .env("PATH", path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "guidance-only doctor failure must not fail a verified install (status {:?}):\nstdout:\n{}\nstderr:\n{}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stdout.contains("pui install manifest OK"));
    assert!(stdout.contains("PUI local install: OK"));
    assert!(stdout.contains("zellij panes: STALE (1)"));
    assert!(stderr.contains("installed successfully; pui doctor reported guidance-only findings"));
    assert!(
        manifest.is_file(),
        "successful install must leave its manifest"
    );
}

#[test]
fn shared_manifest_writer_supports_release_relative_paths_and_verification() {
    let root = repo_root();
    let helper = root.join("apps/tui/scripts/write-install-manifest.py");
    let scratch = std::env::temp_dir().join(format!("pui-manifest-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(scratch.join("bin")).unwrap();
    std::fs::write(scratch.join("bin/pui"), b"binary").unwrap();
    std::fs::write(scratch.join("pui-companion.wasm"), b"wasm").unwrap();
    let manifest = scratch.join("pui-install.json");

    let write = Command::new("python3")
        .arg(&helper)
        .args([
            "write",
            "--manifest",
            manifest.to_str().unwrap(),
            "--source-sha",
            "abc123",
            "--source-dirty",
            "0",
            "--built-at-epoch",
            "123",
            "--binary",
            scratch.join("bin/pui").to_str().unwrap(),
            "--companion",
            scratch.join("pui-companion.wasm").to_str().unwrap(),
            "--relative-paths",
        ])
        .output()
        .unwrap();
    assert!(
        write.status.success(),
        "{}",
        String::from_utf8_lossy(&write.stderr)
    );
    let body = std::fs::read_to_string(&manifest).unwrap();
    assert!(body.contains("\"binaryPath\": \"bin/pui\""));
    assert!(body.contains("\"companionPath\": \"pui-companion.wasm\""));

    let verify = Command::new("python3")
        .arg(&helper)
        .args([
            "verify",
            "--manifest",
            manifest.to_str().unwrap(),
            "--binary",
            scratch.join("bin/pui").to_str().unwrap(),
            "--companion",
            scratch.join("pui-companion.wasm").to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        verify.status.success(),
        "{}",
        String::from_utf8_lossy(&verify.stderr)
    );
    std::fs::remove_dir_all(scratch).unwrap();
}
