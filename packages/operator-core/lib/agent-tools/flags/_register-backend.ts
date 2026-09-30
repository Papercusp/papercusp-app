/**
 * Side-effect import that ensures the PostHog client is initialized
 * before any flag tool runs. Pulls the in-process flag bus, which in
 * turn calls initFlagBackend() with the resolved config.
 */
import '../../flag-bus';
