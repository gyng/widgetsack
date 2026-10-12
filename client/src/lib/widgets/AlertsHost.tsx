import { useState } from 'react';
import type { SensorState } from '../core/telemetry';
import { activeAlerts, alertRules, meetingAlerts, boundedNumber } from '../core/dashboard';
import Alerts from './meters/Alerts';
import { useNow } from './useNow';
export default function AlertsHost({
	rules = '',
	label = 'Needs attention',
	snoozeMin = 15,
	meetingMinutes = 10,
	sensors = {},
	editMode = false,
	previewMode = false
}: {
	rules?: unknown;
	label?: string;
	snoozeMin?: number;
	meetingMinutes?: number;
	sensors?: Record<string, SensorState>;
	editMode?: boolean;
	previewMode?: boolean;
}) {
	const [snoozes, setSnoozes] = useState<Record<string, number>>({});
	const now = useNow(1000);
	const parsed = alertRules(String(rules ?? ''));
	const snoozeMinutes = boundedNumber(snoozeMin, 15, 1, 1440);
	const meetings = meetingAlerts(
		sensors['agenda.list'],
		now,
		boundedNumber(meetingMinutes, 10, 0, 120)
	).filter((a) => (snoozes[a.id] ?? 0) <= now);
	return (
		<Alerts
			alerts={[...activeAlerts(parsed, sensors, snoozes, now), ...meetings]}
			label={label}
			snoozeMin={snoozeMinutes}
			editMode={editMode || previewMode}
			onSnooze={(id) => setSnoozes((s) => ({ ...s, [id]: Date.now() + snoozeMinutes * 60000 }))}
		/>
	);
}
