// Sticky Note / scratchpad (self-sourcing, interactive). A plain editable textarea whose text persists
// in localStorage keyed by the widget instance id (so it survives restarts and syncs across the studio + overlay
// windows via the `storage` event). Editable on the live overlay; read-only in studio EDIT / preview mode so the
// widget can be dragged/arranged (type on the overlay). BARE DOM; styled via --np-* / --note-* tokens.
import { useEffect, useState, type CSSProperties } from 'react';
import './StickyNote.css';

type Props = {
	widgetId?: string;
	/** The namespaced instance id (WidgetHost's dom id) — two placements of one library widget share
	 * `widgetId` but not this, so each keeps its own note. */
	widgetInstanceId?: string;
	editMode?: boolean;
	previewMode?: boolean;
	placeholder?: string;
	color?: string;
};

const keyFor = (id: string): string => `scratch:${id}`;
// Notes saved before instance keys existed live under the def-local id; read them as a fallback.
const load = (key: string, legacyKey: string): string => {
	try {
		return (
			localStorage.getItem(key) ??
			(key !== legacyKey ? localStorage.getItem(legacyKey) : null) ??
			''
		);
	} catch {
		return '';
	}
};

export default function StickyNote({
	widgetId = '',
	widgetInstanceId = widgetId,
	editMode = false,
	previewMode = false,
	placeholder = 'Notes…',
	color
}: Props) {
	const id = widgetInstanceId || widgetId;
	const key = keyFor(id);
	const legacyKey = keyFor(widgetId || id);
	const readOnly = editMode || previewMode;
	const [text, setText] = useState(() => (id ? load(key, legacyKey) : ''));

	// Re-read from storage when the widget id changes — as an adjust-during-render (React re-renders
	// before paint) rather than a setState-in-effect. Matches the old effect's `if (!widgetId) return`:
	// an empty id keeps whatever is shown.
	const [prevKey, setPrevKey] = useState(key);
	if (key !== prevKey) {
		setPrevKey(key);
		if (id) setText(load(key, legacyKey));
	}

	useEffect(() => {
		if (!id) return;
		// Sync edits made in the OTHER window (studio ↔ overlay share the origin → the storage event fires).
		const onStorage = (e: StorageEvent): void => {
			if (e.key === key) setText(e.newValue ?? '');
		};
		window.addEventListener('storage', onStorage);
		return () => window.removeEventListener('storage', onStorage);
	}, [id, key]);

	const onChange = (v: string): void => {
		if (readOnly) return;
		setText(v);
		if (id) {
			try {
				localStorage.setItem(key, v);
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
				readOnly={readOnly}
				spellCheck={false}
				aria-label="sticky note"
				onChange={(e) => onChange(e.currentTarget.value)}
				// On the live overlay, keep pointer/scroll inside the note (don't bubble to overlay handlers);
				// in edit/preview mode let them through so the widget stays draggable.
				onPointerDown={(e) => {
					if (!readOnly) e.stopPropagation();
				}}
				onWheel={(e) => {
					if (!readOnly) e.stopPropagation();
				}}
			/>
		</div>
	);
}
