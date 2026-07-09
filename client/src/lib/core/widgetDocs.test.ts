import { describe, expect, it } from 'vitest';
import { widgetReferenceMarkdown } from './widgetDocs';
import type { WidgetMeta } from './widget';

const metas: WidgetMeta[] = [
	{
		type: 'gauge',
		label: 'Gauge',
		description: 'Arc gauge.',
		binds: 'scalar',
		defaultSensor: 'cpu.total',
		defaultSize: { w: 110, h: 110 },
		defaultConfig: { label: 'CPU', min: 0, max: 100 },
		configFields: [
			{ key: 'label', label: 'label', kind: 'text' },
			{ key: 'min', label: 'min', kind: 'number', help: 'empty value' },
			{ key: 'mode', label: 'mode', kind: 'select', options: ['a', 'b'] }
		]
	},
	{
		type: 'clock',
		label: 'Clock',
		binds: 'none',
		intrinsic: true,
		defaultSize: { w: 160, h: 40 }
	}
];

describe('widgetReferenceMarkdown', () => {
	const md = widgetReferenceMarkdown(metas);

	it('includes the layout-shape preamble and a section per widget', () => {
		expect(md).toContain('# Widget reference');
		expect(md).toContain('## Layout shape');
		expect(md).toContain('### Gauge — `gauge`');
		expect(md).toContain('### Clock — `clock`');
	});

	it('documents the sensor binding (and self-sourcing)', () => {
		expect(md).toContain('binds a `scalar` sensor (default `cpu.total`)');
		expect(md).toContain('none (self-sourcing)');
	});

	it('renders a config table with defaults pulled from defaultConfig', () => {
		expect(md).toContain('| key | type | default | options / range | description |');
		expect(md).toContain('| `label` | text | "CPU" |');
		expect(md).toContain('| `mode` | select |  | `a`, `b` |');
	});

	it('notes intrinsic + no-fields widgets', () => {
		expect(md).toContain('Intrinsic size');
		expect(md).toContain('_No configurable fields._');
	});

	it('escapes pipes so the table stays well-formed', () => {
		const piped = widgetReferenceMarkdown([
			{
				type: 't',
				label: 'T',
				binds: 'scalar',
				configFields: [{ key: 'k', label: 'k', kind: 'text', help: 'a | b' }]
			}
		]);
		expect(piped).toContain('a \\| b');
	});

	it('documents an empty/catalog select, expr fields (with/without a target), and a numeric range', () => {
		const kitchen: WidgetMeta = {
			type: 'kitchen',
			label: 'Kitchen',
			binds: 'scalar',
			configFields: [
				{ key: 'src', label: 'src', kind: 'select', options: [], catalog: 'sensors' },
				{ key: 'e1', label: 'e1', kind: 'expr', result: 'number', target: 'foo' },
				{ key: 'e2', label: 'e2', kind: 'expr', result: 'text' },
				{ key: 'range', label: 'range', kind: 'number', min: 0, max: 10, step: 1 },
				{ key: 'preset', label: 'preset', kind: 'text', default: 'hi' }
			]
		};
		const md = widgetReferenceMarkdown([kitchen]);
		expect(md).toContain('(runtime list) — from `sensors`');
		expect(md).toContain('→ number (sets `foo`)');
		expect(md).toContain('| `e2` | expr | ');
		expect(md).toContain('→ text |');
		expect(md).toContain('min 0, max 10, step 1');
		expect(md).toContain('| `preset` | text | "hi" |');
	});

	it('falls back to the type when label is missing, "scalar" when binds is missing, and notes interactive widgets', () => {
		const blob: WidgetMeta = { type: 'blob', interactive: true };
		const md = widgetReferenceMarkdown([blob]);
		expect(md).toContain('### blob — `blob`');
		expect(md).toContain('![blob widget]');
		expect(md).toContain('binds a `scalar` sensor');
		expect(md).toContain('- **Interactive:** catches clicks in passive mode');
	});
});
