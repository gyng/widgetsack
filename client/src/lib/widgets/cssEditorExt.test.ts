import { describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { CompletionContext } from '@codemirror/autocomplete';
import { diagnosticCount, forceLinting } from '@codemirror/lint';
import { css } from '@codemirror/lang-css';
import { cssExtensions, partCompletionSource, tokenCompletionSource } from './cssEditorExt';
import { DEFAULT_TOKENS } from '../core/tokens';

// Drive each completion source through a real CodeMirror CompletionContext, exactly as the editor
// does at runtime — proof the autocomplete actually fires (the smoke test only covers mounting).
function contextAt(doc: string, pos = doc.length, explicit = false): CompletionContext {
	const state = EditorState.create({ doc, extensions: [css()] });
	return new CompletionContext(state, pos, explicit);
}

describe('token (--np-*) autocomplete', () => {
	it('offers every theme token when typing a custom property inside var()', () => {
		const result = tokenCompletionSource(contextAt('color: var(--np'));
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result.options.map((o) => o.label)).toEqual(Object.keys(DEFAULT_TOKENS));
		expect(result.options.map((o) => o.label)).toContain('--np-accent');
		// The match starts at the `--`, so accepting replaces the whole token name.
		expect(result.from).toBe('color: var('.length);
	});

	it('does not fire on ordinary text unless completion is explicitly requested', () => {
		expect(tokenCompletionSource(contextAt('color: red'))).toBeNull();
		expect(tokenCompletionSource(contextAt('color: red', 10, true))).not.toBeNull();
	});
});

describe('[data-part="…"] autocomplete', () => {
	it('offers the meter parts while authoring a data-part selector', () => {
		const result = partCompletionSource(contextAt('[data-part="la'));
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result.options.map((o) => o.label)).toContain('label');
		// Accepting closes the selector (`label"]`).
		expect(result.options.find((o) => o.label === 'label')?.apply).toBe('label"]');
		expect(result.from).toBe('[data-part="'.length);
	});

	it('does not fire outside a data-part selector', () => {
		expect(partCompletionSource(contextAt('color: red'))).toBeNull();
	});
});

describe('autocomplete wiring', () => {
	it('registers three CSS autocomplete sources: built-in (props/values) + tokens + parts', () => {
		// The editor enables completion by collecting every autocomplete source on the CSS language
		// data. css() contributes the built-in property/value source; cssExtensions adds our two.
		const state = EditorState.create({ doc: 'a { color: red }', extensions: cssExtensions() });
		expect(state.languageDataAt('autocomplete', 5)).toHaveLength(3);
	});
});

describe('linter wiring (cssDiagnostics → CM diagnostics)', () => {
	// Drive the bundled linter end-to-end against a real EditorView so the linter source callback
	// (the cssDiagnostics → CM-diagnostic mapping) actually runs. Uses a hidden DOM container.
	function mount(doc: string): EditorView {
		const parent = document.createElement('div');
		document.body.appendChild(parent);
		return new EditorView({
			state: EditorState.create({ doc, extensions: cssExtensions() }),
			parent
		});
	}

	it('surfaces a diagnostic for a broken CSS fragment', async () => {
		// An unbalanced bracket fragment is flagged by the balance pass inside cssDiagnostics; the
		// linter callback maps that to a CodeMirror diagnostic on the document.
		const view = mount('color: red; }}');
		try {
			forceLinting(view);
			await vi.waitFor(() => expect(diagnosticCount(view.state)).toBeGreaterThan(0));
		} finally {
			view.destroy();
		}
	});

	it('produces no diagnostics for a clean fragment', async () => {
		const view = mount('color: red;');
		try {
			forceLinting(view);
			// Let the (forced) lint pass settle, then assert it stayed clean.
			await new Promise((r) => setTimeout(r, 0));
			expect(diagnosticCount(view.state)).toBe(0);
		} finally {
			view.destroy();
		}
	});
});
