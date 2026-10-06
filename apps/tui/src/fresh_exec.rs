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
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output};
use std::time::{Duration, Instant};

const ETXTBSY: i32 = 26; // the same errno on Linux and macOS
/// 2 s was exceeded once (WI-10004365: two self_install tests failed ETXTBSY under
/// parallel test threads at load ~100 on 128 cores; 0 of 16 re-runs reproduced it).
/// A spurious busy costs only this wait, so the margin is generous; when it is still
/// exceeded, the error names who holds the file open for writing (see `writers_of`).
const BUSY_DEADLINE: Duration = Duration::from_secs(10);

fn retry_text_busy<T>(
    program: &Path,
    deadline: Duration,
    mut attempt: impl FnMut() -> io::Result<T>,
) -> io::Result<T> {
    let started = Instant::now();
    let mut attempts = 0u32;
    loop {
        attempts += 1;
        match attempt() {
            Err(error) if error.raw_os_error() == Some(ETXTBSY) => {
                if started.elapsed() >= deadline {
                    return Err(still_busy(error, program, started.elapsed(), attempts));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            result => return result,
        }
    }
}

/// The give-up error: the original ETXTBSY message plus how long it lasted and which
/// processes still hold the file open for writing, so the next occurrence names its
/// holder instead of leaving a fork race to be inferred.
fn still_busy(error: io::Error, program: &Path, elapsed: Duration, attempts: u32) -> io::Error {
    let writers = writers_of(program);
    let holders = if writers.is_empty() {
        "no process found holding it open for writing".to_string()
    } else {
        format!("held open for writing by {}", writers.join(", "))
    };
    io::Error::new(
        error.kind(),
        format!(
            "{error}: still busy after {:.1}s ({attempts} attempts); {holders}",
            elapsed.as_secs_f64()
        ),
    )
}

/// `pid <n> (<comm>)` for every process with a descriptor on `program` opened for
/// writing, read from /proc. Best-effort: unreadable entries are skipped, and other
/// platforms report nothing.
fn writers_of(program: &Path) -> Vec<String> {
    let Ok(target) = std::fs::canonicalize(program) else {
        return Vec::new();
    };
    let Ok(procs) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    let mut writers = Vec::new();
    for entry in procs.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().filter(|n| n.bytes().all(|b| b.is_ascii_digit())) else {
            continue;
        };
        let Ok(fds) = std::fs::read_dir(entry.path().join("fd")) else {
            continue;
        };
        let writing = fds.flatten().any(|fd| {
            std::fs::read_link(fd.path()).is_ok_and(|link| link == target)
                && opened_for_writing(&entry.path().join("fdinfo").join(fd.file_name()))
        });
        if writing {
            let comm = std::fs::read_to_string(entry.path().join("comm")).unwrap_or_default();
            writers.push(format!("pid {pid} ({})", comm.trim()));
        }
    }
    writers
}

/// Whether an fdinfo `flags:` field (octal open flags) has O_WRONLY or O_RDWR set.
fn opened_for_writing(fdinfo: &Path) -> bool {
    std::fs::read_to_string(fdinfo).is_ok_and(|info| {
        info.lines()
            .find_map(|line| line.strip_prefix("flags:"))
            .and_then(|flags| u32::from_str_radix(flags.trim(), 8).ok())
            .is_some_and(|flags| flags & 0o3 != 0)
    })
}

/// `command.output()`, retrying ETXTBSY.
pub fn output(command: &mut Command) -> io::Result<Output> {
    let program = PathBuf::from(command.get_program());
    retry_text_busy(&program, BUSY_DEADLINE, || command.output())
}

/// `command.spawn()`, retrying ETXTBSY.
pub fn spawn(command: &mut Command) -> io::Result<Child> {
    let program = PathBuf::from(command.get_program());
    retry_text_busy(&program, BUSY_DEADLINE, || command.spawn())
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

    #[cfg(target_os = "linux")]
    #[test]
    fn a_file_still_busy_at_the_deadline_names_its_writer() {
        // WI-10004365: when the wait runs out, the error must say how long it lasted
        // and which process holds the file open for writing — here, this test itself.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("held");
        std::fs::write(&path, "#!/bin/sh\necho ran\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _writer = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        let error = retry_text_busy(&path, Duration::from_millis(100), || {
            Command::new(&path).output()
        })
        .unwrap_err();
        let message = error.to_string();
        assert!(message.contains("still busy after"), "{message}");
        assert!(
            message.contains(&format!("pid {} (", std::process::id())),
            "{message}"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_read_only_descriptor_is_not_reported_as_a_writer() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("read-only");
        std::fs::write(&path, "data").unwrap();
        let _reader = std::fs::File::open(&path).unwrap();
        assert!(writers_of(&path).is_empty(), "{:?}", writers_of(&path));
        let _writer = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        assert_eq!(writers_of(&path).len(), 1, "{:?}", writers_of(&path));
    }

    #[test]
    fn other_errors_are_not_retried() {
        let started = Instant::now();
        let error = spawn(&mut Command::new("/nonexistent/fresh-exec-probe")).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        assert!(started.elapsed() < Duration::from_millis(500));
    }
}
