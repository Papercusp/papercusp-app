// _admin-paths.ts — INTENTIONAL admin URL strings, scoped to one file.
//
// All `/api/org/...` and `/api/harness/...` admin path literals in the shared
// lib are confined here. The shared views import these helpers and call them
// only inside admin code paths — every consumer guards with `if (readOnly) return`
// before invoking, so on the public site these URLs are dead code in the bundle
// (and never reached by fetch).
//
// This file is the single point of admin-URL containment. It is the only file
// in libs/papercusp-shared/ exempt from the admin-fetch lint rule. New uses
// must come through these helpers; the lint will catch direct literals
// elsewhere in the lib.

export const orgPath = (rel: string): string => '/api/org/' + rel;
export const harnessPath = (rel: string): string => '/api/harness/' + rel;
