import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ServiceHealthHost from './ServiceHealthHost';
import { checkServiceHealth } from './plugins/service-health-commands';
vi.mock('./plugins/service-health-commands', () => ({ checkServiceHealth: vi.fn() }));
const good = { status: 200, latencyMs: 42, certificateDays: null, error: null };
beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(checkServiceHealth).mockReset().mockResolvedValue(good);
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});
describe('service polling lifetime', () => {
	it('treats malformed or blank URLs as unconfigured and trims valid targets', async () => {
		const view = render(<ServiceHealthHost url={null} />);
		expect(screen.getByText(/Set an HTTP/)).toBeVisible();
		view.rerender(<ServiceHealthHost url={123} />);
		view.rerender(<ServiceHealthHost url="   " />);
		expect(checkServiceHealth).not.toHaveBeenCalled();
		await act(async () => view.rerender(<ServiceHealthHost url=" https://nas " />));
		expect(checkServiceHealth).toHaveBeenCalledWith('https://nas');
	});
	it('does not resurrect an earlier result when returning to a previously checked URL', async () => {
		const view = render(<ServiceHealthHost url="https://one" />);
		await act(async () => {});
		expect(screen.getByText(/up · 200/)).toBeVisible();
		const pending: ((value: typeof good) => void)[] = [];
		vi.mocked(checkServiceHealth).mockImplementation(
			() =>
				new Promise((r) => {
					pending.push(r);
				})
		);
		view.rerender(<ServiceHealthHost url="https://two" />);
		view.rerender(<ServiceHealthHost url="https://one" />);
		expect(screen.getByText('Checking…')).toBeVisible();
		expect(screen.queryByText(/up · 200/)).toBeNull();
		await act(async () => pending.forEach((finish) => finish(good)));
	});
	it('ignores a rejected request belonging to a disposed target', async () => {
		let reject!: (e: Error) => void;
		vi.mocked(checkServiceHealth).mockReturnValueOnce(
			new Promise((_r, rej) => {
				reject = rej;
			})
		);
		const view = render(<ServiceHealthHost url="https://old" />);
		view.unmount();
		await act(async () => reject(new Error('stale')));
		expect(screen.queryByRole('alert')).toBeNull();
	});
	it('does not check unconfigured endpoints and polls without overlaps', async () => {
		const { rerender } = render(<ServiceHealthHost />);
		expect(checkServiceHealth).not.toHaveBeenCalled();
		await act(async () => rerender(<ServiceHealthHost url="https://nas" interval={1} />));
		expect(screen.getByText(/up · 200 · 42 ms/)).toBeVisible();
		await act(async () => vi.advanceTimersByTimeAsync(15000));
		expect(checkServiceHealth).toHaveBeenCalledTimes(2);
	});
	it('rejects stale responses after the target changes or the widget unmounts', async () => {
		let finish!: (v: typeof good) => void;
		vi.mocked(checkServiceHealth).mockReturnValueOnce(
			new Promise((r) => {
				finish = r;
			})
		);
		const { rerender, unmount } = render(<ServiceHealthHost url="https://old" />);
		await act(async () => vi.advanceTimersByTimeAsync(60000));
		expect(checkServiceHealth).toHaveBeenCalledTimes(1);
		await act(async () => rerender(<ServiceHealthHost url="https://new" />));
		await act(async () => finish({ ...good, status: 500 }));
		expect(screen.queryByText(/500/)).toBeNull();
		unmount();
		await act(async () => vi.advanceTimersByTimeAsync(120000));
		expect(checkServiceHealth).toHaveBeenCalledTimes(2);
	});
	it('reports failures and suspends checks while hidden', async () => {
		vi.mocked(checkServiceHealth).mockRejectedValueOnce(new Error('timeout'));
		await act(async () => {
			render(<ServiceHealthHost url="http://nas" />);
		});
		expect(screen.getByRole('alert')).toHaveTextContent('timeout');
		const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
		act(() => document.dispatchEvent(new Event('visibilitychange')));
		await act(async () => vi.advanceTimersByTimeAsync(60000));
		expect(checkServiceHealth).toHaveBeenCalledTimes(1);
		hidden.mockReturnValue('visible');
		await act(async () => document.dispatchEvent(new Event('visibilitychange')));
		expect(checkServiceHealth).toHaveBeenCalledTimes(2);
	});
});
