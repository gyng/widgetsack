import { act, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import PalettePreview from './PalettePreview';

it('renders only visible previews, scales to tile width and releases observers', () => {
	let intersect!: IntersectionObserverCallback;
	let resize!: ResizeObserverCallback;
	const disconnect = vi.fn();
	vi.stubGlobal(
		'IntersectionObserver',
		class {
			constructor(cb: IntersectionObserverCallback) {
				intersect = cb;
			}
			observe() {}
			disconnect = disconnect;
		}
	);
	vi.stubGlobal(
		'ResizeObserver',
		class {
			constructor(cb: ResizeObserverCallback) {
				resize = cb;
			}
			observe() {}
			disconnect = disconnect;
		}
	);
	try {
		const view = render(<PalettePreview type="clock" />);
		expect(view.container.querySelector('[data-preview]')).toBeNull();
		act(() => {
			intersect(
				[{ isIntersecting: true } as IntersectionObserverEntry],
				{} as IntersectionObserver
			);
			resize([{ contentRect: { width: 200 } } as ResizeObserverEntry], {} as ResizeObserver);
		});
		expect(view.container.querySelector('[data-preview]')).toHaveStyle({ width: '184px' });
		act(() =>
			resize([{ contentRect: { width: 40 } } as ResizeObserverEntry], {} as ResizeObserver)
		);
		expect(view.container.querySelector('[data-preview]')).toHaveStyle({ width: '64px' });
		act(() =>
			intersect(
				[{ isIntersecting: false } as IntersectionObserverEntry],
				{} as IntersectionObserver
			)
		);
		expect(view.container.querySelector('[data-preview]')).toBeNull();
		view.unmount();
		expect(disconnect).toHaveBeenCalledTimes(2);
	} finally {
		vi.unstubAllGlobals();
	}
});
