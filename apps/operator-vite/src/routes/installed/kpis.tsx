import { createFileRoute } from '@tanstack/react-router';
import KPIsPage from '@/app/installed/kpis/page';

/**
 * /installed/kpis — cross-harness KPI dashboard. Translated from
 * `apps/operator/app/installed/kpis/page.tsx` ('use client', clean).
 */
export const Route = createFileRoute('/installed/kpis')({
  component: KPIsPage,
});
