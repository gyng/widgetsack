import { createCalendarProcessor } from './processor';
const processor = createCalendarProcessor(
	() => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
);
export const requestCalendar = processor.request;
