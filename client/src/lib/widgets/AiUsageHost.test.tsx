import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AiUsageHost from './AiUsageHost';
import { readAiUsage } from './plugins/ai-usage-commands';
import { approveUsageCommand, saveUsageHistory } from './plugins/ai-usage-source';
import { usageProviders } from '../core/aiUsage';
vi.mock('./plugins/ai-usage-commands', () => ({ readAiUsage: vi.fn() }));
const snapshot = {
	version: 1 as const,
	metrics: [
		{
			id: 'q',
			label: 'Weekly',
			kind: 'quota' as const,
			used: 42,
			unit: '%',
			period: 'week',
			scope: 'account',
			limit: 100
		}
	]
};
beforeEach(() => {
	vi.useFakeTimers();
	localStorage.clear();
	vi.mocked(readAiUsage).mockReset().mockResolvedValue(snapshot);
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
});
describe('AI usage refresh lifetime', () => {
	it('uses the default cadence for invalid intervals', async () => {
		render(<AiUsageHost providers={[{ source: 'codex' }]} interval={0} />);
		await act(async () => {});
		await act(async () => vi.advanceTimersByTimeAsync(900000));
		expect(readAiUsage).toHaveBeenCalledTimes(2);
	});
	it('restores history and ignores late errors after disposal', async () => {
		const p = usageProviders([{ source: 'codex' }])[0];
		saveUsageHistory(p, snapshot, Date.now() - 60000);
		let reject!: (error: Error) => void;
		vi.mocked(readAiUsage).mockReturnValueOnce(
			new Promise((_resolve, fail) => {
				reject = fail;
			})
		);
		const view = render(
			<AiUsageHost providers={[p, { ...p, id: 'disabled', enabled: false }]} interval={0} />
		);
		expect(screen.getByText('58%')).toBeVisible();
		view.unmount();
		await act(async () => reject(new Error('Disposed')));
	});
	it('polls defaults, preserves last success on failure, and stops on disposal', async () => {
		const view = render(<AiUsageHost interval={60} />);
		await act(async () => {});
		expect(readAiUsage).toHaveBeenCalledTimes(2);
		expect(screen.getAllByText('58%')).toHaveLength(2);
		vi.mocked(readAiUsage).mockRejectedValue(new Error('Offline'));
		await act(async () => vi.advanceTimersByTimeAsync(60000));
		expect(screen.getAllByText('Stale')).toHaveLength(2);
		expect(screen.getAllByText('58%')).toHaveLength(2);
		view.unmount();
		await act(async () => vi.advanceTimersByTimeAsync(60000));
		expect(readAiUsage).toHaveBeenCalledTimes(4);
	});
	it('does not execute imported commands until local activation', async () => {
		const providers = usageProviders([
			{ source: 'command', id: 'custom', command: 'Get-Usage', label: 'Custom' }
		]);
		render(<AiUsageHost providers={providers} />);
		await act(async () => {});
		expect(readAiUsage).not.toHaveBeenCalled();
		expect(screen.getByText(/Activate this command/)).toBeVisible();
		await act(async () => approveUsageCommand(providers[0]));
		expect(readAiUsage).toHaveBeenCalledTimes(1);
	});
	it('ignores late responses from an old provider and prevents overlapping polls', async () => {
		let finish!: (value: typeof snapshot) => void;
		vi.mocked(readAiUsage).mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			})
		);
		const view = render(<AiUsageHost providers={[{ source: 'codex' }]} />);
		await act(async () => {
			window.dispatchEvent(new Event('aiusage:approval'));
		});
		expect(readAiUsage).toHaveBeenCalledTimes(1);
		view.rerender(<AiUsageHost providers={[{ source: 'claude' }]} />);
		await act(async () => {});
		await act(async () => finish({ ...snapshot, metrics: [{ ...snapshot.metrics[0], used: 99 }] }));
		expect(screen.queryByText('99%')).toBeNull();
		expect(screen.getByText('58%')).toBeVisible();
	});
	it('pauses while hidden and resumes without parallel requests', async () => {
		const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
		render(<AiUsageHost providers={[]} />);
		expect(readAiUsage).not.toHaveBeenCalled();
		visibility.mockReturnValue('visible');
		await act(async () => document.dispatchEvent(new Event('visibilitychange')));
		expect(readAiUsage).not.toHaveBeenCalled();
	});
});

it('keeps the 15-minute cadence across presentation edits and visibility changes', async () => {
	const p = usageProviders([{ source: 'codex' }])[0];
	const view = render(<AiUsageHost providers={[p]} />);
	await act(async () => {});
	expect(readAiUsage).toHaveBeenCalledTimes(1);
	view.rerender(
		<AiUsageHost
			providers={[{ ...p, label: 'Work', week: false, order: [...p.order].reverse() }]}
		/>
	);
	await act(async () => {});
	expect(readAiUsage).toHaveBeenCalledTimes(1);
	await act(async () => document.dispatchEvent(new Event('visibilitychange')));
	expect(readAiUsage).toHaveBeenCalledTimes(1);
	await act(async () => vi.advanceTimersByTimeAsync(900000));
	expect(readAiUsage).toHaveBeenCalledTimes(2);
});
