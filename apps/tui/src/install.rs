//! Installed-artifact identity and freshness checks for `pui doctor`.
//!
//! The canonical installer builds the native binary and companion WASM from one
//! source generation, embeds that generation into both artifacts, and writes a
//! small manifest beside the WASM. Doctor verifies the manifest and hashes; it
//! never kills a process. On Linux it also detects long-lived zellij panes that
//! still map an older installed `pui` inode and prints pane/session-scoped
//! relaunch guidance.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const INSTALL_COMMAND: &str = "./apps/tui/scripts/install-update.sh";
pub const BUILD_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const BUILD_SHA: &str = env!("PUI_BUILD_SHA");
pub const BUILD_DIRTY: &str = env!("PUI_BUILD_DIRTY");
pub const BUILD_EPOCH: &str = env!("PUI_BUILD_EPOCH");
pub const EXPECTED_COMPANION_SHA256: &str = env!("PUI_COMPANION_SHA256");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallManifest {
    pub schema_version: u32,
    pub source_sha: String,
    pub source_dirty: bool,
    pub built_at_epoch: u64,
    pub binary_path: String,
    pub binary_sha256: String,
    pub companion_path: String,
    pub companion_sha256: String,
    /// The git worktree `source_sha` was resolved from, when the writer knew
    /// one (install-update.sh always passes it; an older manifest, or one from
    /// another writer, simply omits the field). Used by
    /// `operator_generation_contained` to ask git whether a differing operator
    /// build sha is an ancestor of (already covered by) this install — missing
    /// is treated as "unknown", never as "no root exists".
    #[serde(default)]
    pub source_root: Option<String>,
    /// Release version (`CARGO_PKG_VERSION` of the build). Written by the release
    /// packager and the sidecar; `pui self` refuses to activate a unit without it
    /// because the versioned release directory and the downgrade check need it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// `<os>-<arch>` the unit was built for (e.g. `linux-x86_64`), so a unit that
    /// cannot run here is refused by name rather than by an exec error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

/// Manifest filename, both beside a relocatable release unit and in `~/.papercusp`.
pub const MANIFEST_NAME: &str = "pui-install.json";

/// `<os>-<arch>` of this build, the same vocabulary the release packager names
/// archives and manifests with.
pub fn this_target() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

/// The release unit root a binary at `<root>/bin/pui` belongs to, when that root
/// carries a manifest. `None` for a loose binary (cargo install, target dir).
pub fn release_root_of(exe: &Path) -> Option<PathBuf> {
    exe.parent()
        .and_then(Path::parent)
        .filter(|root| root.join(MANIFEST_NAME).is_file())
        .map(Path::to_path_buf)
}

/// The companion WASM named by the release manifest beside `exe`, if the binary
/// runs from a release unit and that manifest resolves.
pub fn release_companion_of(exe: &Path) -> Option<PathBuf> {
    let manifest_path = release_root_of(exe)?.join(MANIFEST_NAME);
    let manifest = read_manifest(&manifest_path).ok()?;
    resolve_manifest_artifact(&manifest_path, &manifest.companion_path, "companionPath").ok()
}

/// When this binary runs from a versioned release unit that bundles its own
/// `bin/zellij`, put that `bin/` first on PATH. The companion plugin API is
/// version-coupled to zellij, and every `zellij` invocation (and pane) resolves
/// the bare name, so the matched copy must win over whatever PATH holds. Units
/// without a manifest `version` (the desktop sidecar, a loose cargo build) keep
/// their existing PATH untouched.
pub fn prefer_bundled_tools() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let Some(root) = release_root_of(&exe) else {
        return;
    };
    let versioned = read_manifest(&root.join(MANIFEST_NAME))
        .map(|manifest| manifest.version.is_some())
        .unwrap_or(false);
    let bin = root.join("bin");
    if !versioned || !bin.join("zellij").is_file() {
        return;
    }
    let mut paths: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    if paths.first() == Some(&bin) {
        return;
    }
    paths.retain(|path| path != &bin);
    paths.insert(0, bin);
    if let Ok(joined) = std::env::join_paths(paths) {
        std::env::set_var("PATH", joined);
    }
}

pub fn read_manifest(manifest_path: &Path) -> Result<InstallManifest> {
    let bytes = fs::read(manifest_path)
        .with_context(|| format!("read install manifest {}", manifest_path.display()))?;
    let manifest: InstallManifest = serde_json::from_slice(&bytes)
        .with_context(|| format!("decode install manifest {}", manifest_path.display()))?;
    if manifest.schema_version != 1 {
        bail!(
            "unsupported pui install manifest schema {}",
            manifest.schema_version
        );
    }
    Ok(manifest)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildStamp {
    pub version: String,
    pub source_sha: String,
    pub source_dirty: Option<bool>,
    pub built_at_epoch: Option<u64>,
    pub companion_sha256: Option<String>,
}

impl BuildStamp {
    pub fn embedded() -> Self {
        Self {
            version: BUILD_VERSION.to_string(),
            source_sha: BUILD_SHA.to_string(),
            source_dirty: match BUILD_DIRTY {
                "0" => Some(false),
                "1" => Some(true),
                _ => None,
            },
            built_at_epoch: BUILD_EPOCH.parse().ok(),
            companion_sha256: (EXPECTED_COMPANION_SHA256 != "unknown")
                .then(|| EXPECTED_COMPANION_SHA256.to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalInstallCheck {
    pub manifest_path: PathBuf,
    pub manifest: InstallManifest,
    pub binary_path: PathBuf,
    pub companion_path: PathBuf,
    pub binary_sha256: String,
    pub companion_sha256: String,
    pub binary_modified_epoch: Option<u64>,
    pub companion_modified_epoch: Option<u64>,
    pub warnings: Vec<String>,
    pub problems: Vec<String>,
}

impl LocalInstallCheck {
    pub fn is_ok(&self) -> bool {
        self.problems.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StalePane {
    pub pid: u32,
    pub session: Option<String>,
    pub command: String,
}

impl StalePane {
    pub fn relaunch_guidance(&self) -> String {
        match self.session.as_deref() {
            Some("pui-wb") => format!(
                "pid {} is the stale pui-wb pane; close that workbench terminal, then run `pui workbench`. If the exact app-managed session survives, run `zellij kill-session pui-wb` before reopening (no other session is touched).",
                self.pid
            ),
            Some("pui-dock") => format!(
                "pid {} is the stale pui-dock pane; close that dock terminal, then run `pui chat`. If the exact app-managed session survives, run `zellij kill-session pui-dock` before reopening (no other session is touched).",
                self.pid
            ),
            Some(session) => format!(
                "pid {} is stale inside zellij session {session:?}; exit and reopen only this pui pane (`{}`), and do not kill the enclosing session.",
                self.pid, self.command
            ),
            None => format!(
                "pid {} is a stale in-zellij pui process (`{}`); exit and reopen only that pane. The session name was unavailable, so do not run a session-wide kill command.",
                self.pid, self.command
            ),
        }
    }
}

fn default_manifest_path(current_exe: &Path) -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("PUI_INSTALL_MANIFEST") {
        return Ok(PathBuf::from(path));
    }
    if let Some(root) = release_root_of(current_exe) {
        return Ok(root.join(MANIFEST_NAME));
    }
    Ok(dirs::home_dir()
        .context("resolve home directory for pui install manifest")?
        .join(".papercusp")
        .join(MANIFEST_NAME))
}

pub(crate) fn sha256_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buf)
            .with_context(|| format!("read {}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn modified_epoch(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
}

fn same_path(a: &Path, b: &Path) -> bool {
    let normalize = |path: &Path| fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    normalize(a) == normalize(b)
}

pub fn inspect_local_install() -> Result<LocalInstallCheck> {
    let current_exe = std::env::current_exe().context("resolve running pui executable")?;
    let manifest_path = default_manifest_path(&current_exe)?;
    inspect_paths(&manifest_path, &current_exe, &BuildStamp::embedded())
}

pub(crate) fn resolve_manifest_artifact(
    manifest_path: &Path,
    raw: &str,
    label: &str,
) -> Result<PathBuf> {
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        return Ok(path);
    }
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        bail!("{label} must not escape the pui install manifest directory");
    }
    Ok(manifest_path
        .parent()
        .context("pui install manifest has no parent directory")?
        .join(path))
}

pub fn inspect_paths(
    manifest_path: &Path,
    current_exe: &Path,
    build: &BuildStamp,
) -> Result<LocalInstallCheck> {
    let manifest = read_manifest(manifest_path)?;

    let binary_path =
        resolve_manifest_artifact(manifest_path, &manifest.binary_path, "binaryPath")?;
    let companion_path =
        resolve_manifest_artifact(manifest_path, &manifest.companion_path, "companionPath")?;
    let binary_sha256 = sha256_file(current_exe)?;
    let companion_sha256 = sha256_file(&companion_path)?;
    let mut warnings = Vec::new();
    let mut problems = Vec::new();

    if !same_path(current_exe, &binary_path) {
        problems.push(format!(
            "running binary {} is not the installed artifact {}",
            current_exe.display(),
            binary_path.display()
        ));
    }
    if binary_sha256 != manifest.binary_sha256 {
        problems.push("running binary hash does not match pui-install.json".to_string());
    }
    if companion_sha256 != manifest.companion_sha256 {
        problems.push("installed companion WASM hash does not match pui-install.json".to_string());
    }
    if build.source_sha != manifest.source_sha {
        problems.push(format!(
            "binary embeds source {} but the install generation records {}",
            build.source_sha, manifest.source_sha
        ));
    }
    if let Some(expected) = build.companion_sha256.as_deref() {
        if expected != companion_sha256 {
            problems.push("binary embeds a different companion WASM hash".to_string());
        }
    } else {
        warnings.push(format!(
            "binary was not built by the canonical installer; companion identity is unknown (run {INSTALL_COMMAND})"
        ));
    }
    if let Some(epoch) = build.built_at_epoch {
        if epoch != manifest.built_at_epoch {
            problems.push(format!(
                "binary build epoch {epoch} differs from install generation {}",
                manifest.built_at_epoch
            ));
        }
    }
    if let Some(dirty) = build.source_dirty {
        if dirty != manifest.source_dirty {
            problems.push("binary dirty-source stamp differs from install manifest".to_string());
        }
    }
    if manifest.source_dirty {
        warnings.push(
            "install generation includes uncommitted pui/companion source; final shipment must reinstall from the exact committed staging SHA"
                .to_string(),
        );
    }

    let binary_modified_epoch = modified_epoch(&binary_path);
    let companion_modified_epoch = modified_epoch(&companion_path);
    if let (Some(binary), Some(companion)) = (binary_modified_epoch, companion_modified_epoch) {
        if binary.abs_diff(companion) > 3600 {
            problems.push(format!(
                "binary and companion mtimes differ by {}s; they are not a plausible single install generation",
                binary.abs_diff(companion)
            ));
        }
    }

    Ok(LocalInstallCheck {
        manifest_path: manifest_path.to_path_buf(),
        manifest,
        binary_path,
        companion_path,
        binary_sha256,
        companion_sha256,
        binary_modified_epoch,
        companion_modified_epoch,
        warnings,
        problems,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallFreshnessStatus {
    Ok,
    Stale,
    Error,
}

impl InstallFreshnessStatus {
    pub fn label(self) -> &'static str {
        match self {
            Self::Ok => "OK",
            Self::Stale => "STALE",
            Self::Error => "ERROR",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperatorInstallFreshness {
    pub status: InstallFreshnessStatus,
    pub detail: String,
    pub repair: Option<String>,
}

impl OperatorInstallFreshness {
    pub fn is_ok(&self) -> bool {
        self.status == InstallFreshnessStatus::Ok
    }
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

/// Compare the installed PUI generation with the selected operator's build identity.
///
/// This is a hard doctor verdict rather than the old informational "source compare"
/// line. An explicitly selected remote operator can otherwise keep accepting a stale
/// client indefinitely even though it exposes the exact source identity needed to
/// detect the mismatch. The repair reuses P-021's one supported install/update path;
/// `PUI_OPERATOR` remains scoped to the selected remote target.
///
/// `operator_generation_caught_up` disambiguates a DIFFERING sha into two
/// structurally different situations (EI-22066271581968324): the installed pui may
/// be genuinely BEHIND the operator (rebuilding from local tip converges — the
/// existing repair is correct and actionable), or the operator may simply be
/// PINNED to an older generation the local tree has already passed (`release`
/// (:3070) lags `staging` by design, or any long-running operator that hasn't been
/// restarted since). In the latter case the prescribed repair can never converge:
/// it always rebuilds from the *current* local tip, which on a continuously
/// committing tree is a strictly newer commit each time, so the two shas simply
/// never land on the same value again — a deterministic loop, not a repair. Pass
/// `Some(true)` when the caller has verified (via `operator_generation_contained`)
/// that the operator's sha is an ancestor of / equal to the installed sha; `None`
/// when unknown (preserves the original STALE+repair verdict, the safe default).
pub fn operator_install_freshness(
    installed_sha: &str,
    operator_sha: Option<&str>,
    endpoint: &str,
    operator_generation_caught_up: Option<bool>,
) -> OperatorInstallFreshness {
    match operator_sha.map(str::trim).filter(|sha| !sha.is_empty()) {
        // The operator identity endpoint intentionally exposes `git rev-parse
        // --short HEAD`, while the installer manifest records the exact 40-char
        // source SHA. Treat a strict prefix match as the same commit in either
        // direction; an equal-length value still has to match exactly.
        Some(sha) if sha_identity_matches(installed_sha, sha) => OperatorInstallFreshness {
            status: InstallFreshnessStatus::Ok,
            detail: format!("installed source {installed_sha} matches the selected operator"),
            repair: None,
        },
        Some(sha) if operator_generation_caught_up == Some(true) => OperatorInstallFreshness {
            status: InstallFreshnessStatus::Ok,
            detail: format!(
                "installed source {installed_sha} already covers the selected operator's \
                 generation {sha} (operator is pinned to an older/deployed generation — \
                 expected skew, not local staleness; rebuilding cannot change it)"
            ),
            repair: None,
        },
        Some(sha) => OperatorInstallFreshness {
            status: InstallFreshnessStatus::Stale,
            detail: format!(
                "installed pui source {installed_sha} differs from selected operator source {sha}"
            ),
            repair: Some(format!(
                "PUI_OPERATOR={} {INSTALL_COMMAND}",
                shell_single_quote(endpoint)
            )),
        },
        None => OperatorInstallFreshness {
            status: InstallFreshnessStatus::Error,
            detail: "selected operator did not expose a source SHA, so install freshness cannot be verified"
                .to_string(),
            repair: Some(format!(
                "upgrade the selected operator, then run `PUI_OPERATOR={endpoint} pui doctor`"
            )),
        },
    }
}

/// How the running binary was installed, which decides the repair doctor may
/// name: a checkout build is updated by the source installer, while an installed
/// release unit (P-011 / D-016) has no checkout or Cargo to rebuild with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallOrigin {
    Checkout,
    Release,
}

pub fn install_origin_of(exe: &Path) -> InstallOrigin {
    release_root_of(exe)
        .and_then(|root| read_manifest(&root.join(MANIFEST_NAME)).ok())
        .filter(|manifest| manifest.version.is_some())
        .map_or(InstallOrigin::Checkout, |_| InstallOrigin::Release)
}

pub fn current_install_origin() -> InstallOrigin {
    std::env::current_exe()
        .map(|exe| install_origin_of(&exe))
        .unwrap_or(InstallOrigin::Checkout)
}

/// The supported command that updates an installation of this origin.
pub fn update_command(origin: InstallOrigin) -> &'static str {
    match origin {
        InstallOrigin::Checkout => INSTALL_COMMAND,
        InstallOrigin::Release => "pui self update --from <PUI release archive>",
    }
}

impl OperatorInstallFreshness {
    /// A release install cannot rebuild from a local tip, so its STALE repair is
    /// to install a PUI release whose source history includes the operator's
    /// generation. (Not "the release built from the operator's source": a release
    /// that is already newer than the operator never needs that, and the ancestry
    /// listing now reports it as covered, WI-10003535.)
    pub fn for_origin(mut self, origin: InstallOrigin, operator_sha: Option<&str>) -> Self {
        if origin == InstallOrigin::Release && self.status == InstallFreshnessStatus::Stale {
            self.repair = Some(format!(
                "install a PUI release whose source includes the operator's generation {}: {}",
                operator_sha.unwrap_or("(unreported)"),
                update_command(origin)
            ));
        }
        self
    }
}

/// Best-effort: is `operator_sha` an ancestor of (or equal to) `installed_sha` in
/// the git history rooted at `source_root`? `Some(true)` means the installed pui
/// already covers everything the operator's generation does, so a differing sha is
/// expected deploy/restart skew rather than local staleness. `Some(false)` means a
/// genuine divergence (the installed pui is missing commits the operator has, or
/// the two histories are unrelated) — the existing rebuild repair remains correct.
/// `None` means this could not be determined (no git on PATH, `source_root` is not
/// a git worktree, one of the shas does not resolve, …) and callers MUST treat that
/// as "unknown", never as "no" — it falls back to the pre-existing STALE verdict.
pub fn operator_generation_contained(
    source_root: &str,
    operator_sha: &str,
    installed_sha: &str,
) -> Option<bool> {
    let operator_sha = operator_sha.trim();
    let installed_sha = installed_sha.trim();
    if source_root.trim().is_empty() || operator_sha.is_empty() || installed_sha.is_empty() {
        return None;
    }
    let output = std::process::Command::new("git")
        .args([
            "-C",
            source_root,
            "merge-base",
            "--is-ancestor",
            operator_sha,
            installed_sha,
        ])
        .output()
        .ok()?;
    match output.status.code() {
        // `git merge-base --is-ancestor` prints nothing and answers purely via
        // exit status: 0 = ancestor (or same commit), 1 = definitively not. Any
        // other code (128 unknown revision / not a repository, missing git, a
        // signal, …) is genuinely UNKNOWN, not a "no" — never conflate the two.
        Some(0) => Some(true),
        Some(1) => Some(false),
        _ => None,
    }
}

/// Filename of the source-ancestry listing a release unit carries beside its
/// manifest (written by `scripts/package-release.sh`): every commit reachable from
/// the release's `sourceSha`, one lowercase 12-hex prefix per line, byte-sorted.
/// It lets a release install answer "is the operator's generation already covered
/// by this pui?" WITHOUT a git checkout (WI-10003535). Without it, a public install
/// could only report a differing operator sha as STALE and prescribe a repair that
/// cannot converge when the operator is older.
pub const ANCESTRY_NAME: &str = "pui-source-ancestry.txt";

/// Prefix length stored per commit in [`ANCESTRY_NAME`]. At 48 bits there is no
/// realistic collision across the repository's history, and a short operator sha
/// (`git rev-parse --short`, 7+ chars) is matched as a prefix of these entries.
pub const ANCESTRY_PREFIX_LEN: usize = 12;

/// Is `operator_sha` in the release's source ancestry `listing` (the contents of
/// [`ANCESTRY_NAME`])? `Some(true)` means the operator's generation is the release's
/// own source or an ancestor of it, so a differing sha is expected skew. `Some(false)`
/// means it is not in the release's history: the operator is newer or diverged, and
/// a newer PUI release is the real repair. `None` means the question cannot be
/// answered (empty listing, or an operator sha that is not a 7+ char hex string), so
/// the caller keeps the pre-existing STALE verdict.
pub fn operator_generation_in_ancestry(listing: &str, operator_sha: &str) -> Option<bool> {
    let operator_sha = operator_sha.trim().to_ascii_lowercase();
    if operator_sha.len() < 7 || !operator_sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let prefix = &operator_sha[..operator_sha.len().min(ANCESTRY_PREFIX_LEN)];
    let entries: Vec<&str> = listing
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if entries.is_empty() {
        return None;
    }
    // The packager byte-sorts the listing, so the first entry >= `prefix` is the
    // only candidate that can start with it.
    let index = entries.partition_point(|entry| *entry < prefix);
    Some(
        entries
            .get(index)
            .is_some_and(|entry| entry.starts_with(prefix)),
    )
}

/// Git-free ancestry for a binary running from an installed release unit: reads
/// [`ANCESTRY_NAME`] beside the unit's manifest. `None` when `exe` is not in a
/// release unit, or the unit predates the listing, or it cannot be read.
pub fn release_generation_contained(exe: &Path, operator_sha: &str) -> Option<bool> {
    let listing = fs::read_to_string(release_root_of(exe)?.join(ANCESTRY_NAME)).ok()?;
    operator_generation_in_ancestry(&listing, operator_sha)
}

fn sha_identity_matches(installed_sha: &str, operator_sha: &str) -> bool {
    if installed_sha.is_empty() || operator_sha.is_empty() {
        return false;
    }
    installed_sha == operator_sha
        || (installed_sha.len() < operator_sha.len() && operator_sha.starts_with(installed_sha))
        || (operator_sha.len() < installed_sha.len() && installed_sha.starts_with(operator_sha))
}

pub fn age_label(epoch: Option<u64>) -> String {
    let Some(epoch) = epoch else {
        return "mtime unavailable".to_string();
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let age = now.saturating_sub(epoch);
    if age < 60 {
        format!("{age}s old")
    } else if age < 3600 {
        format!("{}m old", age / 60)
    } else if age < 86_400 {
        format!("{}h old", age / 3600)
    } else {
        format!("{}d old", age / 86_400)
    }
}

#[cfg(target_os = "linux")]
fn read_nul_fields(path: &Path) -> Option<Vec<String>> {
    let bytes = fs::read(path).ok()?;
    Some(
        bytes
            .split(|byte| *byte == 0)
            .filter(|field| !field.is_empty())
            .map(|field| String::from_utf8_lossy(field).into_owned())
            .collect(),
    )
}

#[cfg(target_os = "linux")]
fn env_value(fields: &[String], key: &str) -> Option<String> {
    fields
        .iter()
        .find_map(|field| field.strip_prefix(&format!("{key}=")).map(str::to_string))
}

#[cfg(target_os = "linux")]
fn trim_deleted_suffix(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    PathBuf::from(value.strip_suffix(" (deleted)").unwrap_or(&value))
}

/// Find in-zellij pui processes still mapping a replaced installed binary.
/// Failures to inspect individual processes are ignored (they may exit while
/// `/proc` is being walked, or belong to another user).
#[cfg(target_os = "linux")]
pub fn stale_zellij_panes(installed_binary: &Path) -> Vec<StalePane> {
    use std::os::unix::fs::MetadataExt;

    let Ok(installed_meta) = fs::metadata(installed_binary) else {
        return Vec::new();
    };
    let mut panes = Vec::new();
    let Ok(entries) = fs::read_dir("/proc") else {
        return panes;
    };
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|value| value.parse::<u32>().ok())
        else {
            continue;
        };
        if pid == std::process::id() {
            continue;
        }
        let process = entry.path();
        let Ok(exe_target) = fs::read_link(process.join("exe")) else {
            continue;
        };
        if trim_deleted_suffix(&exe_target) != installed_binary {
            continue;
        }
        let Ok(process_meta) = fs::metadata(process.join("exe")) else {
            continue;
        };
        if process_meta.dev() == installed_meta.dev() && process_meta.ino() == installed_meta.ino()
        {
            continue;
        }
        let Some(environment) = read_nul_fields(&process.join("environ")) else {
            continue;
        };
        if env_value(&environment, "ZELLIJ").is_none() {
            continue;
        }
        let command = read_nul_fields(&process.join("cmdline"))
            .map(|parts| parts.join(" "))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "pui".to_string());
        panes.push(StalePane {
            pid,
            session: env_value(&environment, "ZELLIJ_SESSION_NAME"),
            command,
        });
    }
    panes.sort_by_key(|pane| pane.pid);
    panes
}

#[cfg(not(target_os = "linux"))]
pub fn stale_zellij_panes(_installed_binary: &Path) -> Vec<StalePane> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn stamp(source_sha: &str, epoch: u64, companion_sha256: &str) -> BuildStamp {
        BuildStamp {
            version: "0.1.0".into(),
            source_sha: source_sha.into(),
            source_dirty: Some(false),
            built_at_epoch: Some(epoch),
            companion_sha256: Some(companion_sha256.into()),
        }
    }

    #[test]
    fn manifest_binds_binary_and_companion_to_one_generation() {
        let dir = tempdir().unwrap();
        let binary = dir.path().join("pui");
        let companion = dir.path().join("pui-companion.wasm");
        let manifest_path = dir.path().join("pui-install.json");
        fs::write(&binary, b"binary-v1").unwrap();
        fs::write(&companion, b"wasm-v1").unwrap();
        let binary_sha = sha256_file(&binary).unwrap();
        let companion_sha = sha256_file(&companion).unwrap();
        let manifest = InstallManifest {
            schema_version: 1,
            source_sha: "abc123".into(),
            source_dirty: false,
            built_at_epoch: 123,
            binary_path: binary.display().to_string(),
            binary_sha256: binary_sha,
            companion_path: companion.display().to_string(),
            companion_sha256: companion_sha.clone(),
            source_root: None,
            version: None,
            target: None,
        };
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();

        let check = inspect_paths(
            &manifest_path,
            &binary,
            &stamp("abc123", 123, &companion_sha),
        )
        .unwrap();
        assert!(check.is_ok(), "{:?}", check.problems);
        assert_eq!(check.binary_path, binary);
        assert_eq!(check.companion_path, companion);
        assert!(check.warnings.is_empty());

        fs::write(&companion, b"wasm-v2").unwrap();
        let stale = inspect_paths(
            &manifest_path,
            &binary,
            &stamp("abc123", 123, &companion_sha),
        )
        .unwrap();
        assert!(stale
            .problems
            .iter()
            .any(|problem| problem.contains("companion WASM hash")));
    }

    #[test]
    fn release_relative_manifest_paths_resolve_from_the_manifest_directory() {
        let dir = tempdir().unwrap();
        let bin = dir.path().join("bin");
        fs::create_dir(&bin).unwrap();
        let binary = bin.join("pui");
        let companion = dir.path().join("pui-companion.wasm");
        let manifest_path = dir.path().join("pui-install.json");
        fs::write(&binary, b"release-binary").unwrap();
        fs::write(&companion, b"release-wasm").unwrap();
        let companion_sha = sha256_file(&companion).unwrap();
        let manifest = InstallManifest {
            schema_version: 1,
            source_sha: "release-sha".into(),
            source_dirty: false,
            built_at_epoch: 456,
            binary_path: "bin/pui".into(),
            binary_sha256: sha256_file(&binary).unwrap(),
            companion_path: "pui-companion.wasm".into(),
            companion_sha256: companion_sha.clone(),
            source_root: None,
            version: None,
            target: None,
        };
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();

        let check = inspect_paths(
            &manifest_path,
            &binary,
            &stamp("release-sha", 456, &companion_sha),
        )
        .unwrap();
        assert!(check.is_ok(), "{:?}", check.problems);

        let escaping = InstallManifest {
            companion_path: "../outside.wasm".into(),
            ..manifest
        };
        fs::write(&manifest_path, serde_json::to_vec(&escaping).unwrap()).unwrap();
        assert!(inspect_paths(
            &manifest_path,
            &binary,
            &stamp("release-sha", 456, &companion_sha)
        )
        .unwrap_err()
        .to_string()
        .contains("must not escape"));
    }

    #[test]
    fn relaunch_guidance_is_scoped_and_never_blanket_kills() {
        let workbench = StalePane {
            pid: 7,
            session: Some("pui-wb".into()),
            command: "pui hud".into(),
        }
        .relaunch_guidance();
        assert!(workbench.contains("kill-session pui-wb"));
        assert!(workbench.contains("no other session is touched"));

        let foreign = StalePane {
            pid: 8,
            session: Some("my-important-shells".into()),
            command: "pui hud".into(),
        }
        .relaunch_guidance();
        assert!(foreign.contains("do not kill the enclosing session"));
        assert!(!foreign.contains("kill-session"));
    }

    #[test]
    fn operator_freshness_uses_local_verdicts_and_the_same_remote_update_path() {
        let current = operator_install_freshness(
            "build-a",
            Some("build-a"),
            "https://operator.example:9443",
            None,
        );
        assert_eq!(current.status.label(), "OK");
        assert!(current.is_ok());
        assert!(current.repair.is_none());

        let stale = operator_install_freshness(
            "build-a",
            Some("build-b"),
            "https://operator.example:9443",
            None,
        );
        assert_eq!(stale.status.label(), "STALE");
        assert!(!stale.is_ok());
        assert!(stale.detail.contains("build-a"));
        assert!(stale.detail.contains("build-b"));
        let repair = stale.repair.expect("stale install has a repair command");
        assert!(repair.contains("PUI_OPERATOR='https://operator.example:9443'"));
        assert!(repair.contains(INSTALL_COMMAND));

        let short_remote = operator_install_freshness(
            "c3bd839379f7461b04a6376f91892c58c48ef9b8",
            Some("c3bd839379"),
            "http://127.0.0.1:3170",
            None,
        );
        assert!(short_remote.is_ok());
        let short_local = operator_install_freshness(
            "c3bd839379",
            Some("c3bd839379f7461b04a6376f91892c58c48ef9b8"),
            "http://127.0.0.1:3170",
            None,
        );
        assert!(short_local.is_ok());

        let same_prefix_but_different = operator_install_freshness(
            "c3bd839379f7461b04a6376f91892c58c48ef9b8",
            Some("c3bd839379f7461b04a6376f91892c58c48ef9b9"),
            "http://127.0.0.1:3170",
            None,
        );
        assert!(!same_prefix_but_different.is_ok());

        let unknown =
            operator_install_freshness("build-a", None, "https://operator.example:9443", None);
        assert_eq!(unknown.status.label(), "ERROR");
        assert!(!unknown.is_ok());
        assert!(unknown.repair.is_some());
    }

    #[test]
    fn release_install_repair_names_self_update_not_the_checkout_script() {
        let stale = operator_install_freshness("build-a", Some("build-b"), "http://op", None);
        let checkout = stale
            .clone()
            .for_origin(InstallOrigin::Checkout, Some("build-b"));
        assert!(checkout
            .repair
            .as_deref()
            .unwrap()
            .contains(INSTALL_COMMAND));

        let release = stale.for_origin(InstallOrigin::Release, Some("build-b"));
        let repair = release
            .repair
            .expect("a stale release install still has a repair");
        assert!(repair.contains("pui self update"), "{repair}");
        assert!(repair.contains("build-b"), "{repair}");
        assert!(!repair.contains(INSTALL_COMMAND), "{repair}");

        let ok = operator_install_freshness("build-a", Some("build-a"), "http://op", None)
            .for_origin(InstallOrigin::Release, Some("build-a"));
        assert!(ok.repair.is_none());
    }

    #[test]
    fn install_origin_is_release_only_for_a_versioned_unit() {
        let dir = tempdir().unwrap();
        let exe = dir.path().join("bin/pui");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::write(&exe, b"pui").unwrap();
        assert_eq!(install_origin_of(&exe), InstallOrigin::Checkout);

        let mut manifest = json!({
            "schemaVersion": 1, "sourceSha": "abc", "sourceDirty": false, "builtAtEpoch": 1,
            "binaryPath": "bin/pui", "binarySha256": "x",
            "companionPath": "pui-companion.wasm", "companionSha256": "y",
        });
        let manifest_path = dir.path().join(MANIFEST_NAME);
        fs::write(&manifest_path, manifest.to_string()).unwrap();
        assert_eq!(
            install_origin_of(&exe),
            InstallOrigin::Checkout,
            "the desktop sidecar's unversioned unit keeps checkout semantics"
        );

        manifest["version"] = json!("0.1.0");
        fs::write(&manifest_path, manifest.to_string()).unwrap();
        assert_eq!(install_origin_of(&exe), InstallOrigin::Release);
    }

    /// EI-22066271581968324: a differing sha against a PINNED-BEHIND operator
    /// (release/main, or any long-running operator not restarted since) must not
    /// keep prescribing a rebuild that can never converge — the deterministic
    /// loop from the bug report.
    #[test]
    fn operator_freshness_stops_the_loop_when_the_operator_is_pinned_behind() {
        let caught_up = operator_install_freshness(
            "a88b41aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            Some("6e898b6cf8"),
            "http://127.0.0.1:9071",
            Some(true),
        );
        assert_eq!(caught_up.status.label(), "OK");
        assert!(caught_up.is_ok());
        assert!(
            caught_up.repair.is_none(),
            "no local action converges a pinned-behind operator"
        );
        assert!(caught_up.detail.contains("a88b41"));
        assert!(caught_up.detail.contains("6e898b6cf8"));

        // A GENUINE divergence (installed pui is missing operator commits, or the
        // histories are unrelated) must keep the existing hard-fail + repair —
        // this is exactly the case the original hard check exists to catch, and
        // `operator_generation_caught_up` must never soften it.
        let genuinely_behind = operator_install_freshness(
            "build-a",
            Some("build-b"),
            "http://127.0.0.1:9071",
            Some(false),
        );
        assert_eq!(genuinely_behind.status.label(), "STALE");
        assert!(genuinely_behind.repair.is_some());

        // Unknown (git unavailable, no recorded source_root, ...) must fall back
        // to today's verdict rather than silently going quiet.
        let unknown_ancestry =
            operator_install_freshness("build-a", Some("build-b"), "http://127.0.0.1:9071", None);
        assert_eq!(unknown_ancestry.status.label(), "STALE");
        assert!(unknown_ancestry.repair.is_some());
    }

    /// Real git repo, real `merge-base --is-ancestor` shell-out — this is the
    /// live half `operator_freshness_stops_the_loop_when_the_operator_is_pinned_behind`
    /// stubs with a bool.
    #[test]
    fn operator_generation_contained_asks_real_git_for_ancestry() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .arg("-C")
                .arg(root)
                .args(args)
                .status()
                .expect("git must be on PATH for this test");
            assert!(status.success(), "git {:?} failed", args);
        };
        git(&["init", "--quiet", "--initial-branch=main"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "test"]);
        fs::write(root.join("f"), b"v1").unwrap();
        git(&["add", "f"]);
        git(&["commit", "--quiet", "-m", "v1"]);
        let older = String::from_utf8(
            std::process::Command::new("git")
                .arg("-C")
                .arg(root)
                .args(["rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string();
        fs::write(root.join("f"), b"v2").unwrap();
        git(&["add", "f"]);
        git(&["commit", "--quiet", "-m", "v2"]);
        let newer = String::from_utf8(
            std::process::Command::new("git")
                .arg("-C")
                .arg(root)
                .args(["rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string();

        let root_str = root.to_str().unwrap();
        // The operator's (older) sha IS an ancestor of the installed (newer) sha:
        // the client already covers this generation.
        assert_eq!(
            operator_generation_contained(root_str, &older, &newer),
            Some(true)
        );
        // PRODUCTION SHAPE: the operator identity endpoint exposes `git rev-parse
        // --short HEAD`, so the sha that actually reaches this function is
        // ABBREVIATED — never the 40-char form the assertion above uses. Pin that
        // git resolves it identically. If it ever did not, every real doctor run
        // would fall through to exit 128 -> None and silently restore the
        // deterministic repair loop this function exists to break, while the
        // full-sha assertions above stayed green (EI-22066271581968324).
        assert_eq!(
            operator_generation_contained(root_str, &older[..10], &newer),
            Some(true)
        );
        // The reverse is definitively false: the newer commit is not an ancestor
        // of the older one.
        assert_eq!(
            operator_generation_contained(root_str, &newer, &older),
            Some(false)
        );
        // A commit git has never heard of resolves to "unknown", not "false".
        assert_eq!(
            operator_generation_contained(
                root_str,
                "0000000000000000000000000000000000dead",
                &newer
            ),
            None
        );
        // No git repository at all is also "unknown".
        let no_repo = tempdir().unwrap();
        assert_eq!(
            operator_generation_contained(no_repo.path().to_str().unwrap(), &older, &newer),
            None
        );
    }

    /// WI-10003535: a public release install has no checkout, so the ancestry
    /// question is answered from the listing the unit ships. Pins prefix
    /// matching for short and full shas, the definite "not in history" answer,
    /// and the "unknown" answers that must keep the safe STALE fallback.
    #[test]
    fn operator_generation_in_ancestry_answers_without_git() {
        let listing = "0123456789ab\n5f720ea918f6\n8e14b49f0c1d\nb5e2b1fbccf0\n";
        // Full 40-char operator sha: compared on its 12-char prefix.
        assert_eq!(
            operator_generation_in_ancestry(listing, "b5e2b1fbccf0aaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            Some(true)
        );
        // `git rev-parse --short` form, and case-insensitive.
        assert_eq!(
            operator_generation_in_ancestry(listing, "B5E2B1F"),
            Some(true)
        );
        assert_eq!(
            operator_generation_in_ancestry(listing, " 8e14b49f0c \n"),
            Some(true)
        );
        // Not in the release's history: the operator is newer or diverged.
        assert_eq!(
            operator_generation_in_ancestry(listing, "ffffffffffff"),
            Some(false)
        );
        assert_eq!(
            operator_generation_in_ancestry(listing, "5f720eb"),
            Some(false)
        );
        // Unanswerable, never read as "no".
        assert_eq!(
            operator_generation_in_ancestry(listing, "b5e2b1"),
            None,
            "too short"
        );
        assert_eq!(
            operator_generation_in_ancestry(listing, "build-b"),
            None,
            "not hex"
        );
        assert_eq!(
            operator_generation_in_ancestry("\n \n", "b5e2b1fbccf0"),
            None,
            "empty listing"
        );
    }

    /// The case the independent acceptance card rated degraded: an installed
    /// release unit, an operator that is an ANCESTOR of the release source, no
    /// source_root and no git. Doctor must report OK, not STALE.
    #[test]
    fn release_install_with_ancestor_operator_and_no_git_is_not_stale() {
        let unit = tempdir().unwrap();
        fs::create_dir_all(unit.path().join("bin")).unwrap();
        fs::write(unit.path().join("bin/pui"), b"binary").unwrap();
        fs::write(unit.path().join(MANIFEST_NAME), b"{}").unwrap();
        fs::write(
            unit.path().join(ANCESTRY_NAME),
            "8e14b49f0c1d\nb5e2b1fbccf0\n",
        )
        .unwrap();
        let exe = unit.path().join("bin/pui");

        let installed = "8e14b49f0c1d2e3f40516273849506a7b8c9d0e1";
        let ancestor_operator = "b5e2b1fbccf0";
        let caught_up = release_generation_contained(&exe, ancestor_operator);
        assert_eq!(caught_up, Some(true));
        let verdict =
            operator_install_freshness(installed, Some(ancestor_operator), "http://op", caught_up)
                .for_origin(InstallOrigin::Release, Some(ancestor_operator));
        assert_eq!(verdict.status.label(), "OK", "{}", verdict.detail);
        assert!(verdict.repair.is_none());

        // An operator the release does not contain is still STALE, and the
        // repair names a release that includes the operator's generation.
        let newer_operator = "c0ffee000000";
        let behind = release_generation_contained(&exe, newer_operator);
        assert_eq!(behind, Some(false));
        let stale =
            operator_install_freshness(installed, Some(newer_operator), "http://op", behind)
                .for_origin(InstallOrigin::Release, Some(newer_operator));
        assert_eq!(stale.status.label(), "STALE");
        let repair = stale.repair.expect("a stale release install has a repair");
        assert!(
            repair.contains("includes the operator's generation c0ffee000000"),
            "{repair}"
        );
        assert!(repair.contains("pui self update"), "{repair}");

        // A unit that predates the listing cannot answer: None keeps STALE.
        fs::remove_file(unit.path().join(ANCESTRY_NAME)).unwrap();
        assert_eq!(release_generation_contained(&exe, ancestor_operator), None);
        // A binary outside any release unit cannot answer either.
        let loose = tempdir().unwrap();
        assert_eq!(
            release_generation_contained(&loose.path().join("bin/pui"), ancestor_operator),
            None
        );
    }
}
