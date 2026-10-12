import { expect, it } from 'vitest';
import { prepareEditorAction } from './editorActions';
it('prepares a template without parameters for preview', () => {
	const result = prepareEditorAction({ type: 'previewTemplate', templateId: 'nowplaying' });
	expect(result).toMatchObject({ type: 'previewTemplate', definition: { name: 'Now playing' } });
	if (result.type === 'previewTemplate') expect(result.definition?.params).toBeUndefined();
});
