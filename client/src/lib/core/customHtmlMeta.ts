import type { WidgetMeta } from './widget';
import { customHtmlSensors } from './customHtml';

export const customHtmlMeta: WidgetMeta = {
	type: 'customhtml',
	label: 'Custom HTML',
	category: 'Utility',
	binds: 'none',
	// Eligible for overlay hit testing; the meter's sentinel keeps decorative mode click-through.
	interactive: true,
	description:
		'Build a portable isolated widget with HTML, CSS, JavaScript, theme tokens and selected sensors.',
	defaultSize: { w: 320, h: 100 },
	defaultConfig: {
		title: 'Custom HTML widget',
		html: '<main><span>CPU</span><strong id="value">—</strong></main>',
		css: 'main { height: 100%; display: flex; align-items: center; gap: var(--np-row-gap); } span { color: var(--np-label); } strong { color: var(--np-fg); font-size: var(--np-text-heading); font-variant-numeric: tabular-nums; }',
		javascript:
			"widgetsack.subscribe(({ sensors }) => { const value = sensors['cpu.total']?.value; document.querySelector('#value').textContent = value?.kind === 'scalar' ? Math.round(value.value) + '%' : '—'; });",
		sensorIds: 'cpu.total',
		interact: false
	},
	sensors: (config) => customHtmlSensors(String(config.sensorIds ?? '')),
	configFields: [
		{ key: 'title', label: 'Title', kind: 'text', group: 'Data', help: 'Accessible frame title.' },
		{
			key: 'html',
			label: 'HTML',
			kind: 'text',
			multiline: true,
			group: 'Data',
			help: 'Body markup, saved with the widget. Inline data images and SVG are supported.'
		},
		{
			key: 'css',
			label: 'CSS',
			kind: 'text',
			multiline: true,
			group: 'Appearance',
			help: 'Document styles. Use inherited --np-* theme tokens for a consistent look.'
		},
		{
			key: 'javascript',
			label: 'JavaScript',
			kind: 'text',
			multiline: true,
			group: 'Behaviour',
			help: 'Isolated module. Use widgetsack.subscribe(state => …) for selected sensors, theme tokens and viewport size.'
		},
		{
			key: 'sensorIds',
			label: 'Sensor IDs',
			kind: 'text',
			group: 'Data',
			help: 'Comma or newline separated sensor IDs; only these sensors are exposed (maximum 32).'
		},
		{
			key: 'interact',
			label: 'Interactive',
			kind: 'toggle',
			group: 'Behaviour',
			help: 'Catch mouse clicks in the overlay. Off passes clicks through to the desktop.'
		}
	]
};
