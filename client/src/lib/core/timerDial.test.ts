import { describe, expect, it } from 'vitest';
import { dialMinutes } from './timerDial';
describe('timer dial', () => {
	it('maps the sweep to whole minutes', () => {
		expect(dialMinutes(0, -100)).toBe(30);
		expect(dialMinutes(100, 0)).toBe(48);
		expect(dialMinutes(-100, 0)).toBe(12);
		expect(dialMinutes(0, 0)).toBe(0);
		expect(dialMinutes(0, 0, 20)).toBe(20);
	});
	it('holds the endpoints when a drag crosses the gap', () => {
		expect(dialMinutes(-1, 100, 60)).toBe(60);
		expect(dialMinutes(1, 100, 0)).toBe(0);
		expect(dialMinutes(0, -100, 29)).toBe(30);
	});
});
