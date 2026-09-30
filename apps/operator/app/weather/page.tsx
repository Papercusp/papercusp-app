'use client';

/**
 * /weather — local weather for the operator dashboard
 * (platform-ops-batch-2026-07-09 P-003, WI-3517). Deliberately minimal:
 * just the widget, dashboard-reachable at this route. Data rides the
 * `weather.current` sync query (@papercusp/sync); the vendor key
 * (WEATHER_API_KEY) comes from injected host config outside the repository —
 * see packages/operator-core/lib/weather/fetch-weather.ts.
 */
import WeatherWidget from '@/app/_components/WeatherWidget';

export default function WeatherPage() {
  return (
    <div style={{ padding: '2rem' }}>
      <h1>Local weather</h1>
      <WeatherWidget />
    </div>
  );
}
