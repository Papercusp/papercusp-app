// PapercuspTermShim — C-ABI surface the Rust desktop dlopens (D-009 macOS).
//
// One exported function attaches a live SwiftTerm terminal (a real native
// terminal view with its own pty — CPU-native, accepted per D-005) INSIDE the
// Tauri window: the WKWebView is shrunk to the right portion and the terminal
// takes the left band (P-014: terminal left, GUI right), both with
// autoresizing so the split tracks window resizes. Must be called on the main
// thread (the Rust side hops via run_on_main_thread).
import AppKit
import SwiftTerm
import WebKit

/// Find the WKWebView anywhere under `view` (tauri/wry nests it).
private func findWebView(_ view: NSView) -> NSView? {
    if view is WKWebView { return view }
    for sub in view.subviews {
        if let hit = findWebView(sub) { return hit }
    }
    return nil
}

/// Attach a terminal hosting `exe` (NUL-separated `args`) to the LEFT
/// `fraction` of the window's content view, shrinking the webview to the
/// remainder. Returns an opaque retained pointer to the terminal view (kept
/// for the window's lifetime), or nil on failure.
@_cdecl("pcterm_attach_left")
public func pcterm_attach_left(
    _ nsWindowPtr: UnsafeMutableRawPointer?,
    _ fraction: Double,
    _ minPx: Double,
    _ maxPx: Double,
    _ exe: UnsafePointer<CChar>?,
    _ argsBlob: UnsafePointer<CChar>?,
    _ argsLen: Int32
) -> UnsafeMutableRawPointer? {
    guard let nsWindowPtr, let exe else { return nil }
    let window = Unmanaged<NSWindow>.fromOpaque(nsWindowPtr).takeUnretainedValue()
    guard let content = window.contentView else { return nil }
    let bounds = content.bounds
    let extent = min(max(bounds.width * fraction, minPx), max(maxPx, minPx))

    // Terminal: left band, full height, themed dark (matches the GUI; also
    // makes the band visually unambiguous on an unstyled webview). Autoresize
    // height so the band tracks window resizes.
    let term = LocalProcessTerminalView(
        frame: NSRect(x: 0, y: 0, width: extent, height: bounds.height))
    term.autoresizingMask = [.height]
    term.nativeBackgroundColor = NSColor(red: 0.027, green: 0.063, blue: 0.114, alpha: 1) // #07101d
    term.nativeForegroundColor = NSColor(red: 0.906, green: 0.969, blue: 1.000, alpha: 1) // #e7f7ff

    // Shrink the webview to the right remainder (width tracks the window).
    if let webview = findWebView(content) {
        webview.frame = NSRect(
            x: extent, y: 0, width: bounds.width - extent, height: bounds.height)
        webview.autoresizingMask = [.width, .height]
    }
    // positioned .above: never let a later sibling (the webview re-layout)
    // cover the band.
    content.addSubview(term, positioned: .above, relativeTo: nil)

    // argsBlob: NUL-separated argv tail (exe is argv[0]).
    var args: [String] = []
    if let argsBlob, argsLen > 0 {
        let data = Data(bytes: argsBlob, count: Int(argsLen))
        args = data.split(separator: 0).compactMap { String(data: $0, encoding: .utf8) }
    }
    // Forward THIS process's environment to the child. SwiftTerm defaults to a
    // MINIMAL env when `environment` is nil — which omits the bundled-bin PATH +
    // PUI_COMPANION_WASM that native_terminal::prepare_dock_env sets on the app
    // process. Without forwarding, `pui` can't find `zellij` on PATH and the
    // dock pane stays BLANK (chat-dock bundling, WI-668). Ensure the terminal
    // vars are present regardless of the inherited env.
    var env = ProcessInfo.processInfo.environment
    if env["TERM"] == nil { env["TERM"] = "xterm-256color" }
    if env["COLORTERM"] == nil { env["COLORTERM"] = "truecolor" }
    let envArray = env.map { "\($0.key)=\($0.value)" }
    term.startProcess(executable: String(cString: exe), args: args, environment: envArray)
    return Unmanaged.passRetained(term).toOpaque()
}

/// WI-3388: re-layout an already-attached terminal (from `pcterm_attach_left`,
/// whose retained pointer the Rust side now keeps instead of discarding) to a
/// new LEFT `fraction`, or fully collapsed (`collapsed == true`, extent 0 —
/// the terminal view is hidden and the webview takes the full window; the
/// re-open rail control itself lives in the webview, at its now-flush left
/// edge). Must be called on the main thread (the Rust side hops via
/// `run_on_main_thread`, same as the initial attach). Returns false if the
/// window/terminal pointers are stale (e.g. the window closed).
@_cdecl("pcterm_set_layout")
public func pcterm_set_layout(
    _ nsWindowPtr: UnsafeMutableRawPointer?,
    _ termPtr: UnsafeMutableRawPointer?,
    _ fraction: Double,
    _ minPx: Double,
    _ maxPx: Double,
    _ collapsed: Bool
) -> Bool {
    guard let nsWindowPtr, let termPtr else { return false }
    let window = Unmanaged<NSWindow>.fromOpaque(nsWindowPtr).takeUnretainedValue()
    guard let content = window.contentView else { return false }
    let term = Unmanaged<LocalProcessTerminalView>.fromOpaque(termPtr).takeUnretainedValue()
    let bounds = content.bounds
    let extent: CGFloat = collapsed
        ? 0
        : min(max(bounds.width * fraction, minPx), max(maxPx, minPx))

    term.frame = NSRect(x: 0, y: 0, width: extent, height: bounds.height)
    term.isHidden = collapsed
    if let webview = findWebView(content) {
        webview.frame = NSRect(
            x: extent, y: 0, width: bounds.width - extent, height: bounds.height)
    }
    return true
}
