//! `pui --connect` — run PUI on a remote Papercusp host the way psu does
//! (pui-first-party-public-release P-017 / D-025, owner #468).
//!
//! PUI keeps no list of remote hosts and no transport of its own. psu's
//! connection front controller
//! (`apps/operator/scripts/psu-connection-front-controller.mjs`) owns the saved
//! profiles, the picker, both transports (OpenSSH over IAP, the Papercusp cloud
//! workspace terminal) and the reattach keys. `pui --connect…` hands the whole
//! command line to `psu --connect-program=pui`, so the SAME profile runs `pui`
//! on the remote host, against that host's own operator and store.
//!
//! Every `--connect*` cell is psu's to interpret — PUI only recognises the
//! namespace so it knows to hand off, and never parses a value out of it. The
//! non-transport cells (subcommand, `--fleet`, `--seat`) reach the remote `pui`
//! unchanged. `pui --connect` always means a remote host: psu's picker offers no
//! "this computer" entry for `--connect-program=pui`, so there is no local
//! fallback to agree on (the remote program's exit status passes straight
//! through psu, so no status value could signal one unambiguously).

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

/// The launcher that owns saved connection profiles.
pub const PSU_PROGRAM: &str = "psu";

/// `<directory of exe>/psu` when it is an executable file: the psu a PUI
/// release unit ships beside `bin/pui` (D-031).
pub fn sibling_psu(exe: &Path) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let candidate = exe.parent()?.join(PSU_PROGRAM);
    let meta = std::fs::metadata(&candidate).ok()?;
    (meta.is_file() && meta.permissions().mode() & 0o111 != 0).then_some(candidate)
}

/// The psu every PUI spawn runs: the one shipped beside the running `pui`
/// first, so an installed release uses its own bundled psu and private Node
/// whatever else is on PATH; otherwise `psu` from PATH (a developer build, or
/// the desktop app, which provides its own psu).
pub fn psu_program() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|exe| sibling_psu(&exe))
        .and_then(|path| path.into_os_string().into_string().ok())
        .unwrap_or_else(|| PSU_PROGRAM.to_string())
}

/// The program a pane actually runs for `argv[0]`: `psu` resolves through
/// [`psu_program`]; every other program is left to PATH unchanged.
pub fn pane_program(program: &str) -> String {
    if program == PSU_PROGRAM {
        psu_program()
    } else {
        program.to_string()
    }
}
/// Tells psu's front controller to launch `pui` (not `psu`) on the chosen host.
pub const CONNECT_PROGRAM_ARG: &str = "--connect-program=pui";
/// Set by psu's front controller on the program it launches on the remote host.
pub const FORWARDED_ENV: &str = "PAPERCUSP_PSU_CONNECTION_FORWARDED";

/// True when the command line uses psu's connection namespace (`--connect`,
/// `--connect=<name>`, `--connect-list`, `--connect-login`, …). A literal `--`
/// closes the namespace, exactly as it does for psu.
pub fn requests_connection(args: &[String]) -> bool {
    args.iter()
        .take_while(|arg| arg.as_str() != "--")
        .any(|arg| {
            let key = arg.split_once('=').map_or(arg.as_str(), |(key, _)| key);
            key == "--connect" || key.starts_with("--connect-")
        })
}

/// psu's argv for this PUI command line: the program selector, then every cell
/// in its original order so psu's own parser sees exactly what the user typed.
pub fn psu_args(args: &[String]) -> Vec<String> {
    std::iter::once(CONNECT_PROGRAM_ARG.to_string())
        .chain(args.iter().cloned())
        .collect()
}

/// PUI's command line for setup's remote choices (D-031): `--connect-login
/// --connect` signs in to Papercusp cloud, then opens PUI on one of that
/// sign-in's workspaces; a bare `--connect` offers psu's saved hosts (and a
/// cloud sign-in when there is none). Pass the result to [`hand_off`].
pub fn setup_connect_args(sign_in: bool) -> Vec<String> {
    if sign_in {
        vec!["--connect-login".into(), "--connect".into()]
    } else {
        vec!["--connect".into()]
    }
}

/// PUI's hidden subcommand for setup's `l` / `h` (P-021). Setup execs PUI with
/// it instead of exec'ing psu directly, so a cancelled or failed sign-in comes
/// back to setup rather than leaving the user at a shell prompt. The TUI itself
/// cannot wait on psu: its terminal event reader would take psu's keystrokes.
pub const SETUP_CONNECT_SUBCOMMAND: &str = "__setup-connect";

/// The argv setup execs PUI with for `l` (sign in) or `h` (saved hosts).
pub fn setup_connect_supervisor_args(sign_in: bool) -> [&'static str; 2] {
    [
        SETUP_CONNECT_SUBCOMMAND,
        if sign_in { "sign-in" } else { "hosts" },
    ]
}

/// `Some(sign_in)` when this command line is exactly the hidden subcommand.
pub fn parse_setup_connect(args: &[String]) -> Option<bool> {
    match args {
        [command, choice] if command == SETUP_CONNECT_SUBCOMMAND => match choice.as_str() {
            "sign-in" => Some(true),
            "hosts" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// What setup says after psu returned without finishing, or `None` when psu
/// succeeded: the remote PUI ran and exited, so this PUI exits too.
pub fn setup_connect_note(
    sign_in: bool,
    outcome: &std::io::Result<std::process::ExitStatus>,
) -> Option<String> {
    let what = if sign_in {
        "Cloud sign-in"
    } else {
        "Connecting to a remote host"
    };
    match outcome {
        Ok(status) if status.success() => None,
        // 130 is psu's own "cancelled"; no code at all means a signal ended it.
        Ok(status) if matches!(status.code(), Some(130) | None) => Some(format!(
            "{what} was cancelled. Press l to sign in to Papercusp cloud, or h for a saved host."
        )),
        Ok(status) => Some(format!(
            "{what} did not finish: psu exited with status {}. Its message stays in this terminal after you quit PUI. Press l or h to try again.",
            status.code().unwrap_or(1)
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(psu_missing().to_string()),
        Err(error) => Some(format!("Could not start psu: {error}. Press l or h to try again.")),
    }
}

/// The hidden subcommand's body: run psu for setup as a child of this TUI-free
/// PUI. Ctrl-C reaches the whole foreground group, so this process listens for
/// it (and SIGQUIT) instead of dying; exec restores the default for psu. On
/// success PUI exits as psu did. Otherwise it execs `pui hud` back into setup
/// with the retained draft and the note; that exec returns only on failure.
pub async fn supervise_setup_connect(sign_in: bool) -> Result<()> {
    use tokio::signal::unix::{signal, SignalKind};
    let _interrupt = signal(SignalKind::interrupt())?;
    let _quit = signal(SignalKind::quit())?;
    let note = match refuse_when_forwarded(std::env::var(FORWARDED_ENV).ok().as_deref()) {
        Err(error) => Some(format!("{error:#}")),
        Ok(()) => {
            let outcome = tokio::process::Command::new(psu_program())
                .args(psu_args(&setup_connect_args(sign_in)))
                .status()
                .await;
            setup_connect_note(sign_in, &outcome)
        }
    };
    let Some(note) = note else {
        std::process::exit(0)
    };
    use std::os::unix::process::CommandExt;
    let error = return_to_setup_command(std::env::current_exe()?, &note).exec();
    eprintln!("pui: {note}");
    Err(error).context("reopen PUI setup")
}

/// `pui hud` with the note, keeping the draft the TUI passed down (an absent
/// draft still reopens setup).
pub fn return_to_setup_command(executable: std::path::PathBuf, note: &str) -> Command {
    let mut command = Command::new(executable);
    command
        .arg("hud")
        .env(crate::session_config::SETUP_NOTE_ENV, note);
    if std::env::var_os(crate::session_config::SETUP_DRAFT_ENV).is_none() {
        command.env(crate::session_config::SETUP_DRAFT_ENV, "");
    }
    command
}

/// Refuse a nested hand-off: a `pui` that psu already launched on a remote host
/// connecting onward would stack one remote terminal inside another.
pub fn refuse_when_forwarded(forwarded: Option<&str>) -> Result<()> {
    if forwarded == Some("1") {
        anyhow::bail!(
            "this pui is already running on a remote host through `pui --connect`; run --connect from your own computer instead"
        );
    }
    Ok(())
}

fn psu_missing() -> anyhow::Error {
    anyhow::anyhow!(
        "`pui --connect` uses the remote hosts psu saves, but this PUI has no bundled psu beside it and `{PSU_PROGRAM}` is not on PATH. Reinstall PUI from a release archive (it includes psu), or open a terminal on the remote host and run `pui` there"
    )
}

/// Hand the terminal to psu. On Unix this replaces the PUI process, so psu (and
/// through it the remote `pui`) owns the terminal and the exit status; it
/// returns only when psu could not be started.
pub fn hand_off(args: &[String]) -> Result<i32> {
    refuse_when_forwarded(std::env::var(FORWARDED_ENV).ok().as_deref())?;
    let mut command = Command::new(psu_program());
    command.args(psu_args(args));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = command.exec();
        if error.kind() == std::io::ErrorKind::NotFound {
            return Err(psu_missing());
        }
        Err(error).context("start psu for `pui --connect`")
    }
    #[cfg(not(unix))]
    {
        let status = command.status().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                psu_missing()
            } else {
                anyhow::Error::new(error).context("start psu for `pui --connect`")
            }
        })?;
        Ok(status.code().unwrap_or(1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(cells: &[&str]) -> Vec<String> {
        cells.iter().map(|cell| cell.to_string()).collect()
    }

    #[test]
    fn every_form_of_the_connect_namespace_hands_off() {
        for cells in [
            &["--connect"][..],
            &["--connect=owner-test"],
            &["--connect", "owner-test"],
            &["--connect=cloud/ws-1", "workbench"],
            &["--fleet=f", "--connect-list"],
            &["--connect-login"],
            &["--connect-login=https://portal.example"],
            &["--connect-logout=cloud"],
            &["--connect-session=abc", "--connect=cloud"],
        ] {
            assert!(requests_connection(&args(cells)), "{cells:?}");
        }
    }

    #[test]
    fn ordinary_command_lines_stay_local() {
        for cells in [
            &[][..],
            &["workbench"],
            &["doctor"],
            &["--fleet=connect", "--seat=s"],
            &["hive-pane", "connect"],
            &["--connection"],
            &["-c"],
            // `--` closes psu's namespace; what follows is not a transport flag.
            &["hud", "--", "--connect=x"],
        ] {
            assert!(!requests_connection(&args(cells)), "{cells:?}");
        }
    }

    #[test]
    fn psu_receives_the_program_selector_then_the_command_line_verbatim() {
        let line = args(&[
            "--fleet=f",
            "--connect",
            "cloud/ws-1",
            "workbench",
            "--seat=s",
        ]);
        assert_eq!(
            psu_args(&line),
            args(&[
                "--connect-program=pui",
                "--fleet=f",
                "--connect",
                "cloud/ws-1",
                "workbench",
                "--seat=s",
            ])
        );
    }

    #[test]
    fn setup_remote_choices_are_connection_command_lines() {
        let sign_in = setup_connect_args(true);
        let host = setup_connect_args(false);
        assert_eq!(sign_in, args(&["--connect-login", "--connect"]));
        assert_eq!(host, args(&["--connect"]));
        // Both must take the hand-off route and reach psu as a pui connection.
        for line in [&sign_in, &host] {
            assert!(requests_connection(line), "{line:?}");
            assert_eq!(psu_args(line)[0], CONNECT_PROGRAM_ARG);
        }
    }

    #[test]
    fn a_forwarded_pui_refuses_to_connect_onward() {
        let refused = refuse_when_forwarded(Some("1")).unwrap_err().to_string();
        assert!(
            refused.contains("already running on a remote host"),
            "{refused}"
        );
        assert!(refuse_when_forwarded(None).is_ok());
        assert!(refuse_when_forwarded(Some("0")).is_ok());
    }

    #[test]
    fn the_psu_shipped_beside_pui_wins_over_path() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("releases/0.1.0-aaaa/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let pui = bin.join("pui");
        std::fs::write(&pui, b"").unwrap();

        assert_eq!(
            sibling_psu(&pui),
            None,
            "no psu beside pui: fall back to PATH"
        );

        let psu = bin.join("psu");
        std::fs::write(&psu, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&psu, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            sibling_psu(&pui),
            None,
            "a non-executable file is not a psu"
        );

        std::fs::set_permissions(&psu, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(sibling_psu(&pui), Some(psu));

        std::fs::remove_file(bin.join("psu")).unwrap();
        std::fs::create_dir(bin.join("psu")).unwrap();
        assert_eq!(sibling_psu(&pui), None, "a directory is not a psu");
    }

    #[test]
    fn only_psu_is_resolved_beside_pui() {
        // The test binary has no psu beside it, so psu falls back to PATH, and
        // no other program is ever rewritten.
        assert_eq!(pane_program("psu"), psu_program());
        assert_eq!(pane_program("git"), "git");
        assert_eq!(pane_program("pui"), "pui");
        let exe = std::env::current_exe().unwrap();
        assert_eq!(
            psu_program(),
            sibling_psu(&exe).map_or_else(|| PSU_PROGRAM.to_string(), |p| p.display().to_string())
        );
    }
}

#[cfg(test)]
mod setup_supervisor_tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::process::ExitStatus;

    fn exited(code: i32) -> std::io::Result<ExitStatus> {
        Ok(ExitStatus::from_raw(code << 8))
    }

    #[test]
    fn setup_choices_round_trip_through_the_hidden_subcommand() {
        for sign_in in [true, false] {
            let argv: Vec<String> = setup_connect_supervisor_args(sign_in)
                .iter()
                .map(|s| s.to_string())
                .collect();
            assert_eq!(parse_setup_connect(&argv), Some(sign_in));
            assert!(
                !requests_connection(&argv),
                "the supervisor must not be read as a --connect command line"
            );
        }
        for other in [
            &["hud"][..],
            &[SETUP_CONNECT_SUBCOMMAND],
            &[SETUP_CONNECT_SUBCOMMAND, "cloud"],
            &[SETUP_CONNECT_SUBCOMMAND, "hosts", "x"],
        ] {
            let argv: Vec<String> = other.iter().map(|s| s.to_string()).collect();
            assert_eq!(parse_setup_connect(&argv), None, "{argv:?}");
        }
    }

    #[test]
    fn only_a_finished_hand_off_ends_pui_and_every_other_outcome_names_the_way_back() {
        assert_eq!(setup_connect_note(true, &exited(0)), None);
        let cancelled = setup_connect_note(true, &exited(130)).unwrap();
        assert!(
            cancelled.starts_with("Cloud sign-in was cancelled.") && cancelled.contains("Press l"),
            "{cancelled}"
        );
        let signalled = setup_connect_note(false, &Ok(ExitStatus::from_raw(2))).unwrap();
        assert!(
            signalled.starts_with("Connecting to a remote host was cancelled."),
            "{signalled}"
        );
        let failed = setup_connect_note(true, &exited(3)).unwrap();
        assert!(
            failed.contains("psu exited with status 3") && failed.contains("try again"),
            "{failed}"
        );
        let missing = setup_connect_note(
            true,
            &Err(std::io::Error::from(std::io::ErrorKind::NotFound)),
        )
        .unwrap();
        assert!(missing.contains("no bundled psu"), "{missing}");
    }

    #[test]
    fn a_returning_hand_off_reopens_setup_with_its_note() {
        let command = return_to_setup_command("/test/pui".into(), "Cloud sign-in was cancelled.");
        assert_eq!(command.get_args().collect::<Vec<_>>(), vec!["hud"]);
        let env = command
            .get_envs()
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(
            env[std::ffi::OsStr::new(crate::session_config::SETUP_NOTE_ENV)].unwrap(),
            "Cloud sign-in was cancelled."
        );
    }
}
