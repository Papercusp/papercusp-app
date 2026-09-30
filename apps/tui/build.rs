use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn command_stdout(root: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn repo_root() -> PathBuf {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or(manifest)
}

fn main() {
    for name in [
        "PUI_BUILD_SHA",
        "PUI_BUILD_DIRTY",
        "PUI_BUILD_EPOCH",
        "PUI_COMPANION_SHA256",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }

    let root = repo_root();
    println!(
        "cargo:rerun-if-changed={}",
        root.join(".git/HEAD").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        root.join(".git/index").display()
    );

    let source_sha = env::var("PUI_BUILD_SHA")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| command_stdout(&root, &["rev-parse", "HEAD"]))
        .unwrap_or_else(|| "unknown".to_string());
    let source_dirty = env::var("PUI_BUILD_DIRTY")
        .ok()
        .filter(|value| matches!(value.as_str(), "0" | "1"))
        .unwrap_or_else(|| {
            let output = command_stdout(
                &root,
                &[
                    "status",
                    "--porcelain",
                    "--untracked-files=normal",
                    "--",
                    "apps/tui",
                    "apps/pui-zellij-plugin",
                    "apps/pui-companion-proto",
                ],
            );
            match output {
                Some(value) if value.is_empty() => "0".to_string(),
                Some(_) => "1".to_string(),
                None => "unknown".to_string(),
            }
        });
    let build_epoch = env::var("PUI_BUILD_EPOCH")
        .ok()
        .filter(|value| value.parse::<u64>().is_ok())
        .unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
                .to_string()
        });
    let companion_sha = env::var("PUI_COMPANION_SHA256")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "unknown".to_string());

    println!("cargo:rustc-env=PUI_BUILD_SHA={source_sha}");
    println!("cargo:rustc-env=PUI_BUILD_DIRTY={source_dirty}");
    println!("cargo:rustc-env=PUI_BUILD_EPOCH={build_epoch}");
    println!("cargo:rustc-env=PUI_COMPANION_SHA256={companion_sha}");
}
