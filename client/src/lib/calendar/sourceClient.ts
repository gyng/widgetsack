import type { TelemetryHub } from '../core/telemetry';
import { subscribeNow } from '../widgets/useNow';
import { requestCalendar } from './workerClient';
import { startAgendaExpansion } from './expansion';
export const installAgendaExpansion = (hub: TelemetryHub) =>
	startAgendaExpansion(hub, {
		request: requestCalendar,
		subscribeClock: (listener) => subscribeNow(60000, listener),
		now: Date.now
	});
