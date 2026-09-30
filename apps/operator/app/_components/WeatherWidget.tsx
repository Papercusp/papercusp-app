'use client';

/**
 * WeatherWidget — local weather for the operator dashboard
 * (platform-ops-batch-2026-07-09 P-003). Reads via `@papercusp/sync`
 * (weather.current), never a hand-rolled fetch — the resolver does the
 * live third-party call server-side, keyed by WEATHER_API_KEY from injected
 * host config outside the repository.
 */
import { useSyncQuery } from '@papercusp/sync';

interface WeatherRow {
  tempC: number;
  conditions: string;
  fetchedAt: string;
  source: string;
}

/** Default coords: NYC (matches this dev box's local tz). Override via props for a real deploy. */
export default function WeatherWidget({ lat = 40.7128, lon = -74.006 }: { lat?: number; lon?: number }) {
  const { data, error, loading } = useSyncQuery<WeatherRow>({
    queryName: 'weather.current',
    args: { lat, lon },
  });

  if (loading) {
    return (
      <div className="pc-weather-widget" role="status">
        Loading weather…
      </div>
    );
  }
  if (error || !data?.[0]) {
    return (
      <div className="pc-weather-widget pc-weather-widget--error" role="status">
        Weather unavailable{error ? ` — ${String(error)}` : ''}
      </div>
    );
  }
  const w = data[0];
  return (
    <div className="pc-weather-widget" role="status">
      <span className="pc-weather-widget__temp">{Math.round(w.tempC)}°C</span>
      <span className="pc-weather-widget__conditions">{w.conditions}</span>
    </div>
  );
}
