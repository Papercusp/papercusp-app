//! Hives tab (pui-hives-tab-2026-06-07; re-rendered over the C-3 trust model by
//! hive-network-surface-2026-06-11 B-11/P-009) — the p2p network roster.
//!
//! This tab shows two DIFFERENT kinds of hive data, and the whole point of the
//! P-009 re-render is that they are no longer conflated:
//!
//!   • the **federated peer roster** (`app.hives`) — remote Papercusp installs
//!     whose presence is projected from the p2p `shared_presence` log and
//!     surfaced by `coord:presence` as `federated: true`. Their identity is
//!     cryptographically verified by the substrate → C-3 trust `federated`,
//!     tier 3. One hive = one DEVICE (machine), grouped by device pubkey.
//!   • the **gossip directory** (`app.hive_directory`) — foreign hives this peer
//!     has merely *heard announced* on the directory topic. Self-reported,
//!     unverified until a join runs the full admission flow → C-3 trust
//!     `gossip`, tier 4.
//!
//! Before P-009 both rendered as one undifferentiated list; now each section
//! carries its C-3 trust badge + tier + provenance so substrate-verified data is
//! never mistaken for self-reported gossip.
//!
//! State lives on `App` (`hives` raw rows + `hive_sel`, `hive_directory` +
//! `hive_dir_sel`); grouping happens at render so the reducer stays a dumb store.
//! Render is pure over `&App`.

use crate::app::App;
use crate::glyph;
use crate::models::PresenceRow;
use crate::theme::Theme;
use crate::ui::trunc;
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::Style,
    text::{Line, Span},
    widgets::{List, ListItem, ListState, Paragraph, Wrap},
    Frame,
};

/// The C-3 capability-ladder TRUST class of a hive row (hive-network-surface
/// C-3). This is the canonical Rust spelling of the pinned wire vocabulary
/// `local|admin|federated|gossip` — the pui network surface shares ONE
/// definition (B-09's network-pane imports `crate::hives::Trust` rather than
/// redefining it; the brief forbids forking the classifier).
///
/// The server-side classifier (B-08) does the heavy lifting of mapping a
/// heterogeneous mix of sources to a tier+trust; rows arriving over the C-3
/// wire carry the `trust` string, parsed here via [`Trust::from_wire`]. The
/// Hives tab does NOT re-run that classifier — its two sources are already
/// homogeneous, so it assigns trust structurally (federated roster vs gossip
/// directory). That is labeling, not a second classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
// The full C-3 trust ladder is represented for the shared vocabulary; the Hives
// tab only constructs Federated/Gossip (its two sources), while Local/Admin are
// built by `from_wire` for B-09's network-board consumer — hence allow.
#[allow(dead_code)]
pub enum Trust {
    /// This very install (tier 1).
    Local,
    /// A hive this operator administers directly (tier 2).
    Admin,
    /// A shared-Hive peer Swarm whose presence is substrate-verified through the
    /// p2p federation layer — `coord:presence federated` / fleet assignments
    /// (tier 3).
    Federated,
    /// A foreign hive known only from its self-reported directory announce /
    /// status beacon — best-effort gossip, unverified until admission (tier 4).
    Gossip,
}

impl Trust {
    /// Parse the C-3 wire `trust` string (B-08's endpoint emits these verbatim).
    /// An unrecognised value falls back to the most-cautious class so unknown
    /// provenance never masquerades as verified. Consumed by B-09's network-pane
    /// to type its `NetworkBoardRow.trust: String`; the Hives tab assigns trust
    /// structurally and so doesn't call it (hence the allow).
    #[allow(dead_code)]
    pub fn from_wire(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "local" => Trust::Local,
            "admin" => Trust::Admin,
            "federated" => Trust::Federated,
            _ => Trust::Gossip,
        }
    }

    /// The wire/spelling token — round-trips with [`Trust::from_wire`].
    #[allow(dead_code)]
    pub fn wire(self) -> &'static str {
        match self {
            Trust::Local => "local",
            Trust::Admin => "admin",
            Trust::Federated => "federated",
            Trust::Gossip => "gossip",
        }
    }

    /// The C-3 capability-ladder tier (1..=4) this trust class sits on.
    pub fn tier(self) -> u8 {
        match self {
            Trust::Local => 1,
            Trust::Admin => 2,
            Trust::Federated => 3,
            Trust::Gossip => 4,
        }
    }

    /// Short uppercase badge label for section headers / rows.
    pub fn badge(self) -> &'static str {
        match self {
            Trust::Local => "LOCAL",
            Trust::Admin => "ADMIN",
            Trust::Federated => "FEDERATED",
            Trust::Gossip => "GOSSIP",
        }
    }

    /// One-line provenance descriptor — what this trust class actually means.
    pub fn provenance(self) -> &'static str {
        match self {
            Trust::Local => "this install",
            Trust::Admin => "you administer",
            Trust::Federated => "substrate-verified",
            Trust::Gossip => "self-reported, unverified",
        }
    }

    /// A glyph marking the trust class at a glance: owned hives read as a solid
    /// diamond, substrate-verified peers as a check, gossip as a tilde
    /// ("approximate / self-reported").
    pub fn glyph(self) -> &'static str {
        match self {
            Trust::Local | Trust::Admin => "◆",
            Trust::Federated => "✓",
            Trust::Gossip => "~",
        }
    }

    /// Palette for the trust badge. Verified classes read as success/info;
    /// gossip reads as a caution (warn) so unverified data is visually distinct
    /// from substrate-verified data — the core P-009 requirement.
    pub fn style(self) -> Style {
        match self {
            Trust::Local | Trust::Admin => Theme::success(),
            Trust::Federated => Theme::info(),
            Trust::Gossip => Theme::warn(),
        }
    }
}

/// One hive — a device joined to the swarm, aggregated from its per-(user,
/// harness) presence rows. Always C-3 trust [`Trust::Federated`] (tier 3): these
/// rows only reach the roster via the substrate's `shared_presence` projection.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HiveGroup {
    /// The machine label (the human half of the federation identity).
    pub machine: String,
    /// The device pubkey (raw-32-byte-base64 — the cryptographic identity).
    pub device_pubkey: String,
    /// gh user ids seen on this device, dedup'd in arrival order.
    pub users: Vec<String>,
    /// Harnesses this hive announced presence in, dedup'd in arrival order.
    pub harnesses: Vec<String>,
    /// The freshest row's declared intent (what the hive is doing).
    pub intent: String,
    /// The freshest row's current view.
    pub current_view: Option<String>,
    /// Freshest announce timestamp (ISO — sorts lexically).
    pub last_seen: String,
    /// True when EVERY row for this device is stale (the hive went quiet).
    pub stale: bool,
}

/// Group the raw federated presence rows into one entry per device. The
/// freshest row (by ISO `heartbeat_at`) wins the intent/view fields; a hive is
/// stale only when all its rows are. Live hives sort first, then by machine.
pub fn group_hives(rows: &[PresenceRow]) -> Vec<HiveGroup> {
    let mut groups: Vec<HiveGroup> = Vec::new();
    for r in rows {
        let key = r
            .device_pubkey
            .clone()
            .filter(|k| !k.is_empty())
            .unwrap_or_else(|| r.host.clone());
        let g = match groups.iter_mut().find(|g| g.device_pubkey == key) {
            Some(g) => g,
            None => {
                groups.push(HiveGroup {
                    machine: if r.host.is_empty() {
                        key.clone()
                    } else {
                        r.host.clone()
                    },
                    device_pubkey: key,
                    stale: true,
                    ..Default::default()
                });
                groups.last_mut().expect("just pushed")
            }
        };
        if let Some(u) = r.user_id.clone().filter(|u| !u.is_empty()) {
            if !g.users.contains(&u) {
                g.users.push(u);
            }
        }
        if let Some(h) = r.harness_slug.clone().filter(|h| !h.is_empty()) {
            if !g.harnesses.contains(&h) {
                g.harnesses.push(h);
            }
        }
        let ts = r.heartbeat_at.clone().unwrap_or_default();
        if ts >= g.last_seen {
            g.last_seen = ts;
            g.intent = r.intent.clone();
            g.current_view = r.current_view.clone();
        }
        g.stale &= r.stale;
    }
    groups.sort_by(|a, b| a.stale.cmp(&b.stale).then(a.machine.cmp(&b.machine)));
    groups
}

/// The present members of ONE hive (B5 / shared-hive-collaboration P-005): the
/// federated presence rows whose hive key (device pubkey, or the host when a row
/// carries no pubkey — the SAME keying `group_hives` uses) matches `key`. That is
/// "who is in THIS shared hive". Live rows sort first, then by user then harness,
/// so the roster reads newest-collaborators-first and is stable. Pure — the roster
/// pane (`network::draw_hive_roster`) renders these inside the per-hive axis tab
/// (B4), and the per-row author identity doubles as the "whose work is whose"
/// attribution shared with Phase-1 #1.
pub fn present_in_hive<'a>(rows: &'a [PresenceRow], key: &str) -> Vec<&'a PresenceRow> {
    let mut members: Vec<&PresenceRow> = rows
        .iter()
        .filter(|r| {
            let k = r
                .device_pubkey
                .as_deref()
                .filter(|k| !k.is_empty())
                .unwrap_or(r.host.as_str());
            k == key
        })
        .collect();
    members.sort_by(|a, b| {
        a.stale
            .cmp(&b.stale)
            .then_with(|| a.user_id.cmp(&b.user_id))
            .then_with(|| a.harness_slug.cmp(&b.harness_slug))
    });
    members
}

/// A bordered-section title carrying the C-3 trust badge + tier + provenance, so
/// a federated section and a gossip section are never mistaken for one another.
/// `tail` is the section-specific count phrase (e.g. " 3 live " / " 5 to join ").
fn trust_section_title(trust: Trust, tail: String) -> Line<'static> {
    Line::from(vec![
        Span::styled(
            format!(" {} {} ", trust.glyph(), trust.badge()),
            trust.style(),
        ),
        Span::styled(format!("tier {} ", trust.tier()), Theme::dim()),
        Span::raw(format!("— {} ·", trust.provenance())),
        Span::styled(tail, Theme::dim()),
    ])
}

/// Render the Hives tab: a 1-line headline framed by the two trust classes, then
/// the federated roster (tier 3) above the gossip directory (tier 4).
pub fn draw_hives(f: &mut Frame, app: &App, area: Rect) {
    let groups = group_hives(&app.hives);
    let live = groups.iter().filter(|g| !g.stale).count();
    let gossip_n = app.hive_directory.len();
    let node = app.lexicon.lex("node").to_lowercase();
    let nodes = app.lexicon.lex_plural("node").to_lowercase();
    let pot = app.lexicon.lex("pot").to_lowercase();

    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(1), Constraint::Min(1)])
        .split(area);

    // Headline: no more "joined the swarm" conflation — count each trust class
    // separately, coloured by its trust palette.
    let headline = Line::from(vec![
        Span::styled(
            format!(" {} Network ", glyph::nav::FLEET),
            Theme::title_active(),
        ),
        Span::raw("the p2p network · "),
        Span::styled(
            format!("{} {} federated", Trust::Federated.glyph(), groups.len()),
            Trust::Federated.style(),
        ),
        Span::raw(format!(" ({live} live) · ")),
        Span::styled(
            format!("{} {} gossip", Trust::Gossip.glyph(), gossip_n),
            Trust::Gossip.style(),
        ),
    ]);
    f.render_widget(Paragraph::new(headline).style(Theme::status_bar()), rows[0]);

    if groups.is_empty() && app.hive_directory.is_empty() {
        // The single-box reality until real peers announce: honest empty state.
        f.render_widget(
            Paragraph::new(format!(
                "no remote {nodes} on the p2p network yet — this {node} runs solo\n\n\
                 A {node} appears here once another Papercusp install joins the\n\
                 substrate (✓ federated — substrate-verified live roster), or\n\
                 announces a public {pot} on the directory topic (~ gossip —\n\
                 self-reported; browse + join with J)."
            ))
            .wrap(Wrap { trim: false })
            .style(Theme::panel())
            .block(Theme::block(Line::from(" p2p network "), false)),
            rows[1],
        );
        return;
    }

    // Body: the substrate-verified roster (tier 3) sits ABOVE the gossip
    // directory (tier 4) — higher trust, higher on screen. Each section claims
    // the whole body when it is the only one with data.
    let has_fed = !groups.is_empty();
    let has_gossip = !app.hive_directory.is_empty();
    let (fed_area, gossip_area) = match (has_fed, has_gossip) {
        (true, true) => {
            let split = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Percentage(55), Constraint::Percentage(45)])
                .split(rows[1]);
            (Some(split[0]), Some(split[1]))
        }
        (true, false) => (Some(rows[1]), None),
        (false, true) => (None, Some(rows[1])),
        (false, false) => (None, None),
    };

    if let Some(area) = fed_area {
        draw_federated_roster(f, app, &groups, area);
    }
    if let Some(area) = gossip_area {
        draw_directory(f, app, area);
    }
}

/// Render the substrate-verified federated peer roster (C-3 trust `federated`,
/// tier 3): one row per device, each prefixed by the ✓ verified glyph. Distinct
/// from the gossip directory — these identities are cryptographically verified.
fn draw_federated_roster(f: &mut Frame, app: &App, groups: &[HiveGroup], area: Rect) {
    let live = groups.iter().filter(|g| !g.stale).count();
    let items: Vec<ListItem> = groups
        .iter()
        .map(|g| {
            let dot = Theme::liveness_marker(g.stale, if g.stale { "stale" } else { "live" });
            let users = if g.users.is_empty() {
                String::new()
            } else {
                format!("gh:{} ", g.users.join(","))
            };
            let doing = g
                .current_view
                .clone()
                .filter(|v| !v.is_empty())
                .or_else(|| Some(g.intent.clone()).filter(|i| !i.is_empty()))
                .unwrap_or_default();
            let harnesses = if g.harnesses.is_empty() {
                String::new()
            } else {
                format!(" [{}]", g.harnesses.join(", "))
            };
            ListItem::new(Line::from(vec![
                Span::styled(
                    format!("{} ", Trust::Federated.glyph()),
                    Trust::Federated.style(),
                ),
                dot,
                Span::raw(format!(" {:<17} ", trunc(&g.machine, 17))),
                Span::styled(format!("{users:<12}"), Theme::dim()),
                Span::raw(format!("{:<32}", trunc(&doing, 32))),
                Span::styled(trunc(&harnesses, 26), Theme::info()),
            ]))
        })
        .collect();

    let tail = if live == groups.len() {
        format!(" {live} live ")
    } else {
        format!(" {live} live / {} ", groups.len())
    };
    let mut state = ListState::default();
    state.select(Some(app.hive_sel.min(groups.len().saturating_sub(1))));
    let body = crate::ui::block_with_header(
        f,
        area,
        Theme::block(trust_section_title(Trust::Federated, tail), false),
        &format!(
            "      {:<18}{:<12}{:<32}{}",
            "machine", "user", "doing", "harnesses"
        ),
    );
    let list = List::new(items)
        .style(Theme::panel())
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, body, &mut state);
}

/// Render the browseable gossip directory (C-3 trust `gossip`, tier 4): each
/// self-reported discovered hive (title · owner · N harnesses · visibility),
/// prefixed by the ~ gossip glyph, `J` to join the first joinable one. A
/// topic-only hive (no member links) shows "topics-only". The header carries the
/// GOSSIP trust badge so a join is never mistaken for a verified peer.
fn draw_directory(f: &mut Frame, app: &App, area: Rect) {
    let items: Vec<ListItem> = app
        .hive_directory
        .iter()
        .map(|h| {
            let joinable = if h.member_links.is_empty() {
                Span::styled("  topics-only", Theme::dim())
            } else {
                Span::styled("  ⮐ J to join", Theme::info())
            };
            ListItem::new(Line::from(vec![
                Span::styled(format!("{} ", Trust::Gossip.glyph()), Trust::Gossip.style()),
                Span::raw(format!("{:<23} ", trunc(&h.title, 23))),
                Span::styled(format!("@{:<14}", trunc(&h.owner, 14)), Theme::dim()),
                Span::raw(format!("{:<27}", trunc(&h.description, 27))),
                Span::styled(format!("{} harness ", h.member_count), Theme::info()),
                joinable,
            ]))
        })
        .collect();
    let mut state = ListState::default();
    if !app.hive_directory.is_empty() {
        state.select(Some(app.hive_dir_sel.min(app.hive_directory.len() - 1)));
    }
    let tail = format!(" {} to join (J) ", app.hive_directory.len());
    let body = crate::ui::block_with_header(
        f,
        area,
        Theme::block(trust_section_title(Trust::Gossip, tail), true),
        &format!(
            "   {:<24}{:<15}{:<27}{}",
            app.lexicon.lex("pot").to_lowercase(),
            "owner",
            "description",
            "harnesses"
        ),
    );
    let list = List::new(items)
        .style(Theme::panel())
        .highlight_style(Theme::selected())
        .highlight_symbol("> ");
    f.render_stateful_widget(list, body, &mut state);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(host: &str, key: &str, user: &str, harness: &str, ts: &str, stale: bool) -> PresenceRow {
        PresenceRow {
            owner_id: format!("fed:{user}@{host}"),
            owner_label: format!("gh:{user} · {host}"),
            intent: format!("working on {harness}"),
            host: host.into(),
            user_id: Some(user.into()),
            stale,
            federated: true,
            device_pubkey: Some(key.into()),
            harness_slug: Some(harness.into()),
            current_view: None,
            heartbeat_at: Some(ts.into()),
        }
    }

    #[test]
    fn groups_by_device_and_unions_users_harnesses() {
        let rows = vec![
            row(
                "mbp",
                "key-a",
                "111",
                "papercup",
                "2026-06-07T01:00:00Z",
                false,
            ),
            row(
                "mbp",
                "key-a",
                "222",
                "restart",
                "2026-06-07T02:00:00Z",
                false,
            ),
            row(
                "tower",
                "key-b",
                "111",
                "papercup",
                "2026-06-07T01:30:00Z",
                true,
            ),
        ];
        let groups = group_hives(&rows);
        assert_eq!(groups.len(), 2);
        // Live hive first.
        assert_eq!(groups[0].machine, "mbp");
        assert_eq!(groups[0].users, vec!["111", "222"]);
        assert_eq!(groups[0].harnesses, vec!["papercup", "restart"]);
        // Freshest row wins the intent.
        assert_eq!(groups[0].intent, "working on restart");
        assert!(!groups[0].stale);
        // All-stale device is stale.
        assert!(groups[1].stale);
        assert_eq!(groups[1].machine, "tower");
    }

    #[test]
    fn one_live_row_keeps_the_hive_live() {
        let rows = vec![
            row(
                "mbp",
                "key-a",
                "111",
                "papercup",
                "2026-06-07T01:00:00Z",
                true,
            ),
            row(
                "mbp",
                "key-a",
                "111",
                "restart",
                "2026-06-07T02:00:00Z",
                false,
            ),
        ];
        let groups = group_hives(&rows);
        assert_eq!(groups.len(), 1);
        assert!(!groups[0].stale);
    }

    #[test]
    fn present_in_hive_filters_to_the_key_with_live_members_first() {
        let rows = vec![
            row(
                "mbp",
                "key-a",
                "111",
                "papercup",
                "2026-06-07T01:00:00Z",
                false,
            ),
            row(
                "mbp",
                "key-a",
                "222",
                "restart",
                "2026-06-07T02:00:00Z",
                true,
            ),
            row(
                "tower",
                "key-b",
                "111",
                "papercup",
                "2026-06-07T01:00:00Z",
                false,
            ),
        ];
        // Only this hive's members; the other device (key-b) is excluded.
        let members = present_in_hive(&rows, "key-a");
        assert_eq!(members.len(), 2);
        // Live member sorts before the stale one.
        assert!(!members[0].stale);
        assert_eq!(members[0].user_id.as_deref(), Some("111"));
        assert!(members[1].stale);
        // A key with nobody present → an empty roster (honest, not an error).
        assert!(present_in_hive(&rows, "nobody").is_empty());
    }

    #[test]
    fn present_in_hive_keys_by_host_when_a_row_has_no_pubkey() {
        let mut r = row(
            "solo-box",
            "",
            "111",
            "papercup",
            "2026-06-07T01:00:00Z",
            false,
        );
        r.device_pubkey = None;
        let rows = vec![r];
        // Falls back to host as the key (mirrors group_hives' keying).
        assert_eq!(present_in_hive(&rows, "solo-box").len(), 1);
        assert!(present_in_hive(&rows, "key-x").is_empty());
    }

    #[test]
    fn trust_wire_round_trips_and_maps_to_tiers() {
        for t in [Trust::Local, Trust::Admin, Trust::Federated, Trust::Gossip] {
            assert_eq!(Trust::from_wire(t.wire()), t);
        }
        // Tiers follow the C-3 capability ladder.
        assert_eq!(Trust::Local.tier(), 1);
        assert_eq!(Trust::Admin.tier(), 2);
        assert_eq!(Trust::Federated.tier(), 3);
        assert_eq!(Trust::Gossip.tier(), 4);
        // Case-insensitive; unknown provenance is the most-cautious class.
        assert_eq!(Trust::from_wire("FEDERATED"), Trust::Federated);
        assert_eq!(Trust::from_wire("mystery"), Trust::Gossip);
    }

    #[test]
    fn renders_roster_and_empty_state() {
        use ratatui::{backend::TestBackend, Terminal};
        let render = |app: &App| -> String {
            let mut term = Terminal::new(TestBackend::new(100, 20)).unwrap();
            term.draw(|f| draw_hives(f, app, f.area())).unwrap();
            term.backend()
                .buffer()
                .content()
                .iter()
                .map(|c| c.symbol())
                .collect()
        };
        let mut app = App::new();
        // Empty: the solo-node hint mentions both trust classes.
        let text = render(&app);
        assert!(text.contains("runs solo"));
        assert!(text.contains("federated"));
        assert!(text.contains("gossip"));
        // Populated: the federated section badge + tier + the row columns.
        app.hives = vec![row(
            "mbp",
            "key-a",
            "111",
            "papercup",
            "2026-06-07T01:00:00Z",
            false,
        )];
        let text = render(&app);
        assert!(text.contains("1 federated"));
        assert!(text.contains("FEDERATED"));
        assert!(text.contains("tier 3"));
        assert!(text.contains("substrate-verified"));
        assert!(text.contains("mbp"));
        assert!(text.contains("gh:111"));
        assert!(text.contains("papercup"));
    }

    #[test]
    fn renders_the_hive_directory_as_gossip_tier() {
        use ratatui::{backend::TestBackend, Terminal};
        let render = |app: &App| -> String {
            let mut term = Terminal::new(TestBackend::new(120, 24)).unwrap();
            term.draw(|f| draw_hives(f, app, f.area())).unwrap();
            term.backend()
                .buffer()
                .content()
                .iter()
                .map(|c| c.symbol())
                .collect()
        };
        let mut app = App::new();
        app.hive_directory = vec![
            crate::models::DiscoveredHiveRow {
                hive_id: "ash".into(),
                title: "Ash Hive".into(),
                description: "shop migration".into(),
                owner: "alice".into(),
                visibility: "public".into(),
                member_links: vec!["papercusp://harness?topic=a".into()],
                member_count: 1,
            },
            crate::models::DiscoveredHiveRow {
                hive_id: "topic-only".into(),
                title: "Topic Hive".into(),
                description: String::new(),
                owner: "bob".into(),
                visibility: "public".into(),
                member_links: vec![],
                member_count: 2,
            },
        ];
        let text = render(&app);
        // The gossip section is trust-badged tier 4, and both hives render; the
        // joinable one shows the Join affordance, the link-less one topics-only.
        assert!(text.contains("GOSSIP"));
        assert!(text.contains("tier 4"));
        assert!(text.contains("self-reported"));
        assert!(text.contains("Ash Hive"));
        assert!(text.contains("@alice"));
        assert!(text.contains("J to join"));
        assert!(text.contains("topics-only"));
    }

    #[test]
    fn federated_and_gossip_render_as_distinct_trust_tiers() {
        use ratatui::{backend::TestBackend, Terminal};
        let mut app = App::new();
        app.hives = vec![row(
            "mbp",
            "key-a",
            "111",
            "papercup",
            "2026-06-07T01:00:00Z",
            false,
        )];
        app.hive_directory = vec![crate::models::DiscoveredHiveRow {
            hive_id: "ash".into(),
            title: "Ash Hive".into(),
            description: "shop migration".into(),
            owner: "alice".into(),
            visibility: "public".into(),
            member_links: vec!["papercusp://harness?topic=a".into()],
            member_count: 1,
        }];
        let mut term = Terminal::new(TestBackend::new(120, 24)).unwrap();
        term.draw(|f| draw_hives(f, &app, f.area())).unwrap();
        let text: String = term
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|c| c.symbol())
            .collect();
        // Both trust classes are present and labeled with their distinct tiers
        // and provenance — the core P-009 anti-conflation guarantee.
        assert!(text.contains("FEDERATED"));
        assert!(text.contains("tier 3"));
        assert!(text.contains("substrate-verified"));
        assert!(text.contains("GOSSIP"));
        assert!(text.contains("tier 4"));
        assert!(text.contains("self-reported"));
    }
}
