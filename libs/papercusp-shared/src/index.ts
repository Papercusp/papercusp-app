// @papercusp/papercusp-shared — shared helpers consumed by the operator.
//
// The presentational Papercup view-tree (`*View.tsx`, `PapercupTabs`,
// `useAgentRoles`, `DocumentationFrame`, …) was removed 2026-06-01: its only
// consumers were the retired `_retired/papercup` site and the dead
// `libs/papercusp/apps/web` Next app (neither in the workspace / live build).
// The operator imports only `openFeatureChat` (here) and the backend agent
// runner (`@papercusp/papercusp-shared/agent`). See plan
// `finish-next-removal-2026-06-01` (D-002).
//
// `_admin-paths`, `theme`, and `Tooltip` remain as standalone modules (imported
// directly by path where used), not re-exported from this index.

export { openFeatureChat, OPEN_CHAT_EVENT, type OpenChatEventDetail } from './openFeatureChat';
