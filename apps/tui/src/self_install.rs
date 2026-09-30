//! `pui self …` — versioned install, update, rollback and uninstall of one PUI
//! release unit (pui-first-party-public-release P-011 / D-016).
//!
//! A release unit is the directory the release packager produces and the desktop
//! sidecar already ships: `bin/pui`, `pui-companion.wasm` and a release-relative
//! `pui-install.json` (the public archive adds `bin/zellij` and its documents).
//! Nothing here needs Cargo, python or a source checkout: the archive's
//! `install.sh` only checks `SHA256SUMS` and runs `bin/pui self install`.
//!
//! Layout under `$PUI_HOME` (default `$XDG_DATA_HOME/pui`, i.e. `~/.local/share/pui`):
//!
//! ```text
//! releases/<version>-<sha12>/   immutable, hash-verified copy of a release unit
//! current  -> releases/<id>     the active release
//! previous -> releases/<id>     the release `rollback` returns to
//! snapshots/<epoch>--<from>--<to>/   PUI-owned user state captured before each switch
//! ```
//!
//! The launcher `$PUI_BIN_DIR/pui` (default `~/.local/bin/pui`) links to
//! `current/bin/pui`; a release that ships psu (D-031) also gets
//! `$PUI_BIN_DIR/psu` → `current/bin/psu`, unless a `psu` PUI did not create
//! already holds that path. User data lives in `~/.papercusp`; install, update and
//! rollback never write it (rollback restores a snapshot only when asked), and
//! uninstall keeps it unless `--purge`.

use crate::install::{self, MANIFEST_NAME};
use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// Per-device user state PUI itself owns under `~/.papercusp`: snapshotted before
/// every activation, removed only by `uninstall --purge`. `operator.json` is
/// deliberately absent — the operator writes it and other clients read it.
pub const PUI_OWNED_STATE: &[&str] = &["pui-state.json"];

/// State under `~/.papercusp` that uninstall reports as kept even with `--purge`.
const SHARED_STATE: &[&str] = &["operator.json"];

/// Entries `$PUI_HOME` may hold. Uninstall refuses to delete a directory holding
/// anything else, so a mistaken `PUI_HOME=$HOME` cannot remove a user's files.
const HOME_ENTRIES: &[&str] = &[
    "releases",
    "current",
    "previous",
    "snapshots",
    "downloads",
    "channel.json",
];

const KEEP_SNAPSHOTS: usize = 5;

const SELF_HELP: &str = "pui self — install, update, roll back or uninstall this PUI

Usage:
  pui self status [--json]
  pui self install --from <release-dir|archive.tar.gz> [--yes] [--dry-run]
  pui self update  --from <release-dir|archive.tar.gz> [--allow-downgrade] [--yes] [--dry-run]
  pui self rollback [--restore-data] [--yes] [--dry-run]
  pui self uninstall [--purge] [--yes] [--dry-run]
  pui self diagnostics      print the redacted support report
  pui self stamp

Every change previews the exact release and paths first and asks for
confirmation (--yes answers it; a non-interactive run without --yes refuses).
Configuration and history in ~/.papercusp are preserved by install, update and
rollback. --restore-data makes rollback also return PUI's own state to the
snapshot taken before the update; --purge makes uninstall also remove it.

Environment:
  PUI_HOME      release store (default $XDG_DATA_HOME/pui or ~/.local/share/pui)
  PUI_BIN_DIR   where the `pui` and `psu` launcher links live (default ~/.local/bin)

A release that ships psu also links $PUI_BIN_DIR/psu, unless a psu PUI did not
create is already there (it is then left untouched).
";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    pub home: PathBuf,
    pub bin_dir: PathBuf,
    pub data_dir: PathBuf,
}

impl Layout {
    pub fn from_env() -> Result<Self> {
        let user_home = dirs::home_dir().context("resolve home directory")?;
        let env_dir = |name: &str| {
            std::env::var_os(name)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        };
        if let Some(home) = env_dir("PUI_HOME").filter(|path| !path.is_absolute()) {
            bail!("PUI_HOME must be an absolute path, not {}", home.display());
        }
        let home = env_dir("PUI_HOME")
            .or_else(|| {
                env_dir("XDG_DATA_HOME")
                    .filter(|path| path.is_absolute())
                    .map(|dir| dir.join("pui"))
            })
            .unwrap_or_else(|| user_home.join(".local").join("share").join("pui"));
        let bin_dir = env_dir("PUI_BIN_DIR")
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| user_home.join(".local").join("bin"));
        Ok(Self {
            home,
            bin_dir,
            data_dir: user_home.join(".papercusp"),
        })
    }

    fn releases(&self) -> PathBuf {
        self.home.join("releases")
    }

    fn current(&self) -> PathBuf {
        self.home.join("current")
    }

    fn previous(&self) -> PathBuf {
        self.home.join("previous")
    }

    fn snapshots(&self) -> PathBuf {
        self.home.join("snapshots")
    }

    pub fn launcher(&self) -> PathBuf {
        self.bin_dir.join("pui")
    }

    fn launcher_target(&self) -> PathBuf {
        self.current().join("bin").join("pui")
    }

    /// `$PUI_BIN_DIR/psu`: the link to the psu a release unit ships (D-031).
    pub fn psu_launcher(&self) -> PathBuf {
        self.bin_dir.join("psu")
    }

    fn psu_launcher_target(&self) -> PathBuf {
        self.current().join("bin").join("psu")
    }
}

/// What activation does with `$PUI_BIN_DIR/psu` (D-031). PUI links the psu its
/// release ships beside `pui`, but never takes over a `psu` it did not create:
/// the desktop app's shim, a developer checkout's launcher or any other file
/// keeps the path, and PUI's own sessions still use the bundled psu because
/// PUI resolves psu beside the running `pui` first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "action")]
pub enum PsuLink {
    /// Create or keep the link to `current/bin/psu`.
    Link { path: PathBuf },
    /// Remove PUI's link: the release being activated ships no psu.
    Remove { path: PathBuf },
    /// Something PUI did not create holds the path; it is left untouched and
    /// PUI's own sessions keep using `bundled`.
    Foreign {
        path: PathBuf,
        holder: String,
        bundled: PathBuf,
    },
    /// No psu in the release and no link of PUI's: nothing to do.
    Untouched,
}

impl PsuLink {
    pub fn preview(&self) -> Option<String> {
        match self {
            PsuLink::Link { path } => Some(format!("psu:      {}", path.display())),
            PsuLink::Remove { path } => Some(format!(
                "remove psu link: {} (this release ships no psu)",
                path.display()
            )),
            PsuLink::Foreign {
                path,
                holder,
                bundled,
            } => Some(format!(
                "psu:      {} is {holder}, not PUI's; left untouched (PUI's own sessions use {})",
                path.display(),
                bundled.display()
            )),
            PsuLink::Untouched => None,
        }
    }
}

/// Who holds `$PUI_BIN_DIR/psu` right now.
enum PsuHolder {
    Absent,
    /// A link into `$PUI_HOME`, or a dangling link: PUI's to replace or remove.
    Pui,
    Foreign(String),
}

fn psu_holder(layout: &Layout) -> PsuHolder {
    let path = layout.psu_launcher();
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => PsuHolder::Absent,
        Err(error) => PsuHolder::Foreign(format!("unreadable ({error})")),
        Ok(meta) if !meta.file_type().is_symlink() => PsuHolder::Foreign(
            if meta.is_dir() {
                "a directory"
            } else {
                "a file"
            }
            .to_string(),
        ),
        Ok(_) => match fs::read_link(&path) {
            Ok(target) if target.starts_with(&layout.home) => PsuHolder::Pui,
            // `metadata` follows the link from its own directory, so a relative
            // target is judged correctly; a dangling link runs nothing.
            Ok(_) if fs::metadata(&path).is_err() => PsuHolder::Pui,
            Ok(target) => PsuHolder::Foreign(format!("a link to {}", target.display())),
            Err(error) => PsuHolder::Foreign(format!("unreadable ({error})")),
        },
    }
}

/// Decide the psu link for activating a release whose root is `release_root`.
fn plan_psu_link(layout: &Layout, release_root: &Path) -> PsuLink {
    let path = layout.psu_launcher();
    let ships_psu = release_root.join("bin").join("psu").is_file();
    match (psu_holder(layout), ships_psu) {
        (PsuHolder::Foreign(holder), true) => PsuLink::Foreign {
            path,
            holder,
            bundled: layout.psu_launcher_target(),
        },
        (PsuHolder::Foreign(_), false) | (PsuHolder::Absent, false) => PsuLink::Untouched,
        (PsuHolder::Pui, false) => PsuLink::Remove { path },
        (PsuHolder::Absent | PsuHolder::Pui, true) => PsuLink::Link { path },
    }
}

/// Apply the psu link for the now-current release. Ownership is re-checked
/// here, so a `psu` that appeared after the preview is still never replaced.
fn ensure_psu_link(layout: &Layout) -> Result<PsuLink> {
    let decided = plan_psu_link(layout, &layout.current());
    match &decided {
        PsuLink::Link { path } => {
            let target = layout.psu_launcher_target();
            if !fs::read_link(path).is_ok_and(|existing| existing == target) {
                fs::create_dir_all(&layout.bin_dir)
                    .with_context(|| format!("create {}", layout.bin_dir.display()))?;
                replace_symlink(path, &target)?;
            }
        }
        PsuLink::Remove { path } => {
            fs::remove_file(path).with_context(|| format!("remove {}", path.display()))?;
        }
        PsuLink::Foreign { .. } | PsuLink::Untouched => {}
    }
    Ok(decided)
}

/// A verified release unit: both artifacts hash to what its manifest records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseUnit {
    pub root: PathBuf,
    pub manifest: install::InstallManifest,
    pub version: String,
}

impl ReleaseUnit {
    pub fn id(&self) -> String {
        release_id(
            &self.version,
            &self.manifest.source_sha,
            self.manifest.source_dirty,
        )
    }
}

pub fn release_id(version: &str, source_sha: &str, dirty: bool) -> String {
    let short: String = source_sha.chars().take(12).collect();
    format!("{version}-{short}{}", if dirty { "-dirty" } else { "" })
}

fn valid_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 64
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+' | '_'))
}

/// The per-unit digest listing the release packager writes: every regular file
/// in the unit except itself, as `<sha256>  <relative path>` lines (the format
/// `sha256sum -c` and `shasum -a 256 -c` read, so `install.sh` can check it too).
pub const CONTENTS_NAME: &str = "CONTENTS.sha256";

fn unit_files(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(dir).with_context(|| format!("read {}", dir.display()))? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            unit_files(root, &entry.path(), out)?;
        } else {
            out.push(entry.path().strip_prefix(root)?.to_path_buf());
        }
    }
    Ok(())
}

/// A unit that carries `CONTENTS.sha256` must match it exactly: no file changed,
/// missing or added. A unit without one (the desktop sidecar's) is verified by
/// its manifest alone.
fn verify_contents(root: &Path) -> Result<()> {
    let listing = root.join(CONTENTS_NAME);
    let Ok(text) = fs::read_to_string(&listing) else {
        return Ok(());
    };
    let mut listed = std::collections::BTreeMap::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let (digest, raw) = line
            .split_once("  ")
            .with_context(|| format!("malformed line in {}: {line:?}", listing.display()))?;
        let path = Path::new(raw);
        if !path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
        {
            bail!("{} lists an unsafe path {raw:?}", listing.display());
        }
        listed.insert(path.to_path_buf(), digest.to_ascii_lowercase());
    }
    let mut present = Vec::new();
    unit_files(root, root, &mut present)?;
    present.retain(|path| path != Path::new(CONTENTS_NAME));
    for path in &present {
        let expected = listed.get(path).with_context(|| {
            format!(
                "{} is not listed in {CONTENTS_NAME}; the release was modified after packaging",
                path.display()
            )
        })?;
        let actual = install::sha256_file(&root.join(path))?;
        if &actual != expected {
            bail!(
                "{} hashes to {actual}, but {CONTENTS_NAME} records {expected}",
                path.display()
            );
        }
    }
    if let Some(missing) = listed.keys().find(|path| !present.contains(path)) {
        bail!(
            "{} is listed in {CONTENTS_NAME} but missing from the release",
            missing.display()
        );
    }
    Ok(())
}

/// Read `<root>/pui-install.json` and verify the unit is relocatable and intact.
pub fn read_release_unit(root: &Path) -> Result<ReleaseUnit> {
    verify_contents(root)?;
    let manifest_path = root.join(MANIFEST_NAME);
    let manifest = install::read_manifest(&manifest_path)?;
    if manifest.binary_path != "bin/pui" {
        bail!(
            "{} names binaryPath {:?}; a relocatable release unit must name \"bin/pui\"",
            manifest_path.display(),
            manifest.binary_path
        );
    }
    if Path::new(&manifest.companion_path).is_absolute() {
        bail!(
            "{} names an absolute companionPath {:?}; a relocatable release unit names it relative to the manifest",
            manifest_path.display(),
            manifest.companion_path
        );
    }
    for (label, raw, expected) in [
        (
            "binaryPath",
            manifest.binary_path.as_str(),
            manifest.binary_sha256.as_str(),
        ),
        (
            "companionPath",
            manifest.companion_path.as_str(),
            manifest.companion_sha256.as_str(),
        ),
    ] {
        let path = install::resolve_manifest_artifact(&manifest_path, raw, label)?;
        let actual = install::sha256_file(&path)?;
        if actual != expected {
            bail!(
                "{label} {} hashes to {actual}, but its manifest records {expected}",
                path.display()
            );
        }
    }
    let version = manifest
        .version
        .clone()
        .filter(|version| valid_version(version))
        .with_context(|| {
            format!(
                "{} has no usable version; this unit was not produced by the release packager",
                manifest_path.display()
            )
        })?;
    Ok(ReleaseUnit {
        root: root.to_path_buf(),
        manifest,
        version,
    })
}

/// The build identity this binary embeds, for `pui self stamp`. Install runs the
/// candidate's own `bin/pui self stamp` and compares it with the manifest, which
/// also proves the binary actually executes on this machine.
pub fn stamp_json() -> Value {
    let build = install::BuildStamp::embedded();
    json!({
        "version": build.version,
        "sourceSha": build.source_sha,
        "sourceDirty": build.source_dirty,
        "builtAtEpoch": build.built_at_epoch,
        "companionSha256": build.companion_sha256,
        "target": install::this_target(),
    })
}

/// Run an executable that was written moments ago (ETXTBSY-tolerant; see
/// `fresh_exec`) rather than refuse a good release over a fork race.
use crate::fresh_exec::output as output_of_fresh_executable;

fn verify_executes_here(unit: &ReleaseUnit) -> Result<()> {
    let here = install::this_target();
    if let Some(target) = unit.manifest.target.as_deref() {
        if target != here {
            bail!("this release was built for {target}; this machine is {here}");
        }
    }
    let binary = unit.root.join("bin").join("pui");
    let output = output_of_fresh_executable(Command::new(&binary).args(["self", "stamp"]))
        .with_context(|| format!("run {} on {here}", binary.display()))?;
    if !output.status.success() {
        bail!(
            "{} self stamp exited with {} on {here}: {}",
            binary.display(),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let stamp: Value = serde_json::from_slice(&output.stdout)
        .with_context(|| format!("decode `{} self stamp` output", binary.display()))?;
    let manifest = &unit.manifest;
    let mut mismatches = Vec::new();
    let mut expect = |field: &str, want: Value| {
        if stamp.get(field) != Some(&want) {
            mismatches.push(format!(
                "{field}: binary embeds {}, manifest records {want}",
                stamp.get(field).cloned().unwrap_or(Value::Null)
            ));
        }
    };
    expect("version", json!(unit.version));
    expect("sourceSha", json!(manifest.source_sha));
    expect("sourceDirty", json!(manifest.source_dirty));
    expect("builtAtEpoch", json!(manifest.built_at_epoch));
    expect("companionSha256", json!(manifest.companion_sha256));
    if !mismatches.is_empty() {
        bail!(
            "the binary's embedded build identity does not match its manifest ({})",
            mismatches.join("; ")
        );
    }
    Ok(())
}

/// Numeric-aware version order: `0.10.0` > `0.9.1`, and a pre-release sorts
/// before its release (`0.2.0-beta.1` < `0.2.0`).
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    fn split(version: &str) -> (Vec<u64>, Option<&str>) {
        let version = version.split('+').next().unwrap_or(version);
        let (core, pre) = match version.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (version, None),
        };
        let numbers = core
            .split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect();
        (numbers, pre)
    }
    let (a_core, a_pre) = split(a);
    let (b_core, b_pre) = split(b);
    let width = a_core.len().max(b_core.len());
    for index in 0..width {
        let order = a_core
            .get(index)
            .unwrap_or(&0)
            .cmp(b_core.get(index).unwrap_or(&0));
        if order != Ordering::Equal {
            return order;
        }
    }
    match (a_pre, b_pre) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(a), Some(b)) => a.cmp(b),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledRelease {
    pub id: String,
    pub version: Option<String>,
    pub path: PathBuf,
    pub problem: Option<String>,
}

fn installed(layout: &Layout, link: &Path) -> Option<InstalledRelease> {
    let target = fs::read_link(link).ok()?;
    let id = target.file_name()?.to_string_lossy().into_owned();
    let path = layout.releases().join(&id);
    Some(match read_release_unit(&path) {
        Ok(unit) => InstalledRelease {
            id,
            version: Some(unit.version),
            path,
            problem: None,
        },
        Err(error) => InstalledRelease {
            id,
            version: None,
            path,
            problem: Some(format!("{error:#}")),
        },
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub home: PathBuf,
    pub launcher: PathBuf,
    pub launcher_target: Option<PathBuf>,
    pub psu_launcher: PathBuf,
    pub psu_launcher_target: Option<PathBuf>,
    pub current: Option<InstalledRelease>,
    pub previous: Option<InstalledRelease>,
    pub path_resolves_to: Option<PathBuf>,
    pub notes: Vec<String>,
}

fn first_on_path(name: &str, path_var: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    std::env::split_paths(path_var?)
        .map(|dir| dir.join(name))
        .find(|candidate| {
            fs::metadata(candidate)
                .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        })
}

pub fn status(layout: &Layout, path_var: Option<&std::ffi::OsStr>) -> Status {
    let launcher = layout.launcher();
    let launcher_target = fs::read_link(&launcher).ok();
    let current = installed(layout, &layout.current());
    let previous = installed(layout, &layout.previous());
    let path_resolves_to = first_on_path("pui", path_var);
    let mut notes = Vec::new();
    if current.is_some() {
        let on_path = path_var
            .map(|value| std::env::split_paths(value).any(|dir| dir == layout.bin_dir))
            .unwrap_or(false);
        if !on_path {
            notes.push(format!(
                "{} is not on PATH; add it so `pui` runs the installed release",
                layout.bin_dir.display()
            ));
        } else if let Some(resolved) = &path_resolves_to {
            let canonical = |path: &Path| fs::canonicalize(path).ok();
            if canonical(resolved) != canonical(&launcher) {
                notes.push(format!(
                    "`pui` on PATH resolves to {}, which shadows the installed launcher {}; remove it or put {} earlier on PATH",
                    resolved.display(),
                    launcher.display(),
                    layout.bin_dir.display()
                ));
            }
        }
    }
    if current.is_some() {
        if let PsuLink::Foreign {
            path,
            holder,
            bundled,
        } = plan_psu_link(layout, &layout.current())
        {
            notes.push(format!(
                "{} is {holder}, not PUI's, so it was left in place; PUI's own sessions use its bundled psu ({})",
                path.display(),
                bundled.display()
            ));
        }
    }
    let legacy_manifest = layout.data_dir.join(MANIFEST_NAME);
    if legacy_manifest.is_file() {
        notes.push(format!(
            "a developer install (install-update.sh) is also present ({}); `pui self` leaves it untouched",
            legacy_manifest.display()
        ));
    }
    Status {
        home: layout.home.clone(),
        launcher,
        launcher_target,
        psu_launcher: layout.psu_launcher(),
        psu_launcher_target: fs::read_link(layout.psu_launcher()).ok(),
        current,
        previous,
        path_resolves_to,
        notes,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivationKind {
    Install,
    Update { allow_downgrade: bool },
}

/// Exactly what an install/update/rollback will do, shown before it happens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationPlan {
    pub action: String,
    pub from: Option<String>,
    pub from_version: Option<String>,
    pub to: String,
    pub to_version: String,
    pub release_dir: PathBuf,
    pub launcher: PathBuf,
    pub psu: PsuLink,
    pub preserved_state: Vec<PathBuf>,
}

impl ActivationPlan {
    pub fn preview(&self) -> Vec<String> {
        let mut lines = vec![match (&self.from, &self.from_version) {
            (Some(from), version) if from != &self.to => format!(
                "{}: {} ({}) → {} ({})",
                self.action,
                from,
                version.as_deref().unwrap_or("unknown version"),
                self.to,
                self.to_version
            ),
            _ => format!("{}: {} ({})", self.action, self.to, self.to_version),
        }];
        lines.push(format!("release:  {}", self.release_dir.display()));
        lines.push(format!("launcher: {}", self.launcher.display()));
        lines.extend(self.psu.preview());
        if self.preserved_state.is_empty() {
            lines.push("user data: none present; nothing to preserve".to_string());
        }
        for path in &self.preserved_state {
            lines.push(format!("preserved: {}", path.display()));
        }
        lines
    }
}

fn existing_owned_state(layout: &Layout) -> Vec<PathBuf> {
    PUI_OWNED_STATE
        .iter()
        .chain(SHARED_STATE)
        .map(|name| layout.data_dir.join(name))
        .filter(|path| path.exists())
        .collect()
}

pub fn plan_activation(
    layout: &Layout,
    unit: &ReleaseUnit,
    kind: ActivationKind,
) -> Result<ActivationPlan> {
    let current = installed(layout, &layout.current());
    let to = unit.id();
    let action = match (&current, kind) {
        (None, ActivationKind::Update { .. }) => {
            bail!("nothing is installed yet; run `pui self install --from …` first")
        }
        (None, ActivationKind::Install) => "install",
        (Some(current), _) if current.id == to => "reinstall",
        (Some(current), kind) => {
            let allow_downgrade = matches!(
                kind,
                ActivationKind::Update {
                    allow_downgrade: true
                }
            );
            if let Some(installed_version) = current.version.as_deref() {
                if compare_versions(&unit.version, installed_version) == Ordering::Less
                    && !allow_downgrade
                {
                    bail!(
                        "{} is older than the installed {}; use `pui self rollback` to return to the previous release, or pass --allow-downgrade",
                        unit.version,
                        installed_version
                    );
                }
            }
            "update"
        }
    };
    Ok(ActivationPlan {
        action: action.to_string(),
        from: current.as_ref().map(|release| release.id.clone()),
        from_version: current.and_then(|release| release.version),
        to_version: unit.version.clone(),
        release_dir: layout.releases().join(&to),
        to,
        launcher: layout.launcher(),
        psu: plan_psu_link(layout, &unit.root),
        preserved_state: existing_owned_state(layout),
    })
}

/// Verify `unit` runs here, copy it into the release store, snapshot user
/// state, then switch `current` (keeping the old one as `previous`).
pub fn apply_activation(layout: &Layout, unit: &ReleaseUnit, plan: &ActivationPlan) -> Result<()> {
    verify_executes_here(unit)?;
    check_launcher(layout)?;
    fs::create_dir_all(layout.releases())
        .with_context(|| format!("create {}", layout.releases().display()))?;
    stage_release(layout, unit)?;
    if let Some(from) = plan.from.as_deref().filter(|from| *from != plan.to) {
        snapshot_user_state(layout, from, &plan.to)?;
        replace_symlink(&layout.previous(), &Path::new("releases").join(from))?;
    }
    replace_symlink(&layout.current(), &Path::new("releases").join(&plan.to))?;
    ensure_launcher(layout)?;
    ensure_psu_link(layout)?;
    prune_releases(layout)?;
    Ok(())
}

fn stage_release(layout: &Layout, unit: &ReleaseUnit) -> Result<PathBuf> {
    let dest = layout.releases().join(unit.id());
    if dest.exists() {
        match read_release_unit(&dest) {
            Ok(existing) if existing.manifest == unit.manifest => return Ok(dest),
            _ => {
                // A damaged or foreign copy under the same id is replaced, never trusted.
                fs::remove_dir_all(&dest)
                    .with_context(|| format!("remove damaged release {}", dest.display()))?;
            }
        }
    }
    let staging = layout
        .releases()
        .join(format!(".{}.staging-{}", unit.id(), std::process::id()));
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    copy_tree(&unit.root, &staging)?;
    read_release_unit(&staging).context("verify the copied release")?;
    fs::rename(&staging, &dest)
        .with_context(|| format!("move staged release into {}", dest.display()))?;
    Ok(dest)
}

fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to).with_context(|| format!("create {}", to.display()))?;
    for entry in fs::read_dir(from).with_context(|| format!("read {}", from.display()))? {
        let entry = entry?;
        let source = entry.path();
        let dest = to.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            bail!(
                "release units must not contain symlinks ({})",
                source.display()
            );
        } else if kind.is_dir() {
            copy_tree(&source, &dest)?;
        } else {
            fs::copy(&source, &dest)
                .with_context(|| format!("copy {} → {}", source.display(), dest.display()))?;
        }
    }
    Ok(())
}

fn replace_symlink(link: &Path, target: &Path) -> Result<()> {
    let name = link
        .file_name()
        .context("link path has no file name")?
        .to_string_lossy();
    let temporary = link.with_file_name(format!(".{name}.tmp-{}", std::process::id()));
    let _ = fs::remove_file(&temporary);
    std::os::unix::fs::symlink(target, &temporary)
        .with_context(|| format!("create link {}", temporary.display()))?;
    fs::rename(&temporary, link).with_context(|| format!("replace link {}", link.display()))
}

/// Refuse, before anything changes, a launcher path held by something PUI did
/// not create: a regular file, or a live link to a binary outside `$PUI_HOME`.
/// A dangling link is treated as ours to replace.
fn check_launcher(layout: &Layout) -> Result<()> {
    let launcher = layout.launcher();
    match fs::symlink_metadata(&launcher) {
        Ok(meta) if !meta.file_type().is_symlink() => bail!(
            "{} exists and is not a PUI launcher link; move it aside or set PUI_BIN_DIR",
            launcher.display()
        ),
        Ok(_) => {
            let existing = fs::read_link(&launcher)?;
            if !existing.starts_with(&layout.home) && existing.exists() {
                bail!(
                    "{} links to {}, which is not a PUI release; move it aside or set PUI_BIN_DIR",
                    launcher.display(),
                    existing.display()
                );
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn ensure_launcher(layout: &Layout) -> Result<()> {
    check_launcher(layout)?;
    fs::create_dir_all(&layout.bin_dir)
        .with_context(|| format!("create {}", layout.bin_dir.display()))?;
    let launcher = layout.launcher();
    let target = layout.launcher_target();
    if fs::read_link(&launcher).is_ok_and(|existing| existing == target) {
        return Ok(());
    }
    replace_symlink(&launcher, &target)
}

/// Keep `current` and `previous`; every other release directory is removed.
fn prune_releases(layout: &Layout) -> Result<()> {
    let keep: Vec<String> = [layout.current(), layout.previous()]
        .iter()
        .filter_map(|link| fs::read_link(link).ok())
        .filter_map(|target| {
            target
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .collect();
    for entry in fs::read_dir(layout.releases())? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || keep.contains(&name) {
            continue;
        }
        fs::remove_dir_all(entry.path())
            .with_context(|| format!("prune {}", entry.path().display()))?;
    }
    Ok(())
}

fn epoch_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn snapshot_user_state(layout: &Layout, from: &str, to: &str) -> Result<PathBuf> {
    let files: Vec<&str> = PUI_OWNED_STATE
        .iter()
        .copied()
        .filter(|name| layout.data_dir.join(name).is_file())
        .collect();
    let taken_at = epoch_now();
    let mut dir = layout
        .snapshots()
        .join(format!("{taken_at:012}--{from}--{to}"));
    let mut suffix = 1;
    while dir.exists() {
        dir = layout
            .snapshots()
            .join(format!("{taken_at:012}--{from}--{to}.{suffix}"));
        suffix += 1;
    }
    fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    for name in &files {
        fs::copy(layout.data_dir.join(name), dir.join(name))
            .with_context(|| format!("snapshot {name}"))?;
    }
    let record = json!({
        "schemaVersion": 1,
        "from": from,
        "to": to,
        "takenAtEpoch": taken_at,
        "files": files,
    });
    fs::write(
        dir.join("snapshot.json"),
        serde_json::to_vec_pretty(&record)?,
    )?;
    prune_snapshots(layout)?;
    Ok(dir)
}

fn snapshot_dirs(layout: &Layout) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = fs::read_dir(layout.snapshots())
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.join("snapshot.json").is_file())
                .collect()
        })
        .unwrap_or_default();
    dirs.sort();
    dirs
}

fn prune_snapshots(layout: &Layout) -> Result<()> {
    let dirs = snapshot_dirs(layout);
    if dirs.len() > KEEP_SNAPSHOTS {
        for dir in &dirs[..dirs.len() - KEEP_SNAPSHOTS] {
            fs::remove_dir_all(dir).with_context(|| format!("prune {}", dir.display()))?;
        }
    }
    Ok(())
}

/// The newest snapshot recorded for the `from → to` switch.
fn find_snapshot(layout: &Layout, from: &str, to: &str) -> Option<(PathBuf, Vec<String>)> {
    snapshot_dirs(layout).into_iter().rev().find_map(|dir| {
        let record: Value =
            serde_json::from_slice(&fs::read(dir.join("snapshot.json")).ok()?).ok()?;
        (record.get("from")?.as_str()? == from && record.get("to")?.as_str()? == to).then(|| {
            let files = record
                .get("files")
                .and_then(Value::as_array)
                .map(|files| {
                    files
                        .iter()
                        .filter_map(|file| file.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            (dir, files)
        })
    })
}

pub fn plan_rollback(layout: &Layout) -> Result<ActivationPlan> {
    let previous = installed(layout, &layout.previous())
        .ok_or_else(|| anyhow!("there is no previous release to roll back to"))?;
    if let Some(problem) = &previous.problem {
        bail!(
            "the previous release {} failed verification: {problem}",
            previous.id
        );
    }
    let current = installed(layout, &layout.current());
    Ok(ActivationPlan {
        action: "rollback".to_string(),
        from: current.as_ref().map(|release| release.id.clone()),
        from_version: current.and_then(|release| release.version),
        to: previous.id.clone(),
        to_version: previous.version.clone().unwrap_or_default(),
        psu: plan_psu_link(layout, &previous.path),
        release_dir: previous.path,
        launcher: layout.launcher(),
        preserved_state: existing_owned_state(layout),
    })
}

/// Swap `current` and `previous`. With `restore_data`, PUI's own state is also
/// returned to the snapshot taken when the rolled-back update happened; the
/// state being replaced is itself snapshotted first, so nothing is lost.
/// Returns the snapshot restored from, if any.
pub fn apply_rollback(
    layout: &Layout,
    plan: &ActivationPlan,
    restore_data: bool,
) -> Result<Option<PathBuf>> {
    let unit = read_release_unit(&plan.release_dir)?;
    verify_executes_here(&unit)?;
    check_launcher(layout)?;
    let from = plan.from.clone();
    let restore_from = match (&from, restore_data) {
        (Some(from), true) => Some(find_snapshot(layout, &plan.to, from).ok_or_else(|| {
            anyhow!(
                "no snapshot of PUI state was recorded for the {} → {from} update; roll back without --restore-data",
                plan.to
            )
        })?),
        _ => None,
    };
    if let Some(from) = &from {
        snapshot_user_state(layout, from, &plan.to)?;
    }
    let restored = match restore_from {
        Some((dir, files)) => {
            fs::create_dir_all(&layout.data_dir)?;
            for name in PUI_OWNED_STATE {
                let live = layout.data_dir.join(name);
                if files.iter().any(|file| file == name) {
                    fs::copy(dir.join(name), &live).with_context(|| format!("restore {name}"))?;
                } else if live.exists() {
                    fs::remove_file(&live).with_context(|| format!("restore {name}"))?;
                }
            }
            Some(dir)
        }
        None => None,
    };
    if let Some(from) = &from {
        replace_symlink(&layout.previous(), &Path::new("releases").join(from))?;
    }
    replace_symlink(&layout.current(), &Path::new("releases").join(&plan.to))?;
    ensure_launcher(layout)?;
    ensure_psu_link(layout)?;
    Ok(restored)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallPlan {
    pub home: PathBuf,
    pub launcher: Option<PathBuf>,
    /// PUI's `psu` link, when PUI created it; a foreign `psu` is never listed.
    pub psu_launcher: Option<PathBuf>,
    pub removed_state: Vec<PathBuf>,
    pub kept_state: Vec<PathBuf>,
}

impl UninstallPlan {
    pub fn preview(&self) -> Vec<String> {
        let mut lines = vec![format!("remove releases: {}", self.home.display())];
        if let Some(launcher) = &self.launcher {
            lines.push(format!("remove launcher: {}", launcher.display()));
        }
        if let Some(psu) = &self.psu_launcher {
            lines.push(format!("remove psu link: {}", psu.display()));
        }
        for path in &self.removed_state {
            lines.push(format!("remove (--purge): {}", path.display()));
        }
        for path in &self.kept_state {
            lines.push(format!("keep: {}", path.display()));
        }
        lines
    }
}

pub fn plan_uninstall(layout: &Layout, purge: bool) -> Result<UninstallPlan> {
    if layout.home.exists() {
        let foreign: Vec<String> = fs::read_dir(&layout.home)?
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| {
                !HOME_ENTRIES.contains(&name.as_str())
                    && !(name.starts_with('.') && name.contains(".tmp-"))
            })
            .collect();
        if !foreign.is_empty() {
            bail!(
                "{} holds entries PUI did not create ({}); refusing to delete it",
                layout.home.display(),
                foreign.join(", ")
            );
        }
    }
    let launcher = fs::read_link(layout.launcher())
        .ok()
        .filter(|target| target.starts_with(&layout.home))
        .map(|_| layout.launcher());
    // Only a link into `$PUI_HOME` is PUI's: a dangling link to elsewhere is
    // left for its owner, since uninstall has nothing of its own to remove there.
    let psu_launcher = fs::read_link(layout.psu_launcher())
        .ok()
        .filter(|target| target.starts_with(&layout.home))
        .map(|_| layout.psu_launcher());
    if !layout.home.exists() && launcher.is_none() && psu_launcher.is_none() {
        bail!(
            "PUI is not installed from a release here ({} does not exist); nothing to uninstall",
            layout.home.display()
        );
    }
    let owned: Vec<PathBuf> = PUI_OWNED_STATE
        .iter()
        .map(|name| layout.data_dir.join(name))
        .filter(|path| path.exists())
        .collect();
    let shared = SHARED_STATE
        .iter()
        .map(|name| layout.data_dir.join(name))
        .filter(|path| path.exists());
    let (removed_state, mut kept_state) = if purge {
        (owned, Vec::new())
    } else {
        (Vec::new(), owned)
    };
    kept_state.extend(shared);
    Ok(UninstallPlan {
        home: layout.home.clone(),
        launcher,
        psu_launcher,
        removed_state,
        kept_state,
    })
}

pub fn apply_uninstall(layout: &Layout, plan: &UninstallPlan) -> Result<()> {
    for link in plan.launcher.iter().chain(&plan.psu_launcher) {
        // Re-check at apply time: only a link still pointing into PUI's home goes.
        if fs::read_link(link).is_ok_and(|target| target.starts_with(&layout.home)) {
            fs::remove_file(link).with_context(|| format!("remove {}", link.display()))?;
        }
    }
    if layout.home.exists() {
        fs::remove_dir_all(&layout.home)
            .with_context(|| format!("remove {}", layout.home.display()))?;
    }
    for path in &plan.removed_state {
        fs::remove_file(path).with_context(|| format!("remove {}", path.display()))?;
    }
    Ok(())
}

/// A release source opened for installation; an unpacked archive (and a
/// downloaded one) is removed on drop.
pub struct OpenedSource {
    pub root: PathBuf,
    pub digest: Option<String>,
    cleanup: Vec<PathBuf>,
}

impl Drop for OpenedSource {
    fn drop(&mut self) {
        for path in &self.cleanup {
            if path.is_dir() {
                let _ = fs::remove_dir_all(path);
            } else {
                let _ = fs::remove_file(path);
            }
        }
    }
}

/// The digest `SHA256SUMS` or `<archive>.sha256` beside `archive` records for
/// it, if either lists it.
fn published_digest(archive: &Path) -> Result<Option<String>> {
    let name = archive
        .file_name()
        .context("archive path has no file name")?
        .to_string_lossy()
        .into_owned();
    let dir = archive.parent().unwrap_or(Path::new("."));
    for listing in [dir.join("SHA256SUMS"), dir.join(format!("{name}.sha256"))] {
        let Ok(text) = fs::read_to_string(&listing) else {
            continue;
        };
        for line in text.lines() {
            let mut fields = line.split_whitespace();
            let (Some(digest), listed) = (fields.next(), fields.next()) else {
                continue;
            };
            let listed = listed.map(|value| value.trim_start_matches('*'));
            if listed.is_none() || listed == Some(name.as_str()) {
                return Ok(Some(digest.to_ascii_lowercase()));
            }
        }
    }
    Ok(None)
}

pub fn open_source(
    layout: &Layout,
    from: &Path,
    expected_sha256: Option<&str>,
) -> Result<OpenedSource> {
    if from.is_dir() {
        if !from.join(MANIFEST_NAME).is_file() {
            bail!(
                "{} is not a PUI release unit (it has no {MANIFEST_NAME})",
                from.display()
            );
        }
        return Ok(OpenedSource {
            root: from.to_path_buf(),
            digest: None,
            cleanup: Vec::new(),
        });
    }
    let name = from.to_string_lossy();
    if !(name.ends_with(".tar.gz") || name.ends_with(".tgz")) {
        bail!(
            "unsupported release source {}; pass an unpacked release directory or a .tar.gz archive",
            from.display()
        );
    }
    let actual = install::sha256_file(from)?;
    let expected = match expected_sha256 {
        Some(expected) => Some(expected.to_ascii_lowercase()),
        None => published_digest(from)?,
    };
    if let Some(expected) = &expected {
        if expected != &actual {
            bail!(
                "{} hashes to {actual}, but its published digest is {expected}; refusing a corrupted or substituted archive",
                from.display()
            );
        }
    }
    let unpack = layout.home.join("downloads").join(format!(
        "unpack-{}-{}",
        std::process::id(),
        epoch_now()
    ));
    fs::create_dir_all(&unpack).with_context(|| format!("create {}", unpack.display()))?;
    // Constructed before unpacking so every early return below removes the dir.
    let mut opened = OpenedSource {
        root: unpack.clone(),
        digest: expected.map(|_| actual),
        cleanup: vec![unpack.clone()],
    };
    let output = Command::new("tar")
        .arg("-xzf")
        .arg(from)
        .arg("-C")
        .arg(&unpack)
        .output()
        .context("run tar to unpack the release archive")?;
    if !output.status.success() {
        bail!(
            "tar could not unpack {}: {}",
            from.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let roots: Vec<PathBuf> = fs::read_dir(&unpack)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.join(MANIFEST_NAME).is_file())
        .collect();
    match roots.as_slice() {
        [root] => {
            opened.root = root.clone();
            Ok(opened)
        }
        _ => bail!(
            "{} does not contain exactly one release unit directory",
            from.display()
        ),
    }
}

// ── the command palette's lifecycle actions ─────────────────────────────────
// PUBLIC_RELEASE_UX.md "Files, installation, and support": About, Check for
// updates, Update, Roll back, Diagnostics and Uninstall. Every change is
// previewed first and comes back ARMED; only an explicit `y` applies it.

/// A palette lifecycle action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LifecycleOp {
    About,
    CheckUpdates,
    /// Install `from` (a release directory, a `.tar.gz`, or an `https://` URL
    /// from the update channel) over the current release. A download must carry
    /// the channel's digest.
    Update {
        from: String,
        sha256: Option<String>,
    },
    Rollback,
    Uninstall {
        purge: bool,
    },
    Diagnostics,
}

impl LifecycleOp {
    pub fn title(&self) -> &'static str {
        match self {
            LifecycleOp::About => "About PUI",
            LifecycleOp::CheckUpdates => "Check for updates",
            LifecycleOp::Update { .. } => "Update PUI",
            LifecycleOp::Rollback => "Roll back PUI",
            LifecycleOp::Uninstall { .. } => "Uninstall PUI",
            LifecycleOp::Diagnostics => "Diagnostics",
        }
    }

    fn confirm_hint(&self) -> &'static str {
        match self {
            LifecycleOp::Diagnostics => "y saves this report to a file · Esc closes",
            LifecycleOp::CheckUpdates | LifecycleOp::Update { .. } => {
                "y installs it · Esc cancels (nothing changes)"
            }
            LifecycleOp::Rollback => "y rolls back · Esc cancels (nothing changes)",
            LifecycleOp::Uninstall { .. } => "y uninstalls · Esc cancels (nothing changes)",
            LifecycleOp::About => "Esc closes",
        }
    }
}

/// What the palette panel shows. `armed` is the change `y` applies; read-only
/// views and results carry none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LifecycleView {
    pub title: String,
    pub lines: Vec<String>,
    pub armed: Option<LifecycleOp>,
}

/// The running session's facts the lifecycle views report.
#[derive(Debug, Clone)]
pub struct LifecycleContext {
    pub endpoint: String,
    pub exe: Option<PathBuf>,
    pub path_var: Option<std::ffi::OsString>,
    pub env: Vec<(String, String)>,
}

impl LifecycleContext {
    pub fn current(endpoint: String) -> Self {
        Self {
            endpoint,
            exe: std::env::current_exe().ok(),
            path_var: std::env::var_os("PATH"),
            env: std::env::vars().collect(),
        }
    }
}

const RESTART_NOTE: &str =
    "This session keeps running the release it started with; quit and run `pui` to use the new one.";

fn is_url(value: &str) -> bool {
    value.starts_with("https://") || value.starts_with("http://")
}

fn short_sha(sha: &str) -> &str {
    sha.get(..12).unwrap_or(sha)
}

/// Strip credentials and query strings from a URL-shaped value; other values
/// pass through unchanged.
pub fn redact_url(value: &str) -> String {
    let Some((scheme, rest)) = value.split_once("://") else {
        return value.to_string();
    };
    let (before_query, query) = match rest.find(['?', '#']) {
        Some(index) => (&rest[..index], true),
        None => (rest, false),
    };
    let (authority, path) = match before_query.find('/') {
        Some(index) => (&before_query[..index], &before_query[index..]),
        None => (before_query, ""),
    };
    let (userinfo, host) = match authority.rsplit_once('@') {
        Some((_, host)) => ("[redacted]@", host),
        None => ("", authority),
    };
    format!(
        "{scheme}://{userinfo}{host}{path}{}",
        if query { "?[redacted]" } else { "" }
    )
}

/// An environment value as a support export may show it. Credentials are
/// redacted by name; beyond that only variables known to hold plain
/// configuration (a path, URL, id or flag) show a value. Everything else —
/// the unsent draft a reconnect carries in `PUI_SETUP_DRAFT`, a command line,
/// a variable this build does not know — reports only that it is set, so
/// conversation text cannot reach an export under a name nobody thought to deny.
pub fn redact_env(name: &str, value: &str) -> String {
    let upper = name.to_ascii_uppercase();
    const SENSITIVE: &[&str] = &[
        "TOKEN",
        "SECRET",
        "KEY",
        "PASSWORD",
        "PASSWD",
        "AUTH",
        "COOKIE",
        "CREDENTIAL",
        "SESSION",
    ];
    const CONFIGURATION: &[&str] = &[
        "PUI_HOME",
        "PUI_BIN_DIR",
        "PUI_INSTALL_MANIFEST",
        "PUI_COMPANION_WASM",
        "PUI_UPDATE_CHANNEL",
        "PUI_OPERATOR",
        "PUI_FLEET",
        "PUI_SEAT",
        "PUI_NOTIFY",
        "PUI_DUMP",
        "PUI_LIVE_AUDIO",
        "PUI_VOICE_INPUT",
        "PUI_VOICE_OUTPUT",
        "PUI_BUILD_SHA",
        "PUI_BUILD_EPOCH",
        "PUI_BUILD_DIRTY",
        "PUI_CENSUS_UPDATE",
        "PAPERCUSP_OPERATOR_URL",
        "PAPERCUSP_HONO_PORT",
        "PAPERCUSP_HARNESS_SLUG",
        "PAPERCUSP_SID",
        "PAPERCUSP_AGENT",
        "PAPERCUSP_TUI_OWNER",
        "ZELLIJ",
        "ZELLIJ_PANE_ID",
        "ZELLIJ_CONFIG_DIR",
    ];
    if SENSITIVE.iter().any(|marker| upper.contains(marker)) {
        "[redacted]".to_string()
    } else if CONFIGURATION.contains(&name) {
        redact_url(value)
    } else {
        "[set, value withheld]".to_string()
    }
}

/// Where the update channel manifest lives: `PUI_UPDATE_CHANNEL`, else
/// `$PUI_HOME/channel.json` (`{"url": …}`). `None` = no channel configured.
fn channel_location(layout: &Layout, env: &[(String, String)]) -> Option<String> {
    if let Some((_, value)) = env
        .iter()
        .find(|(name, value)| name == "PUI_UPDATE_CHANNEL" && !value.trim().is_empty())
    {
        return Some(value.trim().to_string());
    }
    let config: Value =
        serde_json::from_slice(&fs::read(layout.home.join("channel.json")).ok()?).ok()?;
    config
        .get("url")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Download `url` to `dest` over https only. `max_secs` bounds the whole
/// transfer: short for the channel manifest (the panel is busy meanwhile),
/// long for a release archive.
fn fetch(url: &str, dest: &Path, max_secs: u32) -> Result<()> {
    if !url.starts_with("https://") {
        bail!("refusing to download {url}: update channels and releases must use https");
    }
    let output = Command::new("curl")
        .args([
            "-fsSL",
            "--proto",
            "=https",
            "--max-time",
            &max_secs.to_string(),
            "-o",
        ])
        .arg(dest)
        .arg(url)
        .output()
        .context("run curl to download from the update channel")?;
    if !output.status.success() {
        bail!(
            "download of {url} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

fn resolve_against(base: &str, reference: &str) -> String {
    if is_url(reference) || Path::new(reference).is_absolute() {
        return reference.to_string();
    }
    match base.rfind('/') {
        Some(index) => format!("{}/{reference}", &base[..index]),
        None => reference.to_string(),
    }
}

/// The newest release in the channel that ships this target, if newer than
/// `installed`. Returns `(version, artifact location, sha256)`.
pub fn newest_in_channel(
    channel: &Value,
    location: &str,
    target: &str,
    installed: &str,
) -> Result<Option<(String, String, String)>> {
    if channel.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        bail!("the update channel at {location} is not a schemaVersion 1 PUI channel");
    }
    let mut newest: Option<(String, String, String)> = None;
    for release in channel
        .get("releases")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        let (Some(version), Some(artifact)) = (
            release.get("version").and_then(Value::as_str),
            release
                .get("artifacts")
                .and_then(|artifacts| artifacts.get(target)),
        ) else {
            continue;
        };
        let (Some(url), Some(sha256)) = (
            artifact.get("url").and_then(Value::as_str),
            artifact.get("sha256").and_then(Value::as_str),
        ) else {
            bail!("the channel's {version} {target} artifact has no url or sha256");
        };
        if newest
            .as_ref()
            .is_none_or(|(best, _, _)| compare_versions(version, best) == Ordering::Greater)
        {
            newest = Some((
                version.to_string(),
                resolve_against(location, url),
                sha256.to_ascii_lowercase(),
            ));
        }
    }
    Ok(newest.filter(|(version, _, _)| compare_versions(version, installed) == Ordering::Greater))
}

fn installed_version(layout: &Layout) -> String {
    installed(layout, &layout.current())
        .and_then(|release| release.version)
        .unwrap_or_else(|| install::BUILD_VERSION.to_string())
}

fn check_for_updates(
    layout: &Layout,
    ctx: &LifecycleContext,
) -> Result<(Vec<String>, Option<LifecycleOp>)> {
    let installed = installed_version(layout);
    let Some(location) = channel_location(layout, &ctx.env) else {
        return Ok((
            vec![
                format!("Installed: PUI {installed}."),
                "No update channel is configured, so PUI cannot check for updates by itself.".into(),
                "To update from a downloaded release: :update <path to pui-<version>-<target>.tar.gz>".into(),
            ],
            None,
        ));
    };
    let text = if is_url(&location) {
        let dest = layout
            .home
            .join("downloads")
            .join(format!("channel-{}.json", std::process::id()));
        fs::create_dir_all(dest.parent().expect("downloads dir has a parent"))?;
        fetch(&location, &dest, 30)?;
        let text = fs::read_to_string(&dest);
        let _ = fs::remove_file(&dest);
        text?
    } else {
        fs::read_to_string(&location).with_context(|| format!("read update channel {location}"))?
    };
    let channel: Value = serde_json::from_str(&text).context("decode the update channel")?;
    match newest_in_channel(&channel, &location, &install::this_target(), &installed)? {
        Some((version, url, sha256)) => Ok((
            vec![
                format!("PUI {version} is available (installed: {installed})."),
                format!("release: {}", redact_url(&url)),
                format!("sha256:  {sha256}"),
                "The download is checked against this digest before anything is installed.".into(),
            ],
            Some(LifecycleOp::Update {
                from: url,
                sha256: Some(sha256),
            }),
        )),
        None => Ok((
            vec![
                format!("PUI {installed} is up to date."),
                format!("channel: {}", redact_url(&location)),
            ],
            None,
        )),
    }
}

/// Open an update source; a URL is downloaded into the release store first and
/// must match `sha256`.
fn open_update_source(layout: &Layout, from: &str, sha256: Option<&str>) -> Result<OpenedSource> {
    if !is_url(from) {
        return open_source(layout, Path::new(from), sha256);
    }
    let digest = sha256
        .context("a download needs the channel's sha256; refusing an unverifiable release")?;
    let name = from
        .rsplit('/')
        .next()
        .filter(|name| name.ends_with(".tar.gz") || name.ends_with(".tgz"))
        .with_context(|| format!("{from} does not name a .tar.gz release archive"))?;
    let downloads = layout.home.join("downloads");
    fs::create_dir_all(&downloads)?;
    let dest = downloads.join(format!("{}-{name}", std::process::id()));
    fetch(from, &dest, 600)?;
    match open_source(layout, &dest, Some(digest)) {
        Ok(mut source) => {
            source.cleanup.push(dest);
            Ok(source)
        }
        Err(error) => {
            let _ = fs::remove_file(&dest);
            Err(error)
        }
    }
}

fn about_lines(layout: &Layout, ctx: &LifecycleContext) -> Vec<String> {
    let build = install::BuildStamp::embedded();
    let mut lines = vec![format!(
        "PUI {} · source {}{} · {}",
        build.version,
        short_sha(&build.source_sha),
        if build.source_dirty == Some(true) {
            " (dirty)"
        } else {
            ""
        },
        install::this_target()
    )];
    let running = ctx.exe.as_deref();
    match running.map(install::install_origin_of) {
        Some(install::InstallOrigin::Release) => {
            let status = status(layout, ctx.path_var.as_deref());
            if let Some(root) = running.and_then(install::release_root_of) {
                lines.push(format!("running release: {}", root.display()));
            }
            match &status.current {
                Some(current) => lines.push(format!(
                    "installed: {} ({})",
                    current.id,
                    current.problem.as_deref().unwrap_or("verified")
                )),
                None => lines.push("installed: no current release in the store".into()),
            }
            if let Some(previous) = &status.previous {
                lines.push(format!("rollback target: {}", previous.id));
            }
            lines.push(format!("release store: {}", status.home.display()));
        }
        _ => lines.push(format!(
            "installed from a source checkout ({}); `pui self` manages release installs only",
            running
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "unknown path".into())
        )),
    }
    lines.push(format!(
        "update channel: {}",
        channel_location(layout, &ctx.env)
            .map(|location| redact_url(&location))
            .unwrap_or_else(|| "none configured".into())
    ));
    lines.push(format!("operator endpoint: {}", redact_url(&ctx.endpoint)));
    lines
}

/// A support report with no conversation content, prompts or credentials.
pub fn diagnostics_report(layout: &Layout, ctx: &LifecycleContext) -> Vec<String> {
    let mut lines = vec![
        "PUI diagnostics (redacted: no conversation content, prompts, tokens or credentials)"
            .to_string(),
    ];
    lines.extend(about_lines(layout, ctx));
    let status = status(layout, ctx.path_var.as_deref());
    for note in &status.notes {
        lines.push(format!("note: {note}"));
    }
    match install::inspect_local_install() {
        Ok(check) => {
            lines.push(format!(
                "local install: {} (manifest {})",
                if check.is_ok() { "OK" } else { "STALE" },
                check.manifest_path.display()
            ));
            lines.extend(
                check
                    .problems
                    .iter()
                    .map(|problem| format!("problem: {problem}")),
            );
            lines.extend(
                check
                    .warnings
                    .iter()
                    .map(|warning| format!("warning: {warning}")),
            );
        }
        Err(error) => lines.push(format!("local install: ERROR {error:#}")),
    }
    let mut env: Vec<&(String, String)> = ctx
        .env
        .iter()
        .filter(|(name, _)| {
            name.starts_with("PUI_") || name.starts_with("PAPERCUSP_") || name.starts_with("ZELLIJ")
        })
        .collect();
    env.sort();
    for (name, value) in env {
        lines.push(format!("env {name}={}", redact_env(name, value)));
    }
    lines
}

fn save_diagnostics(layout: &Layout, ctx: &LifecycleContext) -> Result<PathBuf> {
    use std::os::unix::fs::OpenOptionsExt;
    let report = diagnostics_report(layout, ctx).join("\n") + "\n";
    fs::create_dir_all(&layout.data_dir)?;
    let path = layout
        .data_dir
        .join(format!("pui-diagnostics-{}.txt", epoch_now()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .with_context(|| format!("create {}", path.display()))?;
    std::io::Write::write_all(&mut file, report.as_bytes())?;
    Ok(path)
}

/// Read-only preview of `op`. A change comes back armed for confirmation.
pub fn preview(op: &LifecycleOp, layout: &Layout, ctx: &LifecycleContext) -> LifecycleView {
    let result: Result<(Vec<String>, Option<LifecycleOp>)> = match op {
        LifecycleOp::About => Ok((about_lines(layout, ctx), None)),
        LifecycleOp::CheckUpdates => check_for_updates(layout, ctx),
        LifecycleOp::Update { from, sha256 } => (|| -> Result<_> {
            let source = open_update_source(layout, from, sha256.as_deref())?;
            let unit = read_release_unit(&source.root)?;
            let plan = plan_activation(
                layout,
                &unit,
                ActivationKind::Update {
                    allow_downgrade: false,
                },
            )?;
            Ok((plan.preview(), Some(op.clone())))
        })(),
        LifecycleOp::Rollback => {
            plan_rollback(layout).map(|plan| (plan.preview(), Some(op.clone())))
        }
        LifecycleOp::Uninstall { purge } => {
            plan_uninstall(layout, *purge).map(|plan| (plan.preview(), Some(op.clone())))
        }
        LifecycleOp::Diagnostics => Ok((diagnostics_report(layout, ctx), Some(op.clone()))),
    };
    let title = op.title().to_string();
    match result {
        Ok((mut lines, armed)) => {
            if let Some(armed) = &armed {
                lines.push(String::new());
                lines.push(armed.confirm_hint().to_string());
            }
            LifecycleView {
                title,
                lines,
                armed,
            }
        }
        Err(error) => LifecycleView {
            title,
            lines: vec![
                format!("{error:#}"),
                String::new(),
                "Nothing was changed.".into(),
            ],
            armed: None,
        },
    }
}

/// Apply a previewed, confirmed `op`. Read-only ops just re-render.
pub fn apply(op: &LifecycleOp, layout: &Layout, ctx: &LifecycleContext) -> LifecycleView {
    let result: Result<Vec<String>> = match op {
        LifecycleOp::About | LifecycleOp::CheckUpdates => return preview(op, layout, ctx),
        LifecycleOp::Update { from, sha256 } => (|| -> Result<Vec<String>> {
            let source = open_update_source(layout, from, sha256.as_deref())?;
            let unit = read_release_unit(&source.root)?;
            let plan = plan_activation(
                layout,
                &unit,
                ActivationKind::Update {
                    allow_downgrade: false,
                },
            )?;
            apply_activation(layout, &unit, &plan)?;
            Ok(vec![
                format!(
                    "✓ {} is installed and active; {} is kept for rollback",
                    plan.to,
                    plan.from.as_deref().unwrap_or("nothing")
                ),
                RESTART_NOTE.to_string(),
            ])
        })(),
        LifecycleOp::Rollback => (|| -> Result<Vec<String>> {
            let plan = plan_rollback(layout)?;
            apply_rollback(layout, &plan, false)?;
            Ok(vec![
                format!("✓ rolled back to {}", plan.to),
                RESTART_NOTE.to_string(),
            ])
        })(),
        LifecycleOp::Uninstall { purge } => (|| -> Result<Vec<String>> {
            let plan = plan_uninstall(layout, *purge)?;
            apply_uninstall(layout, &plan)?;
            Ok(vec![
                "✓ PUI is uninstalled.".to_string(),
                if *purge {
                    "PUI's own settings were removed; operator.json is kept for other Papercusp clients.".to_string()
                } else {
                    "Your settings in ~/.papercusp are kept.".to_string()
                },
                "This session keeps running until you quit.".to_string(),
            ])
        })(),
        LifecycleOp::Diagnostics => save_diagnostics(layout, ctx).map(|path| {
            vec![
                format!("✓ saved {}", path.display()),
                "It holds no conversation content or credentials; review it before sharing."
                    .to_string(),
            ]
        }),
    };
    LifecycleView {
        title: op.title().to_string(),
        lines: result.unwrap_or_else(|error| vec![format!("{} failed: {error:#}", op.title())]),
        armed: None,
    }
}

fn confirm(action: &str, yes: bool) -> Result<()> {
    use std::io::{BufRead, IsTerminal, Write};
    if yes {
        return Ok(());
    }
    if !std::io::stdin().is_terminal() {
        bail!("refusing to {action} without confirmation; re-run with --yes");
    }
    print!("Proceed with {action}? [y/N] ");
    std::io::stdout().flush()?;
    let mut answer = String::new();
    std::io::stdin().lock().read_line(&mut answer)?;
    if matches!(answer.trim(), "y" | "Y" | "yes" | "YES") {
        Ok(())
    } else {
        bail!("{action} cancelled; nothing was changed")
    }
}

struct SelfArgs {
    from: Option<PathBuf>,
    yes: bool,
    dry_run: bool,
    json: bool,
    allow_downgrade: bool,
    restore_data: bool,
    purge: bool,
}

fn parse_args(args: &[String]) -> Result<SelfArgs> {
    let mut parsed = SelfArgs {
        from: None,
        yes: false,
        dry_run: false,
        json: false,
        allow_downgrade: false,
        restore_data: false,
        purge: false,
    };
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--from" => {
                parsed.from = Some(PathBuf::from(
                    iter.next().context("--from requires a path")?,
                ))
            }
            _ if arg.starts_with("--from=") => {
                parsed.from = Some(PathBuf::from(&arg["--from=".len()..]))
            }
            "--yes" | "-y" => parsed.yes = true,
            "--dry-run" => parsed.dry_run = true,
            "--json" => parsed.json = true,
            "--allow-downgrade" => parsed.allow_downgrade = true,
            "--restore-data" => parsed.restore_data = true,
            "--purge" => parsed.purge = true,
            other => bail!("unknown `pui self` argument {other:?}\n\n{SELF_HELP}"),
        }
    }
    Ok(parsed)
}

fn print_lines(lines: &[String]) {
    for line in lines {
        println!("{line}");
    }
}

/// `pui self <verb> …` — `args` starts at the verb.
pub fn run(args: &[String]) -> Result<()> {
    let Some(verb) = args.first().map(String::as_str) else {
        print!("{SELF_HELP}");
        return Ok(());
    };
    if matches!(verb, "-h" | "--help" | "help")
        || args.iter().any(|arg| arg == "-h" || arg == "--help")
    {
        print!("{SELF_HELP}");
        return Ok(());
    }
    if verb == "stamp" {
        println!("{}", stamp_json());
        return Ok(());
    }
    let options = parse_args(&args[1..])?;
    let layout = Layout::from_env()?;
    match verb {
        "status" => {
            let status = status(&layout, std::env::var_os("PATH").as_deref());
            if options.json {
                println!("{}", serde_json::to_string_pretty(&status)?);
                return Ok(());
            }
            println!("release store: {}", status.home.display());
            match &status.current {
                Some(release) => println!(
                    "current:  {} ({}){}",
                    release.id,
                    release.version.as_deref().unwrap_or("unknown version"),
                    release
                        .problem
                        .as_deref()
                        .map(|problem| format!(" — FAILED VERIFICATION: {problem}"))
                        .unwrap_or_default()
                ),
                None => println!("current:  not installed"),
            }
            if let Some(release) = &status.previous {
                println!(
                    "previous: {} ({})",
                    release.id,
                    release.version.as_deref().unwrap_or("unknown version")
                );
            }
            println!("launcher: {}", status.launcher.display());
            if status
                .psu_launcher_target
                .as_ref()
                .is_some_and(|target| target.starts_with(&status.home))
            {
                println!("psu:      {}", status.psu_launcher.display());
            }
            for note in &status.notes {
                println!("note: {note}");
            }
            if status
                .current
                .as_ref()
                .is_some_and(|release| release.problem.is_some())
            {
                bail!("the installed release failed verification; reinstall it with `pui self install --from …`");
            }
            Ok(())
        }
        "install" | "update" => {
            let from = options.from.as_deref().with_context(|| {
                format!("`pui self {verb}` needs --from <release-dir|archive.tar.gz>")
            })?;
            let source = open_source(&layout, from, None)?;
            let unit = read_release_unit(&source.root)?;
            let kind = if verb == "install" {
                ActivationKind::Install
            } else {
                ActivationKind::Update {
                    allow_downgrade: options.allow_downgrade,
                }
            };
            let plan = plan_activation(&layout, &unit, kind)?;
            print_lines(&plan.preview());
            match &source.digest {
                Some(digest) => println!("archive:  sha256 {digest} matches its published digest"),
                None if !source.cleanup.is_empty() => println!(
                    "archive:  no published digest beside it; release contents are still verified against their manifest"
                ),
                None => {}
            }
            if options.dry_run {
                return Ok(());
            }
            confirm(&plan.action, options.yes)?;
            apply_activation(&layout, &unit, &plan)?;
            println!("✓ {} {} is active", plan.action, plan.to);
            for note in status(&layout, std::env::var_os("PATH").as_deref()).notes {
                println!("note: {note}");
            }
            Ok(())
        }
        "rollback" => {
            let plan = plan_rollback(&layout)?;
            print_lines(&plan.preview());
            if options.restore_data {
                println!("user data: PUI state returns to its pre-update snapshot (the current state is snapshotted first)");
            }
            if options.dry_run {
                return Ok(());
            }
            confirm("rollback", options.yes)?;
            let restored = apply_rollback(&layout, &plan, options.restore_data)?;
            println!("✓ rolled back to {}", plan.to);
            if let Some(dir) = restored {
                println!("  restored PUI state from {}", dir.display());
            }
            Ok(())
        }
        "diagnostics" => {
            let ctx = LifecycleContext::current(crate::client::selected_endpoint_label());
            print_lines(&diagnostics_report(&layout, &ctx));
            Ok(())
        }
        "uninstall" => {
            let plan = plan_uninstall(&layout, options.purge)?;
            print_lines(&plan.preview());
            if options.dry_run {
                return Ok(());
            }
            confirm("uninstall", options.yes)?;
            apply_uninstall(&layout, &plan)?;
            println!("✓ PUI uninstalled");
            Ok(())
        }
        other => bail!("unknown `pui self` command {other:?}\n\n{SELF_HELP}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::tempdir;

    const EPOCH: u64 = 1_700_000_000;

    fn layout(root: &Path) -> Layout {
        Layout {
            home: root.join("share/pui"),
            bin_dir: root.join("bin"),
            data_dir: root.join("dot-papercusp"),
        }
    }

    /// A release unit whose `bin/pui` is a script answering `self stamp` exactly
    /// as a real build of that generation would.
    fn fake_unit(dir: &Path, version: &str, sha: &str) -> PathBuf {
        fake_unit_with(dir, version, sha, |_| {})
    }

    fn fake_unit_with(
        dir: &Path,
        version: &str,
        sha: &str,
        edit: impl FnOnce(&mut Value),
    ) -> PathBuf {
        let root = dir.join(format!("pui-{version}-{sha}"));
        fs::create_dir_all(root.join("bin")).unwrap();
        let companion = root.join("pui-companion.wasm");
        fs::write(&companion, format!("wasm {version} {sha}")).unwrap();
        let companion_sha = install::sha256_file(&companion).unwrap();
        let mut stamp = json!({
            "version": version,
            "sourceSha": sha,
            "sourceDirty": false,
            "builtAtEpoch": EPOCH,
            "companionSha256": companion_sha,
            "target": install::this_target(),
        });
        edit(&mut stamp);
        let binary = root.join("bin/pui");
        fs::write(
            &binary,
            format!(
                "#!/bin/sh\n[ \"$1 $2\" = \"self stamp\" ] || exit 64\nprintf '%s\\n' '{stamp}'\n"
            ),
        )
        .unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
        let manifest = install::InstallManifest {
            schema_version: 1,
            source_sha: sha.into(),
            source_dirty: false,
            built_at_epoch: EPOCH,
            binary_path: "bin/pui".into(),
            binary_sha256: install::sha256_file(&binary).unwrap(),
            companion_path: "pui-companion.wasm".into(),
            companion_sha256: companion_sha,
            source_root: None,
            version: Some(version.into()),
            target: Some(install::this_target()),
        };
        fs::write(
            root.join(MANIFEST_NAME),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        root
    }

    fn activate(layout: &Layout, root: &Path, kind: ActivationKind) -> Result<ActivationPlan> {
        let unit = read_release_unit(root)?;
        let plan = plan_activation(layout, &unit, kind)?;
        apply_activation(layout, &unit, &plan)?;
        Ok(plan)
    }

    fn current_id(layout: &Layout) -> Option<String> {
        installed(layout, &layout.current()).map(|release| release.id)
    }

    fn previous_id(layout: &Layout) -> Option<String> {
        installed(layout, &layout.previous()).map(|release| release.id)
    }

    #[test]
    fn install_activates_a_verified_copy_and_links_the_launcher() {
        let dir = tempdir().unwrap();
        let layout = layout(dir.path());
        let unit = fake_unit(dir.path(), "0.1.0", "aaaaaaaaaaaaaaaa");

        let plan = activate(&layout, &unit, ActivationKind::Install).unwrap();

        assert_eq!(plan.action, "install");
        assert_eq!(current_id(&layout).as_deref(), Some("0.1.0-aaaaaaaaaaaa"));
        assert_eq!(
            fs::read_link(layout.launcher()).unwrap(),
            layout.home.join("current/bin/pui")
        );
        // The launcher runs the COPY in the release store, not the source dir.
        fs::remove_dir_all(&unit).unwrap();
        let output =
            output_of_fresh_executable(Command::new(layout.launcher()).args(["self", "stamp"]))
                .unwrap();
        assert!(output.status.success());
        let status = status(&layout, Some(layout.bin_dir.as_os_str()));
        assert_eq!(status.current.unwrap().problem, None);
        assert!(status.notes.is_empty(), "{:?}", status.notes);
    }

    #[test]
    fn install_refuses_a_unit_whose_artifacts_do_not_match_its_manifest() {
        let dir = tempdir().unwrap();
        let unit = fake_unit(dir.path(), "0.1.0", "aaaaaaaaaaaaaaaa");
        fs::write(unit.join("pui-companion.wasm"), b"substituted").unwrap();

        let error = read_release_unit(&unit).unwrap_err().to_string();

        assert!(error.contains("companionPath"), "{error}");
        assert!(error.contains("hashes to"), "{error}");
    }

    fn write_contents(root: &Path) {
        let mut files = Vec::new();
        unit_files(root, root, &mut files).unwrap();
        files.retain(|path| path != Path::new(CONTENTS_NAME));
        files.sort();
        let listing: String = files
            .iter()
            .map(|path| {
                format!(
                    "{}  {}\n",
                    install::sha256_file(&root.join(path)).unwrap(),
                    path.display()
                )
            })
            .collect();
        fs::write(root.join(CONTENTS_NAME), listing).unwrap();
    }

    #[test]
    fn a_contents_listing_pins_every_file_in_the_unit() {
        let dir = tempdir().unwrap();
        let unit = fake_unit(dir.path(), "0.1.0", "aaaaaaaaaaaaaaaa");
        fs::write(unit.join("bin/zellij"), b"zellij 0.44.3").unwrap();
        fs::write(unit.join("README.md"), b"readme").unwrap();
        write_contents(&unit);
        read_release_unit(&unit).expect("an intact listed unit verifies");

        fs::write(unit.join("bin/zellij"), b"substituted").unwrap();
        let changed = read_release_unit(&unit).unwrap_err().to_string();
        assert!(changed.contains("bin/zellij hashes to"), "{changed}");

        fs::write(unit.join("bin/zellij"), b"zellij 0.44.3").unwrap();
        fs::write(unit.join("bin/extra"), b"added").unwrap();
        let added = read_release_unit(&unit).unwrap_err().to_string();
        assert!(added.contains("bin/extra is not listed"), "{added}");

        fs::remove_file(unit.join("bin/extra")).unwrap();
        fs::remove_file(unit.join("README.md")).unwrap();
        let missing = read_release_unit(&unit).unwrap_err().to_string();
        assert!(missing.contains("README.md is listed"), "{missing}");
    }

    #[test]
    fn install_refuses_a_binary_whose_embedded_identity_disagrees() {
        let dir = tempdir().unwrap();
        let layout = layout(dir.path());
        let unit = fake_unit_with(dir.path(), "0.1.0", "aaaaaaaaaaaaaaaa", |stamp| {
            stamp["sourceSha"] = json!("bbbbbbbbbbbbbbbb");
        });

        let error = activate(&layout, &unit, ActivationKind::Install)
            .unwrap_err()
            .to_string();

        assert!(error.contains("sourceSha"), "{error}");
        assert!(!layout.current().exists(), "nothing may activate");
    }

    #[test]
    fn install_refuses_a_unit_built_for_another_target() {
        let dir = tempdir().unwrap();
        let layout = layout(dir.path());
        let unit = fake_unit(dir.path(), "0.1.0", "aaaaaaaaaaaaaaaa");
        let manifest_path = unit.join(MANIFEST_NAME);
        let mut manifest: Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest["target"] = json!("plan9-mips");
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();

        let error = activate(&layout, &unit, ActivationKind::Install)
            .unwrap_err()
            .to_string();

        assert!(error.contains("built for plan9-mips"), "{error}");
    }

    #[test]
    fn update_preserves_user_state_and_rollback_swaps_back_without_touching_it() {
        let dir = tempdir().unwrap();
        let layout = layout(dir.path());
        fs::create_dir_all(&layout.data_dir).unwrap();
        let state = layout.data_dir.join("pui-state.json");
        let operator = layout.data_dir.join("operator.json");
        fs::write(&state, br#"{"tutorialSeen":true}"#).unwrap();
        fs::write(&operator, br#"{"httpUrl":"http://127.0.0.1:3070"}"#).unwrap();
        let v1 = fake_unit(dir.path(), "0.1.0", "aaaaaaaaaaaaaaaa");
        let v2 = fake_unit(dir.path(), "0.2.0", "bbbbbbbbbbbbbbbb");
        activate(&layout, &v1, ActivationKind::Install).unwrap();

        let plan = activate(
            &layout,
            &v2,
            ActivationKind::Update {
                allow_downgrade: false,
            },
        )
        .unwrap();

        assert_eq!(plan.action, "update");
        assert_eq!(plan.preserved_state, vec![state.clone(), operator.clone()]);
        assert_eq!(current_id(&layout).as_deref(), Some("0.2.0-bbbbbbbbbbbb"));
        assert_eq!(previous_id(&layout).as_deref(), Some("0.1.0-aaaaaaaaaaaa"));
        assert_eq!(fs::read(&state).unwrap(), br#"{"tutorialSeen":true}"#);
        // The newer release writes a key the older one does not know.
        fs::write(&state, br#"{"tutorialSeen":true,"addedIn020":1}"#).unwrap();

        let rollback = plan_rollback(&layout).unwrap();
        assert_eq!(rollback.to, "0.1.0-aaaaaaaaaaaa");
        assert_eq!(apply_rollback(&layout, &rollback, false).unwrap(), None);

        assert_eq!(current_id(&layout).as_deref(), Some("0.1.0-aaaaaaaaaaaa"));
        assert_eq!(previous_id(&layout).as_deref(), Some("0.2.0-bbbbbbbbbbbb"));
        assert_eq!(
            fs::read(&state).unwrap(),
            br#"{"tutorialSeen":true,"addedIn020":1}"#,
            "rollback preserves configuration by default"
        );
        assert_eq!(
            fs::read(&operator).unwrap(),
            br#"{"httpUrl":"http://127.0.0.1:3070"}"#
        );
    }

    #[test]
    fn rollback_restore_data_returns_pui_state_to_the_pre_update_snapshot() {
        let dir = tempdir().unwrap();
        let layout = layout(dir.path());
        fs::create_dir_all(&layout.data_dir).unwrap();
        let state = layout.data_dir.join("pui-state.json");
        fs::write(&state, br#"{"tutorialSeen":false}"#).unwrap();
        let v1 = fake_unit(dir.path(), "0.1.0", "aaaaaaaaaaaaaaaa");
        let v2 = fake_unit(dir.path(), "0.2.0", "bbbbbbbbbbbbbbbb");
        activate(&layout, &v1, ActivationKind::Install).unwrap();
        activate(
            &layout,
            &v2,
            ActivationKind::Update {
                allow_downgrade: false,
            },
        )
        .unwrap();
        fs::write(&state, br#"{"schema":2,"migrated":true}"#).unwrap();

        let plan = plan_rollback(&layout).unwrap();
        let restored = apply_rollback(&layout, &plan, true).unwrap();

        assert!(restored.is_some());
        assert_eq!(fs::read(&state).unwrap(), br#"{"tutorialSeen":false}"#);
        // The migrated state it replaced is itself recoverable.
        let (dir_after, files) =
            find_snapshot(&layout, "0.2.0-bbbbbbbbbbbb", "0.1.0-aaaaaaaaaaaa").unwrap();
        assert_eq!(files, vec!["pui-state.json".to_string()]);
        assert_eq!(
            fs::read(dir_after.join("pui-state.json")).unwrap(),
            br#"{"schema":2,"migrated":true}"#
        );
    }

    #[test]
    fn rollback_without_a_previous_release_is_refused() {
        let dir = tempdir().unwrap();
        let layout = layout(dir.path());
        let v1 = fake_unit(dir.path(), "0.1.0", "aaaaaaaaaaaaaaaa");
        activate(&layout, &v1, ActivationKind::Install).unwrap();

        let error = plan_rollback(&layout).unwrap_err().to_string();

        assert!(error.contains("no previous release"), "{error}");
    }

    #[test]
    fn update_refuses_a_downgrade_unless_allowed_and_needs_an_install() {
        let dir = tempdir().unwrap();
        let layout = layout(dir.path());
        let v1 = fake_unit(dir.path(), "0.9.0", "aaaaaaaaaaaaaaaa");
        let v2 = fake_unit(dir.path(), "0.10.0", "bbbbbbbbbbbbbbbb");
        let update = ActivationKind::Update {
            allow_downgrade: false,
        };
        let error = activate(&layout, &v2, update).unwrap_err().to_string();
        assert!(error.contains("nothing is installed"), "{error}");

        activate(&layout, &v2, ActivationKind::Install).unwrap();
        let error = activate(&layout, &v1, update).unwrap_err().to_string();
        assert!(error.contains("older than the installed 0.10.0"), "{error}");

        activate(
            &layout,
            &v1,
            ActivationKind::Update {
                allow_downgrade: true,
            },
        )
        .unwrap();
        assert_eq!(current_id(&layout).as_deref(), Some("0.9.0-aaaaaaaaaaaa"));
    }

    #[test]
    fn only_the_current_and_previous_releases_are_kept() {
        let dir = tempdir().unwrap();
        let layout = layout(dir.path());
        let update = ActivationKind::Update {
            allow_downgrade: false,
        };
        activate(
            &layout,
            &fake_unit(dir.path(), "0.1.0", "aaaaaaaaaaaaaaaa"),
            ActivationKind::Install,
        )
        .unwrap();
        activate(
            &layout,
            &fake_unit(dir.path(), "0.2.0", "bbbbbbbbbbbbbbbb"),
            update,
        )
        .unwrap();
        activate(
            &layout,
            &fake_unit(dir.path(), "0.3.0", "cccccccccccccccc"),
            update,
        )
        .unwrap();

        let mut kept: Vec<String> = fs::read_dir(layout.releases())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        kept.sort();

        assert_eq!(kept, vec!["0.2.0-bbbbbbbbbbbb", "0.3.0-cccccccccccc"]);
    }

    #[test]
    fn uninstall_keeps_user_data_unless_purged_and_refuses_foreign_files() {
        let dir = tempdir().unwrap();
        let layout = layout(dir.path());
        fs::create_dir_all(&layout.data_dir).unwrap();
        let state = layout.data_dir.join("pui-state.json");
        let operator = layout.data_dir.join("operator.json");
        fs::write(&state, b"{}").unwrap();
        fs::write(&operator, b"{}").unwrap();
        activate(
            &layout,
            &fake_unit(dir.path(), "0.1.0", "aaaaaaaaaaaaaaaa"),
            ActivationKind::Install,
        )
        .unwrap();

        fs::write(layout.home.join("notes.txt"), b"mine").unwrap();
        let error = plan_uninstall(&layout, false).unwrap_err().to_string();
        assert!(error.contains("notes.txt"), "{error}");
        fs::remove_file(layout.home.join("notes.txt")).unwrap();

        let plan = plan_uninstall(&layout, false).unwrap();
        assert_eq!(plan.launcher, Some(layout.launcher()));
        assert_eq!(plan.kept_state, vec![state.clone(), operator.clone()]);
        apply_uninstall(&layout, &plan).unwrap();
        assert!(!layout.home.exists());
        assert!(fs::symlink_metadata(layout.launcher()).is_err());
        assert!(state.exists() && operator.exists());

        activate(
            &layout,
            &fake_unit(dir.path(), "0.1.0", "aaaaaaaaaaaaaaaa"),
            ActivationKind::Install,
        )
        .unwrap();
        let purge = plan_uninstall(&layout, true).unwrap();
        assert_eq!(purge.removed_state, vec![state.clone()]);
        assert_eq!(purge.kept_state, vec![operator.clone()]);
        apply_uninstall(&layout, &purge).unwrap();
        assert!(!state.exists());
        assert!(
            operator.exists(),
            "operator.json is shared and never purged"
        );
    }

    /// A unit that also ships `bin/psu` (D-031), answering `psu-of <version>`.
    fn fake_unit_with_psu(dir: &Path, version: &str, sha: &str) -> PathBuf {
        let root = fake_unit(dir, version, sha);
        let psu = root.join("bin/psu");
        fs::write(&psu, format!("#!/bin/sh\necho psu-of {version}\n")).unwrap();
        fs::set_permissions(&psu, fs::Permissions::from_mode(0o755)).unwrap();
        root
    }

    fn run_psu_link(layout: &Layout) -> String {
        // The fake psu was written moments ago; a parallel test's fork can hold it busy.
        let output = output_of_fresh_executable(&mut Command::new(layout.psu_launcher())).unwrap();
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[test]
    fn a_release_that_ships_psu_links_it_and_every_switch_follows_current() {
        let dir = tempdir().unwrap();
        let layout = layout(dir.path());
        let update = ActivationKind::Update {
            allow_downgrade: false,
        };

        let plan = activate(
            &layout,
            &fake_unit_with_psu(dir.path(), "0.1.0", "aaaaaaaaaaaaaaaa"),
            ActivationKind::Install,
        )
        .unwrap();
        assert_eq!(
            plan.psu,
            PsuLink::Link {
                path: layout.psu_launcher()
            }
        );
        assert!(plan
            .preview()
            .contains(&format!("psu:      {}", layout.psu_launcher().display())));
        assert_eq!(
            fs::read_link(layout.psu_launcher()).unwrap(),
            layout.psu_launcher_target()
        );
        assert_eq!(run_psu_link(&layout), "psu-of 0.1.0");

        activate(
            &layout,
            &fake_unit_with_psu(dir.path(), "0.2.0", "bbbbbbbbbbbbbbbb"),
            update,
        )
        .unwrap();
        assert_eq!(
            run_psu_link(&layout),
            "psu-of 0.2.0",
            "update moves psu with current"
        );

        // A release without psu (older than D-031) must not leave a dangling link
        // that would shadow a psu later on PATH.
        let plan = activate(
            &layout,
            &fake_unit(dir.path(), "0.3.0", "cccccccccccccccc"),
            update,
        )
        .unwrap();
        assert_eq!(
            plan.psu,
            PsuLink::Remove {
                path: layout.psu_launcher()
            }
        );
        assert!(fs::symlink_metadata(layout.psu_launcher()).is_err());

        let rollback = plan_rollback(&layout).unwrap();
        assert_eq!(
            rollback.psu,
            PsuLink::Link {
                path: layout.psu_launcher()
            },
            "rolling back to a release that ships psu relinks it"
        );
        apply_rollback(&layout, &rollback, false).unwrap();
        assert_eq!(run_psu_link(&layout), "psu-of 0.2.0");
    }

    #[test]
    fn a_psu_that_pui_did_not_create_is_never_replaced_and_never_blocks_install() {
        let dir = tempdir().unwrap();
        let layout = layout(dir.path());
        fs::create_dir_all(&layout.bin_dir).unwrap();
        // The desktop app's shim, a developer launcher: any regular file.
        let shim = b"#!/bin/sh\necho desktop shim\n";
        fs::write(layout.psu_launcher(), shim).unwrap();

        let plan = activate(
            &layout,
            &fake_unit_with_psu(dir.path(), "0.1.0", "aaaaaaaaaaaaaaaa"),
            ActivationKind::Install,
        )
        .unwrap();

        assert!(
            matches!(&plan.psu, PsuLink::Foreign { holder, .. } if holder == "a file"),
            "{:?}",
            plan.psu
        );
        let preview = plan.preview().join("\n");
        assert!(preview.contains("not PUI's; left untouched"), "{preview}");
        assert_eq!(fs::read(layout.psu_launcher()).unwrap(), shim);
        assert_eq!(
            fs::read_link(layout.launcher()).unwrap(),
            layout.launcher_target(),
            "pui itself still installs"
        );
        let status = status(&layout, None);
        assert!(
            status.notes.iter().any(|note| note.contains("not PUI's")),
            "{:?}",
            status.notes
        );

        // A live link to a psu elsewhere (a developer checkout) is foreign too.
        let checkout = dir.path().join("checkout-psu");
        fs::write(&checkout, b"#!/bin/sh\n").unwrap();
        fs::remove_file(layout.psu_launcher()).unwrap();
        std::os::unix::fs::symlink(&checkout, layout.psu_launcher()).unwrap();
        let update = ActivationKind::Update {
            allow_downgrade: false,
        };
        activate(
            &layout,
            &fake_unit_with_psu(dir.path(), "0.2.0", "bbbbbbbbbbbbbbbb"),
            update,
        )
        .unwrap();
        assert_eq!(fs::read_link(layout.psu_launcher()).unwrap(), checkout);

        // Uninstall removes only what PUI created.
        let plan = plan_uninstall(&layout, false).unwrap();
        assert_eq!(plan.psu_launcher, None);
        apply_uninstall(&layout, &plan).unwrap();
        assert_eq!(fs::read_link(layout.psu_launcher()).unwrap(), checkout);
    }

    #[test]
    fn a_dangling_psu_link_is_replaced_and_uninstall_removes_puis_own_link() {
        let dir = tempdir().unwrap();
        let layout = layout(dir.path());
        fs::create_dir_all(&layout.bin_dir).unwrap();
        std::os::unix::fs::symlink(
            dir.path().join("deleted-checkout/psu"),
            layout.psu_launcher(),
        )
        .unwrap();

        activate(
            &layout,
            &fake_unit_with_psu(dir.path(), "0.1.0", "aaaaaaaaaaaaaaaa"),
            ActivationKind::Install,
        )
        .unwrap();
        assert_eq!(run_psu_link(&layout), "psu-of 0.1.0");

        let plan = plan_uninstall(&layout, false).unwrap();
        assert_eq!(plan.psu_launcher, Some(layout.psu_launcher()));
        assert!(plan.preview().contains(&format!(
            "remove psu link: {}",
            layout.psu_launcher().display()
        )));
        apply_uninstall(&layout, &plan).unwrap();
        assert!(fs::symlink_metadata(layout.psu_launcher()).is_err());
        assert!(fs::symlink_metadata(layout.launcher()).is_err());
        assert!(!layout.home.exists());
    }

    #[test]
    fn launcher_never_clobbers_a_file_it_did_not_create() {
        let dir = tempdir().unwrap();
        let layout = layout(dir.path());
        fs::create_dir_all(&layout.bin_dir).unwrap();
        fs::write(layout.launcher(), b"#!/bin/sh\necho mine\n").unwrap();

        let error = activate(
            &layout,
            &fake_unit(dir.path(), "0.1.0", "aaaaaaaaaaaaaaaa"),
            ActivationKind::Install,
        )
        .unwrap_err()
        .to_string();

        assert!(error.contains("not a PUI launcher link"), "{error}");
        assert_eq!(
            fs::read(layout.launcher()).unwrap(),
            b"#!/bin/sh\necho mine\n"
        );
        assert!(
            fs::symlink_metadata(layout.current()).is_err(),
            "the conflict is refused before anything switches"
        );
    }

    #[test]
    fn archive_is_checked_against_its_published_digest_before_unpacking() {
        let dir = tempdir().unwrap();
        let layout = layout(dir.path());
        let unit = fake_unit(dir.path(), "0.1.0", "aaaaaaaaaaaaaaaa");
        let dist = dir.path().join("dist");
        fs::create_dir_all(&dist).unwrap();
        let archive = dist.join("pui-0.1.0-test.tar.gz");
        let status = Command::new("tar")
            .arg("-czf")
            .arg(&archive)
            .arg("-C")
            .arg(dir.path())
            .arg(unit.file_name().unwrap())
            .status()
            .unwrap();
        assert!(status.success());
        let digest = install::sha256_file(&archive).unwrap();

        fs::write(
            dist.join("SHA256SUMS"),
            format!("{}  pui-0.1.0-test.tar.gz\n", "0".repeat(64)),
        )
        .unwrap();
        let error = open_source(&layout, &archive, None)
            .err()
            .expect("a wrong digest must be refused")
            .to_string();
        assert!(error.contains("published digest"), "{error}");

        fs::write(
            dist.join("SHA256SUMS"),
            format!("{digest}  pui-0.1.0-test.tar.gz\n"),
        )
        .unwrap();
        let source = open_source(&layout, &archive, None).unwrap();
        assert_eq!(source.digest.as_deref(), Some(digest.as_str()));
        let unpacked = source.root.clone();
        let unit = read_release_unit(&source.root).unwrap();
        let plan = plan_activation(&layout, &unit, ActivationKind::Install).unwrap();
        apply_activation(&layout, &unit, &plan).unwrap();
        drop(source);
        assert!(!unpacked.exists(), "the unpacked archive is cleaned up");
        assert_eq!(current_id(&layout).as_deref(), Some("0.1.0-aaaaaaaaaaaa"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_fresh_executable_still_open_for_writing_runs_once_released() {
        use std::io::Write;
        let dir = tempdir().unwrap();
        let script = dir.path().join("probe");
        let mut writer = fs::File::create(&script).unwrap();
        writer.write_all(b"#!/bin/sh\necho ok\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        // The race a parallel fork produces: exec refused while a writer is open.
        let busy = Command::new(&script).output().unwrap_err();
        assert_eq!(busy.raw_os_error(), Some(26), "{busy}");
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            drop(writer);
        });
        let output = output_of_fresh_executable(&mut Command::new(&script)).unwrap();
        release.join().unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "ok");
    }

    #[test]
    fn status_names_a_pui_that_shadows_the_launcher_on_path() {
        let dir = tempdir().unwrap();
        let layout = layout(dir.path());
        activate(
            &layout,
            &fake_unit(dir.path(), "0.1.0", "aaaaaaaaaaaaaaaa"),
            ActivationKind::Install,
        )
        .unwrap();
        let cargo_bin = dir.path().join("cargo-bin");
        fs::create_dir_all(&cargo_bin).unwrap();
        let shadow = cargo_bin.join("pui");
        fs::write(&shadow, b"#!/bin/sh\n").unwrap();
        fs::set_permissions(&shadow, fs::Permissions::from_mode(0o755)).unwrap();
        let path = std::env::join_paths([cargo_bin.clone(), layout.bin_dir.clone()]).unwrap();

        let status = status(&layout, Some(path.as_os_str()));

        assert_eq!(status.path_resolves_to, Some(shadow));
        assert!(
            status
                .notes
                .iter()
                .any(|note| note.contains("shadows the installed launcher")),
            "{:?}",
            status.notes
        );
    }

    fn ctx(env: &[(&str, &str)]) -> LifecycleContext {
        LifecycleContext {
            endpoint: "https://user:hunter2@op.example:9443/api?token=abc".into(),
            exe: None,
            path_var: None,
            env: env
                .iter()
                .map(|(name, value)| (name.to_string(), value.to_string()))
                .collect(),
        }
    }

    fn pack(dir: &Path, unit: &Path) -> PathBuf {
        let archive = dir.join(format!(
            "{}.tar.gz",
            unit.file_name().unwrap().to_string_lossy()
        ));
        let status = Command::new("tar")
            .arg("-czf")
            .arg(&archive)
            .arg("-C")
            .arg(unit.parent().unwrap())
            .arg(unit.file_name().unwrap())
            .status()
            .unwrap();
        assert!(status.success());
        archive
    }

    #[test]
    fn palette_preview_changes_nothing_and_only_a_confirmed_apply_rolls_back() {
        let dir = tempdir().unwrap();
        let layout = layout(dir.path());
        activate(
            &layout,
            &fake_unit(dir.path(), "0.1.0", "aaaaaaaaaaaaaaaa"),
            ActivationKind::Install,
        )
        .unwrap();
        let v2 = fake_unit(dir.path(), "0.2.0", "bbbbbbbbbbbbbbbb");
        let update = LifecycleOp::Update {
            from: v2.display().to_string(),
            sha256: None,
        };

        let previewed = preview(&update, &layout, &ctx(&[]));
        assert_eq!(previewed.armed.as_ref(), Some(&update));
        assert!(
            previewed.lines[0].contains("0.1.0-aaaaaaaaaaaa"),
            "{:?}",
            previewed.lines
        );
        assert!(previewed
            .lines
            .iter()
            .any(|line| line.contains("y installs it")));
        assert_eq!(
            current_id(&layout).as_deref(),
            Some("0.1.0-aaaaaaaaaaaa"),
            "a preview changes nothing"
        );

        let done = apply(&update, &layout, &ctx(&[]));
        assert_eq!(done.armed, None);
        assert_eq!(
            current_id(&layout).as_deref(),
            Some("0.2.0-bbbbbbbbbbbb"),
            "{:?}",
            done.lines
        );

        let rollback = preview(&LifecycleOp::Rollback, &layout, &ctx(&[]));
        assert_eq!(rollback.armed, Some(LifecycleOp::Rollback));
        assert_eq!(current_id(&layout).as_deref(), Some("0.2.0-bbbbbbbbbbbb"));
        apply(&LifecycleOp::Rollback, &layout, &ctx(&[]));
        assert_eq!(current_id(&layout).as_deref(), Some("0.1.0-aaaaaaaaaaaa"));
    }

    #[test]
    fn a_refused_preview_arms_nothing_and_says_nothing_changed() {
        let dir = tempdir().unwrap();
        let layout = layout(dir.path());

        for op in [
            LifecycleOp::Rollback,
            LifecycleOp::Uninstall { purge: false },
        ] {
            let view = preview(&op, &layout, &ctx(&[]));
            assert_eq!(view.armed, None, "{op:?}");
            assert!(
                view.lines.iter().any(|line| line == "Nothing was changed."),
                "{:?}",
                view.lines
            );
        }
    }

    #[test]
    fn check_for_updates_without_a_channel_says_so() {
        let dir = tempdir().unwrap();
        let layout = layout(dir.path());

        let view = preview(&LifecycleOp::CheckUpdates, &layout, &ctx(&[]));

        assert_eq!(view.armed, None);
        assert!(view
            .lines
            .iter()
            .any(|line| line.contains("No update channel is configured")));
    }

    #[test]
    fn check_for_updates_arms_the_newest_release_for_this_target_with_its_digest() {
        let dir = tempdir().unwrap();
        let layout = layout(dir.path());
        activate(
            &layout,
            &fake_unit(dir.path(), "0.1.0", "aaaaaaaaaaaaaaaa"),
            ActivationKind::Install,
        )
        .unwrap();
        let dist = dir.path().join("dist");
        fs::create_dir_all(&dist).unwrap();
        let archive = pack(&dist, &fake_unit(dir.path(), "0.3.0", "cccccccccccccccc"));
        let digest = install::sha256_file(&archive).unwrap();
        let target = install::this_target();
        let channel = json!({
            "schemaVersion": 1,
            "releases": [
                { "version": "0.2.0", "artifacts": { target.clone(): { "url": "missing.tar.gz", "sha256": "0".repeat(64) } } },
                { "version": "0.3.0", "artifacts": { target.clone(): { "url": archive.file_name().unwrap().to_string_lossy(), "sha256": digest } } },
                { "version": "9.9.9", "artifacts": { "plan9-mips": { "url": "x.tar.gz", "sha256": "1".repeat(64) } } },
            ],
        });
        let channel_path = dist.join("channel.json");
        fs::write(&channel_path, channel.to_string()).unwrap();
        let env = [("PUI_UPDATE_CHANNEL", channel_path.to_str().unwrap())];

        let view = preview(&LifecycleOp::CheckUpdates, &layout, &ctx(&env));

        assert!(
            view.lines[0].contains("PUI 0.3.0 is available"),
            "{:?}",
            view.lines
        );
        let Some(LifecycleOp::Update { from, sha256 }) = view.armed.clone() else {
            panic!("the newer release must be armed: {view:?}");
        };
        assert_eq!(PathBuf::from(&from), archive);
        assert_eq!(sha256.as_deref(), Some(digest.as_str()));

        let wrong_digest = LifecycleOp::Update {
            from: from.clone(),
            sha256: Some("f".repeat(64)),
        };
        let refused = apply(&wrong_digest, &layout, &ctx(&env));
        assert!(
            refused.lines[0].contains("published digest"),
            "{:?}",
            refused.lines
        );
        assert_eq!(current_id(&layout).as_deref(), Some("0.1.0-aaaaaaaaaaaa"));

        apply(view.armed.as_ref().unwrap(), &layout, &ctx(&env));
        assert_eq!(current_id(&layout).as_deref(), Some("0.3.0-cccccccccccc"));
        let again = preview(&LifecycleOp::CheckUpdates, &layout, &ctx(&env));
        assert!(
            again.lines[0].contains("0.3.0 is up to date"),
            "{:?}",
            again.lines
        );
    }

    #[test]
    fn a_download_without_a_digest_or_over_plain_http_is_refused() {
        let dir = tempdir().unwrap();
        let layout = layout(dir.path());
        let no_digest =
            open_update_source(&layout, "https://example.invalid/pui-0.2.0-x.tar.gz", None);
        assert!(no_digest
            .err()
            .unwrap()
            .to_string()
            .contains("needs the channel's sha256"));
        let plain = open_update_source(
            &layout,
            "http://example.invalid/pui-0.2.0-x.tar.gz",
            Some("0"),
        );
        assert!(plain.err().unwrap().to_string().contains("must use https"));
    }

    #[test]
    fn diagnostics_redact_credentials_and_carry_no_secret_values() {
        let dir = tempdir().unwrap();
        let layout = layout(dir.path());
        let env = [
            ("PAPERCUSP_API_TOKEN", "sk-live-SECRET"),
            ("PUI_OPERATOR", "https://me:pw@op.example/api?key=SECRET2"),
            ("PUI_FLEET", "alpha"),
            ("HOME_UNRELATED", "SECRET3"),
            ("PUI_SETUP_DRAFT", "private draft λ PRIVATE4"),
            ("PAPERCUSP_BRAIN_CMD", "brain --prompt PRIVATE5"),
            ("PUI_NOT_YET_INVENTED", "PRIVATE6"),
        ];

        let report = diagnostics_report(&layout, &ctx(&env)).join("\n");

        for secret in [
            "sk-live-SECRET",
            "SECRET2",
            "SECRET3",
            "hunter2",
            "pw@",
            "PRIVATE4",
            "PRIVATE5",
            "PRIVATE6",
        ] {
            assert!(!report.contains(secret), "{secret} leaked:\n{report}");
        }
        assert!(
            report.contains("env PAPERCUSP_API_TOKEN=[redacted]"),
            "{report}"
        );
        assert!(
            report.contains("env PUI_OPERATOR=https://[redacted]@op.example/api?[redacted]"),
            "{report}"
        );
        assert!(report.contains("env PUI_FLEET=alpha"), "{report}");
        assert!(
            report.contains("env PUI_SETUP_DRAFT=[set, value withheld]"),
            "{report}"
        );
        assert!(
            report.contains("env PUI_NOT_YET_INVENTED=[set, value withheld]"),
            "{report}"
        );
        assert!(
            report.contains("operator endpoint: https://[redacted]@op.example:9443/api?[redacted]"),
            "{report}"
        );

        let saved = apply(&LifecycleOp::Diagnostics, &layout, &ctx(&env));
        let path = saved.lines[0].trim_start_matches("✓ saved ");
        let written = fs::read_to_string(path).unwrap();
        assert!(!written.contains("sk-live-SECRET"));
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn versions_order_numerically_with_prereleases_first() {
        assert_eq!(compare_versions("0.10.0", "0.9.1"), Ordering::Greater);
        assert_eq!(compare_versions("0.2.0-beta.1", "0.2.0"), Ordering::Less);
        assert_eq!(compare_versions("1.0.0+build.5", "1.0.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.0", "1.0.0"), Ordering::Equal);
    }
}
