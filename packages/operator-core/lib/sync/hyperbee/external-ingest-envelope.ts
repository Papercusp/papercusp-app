/**
 * external-ingest-envelope — the ONE definition of "this value carries the owner's
 * private external-integration ingest", plus the redaction that strips it.
 *
 * ── WHY THIS MODULE EXISTS (EI-22088522809897790) ──
 * `external-triggers/binding-engine.ts` builds ONE object (`triggerArgs()`) that is
 * used for TWO different trust levels:
 *
 *   1. `harness_shared.trigger_runs.args` — LOCAL and never federated (no `sync/`
 *      module references that table), and the legitimate home of the private
 *      payload: `gmail:create-draft` / `slack:respond-in-thread` resolve recipient,
 *      thread, reply headers and OAuth credential from it SERVER-SIDE by planRunId.
 *   2. the plan run's `inputs` (binding-engine launch-plan branch) — which lands
 *      inside `harness_shared.work_items.payload.plan_run.inputs.trigger` and IS
 *      federated to every admitted hive member.
 *
 * So the owner's full inbound email — sender, recipients, subject, full HTML body —
 * rides into the replicated work-item stream. The PUBLIC SEED path already guards
 * this (`seed-provider-corestore.ts` drops any row whose value carries an envelope);
 * the POST-ADMISSION replication path did not, which is the residual leak.
 *
 * The predicates below were previously private to `seed-provider-corestore.ts`. They
 * live here because that module pulls in `corestore`, `node:child_process` and
 * `node:fs` — far too heavy to import from the outbox row mapper on the hot
 * federation path. A SECOND hand-maintained copy was the alternative and is exactly
 * the drift this repo's derived-truth rule forbids: one definition, two callers.
 */

/**
 * The sentinel that REPLACES a private ingest payload in a federated value.
 *
 * A STRING on purpose, not a `{ redacted: … }` object. `isExternalTriggerEnvelope`
 * requires `payload`/`adapterPayload` to be an OBJECT, so a string sentinel makes the
 * redaction SELF-VERIFYING and IDEMPOTENT: a redacted value no longer satisfies the
 * predicate, which turns the guard's correctness into a post-condition a test can
 * assert directly — `valueCarriesExternalIngest(redactExternalIngest(v)) === false` —
 * rather than a claim about which keys the redactor happened to visit. An object
 * sentinel would leave the envelope still matching, so a re-scan (the seed path, a
 * future auditor) could not tell "already redacted" from "still leaking".
 */
export const EXTERNAL_INGEST_REDACTION = '[redacted:external-ingest]';

export function decodeEncodedJson(value: Uint8Array | ArrayBuffer): { text: string; json?: unknown } | undefined {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  try {
    return { text, json: JSON.parse(text) as unknown };
  } catch {
    return { text };
  }
}

/**
 * An external-integration event envelope — the shape `external-triggers/*` writes when it
 * ingests the OWNER'S connected account (Gmail today; any `ext:<source>:<event>` adapter):
 * `{ key:'ext:gmail:message.received', source:'gmail', event:'message.received', payload:{…} }`,
 * or the canonical ingest record `{ source, event, dedupeKey, payload|adapterPayload }`.
 * The payload is the owner's private inbox — sender, recipients, subject, full HTML body —
 * and it reaches the hive INSIDE work-item payloads (a plan run's `inputs.trigger`,
 * features-by-id PR-974 in the 2026-09-01 seed), not in a table of its own, so both the
 * public seed and post-admission replication must handle it wherever it appears in a value.
 */
export function isExternalTriggerEnvelope(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const hasSourceEvent = typeof v.source === 'string' && typeof v.event === 'string';
  if (!hasSourceEvent) return false;
  const hasPayload =
    (typeof v.payload === 'object' && v.payload !== null) || (typeof v.adapterPayload === 'object' && v.adapterPayload !== null);
  if (!hasPayload) return false;
  return (typeof v.key === 'string' && v.key.startsWith('ext:')) || typeof v.dedupeKey === 'string';
}

/** Deep scan of a row VALUE for an {@link isExternalTriggerEnvelope} anywhere inside it. */
export function valueCarriesExternalIngest(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const decoded = decodeEncodedJson(value);
    return decoded?.json !== undefined ? valueCarriesExternalIngest(decoded.json) : false;
  }
  if (Array.isArray(value)) return value.some(valueCarriesExternalIngest);
  if (isExternalTriggerEnvelope(value)) return true;
  return Object.values(value).some(valueCarriesExternalIngest);
}

/**
 * Deep, structure-preserving redaction: every {@link isExternalTriggerEnvelope} found
 * anywhere inside `value` keeps its ROUTING fields (key/source/event/sourceId/
 * externalId/dedupeKey/occurredAt/datatypeId) and loses only `payload`/`adapterPayload`,
 * which become {@link EXTERNAL_INGEST_REDACTION}.
 *
 * REDACT, not DROP — deliberately the opposite of the seed path's choice, because the
 * two boundaries differ in kind. A seed is a PUBLIC artifact handed to a stranger, so
 * dropping the whole row is right there. Post-admission replication feeds ADMITTED
 * members who legitimately see the work stream: dropping the row would punch a hole in
 * their work-item history (an item that exists for the owner and not for them, with no
 * tombstone to explain it) to hide one field. Keeping the row and blanking the private
 * field removes the exposure without inventing a divergence.
 *
 * IDENTITY-PRESERVING: when nothing carries ingest, the SAME reference comes back, so
 * this is provably a no-op for the overwhelming majority of federated rows and callers
 * can assert that cheaply.
 */
export function redactExternalIngest<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;

  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const decoded = decodeEncodedJson(value);
    if (decoded?.json === undefined) return value;
    const redacted = redactExternalIngest(decoded.json);
    if (redacted === decoded.json) return value;
    return new TextEncoder().encode(JSON.stringify(redacted)) as unknown as T;
  }

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const redacted = redactExternalIngest(item);
      if (redacted !== item) changed = true;
      return redacted;
    });
    return (changed ? next : value) as unknown as T;
  }

  const source = value as Record<string, unknown>;
  const envelope = isExternalTriggerEnvelope(source);
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (envelope && (key === 'payload' || key === 'adapterPayload')) {
      // Only an OBJECT payload makes this an envelope, so this branch always
      // replaces real ingest content, never a scalar that merely shares the name.
      next[key] = EXTERNAL_INGEST_REDACTION;
      changed = true;
      continue;
    }
    const redacted = redactExternalIngest(child);
    if (redacted !== child) changed = true;
    next[key] = redacted;
  }
  return (changed ? next : value) as unknown as T;
}
