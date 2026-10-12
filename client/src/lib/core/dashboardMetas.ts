import type { WidgetMeta } from './widget';
import { alertRules, boundedNumber } from './dashboard';
export const dashboardMetas: WidgetMeta[] = [
	{
		type: 'alerts',
		label: 'Status / Alerts',
		category: 'Tools',
		binds: 'none',
		interactive: true,
		defaultSize: { w: 320, h: 150 },
		description:
			'Show sensor threshold alerts only when attention is needed; snooze individual alerts.',
		defaultConfig: {
			label: 'Needs attention',
			rules:
				'cpu.total|above|90|CPU busy;mem.used|above|90|Memory nearly full;disk.c.used.pct|above|90|Disk C nearly full',
			snoozeMin: 15,
			meetingMinutes: 10
		},
		configFields: [
			{
				key: 'label',
				label: 'heading',
				kind: 'text',
				group: 'Data',
				help: 'Heading above active alerts.'
			},
			{
				key: 'rules',
				label: 'alert rules',
				kind: 'text',
				group: 'Data',
				help: 'Separate rules with semicolons: sensor|above/below|threshold|message. Thresholds are inclusive; missing readings do not alert.'
			},
			{
				key: 'snoozeMin',
				label: 'snooze minutes',
				kind: 'number',
				group: 'Data',
				min: 1,
				max: 1440,
				help: 'Hide an individual alert for this many minutes.'
			},
			{
				key: 'meetingMinutes',
				label: 'meeting reminder (minutes)',
				kind: 'number',
				group: 'Data',
				min: 0,
				max: 120,
				help: 'Show upcoming timed events from the configured Agenda feed; 0 disables reminders.'
			}
		],
		sensors: (c) =>
			Object.fromEntries([
				...alertRules(String(c.rules ?? '')).map((r) => [r.sensor, r.sensor]),
				...(boundedNumber(c.meetingMinutes, 10, 0, 120) > 0 ? [['agenda.list', 'agenda.list']] : [])
			])
	},
	{
		type: 'servicehealth',
		label: 'Service Health',
		category: 'System',
		binds: 'none',
		defaultSize: { w: 260, h: 85 },
		description:
			'HTTP/HTTPS endpoint status, latency, and certificate expiry. Checks pause while hidden.',
		defaultConfig: { label: 'Service health', url: '', interval: 60, slowMs: 1000, warnDays: 14 },
		configFields: [
			{
				key: 'label',
				label: 'heading',
				kind: 'text',
				group: 'Data',
				help: 'Name of the service being monitored.'
			},
			{
				key: 'url',
				label: 'endpoint URL',
				kind: 'text',
				group: 'Data',
				help: 'HTTP or HTTPS health endpoint. Tries HEAD, then GET if unsupported; reads headers only and reports redirects without following them.'
			},
			{
				key: 'interval',
				label: 'check interval (seconds)',
				kind: 'number',
				group: 'Data',
				min: 15,
				max: 3600,
				help: 'Seconds between checks; requests time out after 10 seconds.'
			},
			{
				key: 'slowMs',
				label: 'slow threshold (ms)',
				kind: 'number',
				group: 'Data',
				min: 1,
				help: 'Mark responses at or above this latency as slow.'
			},
			{
				key: 'warnDays',
				label: 'certificate warning (days)',
				kind: 'number',
				group: 'Data',
				min: 0,
				help: 'Warn when the HTTPS certificate expires within this many days. Unavailable for plain HTTP.'
			}
		]
	},
	{
		type: 'audiomixer',
		label: 'App Audio / Microphone',
		category: 'Tools',
		binds: 'none',
		interactive: true,
		defaultSize: { w: 340, h: 200 },
		description:
			'Independent app-session volume and mute, plus default communications microphone mute.',
		defaultConfig: { showMicrophone: true },
		configFields: [
			{
				key: 'showMicrophone',
				label: 'microphone control',
				kind: 'toggle',
				group: 'Appearance',
				help: 'Show mute status and a toggle for the default communications microphone.'
			}
		]
	},
	{
		type: 'checklist',
		label: 'Task Checklist',
		category: 'Tools',
		binds: 'none',
		interactive: true,
		defaultSize: { w: 270, h: 200 },
		description:
			'Persistent task list with checkboxes and add/remove controls; syncs across studio and overlay.',
		defaultConfig: { label: 'Today' },
		configFields: [
			{
				key: 'label',
				label: 'heading',
				kind: 'text',
				group: 'Data',
				help: 'Heading above your tasks and completed count.'
			}
		]
	},
	{
		type: 'history',
		label: 'Sensor History',
		category: 'Meters',
		binds: 'none',
		defaultSize: { w: 360, h: 150 },
		description:
			'Compare sensor histories on one scale, with a threshold band and min/average/max summaries.',
		defaultConfig: {
			label: 'History',
			sensorIds: 'cpu.total,gpu.util',
			seconds: 60,
			fixedScale: true,
			min: 0,
			max: 100,
			showThreshold: false,
			threshold: 80,
			showStats: true
		},
		configFields: [
			{
				key: 'label',
				label: 'heading',
				kind: 'text',
				group: 'Data',
				help: 'Heading above the comparison chart.'
			},
			{
				key: 'sensorIds',
				label: 'sensor IDs',
				kind: 'text',
				group: 'Data',
				help: 'Comma-separated numeric sensor IDs. Compare sensors with the same units.'
			},
			{
				key: 'seconds',
				label: 'history samples',
				kind: 'number',
				group: 'Data',
				min: 5,
				max: 600,
				help: 'Number of recent samples to display (roughly seconds for 1 Hz system sensors).'
			},
			{
				key: 'fixedScale',
				label: 'fixed scale',
				kind: 'toggle',
				group: 'Appearance',
				help: 'Pin the shared range instead of automatically scaling all lines together.'
			},
			{
				key: 'min',
				label: 'minimum',
				kind: 'number',
				group: 'Data',
				help: 'Bottom of the fixed chart scale.'
			},
			{
				key: 'max',
				label: 'maximum',
				kind: 'number',
				group: 'Data',
				help: 'Top of the fixed chart scale.'
			},
			{
				key: 'showThreshold',
				label: 'threshold band',
				kind: 'toggle',
				group: 'Appearance',
				help: 'Shade the area at or above the threshold.'
			},
			{
				key: 'threshold',
				label: 'threshold',
				kind: 'number',
				group: 'Data',
				help: 'Beginning of the shaded warning band.'
			},
			{
				key: 'showStats',
				label: 'min / average / max',
				kind: 'toggle',
				group: 'Appearance',
				help: 'Show summaries of each visible history window in the legend.'
			}
		],
		sensors: (c) =>
			Object.fromEntries(
				String(c.sensorIds ?? '')
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean)
					.slice(0, 8)
					.map((s) => [s, s])
			)
	}
];
