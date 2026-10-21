import { expect, it } from 'vitest';
import { selectionRequest } from './selectionRequest';
it('marks modifier-clicks for additive selection and leaves ordinary clicks unchanged', () => {
	expect(selectionRequest('a', {})).toEqual({ id: 'a' });
	for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }])
		expect(selectionRequest('a', modifiers)).toEqual({ id: 'a', additive: true });
});
