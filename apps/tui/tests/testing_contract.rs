//! Source-level guards for the documented pui test commands.
//!
//! `pui` is a binary-only crate. Keeping the live HTTP smoke's command in a
//! source contract test prevents a future documentation edit from restoring
//! Cargo's invalid `--lib` target selection.

use std::path::PathBuf;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .expect("apps/tui lives below repo root")
        .to_path_buf()
}

#[test]
fn live_http_smoke_targets_the_pui_binary() {
    let source = std::fs::read_to_string(repo_root().join("apps/tui/src/http.rs"))
        .expect("read HTTP client source");
    let command = source
        .lines()
        .find(|line| line.contains("cargo test") && line.contains("http_live"))
        .expect("http.rs must document the live HTTP smoke command");

    assert!(
        command.contains("cargo test --bin pui http_live -- --ignored"),
        "the live HTTP smoke must target pui's binary target: {command}"
    );
    assert!(
        !command.contains("--lib"),
        "pui has no library target; --lib makes the documented smoke fail: {command}"
    );
}

fn table_first_column(markdown: &str, heading: &str) -> Vec<String> {
    let mut in_section = false;
    let mut rows = Vec::new();

    for line in markdown.lines() {
        if line.trim() == heading {
            in_section = true;
            continue;
        }
        if in_section && line.starts_with("## ") {
            break;
        }
        if !in_section || !line.starts_with('|') {
            continue;
        }
        let cell = line
            .split('|')
            .nth(1)
            .expect("table row has a first column")
            .trim();
        if cell.is_empty()
            || cell.starts_with("---")
            || cell == "Capability inherited from a native client"
            || cell == "Required capability"
        {
            continue;
        }
        rows.push(cell.to_string());
    }

    rows
}

#[test]
fn public_release_ux_maps_every_native_capability_exactly_once() {
    let root = repo_root();
    let inventory = std::fs::read_to_string(root.join("apps/tui/NATIVE_CAPABILITIES.md"))
        .expect("read native capability inventory");
    let ux = std::fs::read_to_string(root.join("apps/tui/PUBLIC_RELEASE_UX.md"))
        .expect("read public-release UX contract");

    let required = table_first_column(&inventory, "## Required replacement matrix");
    let mapped = table_first_column(&ux, "## Capability replacement interaction map");

    assert_eq!(
        required.len(),
        19,
        "the release inventory population changed"
    );
    assert_eq!(
        mapped, required,
        "every native capability must keep one same-named in-PUI interaction"
    );
}

#[test]
fn public_release_ux_ir_freezes_the_wide_and_80x24_contracts() {
    let source =
        std::fs::read_to_string(repo_root().join("docs/mockups/pui-public-release-ux.ir.json"))
            .expect("read PUI public-release UI IR");
    let ir: serde_json::Value = serde_json::from_str(&source).expect("UI IR is valid JSON");

    assert_eq!(ir["irVersion"], "0.1");
    assert_eq!(ir["ecosystem"], "ratatui");

    let responsive = &ir["layout"]["children"][1]["responsive"];
    assert_eq!(responsive["terminal.wide"]["minColumns"], 160);
    assert_eq!(responsive["terminal.wide"]["minRows"], 24);
    assert_eq!(responsive["terminal.wide"]["layout"], "chat-plus-context");
    assert_eq!(responsive["terminal.wide"]["contextColumns"], 40);

    assert_eq!(responsive["terminal.compact"]["minColumns"], 80);
    assert_eq!(responsive["terminal.compact"]["minRows"], 20);
    assert_eq!(
        responsive["terminal.compact"]["layout"],
        "one-surface-at-a-time"
    );
    assert_eq!(responsive["terminal.compact"]["contextRoute"], "ctrl-t");
    assert_eq!(responsive["terminal.compact"]["chatRoute"], "o");

    let states = ir["states"].as_object().expect("states object");
    for required in [
        "first-run",
        "session-picker",
        "settings-palette",
        "approval",
        "error-recovery",
        "attachment-picker",
        "about-support",
        "too-small",
    ] {
        assert!(
            states.contains_key(required),
            "UI IR is missing required state {required}"
        );
    }
    assert_eq!(
        states["too-small"]["copy"]["default"],
        "Terminal too small — resize to at least 80×20. Your session and draft are safe."
    );
}

#[test]
fn public_release_ux_resolves_launcher_and_release_matrix() {
    let ux = std::fs::read_to_string(repo_root().join("apps/tui/PUBLIC_RELEASE_UX.md"))
        .expect("read public-release UX contract");

    assert!(ux.contains("First run and Sessions > New open the same in-PUI New session form."));
    assert!(ux.contains("Open advanced PSU launcher remains available under Advanced"));

    for row in [
        "| Linux x86_64 | Native PUI binary | Required | Required | Required |",
        "| macOS arm64 | Native PUI binary | Required | Required | Required |",
        "| macOS x86_64 | Native PUI binary | Required | Required | Required |",
        "| Windows 11 via WSL2 x86_64 | Linux PUI binary inside WSL2 | Required | Required | Required |",
    ] {
        assert!(ux.contains(row), "missing release matrix row: {row}");
    }
}
