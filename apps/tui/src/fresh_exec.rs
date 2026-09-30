//! Exec an executable that was written moments ago.
//!
//! A fork on any other thread can briefly inherit the writer's descriptor, and
//! exec of that file then fails ETXTBSY until the forked child execs (or exits)
//! and drops it. That is a kernel-level race, not a broken file, so every exec
//! of a freshly written binary retries it — the installer's self-stamp, the
//! pui-audio helper, and every test that writes a fake executable and runs it.
//! The bound is wall-clock, not an attempt count: on a loaded machine a forked
//! child can sit between fork and exec for far longer than a few retries.

use std::io;
use std::process::{Child, Command, Output};
use std::time::{Duration, Instant};

const ETXTBSY: i32 = 26; // the same errno on Linux and macOS
const BUSY_DEADLINE: Duration = Duration::from_secs(2);

fn retry_text_busy<T>(mut attempt: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    let deadline = Instant::now() + BUSY_DEADLINE;
    loop {
        match attempt() {
            Err(error) if error.raw_os_error() == Some(ETXTBSY) && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            result => return result,
        }
    }
}

/// `command.output()`, retrying ETXTBSY.
pub fn output(command: &mut Command) -> io::Result<Output> {
    retry_text_busy(|| command.output())
}

/// `command.spawn()`, retrying ETXTBSY.
pub fn spawn(command: &mut Command) -> io::Result<Child> {
    retry_text_busy(|| command.spawn())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[cfg(target_os = "linux")]
    #[test]
    fn an_executable_briefly_held_open_for_writing_still_runs() {
        // Exec of a file open for writing fails ETXTBSY — exactly what a concurrent
        // fork inheriting the writer's fd looks like. The retry must wait it out.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fresh");
        std::fs::write(&path, "#!/bin/sh\necho ran\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let writer = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        let busy = Command::new(&path).output();
        assert_eq!(busy.err().and_then(|e| e.raw_os_error()), Some(ETXTBSY));
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(60));
            drop(writer);
        });
        let out = output(&mut Command::new(&path)).unwrap();
        release.join().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "ran");
    }

    #[test]
    fn other_errors_are_not_retried() {
        let started = Instant::now();
        let error = spawn(&mut Command::new("/nonexistent/fresh-exec-probe")).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert!(started.elapsed() < Duration::from_millis(500));
    }
}
