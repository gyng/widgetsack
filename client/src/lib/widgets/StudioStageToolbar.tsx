import { useId, useState, type CSSProperties } from 'react';
import { selectMenuPlacement } from './selectMenuPlacement';
import Icon from './Icon';

type Props = {
	canUndo: boolean;
	canRedo: boolean;
	undo: () => void;
	redo: () => void;
	fit: () => void;
	focus: () => void;
	zoom: number;
	dropIntoFlow: boolean;
	dropIntoCells: boolean;
	onDropIntoFlow: (value: boolean) => void;
	onDropIntoCells: (value: boolean) => void;
	developer: boolean;
	copyDebug: () => void;
};

export default function StudioStageToolbar(p: Props) {
	const optionsId = useId();
	const [position, setPosition] = useState<CSSProperties>();
	return (
		<div className="stage-tools">
			<button
				type="button"
				aria-label="Undo"
				title="Undo (Ctrl+Z)"
				disabled={!p.canUndo}
				onClick={p.undo}
			>
				<Icon name="undo" /> <span className="tool-label">Undo</span>
			</button>
			<button
				type="button"
				aria-label="Redo"
				title="Redo (Ctrl+Y)"
				disabled={!p.canRedo}
				onClick={p.redo}
			>
				<Icon name="redo" /> <span className="tool-label">Redo</span>
			</button>
			<span className="tool-divider" />
			<button type="button" title="Fit the whole monitor in the stage" onClick={p.fit}>
				Fit
			</button>
			<button
				type="button"
				aria-label="Zoom to content"
				title="Fit the selection, or all widgets when nothing is selected"
				onClick={p.focus}
			>
				<Icon name="focus" /> <span className="tool-label">Zoom to content</span>
			</button>
			<span className="zlevel" aria-label="Zoom level">
				{Math.round(p.zoom * 100)}%
			</span>
			<button
				type="button"
				popoverTarget={optionsId}
				onClick={(event) =>
					setPosition(
						selectMenuPlacement(
							event.currentTarget.getBoundingClientRect(),
							{ w: window.innerWidth, h: window.innerHeight },
							210
						)
					)
				}
				aria-label="Canvas options"
				title="Canvas options"
			>
				<Icon name="more" />
			</button>
			<div id={optionsId} popover="auto" className="stage-options" style={position}>
				<strong>Drop behavior</strong>
				<label className="chk">
					<input
						type="checkbox"
						checked={p.dropIntoFlow}
						onChange={(e) => p.onDropIntoFlow(e.currentTarget.checked)}
					/>
					into grids
				</label>
				<label className="chk">
					<input
						type="checkbox"
						checked={p.dropIntoCells}
						onChange={(e) => p.onDropIntoCells(e.currentTarget.checked)}
					/>
					into cells
				</label>
				{p.developer && (
					<button type="button" onClick={p.copyDebug}>
						⧉ Copy debug
					</button>
				)}
			</div>
		</div>
	);
}
