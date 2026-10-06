/**
 * Provider-agnostic types for a TYPED DECISION model: a model that never writes
 * text, and instead answers typed questions about a piece of `state` with
 * probabilities.
 *
 * Three question kinds cover the known providers (TypeSafe Jev calls them
 * `choice`, `score` and `noul`):
 *
 *  - `choice` — pick one of up to 255 named options; per-option probabilities
 *    plus a confidence value.
 *  - `score`  — an ordered scale of 2..10 levels; a probability-weighted score
 *    (which can land BETWEEN levels), the distribution, and a confidence value.
 *  - `yesNo`  — P(yes). No confidence value: the probability IS the answer.
 *
 * The central contract is {@link DecisionOutcome}: a call either ANSWERED every
 * question it asked, or it is INCONCLUSIVE with a typed reason. There is no
 * third, partial state, and an unavailable judge can never be read as an empty
 * verdict — the silent-no-op failure this library exists to make impossible.
 */

/** A value a provider accepts as free-form description: text or structured data. */
export type Describable = string | Record<string, unknown> | unknown[];

/** Pick one option. The option KEYS are the answer vocabulary. */
export interface ChoiceQuestion<O extends string = string> {
  readonly type: 'choice';
  readonly instructions: Describable;
  /** Option key → description (null when the key is self-explanatory). 1..255 entries. */
  readonly options: Readonly<Record<O, Describable | null>>;
}

/** An ordered scale. Level i is `levels[i]`; the answer's `score` is in [0, levels.length - 1]. */
export interface ScoreQuestion {
  readonly type: 'score';
  readonly instructions: Describable;
  /** Ordered level descriptions, lowest first. 2..10 entries. */
  readonly levels: readonly Describable[];
}

/** A yes/no question. `criteria` optionally spells out what yes and no mean. */
export interface YesNoQuestion {
  readonly type: 'yesNo';
  readonly instructions: Describable;
  readonly criteria?: { readonly yes: Describable; readonly no: Describable };
}

export type Question = ChoiceQuestion<string> | ScoreQuestion | YesNoQuestion;

export interface ChoiceAnswer<O extends string = string> {
  readonly type: 'choice';
  /** The highest-probability option. */
  readonly choice: O;
  /** Option → probability; sums to ~1. */
  readonly probabilities: Readonly<Record<O, number>>;
  /** Provider confidence in [0, 1]. A MARGIN, not P(correct) — never threshold it as one. */
  readonly confidence: number;
}

export interface ScoreAnswer {
  readonly type: 'score';
  /** Probability-weighted level in [0, levels - 1]; may fall between integer levels. */
  readonly score: number;
  /** Probability per level index (index i ↔ `levels[i]`); sums to ~1. */
  readonly probabilities: readonly number[];
  readonly confidence: number;
}

export interface YesNoAnswer {
  readonly type: 'yesNo';
  /** P(yes) in [0, 1]. */
  readonly pYes: number;
}

export type Answer = ChoiceAnswer<string> | ScoreAnswer | YesNoAnswer;

/** The answer type for one question type — keeps option keys typed end to end. */
export type AnswerFor<Q> = Q extends ChoiceQuestion<infer O>
  ? ChoiceAnswer<O>
  : Q extends ScoreQuestion
    ? ScoreAnswer
    : Q extends YesNoQuestion
      ? YesNoAnswer
      : never;

export type QuestionMap = Readonly<Record<string, Question>>;

/** Every asked key, answered with its own question's answer type. */
export type AnswersFor<QM extends QuestionMap> = { readonly [K in keyof QM]: AnswerFor<QM[K]> };

export interface DecisionRequest<QM extends QuestionMap = QuestionMap> {
  /** What is being judged: text, or structured data the instructions can reference by field name. */
  readonly state: Describable;
  /** Question id → question. Ids are yours; answers come back under the same ids. */
  readonly questions: QM;
  /** Caller's cancellation; combined with the client's own deadline. */
  readonly signal?: AbortSignal;
}

/**
 * Why no answer is available. Every reason means "fall back to your pre-model
 * behaviour" — none of them means "the model said no".
 */
export type InconclusiveReason =
  /** No client has been configured in this process. */
  | 'not-configured'
  /** The host has no credential for the provider. */
  | 'no-key'
  /** The request is outside the provider's documented limits; nothing was sent. */
  | 'invalid-request'
  /** 401 — the credential was rejected. */
  | 'unauthorized'
  /** 422 — the provider rejected the request shape. */
  | 'rejected'
  /** 429 after the retry budget was spent. */
  | 'rate-limited'
  /** 529 after the retry budget was spent. */
  | 'overloaded'
  /**
   * 402: the provider refused for billing (for example, the account has no credits left).
   * After a 402 the client sends nothing for `paymentRequiredCooldownMs`, and each call in
   * that window returns this reason with attempts 0 and no status.
   */
  | 'payment-required'
  /** Any other non-2xx status. */
  | 'http-error'
  /** The deadline expired before an answer arrived. */
  | 'timeout'
  /** The caller's own signal aborted the call. */
  | 'aborted'
  /** fetch itself failed (DNS, connection reset, TLS, …). */
  | 'network-error'
  /** A 2xx response that is not a complete, well-formed answer to every question asked. */
  | 'malformed-response';

export interface DecisionUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface Answered<QM extends QuestionMap = QuestionMap> {
  readonly kind: 'answered';
  /** The model id the provider says ANSWERED — record this, not the id you asked for. */
  readonly model: string;
  readonly answers: AnswersFor<QM>;
  readonly usage: DecisionUsage;
  readonly latencyMs: number;
  /** HTTP attempts made, including retries. */
  readonly attempts: number;
}

export interface Inconclusive {
  readonly kind: 'inconclusive';
  readonly reason: InconclusiveReason;
  /** Human-readable specifics (status code, offending field, parse failure). Never contains the key. */
  readonly detail?: string;
  /** HTTP status of the last attempt, when one was made. */
  readonly status?: number;
  readonly latencyMs: number;
  readonly attempts: number;
}

export type DecisionOutcome<QM extends QuestionMap = QuestionMap> = Answered<QM> | Inconclusive;

/** The HTTP request a provider adapter asks the client to send. */
export interface ProviderHttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Result of parsing a 2xx body: a complete answer set, or the reason it is not one. */
export type ProviderParseResult =
  | {
      readonly ok: true;
      readonly model: string;
      readonly answers: Readonly<Record<string, Answer>>;
      readonly usage: DecisionUsage;
    }
  | { readonly ok: false; readonly detail: string };

/**
 * A provider adapter: pure request building and response parsing. The client
 * owns transport, deadline, retries and the key; an adapter owns only the wire
 * shape, so a second provider is one more adapter, not a second client.
 */
export interface DecisionProvider {
  /** Stable id recorded with every call, e.g. `typesafe`. */
  readonly id: string;
  /** The versioned model id this adapter pins. */
  readonly model: string;
  /** Returns a reason string when the request exceeds documented limits, else null. */
  validate(request: DecisionRequest): string | null;
  buildRequest(request: DecisionRequest, apiKey: string): ProviderHttpRequest;
  parseResponse(body: unknown, request: DecisionRequest): ProviderParseResult;
}

/**
 * How busy the CALLING thread was while one call was open: the event loop's
 * utilization over the call window. It separates the two ways a call can miss its
 * deadline — the provider answered late, or the answer arrived on time and sat
 * unread while this thread ran other code (a synchronous spawn, a blocking file
 * read, a long callback).
 */
export interface HostLoad {
  /** Milliseconds the thread spent running code, not idle waiting on I/O, during the call. */
  readonly busyMs: number;
  /** `busyMs` over the call window, in [0, 1]. */
  readonly utilization: number;
}

/**
 * One completed call, handed to the host's observer (the audit ledger). Carries
 * no raw state text and no key: the host decides what to hash or store.
 */
export interface DecisionCallRecord {
  readonly provider: string;
  readonly requestedModel: string;
  readonly request: DecisionRequest;
  readonly outcome: DecisionOutcome;
  readonly startedAt: Date;
  /** The consumer label passed to `decide`, e.g. `memory-injection`. */
  readonly consumer: string | null;
  /**
   * Where in the host the call was made (the `surface` passed to `decide`), e.g.
   * the injection port for the memory consumer. Null when the caller passed none.
   */
  readonly surface: string | null;
  /**
   * Ids of what the state was built from (memory ids, doc ids, …), passed to
   * `decide`. They let an audit resolve the judged content by id without the
   * ledger keeping a raw copy of it. Empty when the caller passed none.
   */
  readonly subjectIds: readonly string[];
  /**
   * The calling thread's event-loop activity over the call. Null when the
   * measurement is disabled (`hostLoad: null` on the client) or failed.
   */
  readonly hostLoad: HostLoad | null;
  /**
   * Request-to-complete-response time of the last attempt that got a response, as
   * measured by a transport running off the calling thread (the worker transport).
   * Unlike `outcome.latencyMs` it excludes time the answer waited for the calling
   * thread, so the two together split a slow call between provider and host. Null
   * when no attempt got a response or the transport does not measure it.
   */
  readonly transportLatencyMs: number | null;
}
