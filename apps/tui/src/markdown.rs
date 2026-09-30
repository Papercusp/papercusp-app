//! Streaming-safe markdown → ratatui `Line`s for the chat transcript.
//! (P-005 slice 5, plan `own-tui-full-divorce-2026-08-24`.)
//!
//! WHY THIS IS HAND-ROLLED — the reuse-first question, answered once so nobody
//! re-litigates it. No CommonMark crate is in this tree, and adding one would
//! not do the job:
//!
//! 1. The subject is a PARTIAL document. A model streams `**important` one
//!    token at a time, and a whole-document parser must render the raw `**`
//!    until the closer arrives — so the pane visibly thrashes as text lands.
//!    The open-delimiter rule below (`open_ok`) styles an unmatched *trailing*
//!    delimiter as though it were already closed. That stability IS the
//!    feature being asked for, and no parser offers it, because for a complete
//!    document it would be wrong.
//! 2. The bulk of the work is reflowing styled runs into width-wrapped
//!    `Line<'static>` values with hanging indents. pulldown-cmark emits an
//!    event stream and does none of that; the adapter would be about the size
//!    of this file, with a new dependency underneath it.
//!
//! NO INCREMENTAL PARSER STATE: `render` re-parses the whole body on every
//! frame. That is what makes it streaming-safe — there is no half-updated
//! parse to resync when the next delta arrives, so a token can never land the
//! renderer in a state the text does not justify.
//!
//! Scope is deliberately bounded to what agent output actually contains:
//! fenced code, inline code, bold, italic, ATX headings, bullet/ordered lists,
//! blockquotes. Links render literally — a terminal cannot click one, and the
//! URL is the half worth reading.

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use crate::theme::Theme;

/// Code hue. Deliberately NOT `Theme::info()`: that style is bold, and bold is
/// already spoken for by `**bold**`. Two different markups that render
/// identically stop carrying information, so they must stay distinguishable.
fn code_style() -> Style {
    Style::default().fg(Theme::active().sky)
}

/// One styled run of text produced by inline parsing.
#[derive(Debug, Clone, PartialEq)]
struct Seg {
    text: String,
    style: Style,
}

impl Seg {
    fn new(text: impl Into<String>, style: Style) -> Self {
        Self {
            text: text.into(),
            style,
        }
    }
}

/// Render `body` as markdown into styled lines bounded to `width` columns.
///
/// `streaming` enables the open-delimiter rule, and only on the final line —
/// a settled message is never reinterpreted, because once the turn is done an
/// unmatched `**` is simply text the model wrote.
pub fn render(body: &str, width: usize, streaming: bool) -> Vec<Line<'static>> {
    let width = width.max(8);
    let mut out: Vec<Line<'static>> = Vec::new();
    let lines: Vec<&str> = body.split('\n').collect();
    let last_idx = lines.len().saturating_sub(1);
    let mut in_fence = false;

    for (idx, raw) in lines.iter().enumerate() {
        let trimmed = raw.trim_start();

        // ── fenced code ──────────────────────────────────────────────────
        if trimmed.starts_with("```") {
            if in_fence {
                in_fence = false;
            } else {
                in_fence = true;
                let lang = trimmed.trim_start_matches('`').trim();
                if !lang.is_empty() {
                    out.push(Line::from(Span::styled(format!("  {lang}"), Theme::dim())));
                }
            }
            continue;
        }
        if in_fence {
            // Code is never WORD-wrapped: a hard split at the margin preserves
            // indentation and alignment, which is the entire point of a code
            // block. Reflowing it would silently corrupt what it shows.
            for chunk in hard_split(raw, width.saturating_sub(2)) {
                out.push(Line::from(Span::styled(format!("  {chunk}"), code_style())));
            }
            continue;
        }

        if trimmed.is_empty() {
            out.push(Line::from(""));
            continue;
        }

        let open_ok = streaming && idx == last_idx;

        // ── ATX heading ──────────────────────────────────────────────────
        if let Some(rest) = atx_heading(trimmed) {
            let segs = parse_inline(rest, Theme::header(), open_ok);
            out.extend(wrap_segs(&segs, width, None, 0));
            continue;
        }

        // ── blockquote ───────────────────────────────────────────────────
        if let Some(rest) = trimmed.strip_prefix('>') {
            let segs = parse_inline(rest.trim_start(), Theme::dim(), open_ok);
            out.extend(wrap_segs(
                &segs,
                width,
                Some(("│ ".to_string(), Theme::dim())),
                2,
            ));
            continue;
        }

        // ── bullet / ordered list ────────────────────────────────────────
        if let Some((marker, rest)) = list_item(trimmed) {
            let indent = leading_spaces(raw).min(8);
            let prefix = format!("{}{} ", " ".repeat(indent), marker);
            let cont = prefix.chars().count();
            let segs = parse_inline(rest, Style::default(), open_ok);
            out.extend(wrap_segs(&segs, width, Some((prefix, Theme::dim())), cont));
            continue;
        }

        // ── paragraph ────────────────────────────────────────────────────
        let segs = parse_inline(raw, Style::default(), open_ok);
        out.extend(wrap_segs(&segs, width, None, 0));
    }
    out
}

/// Parse inline markup into styled runs.
///
/// `open_ok` is the STREAMING rule: when true, an unmatched OPENING delimiter
/// styles the remainder of the text instead of rendering the raw delimiter.
fn parse_inline(src: &str, base: Style, open_ok: bool) -> Vec<Seg> {
    let mut out: Vec<Seg> = Vec::new();
    let mut lit = String::new();
    let chars: Vec<char> = src.chars().collect();
    let mut i = 0usize;

    macro_rules! flush_lit {
        () => {
            if !lit.is_empty() {
                out.push(Seg::new(std::mem::take(&mut lit), base));
            }
        };
    }

    while i < chars.len() {
        let c = chars[i];

        // `code` — highest precedence: markup inside a code span is literal.
        //
        // A RUN of n backticks opens a span that closes at the next run of
        // EXACTLY n (CommonMark). Matching a single backtick instead would
        // make ``a ` b`` unrepresentable, and — the reason this is written
        // out rather than assumed — would treat a bare `` as an empty span
        // and DELETE both characters the model wrote.
        if c == '`' {
            let open = run_len(&chars, i, '`');
            if let Some(close) = find_run_of(&chars, i + open, '`', open) {
                flush_lit!();
                out.push(Seg::new(
                    chars[i + open..close].iter().collect::<String>(),
                    code_style(),
                ));
                i = close + open;
                continue;
            }
            if open_ok {
                flush_lit!();
                let inner: String = chars[i + open..].iter().collect();
                if !inner.is_empty() {
                    out.push(Seg::new(inner, code_style()));
                }
                break;
            }
            // Unmatched in settled text: every backtick of the run is literal.
            for _ in 0..open {
                lit.push('`');
            }
            i += open;
            continue;
        }

        // **bold** — checked before *italic* so `**` is never two italics.
        if c == '*' && chars.get(i + 1) == Some(&'*') {
            if let Some(end) = find_run(&chars, i + 2, '*', 2) {
                flush_lit!();
                let inner: String = chars[i + 2..end].iter().collect();
                out.extend(parse_inline(
                    &inner,
                    base.add_modifier(Modifier::BOLD),
                    false,
                ));
                i = end + 2;
                continue;
            }
            if open_ok {
                flush_lit!();
                let inner: String = chars[i + 2..].iter().collect();
                out.extend(parse_inline(
                    &inner,
                    base.add_modifier(Modifier::BOLD),
                    true,
                ));
                break;
            }
            lit.push(c);
            i += 1;
            continue;
        }

        // *italic* — only when the `*` actually opens a word, so `2 * 3` and a
        // stray asterisk stay literal.
        if c == '*' && opens_emphasis(&chars, i) {
            if let Some(end) = find_closing_emph(&chars, i + 1) {
                flush_lit!();
                let inner: String = chars[i + 1..end].iter().collect();
                out.extend(parse_inline(
                    &inner,
                    base.add_modifier(Modifier::ITALIC),
                    false,
                ));
                i = end + 1;
                continue;
            }
            if open_ok {
                flush_lit!();
                let inner: String = chars[i + 1..].iter().collect();
                out.extend(parse_inline(
                    &inner,
                    base.add_modifier(Modifier::ITALIC),
                    true,
                ));
                break;
            }
        }

        lit.push(c);
        i += 1;
    }
    flush_lit!();
    out
}

/// Length of the run of `needle` starting at `from` (0 if none starts there).
fn run_len(chars: &[char], from: usize, needle: char) -> usize {
    let mut k = from;
    while k < chars.len() && chars[k] == needle {
        k += 1;
    }
    k - from
}

/// Start index of a run of EXACTLY `n` consecutive `needle` at or after `from`.
///
/// Deliberately not [`find_run`], which matches a run of AT LEAST `n` — correct
/// for `**`, wrong for a code span, where a ``` run must not close a `` one.
fn find_run_of(chars: &[char], from: usize, needle: char, n: usize) -> Option<usize> {
    let mut k = from;
    while k < chars.len() {
        if chars[k] == needle {
            let len = run_len(chars, k, needle);
            if len == n {
                return Some(k);
            }
            k += len;
        } else {
            k += 1;
        }
    }
    None
}

/// Start index of a run of `n` consecutive `needle` at or after `from`.
fn find_run(chars: &[char], from: usize, needle: char, n: usize) -> Option<usize> {
    let mut k = from;
    while k + n <= chars.len() {
        if chars[k..k + n].iter().all(|&c| c == needle) {
            return Some(k);
        }
        k += 1;
    }
    None
}

/// The closer for a single-`*` emphasis: the next `*` that is not the start of
/// a `**` run and does not directly follow a space (`a * b` is arithmetic).
fn find_closing_emph(chars: &[char], from: usize) -> Option<usize> {
    let mut k = from;
    while k < chars.len() {
        if chars[k] == '*'
            && k > from
            && !chars[k - 1].is_whitespace()
            && chars.get(k + 1) != Some(&'*')
        {
            return Some(k);
        }
        k += 1;
    }
    None
}

/// A `*` opens emphasis only at a word boundary and followed by non-space.
///
/// Note there is deliberately NO `_` emphasis in this renderer. This is a
/// developer tool whose transcripts are full of snake_case, and honouring `_`
/// renders `agent_loop_approvals` as "agent<i>loop</i>approvals". Dropping the
/// delimiter removes the whole hazard rather than guarding it case by case.
fn opens_emphasis(chars: &[char], i: usize) -> bool {
    let next_ok = matches!(chars.get(i + 1), Some(c) if !c.is_whitespace() && *c != '*');
    let prev_ok = i == 0
        || matches!(chars.get(i - 1), Some(c) if c.is_whitespace()
            || matches!(c, '(' | '[' | '{' | '"' | '\'' | ',' | ':' | '—'));
    next_ok && prev_ok
}

/// `## Heading` → `Heading`. Requires the space: `#41189` is an issue ref, and
/// agent output is full of them.
fn atx_heading(s: &str) -> Option<&str> {
    let hashes = s.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    s[hashes..].strip_prefix(' ').map(|r| r.trim())
}

fn list_item(s: &str) -> Option<(String, &str)> {
    for m in ["- ", "* ", "+ "] {
        if let Some(rest) = s.strip_prefix(m) {
            return Some(("•".to_string(), rest));
        }
    }
    let digits = s.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits > 0 && digits <= 3 {
        let rest = &s[digits..];
        for m in [". ", ") "] {
            if let Some(r) = rest.strip_prefix(m) {
                return Some((format!("{}.", &s[..digits]), r));
            }
        }
    }
    None
}

fn leading_spaces(s: &str) -> usize {
    s.chars().take_while(|c| *c == ' ').count()
}

fn hard_split(s: &str, width: usize) -> Vec<String> {
    if width == 0 || s.chars().count() <= width {
        return vec![s.to_string()];
    }
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in s.chars() {
        if cur.chars().count() == width {
            out.push(std::mem::take(&mut cur));
        }
        cur.push(ch);
    }
    out.push(cur);
    out
}

enum Tok {
    Space,
    Word(String, Style),
}

/// Word-wrap styled runs into lines, carrying each run's style across the
/// break. `first_prefix` decorates line 1 (a bullet, a quote bar) and
/// `cont_indent` is the hanging indent every continuation line gets.
fn wrap_segs(
    segs: &[Seg],
    width: usize,
    first_prefix: Option<(String, Style)>,
    cont_indent: usize,
) -> Vec<Line<'static>> {
    let mut toks: Vec<Tok> = Vec::new();
    for seg in segs {
        for (i, part) in seg.text.split(' ').enumerate() {
            if i > 0 {
                toks.push(Tok::Space);
            }
            if !part.is_empty() {
                toks.push(Tok::Word(part.to_string(), seg.style));
            }
        }
    }

    let mut out: Vec<Line<'static>> = Vec::new();
    let mut spans: Vec<Span<'static>> = Vec::new();
    let mut cur_w = 0usize;
    let mut pending_space = false;
    let mut has_content = false;

    if let Some((p, st)) = &first_prefix {
        cur_w = p.chars().count();
        spans.push(Span::styled(p.clone(), *st));
    }

    let break_line =
        |out: &mut Vec<Line<'static>>, spans: &mut Vec<Span<'static>>, cur_w: &mut usize| {
            out.push(Line::from(std::mem::take(spans)));
            *cur_w = cont_indent;
            if cont_indent > 0 {
                spans.push(Span::raw(" ".repeat(cont_indent)));
            }
        };

    for tok in toks {
        match tok {
            Tok::Space => {
                if has_content {
                    pending_space = true;
                }
            }
            Tok::Word(w, st) => {
                let wlen = w.chars().count();
                let need = wlen + usize::from(pending_space && has_content);
                if has_content && cur_w + need > width {
                    break_line(&mut out, &mut spans, &mut cur_w);
                    pending_space = false;
                    has_content = false;
                }
                if pending_space && has_content {
                    spans.push(Span::raw(" "));
                    cur_w += 1;
                }
                pending_space = false;

                // A single word longer than the remaining room is hard-split
                // rather than pushing the pane sideways.
                let room = width.saturating_sub(cur_w);
                if wlen > room && room > 0 {
                    for (k, chunk) in hard_split(&w, room).into_iter().enumerate() {
                        if k > 0 {
                            break_line(&mut out, &mut spans, &mut cur_w);
                        }
                        cur_w += chunk.chars().count();
                        spans.push(Span::styled(chunk, st));
                    }
                    has_content = true;
                    continue;
                }
                cur_w += wlen;
                spans.push(Span::styled(w, st));
                has_content = true;
            }
        }
    }

    if has_content || (out.is_empty() && !spans.is_empty()) {
        out.push(Line::from(spans));
    }
    if out.is_empty() {
        out.push(Line::from(""));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(lines: &[Line<'static>]) -> Vec<String> {
        lines
            .iter()
            .map(|l| {
                l.spans
                    .iter()
                    .map(|s| s.content.as_ref())
                    .collect::<String>()
            })
            .collect()
    }

    fn has_bold(l: &Line<'static>) -> bool {
        l.spans
            .iter()
            .any(|s| s.style.add_modifier.contains(Modifier::BOLD))
    }

    #[test]
    fn snake_case_identifiers_are_never_italicised() {
        // The reason `_` is not an emphasis delimiter. A regression here
        // renders every identifier in the transcript mangled.
        let out = render("parked in agent_loop_approvals now", 80, false);
        assert_eq!(flat(&out), vec!["parked in agent_loop_approvals now"]);
        assert!(out[0]
            .spans
            .iter()
            .all(|s| !s.style.add_modifier.contains(Modifier::ITALIC)));
    }

    #[test]
    fn streaming_tail_styles_an_unclosed_bold_instead_of_showing_the_delimiter() {
        let live = render("this is **important", 80, true);
        assert_eq!(flat(&live), vec!["this is important"]);
        assert!(has_bold(&live[0]), "open delimiter should style its tail");

        // A SETTLED message must NOT get the same treatment: once the turn is
        // done, an unmatched `**` is just text the model wrote.
        let done = render("this is **important", 80, false);
        assert_eq!(flat(&done), vec!["this is **important"]);
        assert!(!has_bold(&done[0]));
    }

    #[test]
    fn only_the_final_line_gets_the_open_delimiter_rule() {
        // An unmatched `**` on an EARLIER line is settled text even mid-stream;
        // only the line still being written is provisional.
        let out = render("a ** b\nstill **writing", 80, true);
        assert_eq!(flat(&out), vec!["a ** b", "still writing"]);
    }

    #[test]
    fn an_unterminated_fence_keeps_rendering_as_code() {
        let out = render("intro\n```rust\nfn main() {\n    let x = 1;", 80, true);
        let txt = flat(&out);
        assert_eq!(txt[0], "intro");
        assert_eq!(txt[1], "  rust");
        assert_eq!(txt[2], "  fn main() {");
        // Indentation PRESERVED — code must never be reflowed.
        assert_eq!(txt[3], "      let x = 1;");
    }

    #[test]
    fn fenced_code_is_hard_split_not_word_wrapped() {
        let long = "let path = \"a/very/long/path/that/exceeds\";";
        let out = render(&format!("```\n{long}\n```"), 20, false);
        let txt = flat(&out);
        assert!(txt.len() > 1, "expected a hard split at width 20");
        // Reassembled without the 2-col gutter it is byte-identical: nothing
        // was reflowed away.
        let rejoined: String = txt.iter().map(|l| l.trim_start_matches("  ")).collect();
        assert_eq!(rejoined, long);
    }

    #[test]
    fn inline_code_and_bold_do_not_collapse_to_the_same_style() {
        let out = render("call `foo()` or **foo()**", 80, false);
        let spans = &out[0].spans;
        let code = spans
            .iter()
            .find(|s| {
                s.content.as_ref() == "foo()" && !s.style.add_modifier.contains(Modifier::BOLD)
            })
            .expect("an inline-code run");
        let bold = spans
            .iter()
            .find(|s| s.style.add_modifier.contains(Modifier::BOLD))
            .expect("a bold run");
        assert_ne!(code.style, bold.style);
    }

    #[test]
    fn markup_inside_a_code_span_stays_literal() {
        let out = render("use `a ** b` here", 80, false);
        assert_eq!(flat(&out), vec!["use a ** b here"]);
        assert!(!has_bold(&out[0]));
    }

    #[test]
    fn wrapping_preserves_the_style_of_a_run_split_across_lines() {
        let out = render("aaa **bbb ccc ddd** eee", 11, false);
        assert!(out.len() > 1, "expected a wrap at width 11");
        let bold: String = out
            .iter()
            .flat_map(|l| l.spans.iter())
            .filter(|s| s.style.add_modifier.contains(Modifier::BOLD))
            .map(|s| s.content.as_ref())
            .collect();
        assert_eq!(bold.replace(' ', ""), "bbbcccddd");
    }

    #[test]
    fn a_bullet_wraps_under_its_text_not_under_the_marker() {
        let out = render("- alpha beta gamma delta", 14, false);
        let txt = flat(&out);
        assert!(txt.len() >= 2, "expected a wrap, got {txt:?}");
        assert!(txt[0].starts_with("• "));
        assert!(
            txt[1].starts_with("  ") && !txt[1].starts_with("• "),
            "continuation must hang-indent, got {:?}",
            txt[1]
        );
    }

    #[test]
    fn a_heading_drops_its_hashes_but_an_issue_ref_keeps_them() {
        assert_eq!(
            flat(&render("## Verification", 80, false)),
            vec!["Verification"]
        );
        // No space ⇒ not a heading. Agent output is full of `#41189` refs.
        assert_eq!(
            flat(&render("#41189 landed", 80, false)),
            vec!["#41189 landed"]
        );
    }

    #[test]
    fn arithmetic_asterisks_are_not_emphasis() {
        let out = render("2 * 3 * 4 is 24", 80, false);
        assert_eq!(flat(&out), vec!["2 * 3 * 4 is 24"]);
        assert!(out[0]
            .spans
            .iter()
            .all(|s| !s.style.add_modifier.contains(Modifier::ITALIC)));
    }

    #[test]
    fn blank_lines_and_ordered_items_survive_a_round_trip() {
        let out = render("intro\n\n1. first\n2. second", 80, false);
        assert_eq!(flat(&out), vec!["intro", "", "1. first", "2. second"]);
    }

    #[test]
    fn a_partial_fence_opener_never_flickers_stray_backticks() {
        // A fence arrives one char at a time: ` → `` → ``` → ```rust. The
        // intermediate states must not paint literal backticks that vanish a
        // keystroke later — the eye catches the flicker, not the content.
        // Rendering NOTHING for the partial opener is the smooth path, and it
        // is what the completed fence does too (an opener is never shown).
        for partial in ["`", "``"] {
            let out = render(partial, 40, true);
            let txt = flat(&out);
            assert!(
                txt.iter().all(|l| !l.contains('`')),
                "partial fence opener {partial:?} leaked a backtick: {txt:?}"
            );
        }
        // Calibration: the SETTLED forms of the same input are not governed by
        // the streaming rule, so this test cannot pass by rendering everything
        // empty always.
        let settled = flat(&render("a ` b", 40, false));
        assert_eq!(settled, vec!["a ` b"], "settled text must stay literal");
    }

    #[test]
    fn an_opening_backtick_mid_stream_keeps_the_prose_before_it() {
        // The common streaming shape: prose, then a code span the model has
        // only just opened. The prose is already written and must not blink
        // out while the span fills in. (The trailing space is dropped by the
        // wrapper, as it is for any line — that is wrapping, not loss.)
        let out = render("call the `", 40, true);
        assert_eq!(flat(&out), vec!["call the"]);
    }

    #[test]
    fn a_double_backtick_span_can_hold_a_literal_backtick() {
        // The reason the parser matches RUNS rather than single backticks:
        // ``a ` b`` is the only way to show a backtick inside code, and the
        // single-backtick parser rendered it as two broken spans.
        let out = render("write ``a ` b`` here", 80, false);
        assert_eq!(flat(&out), vec!["write a ` b here"]);
        // The inner text is genuinely CODE-styled, not literal prose that
        // happens to read the same once the delimiters are stripped.
        assert!(
            out[0]
                .spans
                .iter()
                .any(|s| s.content.contains('`') && s.style == code_style()),
            "expected the backtick-bearing run to be code-styled"
        );
    }

    #[test]
    fn an_empty_code_span_does_not_swallow_the_backticks_it_is_made_of() {
        // `` with nothing between is NOT a code span (CommonMark: a span needs
        // content); the backticks are literal text. Rendering it as an empty
        // span deletes two characters the model deliberately wrote — the same
        // disappearing-content failure the transcript rules forbid, one layer
        // down. Settled text is shown as written.
        let out = render("escape it with `` in prose", 80, false);
        assert_eq!(flat(&out), vec!["escape it with `` in prose"]);

        let alone = render("``", 80, false);
        assert_eq!(flat(&alone), vec!["``"]);
    }
}
