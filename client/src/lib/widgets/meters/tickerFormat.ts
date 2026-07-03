// Pure formatting helpers for the stock Ticker meter, extracted so price/change formatting and the
// market-state vocabulary are unit-testable without React/DOM (AGENTS.md §4). No I/O, no DOM.

export type Direction = 'up' | 'down' | 'flat';

/** Sign of a change as a direction; non-finite / null / 0 → 'flat'. */
export function direction(change: number | null | undefined): Direction {
	if (change == null || !Number.isFinite(change) || change === 0) return 'flat';
	return change > 0 ? 'up' : 'down';
}

/** A glyph for the direction (▲ up / ▼ down / · flat). */
export function directionArrow(dir: Direction): string {
	return dir === 'up' ? '▲' : dir === 'down' ? '▼' : '·';
}

/** Group-separated fixed-decimal price, or an em dash when there's no value yet. Deterministic
 * (manual grouping, not locale-dependent) so it renders the same everywhere and in tests. */
export function formatPrice(value: number | null | undefined, decimals = 2): string {
	if (value == null || !Number.isFinite(value)) return '—';
	const d = Math.max(0, Math.min(6, Math.round(decimals)));
	const fixed = Math.abs(value).toFixed(d);
	const [intPart, frac] = fixed.split('.');
	const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	const sign = value < 0 ? '-' : '';
	return frac ? `${sign}${grouped}.${frac}` : `${sign}${grouped}`;
}

/** Signed percent change, e.g. "+1.23%" / "-0.50%"; '' when there's no value. */
export function formatChangePct(change: number | null | undefined): string {
	if (change == null || !Number.isFinite(change)) return '';
	const sign = change > 0 ? '+' : '';
	return `${sign}${change.toFixed(2)}%`;
}

/** Signed absolute change, e.g. "+1.20" / "-0.30"; '' when there's no value. */
export function formatChangeAbs(change: number | null | undefined, decimals = 2): string {
	if (change == null || !Number.isFinite(change)) return '';
	const sign = change > 0 ? '+' : change < 0 ? '-' : '';
	return `${sign}${formatPrice(Math.abs(change), decimals)}`;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
	USD: '$',
	EUR: '€',
	GBP: '£',
	JPY: '¥',
	CNY: '¥',
	AUD: 'A$',
	CAD: 'C$',
	HKD: 'HK$',
	INR: '₹',
	KRW: '₩'
};

/** A leading symbol for a currency code ($, €, …), or '' for an unknown code (show the bare number). */
export function currencySymbol(code: string | null | undefined): string {
	return code ? (CURRENCY_SYMBOLS[code.toUpperCase()] ?? '') : '';
}

/** Friendly label for a Yahoo market state, or '' for an open/regular session (nothing to flag). */
export function marketLabel(state: string | null | undefined): string {
	switch ((state ?? '').toUpperCase()) {
		case '':
		case 'REGULAR':
			return '';
		case 'PRE':
		case 'PREPRE':
			return 'pre-market';
		case 'POST':
		case 'POSTPOST':
			return 'after hours';
		case 'CLOSED':
			return 'closed';
		default:
			return state ? state.toLowerCase() : '';
	}
}
