import { describe, it, expect } from 'vitest';
import { setTokens } from './editorOps';

// setTokens only reads `tokenOverrides`, so a minimal partial state suffices.
const state = (tokenOverrides: Record<string, string> = {}) =>
	({ tokenOverrides } as unknown as Parameters<typeof setTokens>[0]);

describe('setTokens op (wallpaper auto-theme)', () => {
	it('merges a whole map over the existing overrides', () => {
		expect(
			setTokens(state({ '--np-accent': 'red' }), { '--np-fg': '#fff', '--np-accent': 'blue' })
		).toEqual({ tokenOverrides: { '--np-accent': 'blue', '--np-fg': '#fff' } });
	});

	it('a key with an empty value clears it', () => {
		expect(
			setTokens(state({ '--np-fg': '#fff', '--np-accent': 'red' }), { '--np-fg': '' })
		).toEqual({ tokenOverrides: { '--np-accent': 'red' } });
	});

	it('an empty map is a no-op patch (no undo entry)', () => {
		expect(setTokens(state({ '--np-fg': '#fff' }), {})).toEqual({});
	});
});
