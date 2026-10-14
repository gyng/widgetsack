// cssThreats.ts — a pure scanner for UNTRUSTED theme CSS (e.g. a theme packed into a shared sack).
// Theme CSS is injected verbatim into the studio/overlay (StyleLayer), so a hostile theme can reach
// outside the app: a remote `url(...)` or `@import` silently phones home (a tracking pixel / web
// font that leaks your IP + "app is open" the moment the layout renders), and a full-viewport
// `position: fixed` block can overlay the whole screen (UI redress). The CSP blocks script and most
// connect-src, but stylesheet-driven remote fetches (img/font/background) still go out — so we warn
// the user before importing a stranger's theme. Pure (no I/O), unit-tested in cssThreats.test.ts.

export type ThreatKind = 'remote-url' | 'import' | 'overlay';

export type CssThreat = {
	kind: ThreatKind;
	/** A human-readable, already-truncated description for a confirm() dialog. */
	detail: string;
};

// A resource reference: `url(` / `image(` / `image-set(` / `-webkit-image-set(` / `src(` and its
// (first) target; `isRemoteTarget` decides whether that target leaves the app. The target is a
// lookahead so a nested `image-set(url(…))` is still scanned from the inner `url(`.
const RESOURCE_REF = /(?:url|image|(?:-webkit-)?image-set|src)\(\s*(?=(['"]?)([^()'"]*))/gi;

// Schemes that stay inside the webview, and the app's own custom-protocol hosts (convertFileSrc →
// asset.localhost, the app origin tauri.localhost, album art art.localhost — see art.rs). The host
// must END at a port / path / query / fragment, so `asset.localhost.evil.example` and
// `asset.localhost@evil.example` (userinfo) are still remote.
const LOCAL_SCHEME = /^(?:data|blob|asset):/i;
const LOCAL_HOST = /^https?:\/\/(?:asset|tauri|art)\.localhost(?::\d*)?(?:[/?#]|$)/i;
const SCHEME = /^[a-z][a-z0-9+.-]+:/i;

/**
 * Whether a URL reference (a CSS `url()` target after escape decoding, an image `src`, …) resolves to
 * something OUTSIDE the app when loaded against the app origin (http://tauri.localhost). Mirrors the
 * WHATWG URL parser's leniency rather than matching only canonical `https://`: leading C0/space and
 * embedded tab/newline are stripped, `\` counts as `/`, so a leading `//` (or `\\`, `/\`) is
 * scheme-relative, and ANY scheme other than data:/blob:/asset: or an app host — `https:evil.example`,
 * `https:/evil`, `ftp:`, `file:` — is treated as remote. A bare relative / root-relative path is
 * local; a one-letter "scheme" is a Windows drive path (`C:\…`), which the URL parser cannot fetch.
 * Pure.
 */
export function isRemoteTarget(raw: string): boolean {
	let start = 0;
	while (start < raw.length && raw.charCodeAt(start) <= 0x20) start++;
	const v = raw
		.slice(start)
		.replace(/[\t\n\r]/g, '')
		.replace(/\\/g, '/');
	if (v.startsWith('//')) return true;
	if (!SCHEME.test(v)) return false;
	return !LOCAL_SCHEME.test(v) && !LOCAL_HOST.test(v);
}

// Every quoted candidate of an `image-set(…)` list (RESOURCE_REF only sees the first target).
const IMAGE_SET = /(?:-webkit-)?image-set\(([^)]*)\)/gi;
const QUOTED = /(['"])(.*?)\1/g;
const IMPORT = /@import\b[^;]*/gi;
const OVERLAY = /position\s*:\s*(?:fixed|sticky)/gi;

/**
 * Normalise CSS so the regexes see what the browser's tokenizer sees: comments replaced by a space
 * (a comment is a token separator, so `@imp/\*\*\/ort` is NOT an import and a `url(…)` inside a
 * comment is NOT a fetch — neither may produce a false alarm or a miss), CSS escapes decoded
 * (`\75rl(` is `url(`, `posi\74ion` is `position`, `\3a` is `:`), and whitespace runs collapsed.
 * Exported for tests. Pure.
 */
export function normalizeCss(css: string): string {
	const noComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
	// `\` + 1–6 hex digits + one optional whitespace char, or `\` + any other single char (which
	// stands for itself). A lone trailing `\` is dropped.
	const decoded = noComments.replace(/\\(?:([0-9a-fA-F]{1,6})\s?|([\s\S]))/g, (_m, hex, ch) => {
		if (hex !== undefined) {
			const code = parseInt(hex, 16);
			return code === 0 || code > 0x10ffff ? '�' : String.fromCodePoint(code);
		}
		return ch;
	});
	return decoded.replace(/\s+/g, ' ');
}

/** First ~80 chars of a match, whitespace-collapsed, for a readable dialog line. */
function snippet(s: string): string {
	const one = s.replace(/\s+/g, ' ').trim();
	return one.length > 80 ? `${one.slice(0, 77)}…` : one;
}

/**
 * Scan a CSS string for constructs that reach outside the local app or hijack the viewport.
 * Returns one threat per distinct site (de-duplicated by detail), empty when the CSS is benign.
 */
export function scanCssThreats(css: string | undefined): CssThreat[] {
	const text = normalizeCss(css ?? '');
	const seen = new Set<string>();
	const out: CssThreat[] = [];
	const add = (kind: ThreatKind, detail: string) => {
		const key = `${kind}:${detail}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ kind, detail });
	};

	let m: RegExpExecArray | null;
	while ((m = RESOURCE_REF.exec(text)) !== null) {
		// normalizeCss turned tabs/newlines into spaces; the URL parser would have dropped them, so a
		// space-split scheme (`ht tps:`) is judged without its spaces.
		if (isRemoteTarget(m[2].replace(/ /g, ''))) add('remote-url', snippet(m[0] + m[1] + m[2]));
	}
	while ((m = IMAGE_SET.exec(text)) !== null) {
		for (const q of m[1].matchAll(QUOTED)) {
			if (isRemoteTarget(q[2].replace(/ /g, ''))) add('remote-url', snippet(m[0]));
		}
	}
	while ((m = IMPORT.exec(text)) !== null) add('import', snippet(m[0]));
	while ((m = OVERLAY.exec(text)) !== null) add('overlay', snippet(m[0]));
	return out;
}

/** A one-line summary for a confirm() prompt, or '' when there's nothing to warn about. */
export function threatSummary(threats: CssThreat[]): string {
	if (!threats.length) return '';
	const remote = threats.filter((t) => t.kind === 'remote-url' || t.kind === 'import').length;
	const overlay = threats.filter((t) => t.kind === 'overlay').length;
	const bits: string[] = [];
	if (remote) bits.push(`${remote} remote resource${remote === 1 ? '' : 's'} (could phone home)`);
	if (overlay) bits.push(`${overlay} full-screen overlay rule${overlay === 1 ? '' : 's'}`);
	return bits.join(' and ');
}
