// Per-workspace isolation.
//
// A "workspace" is a fully-isolated fake-HOME directory that the Node
// sidecar and embedded-postgres-server are spawned with. Two workspaces look to the
// app like two completely separate machines: separate Postgres data,
// separate ~/.papercusp/, separate ~/.claude/ (so different API keys
// per workspace if the user wants), separate ~/.gitconfig, separate
// snapshots, separate plugin installs.
//
// Layout on the real filesystem:
//
//   ~/.papercusp-workspaces/
//     registry.json                      // { current, workspaces[] }
//     <workspace-id>/                    // becomes HOME for the sidecar
//       .papercusp/                      // app state
//       .claude/                         // claude CLI state (per-workspace)
//       .gitconfig                       // git identity (per-workspace)
//       ...                              // anything else the sidecar's
//                                        // children write under HOME
//
// First-launch migration: if registry.json is absent and the user has an
// existing ~/.papercusp/, we mv it into ~/.papercusp-workspaces/default/
// /.papercusp/ so existing harnesses, snapshots, and projects are
// preserved. Other dotfiles (~/.claude, ~/.gitconfig) are NOT migrated —
// the user re-enters their Anthropic key on first launch. This is the
// price of per-workspace isolation; documented in the onboarding screen.

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Clone, Debug, specta::Type)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    /// Unix epoch milliseconds.
    #[serde(rename = "createdAt")]
    pub created_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, specta::Type)]
pub struct Registry {
    pub current: String,
    pub workspaces: Vec<Workspace>,
}

/// The user's real home dir. Windows sets USERPROFILE, not HOME — resolving
/// HOME alone falls back to `.` (= System32 when launched via the shell /
/// task scheduler), which lands every state dir in an access-denied path.
pub fn real_home() -> PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// The BASE app's data-home directory name. Mirrors
/// `PAPERCUSP_BASE_IDENTITY.dataHomeDirName` in `bin/release.config.ts` — the
/// kit resolves a side-by-side channel's home as `<base>-<identitySuffix>`.
pub const BASE_DATA_HOME_DIR_NAME: &str = ".papercusp";

/// The per-workspace registry root, always a sibling of the data home under the
/// same channel HOME (`<home>/.papercusp-workspaces`).
pub const WORKSPACES_DIR_NAME: &str = ".papercusp-workspaces";

/// How many dot-segments a CHANNEL-LESS bundle identifier has
/// (`com.papercusp.gui`, `com.papercusp.server`). A side-by-side channel appends
/// one more (`com.papercusp.gui.nightly`), which is what makes it a separate
/// installed application — see `resolveChannelIdentity()` in the release kit.
const BASE_IDENTIFIER_SEGMENTS: usize = 3;

/// The channel id baked at build time (`nightly`, …); empty for every build cut
/// so far. Same mechanism as `PAPERCUSP_BUILD_SHA` / `baked_release_host()`,
/// with a matching `rerun-if-env-changed` in `build.rs` so cargo cannot freeze a
/// stale value.
fn baked_channel() -> &'static str {
    option_env!("PAPERCUSP_CHANNEL").unwrap_or("").trim()
}

/// The data-home directory name baked at build time. The VALUE comes from the
/// kit's `resolveChannelIdentity()` (one exit, so bundle id / product name /
/// data home cannot drift); Rust only validates it.
fn baked_channel_data_home() -> &'static str {
    option_env!("PAPERCUSP_CHANNEL_DATA_HOME")
        .unwrap_or("")
        .trim()
}

/// A data-home stamp must be a single hidden directory segment directly under
/// the real HOME — never a path, never an escape, never a visible dir.
fn validate_data_home_segment(name: &str) -> Result<(), String> {
    if name == "." || name == ".." {
        return Err(format!("data home {name:?} is a relative path component"));
    }
    if !name.starts_with('.') {
        return Err(format!(
            "data home {name:?} must be a hidden directory (start with '.')"
        ));
    }
    if name.len() > 64 {
        return Err(format!("data home {name:?} is longer than 64 characters"));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    {
        return Err(format!(
            "data home {name:?} contains characters outside [A-Za-z0-9._-] — a path separator or traversal would escape HOME"
        ));
    }
    Ok(())
}

/// Resolve the data-home directory name from the two baked stamps.
///
/// FAIL-CLOSED IN BOTH DIRECTIONS, and they are OPPOSITE — do not collapse them
/// into one rule (WI-36794, confirmed by EI-14941 / EI-14960):
///
///   * An ABSENT stamp resolves to the EXISTING `~/.papercusp`. Every build ever
///     cut carries no stamp, so any other default would break every install.
///   * A stamp naming a SIDE-BY-SIDE channel must resolve to a DISTINCT dir, or
///     the process refuses to boot. A nightly build that silently opened
///     `~/.papercusp` would be writing the live desktop's operator state.
///
/// An `update-lane` channel (alpha/beta/stable) is the SAME application reached
/// by a different feed, so it legitimately stamps the BASE home and shares state
/// — that is why `stamped == BASE` is an accept, not a reject.
pub fn resolve_data_home_dir_name<'a>(
    channel: &'a str,
    stamped: &'a str,
) -> Result<&'a str, String> {
    let channel = channel.trim();
    let stamped = stamped.trim();

    if stamped.is_empty() {
        if channel.is_empty() {
            // Un-stamped build — today's behavior, and the only safe default.
            return Ok(BASE_DATA_HOME_DIR_NAME);
        }
        // The drift case: someone baked a channel but not the home it resolves
        // to. We cannot tell whether it is side-by-side, so we must not guess.
        return Err(format!(
            "this build is stamped PAPERCUSP_CHANNEL={channel:?} but carries no PAPERCUSP_CHANNEL_DATA_HOME. \
             Refusing to boot rather than guess: a side-by-side channel that fell back to the base home would \
             write to the state of the app in daily use. Bake both stamps from resolveChannelIdentity()."
        ));
    }

    if stamped == BASE_DATA_HOME_DIR_NAME {
        // update-lane: same app, different feed, shared state.
        return Ok(BASE_DATA_HOME_DIR_NAME);
    }

    if channel.is_empty() {
        return Err(format!(
            "this build bakes PAPERCUSP_CHANNEL_DATA_HOME={stamped:?} (distinct from the base {BASE_DATA_HOME_DIR_NAME:?}) \
             but no PAPERCUSP_CHANNEL. A distinct data home with no channel is unattributable — refusing to boot."
        ));
    }

    validate_data_home_segment(stamped)
        .map_err(|e| format!("invalid PAPERCUSP_CHANNEL_DATA_HOME for channel {channel:?}: {e}"))?;
    Ok(stamped)
}

/// The resolved data-home directory name for THIS build, or a refusal to boot.
///
/// A bad stamp is a build-time misconfiguration that cannot be recovered from at
/// runtime, and continuing would mean writing to the wrong home — so this exits
/// rather than returning a plausible-looking wrong path.
fn data_home_dir_name() -> &'static str {
    match resolve_data_home_dir_name(baked_channel(), baked_channel_data_home()) {
        Ok(name) => name,
        Err(msg) => {
            eprintln!("[papercusp-desktop] FATAL (channel data home): {msg}");
            std::process::exit(1);
        }
    }
}

/// The channel suffix carried by a bundle identifier, if any —
/// `com.papercusp.gui.nightly` ⇒ `Some("nightly")`, `com.papercusp.gui` ⇒ `None`.
pub fn channel_suffix_of_identifier(identifier: &str) -> Option<&str> {
    let segs: Vec<&str> = identifier.split('.').filter(|s| !s.is_empty()).collect();
    segs.get(BASE_IDENTIFIER_SEGMENTS).copied()
}

/// Cross-check the two facts a side-by-side build sets INDEPENDENTLY: the tauri
/// identity overlay (which makes it a separate installed app) and the baked
/// channel stamp (which moves its data home). Either one applied without the
/// other is the failure this exists to catch, and it is symmetric:
///
///   * overlay applied, stamp forgotten ⇒ a separate app writing the base home
///     — the exact disaster;
///   * stamp applied, overlay forgotten ⇒ one app whose two installs fight over
///     the same bundle id while pointing at different state.
///
/// Needs no channel table: the identifier's own suffix IS the channel.
///
/// ⚠ The rule is keyed on the resolved DATA HOME, not on the baked channel id,
/// and that distinction is load-bearing. An `update-lane` build may legitimately
/// bake `PAPERCUSP_CHANNEL=stable` while keeping the BASE data home — it is the
/// same application, so its identifier correctly carries NO channel segment. A
/// naive `baked == identifier_suffix` comparison would read that as a mismatch
/// and refuse to boot every stable/beta/alpha build that ever stamped itself.
pub fn verify_channel_identity(identifier: &str) -> Result<(), String> {
    let from_identifier = channel_suffix_of_identifier(identifier).unwrap_or("");
    let resolved = data_home_dir_name();

    if resolved == BASE_DATA_HOME_DIR_NAME {
        // No distinct identity. The bundle id must not claim one either — an
        // identifier with a channel segment here is a SEPARATE installed app
        // pointed at the state of the app in daily use.
        if from_identifier.is_empty() {
            return Ok(());
        }
        return Err(format!(
            "bundle identifier {identifier:?} carries channel {from_identifier:?}, but this build resolves the \
             BASE data home {BASE_DATA_HOME_DIR_NAME:?}. Refusing to boot: that is a separate installed \
             application pointed at the operator state of the app in daily use. The tauri identity overlay was \
             applied without baking PAPERCUSP_CHANNEL + PAPERCUSP_CHANNEL_DATA_HOME."
        ));
    }

    // Distinct data home ⇒ side-by-side ⇒ the identifier must name the channel.
    let baked = baked_channel();
    if baked.eq_ignore_ascii_case(from_identifier) {
        return Ok(());
    }
    Err(format!(
        "channel identity mismatch: bundle identifier {identifier:?} carries channel {from_identifier:?} but \
         this build baked PAPERCUSP_CHANNEL={baked:?} and data home {resolved:?}. Refusing to boot — a \
         side-by-side build whose identity and data home disagree writes to the wrong app's state."
    ))
}

pub fn workspaces_root() -> PathBuf {
    // Match the Node registry reader. An isolated desktop passes a private
    // registry root; reading the channel's ambient registry instead rewrites
    // its webview URL to a workspace the isolated operator cannot serve.
    resolve_workspaces_root(
        shared_sidecar_home(),
        std::env::var("PAPERCUSP_WORKSPACES_ROOT").ok().as_deref(),
    )
}

fn resolve_workspaces_root(shared_home: PathBuf, explicit_root: Option<&str>) -> PathBuf {
    if let Some(root) = explicit_root.filter(|root| !root.trim().is_empty()) {
        return PathBuf::from(root);
    }
    // Sibling of the data home under the SAME channel HOME. Identical to
    // `real_home().join(".papercusp-workspaces")` for an un-stamped build.
    shared_home.join(WORKSPACES_DIR_NAME)
}

fn registry_path() -> PathBuf {
    workspaces_root().join("registry.json")
}

pub fn workspace_dir(id: &str) -> PathBuf {
    workspaces_root().join(id)
}

/// Phase E (P-050 / D-008): the ONE shared sidecar serves EVERY workspace, so
/// it runs under the real user HOME (where `~/.claude`, `~/.gitconfig` and the
/// legacy `~/.papercusp` live). Per-workspace credential isolation no longer
/// rides the sidecar's process HOME — it moves to each spawned CHILD's HOME,
/// set operator-side from the job's workspace (P-051). Operator state itself is
/// already workspace-scoped via `papercuspRoot()` (P-052), so a shared sidecar
/// HOME is safe. Returns the process's real HOME, NOT a per-workspace dir.
///
/// WI-36794 — this is the SINGLE CHOKEPOINT for channel isolation. Everything
/// the app and the sidecar write is `$HOME`-derived (`~/.papercusp`,
/// `~/.papercusp-workspaces`, and Node's `os.homedir()` inside the sidecar,
/// which reads the `HOME` we spawn it with), so moving this one path moves ALL
/// of it. A side-by-side channel (`nightly`) resolves to
/// `~/.papercusp-nightly/`; an un-stamped build resolves to the real HOME
/// exactly as before.
pub fn shared_sidecar_home() -> PathBuf {
    home_for(real_home(), data_home_dir_name())
}

/// The channel HOME for a given real home + resolved data-home dir name. Split
/// out from `shared_sidecar_home()` so BOTH branches are testable: the baked
/// stamps are compile-time, so a test that went through them could only ever
/// exercise the un-stamped build it happens to be compiled as.
fn home_for(real: PathBuf, data_home_dir_name: &str) -> PathBuf {
    if data_home_dir_name == BASE_DATA_HOME_DIR_NAME {
        real
    } else {
        real.join(data_home_dir_name)
    }
}

/// Phase E (P-050 / D-006): the shared embedded-PG (and code-server) data dir.
/// One RLS-scoped Postgres instance backs ALL workspaces, so its data lives
/// here — beside the registry under `~/.papercusp-workspaces/.shared/` — NOT
/// under any single workspace's `.papercusp/`. The leading dot keeps it from
/// ever colliding with a workspace id (ids are slugs: `[a-z0-9-]`).
pub fn shared_data_dir() -> PathBuf {
    workspaces_root().join(".shared")
}

/// Symlink the user's real credentials + identity into a workspace's fake-HOME
/// so CLI children spawned with `HOME=<workspace_dir>` inherit a working session
/// instead of re-authing:
///   - `~/.claude.json` + `~/.claude/.credentials.json` (claude CLI session)
///   - `~/.gitconfig` (git identity — without it a spawned `git` has no
///     `user.name`/`user.email` and commits fail). The header comment has
///     always listed `.gitconfig` as a per-workspace file, but only the claude
///     creds were ever linked; per-window-workspace-context P-051 (per-spawn
///     HOME) relies on every workspace HOME carrying gitconfig too, else the
///     HOME flip silently breaks git for spawned agents.
/// Per-workspace overrides stay possible: users who want isolation delete a
/// symlink and write their own file (we never clobber a real file, only stale
/// symlinks). Best-effort — failures are logged but don't block creation.
pub fn link_workspace_credentials(workspace_dir: &PathBuf) -> io::Result<()> {
    let real_home = real_home();
    let ws_claude_dir = workspace_dir.join(".claude");
    fs::create_dir_all(&ws_claude_dir)?;

    let pairs: [(PathBuf, PathBuf); 3] = [
        (
            real_home.join(".claude.json"),
            workspace_dir.join(".claude.json"),
        ),
        (
            real_home.join(".claude").join(".credentials.json"),
            ws_claude_dir.join(".credentials.json"),
        ),
        // git identity (P-051) — at the HOME root, like .claude.json.
        (
            real_home.join(".gitconfig"),
            workspace_dir.join(".gitconfig"),
        ),
    ];

    for (src, dst) in pairs.iter() {
        if !src.exists() {
            continue;
        }
        // If dst exists as a real file (user already wrote per-workspace creds),
        // leave it alone. Only replace dangling/stale symlinks.
        if dst.exists() && !dst.is_symlink() {
            continue;
        }
        if dst.is_symlink() {
            let _ = fs::remove_file(dst);
        }
        #[cfg(unix)]
        {
            if let Err(e) = std::os::unix::fs::symlink(src, dst) {
                eprintln!(
                    "[papercusp-desktop] could not link {} -> {}: {}",
                    src.display(),
                    dst.display(),
                    e
                );
            }
        }
        #[cfg(not(unix))]
        {
            // On Windows, fall back to copy.
            if let Err(e) = fs::copy(src, dst) {
                eprintln!(
                    "[papercusp-desktop] could not copy {} -> {}: {}",
                    src.display(),
                    dst.display(),
                    e
                );
            }
        }
    }
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn read_registry() -> io::Result<Registry> {
    let path = registry_path();
    let raw = fs::read_to_string(&path)?;
    serde_json::from_str(&raw).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// Write the registry ATOMICALLY (temp file + `rename`).
///
/// ⚠ `fs::write` — which this used to be — is `File::create` + write, and
/// `File::create` TRUNCATES. That leaves a window in which the registry on disk
/// is zero-length or a partial document, and a concurrent reader that lands in
/// it gets `Unexpected end of JSON input` against a file that is perfectly valid
/// a millisecond later. `rename` is atomic on POSIX, so a reader now sees either
/// the whole old file or the whole new one, never a torn one.
///
/// This is not hypothetical and it is not desktop-only. Dozens of agent sessions
/// on one box read this file constantly to resolve their active workspace, and a
/// torn read there is especially nasty: an empty registry resolves
/// `activeWorkspaceId()` to the retired `'default'` partition, where every scoped
/// query returns zero rows and the tool surface renders that as an authoritative
/// "does not exist" rather than "I could not determine where to look" (WI-6734).
/// The TS half (`workspace-registry.ts`) has always written atomically for
/// exactly this reason, and carries a retry-once read guard whose comment names
/// this writer as the remaining hazard: *"the Rust shell also owns this file"*.
/// That retry is a MITIGATION, not a fix — it fails whenever both reads land
/// inside the write window, which is how this was found (a live `coord:orient`
/// failed here 2026-08-11 while the file was valid before and after).
///
/// Keep the temp file in the same directory as the registry: a cross-filesystem
/// rename is not atomic. Unlike the synchronous single-threaded TypeScript
/// writer, Tauri commands can call this function concurrently inside ONE Rust
/// process. A PID-only temp name therefore is not unique: two command threads
/// can open the same temp inode, one can rename it live, and the other can then
/// truncate/write through its still-open descriptor at the public path. That is
/// the exact torn-read window this function exists to remove.
static REGISTRY_WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn registry_temp_path(path: &Path) -> PathBuf {
    let sequence = REGISTRY_WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    path.with_file_name(format!(
        "registry.json.{}.{}.tmp",
        std::process::id(),
        sequence
    ))
}

fn write_registry(reg: &Registry) -> io::Result<()> {
    fs::create_dir_all(workspaces_root())?;
    let raw = serde_json::to_string_pretty(reg)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let path = registry_path();
    let (tmp, mut file) = loop {
        let candidate = registry_temp_path(&path);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => break (candidate, file),
            // A crashed process can leave a temp file behind and the OS can
            // later reuse its PID. Never truncate that unattributed file or
            // let it block registry writes: advance the per-process sequence.
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    };

    let write_result = file.write_all(raw.as_bytes()).and_then(|_| file.sync_all());
    drop(file);
    if let Err(e) = write_result {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }

    if let Err(e) = fs::rename(&tmp, &path) {
        // Never leave a stray temp sibling behind on a failed rename — the
        // directory is scanned elsewhere, and a registry temp that outlives
        // its writer reads as debris nobody can attribute.
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// Slugify a user-supplied workspace name into a filesystem-safe id.
/// Falls back to "workspace-<ts>" if the name has no usable characters.
fn slugify(name: &str) -> String {
    let mut slug = String::with_capacity(name.len());
    let mut last_dash = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if ch == '-' || ch == '_' || ch.is_whitespace() {
            if !last_dash && !slug.is_empty() {
                slug.push('-');
                last_dash = true;
            }
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        format!("workspace-{}", now_ms())
    } else {
        slug
    }
}

fn unique_id(reg: &Registry, base: &str) -> String {
    if !reg.workspaces.iter().any(|w| w.id == base) && base != "" {
        return base.to_string();
    }
    let mut n: u32 = 2;
    loop {
        let candidate = format!("{}-{}", base, n);
        if !reg.workspaces.iter().any(|w| w.id == candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// Ensure the registry exists. If not, create the "default" workspace and
/// migrate any pre-existing ~/.papercusp into it. Returns the live registry.
pub fn ensure_initialized() -> io::Result<Registry> {
    if let Ok(reg) = read_registry() {
        // Make sure the dir for current still exists; if not, fall back to
        // the first available workspace (defensive).
        if !workspace_dir(&reg.current).exists() {
            if let Some(first) = reg.workspaces.first() {
                let mut fixed = reg.clone();
                fixed.current = first.id.clone();
                write_registry(&fixed)?;
                for ws in &fixed.workspaces {
                    let dir = workspace_dir(&ws.id);
                    if dir.exists() {
                        let _ = link_workspace_credentials(&dir);
                    }
                }
                return Ok(fixed);
            }
        }
        for ws in &reg.workspaces {
            let dir = workspace_dir(&ws.id);
            if !dir.exists() {
                // Self-heal a registry entry whose data dir was never
                // provisioned — e.g. one added by the operator-side dogfood
                // bootstrap. Without this, `switch()` rejects it with
                // "workspace dir for <id> missing". Provisioning an empty dir
                // is safe: the sidecar populates it on first boot.
                let _ = fs::create_dir_all(&dir);
            }
            if dir.exists() {
                let _ = link_workspace_credentials(&dir);
            }
        }
        return Ok(reg);
    }

    // First launch (or registry corrupted/missing).
    fs::create_dir_all(workspaces_root())?;
    // D2 (WI-5321, root-causing WI-2381 Blocker A): mint a REAL, non-literal-
    // "default" workspace id here, not the bare string "default". "default" is
    // NOT just an ambient placeholder — it is `DEFAULT_COORD_WORKSPACE`, a
    // distinct coordination-shared partition sentinel the p2p/allotment layer
    // (resource-allotments.ts / metering-store.ts / grant-store.ts, WI-1564)
    // deliberately fail-closes on with a `workspace_unresolved` refusal,
    // because a row captured under that partition is unattributable /
    // unfederatable. Every fresh (or pre-fix legacy) install used to mint its
    // ONE real workspace with id "default", so it collided with that sentinel
    // and could NEVER complete a p2p seat_offer/spawn_request — the guard
    // working exactly as designed against what looked like a real workspace
    // but wasn't one. Minting a unique per-install id here removes the
    // collision while leaving the WI-1564 guard itself untouched (a stale
    // pre-fix install whose registry still says "default" keeps refusing,
    // which is correct — it must be migrated, not silently reinterpreted).
    // Display name stays "Default" for UX continuity; only the `id` changes.
    let initial_id = format!(
        "workspace-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..8]
    );
    let initial_dir = workspace_dir(&initial_id);
    fs::create_dir_all(&initial_dir)?;

    // Migrate ~/.papercusp -> workspaces/<initial_id>/.papercusp if present and
    // the destination doesn't already exist.
    //
    // WI-36794: this MUST read the channel HOME, not the real one. A nightly
    // build resolving `real_home()` here would `fs::rename` the LIVE desktop's
    // `~/.papercusp` into its own workspace on first launch — the single most
    // destructive thing a side-by-side build could do. Under a channel HOME the
    // legacy dir simply does not exist, so nightly starts fresh, which is right.
    let home = shared_sidecar_home();
    let legacy = home.join(".papercusp");
    let migrated = initial_dir.join(".papercusp");
    if legacy.exists() && !migrated.exists() {
        // Best-effort rename; if cross-device or permissions block it, fall
        // back to leaving the legacy dir alone — the new workspace just
        // starts fresh and the user can copy state manually.
        if let Err(e) = fs::rename(&legacy, &migrated) {
            eprintln!(
                "[papercusp-desktop] could not migrate {} -> {}: {} (default workspace will start fresh)",
                legacy.display(),
                migrated.display(),
                e
            );
        } else {
            println!(
                "[papercusp-desktop] migrated {} -> {}",
                legacy.display(),
                migrated.display()
            );
        }
    }

    let reg = Registry {
        current: initial_id.clone(),
        workspaces: vec![Workspace {
            id: initial_id,
            name: "Default".to_string(),
            created_at: now_ms(),
        }],
    };
    write_registry(&reg)?;

    // Link claude creds into every existing workspace dir on every boot —
    // catches both fresh first-launch and pre-existing workspaces created
    // before this fix landed.
    for ws in &reg.workspaces {
        let dir = workspace_dir(&ws.id);
        if dir.exists() {
            let _ = link_workspace_credentials(&dir);
        }
    }

    Ok(reg)
}

pub fn list() -> Registry {
    ensure_initialized().unwrap_or_default()
}

pub fn create(name: &str) -> io::Result<Workspace> {
    let mut reg = ensure_initialized()?;
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "workspace name cannot be empty",
        ));
    }
    let id = unique_id(&reg, &slugify(trimmed));
    let dir = workspace_dir(&id);
    if dir.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("workspace dir {} already exists", dir.display()),
        ));
    }
    fs::create_dir_all(&dir)?;
    let _ = link_workspace_credentials(&dir);
    let ws = Workspace {
        id,
        name: trimmed.to_string(),
        created_at: now_ms(),
    };
    reg.workspaces.push(ws.clone());
    write_registry(&reg)?;
    Ok(ws)
}

pub fn rename(id: &str, new_name: &str) -> io::Result<()> {
    let mut reg = ensure_initialized()?;
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "workspace name cannot be empty",
        ));
    }
    let ws = reg
        .workspaces
        .iter_mut()
        .find(|w| w.id == id)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("no workspace {}", id)))?;
    ws.name = trimmed.to_string();
    write_registry(&reg)
}

pub fn switch(id: &str) -> io::Result<()> {
    let mut reg = ensure_initialized()?;
    if !reg.workspaces.iter().any(|w| w.id == id) {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("no workspace {}", id),
        ));
    }
    if !workspace_dir(id).exists() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("workspace dir for {} missing", id),
        ));
    }
    reg.current = id.to_string();
    write_registry(&reg)
}

/// Delete a workspace and its data dir. Refuses to delete the only workspace
/// or the current one (caller must switch first).
pub fn delete(id: &str) -> io::Result<()> {
    let mut reg = ensure_initialized()?;
    if reg.workspaces.len() <= 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "cannot delete the only workspace",
        ));
    }
    if reg.current == id {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "cannot delete the current workspace; switch to another first",
        ));
    }
    if let Some(pos) = reg.workspaces.iter().position(|w| w.id == id) {
        reg.workspaces.remove(pos);
    } else {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("no workspace {}", id),
        ));
    }
    let dir = workspace_dir(id);
    if dir.exists() {
        // Best-effort remove. If it fails (permissions, in-use), surface it
        // — the registry write below will still succeed so the workspace
        // disappears from the UI even if some bytes linger on disk.
        let _ = fs::remove_dir_all(&dir);
    }
    write_registry(&reg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_root_honors_private_registry_without_changing_channel_home() {
        let channel_home = PathBuf::from("/home/owner/.papercusp-nightly");
        assert_eq!(
            resolve_workspaces_root(channel_home.clone(), Some("/tmp/owned-rig/workspaces")),
            PathBuf::from("/tmp/owned-rig/workspaces")
        );
        for explicit in [None, Some(""), Some("  ")] {
            assert_eq!(
                resolve_workspaces_root(channel_home.clone(), explicit),
                channel_home.join(WORKSPACES_DIR_NAME)
            );
        }
    }

    // ---- WI-36794: channel-aware data home -------------------------------
    //
    // These drive the PURE resolver, never the baked `option_env!` stamps — a
    // test that read the stamps would only ever exercise the un-stamped build
    // it happens to be compiled as, i.e. exactly one of the seven cases below.

    #[test]
    fn unstamped_build_keeps_the_existing_home() {
        // The load-bearing default: every build ever cut carries no stamp, so
        // changing this breaks every install.
        assert_eq!(
            resolve_data_home_dir_name("", "").unwrap(),
            BASE_DATA_HOME_DIR_NAME
        );
        // option_env! that baked an empty string, and whitespace, are the same
        // thing as absent — mirrors baked_release_host()'s blank handling.
        assert_eq!(
            resolve_data_home_dir_name("  ", " ").unwrap(),
            BASE_DATA_HOME_DIR_NAME
        );
    }

    #[test]
    fn update_lane_channel_shares_the_base_home() {
        // alpha/beta/stable are the SAME application reached by a different
        // feed — the kit resolves them to the base data home on purpose, so
        // switching lanes must preserve the user's state.
        assert_eq!(
            resolve_data_home_dir_name("beta", ".papercusp").unwrap(),
            BASE_DATA_HOME_DIR_NAME
        );
    }

    #[test]
    fn side_by_side_channel_gets_a_distinct_home() {
        assert_eq!(
            resolve_data_home_dir_name("nightly", ".papercusp-nightly").unwrap(),
            ".papercusp-nightly"
        );
    }

    #[test]
    fn channel_without_a_data_home_refuses_to_boot() {
        // The drift case the whole guard exists for: a channel-stamped build
        // that did not resolve a home must NOT fall back to the base one.
        let err = resolve_data_home_dir_name("nightly", "").unwrap_err();
        assert!(err.contains("PAPERCUSP_CHANNEL_DATA_HOME"), "{err}");
    }

    #[test]
    fn distinct_home_without_a_channel_refuses_to_boot() {
        let err = resolve_data_home_dir_name("", ".papercusp-nightly").unwrap_err();
        assert!(err.contains("PAPERCUSP_CHANNEL"), "{err}");
    }

    #[test]
    fn a_data_home_stamp_can_never_escape_home() {
        for bad in [
            "../.ssh",
            ".papercusp/../..",
            ".papercusp-night/ly",
            ".papercusp-night\\ly",
            "..",
            ".",
            "papercusp-nightly", // not hidden
        ] {
            assert!(
                resolve_data_home_dir_name("nightly", bad).is_err(),
                "expected {bad:?} to be refused"
            );
        }
    }

    #[test]
    fn identifier_channel_suffix_is_read_from_the_identifier_itself() {
        assert_eq!(channel_suffix_of_identifier("com.papercusp.gui"), None);
        assert_eq!(channel_suffix_of_identifier("com.papercusp.server"), None);
        assert_eq!(
            channel_suffix_of_identifier("com.papercusp.gui.nightly"),
            Some("nightly")
        );
        assert_eq!(
            channel_suffix_of_identifier("com.papercusp.server.nightly"),
            Some("nightly")
        );
    }

    #[test]
    fn identity_and_stamp_must_agree_in_both_directions() {
        // A test build is un-stamped, so it resolves the BASE data home. Both
        // base identifiers agree with that; a channel-suffixed one does not —
        // which is precisely the "overlay applied, stamp forgotten" half of the
        // invariant, and the half that would silently point a separate installed
        // app at `~/.papercusp`.
        assert!(verify_channel_identity("com.papercusp.gui").is_ok());
        assert!(verify_channel_identity("com.papercusp.server").is_ok());
        let err = verify_channel_identity("com.papercusp.gui.nightly").unwrap_err();
        assert!(err.contains("BASE data home"), "{err}");
        assert!(err.contains("PAPERCUSP_CHANNEL"), "{err}");
    }

    #[test]
    fn a_side_by_side_home_moves_both_state_roots_off_the_base() {
        // The claim the whole chokepoint rests on: move ONE path and BOTH of the
        // roots the desktop writes move with it — `<home>/.papercusp` (operator
        // state, reached through the sidecar's HOME) and `<home>/.papercusp-
        // workspaces` (the registry, passed explicitly as PAPERCUSP_WORKSPACES_ROOT).
        let real = PathBuf::from("/home/u");
        let base = home_for(real.clone(), BASE_DATA_HOME_DIR_NAME);
        let night = home_for(real.clone(), ".papercusp-nightly");

        assert_eq!(base, real, "an un-stamped build must not move at all");
        assert_eq!(night, real.join(".papercusp-nightly"));

        // Neither root may resolve to — or underneath — the base app's.
        assert_ne!(
            night.join(BASE_DATA_HOME_DIR_NAME),
            base.join(BASE_DATA_HOME_DIR_NAME)
        );
        assert_ne!(
            night.join(WORKSPACES_DIR_NAME),
            base.join(WORKSPACES_DIR_NAME)
        );
        assert!(!night
            .join(BASE_DATA_HOME_DIR_NAME)
            .starts_with(base.join(BASE_DATA_HOME_DIR_NAME)));
        assert!(!night
            .join(WORKSPACES_DIR_NAME)
            .starts_with(base.join(WORKSPACES_DIR_NAME)));
    }

    #[test]
    fn an_unstamped_build_resolves_exactly_the_pre_wi36794_paths() {
        // Deliberately does NOT call shared_sidecar_home()/workspaces_root():
        // those read the ambient HOME, and a sibling test in this binary
        // (ensure_initialized_...) REASSIGNS HOME while cargo runs tests in
        // parallel threads — so an env-reading assertion here is a coin flip,
        // not a guard. Resolve the real home ONCE and drive the pure function
        // instead; the wiring from workspaces_root() through shared_sidecar_home()
        // is what the mutation probe covers.
        let real = real_home();
        assert_eq!(home_for(real.clone(), BASE_DATA_HOME_DIR_NAME), real);
        assert_eq!(
            home_for(real.clone(), BASE_DATA_HOME_DIR_NAME).join(WORKSPACES_DIR_NAME),
            real.join(".papercusp-workspaces"),
        );
    }

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("My Cool Workspace"), "my-cool-workspace");
        assert_eq!(slugify("client_X"), "client-x");
        assert_eq!(slugify("--weird--"), "weird");
        assert!(slugify("###").starts_with("workspace-"));
    }

    #[test]
    fn unique_id_appends_counter() {
        let reg = Registry {
            current: "a".into(),
            workspaces: vec![
                Workspace {
                    id: "a".into(),
                    name: "A".into(),
                    created_at: 0,
                },
                Workspace {
                    id: "a-2".into(),
                    name: "A2".into(),
                    created_at: 0,
                },
            ],
        };
        assert_eq!(unique_id(&reg, "a"), "a-3");
        assert_eq!(unique_id(&reg, "b"), "b");
    }

    // The concurrency half of the atomicity guard for `write_registry`.
    //
    // Tauri dispatches commands on multiple threads in one process. A temp name
    // derived from only the PID is therefore shared by concurrent writers. If
    // one thread renames that temp file while another still has it open, the
    // second thread keeps writing through the same inode after it becomes the
    // live registry. These paths must be unique before filesystem timing enters
    // the picture; testing the path allocator is deterministic and catches the
    // exact PID-only regression without a probabilistic race test.
    #[test]
    fn registry_temp_paths_are_unique_within_one_process() {
        use std::collections::HashSet;

        let live = PathBuf::from("/tmp/workspace-registry-test/registry.json");
        let paths: Vec<PathBuf> = (0..128).map(|_| registry_temp_path(&live)).collect();
        let unique: HashSet<&PathBuf> = paths.iter().collect();

        assert_eq!(
            unique.len(),
            paths.len(),
            "each write needs its own temp inode"
        );
        assert!(paths.iter().all(|path| path.parent() == live.parent()));
        assert!(paths.iter().all(|path| {
            let name = path.file_name().unwrap().to_string_lossy();
            name.starts_with(&format!("registry.json.{}.", std::process::id()))
                && name.ends_with(".tmp")
        }));
    }

    // The replacement half of the atomicity guard for `write_registry`.
    //
    // WHY AN INODE ASSERTION AND NOT A ROUND-TRIP: the obvious test — write it,
    // read it back, assert it parses — passes just as happily against the
    // `fs::write` this replaced, so it could never fail for the one thing it
    // exists to guard. A guard that cannot fail is not a guard.
    //
    // Inode identity IS the observable difference, deterministically and with no
    // racing: `fs::write` opens the EXISTING path with truncate, so the inode
    // survives across writes; temp-file + `rename` swaps a NEW inode into place,
    // so it must change. Revert `write_registry` to
    // `fs::write(registry_path(), raw)` and this fails on the second write.
    //
    // The discriminator was VERIFIED rather than assumed — but out-of-tree, in a
    // scratch dir, NOT by restoring the old body here. Mutating a shared-checkout
    // source to prove a guard can fail is forbidden in this repo precisely because
    // the git-sync sweep can commit the mutant while the probe is still running.
    // Measured: two consecutive truncating writes to one path kept inode
    // 5418554290 unchanged, while a temp-file + rename over the same path moved it
    // to 5418554291. So `assert_ne!` on consecutive inodes is a real falsifier for
    // this specific revert, not a tautology.
    //
    // UNIX-ONLY BY MECHANISM, not by convenience: the falsifier IS the inode moving,
    // and Windows has no inode — `std::fs::Metadata::ino()` does not exist there, so
    // this test cannot even be COMPILED for x86_64-pc-windows-msvc. The property under
    // test (write_registry renames a fresh file into place rather than truncating the
    // live one) is platform-independent and stays enforced on unix, where we actually
    // run; only this probe is unix-shaped. Gating it is what lets
    // `cargo xwin check --all-targets` pass for the Windows target, so a Windows
    // compile gate can cover TEST code and not just `--bins` (EI-20113642710585614).
    #[cfg(unix)]
    #[test]
    fn write_registry_replaces_the_inode_rather_than_truncating_in_place() {
        use std::os::unix::fs::MetadataExt;
        // Same crate-wide lock as the other HOME-mutating test: `registry_path()`
        // resolves through the process-global HOME, and `cargo test` runs test
        // fns on separate threads in ONE process.
        let _home_guard = crate::HOME_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!("pcusp-ws-atomic-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let prev_home = std::env::var_os("HOME");
        std::env::set_var("HOME", &tmp);

        let mk = |id: &str| Registry {
            current: id.into(),
            workspaces: vec![Workspace {
                id: id.into(),
                name: id.to_uppercase(),
                created_at: 1,
            }],
        };

        write_registry(&mk("w1")).unwrap();
        let first_inode = fs::metadata(registry_path()).unwrap().ino();

        write_registry(&mk("w2")).unwrap();
        let second_inode = fs::metadata(registry_path()).unwrap().ino();

        assert_ne!(
            first_inode, second_inode,
            "write_registry must rename a fresh file into place, not truncate the live one: a \
             truncating write leaves a window where a concurrent reader sees a partial document, \
             and an unreadable registry resolves activeWorkspaceId() to the retired 'default' \
             partition where every scoped query answers a false NOT-FOUND (WI-6734)"
        );

        // The replacement must be the WHOLE new document, not a merge or a stub.
        assert_eq!(read_registry().unwrap().current, "w2");

        // And it must leave no temp debris a later reader would have to attribute.
        let strays: Vec<String> = fs::read_dir(workspaces_root())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(
            strays.is_empty(),
            "stray temp files left behind: {strays:?}"
        );

        match prev_home {
            Some(h) => std::env::set_var("HOME", h),
            None => std::env::remove_var("HOME"),
        }
        let _ = fs::remove_dir_all(&tmp);
    }

    // WI-5321 (root-causing WI-2381 Blocker A): a fresh install used to mint its
    // ONE real workspace with the literal id "default", which collides with
    // DEFAULT_COORD_WORKSPACE — the p2p/allotment layer's coordination-shared
    // partition sentinel (WI-1564) that fail-closes with `workspace_unresolved`
    // on exactly that string. That made every fresh install permanently unable
    // to complete a p2p seat_offer/spawn_request. This guards the fix: a fresh
    // `ensure_initialized()` must mint a real, unique, non-"default" id while
    // keeping the "Default" display name and the migration behavior.
    //
    // Both scenarios (fresh mint + legacy-dir migration) live in ONE test
    // function AND hold the crate-wide `crate::HOME_ENV_TEST_LOCK` (main.rs)
    // for their whole span: `ensure_initialized()` reads/writes the process-
    // global `HOME` env var, and `cargo test` runs test fns on separate
    // threads within the SAME process by default — two tests mutating `HOME`
    // concurrently is a real, observed race (each can read the other's HOME),
    // not a hypothetical one. This raced main.rs's own
    // `pending_route_round_trip_is_one_shot_and_sanitized` the first time the
    // FULL suite ran both concurrently; that test now takes the same lock.
    #[test]
    fn ensure_initialized_mints_a_real_non_default_id_and_migrates_legacy_dir() {
        let _home_guard = crate::HOME_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // Isolate HOME so the test writes to a temp dir, never the real
        // workspaces root.
        let tmp =
            std::env::temp_dir().join(format!("pcusp-ws-fresh-install-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let prev_home = std::env::var_os("HOME");
        unsafe {
            std::env::set_var("HOME", &tmp);
        }

        let reg = ensure_initialized().expect("ensure_initialized should succeed on a fresh HOME");

        assert_eq!(reg.workspaces.len(), 1);
        let ws = &reg.workspaces[0];
        assert_ne!(
            ws.id, "default",
            "fresh install must not mint the literal 'default' workspace id (WI-1564 collision)"
        );
        assert!(
            ws.id.starts_with("workspace-"),
            "expected a minted workspace-<hex> id, got {}",
            ws.id
        );
        assert_eq!(
            ws.name, "Default",
            "display name stays 'Default' for UX continuity"
        );
        assert_eq!(reg.current, ws.id);
        assert!(workspace_dir(&ws.id).exists());

        // Idempotent: a second call re-reads the SAME registry, never re-mints
        // (else every boot would silently orphan the previous workspace's data).
        let reg2 = ensure_initialized().expect("second call should succeed");
        assert_eq!(reg2.workspaces.len(), 1);
        assert_eq!(reg2.workspaces[0].id, ws.id);

        unsafe {
            match prev_home {
                Some(h) => std::env::set_var("HOME", h),
                None => std::env::remove_var("HOME"),
            }
        }
        let _ = fs::remove_dir_all(&tmp);

        // --- Legacy-migration scenario: a SEPARATE fresh HOME, still isolated
        // from the first scenario above (which already restored/cleaned up). ---
        let tmp2 =
            std::env::temp_dir().join(format!("pcusp-ws-legacy-migrate-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp2);
        fs::create_dir_all(&tmp2).unwrap();
        // Pre-seed a legacy ~/.papercusp with a marker file, as a real upgrading
        // install would have.
        let legacy = tmp2.join(".papercusp");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("marker.txt"), b"legacy-state").unwrap();

        let prev_home2 = std::env::var_os("HOME");
        unsafe {
            std::env::set_var("HOME", &tmp2);
        }

        let reg = ensure_initialized().expect("ensure_initialized should succeed");
        let ws_id = reg.workspaces[0].id.clone();
        let migrated_marker = workspace_dir(&ws_id).join(".papercusp").join("marker.txt");
        assert!(
            migrated_marker.exists(),
            "legacy ~/.papercusp should migrate into the minted (non-'default') workspace dir"
        );
        assert_eq!(fs::read(&migrated_marker).unwrap(), b"legacy-state");
        assert!(
            !legacy.exists(),
            "legacy dir should be moved (renamed), not copied"
        );

        unsafe {
            match prev_home2 {
                Some(h) => std::env::set_var("HOME", h),
                None => std::env::remove_var("HOME"),
            }
        }
        let _ = fs::remove_dir_all(&tmp2);
    }
}
