//! Raise the process's `RLIMIT_NOFILE` soft limit at startup (WI-4369).
//!
//! macOS hands a GUI app a **256** fd soft limit, and the Rust/Tauri processes
//! (GUI + Server) sit on it. rlimits are inherited across fork/exec, so raising
//! ours ONCE at the top of `run()` — before anything opens an fd or forks — lifts
//! the whole tree, including any NON-node child. That is why this is not bolted
//! to a single spawn site.
//!
//! **Scope check, so nobody re-files the bug this module was wrongly filed for:**
//! Node RAISES ITS OWN `RLIMIT_NOFILE` at startup (it binary-searches up to
//! 1<<20 — with the shell at 256, `node -e` reports soft=1048575). So the node
//! operator sidecar was never bounded by 256, and an operator holding ~329 open
//! handles is NOT an impending `EMFILE` — it is proof the cap is already above
//! 256, since a process capped at 256 cannot hold 329. WI-4369 was originally
//! filed on that misreading; no `EMFILE` existed in any log. This raise is
//! therefore **latent hardening for the Rust processes**, not a fix for an
//! observed crash. Don't oversell it, and don't diagnose a future operator
//! `EMFILE` as "the 256 limit".
//!
//! Two traps, both of which make the "obvious" implementation wrong:
//!
//! 1. **`soft = hard` FAILS on macOS.** launchd gives a GUI app `RLIM_INFINITY`
//!    as its hard limit; `setrlimit` rejects an infinite *soft* value with
//!    `EINVAL`, and the process silently stays on 256 while you think you fixed
//!    it. The real ceiling is the kernel's `kern.maxfilesperproc` (122880 on the
//!    build VM), which must be queried separately via `sysctlbyname`.
//!
//! 2. **Raise the SOFT limit ONLY; preserve `rlim_max`.** Setting the hard limit
//!    too — which is what bash's `ulimit -n N` does — would CLAMP node's startup
//!    self-raise from 1048575 down to N, leaving the operator with FEWER fds than
//!    it had before this "fix". That is a regression, and it is guarded by
//!    `bin/mac-vm-fd-limit-verify.sh` §3.

/// The soft `RLIMIT_NOFILE` we want every Papercusp process tree to run with.
/// Comfortably above the operator's ~329 baseline plus watcher headroom, and
/// below macOS's usual `kern.maxfilesperproc` (10240–24576).
pub const DESIRED_SOFT_LIMIT: u64 = 8192;

/// `RLIM_INFINITY` is `(rlim_t)-1` — i.e. "no finite cap", not "a huge cap".
/// Asking `setrlimit` for it as a *soft* value is exactly the `EINVAL` above.
pub const NO_FINITE_CAP: u64 = u64::MAX;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FdLimitPlan {
    /// The soft limit already meets what we'd ask for — leave it alone.
    /// We never LOWER a limit someone else deliberately raised.
    AlreadySufficient { soft: u64 },
    /// Raise the soft limit to `to` (clamped to whatever ceiling really applies).
    Raise { from: u64, to: u64 },
}

/// Decide what to ask for, given the current limits and the kernel's per-process
/// cap. Pure so the clamping rules are testable without touching real syscalls.
pub fn plan_fd_limit(soft: u64, hard: u64, kernel_cap: Option<u64>, desired: u64) -> FdLimitPlan {
    let mut ceiling = desired;
    if hard != NO_FINITE_CAP {
        ceiling = ceiling.min(hard);
    }
    if let Some(cap) = kernel_cap {
        ceiling = ceiling.min(cap);
    }

    if ceiling <= soft {
        FdLimitPlan::AlreadySufficient { soft }
    } else {
        FdLimitPlan::Raise {
            from: soft,
            to: ceiling,
        }
    }
}

/// The kernel's hard ceiling on fds *per process*, where one exists independently
/// of `RLIMIT_NOFILE`'s hard value.
#[cfg(unix)]
fn kernel_per_process_cap() -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        let mut value: libc::c_int = 0;
        let mut size = std::mem::size_of::<libc::c_int>();
        // SAFETY: `sysctlbyname` writes at most `size` bytes into `value` (a
        // caller-owned c_int) and updates `size` in place; a null new-value
        // pointer with length 0 makes this a pure read. Failure is signalled by
        // the return code.
        let rc = unsafe {
            libc::sysctlbyname(
                b"kern.maxfilesperproc\0".as_ptr() as *const libc::c_char,
                &mut value as *mut libc::c_int as *mut libc::c_void,
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc == 0 && value > 0 {
            return Some(value as u64);
        }
        return None;
    }

    // On Linux the hard limit already IS the real ceiling (`fs.nr_open` bounds
    // what the hard limit can be raised to, and we never raise the hard limit).
    #[cfg(not(target_os = "macos"))]
    None
}

/// Raise this process's soft fd limit toward [`DESIRED_SOFT_LIMIT`], clamped to
/// the hard limit and the kernel's per-process cap. Best-effort and idempotent:
/// a failure here is logged and never fatal — the app still runs, just with the
/// EMFILE cliff it had before.
pub fn raise_fd_limit() {
    #[cfg(unix)]
    {
        let mut current = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: `getrlimit` fills a caller-owned struct; no aliasing, no
        // ownership transfer, failure reported by the return code.
        if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut current) } != 0 {
            eprintln!(
                "[papercusp] could not read RLIMIT_NOFILE: {}",
                std::io::Error::last_os_error()
            );
            return;
        }

        let plan = plan_fd_limit(
            current.rlim_cur as u64,
            current.rlim_max as u64,
            kernel_per_process_cap(),
            DESIRED_SOFT_LIMIT,
        );

        let (soft, note) = match plan {
            FdLimitPlan::AlreadySufficient { soft } => (soft, "already-sufficient".to_string()),
            FdLimitPlan::Raise { from, to } => {
                let next = libc::rlimit {
                    rlim_cur: to as libc::rlim_t,
                    // Leave the hard limit exactly as we found it — raising it
                    // needs privileges we don't have and don't want.
                    rlim_max: current.rlim_max,
                };
                // SAFETY: `setrlimit` reads a caller-owned struct and reports
                // failure by return code.
                if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &next) } == 0 {
                    (to, format!("raised-from={from}"))
                } else {
                    (
                        from,
                        format!(
                            "RAISE-FAILED target={to} err={} (FS watchers may hit EMFILE \
                             on a large workspace)",
                            std::io::Error::last_os_error()
                        ),
                    )
                }
            }
        };

        // Stored, not printed. The raise has to happen at the top of `run()` —
        // before anything opens an fd or forks — but at that point a packaged
        // build's stdout/stderr are still /dev/null (a Finder/launchd launch has
        // no console; `redirect_own_stdio` only routes them to the on-disk log
        // later, inside `setup()`). Printing here would therefore be invisible in
        // exactly the packaged install this bug is about. `report()` emits it
        // once the log exists.
        let _ = OUTCOME.set(format!("fd-limit: soft={soft} ({note})"));
    }
}

/// The outcome of the startup raise, held until there is somewhere to print it.
static OUTCOME: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Emit the startup fd-limit line. Call AFTER the process has routed its stdio
/// to the on-disk log, so a packaged install records it.
///
/// This line is the whole regression story for WI-4369: macOS cannot read
/// another process's rlimit without root, so the app reporting its own effective
/// limit is what makes the mac E2E battery able to assert on it at all.
pub fn report() {
    if let Some(line) = OUTCOME.get() {
        eprintln!("[papercusp] {line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DESIRED: u64 = DESIRED_SOFT_LIMIT;

    /// The bug itself: a macOS GUI app gets soft=256 / hard=RLIM_INFINITY.
    #[test]
    fn macos_gui_app_is_raised_off_256() {
        assert_eq!(
            plan_fd_limit(256, NO_FINITE_CAP, Some(24576), DESIRED),
            FdLimitPlan::Raise {
                from: 256,
                to: 8192
            }
        );
    }

    /// The EINVAL trap: with an INFINITE hard limit we must still ask for a
    /// FINITE soft value — never RLIM_INFINITY, which setrlimit rejects.
    #[test]
    fn infinite_hard_limit_never_yields_an_infinite_ask() {
        let plan = plan_fd_limit(256, NO_FINITE_CAP, None, DESIRED);
        match plan {
            FdLimitPlan::Raise { to, .. } => {
                assert_ne!(to, NO_FINITE_CAP);
                assert_eq!(to, DESIRED);
            }
            other => panic!("expected a raise, got {other:?}"),
        }
    }

    /// A kernel cap below what we want clamps the ask — asking above
    /// `kern.maxfilesperproc` fails outright and leaves us on 256.
    #[test]
    fn kernel_cap_clamps_the_ask() {
        assert_eq!(
            plan_fd_limit(256, NO_FINITE_CAP, Some(4096), DESIRED),
            FdLimitPlan::Raise {
                from: 256,
                to: 4096
            }
        );
    }

    /// A finite hard limit below the target clamps it too.
    #[test]
    fn hard_limit_clamps_the_ask() {
        assert_eq!(
            plan_fd_limit(256, 1024, None, DESIRED),
            FdLimitPlan::Raise {
                from: 256,
                to: 1024
            }
        );
    }

    /// The tighter of the two ceilings wins.
    #[test]
    fn tightest_ceiling_wins() {
        assert_eq!(
            plan_fd_limit(256, 2048, Some(4096), DESIRED),
            FdLimitPlan::Raise {
                from: 256,
                to: 2048
            }
        );
    }

    /// Linux's typical starting point still gets lifted to the target.
    #[test]
    fn linux_default_is_raised() {
        assert_eq!(
            plan_fd_limit(1024, 1_048_576, None, DESIRED),
            FdLimitPlan::Raise {
                from: 1024,
                to: 8192
            }
        );
    }

    /// Idempotent: a second call after a successful raise is a no-op.
    #[test]
    fn already_at_target_is_a_no_op() {
        assert_eq!(
            plan_fd_limit(8192, 1_048_576, None, DESIRED),
            FdLimitPlan::AlreadySufficient { soft: 8192 }
        );
    }

    /// We never LOWER a soft limit someone else raised on purpose.
    #[test]
    fn never_lowers_an_already_generous_limit() {
        assert_eq!(
            plan_fd_limit(65536, 1_048_576, Some(24576), DESIRED),
            FdLimitPlan::AlreadySufficient { soft: 65536 }
        );
        assert_eq!(
            plan_fd_limit(NO_FINITE_CAP, NO_FINITE_CAP, None, DESIRED),
            FdLimitPlan::AlreadySufficient {
                soft: NO_FINITE_CAP
            }
        );
    }

    /// The soft limit at the ceiling exactly — nothing to do, no zero-width raise.
    #[test]
    fn soft_equal_to_ceiling_is_a_no_op() {
        assert_eq!(
            plan_fd_limit(4096, NO_FINITE_CAP, Some(4096), DESIRED),
            FdLimitPlan::AlreadySufficient { soft: 4096 }
        );
    }

    /// The real syscall path must ACHIEVE the plan, not merely avoid making
    /// things worse.
    ///
    /// Asserting only "it didn't go down" would pass on the very bug this module
    /// exists to fix: on macOS a naive `soft = hard` raise returns `EINVAL` and
    /// silently leaves the process on 256 — the limit didn't drop, and nothing
    /// was raised either. So we compute the plan from the live limits, run the
    /// real `setrlimit`, and assert the kernel landed exactly where we asked.
    /// Run natively on macOS (where the process really does start at 256) this
    /// is what proves the raise took.
    #[cfg(unix)]
    #[test]
    fn raise_achieves_the_planned_limit() {
        let (soft_before, hard) = current_limits();
        let plan = plan_fd_limit(soft_before, hard, kernel_per_process_cap(), DESIRED);

        raise_fd_limit();

        let (soft_after, _) = current_limits();
        match plan {
            FdLimitPlan::AlreadySufficient { .. } => assert_eq!(
                soft_after, soft_before,
                "nothing was planned, so nothing should have changed"
            ),
            FdLimitPlan::Raise { to, .. } => assert_eq!(
                soft_after, to,
                "setrlimit did not land on the planned limit \
                 (soft {soft_before} -> {soft_after}, wanted {to})"
            ),
        }
        assert!(
            soft_after >= soft_before,
            "raise_fd_limit lowered the soft limit: {soft_before} -> {soft_after}"
        );
    }

    #[cfg(unix)]
    fn current_limits() -> (u64, u64) {
        let mut lim = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        // SAFETY: caller-owned struct, read-only syscall.
        assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) }, 0);
        (lim.rlim_cur as u64, lim.rlim_max as u64)
    }
}
