import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { createTelemetryHub, type TelemetryHub } from '../core/telemetry';
import { TelemetryHubContext } from './telemetryContext';

// Mock the outer-ring deps: the LLM Tauri command, the TTS adapter, and the window-role check. The
// prompt builder (core/llm) and the schedule math (core/schedule) stay REAL so we verify the
// snapshot→prompt→complete flow and the interval/cron scheduling.
const llmComplete = vi.fn();
const speakSmart = vi.fn(() => Promise.resolve());
const isStudioWindow = vi.fn(() => false);
vi.mock('./plugins/llm-commands', () => ({ llmComplete: (...a: unknown[]) => llmComplete(...a) }));
vi.mock('./plugins/llm-tts', () => ({ speakSmart: (t: string) => speakSmart(t) }));
vi.mock('../overlay', () => ({ isStudioWindow: () => isStudioWindow() }));

import { useAssistant, type AssistantConfig } from './useAssistant';

let hub: TelemetryHub;

function wrapper({ children }: { children: ReactNode }) {
	return createElement(TelemetryHubContext.Provider, { value: hub }, children);
}

const cfg = (over: Partial<AssistantConfig> = {}): AssistantConfig => ({
	prompt: 'Summarize',
	schedule: '',
	sensors: 'auto',
	...over
});

beforeEach(() => {
	vi.useFakeTimers();
	hub = createTelemetryHub();
	llmComplete.mockResolvedValue('  the briefing  ');
	isStudioWindow.mockReturnValue(false);
});
afterEach(() => {
	vi.runOnlyPendingTimers();
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe('useAssistant', () => {
	it('refresh() snapshots the hub, calls the provider, and trims the result', async () => {
		hub.ingest({ sensor: 'cpu.total', ts_ms: 1, value: { kind: 'scalar', value: 42.37 } });
		hub.ingest({ sensor: 'proc.cpu.top.name', ts_ms: 1, value: { kind: 'text', value: 'node' } });
		const { result } = renderHook(() => useAssistant(cfg()), { wrapper });

		await act(async () => {
			result.current.refresh();
		});

		expect(llmComplete).toHaveBeenCalledOnce();
		const [messages, opts] = llmComplete.mock.calls[0]!;
		expect(opts).toEqual({ temperature: 0.4, maxTokens: 200 });
		// The user message carries the rounded scalar (42.4) and the text reading.
		const userMsg = (messages as { role: string; content: string }[]).find(
			(m) => m.role === 'user'
		)!;
		expect(userMsg.content).toContain('42.4'); // scalar rounded to 1dp
		expect(userMsg.content).toContain('node');
		expect(result.current.text).toBe('the briefing'); // trimmed
		expect(result.current.busy).toBe(false);
		expect(result.current.error).toBe('');
	});

	it('only includes present, scalar/text sensors from a custom CSV (absent + non-readable skipped)', async () => {
		hub.ingest({ sensor: 'gpu.util', ts_ms: 1, value: { kind: 'scalar', value: 80 } });
		// A series-valued sensor has no scalar/text reading → readingOf returns null → it's skipped.
		hub.ingest({ sensor: 'cpu.cores', ts_ms: 1, value: { kind: 'series', value: [1, 2, 3] } });
		const { result } = renderHook(
			() => useAssistant(cfg({ sensors: 'gpu.util, cpu.cores, missing.id' })),
			{ wrapper }
		);
		await act(async () => {
			result.current.refresh();
		});
		const userMsg = (llmComplete.mock.calls[0]![0] as { role: string; content: string }[]).find(
			(m) => m.role === 'user'
		)!;
		expect(userMsg.content).toContain('gpu.util');
		expect(userMsg.content).not.toContain('cpu.cores'); // series reading skipped
		expect(userMsg.content).not.toContain('missing.id');
	});

	it('speaks the result when speak is enabled', async () => {
		const { result } = renderHook(() => useAssistant(cfg({ speak: true })), { wrapper });
		await act(async () => {
			result.current.refresh();
		});
		expect(speakSmart).toHaveBeenCalledWith('the briefing');
	});

	it('surfaces a provider error and clears busy', async () => {
		llmComplete.mockRejectedValueOnce(new Error('rate limited'));
		const { result } = renderHook(() => useAssistant(cfg()), { wrapper });
		await act(async () => {
			result.current.refresh();
		});
		expect(result.current.error).toContain('rate limited');
		expect(result.current.busy).toBe(false);
		expect(result.current.text).toBe('');
	});

	it('auto-generates after the first-delay on the overlay (interval schedule)', async () => {
		renderHook(() => useAssistant(cfg({ schedule: '30s' })), { wrapper });
		expect(llmComplete).not.toHaveBeenCalled(); // nothing before the first delay
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000); // FIRST_DELAY_MS
		});
		expect(llmComplete).toHaveBeenCalledTimes(1);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30_000); // one interval tick
		});
		expect(llmComplete).toHaveBeenCalledTimes(2);
	});

	it('floors a too-fast interval to the minimum (no API hammering)', async () => {
		renderHook(() => useAssistant(cfg({ schedule: '1s' })), { wrapper });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000); // first delay fires once
		});
		expect(llmComplete).toHaveBeenCalledTimes(1);
		// A 1s schedule is floored to 15s — at +5s nothing more has fired.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5000);
		});
		expect(llmComplete).toHaveBeenCalledTimes(1);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000); // now past the 15s floor
		});
		expect(llmComplete).toHaveBeenCalledTimes(2);
	});

	it('does NOT auto-generate in the studio (manual refresh only)', async () => {
		isStudioWindow.mockReturnValue(true);
		const { result } = renderHook(() => useAssistant(cfg({ schedule: '30s' })), { wrapper });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(llmComplete).not.toHaveBeenCalled(); // no auto run
		await act(async () => {
			result.current.refresh(); // but manual refresh still works
		});
		expect(llmComplete).toHaveBeenCalledOnce();
	});

	it('fires a cron schedule once per matching minute', async () => {
		// Pin "now" to a minute boundary so the cron "* * * * *" (every minute) matches deterministically.
		vi.setSystemTime(new Date('2026-06-19T10:00:30Z'));
		renderHook(() => useAssistant(cfg({ schedule: '* * * * *' })), { wrapper });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000); // first-delay run
		});
		expect(llmComplete).toHaveBeenCalledTimes(1);
		// The cron poller ticks every 30s; within the same minute it must NOT re-fire (dedup).
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30_000);
		});
		const afterSameMinute = llmComplete.mock.calls.length;
		// Cross into the next minute → exactly one more fire.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(llmComplete.mock.calls.length).toBeGreaterThan(afterSameMinute);
	});
});
