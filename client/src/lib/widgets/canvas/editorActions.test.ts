import { getMeta, registerMeta } from '../../core/widget';
import { expect, it } from 'vitest';
import { prepareEditorAction } from './editorActions';
it('prepares a template without parameters for preview', () => {
	const result = prepareEditorAction({ type: 'previewTemplate', templateId: 'nowplaying' });
	expect(result).toMatchObject({ type: 'previewTemplate', definition: { name: 'Now playing' } });
	if (result.type === 'previewTemplate') expect(result.definition?.params).toBeUndefined();
});

it('starts a reusable widget from a registered built-in, with independent identities', () => {
	const first = prepareEditorAction({ type: 'newFromWidget', widgetType: 'clock' });
	const second = prepareEditorAction({ type: 'newFromWidget', widgetType: 'clock' });
	expect(first).toMatchObject({
		type: 'newFromTemplate',
		definition: { name: 'Clock', size: { w: expect.any(Number), h: expect.any(Number) } }
	});
	expect(first).not.toEqual(second);
	expect(prepareEditorAction({ type: 'newFromWidget', widgetType: 'unknown-widget' })).toEqual({
		type: 'newFromTemplate',
		definition: null
	});
});

it('uses the type name when a registered widget has no display label', () => {
	const original = getMeta('text')!;
	try {
		registerMeta({ ...original, label: undefined });
		expect(prepareEditorAction({ type: 'newFromWidget', widgetType: 'text' })).toMatchObject({
			definition: { name: 'text' }
		});
	} finally {
		registerMeta(original);
	}
});
