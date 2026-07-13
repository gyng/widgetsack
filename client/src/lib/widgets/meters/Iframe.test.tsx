import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import Iframe from './Iframe';

// Cast away null at the helper so call sites stay assertion-free (the repo forbids `!`); the
// empty-URL tests still read null at runtime, which `.toBeNull()` checks fine.
const frame = (c: HTMLElement) => c.querySelector('iframe') as HTMLIFrameElement;
const root = (c: HTMLElement) => c.querySelector('.np-iframe') as HTMLElement;
const originalConsoleError = console.error;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
	// happy-dom would otherwise issue a REAL network fetch for each iframe `src`. Disabling child-frame
	// navigation makes it just set the URL (no fetch) — keeping these tests offline/deterministic and
	// quiet, while the iframe still carries the src/attributes we assert on.
	const hd = (
		window as unknown as {
			happyDOM?: { settings?: { navigation?: { disableChildFrameNavigation?: boolean } } };
		}
	).happyDOM;
	if (hd?.settings?.navigation) hd.settings.navigation.disableChildFrameNavigation = true;
});

beforeEach(() => {
	vi.useFakeTimers();
	// happy-dom dispatches a synthetic iframe load after React's render act has returned, unlike a
	// browser where navigation is genuinely external. Suppress only that environment artifact; every
	// state transition this suite triggers itself remains wrapped in act and other errors still print.
	errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
		const text = args.map(String).join(' ');
		if (text.includes('not wrapped in act') && text.includes('Iframe')) return;
		originalConsoleError(...args);
	});
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	errorSpy.mockRestore();
});

describe('Iframe — empty / invalid URL', () => {
	it('renders the placeholder (not a frame) when url is blank', () => {
		const { container } = render(<Iframe url="" />);
		expect(frame(container)).toBeNull();
		expect(container.querySelector('[data-part="placeholder"]')?.textContent).toBe(
			'Add a URL in config'
		);
	});

	it('renders an "Invalid URL" placeholder for a rejected scheme', () => {
		const { container } = render(<Iframe url="javascript:alert(1)" />);
		expect(frame(container)).toBeNull();
		expect(container.querySelector('[data-part="placeholder"]')?.textContent).toBe('Invalid URL');
	});
});

describe('Iframe — frame attributes', () => {
	it('normalizes the url into the src and sets a11y / privacy attributes', () => {
		const { container } = render(
			<Iframe url="example.com" referrerPolicy="origin" title="Status" />
		);
		const f = frame(container);
		expect(f.getAttribute('src')).toBe('https://example.com/');
		expect(f.getAttribute('referrerpolicy')).toBe('origin');
		expect(f.getAttribute('loading')).toBe('lazy');
		expect(f.getAttribute('title')).toBe('Status');
	});

	it('falls back to a generic title when none is given', () => {
		const { container } = render(<Iframe url="https://example.com" />);
		expect(frame(container).getAttribute('title')).toBe('Embedded web page');
	});

	it('applies the opaque-origin sandbox by default and omits it when disabled', () => {
		const on = render(<Iframe url="https://example.com" sandbox />);
		expect(frame(on.container).getAttribute('sandbox')).toBe('allow-scripts');
		const off = render(<Iframe url="https://example.com" sandbox={false} />);
		expect(frame(off.container).hasAttribute('sandbox')).toBe(false);
	});

	it('disables scrolling only when scroll is off', () => {
		const noScroll = render(<Iframe url="https://example.com" scroll={false} />);
		expect(frame(noScroll.container).getAttribute('scrolling')).toBe('no');
		const scroll = render(<Iframe url="https://example.com" scroll />);
		expect(frame(scroll.container).hasAttribute('scrolling')).toBe(false);
	});
});

describe('Iframe — click-through (interactivity)', () => {
	it('decorative mode: 0×0 [data-interactive] sentinel, frame is not interactive', () => {
		const { container } = render(<Iframe url="https://example.com" interact={false} />);
		const sentinel = container.querySelector('.np-iframe-sentinel') as HTMLElement;
		expect(sentinel).not.toBeNull();
		expect(sentinel.getAttribute('data-interactive')).not.toBeNull();
		expect(sentinel.getAttribute('aria-hidden')).toBe('true');
		const f = frame(container);
		expect(f.hasAttribute('data-interactive')).toBe(false);
		expect(f.style.pointerEvents).toBe('none');
	});

	it('interactive mode: frame carries data-interactive, no sentinel', () => {
		const { container } = render(<Iframe url="https://example.com" interact />);
		expect(container.querySelector('.np-iframe-sentinel')).toBeNull();
		const f = frame(container);
		expect(f.hasAttribute('data-interactive')).toBe(true);
		expect(f.style.pointerEvents).toBe('auto');
	});
});

describe('Iframe — load / blocked lifecycle', () => {
	it('shows the spinner until load, then clears it (not blocked)', () => {
		const { container } = render(<Iframe url="https://example.com" />);
		expect(root(container).getAttribute('data-loading')).toBe('true');
		expect(container.querySelector('[data-part="spinner"]')).not.toBeNull();
		act(() => fireEvent.load(frame(container)));
		expect(root(container).getAttribute('data-loading')).toBe('false');
		expect(container.querySelector('[data-part="spinner"]')).toBeNull();
		expect(root(container).getAttribute('data-blocked')).toBe('false');
	});

	it('marks blocked + shows the hint when no load arrives within timeoutMs', () => {
		// A frame refused by X-Frame-Options/CSP fails silently (no error event), so the timeout is the
		// only signal — see Iframe.tsx. (React doesn't even fire onError for iframes; verified.)
		vi.useFakeTimers();
		const { container } = render(<Iframe url="https://example.com" timeoutMs={6000} />);
		expect(root(container).getAttribute('data-blocked')).toBe('false');
		expect(container.querySelector('[data-part="blocked"]')).toBeNull();
		act(() => vi.advanceTimersByTime(6001));
		expect(root(container).getAttribute('data-blocked')).toBe('true');
		expect(container.querySelector('[data-part="blocked"]')?.textContent).toBe(
			'Content blocked or unreachable'
		);
	});

	it('does not mark blocked when load beats the timeout', () => {
		vi.useFakeTimers();
		const { container } = render(<Iframe url="https://example.com" timeoutMs={6000} />);
		act(() => fireEvent.load(frame(container)));
		act(() => vi.advanceTimersByTime(10000));
		expect(root(container).getAttribute('data-blocked')).toBe('false');
	});
});

describe('Iframe — auto-refresh', () => {
	it('remounts the frame (new load cycle) every refresh interval', () => {
		vi.useFakeTimers();
		const { container } = render(
			<Iframe url="https://example.com" refresh={30} timeoutMs={60000} />
		);
		act(() => fireEvent.load(frame(container)));
		expect(root(container).getAttribute('data-loading')).toBe('false');
		// After the interval the frame remounts → a fresh load cycle (loading again).
		act(() => vi.advanceTimersByTime(30000));
		expect(root(container).getAttribute('data-loading')).toBe('true');
	});

	it('never remounts when refresh is 0', () => {
		vi.useFakeTimers();
		const { container } = render(
			<Iframe url="https://example.com" refresh={0} timeoutMs={60000} />
		);
		act(() => fireEvent.load(frame(container)));
		act(() => vi.advanceTimersByTime(120000));
		expect(root(container).getAttribute('data-loading')).toBe('false');
	});
});
