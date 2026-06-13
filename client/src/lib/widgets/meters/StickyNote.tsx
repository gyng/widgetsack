// Sticky Note / scratchpad (self-sourcing, interactive). A plain editable textarea whose text persists
// in localStorage keyed by the widget id (so it survives restarts and syncs across the studio + overlay
// windows via the `storage` event). Editable on the live overlay; read-only in studio EDIT mode so the
// widget can be dragged/arranged (type on the overlay). BARE DOM; styled via --np-* / --note-* tokens.
import { useEffect, useState, type CSSProperties } from 'react';
import './StickyNote.css';

type Props = {
	widgetId?: string;
	editMode?: boolean;
	placeholder?: string;
	color?: string;
};

const keyFor = (id: string): string => `scratch:${id}`;
const load = (id: string): string => {
	try {
		return localStorage.getItem(keyFor(id)) ?? '';
	} catch {
		return '';
	}
};

export default function StickyNote({
	widgetId = '',
	editMode = false,
	placeholder = 'Notes…',
	color
}: Props) {
	const [text, setText] = useState(() => (widgetId ? load(widgetId) : ''));

	useEffect(() => {
		if (!widgetId) return;
		setText(load(widgetId));
		// Sync edits made in the OTHER window (studio ↔ overlay share the origin → the storage event fires).
		const onStorage = (e: StorageEvent): void => {
			if (e.key === keyFor(widgetId)) setText(e.newValue ?? '');
		};
		window.addEventListener('storage', onStorage);
		return () => window.removeEventListener('storage', onStorage);
	}, [widgetId]);

	const onChange = (v: string): void => {
		setText(v);
		if (widgetId) {
			try {
				localStorage.setItem(keyFor(widgetId), v);
			} catch {
				/* storage unavailable / quota — the note just won't persist */
			}
		}
	};

	const vars = color ? ({ '--note-accent': color } as CSSProperties) : undefined;

	return (
		<div className="stickynote np-stickynote" style={vars}>
			<textarea
				className="note-area"
				value={text}
				placeholder={placeholder}
				readOnly={editMode}
				spellCheck={false}
				aria-label="sticky note"
				onChange={(e) => onChange(e.currentTarget.value)}
				// On the live overlay, keep pointer/scroll inside the note (don't bubble to overlay handlers);
				// in edit mode let them through so the widget stays draggable.
				onPointerDown={(e) => {
					if (!editMode) e.stopPropagation();
				}}
				onWheel={(e) => {
					if (!editMode) e.stopPropagation();
				}}
			/>
		</div>
	);
}
