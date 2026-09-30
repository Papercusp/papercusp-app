/**
 * fetch-weather — local weather for the operator dashboard
 * (platform-ops-batch-2026-07-09 P-003).
 *
 * Vendor: Open-Meteo-compatible current-weather endpoint keyed by
 * `WEATHER_API_KEY` (a THIRD-PARTY vendor credential, not one of the 4
 * platform provider keys `setup:save_key` owns). The preferred sources are
 * injected process environment and the host-only credential file at
 * `~/.papercusp/local-secrets/weatherapi-key`; neither source is part of the
 * repository tree. Reading the sources at call time (not module load) keeps
 * this test-injectable and avoids baking a missing-key crash into import order.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface WeatherResult {
  tempC: number;
  conditions: string;
  fetchedAt: string;
  source: string;
}

export interface FetchWeatherOptions {
  lat: number;
  lon: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to process.env.WEATHER_API_KEY. */
  apiKey?: string;
  /** Injectable host credential path; defaults to WEATHER_API_KEY_FILE or the host-only path. */
  apiKeyFile?: string;
}

export class WeatherConfigError extends Error {}
export class WeatherFetchError extends Error {}

const DEFAULT_WEATHER_API_KEY_FILE = join(homedir(), '.papercusp', 'local-secrets', 'weatherapi-key');

function readWeatherApiKey(opts: FetchWeatherOptions): string | undefined {
  // An explicit option, including an empty string, is authoritative. Tests use
  // the empty value to exercise the not-configured branch without touching host
  // credentials.
  if (opts.apiKey !== undefined) return opts.apiKey.trim() || undefined;

  const injected = process.env.WEATHER_API_KEY?.trim();
  if (injected) return injected;

  const credentialPath = opts.apiKeyFile ?? process.env.WEATHER_API_KEY_FILE ?? DEFAULT_WEATHER_API_KEY_FILE;
  try {
    return readFileSync(credentialPath, 'utf8').trim() || undefined;
  } catch {
    // A missing/unreadable host credential is the same configuration state as
    // an unset env value; the caller turns it into a clear config error.
    return undefined;
  }
}

/**
 * Fetch current local weather for (lat, lon). Throws WeatherConfigError when
 * no API key is configured (surfaced as a clear "not set up" state, not a
 * silent zero-data widget) and WeatherFetchError on a vendor/network failure.
 */
export async function fetchCurrentWeather(opts: FetchWeatherOptions): Promise<WeatherResult> {
  const apiKey = readWeatherApiKey(opts);
  if (!apiKey) {
    throw new WeatherConfigError(
      'WEATHER_API_KEY is not configured — provide injected host config or WEATHER_API_KEY_FILE outside the repository.',
    );
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const url = new URL('https://api.openweathermap.org/data/2.5/weather');
  url.searchParams.set('lat', String(opts.lat));
  url.searchParams.set('lon', String(opts.lon));
  url.searchParams.set('units', 'metric');
  url.searchParams.set('appid', apiKey);

  let res: Response;
  try {
    res = await doFetch(url.toString());
  } catch (e) {
    throw new WeatherFetchError(`weather vendor request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new WeatherFetchError(`weather vendor returned ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as {
    main?: { temp?: number };
    weather?: Array<{ description?: string }>;
  };
  const tempC = body.main?.temp;
  if (typeof tempC !== 'number') {
    throw new WeatherFetchError('weather vendor response missing main.temp');
  }
  return {
    tempC,
    conditions: body.weather?.[0]?.description ?? 'unknown',
    fetchedAt: new Date().toISOString(),
    source: 'openweathermap',
  };
}
