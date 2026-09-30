//! Surface × state coverage census for the `pui` workbench.
//!
//! Plan `pui-tui-next-wave-2026-09-05` P-007 — closes WI-573215 ("you cannot
//! tell an unexercised state from a healthy one"). Every public destination in
//! `Tab::ALL` is rendered OFFLINE through the ratatui `TestBackend` in each of
//! five states — loading · empty · error · populated · keyboard — from a
//! hand-built `App` fixture, and every (surface × state) cell is classified:
//!
//! * **exercised** — the fixture renders and a state-specific MARKER string is
//!   asserted in the pinned BODY render (pinned mode draws only `draw_tab_body`
//!   over the whole frame: no tab strip, no HUD, so the strip can never satisfy
//!   the assertion on the body's behalf);
//! * **not-applicable** — the surface has no such state in code today and the
//!   REASON is recorded verbatim, so a reader can tell "healthy" from "never
//!   rendered". WI-573215's D-005 finding — several surfaces render an ERROR as
//!   an EMPTY state — shows up here as an explicit reason instead of an invented
//!   marker;
//! * **not-exercised** — the state exists but this census cannot build it
//!   offline; it is NAMED in the artifact so it is a tracked gap, not a silent one.
//!
//! The census table is DERIVED from `Tab::ALL` + the fixture table and pinned to
//! `docs/surface-state-census.md` (derived-truth ladder, rung 2):
//! `census_table_is_current` fails on drift and prints the regeneration command,
//! so the committed table can never claim something the code no longer does. A
//! JSON twin lands under `target/census/` for tooling.
//!
//! The non-strip `Tab` variants get a second table so P-014 (enum residue
//! cleanup) stays exhaustive after deleting the four retired shells. The three
//! remaining variants are live pane-only boards, with their dead public switch
//! keys, `from_title` migration targets, pinned renders, and source-site counts
//! all verified here.

use crate::app::{App, InboxFocus, Tab, TestRunState};
use crate::event::{Event, MemoryLoadState};
use crate::models::{
    AttentionItem, ChatMessage, CupboardListing, DocsResponse, EffectiveClaudeSettings,
    HarnessFeature, HarnessIssue, HarnessRef, MemoryEntry, NetworkBoardRow, PlanSummary,
    PresenceRow, RosterEntry, TestingDomain,
};
use crate::voice_ui::VoiceChannelRow;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::{backend::TestBackend, Terminal};
use serde_json::json;
use std::path::PathBuf;

/// Render size for every cell. Wide enough that no marker is clipped by a
/// column truncation, tall enough that every destination's body has room.
const W: u16 = 200;
const H: u16 = 50;

/// Number of `Tab` variants. The exhaustive `classify` match below forces a
/// compile error the moment the enum changes; update this constant in the same
/// edit so the partition check stays honest.
const TAB_VARIANT_COUNT: usize = 17;

/// The census artifact, relative to the crate root. Committed; pinned by
/// `census_table_is_current`.
const ARTIFACT_MD: &str = "docs/surface-state-census.md";
/// Regeneration switch: `PUI_CENSUS_UPDATE=1 cargo test census_table_is_current`.
const UPDATE_ENV: &str = "PUI_CENSUS_UPDATE";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Loading,
    Empty,
    Error,
    Populated,
    Keyboard,
}

impl State {
    const ALL: [State; 5] = [
        State::Loading,
        State::Empty,
        State::Error,
        State::Populated,
        State::Keyboard,
    ];

    fn name(self) -> &'static str {
        match self {
            State::Loading => "loading",
            State::Empty => "empty",
            State::Error => "error",
            State::Populated => "populated",
            State::Keyboard => "keyboard",
        }
    }
}

/// One (surface × state) cell's classification. `Exercised` is VERIFIED by the
/// render (the marker must appear in the body); the other two are authored
/// reasons that the artifact carries verbatim.
#[derive(Debug, Clone)]
enum Cell {
    Exercised {
        marker: &'static str,
        fixture: &'static str,
    },
    NotApplicable {
        reason: &'static str,
    },
    NotExercised {
        reason: &'static str,
    },
}

/// How a `Tab` variant is reachable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Class {
    /// In `Tab::ALL`: tab strip + switch key.
    Public,
    /// Not in the strip; rendered only as a pinned dock pane via a `pui
    /// <x>-pane` subcommand (`main.rs` resolves the subcommand to the variant).
    PaneOnly,
}

/// Exhaustive on purpose: adding or deleting a `Tab` variant fails to compile
/// here, which is the guard that keeps `TAB_VARIANT_COUNT` and the non-strip
/// table honest.
fn classify(tab: Tab) -> Class {
    match tab {
        Tab::Overview
        | Tab::Operator
        | Tab::Inbox
        | Tab::Plans
        | Tab::Fleet
        | Tab::Sessions
        | Tab::Harnesses
        | Tab::Docs
        | Tab::Testing
        | Tab::Config
        | Tab::Memory
        | Tab::Cupboard
        | Tab::Voice
        | Tab::Network => Class::Public,
        Tab::Wake | Tab::AgentCtx | Tab::PlansBoard => Class::PaneOnly,
    }
}

/// The non-strip variants with the live door (if any) that reaches them.
const NON_STRIP: [(Tab, &str); 3] = [
    (
        Tab::Wake,
        "pane-only — `pui wake-pane` (main.rs pinned subcommand)",
    ),
    (
        Tab::AgentCtx,
        "pane-only — `pui prompt-pane` | `mail-pane` | `work-pane` (main.rs pinned subcommand)",
    ),
    (
        Tab::PlansBoard,
        "pane-only — `pui context-pane` | `plans-pane` (main.rs pinned subcommand)",
    ),
];

// ───────────────────────────── fixtures ─────────────────────────────

fn app_on(tab: Tab) -> App {
    let mut app = App::new();
    app.tab = tab;
    app
}

fn press(app: &mut App, code: KeyCode) {
    let _ = app.update(Event::Key(KeyEvent::new(code, KeyModifiers::NONE)));
}

/// Build an operator-API DTO from a minimal JSON object. Every model in
/// `models.rs` defaults its optional fields on deserialize (shape drift never
/// hard-fails), so a fixture only has to name the fields a marker depends on.
fn de<T: serde::de::DeserializeOwned>(v: serde_json::Value) -> T {
    serde_json::from_value(v).expect("census fixture must deserialize")
}

fn plan(slug: &str) -> PlanSummary {
    PlanSummary {
        slug: slug.into(),
        title: format!("Title {slug}"),
        status: "active".into(),
        updated: "2026-09-05".into(),
        owner: Some("o@x.z".into()),
        harness: Some("papercup".into()),
        archived: false,
        next_action: Some("do the thing".into()),
        item_counts: Default::default(),
        open: None,
        done: None,
        priority: None,
    }
}

fn roster(owner_id: &str, label: &str) -> RosterEntry {
    RosterEntry {
        owner_id: owner_id.into(),
        label: label.into(),
        liveness: "live".into(),
        ..Default::default()
    }
}

fn attention(title: &str) -> AttentionItem {
    de(json!({
        "id": "att-census",
        "kind": "decision",
        "source": "census",
        "title": title,
        "status": "open",
        "needsHuman": true,
        "tier": "decision",
    }))
}

fn settings(effective: serde_json::Value, file_keys: &[&str]) -> EffectiveClaudeSettings {
    EffectiveClaudeSettings {
        content: effective.to_string(),
        effective,
        file_keys: file_keys.iter().map(|k| (*k).to_string()).collect(),
        parse_error: None,
    }
}

/// Load the one-row POPULATED fixture for `tab` and return the marker the body
/// must show. Shared by the `populated` and `keyboard` states.
fn populate(app: &mut App, tab: Tab) -> &'static str {
    match tab {
        Tab::Overview => {
            app.set_plans(vec![plan("census-plan")]);
            app.set_inbox(vec![attention("Census attention row")]);
            app.set_roster(vec![roster("su-census", "census-agent")]);
            " Plans (1)"
        }
        Tab::Operator => {
            app.set_chat_history(
                "conv-census".into(),
                vec![
                    ChatMessage::user("census hello"),
                    ChatMessage::assistant("census reply"),
                ],
                false,
                None,
            );
            "census reply"
        }
        Tab::Inbox => {
            app.set_inbox(vec![attention("Census attention row")]);
            "Census attention row"
        }
        Tab::Plans => {
            app.set_plans(vec![plan("census-plan")]);
            "census-plan"
        }
        Tab::Fleet => {
            // Roster groups render COLLAPSED by default ("▸ No fleet (1)"), so
            // the row label is hidden; the header's online count and the
            // footer's `id: su-censu` are what a one-row roster changes.
            app.set_roster(vec![roster("su-census", "census-agent")]);
            "1/1 online"
        }
        Tab::Sessions => {
            // The WHEN facet defaults to 7d and hides a row with no timestamp;
            // pick "all" (SESSION_BROWSER_WHEN[2]) so the fixture stays
            // clock-independent instead of forging a heartbeat.
            app.session_browser.rows = vec![roster("su-census", "census-session")];
            app.session_browser.when_idx = 2;
            "census-session"
        }
        Tab::Harnesses => {
            app.set_harnesses(vec![de::<HarnessRef>(json!({ "slug": "census-pot" }))]);
            app.set_features(vec![de::<HarnessFeature>(json!({
                "id": "F-census",
                "title": "Census feature",
                "status": "open",
            }))]);
            app.set_issues(vec![de::<HarnessIssue>(json!({
                "id": "EI-census",
                "title": "Census issue",
                "status": "open",
            }))]);
            "Census feature"
        }
        Tab::Docs => {
            app.set_docs(de::<DocsResponse>(json!({
                "files": ["census.md"],
                "activePath": "census.md",
                "content": "Census doc body",
            })));
            "Census doc body"
        }
        Tab::Testing => {
            app.set_testing(vec![de::<TestingDomain>(json!({
                "id": "census-domain",
                "label": "Census domain",
            }))]);
            "Census domain"
        }
        Tab::Config => {
            app.set_config(settings(json!({ "model": "census-model" }), &["model"]));
            "census-model"
        }
        Tab::Memory => {
            app.memory_available = true;
            app.memory_load_state = MemoryLoadState::Available { results: vec![] };
            app.memories = vec![MemoryEntry {
                id: "m-census".into(),
                memory: "census memory text".into(),
                ..Default::default()
            }];
            "census memory text"
        }
        Tab::Cupboard => {
            app.cupboard = vec![CupboardListing {
                id: "l-census".into(),
                listing_kind: "harness".into(),
                title: Some("Census listing".into()),
                ..Default::default()
            }];
            "Census listing"
        }
        Tab::Voice => {
            app.voice_ui.connected = true;
            app.voice_ui.channels = vec![VoiceChannelRow {
                id: "ch-census".into(),
                name: "census-channel".into(),
            }];
            "census-channel"
        }
        Tab::Network => {
            app.network_rows = vec![NetworkBoardRow {
                key: "hive-census".into(),
                title: "Census Hive".into(),
                tier: 3,
                trust: "verified".into(),
                ..Default::default()
            }];
            app.hives = vec![PresenceRow {
                owner_id: "su-peer".into(),
                owner_label: "census-peer".into(),
                host: "census-host".into(),
                ..Default::default()
            }];
            "Census Hive"
        }
        other => unreachable!("census fixtures cover Tab::ALL only, got {other:?}"),
    }
}

fn empty(app: &mut App, tab: Tab) -> Cell {
    let ex = |marker, fixture| Cell::Exercised { marker, fixture };
    match tab {
        Tab::Overview => ex("no alerts", "App::new() — no plans/inbox/roster"),
        Tab::Operator => ex("No messages yet", "App::new() — no chat history"),
        Tab::Inbox => ex(
            "Inbox facet empty",
            "App::new() — default Needs-you facet, no attention items",
        ),
        Tab::Plans => ex("No plans loaded.", "App::new() — no plans"),
        Tab::Fleet => ex("(no agents in the fleet)", "App::new() — empty roster"),
        Tab::Sessions => ex(" sessions ", "App::new() — empty session_browser.rows (header only: the list has NO explicit empty-state text — finding F-1)"),
        Tab::Harnesses => ex("No features.", "App::new() — no features/issues"),
        Tab::Docs => ex("(no docs — select a file)", "App::new() — no docs"),
        Tab::Testing => ex("domains (0)", "App::new() — no testing domains"),
        Tab::Config => {
            app.set_config(settings(json!({}), &[]));
            ex("(no settings file for this pot", "set_config(effective: {}, file_keys: [])")
        }
        Tab::Memory => {
            app.memory_available = true;
            ex("(no memories stored yet)", "memory_available = true, memories = []")
        }
        Tab::Cupboard => ex("(no listings — r refetches)", "App::new() — no listings"),
        Tab::Voice => {
            app.voice_ui.connected = true;
            ex("(no channels — press n to create)", "voice_ui.connected = true, channels = []")
        }
        Tab::Network => ex(
            "no pot contexts on the network board yet",
            "App::new() — no network_rows / hives",
        ),
        other => unreachable!("census fixtures cover Tab::ALL only, got {other:?}"),
    }
}

fn loading(app: &mut App, tab: Tab) -> Cell {
    let ex = |marker, fixture| Cell::Exercised { marker, fixture };
    let na = |reason| Cell::NotApplicable { reason };
    match tab {
        Tab::Overview => na(
            "Overview composes tiles from already-loaded App vectors; no loading flag exists — it renders as EMPTY until data lands",
        ),
        Tab::Operator => {
            populate(app, tab);
            app.chat_loading_earlier = true;
            ex("↑ loading…", "populate() + chat_loading_earlier = true")
        }
        Tab::Inbox => {
            app.inbox_focus = InboxFocus::Threads;
            app.conversations_loading = true;
            ex(
                "Loading conversations…",
                "inbox_focus = Threads, conversations_loading = true (the Attention sub-view has no loading flag)",
            )
        }
        Tab::Plans => na("no loading flag; renders as EMPTY (\"No plans loaded.\") until set_plans"),
        Tab::Fleet => ex(
            "(loading work frontier…)",
            "App::new() — fleet.frontier = None, frontier_error = None",
        ),
        Tab::Sessions => {
            app.session_browser.loading = true;
            ex("searching…", "session_browser.loading = true")
        }
        Tab::Harnesses => na("no loading flag; renders as EMPTY (\"No features.\") until set_features"),
        Tab::Docs => na("no loading flag; renders as EMPTY until set_docs"),
        Tab::Testing => {
            app.testing_files_loading = true;
            ex("loading files…", "testing_files_loading = true (files column)")
        }
        Tab::Config => ex(
            "(loading…)",
            "App::new() — config.effective is JSON null until set_config",
        ),
        Tab::Memory => na(
            "MemoryLoadState has no Loading variant; before the first load the tab renders BackendUnavailable{None} (\"not configured yet\"), indistinguishable from a real backend-unavailable — finding F-2",
        ),
        Tab::Cupboard => {
            app.cupboard_loading = true;
            ex("(loading the Cupboard…)", "cupboard_loading = true")
        }
        Tab::Voice => na(
            "connection is a binary `connected` flag; the pre-state renders \"(press Enter or r to connect)\", not a loading state",
        ),
        Tab::Network => na(
            "no loading flag; the empty text itself says an empty board \"usually means the network data endpoint isn't reachable yet\"",
        ),
        other => unreachable!("census fixtures cover Tab::ALL only, got {other:?}"),
    }
}

fn error(app: &mut App, tab: Tab) -> Cell {
    let ex = |marker, fixture| Cell::Exercised { marker, fixture };
    let na = |reason| Cell::NotApplicable { reason };
    match tab {
        Tab::Overview => na(
            "no error field feeds the Overview body; fetch failures surface in the HUD status line / toasts, which pinned mode does not draw",
        ),
        Tab::Operator => Cell::NotExercised {
            reason: "the only error rendering is ` · reconnecting` on a STALE SU-session binding (`app.su_session.stale`); building a live SuSessionState offline is out of this census's scope — covered by su_session tests",
        },
        Tab::Inbox => na(
            "no error representation: a failed attention fetch leaves the previous list, i.e. error renders as EMPTY (WI-573215 D-005)",
        ),
        Tab::Plans => na("no error representation: a failed plans fetch renders as EMPTY (WI-573215 D-005)"),
        Tab::Fleet => {
            app.fleet.frontier_error = Some("census frontier boom".into());
            ex(
                "frontier unavailable: census frontier boom",
                "fleet.frontier_error = Some(..)",
            )
        }
        Tab::Sessions => {
            app.session_browser.transcript_error = Some("census transcript error".into());
            ex("census transcript error", "session_browser.transcript_error = Some(..)")
        }
        Tab::Harnesses => na("no error representation: a failed features/issues fetch renders as EMPTY (WI-573215 D-005)"),
        Tab::Docs => na("no error representation: a failed docs fetch renders as EMPTY (WI-573215 D-005)"),
        Tab::Testing => {
            app.test_run = Some(TestRunState {
                running: false,
                run_id: Some("run-census".into()),
                file: "census.test.ts".into(),
                cancelling: false,
                status: "error".into(),
                output: "census run error".into(),
            });
            ex("census run error", "test_run = Some(status: error, output: ..)")
        }
        Tab::Config => {
            let mut s = settings(json!({}), &[]);
            s.parse_error = Some("census parse error".into());
            app.set_config(s);
            ex("file invalid: census parse error", "set_config(parse_error: Some(..))")
        }
        Tab::Memory => {
            app.memory_available = false;
            app.memory_load_state = MemoryLoadState::TransportFailure {
                message: "census transport".into(),
            };
            ex(
                "(memory request failed — census transport",
                "memory_load_state = TransportFailure (AuthFailure → \"(memory request unauthorized\", BackendUnavailable → \"(memory backend unavailable\" are the sibling markers)",
            )
        }
        Tab::Cupboard => na("no error field: a failed listings fetch renders the EMPTY hint (WI-573215 D-005)"),
        Tab::Voice => {
            app.voice_ui.error = Some("census voice error".into());
            ex("census voice error", "voice_ui.error = Some(..)")
        }
        Tab::Network => na(
            "no error field: an unreachable endpoint renders the EMPTY board text, which says so in prose (WI-573215 D-005)",
        ),
        other => unreachable!("census fixtures cover Tab::ALL only, got {other:?}"),
    }
}

fn build(tab: Tab, state: State) -> (App, Cell) {
    let mut app = app_on(tab);
    let cell = match state {
        State::Populated => {
            let marker = populate(&mut app, tab);
            Cell::Exercised {
                marker,
                fixture: "populate() — one-row fixture per data setter",
            }
        }
        State::Keyboard => {
            let marker = populate(&mut app, tab);
            press(&mut app, KeyCode::Down);
            press(&mut app, KeyCode::Up);
            Cell::Exercised {
                marker,
                fixture: "populate() + ↓ ↑ through App::update — body intact, no panic",
            }
        }
        State::Empty => empty(&mut app, tab),
        State::Loading => loading(&mut app, tab),
        State::Error => error(&mut app, tab),
    };
    (app, cell)
}

// ───────────────────────────── rendering ─────────────────────────────

/// Render ONLY the destination body (pinned mode) and return it row-major with
/// one `\n` per terminal row, so markers never straddle a row boundary.
fn render_body(app: &mut App, tab: Tab) -> String {
    assert!(
        !app.show_help && !app.show_notifs && app.toast.is_none(),
        "{tab:?}: an overlay is active, so a body-only render would measure the overlay"
    );
    app.pinned = Some(tab);
    let mut term = Terminal::new(TestBackend::new(W, H)).unwrap();
    term.draw(|f| crate::ui::draw(f, app)).unwrap();
    app.pinned = None;
    let cells: Vec<&str> = term
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|c| c.symbol())
        .collect();
    cells
        .chunks(W as usize)
        .map(|row| row.concat())
        .collect::<Vec<_>>()
        .join("\n")
}

fn nonblank(text: &str) -> usize {
    text.chars().filter(|c| !c.is_whitespace()).count()
}

// ───────────────────────────── census ─────────────────────────────

#[derive(Debug, Clone)]
struct Row {
    tab: Tab,
    state: State,
    cell: Cell,
    body_nonblank: usize,
}

fn run_census() -> Vec<Row> {
    let mut rows = Vec::with_capacity(Tab::ALL.len() * State::ALL.len());
    for tab in Tab::ALL {
        for state in State::ALL {
            let (mut app, cell) = build(tab, state);
            let body = render_body(&mut app, tab);
            let body_nonblank = nonblank(&body);
            assert!(
                body_nonblank > 0,
                "{tab:?}×{}: body rendered blank",
                state.name()
            );
            if let Cell::Exercised { marker, fixture } = &cell {
                assert!(
                    body.contains(marker),
                    "{tab:?}×{}: marker {marker:?} missing from the body render (fixture: {fixture})\n{body}",
                    state.name()
                );
            }
            rows.push(Row {
                tab,
                state,
                cell,
                body_nonblank,
            });
        }
    }
    rows
}

#[derive(Debug, Clone)]
struct NonStripRow {
    tab: Tab,
    class: Class,
    door: &'static str,
    switch_key: char,
    /// `app.tab` after pressing the variant's switch key from a fresh App.
    switch_lands_on: Tab,
    /// `Tab::from_title(tab.title())` — where persisted view-state naming this
    /// variant is re-pointed.
    from_title: Option<Tab>,
    pinned_body_nonblank: usize,
    /// `Tab::<Variant>` source sites per file (excluding this census).
    sites: Vec<(String, usize)>,
}

fn source_sites(tab: Tab) -> Vec<(String, usize)> {
    let needle = format!("Tab::{tab:?}");
    let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut out: Vec<(String, usize)> = Vec::new();
    let mut names: Vec<_> = std::fs::read_dir(&src)
        .expect("src dir")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".rs") && n != "census.rs")
        .collect();
    names.sort();
    for name in names {
        let text = std::fs::read_to_string(src.join(&name)).unwrap_or_default();
        let count = text
            .match_indices(&needle)
            .filter(|(i, m)| {
                // Word boundary: `Tab::Wake` must not count `Tab::WakeBoard`.
                let after = text[i + m.len()..].chars().next();
                !matches!(after, Some(c) if c.is_alphanumeric() || c == '_')
            })
            .count();
        if count > 0 {
            out.push((name, count));
        }
    }
    out
}

fn run_non_strip() -> Vec<NonStripRow> {
    NON_STRIP
        .iter()
        .map(|(tab, door)| {
            let tab = *tab;
            let mut app = App::new();
            press(&mut app, KeyCode::Char(tab.switch_key()));
            let switch_lands_on = app.tab;
            let mut pinned = App::new();
            let body = render_body(&mut pinned, tab);
            NonStripRow {
                tab,
                class: classify(tab),
                door,
                switch_key: tab.switch_key(),
                switch_lands_on,
                from_title: Tab::from_title(tab.title()),
                pinned_body_nonblank: nonblank(&body),
                sites: source_sites(tab),
            }
        })
        .collect()
}

// ───────────────────────────── artifact ─────────────────────────────

fn cell_md(cell: &Cell) -> String {
    match cell {
        Cell::Exercised { marker, .. } => format!("✓ `{}`", marker.replace('|', "\\|")),
        Cell::NotApplicable { reason } => format!("n/a — {}", reason.replace('|', "\\|")),
        Cell::NotExercised { reason } => {
            format!("✗ NOT EXERCISED — {}", reason.replace('|', "\\|"))
        }
    }
}

fn artifact_markdown(rows: &[Row], non_strip: &[NonStripRow]) -> String {
    let mut md = String::new();
    md.push_str("# pui surface × state census\n\n");
    md.push_str(
        "<!-- GENERATED by apps/tui/src/census.rs (`cargo test census`, plan pui-tui-next-wave-2026-09-05 P-007).\n     \
         Do not hand-edit: `census_table_is_current` fails when this file drifts from the code.\n     \
         Regenerate: cd apps/tui && PUI_CENSUS_UPDATE=1 cargo test census_table_is_current -->\n\n",
    );
    md.push_str(
        "Every public destination in `Tab::ALL` is rendered offline through the ratatui `TestBackend` \
         in PINNED mode (body only — no tab strip, no HUD) at 200×50, in five states. \
         A `✓` cell is VERIFIED by the test: the quoted marker string is asserted in the body render. \
         An `n/a` cell records, verbatim, why the surface has no such state in code today \
         (so \"healthy\" and \"never rendered\" stay distinguishable — WI-573215). \
         A `✗` cell is a state that exists but this census could not build offline; it is a tracked gap.\n\n",
    );
    md.push_str("States: **loading** = the surface's own loading flag/text · **empty** = zero rows after load · \
                 **error** = the surface's own failure rendering · **populated** = a one-row fixture through the tab's data setter · \
                 **keyboard** = the populated fixture after `↓` `↑` through `App::update` (body intact, no panic).\n\n");

    md.push_str(&format!(
        "## Public destinations (`Tab::ALL`, {}) × states\n\n",
        Tab::ALL.len()
    ));
    md.push_str(
        "| tab | loading | empty | error | populated | keyboard |\n|---|---|---|---|---|---|\n",
    );
    for tab in Tab::ALL {
        let mut line = format!("| {tab:?} |");
        for state in State::ALL {
            let row = rows
                .iter()
                .find(|r| r.tab == tab && r.state == state)
                .expect("census row");
            line.push(' ');
            line.push_str(&cell_md(&row.cell));
            line.push_str(" |");
        }
        line.push('\n');
        md.push_str(&line);
    }

    let exercised = rows
        .iter()
        .filter(|r| matches!(r.cell, Cell::Exercised { .. }))
        .count();
    let na = rows
        .iter()
        .filter(|r| matches!(r.cell, Cell::NotApplicable { .. }))
        .count();
    let nx: Vec<&Row> = rows
        .iter()
        .filter(|r| matches!(r.cell, Cell::NotExercised { .. }))
        .collect();
    md.push_str(&format!(
        "\n**Totals:** {} cells — {exercised} exercised · {na} not-applicable (reason recorded) · {} not-exercised.\n\n",
        rows.len(),
        nx.len()
    ));

    md.push_str("## Cells not exercised\n\n");
    if nx.is_empty() {
        md.push_str("None — every cell is either verified by render or not-applicable with a recorded reason.\n\n");
    } else {
        for r in &nx {
            if let Cell::NotExercised { reason } = &r.cell {
                md.push_str(&format!(
                    "- **{:?} × {}** — {reason}\n",
                    r.tab,
                    r.state.name()
                ));
            }
        }
        md.push('\n');
    }

    md.push_str("## Error rendered as empty (WI-573215 D-005)\n\n");
    md.push_str("Surfaces whose `error` cell is not-applicable because a failed fetch leaves the EMPTY rendering — the states dimension where the residual risk sits:\n\n");
    for r in rows.iter().filter(|r| r.state == State::Error) {
        if let Cell::NotApplicable { reason } = &r.cell {
            if reason.contains("EMPTY") {
                md.push_str(&format!("- {:?}\n", r.tab));
            }
        }
    }
    md.push('\n');

    md.push_str("## Fixtures\n\n");
    md.push_str("| tab | state | fixture |\n|---|---|---|\n");
    for r in rows {
        if let Cell::Exercised { fixture, .. } = &r.cell {
            md.push_str(&format!(
                "| {:?} | {} | {} |\n",
                r.tab,
                r.state.name(),
                fixture.replace('|', "\\|")
            ));
        }
    }
    md.push('\n');

    md.push_str(&format!(
        "## Non-strip `Tab` variants ({} of {TAB_VARIANT_COUNT}) — proof for P-014\n\n",
        non_strip.len()
    ));
    md.push_str(
        "`switch key →` is `app.tab` after pressing the pane-only variant's nominal key from a fresh App (the strip dispatch derives from `Tab::ALL`, so it must land elsewhere). \
         `from_title →` is where persisted view-state naming the pane is re-pointed. \
         `pinned body` is the non-blank cell count when the variant is force-pinned (its live path). \
         `sites` are `Tab::<Variant>` source occurrences per file — the exhaustive live radius.\n\n",
    );
    md.push_str("| variant | class | live door | switch key → | from_title → | pinned body | sites |\n|---|---|---|---|---|---|---|\n");
    for r in non_strip {
        let sites = r
            .sites
            .iter()
            .map(|(f, n)| format!("{f}:{n}"))
            .collect::<Vec<_>>()
            .join(", ");
        md.push_str(&format!(
            "| {:?} | {:?} | {} | `{}` → {:?} | {} | {} | {} |\n",
            r.tab,
            r.class,
            r.door.replace('|', "\\|"),
            r.switch_key,
            r.switch_lands_on,
            r.from_title
                .map(|t| format!("{t:?}"))
                .unwrap_or_else(|| "None".into()),
            r.pinned_body_nonblank,
            sites
        ));
    }
    md.push('\n');

    md.push_str("## Findings\n\n");
    md.push_str("- **F-1 Sessions has no explicit empty-state text** — an empty `session_browser.rows` renders the facet header and an empty list; the `empty` cell above is verified on the header only.\n");
    md.push_str("- **F-2 Memory's pre-load state is indistinguishable from backend-unavailable** — `MemoryLoadState` has no `Loading` variant, so until the first load returns the tab shows \"(memory backend unavailable — not configured yet)\".\n");
    md.push_str("- **F-3 Operator's only error rendering (` · reconnecting`) is bound to a live SU-session binding** and is not built offline here (the one `✗` cell).\n");
    md.push_str("- **F-4 P-014 removed the four retired enum shells (Plugins, Settings, Conversations, Hives).** The remaining non-strip variants are exactly the three live PANE-ONLY boards: Wake, AgentCtx, and PlansBoard. The old titles still migrate through `Tab::from_title` to their capability-complete public parents.\n");
    md
}

fn artifact_json(rows: &[Row], non_strip: &[NonStripRow]) -> serde_json::Value {
    json!({
        "generatedBy": "apps/tui/src/census.rs",
        "plan": "pui-tui-next-wave-2026-09-05#P-007",
        "closes": ["WI-573215"],
        "render": { "width": W, "height": H, "mode": "pinned-body" },
        "cells": rows.iter().map(|r| {
            let (status, marker, reason, fixture) = match &r.cell {
                Cell::Exercised { marker, fixture } => ("exercised", Some(*marker), None, Some(*fixture)),
                Cell::NotApplicable { reason } => ("not-applicable", None, Some(*reason), None),
                Cell::NotExercised { reason } => ("not-exercised", None, Some(*reason), None),
            };
            json!({
                "tab": format!("{:?}", r.tab),
                "state": r.state.name(),
                "status": status,
                "marker": marker,
                "reason": reason,
                "fixture": fixture,
                "bodyNonblank": r.body_nonblank,
            })
        }).collect::<Vec<_>>(),
        "nonStrip": non_strip.iter().map(|r| json!({
            "variant": format!("{:?}", r.tab),
            "class": format!("{:?}", r.class),
            "door": r.door,
            "switchKey": r.switch_key.to_string(),
            "switchLandsOn": format!("{:?}", r.switch_lands_on),
            "fromTitle": r.from_title.map(|t| format!("{t:?}")),
            "pinnedBodyNonblank": r.pinned_body_nonblank,
            "sites": r.sites.iter().map(|(f, n)| json!({ "file": f, "count": n })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    })
}

fn crate_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel)
}

// ───────────────────────────── tests ─────────────────────────────

/// Every `Tab::ALL` destination renders in every state, and every `exercised`
/// cell's marker is present in the body. This is the census itself; the table
/// below is only its projection.
#[test]
fn census_every_public_destination_renders_in_every_state() {
    let rows = run_census();
    assert_eq!(rows.len(), Tab::ALL.len() * State::ALL.len());
    // The partition must be COMPLETE: a cell is exercised, not-applicable with
    // a reason, or not-exercised with a reason — never silently missing.
    for r in &rows {
        match &r.cell {
            Cell::Exercised { marker, .. } => assert!(!marker.is_empty()),
            Cell::NotApplicable { reason } | Cell::NotExercised { reason } => {
                assert!(
                    reason.len() > 20,
                    "{:?}×{}: reason too thin",
                    r.tab,
                    r.state.name()
                )
            }
        }
    }
    // Populated + keyboard are ALWAYS exercisable offline — a not-applicable
    // there would mean a destination with no data path, which is a bug.
    for r in rows
        .iter()
        .filter(|r| matches!(r.state, State::Populated | State::Keyboard | State::Empty))
    {
        assert!(
            matches!(r.cell, Cell::Exercised { .. }),
            "{:?}×{} must be exercised",
            r.tab,
            r.state.name()
        );
    }
}

/// `Tab::ALL` + the non-strip table partition the enum. Every non-strip
/// variant is pane-only: its nominal switch key lands elsewhere, its title
/// migrates to Fleet, and its pinned body must remain non-blank (that is its
/// live path).
#[test]
fn census_non_strip_variants_are_pane_only_and_unreachable_from_strip() {
    assert_eq!(
        Tab::ALL.len() + NON_STRIP.len(),
        TAB_VARIANT_COUNT,
        "Tab::ALL + NON_STRIP must cover every Tab variant — update TAB_VARIANT_COUNT and NON_STRIP together"
    );
    for tab in Tab::ALL {
        assert_eq!(classify(tab), Class::Public, "{tab:?} is in Tab::ALL");
        assert!(
            !NON_STRIP.iter().any(|(t, _)| *t == tab),
            "{tab:?} is in both Tab::ALL and NON_STRIP"
        );
    }
    for row in run_non_strip() {
        assert_eq!(row.class, Class::PaneOnly, "{:?} is pane-only", row.tab);
        assert_ne!(
            row.switch_lands_on, row.tab,
            "{:?}: its switch key `{}` still reaches it",
            row.tab, row.switch_key
        );
        assert_ne!(
            row.from_title,
            Some(row.tab),
            "{:?}: from_title still resolves persisted state to the pane-only variant",
            row.tab
        );
        assert!(
            row.pinned_body_nonblank > 0,
            "{:?} is pane-only, so its pinned render is the live path and must not be blank",
            row.tab
        );
        assert!(
            row.sites.iter().any(|(f, _)| f == "app.rs"),
            "{:?}: the enum definition in app.rs must count as a site",
            row.tab
        );
    }
}

/// The committed census table is a projection of the code — pinned here.
/// Regenerate with `PUI_CENSUS_UPDATE=1 cargo test census_table_is_current`.
#[test]
fn census_table_is_current() {
    let rows = run_census();
    let non_strip = run_non_strip();
    let md = artifact_markdown(&rows, &non_strip);

    // JSON twin for tooling — target/ is build output, never committed.
    let json_dir = crate_path("target/census");
    let _ = std::fs::create_dir_all(&json_dir);
    let _ = std::fs::write(
        json_dir.join("surface-state-census.json"),
        serde_json::to_string_pretty(&artifact_json(&rows, &non_strip)).unwrap(),
    );

    let path = crate_path(ARTIFACT_MD);
    if std::env::var(UPDATE_ENV).is_ok() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &md).unwrap();
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_default();
    if committed != md {
        let first_diff = committed
            .lines()
            .zip(md.lines())
            .position(|(a, b)| a != b)
            .map(|i| i + 1)
            .unwrap_or_else(|| committed.lines().count().min(md.lines().count()) + 1);
        panic!(
            "{} is out of date with the code (first differing line: {first_diff}).\n\
             Regenerate: cd apps/tui && {UPDATE_ENV}=1 cargo test census_table_is_current\n\
             (then commit the regenerated file — git-sync sweeps it)",
            path.display()
        );
    }
}
