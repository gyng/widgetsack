import type { Sack } from './sack';
import type { LayoutNode } from './layoutTree';
import { createWidget, NOWPLAYING_DEFAULT_CSS } from './widget';
import { LOCAL_DESKTOP_PRESET_NAME, LOCAL_DESKTOP_SACK } from './localDesktop';

function dashboard(
	name: string,
	accent: string,
	widgets: { type: string; config?: Record<string, unknown>; sensor?: string; height: number }[]
): Sack {
	const children: LayoutNode[] = widgets.map((w, i) => {
		const id = `dashboard-${name.toLowerCase()}-${i}`;
		const unit = createWidget(w.type, id);
		unit.rect = { x: 0, y: 0, w: 360, h: w.height };
		unit.config = { ...unit.config, ...w.config };
		if (w.sensor) unit.sensor = w.sensor;
		if (w.type === 'nowplaying')
			unit.css = `${NOWPLAYING_DEFAULT_CSS}
.np-title { font-size: 19px; font-weight: 600; line-height: 1.25; margin-top: 4px; }
.np-artist { font-size: 15px; line-height: 1.3; margin-bottom: 0; opacity: 0.72; }`;
		return { id, unit, basis: w.height, halign: 'fill' };
	});
	return {
		kind: 'widgetsack/sack',
		version: 1,
		name,
		tokens: { '--np-accent': accent, '--np-fg': '#e9eef3', '--np-bg': '#17202b' },
		library: {
			version: 1,
			defs: [
				{
					id: `dashboard-${name.toLowerCase()}`,
					name: `${name} dashboard`,
					size: { w: 392, h: widgets.reduce((h, w) => h + w.height + 12, 20) },
					child: {
						id: `dashboard-${name.toLowerCase()}-root`,
						kind: 'col',
						pad: 16,
						gap: 12,
						children
					},
					css: '&[data-group=""] { width: 392px; max-width: 100%; background: rgba(20, 28, 40, .88); box-shadow: inset 0 0 0 1px var(--np-accent); border-radius: 14px; }'
				}
			]
		}
	};
}

/** Built-in sacks share the exact import path used by user-exported sacks; no files are overwritten. */
export const DASHBOARD_SACKS: Record<string, Sack> = {
	[LOCAL_DESKTOP_PRESET_NAME]: LOCAL_DESKTOP_SACK,
	'Built-in: Work': dashboard('Work', '#77c4d3', [
		{ type: 'clock', height: 42, config: { format: 'ddd D MMM · HH:mm' } },
		{ type: 'agenda', height: 160, config: { maxRows: 2 } },
		{ type: 'checklist', height: 180 },
		{ type: 'timer', height: 70 },
		{ type: 'alerts', height: 90 }
	]),
	'Built-in: Gaming': dashboard('Gaming', '#c5a3ff', [
		{ type: 'history', height: 150, config: { label: 'CPU / GPU', showThreshold: true } },
		{ type: 'gpu', height: 96 },
		{ type: 'ping', height: 30 },
		{ type: 'nowplaying', height: 120 }
	]),
	'Built-in: Home': dashboard('Home', '#9bd385', [
		{ type: 'clock', height: 42, config: { format: 'dddd · HH:mm' } },
		{ type: 'weather', height: 100 },
		{ type: 'agenda', height: 160, config: { maxRows: 2 } },
		{ type: 'servicehealth', height: 85, config: { label: 'Home Assistant', url: '' } },
		{ type: 'checklist', height: 150, config: { label: 'Home tasks' } }
	]),
	'Built-in: Minimal': dashboard('Minimal', '#ffbc77', [
		{ type: 'clock', height: 42, config: { format: 'HH:mm' } },
		{ type: 'text', height: 24, sensor: 'net.down', config: { label: '↓', format: 'rate' } },
		{
			type: 'history',
			height: 100,
			config: { sensorIds: 'cpu.total', showStats: false, label: 'CPU' }
		},
		{ type: 'alerts', height: 60 }
	])
};
