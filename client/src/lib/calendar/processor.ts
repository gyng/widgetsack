import { parseAgendaList } from '../core/agenda';
import { CALENDAR_WINDOW_MS, type CalendarResult } from '../core/calendarFeedContract';
export type CalendarWorker = Pick<Worker, 'onmessage' | 'onerror' | 'postMessage' | 'terminate'>;
export type CalendarRequest = { promise: Promise<CalendarResult>; release: () => void };
const FAILED: CalendarResult = { events: [], warnings: ['The calendar could not be read.'] };
export const CALENDAR_TIMEOUT_MS = 5000;
type Job = {
	calendar: string;
	bucket: number;
	clients: number;
	worker: CalendarWorker;
	done: boolean;
	promise: Promise<CalendarResult>;
	resolve: (result: CalendarResult) => void;
	timer: ReturnType<typeof setTimeout>;
};

/** One processor per window: concurrent consumers share a job and its completed snapshot.
 * A changed source cancels old work. Releasing the last client disposes pending work. */
export function createCalendarProcessor(makeWorker: () => CalendarWorker) {
	let current: Job | null = null;
	let cache: { calendar: string; bucket: number; result: CalendarResult } | null = null;
	const finish = (job: Job, result: CalendarResult, remember: boolean) => {
		if (job.done) return;
		job.done = true;
		clearTimeout(job.timer);
		job.worker.onmessage = null;
		job.worker.onerror = null;
		job.worker.terminate();
		current = null;
		if (remember) cache = { calendar: job.calendar, bucket: job.bucket, result };
		job.resolve(result);
	};
	const lease = (job: Job): CalendarRequest => {
		job.clients++;
		let released = false;
		return {
			promise: job.promise,
			release: () => {
				if (released) return;
				released = true;
				if (--job.clients === 0 && !job.done) finish(job, { events: [], warnings: [] }, false);
			}
		};
	};
	const request = (calendar: string, now: number): CalendarRequest => {
		const bucket = Math.floor(now / CALENDAR_WINDOW_MS) * CALENDAR_WINDOW_MS;
		if (cache?.calendar === calendar && cache.bucket === bucket)
			return { promise: Promise.resolve(cache.result), release: () => undefined };
		if (current?.calendar === calendar && current.bucket === bucket) return lease(current);
		if (current) finish(current, { events: [], warnings: [] }, false);
		let worker: CalendarWorker;
		try {
			worker = makeWorker();
		} catch {
			return { promise: Promise.resolve(FAILED), release: () => undefined };
		}
		let resolve!: (result: CalendarResult) => void;
		const promise = new Promise<CalendarResult>((done) => {
			resolve = done;
		});
		const job: Job = {
			calendar,
			bucket,
			clients: 0,
			worker,
			done: false,
			promise,
			resolve,
			timer: setTimeout(
				() => finish(job, { events: [], warnings: ['Calendar processing took too long.'] }, false),
				CALENDAR_TIMEOUT_MS
			)
		};
		current = job;
		worker.onmessage = ({ data }: MessageEvent<unknown>) => {
			if (!data || typeof data !== 'object') {
				finish(job, FAILED, false);
				return;
			}
			const result = data as Record<string, unknown>;
			if (
				!Array.isArray(result.events) ||
				!Array.isArray(result.warnings) ||
				!result.warnings.every((warning) => typeof warning === 'string')
			) {
				finish(job, FAILED, false);
				return;
			}
			finish(
				job,
				{ events: parseAgendaList(result.events), warnings: result.warnings as string[] },
				true
			);
		};
		worker.onerror = (event) => {
			event.preventDefault();
			finish(job, FAILED, false);
		};

		const result = lease(job);
		try {
			worker.postMessage({ calendar, now: bucket });
		} catch {
			finish(job, FAILED, false);
		}
		return result;
	};
	return { request };
}
