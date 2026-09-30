/**
 * observation-title-guidance — the ONE canonical statement of the
 * title-is-an-identifier rule (observation-and-recall-surface-honesty-2026-08-16
 * P-001), shared by every surface that asks an agent for an observation title.
 *
 * WHY A SHARED CONSTANT AND NOT THREE HAND-WRITTEN SENTENCES: the rule is stated
 * on `improvements:capture { title }`, on the turn-end reflection fields that
 * checkpoint-harvest reads (`loop:checkpoint { insight }`,
 * `work_items:complete { completion.coordNotes }`), and in both su playbooks.
 * Three independently-worded copies drift, and the drift is invisible — nothing
 * fails when one surface stops naming the rule. Pinning them to one exported
 * string makes `observation-title-guidance.test.ts` able to assert the rule is
 * present on EVERY surface rather than on whichever one was last edited.
 *
 * THE MEASUREMENT BEHIND IT (EI-20587312505064997, 2026-08-16, over all 37,051
 * observation titles): the recurrence mechanism the observation lane exists for
 * (`recurrence-escalation.ts`, fires at 3 occurrences) matches on
 * `dedupSignature(title)` — title ONLY, reduced to a sorted bag of >2-char
 * tokens. Measured: 35,520 distinct signatures, 35,277 of them SINGLETONS
 * (99.3%), and only 48 signatures ever reach the ≥3 threshold. Of the 1,378 rows
 * that do sit in a recurring cluster, 1,213 (88%) are machine-emitted
 * scorecards. The one clearly agent-authored cluster —
 * `coord:send cannot deliver to ended launcher session`, 6 occurrences —
 * recurred precisely BECAUSE it names a stable subject in stable words.
 *
 * So the defect is structural, not a discipline problem: the guidance asked for
 * a good DESCRIPTION while the machinery rewards a stable IDENTIFIER, and those
 * pull in opposite directions. A reflective title ("TWICE in this one
 * investigation a surface-level set comparison would have produced a confident
 * false finding") is a fine description and a signature that can never collide.
 *
 * ⛔ THIS IS NOT A QUALITY FILTER, and must never become one (plan D-002).
 * Unfiltered VOLUME is the denominator that makes recurrence meaningful — no
 * single agent can tell whether its friction is idiosyncratic or fleet-wide;
 * only the count knows. This rule changes the SHAPE of the title and leaves the
 * filing rate and the free-prose body untouched.
 */

/**
 * The rule itself, phrased for an agent about to type a title. Kept to one
 * paragraph on purpose: it is carried in a JSON-Schema field `description`, so
 * every character is re-sent to every agent on every tool listing.
 */
export const OBSERVATION_TITLE_RULE =
  'TITLE IS AN IDENTIFIER, NOT A SENTENCE — lead with the stable SUBJECT (tool/verb name, surface, file path, error class), ' +
  'then the symptom in the plainest words you would use again; the narrative goes in the body, where it costs nothing. ' +
  "Recurrence and dedup match on the title's word-bag, so a title phrased as a reflection can never collide with a peer " +
  'filing the SAME friction, and the recurring-condition escalation never fires.';

/** The structured observation evidence-routing contract shared by catalog and prose surfaces. */
export const OBSERVATION_EVIDENCE_RULE =
  'Free-text observation evidence belongs in the top-level body; observation.evidence is not a valid field. ' +
  'For a rubric scorecard, put evidence in each observation.ratings[criterion].evidence.';

/**
 * The same rule stated for a free-text reflection field whose FIRST LINE is
 * harvested verbatim into an observation title (`boundInsight` in
 * checkpoint-harvest.ts). The distinction matters: here the agent is not asked
 * for a title at all, so "make the title an identifier" is unactionable unless
 * it says WHICH line becomes the title.
 */
export const HARVESTED_FIRST_LINE_RULE =
  'Its FIRST LINE is harvested verbatim as an observation title, so lead that line with the stable subject ' +
  '(tool/verb name, surface, file path, error class) and keep the story on the lines below.';

/**
 * The same rule for `work_items:complete { completion.coordNotes }`, the OTHER
 * free-text field checkpoint-harvest reads. Stated separately because that
 * field's description has to name the field (it is documented inside a
 * multi-field record description, not on a field of its own).
 */
export const HARVESTED_COORD_NOTES_RULE =
  '`coordNotes` is ALSO harvested into the observation lane: its FIRST LINE becomes the observation title, ' +
  'so lead that line with the stable subject (tool/verb name, surface, file path, error class) and keep the ' +
  'narrative on the lines below — recurrence is matched on that line alone.';

/**
 * `conditionKey` — the DESIGNED recurrence path, stated so an agent knows it may
 * MINT one (P-002).
 *
 * WHY THE FRAMING IS THE WHOLE FIX: the field has existed since EI-15448 and
 * works. Its description just described it as something to *copy* — "an
 * OverwatchBrief anomaly line's `[conditionKey: …]` — copy it verbatim" — which
 * reads as an echo field for machine-published keys, not as an identity an agent
 * mints for its own recurring friction.
 *
 * MEASURED 2026-08-16 over the 11,302 non-harvest observation rows:
 *   • 87 (0.77%) carry an agent-authored key — 87 rows, 87 DISTINCT keys
 *   • 6,726 carry a machine `repeated-tool-error:*` key (the tool-failure
 *     watchdog mints those with no agent involved)
 *   • 24 carry the automatic `scorecard:*` default
 *   • 4,465 carry no key at all
 * All 25,866 checkpoint-harvest rows carry no key: `harvestInsight()` has no
 * parameter for one, so the entire turn-end reflection path — ~70% of the corpus
 * — has NO route to this mechanism. Guidance cannot close that half; it is
 * recorded here so the next reader does not mistake the gap for disuse.
 */
export const CONDITION_KEY_RULE =
  'Filing a condition you expect to see again — or are seeing again right now? Pass a stable `conditionKey` and ' +
  'MINT IT YOURSELF as `<area>:<stable-subject>` (e.g. `coord-send:ended-launcher-session`); it does not have to be ' +
  'a machine-issued key. This is the DESIGNED recurrence path: a still-open observation carrying the same key is ' +
  'updated in place with `repeatCount` bumped, rather than minting a row nothing can cluster.';

/**
 * The short form for a prose playbook bullet, where the surrounding text already
 * establishes that an observation is being filed.
 */
export const OBSERVATION_TITLE_RULE_SHORT =
  'the title is an IDENTIFIER, not a sentence: lead with the stable subject ' +
  '(tool/verb name, surface, file path, error class); the narrative goes in the body.';
