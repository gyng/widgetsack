import { describe, it, expect } from 'vitest';
import { rebaselineOnEditToggle } from './overlayEditBaseline';

describe('rebaselineOnEditToggle', () => {
	it.each([
		// overlay: only the rising edge re-anchors the baseline + history
		[{ studio: false, wasEditing: false, editing: true }, true],
		[{ studio: false, wasEditing: true, editing: false }, false],
		[{ studio: false, wasEditing: true, editing: true }, false],
		[{ studio: false, wasEditing: false, editing: false }, false],
		// studio: never (its baseline is the last explicit Save)
		[{ studio: true, wasEditing: false, editing: true }, false],
		[{ studio: true, wasEditing: true, editing: false }, false]
	])('%j → %s', (input, expected) => {
		expect(rebaselineOnEditToggle(input)).toBe(expected);
	});
});
