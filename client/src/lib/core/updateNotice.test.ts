import { describe, expect, it } from 'vitest';
import {
	appUpdateFromWire,
	isProjectUrl,
	updateBadge,
	updateStatusLine,
	type AppUpdate
} from './updateNotice';

const update = (over: Partial<AppUpdate> = {}): AppUpdate => ({
	current: '0.0.55',
	latest: '0.0.56',
	url: 'https://github.com/gyng/widgetsack/releases/tag/v0.0.56',
	updateAvailable: true,
	...over
});

describe('appUpdateFromWire', () => {
	it('camelCases the serde shape and passes an absent result through as null', () => {
		expect(
			appUpdateFromWire({
				current: '0.0.55',
				latest: '0.0.56',
				url: 'https://x',
				update_available: true
			})
		).toEqual({ current: '0.0.55', latest: '0.0.56', url: 'https://x', updateAvailable: true });
		expect(appUpdateFromWire(null)).toBeNull();
		expect(appUpdateFromWire(undefined)).toBeNull();
	});
});

describe('updateBadge / updateStatusLine', () => {
	it('badges only an available update, with the new version tag', () => {
		expect(updateBadge(update())).toBe('v0.0.56');
		expect(updateBadge(update({ updateAvailable: false }))).toBeNull();
		expect(updateBadge(null)).toBeNull();
	});

	it('describes each persisted state for the About tab', () => {
		expect(updateStatusLine(null)).toBe('No update check has run yet.');
		expect(updateStatusLine(update())).toBe('v0.0.56 available (you have v0.0.55).');
		expect(updateStatusLine(update({ updateAvailable: false, latest: '0.0.55' }))).toBe(
			'You’re up to date (v0.0.55).'
		);
	});
});

describe('isProjectUrl', () => {
	it('accepts only https github.com URLs under the repo (mirrors update.rs url_allowed)', () => {
		expect(isProjectUrl('https://github.com/gyng/widgetsack')).toBe(true);
		expect(isProjectUrl('https://github.com/gyng/widgetsack/releases/tag/v1')).toBe(true);
		expect(isProjectUrl('https://github.com/gyng/widgetsack?tab=readme')).toBe(true);
		expect(isProjectUrl('http://github.com/gyng/widgetsack')).toBe(false);
		expect(isProjectUrl('https://github.com.evil.example/gyng/widgetsack')).toBe(false);
		expect(isProjectUrl('https://github.com/gyng/widgetsack-evil')).toBe(false);
		expect(isProjectUrl('https://github.com/gyng/widgetsack/a b')).toBe(false);
		expect(isProjectUrl('')).toBe(false);
	});
});
