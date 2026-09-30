/**
 * Flags section (P-002) — the existing /admin/features console lifted into the
 * rail as an embeddable panel. FeaturesAdmin is already self-contained (no props,
 * own SSE to /api/flags/stream, preset buttons + per-flag toggles), so this is a
 * thin wrapper that just constrains it to the narrow rail (see .pcdar-embed).
 */
import FeaturesAdmin from '@/app/admin/features/FeaturesAdmin';

export default function FlagsPanel() {
  return (
    <div className="pcdar-embed">
      <FeaturesAdmin />
    </div>
  );
}
