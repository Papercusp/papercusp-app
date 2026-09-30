//! App role — the desktop ships as TWO bundles from ONE binary:
//!
//!   * **Papercusp Server** — owns `serve.mjs --ensure` (operator + embedded-PG
//!     + federation + the API/IPC that `psu` and agents talk to). Lives in the
//!     tray/menubar, registers login auto-start, opens NO window. `psu` works
//!     whenever this is up, GUI or not.
//!   * **Papercusp GUI** — a webview only. It does NOT spawn a sidecar; it
//!     discovers a running Server (via `~/.papercusp/operator.json`), auto-
//!     launches the Server bundle if none is up, then attaches its window to
//!     the Server's operator. It NEVER tears the sidecar down on quit.
//!
//! The role is resolved at runtime from the active bundle identifier (each
//! bundle's `tauri.conf` sets a distinct one), with a `PAPERCUSP_APP_ROLE`
//! env override for `tauri dev` / tests where there is no bundle identity.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// Backend: spawn + own the sidecar, tray, login auto-start, no window.
    Server,
    /// Frontend: attach to a running Server's operator; webview only.
    Gui,
}

impl Role {
    pub fn is_gui(self) -> bool {
        matches!(self, Role::Gui)
    }
    /// Only the Server role may spawn/own/supervise the operator sidecar
    /// (`serve.mjs --ensure` + embedded-PG). The GUI role NEVER does — it
    /// discovers + attaches to a running Server. This is the invariant behind
    /// the co-install footgun (WI-3170 P-003 / WI-2902): a co-installed GUI must
    /// not spawn a competing operator that fights the Server for ports/PG.
    pub fn owns_operator(self) -> bool {
        matches!(self, Role::Server)
    }
    pub fn label(self) -> &'static str {
        match self {
            Role::Server => "server",
            Role::Gui => "gui",
        }
    }
}

/// Resolve the app role. Priority:
///   1. `PAPERCUSP_APP_ROLE` env (`server` | `gui`) — dev / test override.
///   2. Bundle identifier convention — `*.server` ⇒ Server.
///   3. Default ⇒ GUI (the safe default: a GUI never owns or kills the sidecar).
pub fn detect(identifier: &str) -> Role {
    if let Ok(v) = std::env::var("PAPERCUSP_APP_ROLE") {
        match v.trim().to_ascii_lowercase().as_str() {
            "server" | "backend" | "sidecar" => return Role::Server,
            "gui" | "window" | "frontend" => return Role::Gui,
            "" => {}
            other => eprintln!("[app-role] ignoring unknown PAPERCUSP_APP_ROLE={other:?}"),
        }
    }
    let id = identifier.to_ascii_lowercase();
    if id.ends_with(".server") || id.contains(".server.") || id.ends_with("-server") {
        Role::Server
    } else {
        Role::Gui
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifier_convention() {
        // Env unset for these (tests run without PAPERCUSP_APP_ROLE).
        assert_eq!(detect("com.papercusp.server"), Role::Server);
        assert_eq!(detect("com.papercusp.gui"), Role::Gui);
        // Unknown / legacy identifier defaults to the safe GUI role.
        assert_eq!(detect("com.papercusp.desktop"), Role::Gui);
    }

    // WI-3170 P-003 / WI-2902 co-install footgun: ONLY the Server role may
    // spawn/own/supervise the operator. A co-installed GUI (even a stale old-build
    // one — VM forensics showed Server pid 3832 + GUI pid 6476 running together)
    // must never spawn a competing operator that fights over PG/ports. This pins
    // the invariant the serve-spawn gate (main.rs) debug_asserts on.
    #[test]
    fn only_server_role_owns_operator() {
        assert!(Role::Server.owns_operator());
        assert!(!Role::Gui.owns_operator());
        // …and the GUI bundle id resolves to a role that does NOT own the operator.
        assert!(!detect("com.papercusp.gui").owns_operator());
        assert!(detect("com.papercusp.server").owns_operator());
        // The safe default (unknown identifier ⇒ GUI) also does not own it.
        assert!(!detect("com.papercusp.desktop").owns_operator());
    }
}
