//! Hive lexicon (pui-hive-lexicon-2026-06-06).
//!
//! ONE source of truth: the term→label packs live server-side
//! (`@papercusp/lexicon` + the operator twin). The pui does NOT duplicate them —
//! it fetches the ACTIVE resolved pack once at startup via
//! `client.lexicon_active_pack()` (which respects the `papercusp-the-hive` flag)
//! and stores the map here. `lex(term)` / `lex_plural(term)` resolve a label,
//! falling back to the built-in CLASSIC labels (today's words) whenever the
//! operator is unreachable or a term is missing — so a fetch failure is a
//! no-rebrand no-op, never a crash or a blank.
//!
//! Term *keys* are brand-neutral (`"fleet"`, `"pot"`, `"operator"`, `"cupboard"`,
//! …); the active pack supplies the user-facing label. Internal identifiers
//! (Tab::title(), persistence keys, tool names) are NEVER driven by this — it is
//! presentation only.

use crate::models::LexiconPackPayload;
use std::collections::HashMap;

/// The CLASSIC fallback labels — must mirror `libs/generic/lexicon` CLASSIC_PACK.
/// Used when the operator is unreachable or the active pack omits a term, so
/// flag-off / offline renders today's words unchanged. `(singular, plural)`.
const CLASSIC: &[(&str, &str, &str)] = &[
    ("pot", "Pot", "Pots"),
    ("fleet", "Fleet", "Fleets"),
    ("operator", "Papercup", "Papercups"),
    ("brain", "Mug", "Mugs"),
    ("overwatch", "Kettle", "Kettles"),
    ("scout", "Blender", "Blenders"),
    ("contributor", "Cup", "Cups"),
    ("human", "Human", "Humans"),
    ("chunk", "Chunk", "Chunks"),
    ("cupboard", "Cupboard", "Cupboards"),
    ("node", "Node", "Nodes"),
    // Backward-compatible key for older TUI call sites. A whole Papercusp
    // install on the p2p network is a Node in the public vocabulary.
    ("hive", "Node", "Nodes"),
    ("substrate", "Coordination", "Coordination"),
    ("blueprint", "Blueprint", "Blueprints"),
    ("harness", "Harness", "Harnesses"),
    ("signal", "Signal", "Signals"),
];

/// Resolved display labels for the active brand pack. Empty (`Default`) → every
/// `lex()` falls back to CLASSIC, i.e. today's labels.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Lexicon {
    /// Active pack id ("classic" | "the-hive"); "" until fetched. Diagnostic only.
    pub pack_id: String,
    /// term key → (singular, plural). Only present keys override CLASSIC.
    forms: HashMap<String, (String, String)>,
}

impl Lexicon {
    /// Build from a fetched `lexicon:active_pack` payload.
    pub fn from_payload(p: &LexiconPackPayload) -> Self {
        let mut forms = HashMap::new();
        for (key, f) in &p.terms {
            if !f.one.is_empty() {
                forms.insert(key.clone(), (f.one.clone(), f.other.clone()));
            }
        }
        Self {
            pack_id: p.pack_id.clone(),
            forms,
        }
    }

    fn classic(term: &str) -> Option<(&'static str, &'static str)> {
        CLASSIC
            .iter()
            .find(|(k, _, _)| *k == term)
            .map(|(_, one, other)| (*one, *other))
    }

    /// The singular Title-Case label for `term`. Falls back to the CLASSIC label,
    /// then (for an unknown key) to the term key itself — never panics, never "".
    pub fn lex(&self, term: &str) -> String {
        if let Some((one, _)) = self.forms.get(term) {
            return one.clone();
        }
        Self::classic(term)
            .map(|(one, _)| one.to_string())
            .unwrap_or_else(|| term.to_string())
    }

    /// The plural Title-Case label for `term` (same fallback chain).
    pub fn lex_plural(&self, term: &str) -> String {
        if let Some((_, other)) = self.forms.get(term) {
            return other.clone();
        }
        Self::classic(term)
            .map(|(_, other)| other.to_string())
            .unwrap_or_else(|| term.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{LexiconPackPayload, TermForms};

    fn payload(pack: &str, pairs: &[(&str, &str, &str)]) -> LexiconPackPayload {
        let mut terms = HashMap::new();
        for (k, one, other) in pairs {
            terms.insert(
                k.to_string(),
                TermForms {
                    one: one.to_string(),
                    other: other.to_string(),
                },
            );
        }
        LexiconPackPayload {
            pack_id: pack.to_string(),
            label: pack.to_string(),
            terms,
        }
    }

    #[test]
    fn default_falls_back_to_classic_labels() {
        let lx = Lexicon::default();
        assert_eq!(lx.lex("fleet"), "Fleet");
        assert_eq!(lx.lex("pot"), "Pot");
        assert_eq!(lx.lex("operator"), "Papercup");
        assert_eq!(lx.lex("brain"), "Mug");
        assert_eq!(lx.lex("overwatch"), "Kettle");
        assert_eq!(lx.lex("scout"), "Blender");
        assert_eq!(lx.lex("contributor"), "Cup");
        assert_eq!(lx.lex("human"), "Human");
        assert_eq!(lx.lex("cupboard"), "Cupboard");
        assert_eq!(lx.lex("node"), "Node");
        assert_eq!(lx.lex_plural("pot"), "Pots");
    }

    #[test]
    fn the_hive_pack_overrides_labels() {
        let lx = Lexicon::from_payload(&payload(
            "the-hive",
            &[
                ("fleet", "Colony", "Colonies"),
                ("pot", "Hive", "Hives"),
                ("operator", "Sentinel", "Sentinels"),
                ("brain", "Queen", "Queens"),
                ("overwatch", "Overwatch", "Overwatches"),
                ("scout", "Scout", "Scouts"),
                ("contributor", "Bee", "Bees"),
                ("human", "Keeper", "Keepers"),
                ("cupboard", "Comb", "Combs"),
                ("node", "Swarm", "Swarms"),
            ],
        ));
        assert_eq!(lx.pack_id, "the-hive");
        assert_eq!(lx.lex("fleet"), "Colony");
        assert_eq!(lx.lex("pot"), "Hive");
        assert_eq!(lx.lex("operator"), "Sentinel");
        assert_eq!(lx.lex("brain"), "Queen");
        assert_eq!(lx.lex("overwatch"), "Overwatch");
        assert_eq!(lx.lex("scout"), "Scout");
        assert_eq!(lx.lex("contributor"), "Bee");
        assert_eq!(lx.lex("human"), "Keeper");
        assert_eq!(lx.lex("cupboard"), "Comb");
        assert_eq!(lx.lex("node"), "Swarm");
        assert_eq!(lx.lex_plural("pot"), "Hives");
        // A key the pack omits still falls back to CLASSIC.
        assert_eq!(lx.lex("harness"), "Harness");
    }

    #[test]
    fn unknown_key_falls_back_to_the_key_itself() {
        let lx = Lexicon::default();
        assert_eq!(lx.lex("nonexistent"), "nonexistent");
    }

    #[test]
    fn empty_forms_are_ignored_in_favor_of_classic() {
        // A pack that ships an empty label for a key must not blank the UI.
        let lx = Lexicon::from_payload(&payload("classic", &[("fleet", "", "")]));
        assert_eq!(lx.lex("fleet"), "Fleet");
    }
}
