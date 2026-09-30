/**
 * @papercusp/structured-concurrency — a generic distributed-systems concurrency toolkit.
 *
 * One durable spawn tree, four mechanisms, all over injected store ports:
 *   • nursery        — structured concurrency: transitive cancel + the completion gate.
 *   • supervision    — an OTP supervision tree: restart strategies + a restart-intensity governor.
 *   • governor       — layered backpressure: token bucket (+ bulkhead) + circuit breaker + credits.
 *   • saga           — sagas + tombstones for compensable destructive ops.
 *   • lock-order     — a total lock-class order for cross-subsystem deadlock avoidance.
 *
 * The algorithms are pure; the host supplies the durable store (PG, in-memory, …) and the
 * resource-release / notify / escalate effects through the ports. Zero domain coupling,
 * zero runtime deps. The in-memory store (`./mem-store`) is the reference implementation
 * the conformance suite runs against.
 */
export * from './types';
export * from './ports';
export * from './lock-order';
export * from './nursery';
export * from './supervision';
export * from './governor';
export * from './saga';
