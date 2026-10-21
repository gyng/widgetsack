import { act, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import CustomHtml from './CustomHtml';
const state = {
	sensors: {},
	tokens: { '--np-fg': 'white' },
	size: { width: 320, height: 100, pixelRatio: 1 }
};
it('keeps an opaque origin and decorative click-through, and only accepts its own ready messages', () => {
	const view = render(
		<CustomHtml
			token="session"
			title="Example"
			interact={false}
			state={state}
			srcDoc="<main>Hello</main>"
		/>
	);
	const frame = screen.getByTitle('Example') as HTMLIFrameElement;
	expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
	expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
	expect(frame.style.pointerEvents).toBe('none');
	expect(view.container.querySelector('[data-interactive]')).toHaveAttribute('aria-hidden', 'true');
	const post = vi.spyOn(frame.contentWindow!, 'postMessage');
	const ready = { type: 'widgetsack:ready', version: 1, token: 'session' };
	act(() => window.dispatchEvent(new MessageEvent('message', { data: ready, source: window })));
	act(() =>
		window.dispatchEvent(
			new MessageEvent('message', {
				data: { ...ready, token: 'other' },
				source: frame.contentWindow
			})
		)
	);
	expect(post).not.toHaveBeenCalled();
	act(() =>
		window.dispatchEvent(new MessageEvent('message', { data: ready, source: frame.contentWindow }))
	);
	expect(post).toHaveBeenLastCalledWith(
		{ type: 'widgetsack:state', version: 1, token: 'session', state },
		'*'
	);
	view.rerender(
		<CustomHtml
			token="session"
			title="Example"
			interact
			state={{ ...state, size: { width: 400, height: 80, pixelRatio: 2 } }}
			srcDoc="<main>Hello</main>"
		/>
	);
	expect(frame.style.pointerEvents).toBe('auto');
	expect(frame).toHaveAttribute('data-interactive');
	expect(post).toHaveBeenLastCalledWith(
		expect.objectContaining({
			state: expect.objectContaining({ size: { width: 400, height: 80, pixelRatio: 2 } })
		}),
		'*'
	);
	view.unmount();
	post.mockClear();
	act(() => window.dispatchEvent(new MessageEvent('message', { data: ready, source: window })));
	expect(post).not.toHaveBeenCalled();
});
