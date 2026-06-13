// Pure WMO weather-code → label + icon mapping for the Weather widget. No React/DOM, unit-tested.
// Codes are the WMO 4677 set Open-Meteo returns in `weather_code`; `isDay` swaps the clear/partly
// glyphs to their night form. An unknown code falls back to a neutral placeholder.

export type WeatherInfo = { label: string; icon: string };

export function weatherInfo(code: number, isDay = true): WeatherInfo {
	const night = !isDay;
	switch (code) {
		case 0:
			return { label: 'Clear', icon: night ? '🌙' : '☀️' };
		case 1:
			return { label: 'Mainly clear', icon: night ? '🌙' : '🌤️' };
		case 2:
			return { label: 'Partly cloudy', icon: night ? '☁️' : '⛅' };
		case 3:
			return { label: 'Overcast', icon: '☁️' };
		case 45:
		case 48:
			return { label: 'Fog', icon: '🌫️' };
		case 51:
		case 53:
		case 55:
			return { label: 'Drizzle', icon: '🌦️' };
		case 56:
		case 57:
			return { label: 'Freezing drizzle', icon: '🌧️' };
		case 61:
		case 63:
		case 65:
			return { label: 'Rain', icon: '🌧️' };
		case 66:
		case 67:
			return { label: 'Freezing rain', icon: '🌧️' };
		case 71:
		case 73:
		case 75:
			return { label: 'Snow', icon: '🌨️' };
		case 77:
			return { label: 'Snow grains', icon: '🌨️' };
		case 80:
		case 81:
		case 82:
			return { label: 'Rain showers', icon: '🌦️' };
		case 85:
		case 86:
			return { label: 'Snow showers', icon: '🌨️' };
		case 95:
			return { label: 'Thunderstorm', icon: '⛈️' };
		case 96:
		case 99:
			return { label: 'Thunderstorm + hail', icon: '⛈️' };
		default:
			return { label: '—', icon: '❓' };
	}
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Column label for a forecast day: "Today" for offset 0, else the 3-letter weekday computed from
 * `baseMs` (passed in, so the helper stays pure + testable). */
export function forecastDayLabel(offsetDays: number, baseMs: number): string {
	if (offsetDays <= 0) return 'Today';
	return WEEKDAYS[new Date(baseMs + offsetDays * 86_400_000).getDay()];
}

export type ForecastCell = { code: number | null; high: number | null; low: number | null };
export type ForecastDay = ForecastCell & { label: string; info: WeatherInfo };

/** Decorate raw per-day cells (index 0 = today) with a column label + day-icon. Pure (baseMs in).
 * Forecast icons use the day glyph — a daily summary has no night variant. */
export function labelForecast(cells: ForecastCell[], baseMs: number): ForecastDay[] {
	return cells.map((c, i) => ({
		...c,
		label: forecastDayLabel(i, baseMs),
		info: c.code == null ? { label: '—', icon: '❓' } : weatherInfo(c.code, true)
	}));
}
