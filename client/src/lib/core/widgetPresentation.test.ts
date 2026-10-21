import { getMeta, registerMeta } from './widget';
import { expect, it } from 'vitest';
import { container, group, leaf } from './layoutTree';
import { createWidget } from './widget';
import { applyPresentation, presentationConfig } from './widgetPresentation';
import { resolveGroup } from './solve';
it('changes presentation controls without changing provider setup, sources or commands', () => {
	const ai = {
		...createWidget('aiusage', 'ai'),
		config: {
			providers: [{ id: 'codex', command: 'private-cli' }],
			interval: 900,
			layout: 'compact'
		}
	};
	expect(presentationConfig(ai, 'minimal')).toMatchObject({
		providers: ai.config.providers,
		interval: 900,
		layout: 'minimal',
		showHeader: false
	});
	expect(presentationConfig(createWidget('clock', 'clock'), 'compact')).toMatchObject({
		format: 'HH:mm:ss'
	});
	expect(presentationConfig(createWidget('clock', 'clock'), 'detailed')).toMatchObject({
		format: 'ddd D MMM · HH:mm:ss'
	});
	expect(presentationConfig(createWidget('clock', 'clock'), 'minimal')).toMatchObject({
		format: 'HH:mm'
	});
	expect(presentationConfig(createWidget('customhtml', 'custom'), 'minimal')).toEqual(
		createWidget('customhtml', 'custom').config
	);
});
it('keeps group definitions linked while applying presentation independently to rendered copies', () => {
	const child = leaf(createWidget('aiusage', 'ai'));
	const def = { id: 'shared', name: 'Usage', size: { w: 265, h: 44 }, child };
	const original = leaf(group('one', def.size, child, { def: def.id }));
	const changed = applyPresentation(container('root', 'col', [original]), 'minimal');
	expect(changed).toMatchObject({
		children: [{ unit: { def: 'shared', config: { presentation: 'minimal' } } }]
	});
	const unit = 'children' in changed ? changed.children[0] : original;
	if ('unit' in unit && 'kind' in unit.unit)
		expect(resolveGroup(unit.unit, { version: 1, defs: [def] }).child).toMatchObject({
			unit: { config: { layout: 'minimal' } }
		});
	expect(def.child).toMatchObject({ unit: { config: { layout: 'compact' } } });
	const inline = leaf(group('inline', def.size, child));
	expect(applyPresentation(inline, 'detailed')).toMatchObject({
		unit: { config: { presentation: 'detailed' } }
	});
});

it('preserves authored date formats and unsupported controls while handling sparse plugin metadata', () => {
	const clock = createWidget('clock', 'time');
	expect(presentationConfig({ ...clock, config: {} }, 'minimal')).toMatchObject({
		format: 'HH:mm'
	});
	expect(presentationConfig({ ...clock, config: { format: 'D MMM' } }, 'detailed')).toMatchObject({
		format: 'D MMM'
	});
	expect(presentationConfig({ ...clock, config: { format: 'h:mm A' } }, 'compact')).toMatchObject({
		format: 'h:mm:ss A'
	});
	expect(presentationConfig(createWidget('text', 'spark-text'), 'compact')).toMatchObject({
		showSparkline: true
	});
	expect(
		presentationConfig({ ...clock, type: 'unregistered', config: { command: 'keep' } }, 'minimal')
	).toEqual({ command: 'keep' });
	const original = getMeta('text')!;
	try {
		registerMeta({
			...original,
			configFields: [{ key: 'layout', label: 'Layout', kind: 'select', options: ['cards'] }]
		});
		expect(
			presentationConfig({ ...clock, type: 'text', config: { layout: 'cards' } }, 'minimal')
		).toEqual({ layout: 'cards' });
	} finally {
		registerMeta(original);
	}
});
