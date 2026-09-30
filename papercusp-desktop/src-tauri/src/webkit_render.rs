//! WebKitGTK renderer feature tuning (Linux only; a no-op everywhere else).
//!
//! WHY THIS EXISTS — WI-6502, "typing into the chat boxes is very laggy".
//!
//! Measured in a live headless instance: a keystroke in a focused text field
//! invalidates the ENTIRE VIEWPORT, so the per-keystroke cost is proportional to
//! everything painting viewport-sized rather than to the caret box. A 10x10px
//! invalidation costs the same as a no-op frame (~17ms), so small damage is
//! genuinely cheap — the problem is purely that the damage is not small.
//!
//! The cause is not our CSS and not a "platform floor". WebKitGTK 2.52.3 ships
//! ~486 toggleable features, and their defaults on this build are:
//!
//!     PropagateDamagingInformation           default TRUE
//!     UseDamagingInformationForCompositing   default FALSE   <-- the problem
//!     UnifyDamagedRegions                    default TRUE
//!
//! i.e. WebKit computes and propagates fine-grained damage and then does not use
//! it for compositing, so the compositor repaints the whole viewport regardless.
//! Turning the second one on makes the compositor honour the damage rects.
//!
//! ⚠ THAT IS THE THEORY, AND IT IS STILL UNPROVEN. See DAMAGE_DEFAULT_ON below:
//! the flag is applied only when explicitly asked for, because a counterbalanced
//! A/B could not resolve any effect from it -- boot order moved the numbers more
//! than the feature did. Everything above this line is the hypothesis this module
//! was built to test, not a description of how the app is configured, and not a
//! finding -- do not read it as either.
//!
//! Related and deliberately NOT the fix here (both measured, both dead ends):
//!   - compositing-layer promotion (`will-change`, `contain:paint`) of the heavy
//!     decorative surfaces: +1ms / +2ms, null in every paired round. Expected —
//!     when the damage rect is the whole viewport, every layer intersects it.
//!   - re-enabling the DMA-BUF renderer (main.rs force-disables it on NVIDIA):
//!     the webview runs JS but never presents a frame at all on driver 580, and
//!     the SHM-transport variant measured *worse* than shipping config.

/// Feature identifier => desired enabled state.
///
/// Keep this list SHORT and justified. Each entry is an experimental or
/// development WebKit feature, so each one needs its own measurement before it
/// earns a place here.
#[cfg(target_os = "linux")]
const DESIRED_FEATURES: &[(&str, bool)] = &[
    // Make the compositor actually honour the damage rects WebKit already
    // computes, instead of repainting the full viewport on every frame.
    ("UseDamagingInformationForCompositing", true),
];

/// Env escape hatch: `PAPERCUSP_WEBKIT_DAMAGE_COMPOSITING=0` restores stock
/// WebKit behaviour, `=1` forces it on. Launch-time renderer configuration, not
/// a product feature toggle — product features belong in `libs/flags`.
#[cfg(target_os = "linux")]
const DAMAGE_ENV: &str = "PAPERCUSP_WEBKIT_DAMAGE_COMPOSITING";

/// Whether the damage-compositing feature is applied when the env var is unset.
///
/// FALSE — but for "unproven", NOT for "measured harmful". Measured 2026-07-28.
///
/// It first defaulted to true on a dmgON-ONLY boot. Adding the dmgOFF control
/// showed stock WebKit measures the same, so that was never evidence it helped.
/// A second pass then looked like it proved the opposite -- and did not:
///
///   run13 (OFF booted first, ON second): OFF 936ms, ON 1181ms  -> "ON is worse"
///   run14 (ON booted first, OFF second): ON 1103ms, OFF 1167ms -> "OFF is worse"
///   (median wall time to type 20 chars at the 33ms key-repeat interval)
///
/// In BOTH runs the arm that booted SECOND was the slower one, whichever flag it
/// carried. That is a boot-order effect, and it is larger than any flag effect
/// present -- so this A/B design cannot resolve the feature at all, in either
/// direction. Counterbalancing is the only reason we know that; a single-order
/// A/B would have "confirmed" whichever answer it was run in the order of.
///
/// So: no demonstrated benefit and no demonstrated harm. It stays OFF because an
/// experimental WebKit feature with no measured benefit should not ship enabled,
/// not because it was shown to hurt. To settle it properly you need a design that
/// survives the order confound (alternate arms across many boots, or flip the
/// feature WITHIN one boot if WebKit ever allows it at runtime) plus the
/// stale-pixel check -- damage-based compositing that under-reports a dirty rect
/// leaves torn/ghosted pixels, which no timing probe can see.
///
/// Measurement note for whoever picks this up: the marginal cost of a character
/// is (burst - shamburst)/N against an in-run NO-TYPING control. 20 chained
/// setTimeout(33) already take ~715ms on this box with nothing typed, so raw
/// "drift vs 660ms ideal" is mostly the probe. Do NOT use a single-keystroke
/// worst-frame metric to clear anything: it read 0 in both arms in the same boot
/// where the burst metric measured ~18-22ms/char, i.e. it is blind at that scale.
#[cfg(target_os = "linux")]
const DAMAGE_DEFAULT_ON: bool = false;

#[cfg(target_os = "linux")]
fn damage_compositing_wanted() -> bool {
    parse_damage_compositing_wanted(std::env::var(DAMAGE_ENV).ok().as_deref())
}

/// The pure parsing half of `damage_compositing_wanted`, split out so the unit
/// tests below can exercise every branch by passing a value in directly instead
/// of mutating the process-global env var.
///
/// EI-18869717910251502: Rust runs unit tests for one binary on multiple
/// threads in a single process, so two tests that both call
/// `std::env::set_var`/`remove_var` on the SAME key race each other — a
/// different one flakes on every run, which is exactly what was observed here.
/// Reading the env only at the one real call site above (`damage_compositing_wanted`)
/// and testing this function instead removes the shared mutable state the race
/// needed, rather than locking around it.
#[cfg(target_os = "linux")]
fn parse_damage_compositing_wanted(raw: Option<&str>) -> bool {
    match raw {
        Some("0") | Some("false") => false,
        Some("1") | Some("true") => true,
        _ => DAMAGE_DEFAULT_ON,
    }
}

#[cfg(target_os = "linux")]
mod ffi_features {
    use std::ffi::{c_char, c_int};

    #[repr(C)]
    pub struct WebKitFeature {
        _private: [u8; 0],
    }
    #[repr(C)]
    pub struct WebKitFeatureList {
        _private: [u8; 0],
    }

    // Present in libwebkit2gtk-4.1.so.0 (WebKitGTK >= 2.42) but not bound by the
    // webkit2gtk 2.0.2 crate, so we declare them directly. Verified present on
    // the shipping lib with `strings | grep '^webkit_feature_'`.
    extern "C" {
        pub fn webkit_settings_get_all_features() -> *mut WebKitFeatureList;
        pub fn webkit_feature_list_get_length(list: *mut WebKitFeatureList) -> usize;
        pub fn webkit_feature_list_get(
            list: *mut WebKitFeatureList,
            index: usize,
        ) -> *mut WebKitFeature;
        pub fn webkit_feature_list_unref(list: *mut WebKitFeatureList);
        pub fn webkit_feature_get_identifier(feature: *mut WebKitFeature) -> *const c_char;
        pub fn webkit_settings_set_feature_enabled(
            settings: *mut webkit2gtk::ffi::WebKitSettings,
            feature: *mut WebKitFeature,
            enabled: c_int,
        );
        pub fn webkit_settings_get_feature_enabled(
            settings: *mut webkit2gtk::ffi::WebKitSettings,
            feature: *mut WebKitFeature,
        ) -> c_int;
    }
}

/// Apply `DESIRED_FEATURES` to the main window's webview.
///
/// Fail-soft everywhere: a missing window, a missing settings object, or a
/// WebKit build without a given feature is logged and skipped, never fatal — a
/// renderer tweak must not be able to prevent the app from starting.
#[cfg(target_os = "linux")]
pub fn init(app: &tauri::App) {
    use tauri::Manager;

    let Some(window) = app.get_webview_window("main") else {
        // Headless / non-GUI role has no window and legitimately wants none.
        // Logged rather than silently skipped: a silent no-op here is
        // indistinguishable from "the renderer fix didn't help".
        eprintln!("[webkit-render] no main webview window at setup — features not applied");
        return;
    };

    let want_damage = damage_compositing_wanted();

    let res = window.with_webview(move |webview| {
        use webkit2gtk::glib::translate::ToGlibPtr;
        use webkit2gtk::WebViewExt;

        let wv: webkit2gtk::WebView = webview.inner();
        let Some(settings) = wv.settings() else {
            eprintln!("[webkit-render] no WebKitSettings on the webview — skipped");
            return;
        };
        let settings_ptr: *mut webkit2gtk::ffi::WebKitSettings = settings.to_glib_none().0;

        unsafe {
            let list = ffi_features::webkit_settings_get_all_features();
            if list.is_null() {
                eprintln!("[webkit-render] webkit_settings_get_all_features() returned null");
                return;
            }
            let len = ffi_features::webkit_feature_list_get_length(list);
            let mut applied = 0usize;

            for i in 0..len {
                let feature = ffi_features::webkit_feature_list_get(list, i);
                if feature.is_null() {
                    continue;
                }
                let raw = ffi_features::webkit_feature_get_identifier(feature);
                if raw.is_null() {
                    continue;
                }
                let Ok(ident) = std::ffi::CStr::from_ptr(raw).to_str() else {
                    continue;
                };

                let Some((_, mut desired)) = DESIRED_FEATURES
                    .iter()
                    .copied()
                    .find(|(name, _)| *name == ident)
                else {
                    continue;
                };
                if ident == "UseDamagingInformationForCompositing" {
                    desired = want_damage;
                }

                let before =
                    ffi_features::webkit_settings_get_feature_enabled(settings_ptr, feature);
                ffi_features::webkit_settings_set_feature_enabled(
                    settings_ptr,
                    feature,
                    if desired { 1 } else { 0 },
                );
                let after =
                    ffi_features::webkit_settings_get_feature_enabled(settings_ptr, feature);

                // Read back rather than trusting the setter: an unknown or
                // locked feature silently keeps its old value, and a silent
                // no-op here would look exactly like "the fix didn't help".
                eprintln!(
                    "[webkit-render] {ident}: {} -> {} (requested {})",
                    before != 0,
                    after != 0,
                    desired
                );
                if (after != 0) == desired {
                    applied += 1;
                }
            }

            ffi_features::webkit_feature_list_unref(list);
            eprintln!(
                "[webkit-render] applied {applied}/{} feature(s) of {len} available",
                DESIRED_FEATURES.len()
            );
        }
    });

    if let Err(e) = res {
        eprintln!("[webkit-render] with_webview failed — renderer features not applied: {e}");
    }
}

#[cfg(not(target_os = "linux"))]
pub fn init(_app: &tauri::App) {}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    // EI-18869717910251502: these used to go through a `with_env` helper that
    // mutated the shared process env var, which raced other tests in the same
    // binary (Rust runs unit tests multi-threaded in one process) — a
    // different test failed on every run. Calling the pure parsing function
    // directly needs no shared mutable state at all, so there is nothing left
    // to race.
    #[test]
    fn env_overrides_default_both_ways() {
        assert!(parse_damage_compositing_wanted(Some("1")));
        assert!(parse_damage_compositing_wanted(Some("true")));
        assert!(!parse_damage_compositing_wanted(Some("0")));
        assert!(!parse_damage_compositing_wanted(Some("false")));
    }

    #[test]
    fn unset_and_garbage_fall_back_to_the_default() {
        assert_eq!(parse_damage_compositing_wanted(None), DAMAGE_DEFAULT_ON);
        assert_eq!(
            parse_damage_compositing_wanted(Some("yes-please")),
            DAMAGE_DEFAULT_ON
        );
    }

    #[test]
    fn desired_features_are_unique_and_named() {
        for (name, _) in DESIRED_FEATURES {
            assert!(!name.is_empty());
            assert_eq!(
                DESIRED_FEATURES.iter().filter(|(n, _)| n == name).count(),
                1,
                "duplicate entry for {name}"
            );
        }
    }
}
