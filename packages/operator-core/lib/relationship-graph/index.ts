/**
 * The platform relationship graph (crm-agent-sales-onboarding-apps-2026-10-06 P-002, D-001 /
 * D-011): canonical persons and organizations merged from every connector source, with
 * per-field provenance, and interaction participants resolved to graph persons. Platform-level,
 * not CRM-owned: Email, Calendar, Phone and the CRM all key to these ids.
 */
export * from './identity-keys';
export * from './merge';
export * from './resolver';
export * from './graph-sink';
export * from './participants';
