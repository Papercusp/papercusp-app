/**
 * The canonical noVNC declaration lives with the Vite app, which owns the
 * dependency. Next's operator program also compiles the shared cloud-workspace
 * components, so reference that declaration instead of maintaining a second
 * API surface that can drift.
 */
/// <reference path="../../operator-vite/src/types/novnc.d.ts" />
