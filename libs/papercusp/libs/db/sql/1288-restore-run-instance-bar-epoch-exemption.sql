-- 1288: restore the template@run-N exemption in stamp_acceptance_bar_epoch.
--
-- Migration 1219 was applied to the live database at 2026-09-24T17:31:53Z with
-- the content of commit f333bfbd (ledger sha256 be963904…), which did NOT yet
-- redefine stamp_acceptance_bar_epoch. The exemption was then added to the
-- already-applied 1219 file (commit 63e64674, sha256 1c979b47…), and an applied
-- migration never re-runs, so the live function kept migration 1111's body:
-- every non-rubric INSERT, run instances included, is stamped post-epoch.
--
-- Consequence (WI-10004563, measured 2026-10-01 06:39Z on :3170 9d4ef786ea): a
-- BAR-ready plan-target template passes runScheduledPlanFire's pre-start gate,
-- but its `<template>@run-N` instance is a fresh post-epoch plan with no BAR set
-- or rubric of its own, so promotion refuses it
-- (plan_run_acceptance_bar_blocked:<template>@run-6:bar_snapshot_*). The live
-- ledger holds 22 such instances, all already superseded, so no backfill.
--
-- A run instance is a snapshot of an already admitted template, not a new
-- author plan; the template is the BAR subject (plan D-044). Keep ordinary new
-- plans strict and exempt only the canonical template@run-<digits> shape. This
-- is the 63e64674 body of 1219 verbatim; CREATE OR REPLACE is idempotent, so a
-- database that did apply the newer 1219 is unchanged.
CREATE OR REPLACE FUNCTION harness_shared.stamp_acceptance_bar_epoch()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.template IS DISTINCT FROM 'rubric'
     AND NOT (NEW.template_slug IS NOT NULL AND NEW.plan_slug ~ '.+@run-[0-9]+$')
     AND NEW.acceptance_bar_epoch IS NULL THEN
    NEW.acceptance_bar_epoch := 1;
    NEW.acceptance_bar_cohort := 'post-epoch';
  END IF;
  RETURN NEW;
END;
$fn$;
