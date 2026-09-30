//! Operator-turn control-tag parsing for the chat pane (tui-operator-surface).
//!
//! The operator brain wraps its user-visible utterance in `<say>…</say>` and
//! emits other control tags (`<set_mode>`, `<sleep …>`, `<continue/>`,
//! `<spawn …>`) in the SAME streamed turn. Desktop renders only the `<say>`
//! body; the TUI pane mirrors that. This is a focused Rust port of the
//! extraction half of `packages/operator-core/lib/operator-converse-tags.ts`
//! (`parseOperatorTurn`) — the parts the chat pane needs:
//!
//!   - [`finalize`]    — the user-visible text of a COMPLETED turn (say-or-fallback).
//!   - [`live_preview`] — best-effort text of an IN-PROGRESS (still streaming) turn.
//!   - [`extract_say`]  — the inner of a complete `<say>…</say>`, if present.
//!
//! Pure string work, no regex dependency: tag names are ASCII, so we scan
//! case-insensitively over bytes and slice the original `&str` at the (always
//! char-boundary) ASCII offsets.

use serde::{Deserialize, Serialize};

// ─── <report> structured-status tag (structured-report-protocol-2026-06-05) ───
//
// The operator emits a `<report>{json}</report>` tag alongside `<say>`, carrying
// a JSON object of per-plan/per-item status. The pane renders it as a two-tiered
// plan→item list below the say. The JSON shape matches the desktop's ParsedReport
// (operator-converse-tags.ts), so the same payload round-trips both surfaces.

/// One item (the inner tier) of a `<report>` plan block.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ReportItem {
    #[serde(default)]
    pub id: Option<String>,
    /// Item text. Required; falls back to `id` when blank, else the item is dropped.
    #[serde(default)]
    pub text: String,
    /// Free-string status (todo|wip|done|blocked|…); rendered via `Theme::status_marker`.
    #[serde(default)]
    pub status: Option<String>,
}

/// One plan (the outer tier) of a `<report>`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ReportPlan {
    #[serde(default)]
    pub slug: Option<String>,
    /// Plan title/label. Falls back to `slug` when blank, else the block is dropped.
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub items: Vec<ReportItem>,
}

/// A parsed `<report>` payload — the structured per-plan/per-item status.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Report {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub plans: Vec<ReportPlan>,
}

/// Parse the first complete `<report>…</report>` JSON body into a [`Report`].
/// `None` when there's no complete tag (e.g. still streaming), the body isn't
/// valid JSON of the expected shape, or no valid plan block survives. Defensive
/// like the desktop `parseReportBody`: blocks with no title/slug and items with
/// no text/id are skipped rather than failing the whole parse.
pub fn extract_report(raw: &str) -> Option<Report> {
    let open = find_tag(raw, "<report>", 0)?;
    let after = open + "<report>".len();
    let close = find_tag(raw, "</report>", after)?;
    let body = raw[after..close].trim();
    let mut report: Report = serde_json::from_str(body).ok()?;
    normalize_report(&mut report);
    if report.plans.is_empty() {
        None
    } else {
        Some(report)
    }
}

/// Trim a string and `None` it when blank.
fn normalize_opt(o: &mut Option<String>) {
    if let Some(s) = o {
        let t = s.trim();
        if t.is_empty() {
            *o = None;
        } else if t.len() != s.len() {
            *o = Some(t.to_string());
        }
    }
}

/// Drop empty/label-less blocks + items, with the title→slug / text→id fallbacks
/// (mirrors the desktop `parseReportBody`).
fn normalize_report(r: &mut Report) {
    normalize_opt(&mut r.title);
    r.plans.retain_mut(|p| {
        let title = if p.title.trim().is_empty() {
            p.slug
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        } else {
            Some(p.title.trim().to_string())
        };
        match title {
            Some(t) => p.title = t,
            None => return false,
        }
        normalize_opt(&mut p.slug);
        normalize_opt(&mut p.status);
        normalize_opt(&mut p.summary);
        p.items.retain_mut(|it| {
            let text = if it.text.trim().is_empty() {
                it.id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            } else {
                Some(it.text.trim().to_string())
            };
            match text {
                Some(t) => it.text = t,
                None => return false,
            }
            normalize_opt(&mut it.id);
            normalize_opt(&mut it.status);
            true
        });
        true
    });
}

/// The inner body of the first complete `<say>…</say>`, trimmed. `None` when
/// there's no complete say tag or the body is empty.
pub fn extract_say(raw: &str) -> Option<String> {
    let open = find_tag(raw, "<say>", 0)?;
    let after = open + "<say>".len();
    let close = find_tag(raw, "</say>", after)?;
    let inner = raw[after..close].trim();
    if inner.is_empty() {
        None
    } else {
        Some(inner.to_string())
    }
}

/// The user-visible text of a COMPLETED operator turn. Mirrors
/// `parseOperatorTurn`'s say-resolution: prefer `<say>`; if the turn is a
/// going-silent `<sleep>` with no say, render nothing; else fall back to the
/// raw prose with all control tags stripped.
pub fn finalize(raw: &str) -> String {
    if let Some(say) = extract_say(raw) {
        return say;
    }
    // A <sleep> with no <say> is the "going silent" contract — no text.
    if find_tag(raw, "<sleep", 0).is_some() {
        return String::new();
    }
    strip_control_tags(raw).trim().to_string()
}

/// Best-effort text for an IN-PROGRESS turn (called on each delta while
/// streaming). Shows a complete say if one has arrived; otherwise the
/// in-flight content after an open `<say>` (minus any partial trailing tag);
/// otherwise the tag-stripped prose so far.
pub fn live_preview(raw: &str) -> String {
    if let Some(say) = extract_say(raw) {
        return say;
    }
    if let Some(open) = find_tag(raw, "<say>", 0) {
        let inner = &raw[open + "<say>".len()..];
        // Drop a partial trailing tag (e.g. a half-streamed `</sa`).
        let inner = inner.split('<').next().unwrap_or(inner);
        return inner.trim().to_string();
    }
    if find_tag(raw, "<sleep", 0).is_some() {
        return String::new();
    }
    strip_control_tags(raw).trim().to_string()
}

// (live_preview's no-tag fallback shares strip_control_tags via the body above.)

/// Case-insensitive (ASCII) search for `tag` in `hay` starting at byte `from`.
/// Returns the byte offset of the match. Tags are ASCII, so the returned
/// offset is always a `&str` char boundary.
fn find_tag(hay: &str, tag: &str, from: usize) -> Option<usize> {
    let hb = hay.as_bytes();
    let tb = tag.as_bytes();
    if tb.is_empty() || from >= hb.len() || tb.len() > hb.len() {
        return None;
    }
    let mut i = from;
    while i + tb.len() <= hb.len() {
        if hb[i..i + tb.len()].eq_ignore_ascii_case(tb) {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Strip operator control tags from prose (the fallback when there's no `<say>`).
/// First removes paired `<set_mode>…</set_mode>` blocks INCLUDING their content
/// (matching `parseOperatorTurn`'s fallback), then drops all remaining standalone
/// tag markup (`<continue/>`, `<spawn …/>`, `<sleep …/>`, a partial trailing
/// `<…`). The user-visible prose is what's left.
fn strip_control_tags(s: &str) -> String {
    let mut work = s.to_string();
    // Remove paired <report>…</report> spans (the JSON body would otherwise leak
    // into the fallback prose — strip_markup only drops `<…>` markup, not the
    // JSON between the tags). structured-report-protocol D-004.
    while let Some(open) = find_tag(&work, "<report>", 0) {
        match find_tag(&work, "</report>", open) {
            Some(close) => {
                let end = close + "</report>".len();
                work.replace_range(open..end, "");
            }
            None => break, // unclosed (mid-stream) — leave it for the markup strip
        }
    }
    // Remove paired <set_mode>…</set_mode> spans (content included).
    while let Some(open) = find_tag(&work, "<set_mode>", 0) {
        match find_tag(&work, "</set_mode>", open) {
            Some(close) => {
                let end = close + "</set_mode>".len();
                work.replace_range(open..end, "");
            }
            None => break, // unclosed — leave it for the markup strip below
        }
    }
    strip_markup(&work)
}

/// Drop everything inside `<…>` (markup only), leaving prose. A trailing unclosed
/// `<` (a partial tag mid-stream) and its remainder are dropped.
fn strip_markup(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0u32;
    for ch in s.chars() {
        match ch {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_say_basic() {
        assert_eq!(
            extract_say("<say>hello there</say>").as_deref(),
            Some("hello there")
        );
        // Surrounding tags + whitespace.
        assert_eq!(
            extract_say("<set_mode>active</set_mode>\n<say>  hi  </say>\n").as_deref(),
            Some("hi"),
        );
        // Case-insensitive tag match.
        assert_eq!(extract_say("<SAY>Yo</SAY>").as_deref(), Some("Yo"));
        // No say / empty say → None.
        assert_eq!(extract_say("just prose"), None);
        assert_eq!(extract_say("<say>   </say>"), None);
        assert_eq!(extract_say("<say>unclosed"), None);
    }

    #[test]
    fn finalize_prefers_say_and_drops_other_tags() {
        assert_eq!(
            finalize("<say>The carve is done.</say><set_mode>passive</set_mode>"),
            "The carve is done.",
        );
    }

    #[test]
    fn finalize_sleep_without_say_is_silent() {
        assert_eq!(
            finalize("<sleep duration_minutes=\"5\" reason=\"busy\"/>"),
            ""
        );
        // sleep + prose noise around it → still silent (no say).
        assert_eq!(finalize("ok <sleep duration_minutes=\"2\"/> bye"), "");
    }

    #[test]
    fn finalize_falls_back_to_bare_prose() {
        // Model emitted prose without a <say> wrapper → show it.
        assert_eq!(finalize("Here is the answer."), "Here is the answer.");
        // set_mode-only around bare prose → strip the tag, keep prose.
        assert_eq!(
            finalize("<set_mode>passive</set_mode>I'll wait."),
            "I'll wait.",
        );
        // A <spawn> tag with no say is stripped from the fallback.
        assert_eq!(
            finalize("Spawning a worker. <spawn role=\"worker\" feature=\"F-1\"/>"),
            "Spawning a worker.",
        );
    }

    #[test]
    fn live_preview_shows_in_progress_say() {
        // Complete say wins.
        assert_eq!(live_preview("<say>done</say>"), "done");
        // Open say, still streaming — show the partial body.
        assert_eq!(live_preview("<say>typing in prog"), "typing in prog");
        // Partial trailing close tag is trimmed off.
        assert_eq!(live_preview("<say>almost</sa"), "almost");
        // Before any say tag arrives → empty (we haven't started the utterance).
        assert_eq!(live_preview("<set_mode>active</set_mode>"), "");
        // Bare prose (no tags yet) shows as-is.
        assert_eq!(live_preview("partial prose"), "partial prose");
    }

    #[test]
    fn extract_report_parses_plans_and_items() {
        let raw = concat!(
            "<say>Fleet status.</say>",
            r#"<report>{"title":"Fleet","plans":[{"slug":"rate-limit-layer-v2",
               "title":"Rate-limit v2","status":"active","items":[
               {"id":"P-001","text":"Error classifier","status":"done"},
               {"id":"P-003","text":"Per-call pacing","status":"wip"}]}]}</report>"#,
        );
        let r = extract_report(raw).expect("report parses");
        assert_eq!(r.title.as_deref(), Some("Fleet"));
        assert_eq!(r.plans.len(), 1);
        assert_eq!(r.plans[0].title, "Rate-limit v2");
        assert_eq!(r.plans[0].slug.as_deref(), Some("rate-limit-layer-v2"));
        assert_eq!(r.plans[0].status.as_deref(), Some("active"));
        assert_eq!(r.plans[0].items.len(), 2);
        assert_eq!(r.plans[0].items[0].text, "Error classifier");
        assert_eq!(r.plans[0].items[1].status.as_deref(), Some("wip"));
    }

    #[test]
    fn extract_report_applies_fallbacks_and_skips_invalid() {
        // title→slug fallback; item text→id fallback; blocks/items with neither dropped.
        let raw = r#"<report>{"plans":[
            {"status":"active"},
            {"slug":"alpha","items":[{"status":"done"},{"id":"P-9"},{"text":"real"}]}
        ]}</report>"#;
        let r = extract_report(raw).expect("one valid plan survives");
        assert_eq!(r.plans.len(), 1);
        assert_eq!(r.plans[0].title, "alpha"); // title fell back to slug
                                               // The status-only item is dropped; id-only falls back to its id as text.
        assert_eq!(r.plans[0].items.len(), 2);
        assert_eq!(r.plans[0].items[0].text, "P-9");
        assert_eq!(r.plans[0].items[1].text, "real");
    }

    #[test]
    fn extract_report_none_on_malformed_partial_or_empty() {
        assert!(extract_report("<report>{not json}</report>").is_none());
        assert!(extract_report(r#"<report>{"plans":[{"status":"x"}]}</report>"#).is_none()); // no titled plan
        assert!(extract_report(r#"<report>{"plans":[]}</report>"#).is_none());
        assert!(extract_report(r#"<report>{"plans":"nope"}</report>"#).is_none());
        // Still streaming — no closing tag yet → None (no flicker).
        assert!(extract_report(r#"<report>{"plans":[{"title":"x"}"#).is_none());
        // No tag at all.
        assert!(extract_report("<say>hi</say>").is_none());
    }

    #[test]
    fn finalize_strips_a_stray_report_from_prose_fallback() {
        // Model forgot the <say> wrapper — the report JSON must NOT leak as prose.
        assert_eq!(
            finalize(r#"<report>{"plans":[{"title":"x"}]}</report>"#),
            "",
        );
        // A <say> still wins and the report doesn't bleed into it.
        assert_eq!(
            finalize(r#"<say>ok</say><report>{"plans":[{"title":"x"}]}</report>"#),
            "ok",
        );
    }
}
