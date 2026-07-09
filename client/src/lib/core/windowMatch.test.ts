import { describe, it, expect } from 'vitest';
import type { Rect } from './layout';
import {
	anyWindowMatches,
	exeBasename,
	globMatch,
	matchWindowToZone,
	windowMatches,
	type WindowDescriptor,
	type ZoneRule
} from './windowMatch';

const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });
const win = (exe: string, className: string, title: string): WindowDescriptor => ({
	hwnd: 1,
	exe,
	className,
	title,
	rect: r(0, 0, 100, 100)
});

describe('exeBasename', () => {
	it('lowercases and strips the directory from a Windows path', () => {
		expect(exeBasename('C:\\Program Files\\Spotify\\Spotify.exe')).toBe('spotify.exe');
	});
	it('handles forward slashes and a bare basename', () => {
		expect(exeBasename('/usr/bin/Foo')).toBe('foo');
		expect(exeBasename('Code.exe')).toBe('code.exe');
	});
});

describe('windowMatches / anyWindowMatches', () => {
	const spotify = win('C:\\x\\Spotify.exe', 'Chrome_WidgetWin_1', 'Artist - Song');
	it('matches on exe basename (case-insensitive), ignoring path', () => {
		expect(windowMatches(spotify, { exe: 'spotify.exe' })).toBe(true);
		expect(windowMatches(spotify, { exe: 'firefox.exe' })).toBe(false);
	});
	it('refines with class/title globs; every specified field must match', () => {
		expect(windowMatches(spotify, { exe: 'spotify.exe', title: '* - Song' })).toBe(true);
		expect(windowMatches(spotify, { exe: 'spotify.exe', title: 'Nope' })).toBe(false);
		expect(windowMatches(spotify, { className: 'Chrome_WidgetWin_?' })).toBe(true);
	});

	it('a mismatched class rejects the window even when nothing else is specified', () => {
		expect(windowMatches(spotify, { className: 'Nope' })).toBe(false);
	});
	it('a fieldless rule never matches (no accidental catch-all)', () => {
		expect(windowMatches(spotify, {})).toBe(false);
	});
	it('anyWindowMatches scans a list', () => {
		const list = [win('a/Code.exe', 'C', 'T'), spotify];
		expect(anyWindowMatches(list, { exe: 'spotify.exe' })).toBe(true);
		expect(anyWindowMatches(list, { exe: 'notepad.exe' })).toBe(false);
		expect(anyWindowMatches([], { exe: 'spotify.exe' })).toBe(false);
	});
});

describe('globMatch', () => {
	it('matches with * and ? wildcards, anchored and case-insensitively', () => {
		expect(globMatch('*- Notepad', 'readme.txt - Notepad')).toBe(true);
		expect(globMatch('Chrome_WidgetWin_?', 'Chrome_WidgetWin_1')).toBe(true);
		expect(globMatch('foo', 'FOO')).toBe(true);
	});
	it('is anchored (no partial matches) and escapes regex metacharacters', () => {
		expect(globMatch('Notepad', 'Notepad++')).toBe(false);
		expect(globMatch('a.b', 'axb')).toBe(false); // '.' is literal, not "any char"
		expect(globMatch('a.b', 'a.b')).toBe(true);
	});

	it('resolves a pathological many-star pattern in linear time (no ReDoS)', () => {
		const pattern = '*'.repeat(40) + 'a';
		const start = performance.now();
		expect(globMatch(pattern, 'x'.repeat(60))).toBe(false); // worst case: trailing literal never matches
		expect(globMatch(pattern, 'x'.repeat(60) + 'a')).toBe(true);
		expect(performance.now() - start).toBeLessThan(50);
	});
});

describe('matchWindowToZone', () => {
	it('matches an exe-only rule regardless of class/title', () => {
		const rules: ZoneRule[] = [{ zoneId: 'music', exe: 'Spotify.exe' }];
		const res = matchWindowToZone(
			win('C:\\x\\Spotify.exe', 'Chrome_WidgetWin_0', 'Whatever'),
			rules
		);
		expect(res?.zoneId).toBe('music');
	});

	it('returns null when nothing matches', () => {
		expect(matchWindowToZone(win('a.exe', 'C', 'T'), [{ zoneId: 'z', exe: 'b.exe' }])).toBeNull();
	});

	it('never matches a fieldless (catch-all) rule', () => {
		expect(matchWindowToZone(win('a.exe', 'C', 'T'), [{ zoneId: 'z' }])).toBeNull();
	});

	it('uses title to disambiguate two windows of the same exe (Chromium shared class)', () => {
		const rules: ZoneRule[] = [
			{ zoneId: 'mail', exe: 'chrome.exe', title: '*Gmail*' },
			{ zoneId: 'docs', exe: 'chrome.exe', title: '*Docs*' }
		];
		const gmail = win('chrome.exe', 'Chrome_WidgetWin_1', 'Inbox - me@x — Gmail');
		const docs = win('chrome.exe', 'Chrome_WidgetWin_1', 'Plan — Google Docs');
		expect(matchWindowToZone(gmail, rules)?.zoneId).toBe('mail');
		expect(matchWindowToZone(docs, rules)?.zoneId).toBe('docs');
	});

	it('falls back to class/title for a UWP window hosted by ApplicationFrameHost.exe', () => {
		const rules: ZoneRule[] = [
			{ zoneId: 'calc', className: 'ApplicationFrameWindow', title: 'Calculator' }
		];
		const uwp = win(
			'C:\\Windows\\System32\\ApplicationFrameHost.exe',
			'ApplicationFrameWindow',
			'Calculator'
		);
		expect(matchWindowToZone(uwp, rules)?.zoneId).toBe('calc');
	});

	it('prefers the more specific rule, then explicit priority, deterministically', () => {
		const w = win('code.exe', 'Chrome_WidgetWin_1', 'main.ts — project');
		// exe-only (score 2) vs exe+title (score 3) → the more specific wins.
		expect(
			matchWindowToZone(w, [
				{ zoneId: 'broad', exe: 'code.exe' },
				{ zoneId: 'narrow', exe: 'code.exe', title: '*project' }
			])?.zoneId
		).toBe('narrow');
		// Explicit priority overrides specificity.
		expect(
			matchWindowToZone(w, [
				{ zoneId: 'narrow', exe: 'code.exe', title: '*project' },
				{ zoneId: 'pinned', exe: 'code.exe', priority: 10 }
			])?.zoneId
		).toBe('pinned');
	});

	it('consumes a className refiner spread from a persisted zone match rule (no field drift)', () => {
		// The persisted ZoneMatch shape (zones.ts) must spread straight into a ZoneRule — both use
		// `className`. If the keys ever drift again, the spread drops the field and this fails.
		const persisted: { exe?: string; className?: string; title?: string } = {
			exe: 'ApplicationFrameHost.exe',
			className: 'ApplicationFrameWindow'
		};
		const rule: ZoneRule = { zoneId: 'calc', ...persisted };
		const uwp = win(
			'C:\\Windows\\System32\\ApplicationFrameHost.exe',
			'ApplicationFrameWindow',
			'Calculator'
		);
		expect(matchWindowToZone(uwp, [rule])?.zoneId).toBe('calc');
	});

	it('breaks remaining ties by earliest rule index', () => {
		const w = win('a.exe', 'C', 'T');
		const res = matchWindowToZone(w, [
			{ zoneId: 'first', exe: 'a.exe' },
			{ zoneId: 'second', exe: 'a.exe' }
		]);
		expect(res?.zoneId).toBe('first');
	});
});
