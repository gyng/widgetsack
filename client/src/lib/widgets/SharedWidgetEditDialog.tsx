import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from './canvas/useFocusTrap';

export default function SharedWidgetEditDialog({
	name,
	usage,
	locations,
	loading,
	placement,
	onEdit,
	onCopy,
	onClose
}: {
	name: string;
	usage: string;
	locations: { key: string; count: number }[];
	loading: boolean;
	placement: boolean;
	onEdit: () => void;
	onCopy: () => void;
	onClose: () => void;
}) {
	const dialog = useRef<HTMLDivElement>(null);
	const { onKeyDown } = useFocusTrap(dialog, true);
	useEffect(() => {
		const opener = document.activeElement as HTMLElement;
		dialog.current!.querySelector<HTMLButtonElement>('button')!.focus();
		return () => opener.focus();
	}, []);
	return createPortal(
		<div className="template-setup-backdrop">
			<div
				className="inspector template-setup"
				role="dialog"
				aria-modal="true"
				aria-label={`Edit ${name}`}
				ref={dialog}
				onKeyDown={(event) => {
					if (event.key === 'Escape') {
						event.preventDefault();
						event.stopPropagation();
						onClose();
					} else onKeyDown(event);
				}}
			>
				<h2>Edit {name}</h2>
				<p>Choose which copies should receive your changes.</p>
				<div className="reuse-card">
					<strong>{usage}</strong>
					<ul>
						{locations.map((location) => (
							<li key={location.key}>
								{location.key} · {location.count}
							</li>
						))}
					</ul>
				</div>
				<button type="button" onClick={onCopy}>
					{placement ? 'Edit only this placement' : 'Make a copy'}
				</button>
				<small className="field-help">
					{placement
						? 'Creates an independent widget for this placement. Other copies keep their existing source.'
						: 'Creates a separate widget in My widgets and keeps the original.'}
				</small>
				<button type="button" disabled={loading} onClick={onEdit}>
					Edit all linked copies
				</button>
				<small className="field-help">
					Updates the shared widget everywhere it is used, including saved layouts.
				</small>
				<div className="template-setup-actions">
					<button type="button" onClick={onClose}>
						Cancel
					</button>
				</div>
			</div>
		</div>,
		document.body
	);
}
