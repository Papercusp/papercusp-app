//! Keyboard + focus normalization across a plain terminal and an app-managed
//! multiplexer session (P-007, pui-first-party-public-release-2026-09-07).
//!
//! Two things sit between the user's fingers and this program, and both behave
//! differently in a bare terminal than in a zellij pane:
//!
//! 1. **Some keys never arrive.** The app-managed dock session binds keys at the
//!    MULTIPLEXER level (see [`crate::layout::DOCK_BINDS`]), so inside it those
//!    keystrokes are consumed by zellij and this program is never told they
//!    happened. Painting a hint that names such a key is a promise the binary
//!    cannot keep — and for at least one of them the cost is worse than a wrong
//!    hint: `app.rs` records that `Tab` on the Inbox is "the ONLY keystroke that
//!    reaches the absorbed capability", so inside the dock that capability is
//!    *unreachable*, not merely unadvertised.
//! 2. **Focus can leave mid-hold.** Hold-to-talk starts recording on a key PRESS
//!    and stops on its RELEASE. Move focus away while holding and the release is
//!    delivered to whoever holds focus now — never to us — so the microphone
//!    stays open indefinitely with no on-screen cause. The terminal's
//!    focus-change protocol is the signal that closes it; see
//!    `Event::FocusLost` and `App::release_held`.
//!
//! Everything here is a pure function of an environment lookup, so it is
//! testable without mutating the process environment (which races every other
//! test in this binary).

use crossterm::event::KeyCode;

/// Which terminal host this `pui` process is running inside.
///
/// This deliberately does NOT reuse [`crate::chat_copy::Passthrough`]. That
/// detector answers a different question — which envelope an OSC-52 clipboard
/// write needs — and for it zellij correctly means "none", the same verdict as
/// a bare terminal. Collapsing the two would make a zellij pane indistinguishable
/// from a plain one exactly where the distinction is the whole point. The
/// *shape* (an injectable lookup, zellij probed first because a zellij pane can
/// inherit `$TMUX` from the shell that launched it) is shared; the verdict is not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Host {
    /// A bare terminal: every key this program binds reaches it.
    #[default]
    Plain,
    /// The app-managed dock session (`pui-dock`) — the one layout we ship that
    /// binds keys away from its own panes.
    ZellijDock,
    /// Some other zellij session: the workbench (whose layout binds nothing), or
    /// a session the user started themselves. A user's own config is not ours to
    /// model, so this is treated as pass-through.
    ZellijOther,
    Tmux,
    Screen,
}

/// Decide the host from an environment lookup.
pub fn detect<F>(env: F) -> Host
where
    F: Fn(&str) -> Option<String>,
{
    let nonempty = |k: &str| env(k).filter(|v| !v.is_empty());
    // zellij FIRST: a zellij pane can also carry an inherited TMUX var from the
    // shell that launched it, so probing $TMUX first would misread every zellij
    // pane as tmux.
    if nonempty("ZELLIJ").is_some() || nonempty("ZELLIJ_SESSION_NAME").is_some() {
        let dock = crate::layout::session_name("dock");
        return match nonempty("ZELLIJ_SESSION_NAME") {
            Some(name) if name == dock => Host::ZellijDock,
            _ => Host::ZellijOther,
        };
    }
    if nonempty("TMUX").is_some() {
        return Host::Tmux;
    }
    if nonempty("STY").is_some() {
        return Host::Screen;
    }
    Host::Plain
}

/// Read the host from the real process environment.
pub fn from_env() -> Host {
    detect(|k| std::env::var(k).ok())
}

impl Host {
    /// Does this host consume `code` before it can reach us?
    ///
    /// Derived from [`crate::layout::DOCK_BINDS`], which is the same slice the
    /// dock's KDL keybinds block is generated from — so a bind added, removed or
    /// re-pointed there changes this answer in the same edit. Note that *bound*
    /// and *swallowed* are not the same thing: the dock rebinds ↑/↓ to `Write`
    /// the CSI cursor sequences straight back to the focused pane, so those keys
    /// are bound and still arrive.
    pub fn swallows(self, code: KeyCode) -> bool {
        self == Host::ZellijDock
            && crate::layout::DOCK_BINDS
                .iter()
                .any(|b| !b.reaches_pane && b.code == Some(code))
    }

    /// The key to NAME in a hint for a binding whose primary key is `Tab`.
    ///
    /// `Tab` and `BackTab` are aliases for each other on every host (see the
    /// `KeyCode::Tab | KeyCode::BackTab` arms in `app.rs`), so this only decides
    /// which of the two to advertise — the binding itself works either way. That
    /// bounds the blast radius of the one claim here that no unit test can
    /// settle: that the dock's `bind "Tab"` leaves `Shift+Tab` reaching the pane.
    /// If that turns out to be wrong, a hint is wrong; no capability is lost.
    pub fn cycle_key(self) -> &'static str {
        if self.swallows(KeyCode::Tab) {
            "Shift+Tab"
        } else {
            "Tab"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The closure OWNS its pairs (`use<>` = captures no lifetime), so a caller
    /// can build it from temporaries inline.
    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> + use<> {
        let owned: Vec<(String, String)> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        move |k: &str| {
            owned
                .iter()
                .find(|(key, _)| key == k)
                .map(|(_, v)| v.clone())
        }
    }

    #[test]
    fn a_bare_terminal_is_plain_and_swallows_nothing() {
        let host = detect(env_of(&[]));
        assert_eq!(host, Host::Plain);
        assert!(!host.swallows(KeyCode::Tab));
        assert_eq!(host.cycle_key(), "Tab");
    }

    #[test]
    fn the_dock_session_is_recognized_by_name_and_swallows_tab() {
        let host = detect(env_of(&[
            ("ZELLIJ", "0"),
            ("ZELLIJ_SESSION_NAME", &crate::layout::session_name("dock")),
        ]));
        assert_eq!(host, Host::ZellijDock);
        assert!(host.swallows(KeyCode::Tab));
        assert_eq!(host.cycle_key(), "Shift+Tab");
    }

    /// CALIBRATION: the dock BINDS ↑/↓ too, but rebinds them to write the cursor
    /// sequences back to the pane — so they arrive. A `swallows` that answered
    /// from "is it bound" rather than "does it reach the pane" would report true
    /// here and suppress two correct hints.
    #[test]
    fn a_rebound_key_that_still_reaches_the_pane_is_not_swallowed() {
        let host = detect(env_of(&[
            ("ZELLIJ", "0"),
            ("ZELLIJ_SESSION_NAME", &crate::layout::session_name("dock")),
        ]));
        assert!(crate::layout::DOCK_BINDS
            .iter()
            .any(|b| b.code == Some(KeyCode::Up)));
        assert!(!host.swallows(KeyCode::Up));
        assert!(!host.swallows(KeyCode::Down));
    }

    /// CALIBRATION: the workbench and a user's own session run pui's panes with
    /// no layout-level binds, so nothing may be suppressed there.
    #[test]
    fn another_zellij_session_swallows_nothing() {
        let host = detect(env_of(&[
            ("ZELLIJ", "0"),
            ("ZELLIJ_SESSION_NAME", &crate::layout::session_name("wb")),
        ]));
        assert_eq!(host, Host::ZellijOther);
        assert!(!host.swallows(KeyCode::Tab));
        assert_eq!(host.cycle_key(), "Tab");
    }

    /// A zellij pane commonly inherits `$TMUX` from the shell that started it;
    /// probing tmux first would misread every such pane as tmux and, worse,
    /// report it as a host that swallows nothing.
    #[test]
    fn zellij_wins_over_an_inherited_tmux_var() {
        let host = detect(env_of(&[
            ("ZELLIJ", "0"),
            ("ZELLIJ_SESSION_NAME", &crate::layout::session_name("dock")),
            ("TMUX", "/tmp/tmux-1000/default,123,0"),
        ]));
        assert_eq!(host, Host::ZellijDock);
    }

    #[test]
    fn tmux_and_screen_are_distinguished_and_pass_keys_through() {
        assert_eq!(
            detect(env_of(&[("TMUX", "/tmp/tmux-1000/default,123,0")])),
            Host::Tmux
        );
        assert_eq!(detect(env_of(&[("STY", "1234.pts-0.host")])), Host::Screen);
        assert!(!Host::Tmux.swallows(KeyCode::Tab));
        assert!(!Host::Screen.swallows(KeyCode::Tab));
    }

    /// An empty var is not a session. zellij/tmux unset their vars by clearing
    /// them in some wrappers, and a `is_some()` on the raw lookup would read
    /// `ZELLIJ=""` as "inside zellij".
    #[test]
    fn an_empty_var_is_not_a_session() {
        assert_eq!(
            detect(env_of(&[("ZELLIJ", ""), ("TMUX", ""), ("STY", "")])),
            Host::Plain
        );
    }
}
