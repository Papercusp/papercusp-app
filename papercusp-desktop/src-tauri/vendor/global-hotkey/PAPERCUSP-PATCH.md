global-hotkey 0.8.0, from the crates.io release (checksum
8c386b0a4a70cb2d39fffd74480f985b6f0bfbcb934b6a6b6b7e630e448f242e).
Source and licenses are unchanged except for two Linux/X11 flushes in
src/platform_impl/x11/mod.rs. The unused example manifest entries are omitted.

WI-4480: after unregister, the key remained grabbed until another registration
flushed the connection. Failed registration could likewise retain partial grabs.
Backport of https://github.com/tauri-apps/global-hotkey/pull/197, which remains
unreleased. Reuses the desktop's existing Cargo patch mechanism. Remove this
patch when a released global-hotkey includes the fix.

tests/global_shortcut_x11.rs in the desktop Cargo suite checks both cases using
the public manager and a second X11 client on a private Xvfb display. Both tests
failed against the unpatched release; they must pass with this patch. It does
not use the owner's display or change the parent test process's DISPLAY.
