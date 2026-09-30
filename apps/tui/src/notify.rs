//! OS desktop notifications (P8) — strictly best-effort. Fires a system
//! notification when something needs the human; on a headless / remote box with
//! no D-Bus session the call simply fails and we ignore it (the in-TUI status
//! flash + Inbox badge are the always-available surface).

/// Fire an OS notification. Errors (no notification daemon, no D-Bus, etc.) are
/// swallowed — never let a missing desktop break the workbench.
pub fn os_notify(summary: &str, body: &str) {
    let _ = notify_rust::Notification::new()
        .summary(summary)
        .body(body)
        .appname("pui")
        .show();
}
