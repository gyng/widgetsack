import { describe, expect, it } from 'vitest';
import { decideExternalChange, isForeignWriter } from './externalChange';

describe('decideExternalChange', () => {
	const idle = { dirty: false, previewPending: false, designing: false };

	it('reloads silently when the editor has nothing to lose', () => {
		expect(decideExternalChange(idle)).toBe('reload');
	});

	it('asks when the editor holds unsaved work', () => {
		expect(decideExternalChange({ ...idle, dirty: true })).toBe('ask');
	});

	it('asks when a preview write is pending (it would clobber the external edit otherwise)', () => {
		expect(decideExternalChange({ ...idle, previewPending: true })).toBe('ask');
		expect(decideExternalChange({ ...idle, dirty: true, previewPending: true })).toBe('ask');
	});

	it('asks while the widget designer is open (a reload would replace the scoped def tree)', () => {
		expect(decideExternalChange({ ...idle, designing: true })).toBe('ask');
	});
});

describe('isForeignWriter', () => {
	it("the window's own save is not foreign", () => {
		expect(isForeignWriter('studio', 'studio')).toBe(false);
	});

	it('another window, or a watcher event with no writer, is foreign', () => {
		expect(isForeignWriter('main', 'studio')).toBe(true);
		expect(isForeignWriter('overlay-2', 'studio')).toBe(true);
		expect(isForeignWriter(undefined, 'studio')).toBe(true);
	});
});
