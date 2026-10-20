import type { SensorState } from './telemetry';

export type CustomHtmlState = {
	sensors: Record<string, SensorState>;
	tokens: Record<string, string>;
	size: { width: number; height: number; pixelRatio: number };
};

// Mirrors the native response header in custom_html.rs; the meta also protects browser previews.
export const CUSTOM_HTML_CSP =
	"default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** Explicit allowlist, also used by WidgetHost's existing multi-sensor subscription wiring. */
export function customHtmlSensors(spec: string): Record<string, string> {
	return Object.fromEntries(
		[...new Set(spec.split(/[,\n]+/).map((id) => id.trim()))]
			.filter((id) => /^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/.test(id))
			.slice(0, 32)
			.map((id) => [id, id])
	);
}

export function isCustomHtmlReady(value: unknown, token: string): boolean {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		'type' in value &&
		value.type === 'widgetsack:ready' &&
		'version' in value &&
		value.version === 1 &&
		'token' in value &&
		value.token === token
	);
}

/** A complete isolated document. Native serving supplies the independent response CSP. */
export function buildCustomHtmlDocument(
	html: string,
	css: string,
	javascript: string,
	token: string
): string {
	const encoded = JSON.stringify({ css, javascript, token }).replaceAll('<', '\\u003c');
	return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CUSTOM_HTML_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}*{box-sizing:border-box}body{font-family:var(--np-font,sans-serif);font-size:var(--np-text-body,14px);color:var(--np-fg,white)}</style><script>
(() => {
 const config = ${encoded};
 let state = { sensors: {}, tokens: {}, size: { width: 0, height: 0, pixelRatio: 1 } };
 const listeners = new Set();
 window.widgetsack = Object.freeze({ getState: () => state, subscribe: (listener) => { listeners.add(listener); listener(state); return () => listeners.delete(listener); } });
 addEventListener('message', (event) => {
  const data = event.data;
  if (event.source !== parent || !data || data.type !== 'widgetsack:state' || data.version !== 1 || data.token !== config.token || !data.state || typeof data.state !== 'object') return;
  state = data.state;
  for (const [key, value] of Object.entries(state.tokens)) document.documentElement.style.setProperty(key, value);
  for (const listener of listeners) listener(state);
  dispatchEvent(new CustomEvent('widgetsack:update', { detail: state }));
 });
 addEventListener('DOMContentLoaded', () => {
  const style = document.createElement('style'); style.textContent = config.css; document.head.append(style);
  const url = URL.createObjectURL(new Blob([config.javascript], { type: 'text/javascript' }));
  const script = document.createElement('script'); script.type = 'module'; script.src = url;
  script.onload = script.onerror = () => URL.revokeObjectURL(url); document.head.append(script);
  parent.postMessage({ type: 'widgetsack:ready', version: 1, token: config.token }, '*');
 });
})();
</script></head><body>${html}</body></html>`;
}
