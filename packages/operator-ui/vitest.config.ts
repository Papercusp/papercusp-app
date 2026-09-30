import { defineVitestConfig } from '@papercusp/test-config';

// Without a config of its own a `vitest run` from this package walks UP to the
// repository root config and runs the whole monorepo topology from here (the
// same trap libs/generic/chat-protocol documents). This package's tests are
// unit-layer guards over its own src/ (the Papercup-chat parity matrix first,
// P-002 of papercup-chat-one-component-one-contract-2026-09-06); the shared
// config wires the admin test-runs reporter automatically.
export default defineVitestConfig({ layer: 'unit' });
