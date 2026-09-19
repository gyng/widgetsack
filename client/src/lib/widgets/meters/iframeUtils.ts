// Pure helpers for the iframe (embedded web page) widget, extracted so the URL hardening and
// sandbox policy are unit-testable without React/DOM (AGENTS.md §4). No I/O, no Tauri, no DOM.

// Valid HTML referrer-policy tokens. The inspector's select offers a safe subset (no-referrer /
// origin / same-origin); this fuller set keeps a power-user's raw-JSON value working while still
// rejecting garbage (which would otherwise hit the DOM via the unchecked attribute).
const REFERRER_POLICIES = new Set([
	'no-referrer',
	'no-referrer-when-downgrade',
	'origin',
	'origin-when-cross-origin',
	'same-origin',
	'strict-origin',
	'strict-origin-when-cross-origin',
	'unsafe-url'
]);

/**
 * Normalize a user-entered URL for use as an iframe `src`, or return `''` (→ the widget shows its
 * "add a URL" / "invalid URL" placeholder) when it isn't a safe http(s) page.
 *
 * - Bare domains and `host:port` get an `https://` prefix (`home-assistant.local:8123` →
 *   `https://home-assistant.local:8123/`), so users can type the short form.
 * - Existing `http://` (LAN dashboards) and `https://` are kept.
 * - Any OTHER scheme — `javascript:`, `data:`, `file:`, `ftp:`, `mailto:`, … — is rejected. The
 *   tricky part is telling a scheme (`mailto:`, `host:port`-looking `localhost:3000`) apart: a real
 *   scheme is either `word://…` (authority form) or `word:` followed by a NON-digit; `word:` + digits
 *   is a host:port. The URL constructor (not a regex) then does the actual parsing/validation.
 * - Embedded credentials (`user:pass@host`) are stripped — they'd leak in the DOM `src`, and modern
 *   browsers ignore them for cross-origin iframe loads anyway.
 */
export function normalizeUrl(input: string): string {
	const raw = (input ?? '').trim();
	if (!raw) return '';
	// `word://…` — an explicit authority-based scheme. It must be http/https or we reject it.
	const authority = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
	if (authority) {
		if (!/^https?$/i.test(authority[1])) return '';
	} else if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(raw)) {
		// `word:` NOT followed by a digit → an opaque scheme (javascript:, data:, mailto:, file:,
		// about:, …). `word:` + digit is a host:port (localhost:3000), which falls through to https://.
		return '';
	}
	const candidate = authority ? raw : `https://${raw.replace(/^\/+/, '')}`;
	try {
		const u = new URL(candidate);
		// candidate is either an already-validated http(s) authority or one we prefixed with https://.
		u.username = '';
		u.password = '';
		return u.href;
	} catch {
		return '';
	}
}

/**
 * The `sandbox` attribute value for the iframe. When enabled we grant ONLY `allow-scripts`: the page
 * runs in an opaque origin — scripts work, but it can't reach the parent window, open popups,
 * navigate the top frame, or read same-origin storage. We deliberately never add `allow-same-origin`
 * (combined with `allow-scripts` it lets a same-origin page strip its own sandbox). `''` signals the
 * caller to OMIT the attribute entirely — note a literal `sandbox=""` would be the MOST restrictive
 * (all flags off), the opposite of "no sandboxing".
 */
export function sandboxValue(enabled: boolean): string {
	return enabled ? 'allow-scripts' : '';
}

/**
 * Clamp a referrer-policy to a valid HTML token, defaulting to the privacy-safe `no-referrer`. The
 * select field already constrains the UI; this guards the raw-JSON escape hatch so a typo can't reach
 * the DOM attribute (defense-in-depth, mirroring normalizeUrl).
 */
export function safeReferrerPolicy(value: string | undefined): string {
	return value && REFERRER_POLICIES.has(value) ? value : 'no-referrer';
}
