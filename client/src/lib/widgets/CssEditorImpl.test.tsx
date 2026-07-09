import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { act } from 'react';
import { EditorView } from '@codemirror/view';
import CssEditorImpl from './CssEditorImpl';

// Direct tests against the (normally lazy-loaded) CodeMirror impl: construct under happy-dom, then
// drive the EditorView programmatically. Rich interactions (real typing/popups) need layout and are
// covered elsewhere — here we verify the wiring: doc render, onChange/onBlur callbacks, external
// value resync (only while unfocused), aria-label, and className merging.

const cmEditor = (container: HTMLElement) => container.querySelector('.cm-editor') as HTMLElement;
const cmContent = (container: HTMLElement) =>
	container.querySelector('.cm-content') as HTMLElement | null;
// happy-dom has no real contentEditable, so drive the doc through CodeMirror's own view API rather
// than synthetic key events (which CodeMirror reads from the DOM and so can't process here).
const view = (container: HTMLElement) => EditorView.findFromDOM(cmEditor(container))!;

describe('CssEditorImpl', () => {
	it('mounts a CodeMirror editor and renders the initial value', async () => {
		const { container } = render(<CssEditorImpl value=".value { color: red }" />);
		await waitFor(() => expect(cmEditor(container)).toBeTruthy());
		expect(cmContent(container)?.textContent).toContain('color: red');
	});

	it('defaults the aria-label and merges the className onto the host', async () => {
		const { container } = render(<CssEditorImpl value="" className="inspector-css" />);
		await waitFor(() => expect(cmContent(container)).toBeTruthy());
		expect(cmContent(container)?.getAttribute('aria-label')).toBe('CSS editor');
		const host = container.querySelector('.css-editor');
		expect(host?.classList.contains('inspector-css')).toBe(true);
	});

	it('uses the supplied aria-label when given', async () => {
		const { container } = render(<CssEditorImpl value="" ariaLabel="theme css" />);
		await waitFor(() => expect(cmContent(container)).toBeTruthy());
		expect(cmContent(container)?.getAttribute('aria-label')).toBe('theme css');
	});

	it('fires onChange with the new doc on a document change', async () => {
		const onChange = vi.fn();
		const { container } = render(<CssEditorImpl value="a" onChange={onChange} />);
		await waitFor(() => expect(cmEditor(container)).toBeTruthy());
		// Dispatch a doc edit through the view → the updateListener fires onChange.
		act(() => {
			view(container).dispatch({ changes: { from: 1, insert: 'bc' } });
		});
		expect(onChange).toHaveBeenCalled();
		expect(onChange.mock.calls.at(-1)?.[0]).toBe('abc');
	});

	it('does not fire onChange for a doc-unchanged update (selection move only)', async () => {
		const onChange = vi.fn();
		const { container } = render(<CssEditorImpl value="abc" onChange={onChange} />);
		await waitFor(() => expect(cmEditor(container)).toBeTruthy());
		// A transaction with no document change still runs the updateListener — but must not commit.
		act(() => {
			view(container).dispatch({ selection: { anchor: 1 } });
		});
		expect(onChange).not.toHaveBeenCalled();
	});

	it('fires onBlur with the current doc when the content blurs', async () => {
		const onBlur = vi.fn();
		const { container } = render(<CssEditorImpl value="x: 1" onBlur={onBlur} />);
		await waitFor(() => expect(cmEditor(container)).toBeTruthy());
		act(() => {
			cmContent(container)!.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
		});
		expect(onBlur).toHaveBeenCalledWith('x: 1');
	});

	it('resyncs the doc when the external value changes while unfocused', async () => {
		const { container, rerender } = render(<CssEditorImpl value="before" />);
		await waitFor(() => expect(cmEditor(container)).toBeTruthy());
		rerender(<CssEditorImpl value="after" />);
		await waitFor(() => expect(cmContent(container)?.textContent).toContain('after'));
	});

	it('does NOT resync while the editor is focused (no clobbering the cursor)', async () => {
		const { container, rerender } = render(<CssEditorImpl value="typed" />);
		await waitFor(() => expect(cmEditor(container)).toBeTruthy());
		// Really focus the content so view.hasFocus (activeElement check) is true.
		act(() => cmContent(container)!.focus());
		expect(view(container).hasFocus).toBe(true);
		rerender(<CssEditorImpl value="external" />);
		// The displayed doc keeps the user's content, not the external value.
		expect(cmContent(container)?.textContent).toContain('typed');
		expect(cmContent(container)?.textContent).not.toContain('external');
	});

	it('is a no-op resync when the external value already matches the doc', async () => {
		const { container, rerender } = render(<CssEditorImpl value="same" />);
		await waitFor(() => expect(cmEditor(container)).toBeTruthy());
		// Re-render with the identical value: the value-sync effect runs but dispatches no change.
		rerender(<CssEditorImpl value="same" />);
		expect(cmContent(container)?.textContent).toContain('same');
	});

	it('destroys the view on unmount without throwing', async () => {
		const { container, unmount } = render(<CssEditorImpl value="z" />);
		await waitFor(() => expect(cmEditor(container)).toBeTruthy());
		expect(() => unmount()).not.toThrow();
		expect(container.querySelector('.cm-editor')).toBeNull();
	});
});
