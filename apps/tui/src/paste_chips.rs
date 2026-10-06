//! Large pastes collapse to a one-line chip in the composer (P-027 G-7).
//!
//! Claude Code shows a 40-line paste as `[Pasted text #1 +39 lines]` and Codex
//! as `[Pasted Content 2110 chars]`; pui used to expand every line into the
//! composer and fill the screen (parity checklist row 16). The chip is plain
//! text in the draft, so cursor movement, undo, history and Ctrl+C keep working
//! unchanged; the pasted body is kept here and only joined back in at the send
//! boundary (`expand`), the same way attachments are joined in
//! `Attachments::attach_to_prompt`.

/// A paste with at least this many lines collapses.
pub const PASTE_CHIP_MIN_LINES: usize = 4;
/// A paste longer than this many characters collapses even on one line.
pub const PASTE_CHIP_MIN_CHARS: usize = 800;
/// Chips remembered for expansion. A chip recalled from history after this
/// many later pastes is sent as its label text; the bound keeps a long-lived
/// pane from retaining every paste of the session.
const MAX_CHIPS: usize = 64;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PasteChips {
    next: usize,
    items: Vec<(String, String)>,
}

/// Lines as the owner sees them: CRLF and a lone CR (some terminals send CR
/// inside a bracketed paste) both end a line; a trailing newline does not
/// start a new one.
fn line_count(text: &str) -> usize {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    normalized.trim_end_matches('\n').split('\n').count()
}

impl PasteChips {
    /// Whether a paste is large enough to collapse.
    pub fn should_collapse(text: &str) -> bool {
        line_count(text) >= PASTE_CHIP_MIN_LINES || text.chars().count() > PASTE_CHIP_MIN_CHARS
    }

    /// Store `text` and return the chip label to put in the draft.
    pub fn collapse(&mut self, text: &str) -> String {
        self.next += 1;
        let lines = line_count(text);
        let label = if lines > 1 {
            format!("[Pasted text #{} +{} lines]", self.next, lines - 1)
        } else {
            format!("[Pasted text #{}, {} chars]", self.next, text.chars().count())
        };
        self.items.push((label.clone(), text.to_string()));
        if self.items.len() > MAX_CHIPS {
            let excess = self.items.len() - MAX_CHIPS;
            self.items.drain(0..excess);
        }
        label
    }

    /// The draft with every known chip replaced by its pasted text.
    pub fn expand(&self, draft: &str) -> String {
        let mut out = draft.to_string();
        for (label, body) in &self.items {
            if out.contains(label.as_str()) {
                out = out.replace(label.as_str(), body);
            }
        }
        out
    }

    /// Byte length of the chip that ends exactly at the end of `before`, so
    /// Backspace removes a chip whole instead of eating its `]`.
    pub fn chip_len_ending(&self, before: &str) -> Option<usize> {
        self.items
            .iter()
            .find(|(label, _)| before.ends_with(label.as_str()))
            .map(|(label, _)| label.len())
    }

    /// Byte length of the chip that starts exactly at the start of `after`, so
    /// Delete removes a chip whole.
    pub fn chip_len_starting(&self, after: &str) -> Option<usize> {
        self.items
            .iter()
            .find(|(label, _)| after.starts_with(label.as_str()))
            .map(|(label, _)| label.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(n: usize) -> String {
        (1..=n).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n")
    }

    #[test]
    fn small_pastes_stay_inline() {
        assert!(!PasteChips::should_collapse("one line"));
        assert!(!PasteChips::should_collapse("a\nb\nc"));
        assert!(!PasteChips::should_collapse("a\nb\nc\n"), "a trailing newline is not a 4th line");
    }

    #[test]
    fn many_lines_or_many_chars_collapse() {
        assert!(PasteChips::should_collapse(&lines(4)));
        assert!(PasteChips::should_collapse("a\r\nb\r\nc\r\nd"));
        assert!(PasteChips::should_collapse("a\rb\rc\rd"), "lone CR ends a line too");
        assert!(PasteChips::should_collapse(&"x".repeat(801)));
        assert!(!PasteChips::should_collapse(&"x".repeat(800)));
    }

    #[test]
    fn label_matches_claude_code_and_expands_back_byte_exact() {
        let mut chips = PasteChips::default();
        let body = lines(40);
        let label = chips.collapse(&body);
        assert_eq!(label, "[Pasted text #1 +39 lines]");
        let draft = format!("review this: {label} thanks");
        assert_eq!(chips.expand(&draft), format!("review this: {body} thanks"));
        let long = "y".repeat(900);
        assert_eq!(chips.collapse(&long), "[Pasted text #2, 900 chars]");
    }

    #[test]
    fn two_chips_expand_independently_and_number_ten_is_not_number_one() {
        let mut chips = PasteChips::default();
        let mut labels = Vec::new();
        for i in 0..11 {
            labels.push(chips.collapse(&format!("{}\nbody {i}", lines(4))));
        }
        let draft = format!("{} and {}", labels[0], labels[10]);
        let out = chips.expand(&draft);
        assert!(out.contains("body 0"));
        assert!(out.contains("body 10"));
        assert!(!out.contains("[Pasted text"));
    }

    #[test]
    fn unknown_text_is_untouched() {
        let chips = PasteChips::default();
        assert_eq!(chips.expand("[Pasted text #1 +3 lines]"), "[Pasted text #1 +3 lines]");
    }

    #[test]
    fn chip_bounds_for_atomic_delete() {
        let mut chips = PasteChips::default();
        let label = chips.collapse(&lines(5));
        assert_eq!(chips.chip_len_ending(&format!("hi {label}")), Some(label.len()));
        assert_eq!(chips.chip_len_ending(&format!("hi {label} ")), None);
        assert_eq!(chips.chip_len_starting(&format!("{label} tail")), Some(label.len()));
        assert_eq!(chips.chip_len_starting("tail"), None);
    }

    #[test]
    fn store_is_bounded() {
        let mut chips = PasteChips::default();
        let first = chips.collapse(&lines(4));
        for _ in 0..MAX_CHIPS {
            chips.collapse(&lines(4));
        }
        assert_eq!(chips.items.len(), MAX_CHIPS);
        assert_eq!(chips.expand(&first), first, "the oldest chip was dropped");
    }
}
