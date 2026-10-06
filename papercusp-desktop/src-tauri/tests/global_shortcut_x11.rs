#![cfg(target_os = "linux")]

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use global_hotkey::{
    hotkey::{Code, HotKey, Modifiers},
    GlobalHotKeyManager,
};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{ConnectionExt, GrabMode, ModMask};
use x11rb::rust_connection::RustConnection;

struct TestDisplay(Child);
impl Drop for TestDisplay {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn run_on_own_display(case: &str) {
    // Never change DISPLAY in the Cargo test process or use the owner's desktop.
    let mut display = TestDisplay(
        Command::new("Xvfb")
            .args([
                "-displayfd",
                "1",
                "-screen",
                "0",
                "640x480x24",
                "-nolisten",
                "tcp",
            ])
            .stdout(Stdio::piped())
            .spawn()
            .expect("Xvfb is required for native X11 shortcut tests"),
    );
    let mut number = String::new();
    BufReader::new(display.0.stdout.take().unwrap())
        .read_line(&mut number)
        .unwrap();
    assert!(!number.trim().is_empty(), "Xvfb did not allocate a display");
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "x11_grab_child", "--nocapture"])
        .env("DISPLAY", format!(":{}", number.trim()))
        .env("PAPERCUSP_SHORTCUT_X11_TEST_CASE", case)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn unregister_releases_the_key_without_another_registration() {
    run_on_own_display("unregister");
}

#[test]
fn rejected_registration_releases_its_partial_grabs() {
    run_on_own_display("rollback");
}

#[test]
#[ignore = "invoked by the parent tests on their private Xvfb display"]
fn x11_grab_child() {
    let case = std::env::var("PAPERCUSP_SHORTCUT_X11_TEST_CASE").unwrap();
    let (peer, screen) = RustConnection::connect(None).unwrap();
    let root = peer.setup().roots[screen].root;
    let mapping = peer
        .get_keyboard_mapping(
            peer.setup().min_keycode,
            peer.setup().max_keycode - peer.setup().min_keycode + 1,
        )
        .unwrap()
        .reply()
        .unwrap();
    let offset = mapping
        .keysyms
        .chunks(mapping.keysyms_per_keycode as usize)
        .position(|keys| keys.contains(&0xffc9))
        .expect("F12 keysym is present");
    let keycode = peer.setup().min_keycode + offset as u8;
    let grab = |mods| {
        peer.grab_key(false, root, mods, keycode, GrabMode::ASYNC, GrabMode::ASYNC)
            .unwrap()
            .check()
    };
    let manager = GlobalHotKeyManager::new().unwrap();
    let key = HotKey::new(Some(Modifiers::CONTROL), Code::F12);
    if case == "unregister" {
        manager.register(key).unwrap();
        assert!(
            grab(ModMask::CONTROL).is_err(),
            "positive control: manager must own the grab"
        );
        manager.unregister(key).unwrap();
    } else {
        assert_eq!(case, "rollback");
        // The manager first acquires the plain mask, then fails on CapsLock.
        grab(ModMask::CONTROL | ModMask::LOCK).unwrap();
        assert!(
            manager.register(key).is_err(),
            "positive control: conflicting grab must refuse registration"
        );
    }
    // Only the other X11 connection makes requests here. A missing flush on the
    // manager connection cannot be accidentally repaired by this probe.
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        if grab(ModMask::CONTROL).is_ok() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "key remained globally grabbed after {case}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}
