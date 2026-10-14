import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCalendarProcessor, CALENDAR_TIMEOUT_MS, type CalendarWorker } from './processor';
afterEach(() => vi.useRealTimers());
const result = {
	events: [{ summary: 'Call', start: '2026-10-14T09:00:00Z', allDay: false, location: '' }],
	warnings: []
};
function fixture() {
	const worker: CalendarWorker = {
		onmessage: null,
		onerror: null,
		postMessage: vi.fn(),
		terminate: vi.fn()
	};
	const factory = vi.fn(() => worker);
	const processor = createCalendarProcessor(factory);
	const message = (data: unknown) =>
		worker.onmessage?.call(worker as Worker, new MessageEvent('message', { data }));
	return { worker, factory, processor, message };
}
describe('calendar worker lifecycle', () => {
	it('shares pending work, caches the result, and releases idempotently', async () => {
		const { worker, factory, processor, message } = fixture();
		const a = processor.request('calendar', 1),
			b = processor.request('calendar', 2);
		expect(factory).toHaveBeenCalledTimes(1);
		expect(worker.postMessage).toHaveBeenCalledWith({ calendar: 'calendar', now: 0 });
		a.release();
		a.release();
		expect(worker.terminate).not.toHaveBeenCalled();
		message(result);
		expect(await b.promise).toEqual(result);
		b.release();
		expect(worker.terminate).toHaveBeenCalledTimes(1);
		const cached = processor.request('calendar', 5);
		expect(await cached.promise).toEqual(result);
		cached.release();
		expect(factory).toHaveBeenCalledTimes(1);
	});
	it('terminates pending work when the last client leaves', async () => {
		const { worker, processor } = fixture();
		const a = processor.request('calendar', 1);
		a.release();
		expect(worker.terminate).toHaveBeenCalledTimes(1);
		expect(await a.promise).toEqual({ events: [], warnings: [] });
	});
	it('ignores a late result from a superseded source and refreshes on a new minute', async () => {
		const { worker, factory, processor, message } = fixture();
		const old = processor.request('old', 1);
		const late = worker.onmessage!;
		const next = processor.request('new', 1);
		late.call(worker as Worker, new MessageEvent('message', { data: result }));
		expect(await old.promise).toEqual({ events: [], warnings: [] });
		message(result);
		expect(await next.promise).toEqual(result);
		const refreshed = processor.request('new', 60000);
		expect(factory).toHaveBeenCalledTimes(3);
		refreshed.release();
	});
	it.each([
		null,
		{ events: {}, warnings: [] },
		{ events: [], warnings: {} },
		{ events: [], warnings: [42] }
	])('rejects malformed worker messages: %j', async (data) => {
		const { processor, message } = fixture();
		const request = processor.request('bad', 1);
		message(data);
		expect((await request.promise).warnings).toEqual(['The calendar could not be read.']);
	});
	it('stops a stuck worker and permits a retry', async () => {
		vi.useFakeTimers();
		const { processor, worker, factory } = fixture();
		const request = processor.request('slow', 1);
		vi.advanceTimersByTime(CALENDAR_TIMEOUT_MS);
		expect((await request.promise).warnings).toEqual(['Calendar processing took too long.']);
		expect(worker.terminate).toHaveBeenCalledTimes(1);
		const retry = processor.request('slow', 1);
		expect(factory).toHaveBeenCalledTimes(2);
		retry.release();
	});
	it('reports worker construction, dispatch, and execution failures without rejecting callers', async () => {
		const broken = createCalendarProcessor(() => {
			throw new Error('unavailable');
		});
		const failed = broken.request('a', 1);
		expect((await failed.promise).warnings.length).toBe(1);
		failed.release();
		const { processor, worker } = fixture();
		vi.mocked(worker.postMessage).mockImplementationOnce(() => {
			throw new Error('closed');
		});
		expect((await processor.request('a', 1).promise).warnings.length).toBe(1);
		const request = processor.request('a', 1);
		const event = new ErrorEvent('error', { cancelable: true });
		worker.onerror!.call(worker as Worker, event);
		expect(event.defaultPrevented).toBe(true);
		expect((await request.promise).warnings.length).toBe(1);
	});
});
