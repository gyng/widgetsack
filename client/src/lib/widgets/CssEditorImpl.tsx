// The CodeMirror-backed CSS editor implementation. Loaded lazily by CssEditor.tsx so CodeMirror
// ships as its own chunk (overlay windows, which never edit CSS, don't pay for it) — mirroring how
// the spectrum WASM FFT and the QuickJS formula engine are split out. A thin React wrapper around a
// CodeMirror EditorView: highlighting, autocomplete (CSS props/values + our `--np-*` tokens +
// data-part hooks) and fragment linting all come from cssEditorExt. The view is created once;
// external `value` changes resync the doc only while the editor is NOT focused, so it works both
// controlled (theme: value+onChange) and commit-on-blur (inspector: value+onBlur, remounted via
// React `key` on selection change).
import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { cssExtensions } from './cssEditorExt';
import './CssEditor.css';

export type CssEditorProps = {
	value: string;
	onChange?: (value: string) => void;
	onBlur?: (value: string) => void;
	placeholder?: string;
	ariaLabel?: string;
	className?: string;
};

export default function CssEditorImpl({
	value,
	onChange,
	onBlur,
	placeholder,
	ariaLabel,
	className
}: CssEditorProps) {
	const hostRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	// Latest callbacks, so the once-created view always calls the current handlers (no stale closures).
	// Committed after render (not during it); the view only ever reads them inside CM callbacks, later.
	const cbRef = useRef({ onChange, onBlur });
	useEffect(() => {
		cbRef.current = { onChange, onBlur };
	});

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const view = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: value,
				extensions: [
					...cssExtensions(placeholder),
					EditorView.updateListener.of((u) => {
						if (u.docChanged) cbRef.current.onChange?.(u.state.doc.toString());
					}),
					EditorView.domEventHandlers({
						blur: (_e, v) => {
							cbRef.current.onBlur?.(v.state.doc.toString());
							return false;
						}
					}),
					EditorView.contentAttributes.of({ 'aria-label': ariaLabel ?? 'CSS editor' })
				]
			})
		});
		viewRef.current = view;
		return () => {
			view.destroy();
			viewRef.current = null;
		};
		// Created once; placeholder/ariaLabel are static per usage. External value sync is handled below.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Reflect external value changes (theme draft seeding, programmatic resets) — but never while the
	// user is typing, which would clobber the cursor/selection.
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		const current = view.state.doc.toString();
		if (value !== current && !view.hasFocus) {
			view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
		}
	}, [value]);

	return <div ref={hostRef} className={['css-editor', className].filter(Boolean).join(' ')} />;
}
