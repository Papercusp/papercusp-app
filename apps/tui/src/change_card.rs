//! Change cards — the in-PUI diff surface for file-editing tool calls
//! (P-007, PUBLIC_RELEASE_UX.md § Capability replacement interaction map).
//!
//! The release UX contract says, verbatim:
//!
//! > | Code changes and diffs | Change cards open an in-PUI scrollable diff
//! > with file/path/hunk context and the same y/Shift-Y copy contract. |
//!
//! This module is the PURE half: recognise a file-editing tool call, turn its
//! arguments into a real line diff with hunk context, and resolve it into the
//! SAME [`chat_copy::CopyBlock`] the transcript already copies. The scroll
//! view and the key wiring live in `app`/`ui`; nothing here touches state.
//!
//! # Why the hunk header carries no line numbers
//!
//! A unified-diff header (`@@ -41,7 +41,9 @@`) states FILE COORDINATES. The
//! seam does not give us any: `capability:edit` takes `{ file_path,
//! old_string, new_string }` and returns `{ ok, path, replacements }` — no
//! offset, no line number, and never the surrounding file. The engines' native
//! `Edit`/`str_replace` tools are the same shape. So a `@@ -1,5 +1,7 @@` here
//! would be FABRICATED, and it would be fabricated in the one format every
//! reader parses as authoritative file coordinates — including `patch`. The
//! header therefore states only what is known: which hunk of how many.
//!
//! The hunks themselves are real. `old_string` is required to carry enough
//! surrounding context to be unique, so the unchanged lines inside it ARE the
//! hunk context the contract asks for — recovered by diffing old against new
//! rather than invented.
//!
//! # Why the diff is bounded
//!
//! An LCS diff is quadratic, and a `Write` card's "old" side is an entire
//! file. 10k lines a side is 100M cells — an unbounded card is a frozen PUI.
//! Past [`LCS_MAX_LINES`] a side, the card degrades to a whole-block replace
//! and SAYS it degraded, rather than silently rendering a diff of a different
//! quality than the one next to it.
//!
//! # Redaction
//!
//! Both forms go through `chat_copy`'s redactor, for the reason stated there:
//! a redactor that runs only on the dangerous path is one refactor away from
//! not running at all. A change card is squarely on the dangerous path — the
//! text being written to a file is exactly where a pasted credential lives.

use serde_json::{Map, Value};

use crate::chat_copy::{redact_text, redact_value, CopyBlock};
use crate::models::{ChatMessage, ChatToolCall, ToolOutcome};

/// Per-side line ceiling before the LCS diff degrades to a block replace.
pub const LCS_MAX_LINES: usize = 400;

/// Unchanged lines kept either side of a change, as in `diff -U3`.
pub const CONTEXT_LINES: usize = 3;

/// Total diff lines a single card will render. A full-file `Write` is
/// otherwise unbounded, and an unbounded card is a scroll view nobody can
/// reach the end of.
pub const MAX_CARD_LINES: usize = 2_000;

/// Which file-editing tool produced the card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    /// A targeted `old_string` → `new_string` replacement.
    Edit,
    /// A whole-file write: everything is new.
    Write,
    /// Several `Edit`s against one file in one call.
    MultiEdit,
    /// A notebook cell replacement.
    NotebookEdit,
}

impl ChangeKind {
    pub fn label(self) -> &'static str {
        match self {
            ChangeKind::Edit => "Edit",
            ChangeKind::Write => "Write",
            ChangeKind::MultiEdit => "MultiEdit",
            ChangeKind::NotebookEdit => "NotebookEdit",
        }
    }
}

/// One line of a rendered hunk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffLine {
    Context(String),
    Removed(String),
    Added(String),
}

impl DiffLine {
    pub fn is_context(&self) -> bool {
        matches!(self, DiffLine::Context(_))
    }
    /// The `diff` gutter marker. Deliberately the classic ASCII trio: a pasted
    /// card should read as a diff to a human AND to a tool.
    pub fn marker(&self) -> char {
        match self {
            DiffLine::Context(_) => ' ',
            DiffLine::Removed(_) => '-',
            DiffLine::Added(_) => '+',
        }
    }
    pub fn text(&self) -> &str {
        match self {
            DiffLine::Context(s) | DiffLine::Removed(s) | DiffLine::Added(s) => s.as_str(),
        }
    }
}

/// A contiguous run of changed lines plus its surrounding context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
    /// 1-based position of this hunk within the card.
    pub ordinal: usize,
    /// How many hunks the card has, so a header can read `2/3`.
    pub of: usize,
    /// Set when this hunk is a degraded whole-block replace rather than a
    /// real line diff — stated on the card, never hidden.
    pub note: Option<String>,
    pub lines: Vec<DiffLine>,
}

impl Hunk {
    pub fn header(&self) -> String {
        match &self.note {
            Some(n) => format!("@@ hunk {}/{} · {} @@", self.ordinal, self.of, n),
            None => format!("@@ hunk {}/{} @@", self.ordinal, self.of),
        }
    }
}

/// One file-editing tool call, resolved into a scrollable diff.
#[derive(Debug, Clone, PartialEq)]
pub struct ChangeCard {
    /// Which message in the transcript this card hangs under.
    pub message_index: usize,
    /// Which tool call on that message, so a card can be addressed without
    /// re-running detection.
    pub tool_index: usize,
    pub kind: ChangeKind,
    pub path: String,
    pub replace_all: bool,
    pub hunks: Vec<Hunk>,
    pub added: usize,
    pub removed: usize,
    /// The rendered diff hit [`MAX_CARD_LINES`] and was cut.
    pub truncated: bool,
    /// Terminal state of the call. A FAILED edit still gets a card: what was
    /// attempted is exactly what a reader needs when it did not land.
    pub outcome: ToolOutcome,
    /// The verbatim call payload, already redacted. `Shift-Y` copies this.
    raw: Value,
}

impl ChangeCard {
    /// `Edit · apps/tui/src/app.rs · +12 -3`
    pub fn title(&self) -> String {
        let mut t = format!(
            "{} · {} · +{} -{}",
            self.kind.label(),
            self.path,
            self.added,
            self.removed
        );
        if self.replace_all {
            t.push_str(" · all occurrences");
        }
        match &self.outcome {
            ToolOutcome::Failed(_) => t.push_str(" · FAILED"),
            ToolOutcome::Denied => t.push_str(" · DENIED"),
            ToolOutcome::Skipped => t.push_str(" · skipped"),
            ToolOutcome::Pending => t.push_str(" · pending"),
            ToolOutcome::Ok => {}
        }
        t
    }

    /// The card body, one entry per display row — what the scroll view paints
    /// and what `y` copies, so the two cannot disagree about what is on screen.
    pub fn render_lines(&self) -> Vec<String> {
        let mut out = Vec::new();
        out.push(self.title());
        if let ToolOutcome::Failed(why) = &self.outcome {
            if !why.is_empty() {
                out.push(format!("  error: {why}"));
            }
        }
        if self.hunks.is_empty() {
            out.push(String::new());
            out.push("(no textual change)".to_string());
            return out.into_iter().map(|l| redact_text(&l)).collect();
        }
        for h in &self.hunks {
            out.push(String::new());
            out.push(h.header());
            for l in &h.lines {
                out.push(format!("{}{}", l.marker(), l.text()));
            }
        }
        if self.truncated {
            out.push(String::new());
            out.push(format!(
                "… diff truncated at {MAX_CARD_LINES} lines — open the file for the rest"
            ));
        }
        out.into_iter().map(|l| redact_text(&l)).collect()
    }

    /// The card body as one string — the `y` payload.
    pub fn render(&self) -> String {
        self.render_lines().join("\n")
    }

    /// The `Shift-Y` payload: the call verbatim, redacted.
    pub fn raw(&self) -> String {
        serde_json::to_string_pretty(&self.raw).unwrap_or_else(|_| String::from("{}"))
    }

    /// Resolve into the transcript's own copy block, so `chat_copy::copy_block`
    /// applies the identical redact/truncate/encode/acknowledge path.
    pub fn copy_block(&self) -> CopyBlock {
        CopyBlock {
            index: self.message_index,
            label: format!("{} card", self.kind.label().to_ascii_lowercase()),
            rendered: self.render(),
            raw: Some(self.raw()),
        }
    }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/// Normalise a tool name for matching: drop the server prefix, lowercase, and
/// strip separators. `capability:edit`, `capability_edit` and `Edit` are the
/// same tool wearing three seams' spellings, and the PUI sees all three —
/// papercusp's own catalog, an attached Claude engine, an attached Codex one.
fn normalized(name: &str) -> String {
    let tail = name.rsplit([':', '.', '/']).next().unwrap_or(name);
    let flat = tail
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    // `capability_edit` is the SAME tool as `capability:edit` — every MCP
    // client mangles `:` to `_`, so the mangled spelling has no separator left
    // to split on and arrives as one word. Strip the server prefix by name
    // rather than by separator, or the mangled form silently resolves to no
    // card while the colon form resolves to one. The prefix is stripped only
    // when something remains, so a tool literally named `capability` is left
    // alone rather than normalising to the empty string.
    match flat.strip_prefix("capability") {
        Some(rest) if !rest.is_empty() => rest.to_string(),
        _ => flat,
    }
}

fn kind_of(name: &str) -> Option<ChangeKind> {
    match normalized(name).as_str() {
        "edit" | "strreplace" | "strreplaceeditor" | "applypatch" | "editfile" => {
            Some(ChangeKind::Edit)
        }
        "write" | "createfile" | "writefile" => Some(ChangeKind::Write),
        "multiedit" => Some(ChangeKind::MultiEdit),
        "notebookedit" => Some(ChangeKind::NotebookEdit),
        _ => None,
    }
}

/// First present string among several spellings of the same field. The seams
/// disagree on case and separator (`file_path` / `filePath` / `path`), and a
/// card that renders for one engine and not another is a parity bug.
fn pick<'a>(v: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|k| v.get(*k)?.as_str())
}

const PATH_KEYS: &[&str] = &["file_path", "filePath", "path", "file", "notebook_path"];
const OLD_KEYS: &[&str] = &[
    "old_string",
    "oldString",
    "old_str",
    "oldText",
    "old_source",
];
const NEW_KEYS: &[&str] = &[
    "new_string",
    "newString",
    "new_str",
    "newText",
    "new_source",
];
const CONTENT_KEYS: &[&str] = &["content", "contents", "text", "file_text"];

/// Build the card for one tool call, or `None` when it is not a file edit.
/// The admission test: everything [`card_for_tool`] must establish BEFORE it
/// can start diffing, and therefore everything that decides whether a tool call
/// has a card at all.
///
/// Factored out so [`is_change_card`] and [`card_for_tool`] cannot disagree by
/// construction. The alternative — a second hand-written predicate — is exactly
/// the drift the repo guide's derived-truth rule warns about, and it would fail
/// in the direction that matters: an affordance offering a diff that `Enter`
/// then declines to open.
fn admit(tool: &ChatToolCall) -> Option<(ChangeKind, &Map<String, Value>, String)> {
    let kind = kind_of(&tool.name)?;
    let input = tool.input.as_ref()?.as_object()?;
    let path = pick(input, PATH_KEYS)?.to_string();
    // A `MultiEdit` with no `edits` array carries no edit pairs, so it resolves
    // to nothing further down. Checking it here keeps the two entry points
    // agreeing on the one kind whose payload can be structurally absent.
    if kind == ChangeKind::MultiEdit && input.get("edits").and_then(Value::as_array).is_none() {
        return None;
    }
    Some((kind, input, path))
}

/// Whether this tool call resolves to a change card — WITHOUT building the
/// diff.
///
/// The transcript asks this of every visible tool call on every frame, and
/// [`card_for_tool`] runs an LCS diff bounded only at [`LCS_MAX_LINES`] a side:
/// calling it just to ask "is there a diff here?" would put a worst-case
/// 160k-cell computation per edit call on the render path, which is the
/// quadratic-work-per-frame anti-pattern the performance guide opens with.
pub fn is_change_card(tool: &ChatToolCall) -> bool {
    admit(tool).is_some()
}

pub fn card_for_tool(
    tool: &ChatToolCall,
    message_index: usize,
    tool_index: usize,
) -> Option<ChangeCard> {
    let (kind, input, path) = admit(tool)?;

    let replace_all = input
        .get("replace_all")
        .or_else(|| input.get("replaceAll"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    // --- the edit pairs -----------------------------------------------------
    // Every kind reduces to a list of (old, new) blocks, which keeps the diff
    // engine below single-shaped instead of branching per tool.
    let mut pairs: Vec<(String, String)> = Vec::new();
    match kind {
        ChangeKind::Write => {
            let content = pick(input, CONTENT_KEYS).unwrap_or_default();
            pairs.push((String::new(), content.to_string()));
        }
        ChangeKind::MultiEdit => {
            let edits = input.get("edits").and_then(Value::as_array)?;
            for e in edits {
                let Some(o) = e.as_object() else { continue };
                let old = pick(o, OLD_KEYS).unwrap_or_default().to_string();
                let new = pick(o, NEW_KEYS).unwrap_or_default().to_string();
                pairs.push((old, new));
            }
        }
        ChangeKind::Edit | ChangeKind::NotebookEdit => {
            let old = pick(input, OLD_KEYS).unwrap_or_default().to_string();
            let new = pick(input, NEW_KEYS)
                .or_else(|| pick(input, CONTENT_KEYS))
                .unwrap_or_default()
                .to_string();
            pairs.push((old, new));
        }
    }

    // --- diff ---------------------------------------------------------------
    let mut groups: Vec<(Option<String>, Vec<DiffLine>)> = Vec::new();
    for (old, new) in &pairs {
        let o = split_lines(old);
        let n = split_lines(new);
        if o.len() > LCS_MAX_LINES || n.len() > LCS_MAX_LINES {
            let mut lines: Vec<DiffLine> = Vec::with_capacity(o.len() + n.len());
            lines.extend(o.into_iter().map(DiffLine::Removed));
            lines.extend(n.into_iter().map(DiffLine::Added));
            groups.push((
                Some(format!("whole-block replace, over {LCS_MAX_LINES} lines")),
                lines,
            ));
            continue;
        }
        for g in to_hunks(lcs_diff(&o, &n), CONTEXT_LINES) {
            groups.push((None, g));
        }
    }

    let total = groups.len();
    let mut hunks: Vec<Hunk> = Vec::with_capacity(total);
    let mut added = 0usize;
    let mut removed = 0usize;
    let mut budget = MAX_CARD_LINES;
    let mut truncated = false;
    for (i, (note, mut lines)) in groups.into_iter().enumerate() {
        // Count the WHOLE change before truncating: `+12 -3` must describe the
        // edit, not the part of it that fit on screen.
        for l in &lines {
            match l {
                DiffLine::Added(_) => added += 1,
                DiffLine::Removed(_) => removed += 1,
                DiffLine::Context(_) => {}
            }
        }
        if budget == 0 {
            truncated = true;
            continue;
        }
        if lines.len() > budget {
            lines.truncate(budget);
            truncated = true;
        }
        budget -= lines.len();
        hunks.push(Hunk {
            ordinal: i + 1,
            of: total,
            note,
            lines,
        });
    }

    // --- raw ----------------------------------------------------------------
    let mut obj = Map::new();
    obj.insert("tool".into(), Value::String(tool.name.clone()));
    if let Some(id) = &tool.id {
        obj.insert("id".into(), Value::String(id.clone()));
    }
    obj.insert(
        "outcome".into(),
        Value::String(format!("{:?}", tool.outcome)),
    );
    obj.insert("input".into(), Value::Object(input.clone()));
    if let Some(r) = &tool.result {
        obj.insert("result".into(), r.clone());
    }

    Some(ChangeCard {
        message_index,
        tool_index,
        kind,
        path,
        replace_all,
        hunks,
        added,
        removed,
        truncated,
        outcome: tool.outcome.clone(),
        raw: redact_value(&Value::Object(obj)),
    })
}

/// Every change card on one message, oldest call first.
pub fn cards_for_message(msg: &ChatMessage, message_index: usize) -> Vec<ChangeCard> {
    msg.tools
        .iter()
        .enumerate()
        .filter_map(|(i, t)| card_for_tool(t, message_index, i))
        .collect()
}

// A whole-transcript `cards_in(&[ChatMessage])` used to live here. It is gone
// on purpose: its only plausible caller was the renderer, and collecting every
// card in the conversation means running an LCS diff per edit call per frame —
// the quadratic-work-per-frame trap. The renderer asks `is_change_card` instead
// (admission only, no diff) and builds the one card the reader actually opened.

// ---------------------------------------------------------------------------
// Line diff
// ---------------------------------------------------------------------------

/// Split into lines WITHOUT inventing or dropping a trailing one. `"a\n"` is
/// one line, `""` is none — an empty `old_string` (a `Write`, or an insertion)
/// must not render as a removed blank line.
fn split_lines(s: &str) -> Vec<String> {
    if s.is_empty() {
        return Vec::new();
    }
    let mut v: Vec<String> = s.split('\n').map(str::to_string).collect();
    if s.ends_with('\n') {
        v.pop();
    }
    v
}

/// Longest-common-subsequence line diff. Bounded by the caller to
/// [`LCS_MAX_LINES`] a side before this is reached.
fn lcs_diff(old: &[String], new: &[String]) -> Vec<DiffLine> {
    let (n, m) = (old.len(), new.len());
    if n == 0 {
        return new.iter().cloned().map(DiffLine::Added).collect();
    }
    if m == 0 {
        return old.iter().cloned().map(DiffLine::Removed).collect();
    }
    let stride = m + 1;
    let mut dp = vec![0u32; (n + 1) * stride];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i * stride + j] = if old[i] == new[j] {
                dp[(i + 1) * stride + j + 1] + 1
            } else {
                dp[(i + 1) * stride + j].max(dp[i * stride + j + 1])
            };
        }
    }
    let mut out = Vec::with_capacity(n.max(m));
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if old[i] == new[j] {
            out.push(DiffLine::Context(old[i].clone()));
            i += 1;
            j += 1;
        } else if dp[(i + 1) * stride + j] >= dp[i * stride + j + 1] {
            out.push(DiffLine::Removed(old[i].clone()));
            i += 1;
        } else {
            out.push(DiffLine::Added(new[j].clone()));
            j += 1;
        }
    }
    out.extend(old[i..].iter().cloned().map(DiffLine::Removed));
    out.extend(new[j..].iter().cloned().map(DiffLine::Added));
    out
}

/// Cut a flat diff into hunks: each changed line keeps `context` unchanged
/// lines either side, and runs that touch are merged. A long unchanged stretch
/// between two changes becomes a hunk BOUNDARY rather than filler — which is
/// what makes the card scrollable at a useful density.
fn to_hunks(lines: Vec<DiffLine>, context: usize) -> Vec<Vec<DiffLine>> {
    if lines.is_empty() {
        return Vec::new();
    }
    let last = lines.len() - 1;
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for (i, l) in lines.iter().enumerate() {
        if l.is_context() {
            continue;
        }
        let lo = i.saturating_sub(context);
        let hi = (i + context).min(last);
        match ranges.last_mut() {
            // `lo <= hi_prev + 1` merges runs that touch or abut, so two
            // changes three lines apart share one hunk instead of repeating
            // the same context lines in two.
            Some(prev) if lo <= prev.1 + 1 => prev.1 = prev.1.max(hi),
            _ => ranges.push((lo, hi)),
        }
    }
    ranges
        .into_iter()
        .map(|(lo, hi)| lines[lo..=hi].to_vec())
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_copy::{copy_block, CopyForm, CopyOutcome, Passthrough, REDACTED};
    use serde_json::json;

    fn call(name: &str, input: Value) -> ChatToolCall {
        ChatToolCall {
            name: name.to_string(),
            id: Some("call-1".into()),
            needs_approval: false,
            input: Some(input),
            result: None,
            outcome: ToolOutcome::Ok,
        }
    }

    fn card(name: &str, input: Value) -> ChangeCard {
        card_for_tool(&call(name, input), 0, 0).expect("expected a change card")
    }

    #[test]
    fn recognizes_the_same_tool_across_every_seam_spelling() {
        // The PUI attaches to papercusp, Claude and Codex; each spells the
        // edit tool differently. A card that only renders for one of them is
        // precisely the engine-parity gap P-006 exists to close.
        for name in [
            "capability:edit",
            "capability_edit",
            "Edit",
            "str_replace",
            "str_replace_editor",
        ] {
            assert_eq!(
                kind_of(name),
                Some(ChangeKind::Edit),
                "{name} should resolve to an Edit card"
            );
        }
        for name in ["capability:write", "Write", "create_file"] {
            assert_eq!(kind_of(name), Some(ChangeKind::Write));
        }
        assert_eq!(kind_of("MultiEdit"), Some(ChangeKind::MultiEdit));
        assert_eq!(kind_of("NotebookEdit"), Some(ChangeKind::NotebookEdit));
    }

    #[test]
    fn a_non_editing_tool_is_not_a_change_card() {
        // The lossless generic card must stay the fallback: a read, a search
        // or a message send has no diff and must not be given a fake one.
        for name in ["capability:read", "coord:send", "Bash", "Grep", "editor"] {
            assert!(
                card_for_tool(&call(name, json!({"file_path": "a.rs"})), 0, 0).is_none(),
                "{name} must not produce a change card"
            );
        }
    }

    #[test]
    fn a_tool_call_with_no_path_yields_no_card() {
        // Better no card than a card headed by an empty path.
        assert!(card_for_tool(&call("Edit", json!({"old_string": "a"})), 0, 0).is_none());
        assert!(card_for_tool(
            &ChatToolCall {
                input: None,
                ..call("Edit", json!({}))
            },
            0,
            0
        )
        .is_none());
    }

    #[test]
    fn an_edit_renders_real_hunk_context_recovered_from_old_string() {
        let c = card(
            "capability:edit",
            json!({
                "file_path": "apps/tui/src/app.rs",
                "old_string": "fn foo() {\n    let a = 1;\n    old();\n    let b = 2;\n}",
                "new_string": "fn foo() {\n    let a = 1;\n    new();\n    let b = 2;\n}",
            }),
        );
        assert_eq!(c.added, 1);
        assert_eq!(c.removed, 1);
        assert_eq!(c.hunks.len(), 1);
        let body = c.render();
        assert!(body.contains("-    old();"), "{body}");
        assert!(body.contains("+    new();"), "{body}");
        // The unchanged lines are CONTEXT, carried with a leading space — this
        // is the "hunk context" half of the contract.
        assert!(body.contains(" fn foo() {"), "{body}");
        assert!(body.contains(" }"), "{body}");
        assert!(body.contains("@@ hunk 1/1 @@"), "{body}");
    }

    #[test]
    fn the_header_never_fabricates_file_line_numbers() {
        // A `@@ -41,7 +41,9 @@` header is read by humans AND by `patch` as
        // real file coordinates. The seam gives us none, so emitting one would
        // be a confident lie in the most authoritative available format.
        let c = card(
            "Edit",
            json!({"file_path": "x.rs", "old_string": "a", "new_string": "b"}),
        );
        let body = c.render();
        assert!(body.contains("@@ hunk 1/1 @@"), "{body}");
        assert!(
            !body.contains("@@ -"),
            "must not emit unified-diff line coordinates it does not have: {body}"
        );
    }

    #[test]
    fn distant_changes_become_separate_hunks_instead_of_one_padded_block() {
        let old: String = (0..40).map(|i| format!("line {i}\n")).collect();
        let new = old
            .replace("line 2\n", "line 2 CHANGED\n")
            .replace("line 30\n", "line 30 CHANGED\n");
        let c = card(
            "Edit",
            json!({"file_path": "x.rs", "old_string": old, "new_string": new}),
        );
        assert_eq!(c.hunks.len(), 2, "two distant changes → two hunks");
        assert_eq!(c.added, 2);
        assert_eq!(c.removed, 2);
        let body = c.render();
        assert!(body.contains("@@ hunk 1/2 @@"), "{body}");
        assert!(body.contains("@@ hunk 2/2 @@"), "{body}");
        // The ~25 untouched lines between them are a boundary, not filler.
        assert!(!body.contains(" line 15"), "{body}");
    }

    #[test]
    fn adjacent_changes_share_one_hunk() {
        let old: String = (0..20).map(|i| format!("line {i}\n")).collect();
        let new = old
            .replace("line 8\n", "line 8 X\n")
            .replace("line 10\n", "line 10 X\n");
        let c = card(
            "Edit",
            json!({"file_path": "x.rs", "old_string": old, "new_string": new}),
        );
        assert_eq!(
            c.hunks.len(),
            1,
            "changes within 2*context must not repeat the same context lines in two hunks"
        );
    }

    #[test]
    fn a_write_is_all_added_with_no_phantom_removed_blank_line() {
        // `split_lines("")` must yield NO lines: an empty old side rendering
        // as one removed blank line is the classic off-by-one here.
        let c = card(
            "capability:write",
            json!({"file_path": "new.rs", "content": "one\ntwo\n"}),
        );
        assert_eq!(c.added, 2);
        assert_eq!(c.removed, 0, "a new file removes nothing");
        let body = c.render();
        assert!(body.contains("+one"), "{body}");
        assert!(body.contains("+two"), "{body}");
        assert!(
            !body.contains("\n-"),
            "nothing may render as removed: {body}"
        );
    }

    #[test]
    fn multiedit_gives_one_hunk_per_edit_and_sums_the_counts() {
        let c = card(
            "MultiEdit",
            json!({
                "file_path": "x.rs",
                "edits": [
                    {"old_string": "a", "new_string": "A"},
                    {"old_string": "b", "new_string": "B\nB2"},
                ],
            }),
        );
        assert_eq!(c.hunks.len(), 2);
        assert_eq!(c.removed, 2);
        assert_eq!(c.added, 3);
        assert_eq!(c.kind, ChangeKind::MultiEdit);
    }

    #[test]
    fn an_oversized_side_degrades_to_a_block_replace_and_says_so() {
        // Silently rendering a DIFFERENT quality of diff than the card beside
        // it is the failure; degrading out loud is the fix.
        let huge: String = (0..LCS_MAX_LINES + 10).map(|i| format!("l{i}\n")).collect();
        let c = card(
            "capability:write",
            json!({"file_path": "big.rs", "content": huge}),
        );
        // 410 lines is over the LCS bound but under the render cap, so this
        // pins DEGRADATION alone — truncation is a separate axis with its own
        // test, and conflating them here would let either one pass for both.
        let note = c.hunks[0].note.as_deref().unwrap_or_default();
        assert!(note.contains("whole-block replace"), "{note}");
        assert!(
            c.render().contains(&format!("@@ hunk 1/1 · {note} @@")),
            "the degrade must be stated ON the card: {}",
            c.render()
        );
        assert!(!c.truncated, "410 lines is under the {MAX_CARD_LINES} cap");
        assert_eq!(c.added, LCS_MAX_LINES + 10);
    }

    #[test]
    fn the_rendered_card_is_bounded_even_when_the_edit_is_not() {
        let huge: String = (0..5_000).map(|i| format!("l{i}\n")).collect();
        let c = card(
            "capability:write",
            json!({"file_path": "big.rs", "content": huge}),
        );
        let rendered_diff_lines = c.hunks.iter().map(|h| h.lines.len()).sum::<usize>();
        assert!(
            rendered_diff_lines <= MAX_CARD_LINES,
            "{rendered_diff_lines} diff lines exceeds the {MAX_CARD_LINES} cap"
        );
    }

    #[test]
    fn secrets_are_redacted_in_both_forms() {
        // The contract says "in both forms", and a change card is where the
        // exposure actually is: the text being written INTO a file.
        let secret = format!("{}{}", "sk-", "ant-abcdefghijklmnopqrstuvwxyz0123");
        let c = card(
            "capability:write",
            json!({"file_path": ".env", "content": format!("ANTHROPIC_API_KEY={secret}\n")}),
        );
        let rendered = c.render();
        let raw = c.raw();
        assert!(!rendered.contains(&secret), "rendered leaked: {rendered}");
        assert!(!raw.contains(&secret), "raw leaked: {raw}");
        assert!(rendered.contains(REDACTED), "{rendered}");
        assert!(raw.contains(REDACTED), "{raw}");
    }

    #[test]
    fn a_failed_edit_still_gets_a_card_carrying_what_was_attempted() {
        let mut t = call(
            "capability:edit",
            json!({"file_path": "x.rs", "old_string": "a", "new_string": "b"}),
        );
        t.outcome = ToolOutcome::Failed("not_found: old_string not found".into());
        let c = card_for_tool(&t, 0, 0).expect("a failed edit is still a change card");
        assert!(c.title().contains("FAILED"), "{}", c.title());
        let body = c.render();
        assert!(body.contains("not_found"), "{body}");
        assert!(
            body.contains("-a"),
            "the attempt itself must survive: {body}"
        );
    }

    #[test]
    fn copy_goes_through_the_one_shared_path_and_carries_both_forms() {
        // The whole point of resolving to a CopyBlock: `y`/`Shift-Y` on a
        // change card must hit the same redact/truncate/encode/ack code as the
        // transcript, not a second copy path that drifts away from it.
        let c = card(
            "capability:edit",
            json!({"file_path": "x.rs", "old_string": "a", "new_string": "b"}),
        );
        let block = c.copy_block();
        assert_eq!(block.index, 0, "the block must name its message");

        let CopyOutcome::Copied { ack, .. } =
            copy_block(&block, CopyForm::Rendered, Passthrough::None)
        else {
            panic!("y must copy the rendered diff");
        };
        assert!(ack.starts_with("Copied edit card rendered"), "{ack}");

        let CopyOutcome::Copied { ack, .. } = copy_block(&block, CopyForm::Raw, Passthrough::None)
        else {
            panic!("Shift-Y must copy the raw payload");
        };
        assert!(ack.starts_with("Copied edit card raw"), "{ack}");
    }

    #[test]
    fn the_raw_form_is_the_call_verbatim_not_the_rendered_diff() {
        let c = card(
            "capability:edit",
            json!({"file_path": "x.rs", "old_string": "a", "new_string": "b", "replace_all": true}),
        );
        let raw: Value = serde_json::from_str(&c.raw()).expect("raw must be valid JSON");
        assert_eq!(raw["tool"], "capability:edit");
        assert_eq!(raw["input"]["old_string"], "a");
        assert_eq!(raw["input"]["replace_all"], true);
        assert!(c.title().contains("all occurrences"), "{}", c.title());
    }

    #[test]
    fn cards_are_collected_in_transcript_order_with_their_addresses() {
        let mut m0 = ChatMessage::assistant("first");
        m0.tools = vec![
            call("Bash", json!({"command": "ls"})),
            call(
                "capability:edit",
                json!({"file_path": "a.rs", "old_string": "x", "new_string": "y"}),
            ),
        ];
        let mut m1 = ChatMessage::assistant("second");
        m1.tools = vec![call(
            "capability:write",
            json!({"file_path": "b.rs", "content": "z\n"}),
        )];

        // The transcript addresses a card by (message, call) so it can be
        // re-found without re-running detection. The non-editing `Bash` call
        // still consumes tool_index 0, which is the part a naive `enumerate()`
        // over only the cards would get wrong.
        let m0_cards = cards_for_message(&m0, 1);
        let m1_cards = cards_for_message(&m1, 2);
        assert_eq!(m0_cards.len(), 1, "only the editing call is a card");
        assert_eq!((m0_cards[0].message_index, m0_cards[0].tool_index), (1, 1));
        assert_eq!(m0_cards[0].path, "a.rs");
        assert_eq!(m1_cards.len(), 1);
        assert_eq!((m1_cards[0].message_index, m1_cards[0].tool_index), (2, 0));
        assert_eq!(m1_cards[0].path, "b.rs");
        assert!(
            cards_for_message(&ChatMessage::user("go"), 0).is_empty(),
            "a message with no tool calls has no cards"
        );
    }

    /// `is_change_card` is what the transcript paints its "Enter to open"
    /// affordance from, and `card_for_tool` is what Enter then runs. If they
    /// ever disagree the UI offers a diff that does not open (or hides one that
    /// would), so pin them to each other over the awkward inputs rather than
    /// trusting that they share `admit`.
    #[test]
    fn the_cheap_predicate_admits_exactly_what_card_for_tool_admits() {
        let mut no_input = call("capability:edit", json!({}));
        no_input.input = None;
        let cases: Vec<ChatToolCall> = vec![
            // Admitted.
            call(
                "capability:edit",
                json!({"file_path": "a.rs", "old_string": "x", "new_string": "y"}),
            ),
            call("Write", json!({"file_path": "a.rs", "content": "x\n"})),
            call(
                "MultiEdit",
                json!({"file_path": "a.rs", "edits": [{"old_string": "x", "new_string": "y"}]}),
            ),
            // A no-op edit is STILL a card (it renders "no textual change"),
            // which is the case a "does it have hunks?" predicate would miss.
            call(
                "Edit",
                json!({"file_path": "a.rs", "old_string": "same", "new_string": "same"}),
            ),
            // Refused, one reason each.
            call("Bash", json!({"command": "ls"})),
            no_input,
            call("capability:edit", json!("not-an-object")),
            call("capability:edit", json!({"old_string": "x"})),
            call("MultiEdit", json!({"file_path": "a.rs"})),
        ];
        let mut admitted = 0usize;
        for t in &cases {
            let built = card_for_tool(t, 0, 0).is_some();
            assert_eq!(
                is_change_card(t),
                built,
                "predicate and builder disagree on {}: {:?}",
                t.name,
                t.input
            );
            if built {
                admitted += 1;
            }
        }
        // CALIBRATION: an `is_change_card` hard-wired to `true` — or to
        // `false` — passes every assertion above only if the table is lopsided.
        // Both populations have to be non-empty for the agreement to mean
        // anything.
        assert_eq!(admitted, 4, "the fixture table must exercise both answers");
        assert_eq!(cases.len() - admitted, 5);
    }

    #[test]
    fn a_no_op_edit_renders_no_hunks_rather_than_an_empty_diff_frame() {
        let c = card(
            "Edit",
            json!({"file_path": "x.rs", "old_string": "same", "new_string": "same"}),
        );
        assert!(c.hunks.is_empty());
        assert_eq!((c.added, c.removed), (0, 0));
        assert!(c.render().contains("(no textual change)"), "{}", c.render());
    }
}
