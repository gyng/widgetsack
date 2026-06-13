// Pure band helpers for the Air Quality widget. No React/DOM — unit-tested. The weather source emits
// weather.air.aqi (European AQI) + weather.air.pm25 and weather.uv; these bucket the numbers into a
// labelled severity band that drives the meter's colour.

export type AqiLevel = 'good' | 'fair' | 'moderate' | 'poor' | 'verypoor' | 'extreme';

/** European AQI → label + level (the official 0–20 / 20–40 / 40–60 / 60–80 / 80–100 / 100+ bands). */
export function aqiBand(aqi: number | null): { label: string; level: AqiLevel } {
	if (aqi == null) return { label: '—', level: 'good' };
	if (aqi < 20) return { label: 'Good', level: 'good' };
	if (aqi < 40) return { label: 'Fair', level: 'fair' };
	if (aqi < 60) return { label: 'Moderate', level: 'moderate' };
	if (aqi < 80) return { label: 'Poor', level: 'poor' };
	if (aqi < 100) return { label: 'Very poor', level: 'verypoor' };
	return { label: 'Extremely poor', level: 'extreme' };
}

export type UvLevel = 'low' | 'moderate' | 'high' | 'veryhigh' | 'extreme';

/** UV index → label + level (WHO bands: ≤2 low, 3–5 moderate, 6–7 high, 8–10 very high, 11+ extreme). */
export function uvBand(uv: number | null): { label: string; level: UvLevel } {
	if (uv == null) return { label: '—', level: 'low' };
	const u = Math.round(uv);
	if (u <= 2) return { label: 'Low', level: 'low' };
	if (u <= 5) return { label: 'Moderate', level: 'moderate' };
	if (u <= 7) return { label: 'High', level: 'high' };
	if (u <= 10) return { label: 'Very high', level: 'veryhigh' };
	return { label: 'Extreme', level: 'extreme' };
}
