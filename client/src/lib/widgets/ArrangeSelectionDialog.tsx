import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { planArrangement, type Arrangement } from '../core/arrangement';
import type { Library, MonitorLayout, Rect } from '../core/layoutTree';
import { useFocusTrap } from './canvas/useFocusTrap';
import './ArrangeSelectionDialog.css';

const OPTIONS: { value: Arrangement; label: string }[] = [
	{ value: 'column', label: 'Stack vertically' },
	{ value: 'row', label: 'Arrange in a row' },
	{ value: 'space-horizontal', label: 'Equal horizontal spacing' },
	{ value: 'space-vertical', label: 'Equal vertical spacing' },
	{ value: 'fit', label: 'Fit to content' }
];
function Diagram({ rects, bounds, label }: { rects: Rect[]; bounds: Rect; label: string }) {
	return (
		<figure>
			<figcaption>{label}</figcaption>
			<svg
				role="img"
				aria-label={`${label} arrangement`}
				viewBox={`${bounds.x - 8} ${bounds.y - 8} ${bounds.w + 16} ${bounds.h + 16}`}
			>
				{rects.map((rect, index) => (
					<g key={index}>
						<rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx={2} />
						<text
							x={rect.x + rect.w / 2}
							y={rect.y + rect.h / 2}
							textAnchor="middle"
							dominantBaseline="middle"
							fontSize={Math.min(rect.h * 0.6, bounds.w / 25)}
						>
							{index + 1}
						</text>
					</g>
				))}
			</svg>
		</figure>
	);
}
export default function ArrangeSelectionDialog({
	monitor,
	library,
	ids,
	measured,
	natural,
	onApply,
	onClose
}: {
	monitor: MonitorLayout;
	library?: Library;
	ids: string[];
	measured: ReadonlyMap<string, Rect>;
	natural: ReadonlyMap<string, Rect>;
	onApply: (source: MonitorLayout, next: MonitorLayout) => boolean;
	onClose: () => void;
}) {
	const [source] = useState(() => ({
		monitor,
		library,
		ids,
		measured,
		natural,
		wrapperId: `arrange-${crypto.randomUUID()}`
	}));
	const [mode, setMode] = useState<Arrangement>('column');
	const [changed, setChanged] = useState(false);
	const dialog = useRef<HTMLDivElement>(null);
	const { onKeyDown } = useFocusTrap(dialog, true);
	useEffect(() => {
		const opener = document.activeElement as HTMLElement;
		dialog.current!.querySelector<HTMLButtonElement>('button')!.focus();
		return () => opener.focus();
	}, []);
	const plan = planArrangement(
		source.monitor,
		source.ids,
		mode,
		source.library,
		mode === 'fit' ? source.natural : source.measured,
		source.wrapperId
	);
	const boxes = [...plan.before, ...plan.after];
	const bounds = boxes.length
		? {
				x: Math.min(...boxes.map((rect) => rect.x)),
				y: Math.min(...boxes.map((rect) => rect.y)),
				w: 0,
				h: 0
			}
		: { x: 0, y: 0, w: 100, h: 100 };
	if (boxes.length) {
		bounds.w = Math.max(...boxes.map((rect) => rect.x + rect.w)) - bounds.x;
		bounds.h = Math.max(...boxes.map((rect) => rect.y + rect.h)) - bounds.y;
	}
	return createPortal(
		<div className="template-setup-backdrop">
			<div
				className="inspector template-setup arrangement-dialog"
				role="dialog"
				aria-modal="true"
				aria-label="Arrange selection"
				ref={dialog}
				onKeyDown={(event) => {
					if (event.key === 'Escape') {
						event.preventDefault();
						event.stopPropagation();
						onClose();
					} else onKeyDown(event);
				}}
			>
				<h2>Arrange selection</h2>
				<p>Review the proposed arrangement. Apply makes one undoable change.</p>
				<div className="arrangement-options" role="group" aria-label="Arrangement">
					{OPTIONS.map((option) => (
						<button
							type="button"
							key={option.value}
							aria-pressed={mode === option.value}
							onClick={() => {
								setMode(option.value);
								setChanged(false);
							}}
						>
							{option.label}
						</button>
					))}
				</div>
				{plan.message ? (
					<p role="status">{plan.message}</p>
				) : (
					<div className="arrangement-previews">
						<Diagram rects={plan.before} bounds={bounds} label="Before" />
						<Diagram rects={plan.after} bounds={bounds} label="After" />
					</div>
				)}
				{changed && <p role="alert">The layout changed. Close this preview and try again.</p>}
				<div className="template-setup-actions">
					<button type="button" onClick={onClose}>
						Cancel
					</button>
					<button
						type="button"
						disabled={!plan.monitor}
						onClick={() => {
							if (onApply(source.monitor, plan.monitor!)) onClose();
							else setChanged(true);
						}}
					>
						Apply arrangement
					</button>
				</div>
			</div>
		</div>,
		document.body
	);
}
