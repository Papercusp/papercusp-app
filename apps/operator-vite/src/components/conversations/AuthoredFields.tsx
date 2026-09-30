/**
 * AuthoredFields — render the authored message fields on a conversation detail.
 *
 * WHY (unified-agent-state-plane-2026-07-27, P-033 (e)): the fields a sender
 * authors — `premises`, `forYouBecause`, `youMayNotKnow`, `couldNotDetermine`,
 * plus the envelope's `expects` / `blocking` / `why` — ride the coord envelope's
 * `extra`, while every reader surface showed only the FLATTENED body string. A
 * field nobody can see cannot be judged by its VALUES, and after D-070 retracted
 * the spec freeze, judging them by their values is the ONLY check left standing.
 * So this exists to make them visible, not to decorate them.
 *
 * The projection is done SERVER-SIDE (`projectAuthoredFields`) and arrives as
 * `AuthoredMessageFields`; this component never unpacks a raw envelope. That is
 * deliberate — a client that re-derives the shape is a second place D-064's
 * envelope/section split can drift from the decision that defined it.
 */
import type { AuthoredMessageFields } from './unified-conversations';
import './authored-fields.css';

/** `expects` is the one envelope field that is meaningful on its own — the rest
 *  are only worth a row when the sender actually set them. */
const EXPECTS_LABEL: Record<string, string> = {
  ack: 'wants an ack',
  answer: 'wants an answer',
  action: 'wants action',
  none: 'FYI — nothing expected',
};

export function AuthoredFields({ authored }: { authored?: AuthoredMessageFields }) {
  if (!authored) return null;

  const derived = new Set(authored.derivedFields ?? []);
  const sections = authored.sections ?? [];
  const hasSectionFields = sections.some(
    (s) => s.premises?.length || s.forYouBecause || s.youMayNotKnow?.length || s.couldNotDetermine?.length,
  );
  const hasEnvelope = authored.expects || authored.blocking || authored.why || authored.basedOn?.length;
  if (!hasEnvelope && !hasSectionFields) return null;

  return (
    <div className="pc-authored">
      <div className="pc-authored__label">What the sender declared</div>

      {authored.blocking && !derived.has('blocking') && (
        <span className="pc-authored__flag">Sender is blocked on this</span>
      )}

      {authored.expects && (
        <div className="pc-authored__row">
          <span className="pc-authored__key">Expects</span>
          <span className="pc-authored__val">
            {EXPECTS_LABEL[authored.expects] ?? authored.expects}
            {derived.has('expects') && <DerivedNote />}
          </span>
        </div>
      )}

      {authored.why && (
        <div className="pc-authored__row">
          <span className="pc-authored__key">Toward</span>
          <span className="pc-authored__val">
            <span className="pc-authored__ref">{authored.why.goalRef}</span>
            {authored.why.note ? ` — ${authored.why.note}` : null}
            {derived.has('why') && <DerivedNote />}
          </span>
        </div>
      )}

      {/* `basedOn` is auto-derived from what the sender READ (D-002/D-011/D-084) —
          never authored, so it is labelled as a trace rather than a claim. The
          token is the ref's version AT SEND time, not at read time (D-084 R4);
          it is shown suffixed so a reader can compare it against the ref now. */}
      {authored.basedOn && authored.basedOn.length > 0 && (
        <div className="pc-authored__row">
          <span className="pc-authored__key">Read before sending</span>
          <span className="pc-authored__val">
            {authored.basedOn.map((e) => (
              <span key={e.ref} className="pc-authored__ref" title={`read via ${e.via} at ${e.readAt}`}>
                {e.ref}
                {e.versionAtSend ? `@${e.versionAtSend}` : ''}{' '}
              </span>
            ))}
          </span>
        </div>
      )}

      {sections.map((section, i) => {
        const carries =
          section.premises?.length ||
          section.forYouBecause ||
          section.youMayNotKnow?.length ||
          section.couldNotDetermine?.length;
        if (!carries) return null;
        return (
          // Sections are positional by construction (`body: Section[]`), so the
          // index IS the identity here — there is no id to key on.
          <div key={i} className="pc-authored__section">
            {sections.length > 1 && <div className="pc-authored__sectext">“{section.text}”</div>}

            {section.forYouBecause && !derived.has('forYouBecause') && (
              <div className="pc-authored__row">
                <span className="pc-authored__key">For you because</span>
                <span className="pc-authored__val">
                  {section.forYouBecause.relation}
                  {section.forYouBecause.ref ? (
                    <> <span className="pc-authored__ref">{section.forYouBecause.ref}</span></>
                  ) : null}
                  {/* D-043: `other` REQUIRES a note — the note is the whole content
                      of the claim, so dropping it would leave an empty assertion. */}
                  {section.forYouBecause.note ? ` — ${section.forYouBecause.note}` : null}
                </span>
              </div>
            )}

            {section.premises && section.premises.length > 0 && (
              <div className="pc-authored__row">
                <span className="pc-authored__key">Rests on</span>
                <span className="pc-authored__val">
                  {section.premises.map((p) => (
                    <span
                      key={p.ref}
                      className="pc-authored__ref"
                      data-invalidatable={p.invalidatable ? 'true' : 'false'}
                    >
                      {p.ref}{' '}
                    </span>
                  ))}
                </span>
              </div>
            )}

            {section.youMayNotKnow && section.youMayNotKnow.length > 0 && (
              <div className="pc-authored__row">
                <span className="pc-authored__key">You may not know</span>
                <span className="pc-authored__val">
                  {section.youMayNotKnow.map((y) => (
                    <span key={y.ref} className="pc-authored__ref">
                      {y.ref}
                      {y.provenance ? ` (${y.provenance})` : ''}{' '}
                    </span>
                  ))}
                </span>
              </div>
            )}

            {/* Spelled out rather than counted: an OPEN question is a different
                action for the reader than an answered one. */}
            {section.couldNotDetermine && section.couldNotDetermine.length > 0 && (
              <div className="pc-authored__row">
                <span className="pc-authored__key pc-authored__open">Could not determine</span>
                <span className="pc-authored__val">
                  {section.couldNotDetermine
                    .map((c) => (c.note ? `${c.what} — ${c.note}` : c.what))
                    .join('; ')}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** D-072: a value the platform filled in is not the sender's intent — say so where
 *  the value is shown, not in a legend the reader has to go find. */
function DerivedNote() {
  return <span className="pc-authored__derived"> · filled in automatically, not authored</span>;
}
