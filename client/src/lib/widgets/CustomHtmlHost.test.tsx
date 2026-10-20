import { act, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const adapter = vi.hoisted(() => ({
	registerCustomHtml: vi.fn(),
	releaseCustomHtml: vi.fn().mockResolvedValue(undefined)
}));
vi.mock('./plugins/customhtml-commands', () => adapter);
import CustomHtmlHost from './CustomHtmlHost';

let resize: () => void;
beforeEach(() => {
	adapter.registerCustomHtml.mockReset();
	adapter.releaseCustomHtml.mockClear();
	vi.stubGlobal(
		'ResizeObserver',
		class {
			constructor(callback: () => void) {
				resize = callback;
			}
			observe() {}
			disconnect() {}
		}
	);
});

it('forwards resolved theme, sensor state and size without remounting for sensor updates', async () => {
	adapter.registerCustomHtml.mockResolvedValue({ url: 'http://customhtml.localhost/test' });
	const view = render(
		<div style={{ '--np-fg': 'red' } as React.CSSProperties}>
			<CustomHtmlHost html="<b>Hi</b>" />
		</div>
	);
	expect(screen.getByRole('status')).toHaveTextContent('Loading');
	await act(async () => undefined);
	const frame = screen.getByTitle('Custom HTML widget') as HTMLIFrameElement;
	const post = vi.spyOn(frame.contentWindow!, 'postMessage');
	const host = view.container.querySelector('.np-customhtml-host')!;
	Object.defineProperty(host, 'clientWidth', { configurable: true, value: 400 });
	Object.defineProperty(host, 'clientHeight', { configurable: true, value: 80 });
	act(() => resize());
	expect(post).toHaveBeenCalledWith(
		expect.objectContaining({
			state: expect.objectContaining({ size: { width: 400, height: 80, pixelRatio: 1 } })
		}),
		'*'
	);
	act(() => window.dispatchEvent(new Event('resize')));
	const sensors = {
		'cpu.total': { value: { kind: 'scalar' as const, value: 42 }, history: [40, 42] }
	};
	view.rerender(
		<div style={{ '--np-fg': 'red' } as React.CSSProperties}>
			<CustomHtmlHost html="<b>Hi</b>" sensors={sensors} />
		</div>
	);
	expect(post).toHaveBeenLastCalledWith(
		expect.objectContaining({ state: expect.objectContaining({ sensors }) }),
		'*'
	);
	expect(adapter.registerCustomHtml).toHaveBeenCalledTimes(1);
	view.unmount();
	expect(adapter.releaseCustomHtml).toHaveBeenCalled();
});

it('disposes a late successful registration and ignores a late failure', async () => {
	let finish!: (value: { url: string }) => void;
	adapter.registerCustomHtml.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			})
	);
	const view = render(<CustomHtmlHost />);
	view.unmount();
	await act(async () => finish({ url: 'http://customhtml.localhost/late' }));
	expect(adapter.releaseCustomHtml).toHaveBeenCalledTimes(2);
	let fail!: (error: Error) => void;
	adapter.registerCustomHtml.mockImplementation(
		() =>
			new Promise((_resolve, reject) => {
				fail = reject;
			})
	);
	const next = render(<CustomHtmlHost />);
	next.unmount();
	await act(async () => fail(new Error('late')));
});

it('reports registration failure and releases old documents when source changes', async () => {
	adapter.registerCustomHtml.mockRejectedValue(new Error('unavailable'));
	const view = render(<CustomHtmlHost html="old" />);
	await act(async () => undefined);
	expect(screen.getByRole('status')).toHaveTextContent('Custom HTML unavailable');
	adapter.registerCustomHtml.mockResolvedValue({ srcDoc: '<main>new</main>' });
	view.rerender(
		<CustomHtmlHost html="new" css="main{}" javascript="console.log(1)" title="New" interact />
	);
	await act(async () => undefined);
	expect(screen.getByTitle('New')).toHaveAttribute('srcdoc', '<main>new</main>');
	expect(adapter.releaseCustomHtml).toHaveBeenCalledTimes(1);
});
