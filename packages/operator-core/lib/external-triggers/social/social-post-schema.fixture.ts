/**
 * A local copy of the canonical `social-post` payload schema, for unit runs.
 *
 * THIS IS A SECOND COPY, AND THAT IS NORMALLY THE MISTAKE. The canonical schema
 * lives in `harness_shared.datatype_registry` (D-004), and a duplicated copy of
 * a truth that lives elsewhere is exactly the drift the repo's derived-truth
 * rule exists to prevent.
 *
 * It exists anyway because the conformance kit's payload check has to be
 * falsifiable WITHOUT a database: `validateDatatypePayload` fails OPEN on a null
 * schema, so a unit run with no schema would pass a malformed payload silently —
 * the check would be decorative. A real schema is what makes the kit's
 * `payload-matches-canonical-datatype` control actually catch anything.
 *
 * What keeps it honest is `conformance.integration.test.ts`, which reads the
 * registry row from a real database and fails if this fixture has drifted from
 * it. So the copy cannot rot unnoticed — it can only rot the tests red.
 */
export const SOCIAL_POST_SCHEMA_FIXTURE: Record<string, unknown> = {
  type: 'object',
  required: ['id', 'text'],
  properties: {
    id: { type: 'string', minLength: 1 },
    url: { type: 'string' },
    text: { type: 'string' },
    media: { type: 'array', items: { type: 'object' } },
    author: { type: 'string' },
    replyToId: { type: 'string' },
    occurredAt: { type: 'string' },
  },
  additionalProperties: true,
};

/** The datatype id this fixture mirrors. */
export const SOCIAL_POST_DATATYPE_ID = 'social-post';
