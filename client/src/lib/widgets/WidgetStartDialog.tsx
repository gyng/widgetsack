import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from './canvas/useFocusTrap';
import Icon from './Icon';

export default function WidgetStartDialog({
	onChoose,
	onBlank,
	onClose
}: {
	onChoose: (tab: 'Templates' | 'Widgets' | 'My widgets') => void;
	onBlank: () => void;
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
				className="inspector template-setup widget-start-dialog"
				role="dialog"
				aria-modal="true"
				aria-label="Start a widget"
				ref={dialog}
				onKeyDown={(event) => {
					if (event.key === 'Escape') {
						event.preventDefault();
						event.stopPropagation();
						onClose();
					} else onKeyDown(event);
				}}
			>
				<h2>Start a widget</h2>
				<p>
					Choose a starting point. You can change its content and appearance before adding it to a
					layout.
				</p>
				<button
					type="button"
					className="widget-start-choice"
					aria-label="Start with a template"
					onClick={() => onChoose('Templates')}
				>
					<Icon name="image" />
					<span>
						<strong>Start with a template</strong>
						<small>A ready-made clock, system panel or network meter.</small>
					</span>
				</button>
				<button
					type="button"
					className="widget-start-choice"
					aria-label="Start with a built-in widget"
					onClick={() => onChoose('Widgets')}
				>
					<Icon name="plus" />
					<span>
						<strong>Start with a built-in widget</strong>
						<small>Choose a working widget and customize it.</small>
					</span>
				</button>
				<button
					type="button"
					className="widget-start-choice"
					aria-label="Copy from My widgets"
					onClick={() => onChoose('My widgets')}
				>
					<Icon name="copy" />
					<span>
						<strong>Copy from My widgets</strong>
						<small>Choose Make a copy on a saved widget to keep the original.</small>
					</span>
				</button>
				<details className="adv">
					<summary>Advanced</summary>
					<p>Build a widget from individual meters and containers.</p>
					<button type="button" onClick={onBlank}>
						Create blank widget
					</button>
				</details>
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
