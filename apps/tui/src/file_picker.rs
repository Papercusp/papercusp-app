//! Composer file/attachment picker — the in-PUI, project-scoped `@` surface.
//!
//! > When the composer is focused, @ opens a project-scoped file/attachment
//! > picker. Every selected attachment is shown above the draft by
//! > project-relative path, kind, and stable reference. Removing an attachment
//! > does not alter the file. Cross-project and unreadable paths are refused
//! > with the reason; PUI never falls back to a similarly named file.
//! >
//! > — `apps/tui/PUBLIC_RELEASE_UX.md:315-319`
//!
//! # What is actually load-bearing here
//!
//! The listing is the visible part; the REFUSAL is the part the contract is
//! really about, and it is what the P-007 spec clause PUI-FILE-CONTEXT names as
//! its falsifier ("picker attaches content from an unselected project"). So the
//! resolution below is written to fail CLOSED:
//!
//!   * a path is admitted only if its CANONICAL form is inside the canonical
//!     project root, which is what makes `..` traversal and symlinks-out-of-tree
//!     refusals rather than loopholes; and
//!   * there is deliberately NO name-based search anywhere in this module.
//!
//! That second point is the subtle one. The natural way to write a picker is to
//! take what the user typed and go looking for it — and a lookup by file NAME
//! turns "you asked for a file outside this project" into "here is the
//! same-named file inside it", silently attaching the wrong file's contents
//! while looking like it worked. There is no such fallback here, and
//! [`tests::refuses_a_cross_project_path_that_shares_a_basename_with_an_in_project_file`]
//! exists to keep it that way: it is the one test that would still pass if the
//! refusal were merely cosmetic, so it asserts the returned refusal AND that no
//! attachment is produced.
//!
//! # Why `root` is a parameter
//!
//! Resolution is a pure function of (root, candidate). The app supplies the
//! session's own project root; this module never consults the process cwd,
//! which would make the same input resolve differently depending on where the
//! PUI happened to be launched from.

use std::fmt;
use std::path::{Path, PathBuf};

/// Why a candidate path cannot become an attachment.
///
/// Carried as a value rather than a bare `None` because the contract requires
/// the PUI to SAY why — a picker that silently drops a refused path is
/// indistinguishable from one that is broken.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// The path resolves outside the project root.
    OutsideProject { shown: String, root: String },
    /// The path could not be read (missing, permission denied, broken symlink).
    Unreadable { shown: String, reason: String },
    /// The path resolves to something that is not a regular file.
    NotAFile { shown: String },
}

impl Refusal {
    /// One line, suitable for the picker's error row. States the path AND the
    /// reason: "refused" alone would leave the reader guessing which rule fired.
    pub fn reason(&self) -> String {
        match self {
            Refusal::OutsideProject { shown, root } => {
                format!("{shown} is outside this project ({root}) — cross-project paths are never attached")
            }
            Refusal::Unreadable { shown, reason } => format!("{shown} is unreadable: {reason}"),
            Refusal::NotAFile { shown } => format!("{shown} is not a regular file"),
        }
    }
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.reason())
    }
}

/// The coarse kind shown beside an attachment. Deliberately coarse: this is a
/// label for a human scanning the list above their draft, not a MIME type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachmentKind {
    Text,
    Image,
    Binary,
}

impl AttachmentKind {
    pub fn label(self) -> &'static str {
        match self {
            AttachmentKind::Text => "text",
            AttachmentKind::Image => "image",
            AttachmentKind::Binary => "binary",
        }
    }

    /// Classified by extension only. A content sniff would be more accurate and
    /// is deliberately not done: the picker must stay responsive while the user
    /// types, and reading every candidate to label it would put file IO on the
    /// keystroke path — the quadratic-work-per-frame shape the performance guide
    /// opens with.
    fn of(path: &Path) -> Self {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        match ext.as_str() {
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "ico" | "avif" => {
                AttachmentKind::Image
            }
            "zip" | "gz" | "tar" | "bz2" | "xz" | "zst" | "pdf" | "wasm" | "so" | "dylib"
            | "dll" | "exe" | "bin" | "o" | "a" | "class" | "jar" | "mp3" | "mp4" | "mov"
            | "wav" | "ogg" | "webm" => AttachmentKind::Binary,
            _ => AttachmentKind::Text,
        }
    }
}

/// One file the owner chose to put in front of the agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    /// Project-relative, forward-slashed. This is the only spelling shown and
    /// the only one sent: an absolute path would leak the owner's home layout
    /// into the transcript and would not be meaningful to the agent.
    pub path: String,
    pub kind: AttachmentKind,
    /// The stable reference displayed before send.
    ///
    /// It is `@<project-relative path>` — stable because it is derived from the
    /// canonical project-relative path rather than from selection order or a
    /// per-session counter, so the same file always carries the same reference
    /// and the agent can be told about it twice without ambiguity.
    pub reference: String,
}

impl Attachment {
    /// The row rendered above the draft: path, kind, and stable reference, in
    /// the order the contract lists them.
    pub fn row(&self) -> String {
        format!("{} · {} · {}", self.path, self.kind.label(), self.reference)
    }
}

/// Normalise to forward slashes so a reference is identical across platforms.
fn slashed(path: &Path) -> String {
    path.components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// Resolve a candidate path into an [`Attachment`], or refuse it WITH a reason.
///
/// `root` is the project root; `candidate` may be absolute or relative to it.
///
/// Both sides are canonicalised before comparison, which is what makes `..`
/// traversal and out-of-tree symlinks refusals instead of escapes: comparing
/// the LEXICAL path would admit `root/../other/secret.txt`, since it starts
/// with `root` as text.
pub fn attach(root: &Path, candidate: &Path) -> Result<Attachment, Refusal> {
    let shown = slashed(candidate);
    let canonical_root = root.canonicalize().map_err(|e| Refusal::Unreadable {
        shown: slashed(root),
        reason: e.to_string(),
    })?;
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        canonical_root.join(candidate)
    };
    // A failure here is the "unreadable" arm of the contract: missing, denied,
    // or a broken symlink all land as a refusal carrying the OS reason, and
    // NONE of them fall through to a search by name.
    let canonical = joined.canonicalize().map_err(|e| Refusal::Unreadable {
        shown: shown.clone(),
        reason: e.to_string(),
    })?;
    if !canonical.starts_with(&canonical_root) {
        return Err(Refusal::OutsideProject {
            shown,
            root: slashed(&canonical_root),
        });
    }
    if !canonical.is_file() {
        return Err(Refusal::NotAFile { shown });
    }
    let relative: PathBuf = canonical
        .strip_prefix(&canonical_root)
        .unwrap_or(&canonical)
        .to_path_buf();
    let path = slashed(&relative);
    Ok(Attachment {
        kind: AttachmentKind::of(&canonical),
        reference: format!("@{path}"),
        path,
    })
}

/// The composer's attachment list.
///
/// Separate from the picker modal on purpose: attachments outlive the picker
/// (they sit above the draft until sent or removed), so their state cannot hang
/// off the transient surface that produced them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Attachments {
    items: Vec<Attachment>,
}

impl Attachments {
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    /// Add an attachment, ignoring an exact repeat.
    ///
    /// De-duplication is by stable reference, which is the point of the
    /// reference being stable: selecting the same file twice must not put two
    /// copies of its contents in front of the agent.
    pub fn add(&mut self, attachment: Attachment) -> bool {
        if self
            .items
            .iter()
            .any(|a| a.reference == attachment.reference)
        {
            return false;
        }
        self.items.push(attachment);
        true
    }

    /// Remove by stable reference.
    ///
    /// This touches THIS LIST ONLY — never the file. The contract calls that
    /// out ("Removing an attachment does not alter the file") because a picker
    /// that offered removal could plausibly be read as offering deletion, and
    /// the safe reading has to be the implemented one.
    pub fn remove(&mut self, reference: &str) -> bool {
        let before = self.items.len();
        self.items.retain(|a| a.reference != reference);
        self.items.len() != before
    }

    /// The block rendered ABOVE the draft, one row per attachment.
    pub fn rows(&self) -> Vec<String> {
        self.items.iter().map(Attachment::row).collect()
    }

    /// Whether this exact reference is already attached.
    pub fn contains(&self, reference: &str) -> bool {
        self.items.iter().any(|a| a.reference == reference)
    }

    /// Stable references in the order the owner selected them.
    ///
    /// The next accepted prompt carries exactly these values. Returning owned
    /// strings lets the in-flight turn retain its snapshot while the composer
    /// starts collecting attachments for a later turn.
    pub fn references(&self) -> Vec<String> {
        self.items.iter().map(|a| a.reference.clone()).collect()
    }

    /// Append the selected project-scoped references to the exact draft bytes.
    ///
    /// Attachments live beside the editor so undo/history cannot rewrite them,
    /// but the engine protocol accepts one text prompt. Joining only at this
    /// boundary keeps the draft byte-identical in the editor/history while the
    /// accepted turn receives every explicit stable reference.
    pub fn attach_to_prompt(&self, draft: &str) -> String {
        let references = self.references().join("\n");
        if references.is_empty() {
            return draft.to_string();
        }
        if draft.is_empty() {
            return references;
        }
        if draft.ends_with('\n') {
            format!("{draft}{references}")
        } else {
            format!("{draft}\n{references}")
        }
    }
}

/// Directory names never worth offering. Build output and dependency trees are
/// large enough to crowd the actual project out of a bounded listing, which
/// would make the picker look empty of the files the owner came for.
const SKIPPED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "coverage",
    "__pycache__",
];

/// Project-relative, forward-slashed paths of the regular files under `root`,
/// sorted, capped at `limit`.
///
/// # Why this is bounded, and why the bound is safe
///
/// The walk runs on the keystroke that opens the picker, so an unbounded walk
/// of a large checkout would stall the UI thread.
///
/// The cap is a LISTING cap only — it never widens or narrows what [`attach`]
/// admits. That separation is the point: the listing is a convenience, and
/// `attach` re-resolves every choice from scratch, so a file missing from the
/// listing is still attachable by typing its path, and a file PRESENT in the
/// listing is still canonicalised and range-checked before it can become an
/// attachment. No path reaches the agent because it appeared in this list.
///
/// Symlinks are not listed: [`std::fs::DirEntry::file_type`] does not follow
/// them, so a link reports neither `is_file` nor `is_dir` here. That is the
/// conservative direction — and a link the owner names explicitly is still
/// resolved (and refused, if it leaves the project) by `attach`.
pub fn list_project_files(root: &Path, limit: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut queue: std::collections::VecDeque<PathBuf> = std::collections::VecDeque::new();
    queue.push_back(root.to_path_buf());
    while let Some(dir) = queue.pop_front() {
        if out.len() >= limit {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            if file_type.is_dir() {
                if SKIPPED_DIRS.contains(&name.as_str()) || name.starts_with('.') {
                    continue;
                }
                queue.push_back(entry.path());
            } else if file_type.is_file() {
                if let Ok(rel) = entry.path().strip_prefix(root) {
                    out.push(slashed(rel));
                }
            }
        }
    }
    out.sort();
    out.truncate(limit);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A project root plus a sibling directory that is NOT part of it.
    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().join("project");
        let outside = tmp.path().join("other-project");
        fs::create_dir_all(root.join("src")).expect("mkdir project/src");
        fs::create_dir_all(&outside).expect("mkdir other-project");
        (tmp, root, outside)
    }

    #[test]
    fn attaches_an_in_project_file_by_project_relative_path() {
        let (_tmp, root, _outside) = fixture();
        fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();

        let attached = attach(&root, Path::new("src/main.rs")).expect("in-project file attaches");

        assert_eq!(attached.path, "src/main.rs");
        assert_eq!(attached.kind, AttachmentKind::Text);
        assert_eq!(attached.reference, "@src/main.rs");
        // The row carries all three things the contract says are shown.
        assert_eq!(attached.row(), "src/main.rs · text · @src/main.rs");
    }

    #[test]
    fn an_absolute_in_project_path_still_resolves_to_the_relative_spelling() {
        let (_tmp, root, _outside) = fixture();
        fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();

        let attached = attach(&root, &root.join("src/main.rs")).expect("absolute in-project");

        assert_eq!(attached.path, "src/main.rs");
        assert_eq!(attached.reference, "@src/main.rs");
    }

    /// THE clause falsifier, in unit form.
    ///
    /// A cross-project file whose BASENAME also exists inside the project is the
    /// exact input that a name-based fallback would resolve to the wrong file
    /// while looking entirely successful. The assertion is therefore twofold:
    /// the call refuses, AND it refuses for the cross-project reason rather than
    /// quietly returning the in-project namesake.
    #[test]
    fn refuses_a_cross_project_path_that_shares_a_basename_with_an_in_project_file() {
        let (_tmp, root, outside) = fixture();
        fs::write(root.join("src/main.rs"), "the in-project file").unwrap();
        fs::write(outside.join("main.rs"), "the OTHER project's file").unwrap();

        let refused = attach(&root, &outside.join("main.rs")).expect_err("must refuse");

        match &refused {
            Refusal::OutsideProject { .. } => {}
            other => panic!("expected OutsideProject, got {other:?}"),
        }
        assert!(
            refused.reason().contains("outside this project"),
            "the refusal must SAY why: {}",
            refused.reason()
        );
    }

    #[test]
    fn refuses_a_parent_traversal_that_escapes_the_project() {
        let (_tmp, root, outside) = fixture();
        fs::write(outside.join("secret.txt"), "not yours").unwrap();

        // Lexically this starts with the project root; canonically it does not.
        let refused = attach(&root, Path::new("../other-project/secret.txt"))
            .expect_err("`..` traversal must not escape the project");

        assert!(
            matches!(refused, Refusal::OutsideProject { .. }),
            "{refused:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_that_points_out_of_the_project() {
        let (_tmp, root, outside) = fixture();
        fs::write(outside.join("secret.txt"), "not yours").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("link.txt")).unwrap();

        // The symlink itself lives inside the project, so only canonicalisation
        // can tell that its TARGET does not.
        let refused = attach(&root, Path::new("link.txt"))
            .expect_err("an out-of-tree symlink must be refused");

        assert!(
            matches!(refused, Refusal::OutsideProject { .. }),
            "{refused:?}"
        );
    }

    #[test]
    fn refuses_a_missing_path_with_the_reason_and_never_a_namesake() {
        let (_tmp, root, _outside) = fixture();
        fs::write(root.join("src/main.rs"), "the real one").unwrap();

        // A file that does not exist, whose basename DOES exist elsewhere in the
        // project: the refusal must not become a search.
        let refused = attach(&root, Path::new("does/not/exist/main.rs")).expect_err("must refuse");

        assert!(matches!(refused, Refusal::Unreadable { .. }), "{refused:?}");
        assert!(
            refused.reason().contains("unreadable"),
            "{}",
            refused.reason()
        );
    }

    #[test]
    fn refuses_a_directory() {
        let (_tmp, root, _outside) = fixture();

        let refused = attach(&root, Path::new("src")).expect_err("a directory is not a file");

        assert!(matches!(refused, Refusal::NotAFile { .. }), "{refused:?}");
    }

    #[test]
    fn classifies_kind_by_extension() {
        let (_tmp, root, _outside) = fixture();
        fs::write(root.join("shot.PNG"), "x").unwrap();
        fs::write(root.join("bundle.tar"), "x").unwrap();
        fs::write(root.join("notes.md"), "x").unwrap();

        assert_eq!(
            attach(&root, Path::new("shot.PNG")).unwrap().kind,
            AttachmentKind::Image
        );
        assert_eq!(
            attach(&root, Path::new("bundle.tar")).unwrap().kind,
            AttachmentKind::Binary
        );
        assert_eq!(
            attach(&root, Path::new("notes.md")).unwrap().kind,
            AttachmentKind::Text
        );
    }

    #[test]
    fn removing_an_attachment_leaves_the_file_alone() {
        let (_tmp, root, _outside) = fixture();
        let file = root.join("src/main.rs");
        fs::write(&file, "still here").unwrap();

        let mut attachments = Attachments::default();
        attachments.add(attach(&root, Path::new("src/main.rs")).unwrap());
        assert_eq!(attachments.len(), 1);

        assert!(attachments.remove("@src/main.rs"));

        assert!(attachments.is_empty());
        // The whole point of the contract line.
        assert_eq!(fs::read_to_string(&file).unwrap(), "still here");
        assert!(file.exists());
    }

    #[test]
    fn selecting_the_same_file_twice_does_not_duplicate_it() {
        let (_tmp, root, _outside) = fixture();
        fs::write(root.join("src/main.rs"), "x").unwrap();

        let mut attachments = Attachments::default();
        assert!(attachments.add(attach(&root, Path::new("src/main.rs")).unwrap()));
        // Same file reached by an absolute path: the stable reference is what
        // makes this recognisable as a repeat.
        assert!(!attachments.add(attach(&root, &root.join("src/main.rs")).unwrap()));

        assert_eq!(attachments.len(), 1);
        assert_eq!(
            attachments.rows(),
            vec!["src/main.rs · text · @src/main.rs"]
        );
    }

    #[test]
    fn selected_references_are_attached_to_the_prompt_without_rewriting_the_draft() {
        let (_tmp, root, _outside) = fixture();
        fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        fs::write(root.join("shot.PNG"), "image").unwrap();
        let mut attachments = Attachments::default();
        attachments.add(attach(&root, Path::new("src/main.rs")).unwrap());
        attachments.add(attach(&root, Path::new("shot.PNG")).unwrap());

        let draft = "  inspect these λ  ";
        assert_eq!(
            attachments.attach_to_prompt(draft),
            "  inspect these λ  \n@src/main.rs\n@shot.PNG"
        );
        assert_eq!(
            draft, "  inspect these λ  ",
            "the editor draft is not mutated"
        );
        assert_eq!(
            attachments.references(),
            vec!["@src/main.rs".to_string(), "@shot.PNG".to_string()]
        );
    }

    #[test]
    fn an_empty_attachment_list_leaves_every_draft_byte_unchanged() {
        let attachments = Attachments::default();
        let draft = "  exact draft λ  \n";
        assert_eq!(attachments.attach_to_prompt(draft), draft);
    }
}
