//! Central style palette (SP-TUI A5). The PUI runs in terminals first, so the
//! palette favors high-contrast ANSI-safe RGB values over subtle web tints.
//!
//! Themes-as-data (workbench-theme-system-2026-06-05 D-001). Palette colours
//! live in [`ThemeSpec`] slots and the draw sites reach them through the named
//! `Theme::*` accessors below. A few sites still name a colour directly
//! (`fleet.rs`'s fleet accents, `agent_pane_kind.rs`'s pane-kind hues), which
//! is why colour-disabled mode clears the finished frame rather than relying on
//! a colourless palette ([`Theme::finish_frame`]). `theme.rs` is
//! a registry over `ThemeSpec`; the accessors read the *active* spec, so a future
//! `:theme` switcher (P1) only needs to flip which spec [`Theme::active`] returns.

use ratatui::buffer::Buffer;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders};
use std::ffi::OsStr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use crate::glyph;

/// A named semantic palette. Themes are data: one `ThemeSpec` per theme holds
/// every colour slot the workbench draws from. Adding a theme = adding a
/// `ThemeSpec` const + registering it in [`THEMES`]; no draw site changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ThemeSpec {
    /// Stable theme id (used by `:theme <name>` and persistence in P1).
    pub name: &'static str,
    // ── base layers ──────────────────────────────────────────────────────
    /// Primary foreground text.
    pub ink: Color,
    /// De-emphasised / secondary text.
    pub muted: Color,
    /// Base pane surface.
    pub panel: Color,
    /// Active (focused) pane surface.
    pub panel_active: Color,
    /// Inactive pane border.
    pub border: Color,
    /// Active pane border.
    pub border_active: Color,
    /// Accent (titles, headers).
    pub accent: Color,
    /// Hot accent (selected row / active title fill).
    pub accent_hot: Color,
    /// Foreground rendered on top of an `accent_hot` fill (selected / title_active).
    pub on_accent: Color,
    // ── semantic hues (status / liveness / signal map onto these) ─────────
    /// Informational / in-progress hue.
    pub sky: Color,
    /// Success / live / done hue.
    pub sage: Color,
    /// Warning / idle hue.
    pub warn: Color,
    /// Danger / blocked / failure hue.
    pub danger: Color,
    /// Human-attention hue (needs-human, decisions).
    pub human: Color,
    // ── chrome surfaces ──────────────────────────────────────────────────
    /// Modal / floating overlay surface.
    pub popup: Color,
    /// Text-input / command-line surface.
    pub input: Color,
    /// Status-bar surface.
    pub status: Color,
    /// Tab-bar surface.
    pub tab_bar_bg: Color,
}

/// Blue Frost — the operator's default theme, adapted to terminal RGB slots.
/// Honeycomb remains selectable, but new sessions should open on the classic
/// frost baseline unless a future persisted theme switcher says otherwise.
pub const BLUE_FROST: ThemeSpec = ThemeSpec {
    name: "frost",
    ink: Color::Rgb(231, 247, 255),
    muted: Color::Rgb(185, 212, 232),
    panel: Color::Rgb(7, 16, 29),
    panel_active: Color::Rgb(11, 18, 32),
    border: Color::Rgb(42, 78, 103),
    border_active: Color::Rgb(125, 211, 252),
    accent: Color::Rgb(56, 189, 248),
    accent_hot: Color::Rgb(125, 211, 252),
    on_accent: Color::Rgb(5, 24, 39),
    sky: Color::Rgb(56, 189, 248),
    sage: Color::Rgb(52, 211, 153),
    warn: Color::Rgb(251, 191, 36),
    danger: Color::Rgb(251, 113, 133),
    human: Color::Rgb(244, 114, 182),
    popup: Color::Rgb(13, 24, 41),
    input: Color::Rgb(3, 10, 20),
    status: Color::Rgb(2, 6, 12),
    tab_bar_bg: Color::Rgb(3, 10, 20),
};

/// The original PUI theme — the styling pass's polished palette, ported byte-for-byte
/// (workbench-theme-system D-004). This is the single source of every colour the
/// workbench previously hardcoded as `Theme::*` consts.
pub const PAPERCUSP_DARK: ThemeSpec = ThemeSpec {
    name: "papercusp-dark",
    ink: Color::Rgb(232, 238, 232),
    muted: Color::Rgb(134, 150, 146),
    panel: Color::Rgb(9, 18, 20),
    panel_active: Color::Rgb(15, 31, 34),
    border: Color::Rgb(43, 67, 67),
    border_active: Color::Rgb(95, 219, 188),
    accent: Color::Rgb(247, 181, 83),
    accent_hot: Color::Rgb(255, 211, 122),
    on_accent: Color::Black,
    sky: Color::Rgb(82, 183, 212),
    sage: Color::Rgb(104, 211, 145),
    warn: Color::Rgb(247, 181, 83),
    danger: Color::Rgb(255, 111, 105),
    human: Color::Rgb(255, 139, 203),
    popup: Color::Rgb(13, 23, 26),
    input: Color::Rgb(3, 8, 10),
    status: Color::Rgb(5, 10, 12),
    tab_bar_bg: Color::Rgb(6, 12, 14),
};

/// Honeycomb — The Swarm terminal palette. Matches the operator Honeycomb token
/// theme: ominous charcoal surfaces, honey-amber signal, and restrained semantic
/// hues for status.
pub const HONEYCOMB: ThemeSpec = ThemeSpec {
    name: "honeycomb",
    ink: Color::Rgb(244, 235, 212),
    muted: Color::Rgb(159, 147, 120),
    panel: Color::Rgb(5, 5, 4),
    panel_active: Color::Rgb(21, 19, 11),
    border: Color::Rgb(86, 64, 25),
    border_active: Color::Rgb(198, 142, 36),
    accent: Color::Rgb(198, 142, 36),
    accent_hot: Color::Rgb(214, 166, 74),
    on_accent: Color::Rgb(19, 13, 3),
    sky: Color::Rgb(120, 160, 165),
    sage: Color::Rgb(104, 211, 145),
    warn: Color::Rgb(214, 166, 74),
    danger: Color::Rgb(224, 111, 105),
    human: Color::Rgb(207, 132, 72),
    popup: Color::Rgb(17, 16, 11),
    input: Color::Rgb(5, 5, 4),
    status: Color::Rgb(8, 8, 6),
    tab_bar_bg: Color::Rgb(5, 5, 4),
};

// ─── Built-in ports (workbench-theme-system P3 / D-001) ─────────────────────
// The four community palettes use their canonical published values mapped onto
// the semantic slots (emphasis hue family: warn≈orange/yellow · sky≈cyan/blue ·
// sage≈green · human≈pink/purple). papercusp-light derives papercusp-dark's
// hue family onto light surfaces.

/// Papercusp Light — papercusp-dark's teal/amber identity on light surfaces.
pub const PAPERCUSP_LIGHT: ThemeSpec = ThemeSpec {
    name: "papercusp-light",
    ink: Color::Rgb(26, 32, 31),
    muted: Color::Rgb(110, 125, 120),
    panel: Color::Rgb(247, 249, 248),
    panel_active: Color::Rgb(235, 241, 240),
    border: Color::Rgb(195, 210, 207),
    border_active: Color::Rgb(13, 148, 136),
    accent: Color::Rgb(180, 110, 10),
    accent_hot: Color::Rgb(217, 119, 6),
    on_accent: Color::Rgb(255, 251, 240),
    sky: Color::Rgb(2, 132, 199),
    sage: Color::Rgb(22, 163, 74),
    warn: Color::Rgb(180, 110, 10),
    danger: Color::Rgb(220, 38, 38),
    human: Color::Rgb(219, 39, 119),
    popup: Color::Rgb(255, 255, 255),
    input: Color::Rgb(255, 255, 255),
    status: Color::Rgb(238, 242, 241),
    tab_bar_bg: Color::Rgb(242, 245, 244),
};

/// Catppuccin Mocha — base/surface layers, mauve accent, pink selection fill.
pub const CATPPUCCIN_MOCHA: ThemeSpec = ThemeSpec {
    name: "catppuccin-mocha",
    ink: Color::Rgb(205, 214, 244),
    muted: Color::Rgb(108, 112, 134),
    panel: Color::Rgb(30, 30, 46),
    panel_active: Color::Rgb(49, 50, 68),
    border: Color::Rgb(69, 71, 90),
    border_active: Color::Rgb(180, 190, 254),
    accent: Color::Rgb(203, 166, 247),
    accent_hot: Color::Rgb(245, 194, 231),
    on_accent: Color::Rgb(17, 17, 27),
    sky: Color::Rgb(137, 180, 250),
    sage: Color::Rgb(166, 227, 161),
    warn: Color::Rgb(249, 226, 175),
    danger: Color::Rgb(243, 139, 168),
    human: Color::Rgb(250, 179, 135),
    popup: Color::Rgb(24, 24, 37),
    input: Color::Rgb(17, 17, 27),
    status: Color::Rgb(24, 24, 37),
    tab_bar_bg: Color::Rgb(17, 17, 27),
};

/// Gruvbox Dark — warm bg ladder, orange/yellow accents.
pub const GRUVBOX_DARK: ThemeSpec = ThemeSpec {
    name: "gruvbox-dark",
    ink: Color::Rgb(235, 219, 178),
    muted: Color::Rgb(146, 131, 116),
    panel: Color::Rgb(40, 40, 40),
    panel_active: Color::Rgb(60, 56, 54),
    border: Color::Rgb(80, 73, 69),
    border_active: Color::Rgb(250, 189, 47),
    accent: Color::Rgb(254, 128, 25),
    accent_hot: Color::Rgb(250, 189, 47),
    on_accent: Color::Rgb(29, 32, 33),
    sky: Color::Rgb(131, 165, 152),
    sage: Color::Rgb(184, 187, 38),
    warn: Color::Rgb(250, 189, 47),
    danger: Color::Rgb(251, 73, 52),
    human: Color::Rgb(211, 134, 155),
    popup: Color::Rgb(50, 48, 47),
    input: Color::Rgb(29, 32, 33),
    status: Color::Rgb(29, 32, 33),
    tab_bar_bg: Color::Rgb(29, 32, 33),
};

/// Nord — polar-night surfaces, frost accents, aurora semantics.
pub const NORD: ThemeSpec = ThemeSpec {
    name: "nord",
    ink: Color::Rgb(236, 239, 244),
    muted: Color::Rgb(76, 86, 106),
    panel: Color::Rgb(46, 52, 64),
    panel_active: Color::Rgb(59, 66, 82),
    border: Color::Rgb(67, 76, 94),
    border_active: Color::Rgb(136, 192, 208),
    accent: Color::Rgb(129, 161, 193),
    accent_hot: Color::Rgb(136, 192, 208),
    on_accent: Color::Rgb(46, 52, 64),
    sky: Color::Rgb(129, 161, 193),
    sage: Color::Rgb(163, 190, 140),
    warn: Color::Rgb(235, 203, 139),
    danger: Color::Rgb(191, 97, 106),
    human: Color::Rgb(180, 142, 173),
    popup: Color::Rgb(59, 66, 82),
    input: Color::Rgb(36, 41, 51),
    status: Color::Rgb(36, 41, 51),
    tab_bar_bg: Color::Rgb(36, 41, 51),
};

/// Dracula — the canonical bg/current-line layers, purple/pink identity.
pub const DRACULA: ThemeSpec = ThemeSpec {
    name: "dracula",
    ink: Color::Rgb(248, 248, 242),
    muted: Color::Rgb(98, 114, 164),
    panel: Color::Rgb(40, 42, 54),
    panel_active: Color::Rgb(68, 71, 90),
    border: Color::Rgb(68, 71, 90),
    border_active: Color::Rgb(189, 147, 249),
    accent: Color::Rgb(189, 147, 249),
    accent_hot: Color::Rgb(255, 121, 198),
    on_accent: Color::Rgb(40, 42, 54),
    sky: Color::Rgb(139, 233, 253),
    sage: Color::Rgb(80, 250, 123),
    warn: Color::Rgb(255, 184, 108),
    danger: Color::Rgb(255, 85, 85),
    human: Color::Rgb(255, 121, 198),
    popup: Color::Rgb(33, 34, 44),
    input: Color::Rgb(30, 31, 41),
    status: Color::Rgb(30, 31, 41),
    tab_bar_bg: Color::Rgb(30, 31, 41),
};

/// High contrast (pui-first-party-public-release P-013): every text slot meets
/// WCAG AAA (7:1) against its surface and every border 3:1, pinned by
/// `high_contrast_meets_wcag_aaa`. Surfaces are one black so nothing depends on
/// telling two dark fills apart; focus rides the yellow border and fill.
pub const HIGH_CONTRAST: ThemeSpec = ThemeSpec {
    name: "high-contrast",
    ink: Color::Rgb(255, 255, 255),
    muted: Color::Rgb(200, 200, 200),
    panel: Color::Rgb(0, 0, 0),
    panel_active: Color::Rgb(0, 0, 0),
    border: Color::Rgb(170, 170, 170),
    border_active: Color::Rgb(255, 255, 0),
    accent: Color::Rgb(0, 255, 255),
    accent_hot: Color::Rgb(255, 255, 0),
    on_accent: Color::Rgb(0, 0, 0),
    sky: Color::Rgb(0, 200, 255),
    sage: Color::Rgb(0, 255, 0),
    warn: Color::Rgb(255, 200, 0),
    danger: Color::Rgb(255, 120, 120),
    human: Color::Rgb(255, 120, 255),
    popup: Color::Rgb(0, 0, 0),
    input: Color::Rgb(0, 0, 0),
    status: Color::Rgb(0, 0, 0),
    tab_bar_bg: Color::Rgb(0, 0, 0),
};

/// Registry of built-in themes. P1 — the `:theme` switcher — adds a
/// live-selectable, ViewState-persisted active theme.
pub const THEMES: &[&ThemeSpec] = &[
    &BLUE_FROST,
    &HONEYCOMB,
    &PAPERCUSP_DARK,
    &PAPERCUSP_LIGHT,
    &CATPPUCCIN_MOCHA,
    &GRUVBOX_DARK,
    &NORD,
    &DRACULA,
    &HIGH_CONTRAST,
];

/// Default active theme id. P1 (the `:theme` switcher) overrides this with the
/// ViewState-persisted selection; P0 always resolves to it.
pub const DEFAULT_THEME: &str = "frost";

/// Resolve a theme by name, or `None` if unknown (callers list `THEMES` on a
/// miss rather than erroring silently — workbench-theme-system D-002).
pub fn theme_by_name(name: &str) -> Option<&'static ThemeSpec> {
    THEMES.iter().copied().find(|t| t.name == name)
}

/// Index into [`THEMES`] of a registered theme name.
fn theme_idx(name: &str) -> Option<usize> {
    THEMES.iter().position(|t| t.name == name)
}

/// The live `:theme` selection as an index into [`THEMES`] (P1 / D-002).
/// `usize::MAX` = no selection → [`Theme::active`] resolves [`DEFAULT_THEME`].
/// Atomic because the reducer thread flips it while the draw loop reads it.
static ACTIVE_IDX: AtomicUsize = AtomicUsize::new(usize::MAX);

/// Dock panes render base SURFACES with a transparent (terminal-inherited)
/// background instead of the opaque `panel`/`status`/`tab_bar` fill (owner ask
/// 2026-06-23 — "the colony pane is the only one that didn't get the new
/// theme"). The chat dock dropped its forced Ghostty `--background` on
/// 2026-06-22 so the slim plain-text panes (brain-view) + the Claude TUI show
/// the user's plain Ghostty bg; the ratatui dock panes (Fleet/colony, the
/// queen boards, wakes) were the holdouts still painting the `frost` panel
/// over it. With this set they inherit the same bg, so the whole dock reads as
/// one theme. Foreground ink/accents/borders are untouched; overlays
/// (popup/input) stay opaque so they remain readable over content. Off in the
/// standalone workbench (full TUI) — only `main.rs` flips it on for a pinned
/// dock pane. Atomic because the reducer thread may read it while the draw
/// loop renders.
static TRANSPARENT_SURFACES: AtomicBool = AtomicBool::new(false);

/// Pure core of [`surface_bg`] (the atomic read injected) so the
/// transparent ⇒ `Reset`, opaque ⇒ slot mapping is unit-testable without
/// touching the process-global flag (which sibling tests read concurrently).
#[inline]
fn resolve_surface_bg(transparent: bool, slot: Color) -> Color {
    if transparent {
        Color::Reset
    } else {
        slot
    }
}

/// The background a base surface should paint: the theme slot normally, or
/// `Color::Reset` (inherit the terminal bg) when [`Theme::set_transparent_surfaces`]
/// is on.
#[inline]
fn surface_bg(slot: Color) -> Color {
    resolve_surface_bg(TRANSPARENT_SURFACES.load(Ordering::Relaxed), slot)
}

/// Colour-disabled rendering (pui-first-party-public-release P-013;
/// <https://no-color.org>). With it on the workbench paints no colour at all:
/// [`Theme::finish_frame`] clears every cell's foreground and background once
/// the frame is drawn. Meaning a palette carried by hue alone moves to a
/// terminal attribute instead: the selected row and the focused pane's title
/// render reversed, a focused pane or popup gets a thick border, and muted
/// text renders dim. `main.rs` turns it on at startup when `NO_COLOR` is set.
/// Atomic for the same reason as [`TRANSPARENT_SURFACES`].
static MONOCHROME: AtomicBool = AtomicBool::new(false);

/// `NO_COLOR` as no-color.org defines it: set to any non-empty value, even
/// `0` or `false`.
pub fn no_color_requested(value: Option<&OsStr>) -> bool {
    value.is_some_and(|v| !v.is_empty())
}

/// Pure core of [`mono_cue`] (the atomic read injected) so both modes are
/// unit-testable without touching the process-global flag.
#[inline]
fn resolve_mono_cue(mono: bool, style: Style, cue: Modifier) -> Style {
    if mono {
        style.add_modifier(cue)
    } else {
        style
    }
}

/// `style` plus the attribute that carries its meaning once colour is gone,
/// only in colour-disabled mode.
#[inline]
fn mono_cue(style: Style, cue: Modifier) -> Style {
    resolve_mono_cue(MONOCHROME.load(Ordering::Relaxed), style, cue)
}

/// Pure core of the emphasised-border weight: a focused pane or popup is told
/// apart by a thick border in colour-disabled mode, by its border hue otherwise.
#[inline]
fn resolve_block_border(block: Block<'static>, emphasised: bool, mono: bool) -> Block<'static> {
    if emphasised && mono {
        block.border_type(BorderType::Thick)
    } else {
        block
    }
}

/// Clear every cell's colours, keeping its symbol and attributes.
pub fn strip_colors(buf: &mut Buffer) {
    for cell in &mut buf.content {
        cell.fg = Color::Reset;
        cell.bg = Color::Reset;
    }
}

pub struct Theme;

impl Theme {
    /// The active palette every accessor reads from — resolved *through* the
    /// registry (D-001). With no `:theme` selection this resolves
    /// `DEFAULT_THEME`; [`Theme::set_active`] (the `:theme` switcher /
    /// ViewState restore) swaps the spec, at which point the next full
    /// re-render re-themes the whole workbench. Falls back to the const if
    /// the name ever misses.
    #[inline]
    pub fn active() -> &'static ThemeSpec {
        THEMES
            .get(ACTIVE_IDX.load(Ordering::Relaxed))
            .copied()
            .or_else(|| theme_by_name(DEFAULT_THEME))
            .unwrap_or(&PAPERCUSP_DARK)
    }

    /// Stable id of the active theme — what `capture_view_state` persists and
    /// `:themes` marks in its listing.
    #[inline]
    pub fn active_name() -> &'static str {
        Self::active().name
    }

    /// Flip the active theme by registry name (`:theme <name>` / the
    /// ViewState restore). Unknown names change nothing and return `false` —
    /// the caller lists `THEMES` instead of erroring silently (D-002).
    pub fn set_active(name: &str) -> bool {
        match theme_idx(name) {
            Some(i) => {
                ACTIVE_IDX.store(i, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }

    /// Turn transparent (terminal-inherited) base surfaces on/off — see
    /// [`TRANSPARENT_SURFACES`]. `main.rs` flips this on for a pinned dock pane
    /// so the ratatui dock panes (Fleet/colony, queen boards, wakes) match the
    /// slim plain-text panes + the user's plain Ghostty bg.
    pub fn set_transparent_surfaces(on: bool) {
        TRANSPARENT_SURFACES.store(on, Ordering::Relaxed);
    }

    /// Turn colour-disabled rendering on/off — see [`MONOCHROME`]. `main.rs`
    /// sets it from `NO_COLOR` before the first frame.
    pub fn set_monochrome(on: bool) {
        MONOCHROME.store(on, Ordering::Relaxed);
    }

    /// Last step of every frame (`ui::draw`): in colour-disabled mode, clear
    /// the colours the draw sites painted, whichever branch painted them.
    pub fn finish_frame(buf: &mut Buffer) {
        if MONOCHROME.load(Ordering::Relaxed) {
            strip_colors(buf);
        }
    }

    /// Base pane surface. Blocks use this so adjacent panes read as an intentional
    /// dashboard instead of raw terminal cells.
    pub fn panel() -> Style {
        let t = Self::active();
        Style::default().fg(t.ink).bg(surface_bg(t.panel))
    }

    /// Active pane surface.
    pub fn panel_active() -> Style {
        let t = Self::active();
        Style::default().fg(t.ink).bg(surface_bg(t.panel_active))
    }

    /// Modal and floating overlay surface.
    pub fn popup() -> Style {
        let t = Self::active();
        Style::default().fg(t.ink).bg(t.popup)
    }

    /// Text input / command-line surface.
    pub fn input() -> Style {
        let t = Self::active();
        Style::default().fg(t.ink).bg(t.input)
    }

    pub fn border() -> Style {
        Style::default().fg(Self::active().border)
    }

    pub fn border_active() -> Style {
        Style::default().fg(Self::active().border_active)
    }

    pub fn title() -> Style {
        Style::default()
            .fg(Self::active().accent_hot)
            .add_modifier(Modifier::BOLD)
    }

    pub fn title_active() -> Style {
        let t = Self::active();
        let style = Style::default()
            .fg(t.on_accent)
            .bg(t.accent_hot)
            .add_modifier(Modifier::BOLD);
        mono_cue(style, Modifier::REVERSED)
    }

    pub fn status_bar() -> Style {
        let t = Self::active();
        Style::default().fg(t.muted).bg(surface_bg(t.status))
    }

    pub fn status_text(style: Style) -> Style {
        style.bg(surface_bg(Self::active().status))
    }

    pub fn tab_bar() -> Style {
        let t = Self::active();
        Style::default().fg(t.muted).bg(surface_bg(t.tab_bar_bg))
    }

    /// Selected list row / active tab.
    pub fn selected() -> Style {
        let t = Self::active();
        let style = Style::default()
            .fg(t.on_accent)
            .bg(t.accent_hot)
            .add_modifier(Modifier::BOLD);
        mono_cue(style, Modifier::REVERSED)
    }

    pub fn dim() -> Style {
        mono_cue(Style::default().fg(Self::active().muted), Modifier::DIM)
    }
    pub fn warn() -> Style {
        Style::default()
            .fg(Self::active().warn)
            .add_modifier(Modifier::BOLD)
    }
    pub fn danger() -> Style {
        Style::default()
            .fg(Self::active().danger)
            .add_modifier(Modifier::BOLD)
    }
    pub fn success() -> Style {
        Style::default()
            .fg(Self::active().sage)
            .add_modifier(Modifier::BOLD)
    }
    pub fn info() -> Style {
        Style::default()
            .fg(Self::active().sky)
            .add_modifier(Modifier::BOLD)
    }
    /// Notification flash in the status bar (accent, not an error).
    pub fn notify() -> Style {
        Style::default()
            .fg(Self::active().sage)
            .add_modifier(Modifier::BOLD)
    }
    /// Column-header row above a list (D-005, pui-completion-and-polish).
    pub fn header() -> Style {
        Style::default()
            .fg(Self::active().accent)
            .add_modifier(Modifier::BOLD | Modifier::UNDERLINED)
    }

    /// Standard bordered workbench pane. Use this instead of hand-rolled
    /// `Block::default()` so every tab participates in the same palette.
    pub fn block(title: Line<'static>, active: bool) -> Block<'static> {
        let block = Block::default()
            .borders(Borders::ALL)
            .style(if active {
                Self::panel_active()
            } else {
                Self::panel()
            })
            .border_style(if active {
                Self::border_active()
            } else {
                Self::border()
            })
            .title_style(if active {
                Self::title_active()
            } else {
                Self::title()
            })
            .title(title);
        resolve_block_border(block, active, MONOCHROME.load(Ordering::Relaxed))
    }

    /// Floating modal block. Popups get a distinct surface but share the active
    /// border/title treatment so they read as focused workbench chrome.
    pub fn popup_block(title: Line<'static>) -> Block<'static> {
        let block = Block::default()
            .borders(Borders::ALL)
            .style(Self::popup())
            .border_style(Self::border_active())
            .title_style(Self::title_active())
            .title(title);
        resolve_block_border(block, true, MONOCHROME.load(Ordering::Relaxed))
    }
    // ---- Semantic glyph styling (Brief 27 / tui-glyph-vocabulary) ----
    // The glyph SHAPE comes from `crate::glyph`; the COLOUR is paired here.
    // Call sites render `Theme::*_marker(token)` to get a styled `Span` in
    // one go, instead of inlining a glyph + a colour separately.

    /// Colour for a work-item / plan-item status token.
    pub fn status_style(token: &str) -> Style {
        match token.trim().to_ascii_lowercase().as_str() {
            "wip" | "doing" | "in_progress" | "in-progress" | "active" | "validating"
            | "running" | "review" => Self::info(),
            "blocked" => Self::danger(),
            "done" | "completed" | "complete" | "passed" | "shipped" | "resolved" | "closed" => {
                Self::success()
            }
            "failing" | "failed" | "error" => Self::danger(),
            "needs-human" | "needs_human" | "needshuman" => Style::default()
                .fg(Self::active().human)
                .add_modifier(Modifier::BOLD),
            // todo / dropped / unknown read as de-emphasised.
            _ => Self::dim(),
        }
    }

    /// Colour for an agent-liveness dot.
    pub fn liveness_style(stale: bool, liveness: &str) -> Style {
        if stale {
            Self::dim()
        } else if liveness.eq_ignore_ascii_case("live") {
            Self::success()
        } else {
            Self::warn()
        }
    }

    /// A status glyph + its colour as a ready-to-render `Span`.
    pub fn status_marker(token: &str) -> Span<'static> {
        Span::styled(glyph::status_for(token), Self::status_style(token))
    }

    /// An agent-liveness dot + its colour as a `Span`.
    pub fn liveness_marker(stale: bool, liveness: &str) -> Span<'static> {
        Span::styled(
            glyph::liveness_dot(stale, liveness),
            Self::liveness_style(stale, liveness),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::buffer::Buffer;
    use ratatui::layout::Rect;
    use ratatui::text::Line;
    use ratatui::widgets::{Paragraph, Widget};

    /// Byte-identical pin: the active palette must equal the polished
    /// `papercusp-dark` values the consts encoded before the registry refactor.
    /// If a slot value drifts, this trips — the refactor is colour-preserving.
    #[test]
    fn papercusp_dark_slots_are_byte_identical() {
        let t = theme_by_name("papercusp-dark").expect("papercusp-dark theme");
        assert_eq!(t.name, "papercusp-dark");
        assert_eq!(t.ink, Color::Rgb(232, 238, 232));
        assert_eq!(t.muted, Color::Rgb(134, 150, 146));
        assert_eq!(t.panel, Color::Rgb(9, 18, 20));
        assert_eq!(t.panel_active, Color::Rgb(15, 31, 34));
        assert_eq!(t.border, Color::Rgb(43, 67, 67));
        assert_eq!(t.border_active, Color::Rgb(95, 219, 188));
        assert_eq!(t.accent, Color::Rgb(247, 181, 83));
        assert_eq!(t.accent_hot, Color::Rgb(255, 211, 122));
        assert_eq!(t.on_accent, Color::Black);
        assert_eq!(t.sky, Color::Rgb(82, 183, 212));
        assert_eq!(t.sage, Color::Rgb(104, 211, 145));
        assert_eq!(t.warn, Color::Rgb(247, 181, 83));
        assert_eq!(t.danger, Color::Rgb(255, 111, 105));
        assert_eq!(t.human, Color::Rgb(255, 139, 203));
        assert_eq!(t.popup, Color::Rgb(13, 23, 26));
        assert_eq!(t.input, Color::Rgb(3, 8, 10));
        assert_eq!(t.status, Color::Rgb(5, 10, 12));
        assert_eq!(t.tab_bar_bg, Color::Rgb(6, 12, 14));
    }

    #[test]
    fn blue_frost_is_the_default_active_palette() {
        let t = Theme::active();
        assert_eq!(t.name, "frost");
        assert_eq!(t.ink, Color::Rgb(231, 247, 255));
        assert_eq!(t.muted, Color::Rgb(185, 212, 232));
        assert_eq!(t.panel, Color::Rgb(7, 16, 29));
        assert_eq!(t.panel_active, Color::Rgb(11, 18, 32));
        assert_eq!(t.border, Color::Rgb(42, 78, 103));
        assert_eq!(t.border_active, Color::Rgb(125, 211, 252));
        assert_eq!(t.accent, Color::Rgb(56, 189, 248));
        assert_eq!(t.accent_hot, Color::Rgb(125, 211, 252));
        assert_eq!(t.on_accent, Color::Rgb(5, 24, 39));
        assert_eq!(t.sky, Color::Rgb(56, 189, 248));
        assert_eq!(t.sage, Color::Rgb(52, 211, 153));
        assert_eq!(t.warn, Color::Rgb(251, 191, 36));
        assert_eq!(t.danger, Color::Rgb(251, 113, 133));
        assert_eq!(t.human, Color::Rgb(244, 114, 182));
        assert_eq!(t.popup, Color::Rgb(13, 24, 41));
        assert_eq!(t.input, Color::Rgb(3, 10, 20));
        assert_eq!(t.status, Color::Rgb(2, 6, 12));
        assert_eq!(t.tab_bar_bg, Color::Rgb(3, 10, 20));
    }

    /// Pin the composed accessor styles (a regression here means a `Self::CONST`
    /// → `active().slot` conversion picked the wrong slot).
    #[test]
    fn accessor_styles_unchanged() {
        let t = Theme::active();
        assert_eq!(Theme::panel(), Style::default().fg(t.ink).bg(t.panel));
        assert_eq!(
            Theme::selected(),
            Style::default()
                .fg(t.on_accent)
                .bg(t.accent_hot)
                .add_modifier(Modifier::BOLD)
        );
        assert_eq!(
            Theme::title_active(),
            Style::default()
                .fg(t.on_accent)
                .bg(t.accent_hot)
                .add_modifier(Modifier::BOLD)
        );
        assert_eq!(
            Theme::tab_bar(),
            Style::default().fg(t.muted).bg(t.tab_bar_bg)
        );
        assert_eq!(Theme::dim(), Style::default().fg(t.muted));
    }

    /// Transparent-surface mode (owner ask 2026-06-23): the pure mapping the
    /// dock panes ride — transparent ⇒ inherit the terminal bg (`Reset`),
    /// opaque ⇒ the theme slot. Tested through the pure core so it never
    /// touches the process-global flag the parallel accessor tests read.
    #[test]
    fn transparent_surface_inherits_terminal_bg_else_keeps_slot() {
        let slot = Color::Rgb(7, 16, 29); // frost panel
        assert_eq!(resolve_surface_bg(true, slot), Color::Reset);
        assert_eq!(resolve_surface_bg(false, slot), slot);
        // Default (workbench): the flag is off, so the live accessors keep the
        // opaque slot — the standalone TUI is unaffected.
        assert!(!TRANSPARENT_SURFACES.load(Ordering::Relaxed));
        assert_eq!(Theme::panel().bg, Some(Theme::active().panel));
    }

    #[test]
    fn registry_resolves_by_name() {
        assert_eq!(theme_by_name("frost"), Some(&BLUE_FROST));
        assert_eq!(theme_by_name("honeycomb"), Some(&HONEYCOMB));
        assert_eq!(theme_by_name("papercusp-dark"), Some(&PAPERCUSP_DARK));
        assert!(theme_by_name("does-not-exist").is_none());
        assert!(!THEMES.is_empty());
    }

    /// `:theme` switcher (P1 / D-002). NOTE: these tests never flip the active
    /// palette to a *different* theme — sibling tests (here and in
    /// `fleet.rs`/`ui.rs`) read `Theme::active()` concurrently, so a real flip
    /// would race them. The store path is still covered: re-selecting the
    /// current name takes the same `Some(idx) → store` branch.
    #[test]
    fn set_active_unknown_name_is_a_noop_and_false() {
        let before = Theme::active_name();
        assert!(!Theme::set_active("does-not-exist"));
        assert_eq!(
            Theme::active_name(),
            before,
            "unknown name must not change the active theme"
        );
    }

    #[test]
    fn set_active_known_name_returns_true() {
        let current = Theme::active_name();
        assert!(Theme::set_active(current));
        assert_eq!(Theme::active_name(), current);
    }

    /// The registry index ↔ name mapping `set_active` stores through.
    #[test]
    fn theme_idx_matches_registry_order() {
        for (i, t) in THEMES.iter().enumerate() {
            assert_eq!(theme_idx(t.name), Some(i));
        }
        assert_eq!(theme_idx("does-not-exist"), None);
    }

    /// `active_name` is always a registered name (the `:themes` listing and
    /// ViewState capture rely on it).
    #[test]
    fn active_name_is_registered() {
        assert!(theme_by_name(Theme::active_name()).is_some());
    }

    /// P3 ports: every registered theme keeps the legibility invariants the
    /// draw sites rely on — unique names, text visible on its panel, the
    /// needs-human hue distinct from the de-emphasis hue (the `!` flag must
    /// never dim away), and selected text distinct from its fill.
    #[test]
    fn every_theme_keeps_semantic_slots_distinct() {
        let mut names = std::collections::BTreeSet::new();
        for t in THEMES {
            assert!(!t.name.is_empty());
            assert!(names.insert(t.name), "duplicate theme name {}", t.name);
            assert_ne!(t.ink, t.panel, "{}: text invisible on panel", t.name);
            assert_ne!(t.human, t.muted, "{}: needs-human dims away", t.name);
            assert_ne!(
                t.on_accent, t.accent_hot,
                "{}: selected text invisible",
                t.name
            );
            assert_ne!(t.danger, t.sage, "{}: danger/success collide", t.name);
        }
    }

    /// Per-theme render snapshot: the needs-human marker must stay VISIBLE —
    /// rendered with the distinct human hue (bold), never dimmed away. Renders
    /// the styled glyph into a real ratatui buffer and inspects the cell.
    #[test]
    fn needs_human_marker_renders_visibly() {
        let t = Theme::active();
        let marker = Theme::status_marker("needs-human");
        // The glyph shape comes from the glyph vocabulary…
        assert_eq!(marker.content, glyph::status_for("needs-human"));
        // …and it carries the human hue + bold (NOT the de-emphasised dim style).
        assert_eq!(marker.style.fg, Some(t.human));
        assert!(marker.style.add_modifier.contains(Modifier::BOLD));
        assert_ne!(
            marker.style.fg,
            Some(t.muted),
            "needs-human must not be dimmed"
        );

        // Render it into a buffer and confirm the glyph cell survives with its hue.
        let area = Rect::new(0, 0, 4, 1);
        let mut buf = Buffer::empty(area);
        Paragraph::new(Line::from(vec![marker])).render(area, &mut buf);
        let cell = buf.cell((0, 0)).expect("cell 0,0");
        assert_eq!(cell.symbol(), glyph::status_for("needs-human"));
        assert_eq!(cell.fg, t.human);
    }

    /// WCAG 2.x contrast ratio between two RGB colours.
    fn contrast(a: Color, b: Color) -> f64 {
        fn luminance(c: Color) -> f64 {
            let Color::Rgb(r, g, b) = c else {
                panic!("high-contrast slots are RGB: {c:?}")
            };
            let lin = |v: u8| {
                let s = f64::from(v) / 255.0;
                if s <= 0.03928 {
                    s / 12.92
                } else {
                    ((s + 0.055) / 1.055).powf(2.4)
                }
            };
            0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
        }
        let (la, lb) = (luminance(a), luminance(b));
        (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
    }

    /// P-013 high-contrast mode: every text slot meets WCAG AAA (7:1) on every
    /// surface it is drawn on, the selected/title fill keeps 7:1, and borders
    /// meet the 3:1 non-text minimum.
    #[test]
    fn high_contrast_meets_wcag_aaa() {
        let t = theme_by_name("high-contrast").expect("registered");
        let surfaces = [
            t.panel,
            t.panel_active,
            t.popup,
            t.input,
            t.status,
            t.tab_bar_bg,
        ];
        let text = [
            t.ink,
            t.muted,
            t.accent,
            t.accent_hot,
            t.sky,
            t.sage,
            t.warn,
            t.danger,
            t.human,
        ];
        for surface in surfaces {
            for fg in text {
                let ratio = contrast(fg, surface);
                assert!(ratio >= 7.0, "{fg:?} on {surface:?} is {ratio:.2}:1");
            }
            for border in [t.border, t.border_active] {
                let ratio = contrast(border, surface);
                assert!(
                    ratio >= 3.0,
                    "border {border:?} on {surface:?} is {ratio:.2}:1"
                );
            }
        }
        let fill = contrast(t.on_accent, t.accent_hot);
        assert!(fill >= 7.0, "selected text is {fill:.2}:1");
        // The instrument itself: black on white is the 21:1 maximum.
        assert!((contrast(Color::Rgb(0, 0, 0), Color::Rgb(255, 255, 255)) - 21.0).abs() < 0.01);
    }

    /// Colour-disabled mode (P-013) follows no-color.org: `NO_COLOR` counts
    /// whenever it is set to anything but the empty string.
    #[test]
    fn no_color_is_any_non_empty_value() {
        assert!(!no_color_requested(None));
        assert!(!no_color_requested(Some(OsStr::new(""))));
        for value in ["1", "0", "false", "yes"] {
            assert!(
                no_color_requested(Some(OsStr::new(value))),
                "NO_COLOR={value} must disable colour"
            );
        }
    }

    /// `strip_colors` removes every fg/bg the draw sites painted — palette
    /// slots and direct literals alike — and keeps the text and attributes.
    #[test]
    fn strip_colors_keeps_symbols_and_attributes() {
        let area = Rect::new(0, 0, 6, 1);
        let mut buf = Buffer::empty(area);
        let style = Style::default()
            .fg(Color::Rgb(0x86, 0xef, 0xac))
            .bg(Color::Yellow)
            .add_modifier(Modifier::BOLD | Modifier::REVERSED);
        Paragraph::new(Line::styled("queen", style)).render(area, &mut buf);
        strip_colors(&mut buf);
        for cell in &buf.content {
            assert_eq!((cell.fg, cell.bg), (Color::Reset, Color::Reset));
        }
        let cell = buf.cell((0, 0)).expect("cell 0,0");
        assert_eq!(cell.symbol(), "q");
        assert!(cell.modifier.contains(Modifier::BOLD | Modifier::REVERSED));
    }

    /// The cue is added only in colour-disabled mode; the coloured path is
    /// byte-identical to the style the accessor built.
    #[test]
    fn mono_cue_applies_only_in_monochrome() {
        let style = Theme::selected();
        assert_eq!(resolve_mono_cue(false, style, Modifier::REVERSED), style);
        let mono = resolve_mono_cue(true, style, Modifier::REVERSED);
        assert!(mono
            .add_modifier
            .contains(Modifier::REVERSED | Modifier::BOLD));
        assert_eq!((mono.fg, mono.bg), (style.fg, style.bg));
    }

    /// With every colour cleared, a focused pane must still read differently
    /// from an unfocused one: a thick border and a reversed title. Renders the
    /// monochrome forms into a real buffer and strips it as `finish_frame` does.
    #[test]
    fn monochrome_focus_is_visible_without_colour() {
        let render = |active: bool| {
            let title_style = if active {
                resolve_mono_cue(true, Theme::title_active(), Modifier::REVERSED)
            } else {
                Theme::title()
            };
            let block = Block::default()
                .borders(Borders::ALL)
                .border_style(if active {
                    Theme::border_active()
                } else {
                    Theme::border()
                })
                .title_style(title_style)
                .title("chat");
            let area = Rect::new(0, 0, 8, 3);
            let mut buf = Buffer::empty(area);
            resolve_block_border(block, active, true).render(area, &mut buf);
            strip_colors(&mut buf);
            buf
        };
        let focused = render(true);
        let unfocused = render(false);
        assert_eq!(focused.cell((0, 0)).expect("corner").symbol(), "┏");
        assert_eq!(unfocused.cell((0, 0)).expect("corner").symbol(), "┌");
        let title = |buf: &Buffer| buf.cell((1, 0)).expect("title cell").modifier;
        assert!(title(&focused).contains(Modifier::REVERSED));
        assert!(!title(&unfocused).contains(Modifier::REVERSED));
        // The coloured path keeps the plain border.
        let mut plain = Buffer::empty(Rect::new(0, 0, 8, 3));
        resolve_block_border(Block::default().borders(Borders::ALL), true, false)
            .render(Rect::new(0, 0, 8, 3), &mut plain);
        assert_eq!(plain.cell((0, 0)).expect("corner").symbol(), "┌");
    }
}
