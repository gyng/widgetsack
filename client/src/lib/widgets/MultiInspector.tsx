// Multi-select details pane (Figma-style): shown when 2+ widgets are selected. Edits the config
// fields COMMON to all selected widgets (applied to every one at once; differing values read
// "mixed"), plus bulk sizing and delete. Presentational — the merged fields/basis are computed by
// canvas/multiSelect.ts and the bulk apply lives in the Canvas (commitOp → one undo step). A list of
// the selected items lets you drop back to single-select to tweak one.
import type { MergedField, BasisSummary } from './canvas/multiSelect';
import type { AlignEdge, DistributeAxis } from '../core/align';
import type { LayoutOp } from './ops';
import Select from './Select';
import './MultiInspector.css';

// Align / distribute buttons (floating widgets only): each emits one op the Canvas applies as a
// single undo step via core/align.ts (alignRects / distributeRects).
const ALIGN_BUTTONS: { edge: AlignEdge; glyph: string; label: string }[] = [
	{ edge: 'left', glyph: '⇤', label: 'Align left' },
	{ edge: 'centre', glyph: '⇹', label: 'Align centres' },
	{ edge: 'right', glyph: '⇥', label: 'Align right' },
	{ edge: 'top', glyph: '⤒', label: 'Align top' },
	{ edge: 'middle', glyph: '⇳', label: 'Align middles' },
	{ edge: 'bottom', glyph: '⤓', label: 'Align bottom' }
];
const DISTRIBUTE_BUTTONS: { axis: DistributeAxis; glyph: string; label: string }[] = [
	{ axis: 'horizontal', glyph: '⇔', label: 'Distribute horizontally' },
	{ axis: 'vertical', glyph: '⇕', label: 'Distribute vertically' }
];

type Props = {
	items: { id: string; label: string }[]; // every selected node (click to focus just it)
	fields: MergedField[]; // config fields shared across the selected WIDGETS
	basis: BasisSummary | null; // shared sizing of the selected flow leaves, or null if not all flow
	onFocus: (id: string) => void;
	onPatchConfig: (key: string, value: unknown) => void;
	onSetBasis: (basis: 'fixed' | 'content' | 'grow') => void;
	onDelete: () => void;
	docked?: boolean;
	// The selected FLOATING widget ids (align/distribute only apply to free-placed widgets; in-flow
	// ones are positioned by their container). 2+ enables align, 3+ distribute. Emits via onOp.
	floatingIds?: string[];
	onOp?: (op: LayoutOp) => void;
};

const num = (v: unknown): number => {
	/* v8 ignore next -- number fields are produced only from numeric widget metadata values. */
	return typeof v === 'number' ? v : 0;
};
const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

export default function MultiInspector({
	items,
	fields,
	basis,
	onFocus,
	onPatchConfig,
	onSetBasis,
	onDelete,
	docked = false,
	floatingIds = [],
	onOp
}: Props) {
	const cls = ['inspector', 'multi'];
	if (docked) cls.push('docked');

	function renderField({ field, value, mixed }: MergedField) {
		const ph = mixed ? 'mixed' : undefined;
		if (field.kind === 'toggle') {
			return (
				<label key={field.key} className={mixed ? 'check mixed' : 'check'}>
					<input
						type="checkbox"
						ref={(el) => {
							if (el) el.indeterminate = mixed;
						}}
						checked={!mixed && !!value}
						onChange={(e) => onPatchConfig(field.key, e.currentTarget.checked)}
					/>
					{field.label}
				</label>
			);
		}
		if (field.kind === 'select') {
			return (
				<label key={field.key} className="full">
					{field.label}
					<Select
						value={mixed ? '' : str(value)}
						options={[
							...(mixed ? [{ value: '', label: '— mixed —' }] : []),
							...field.options.map((o) => ({ value: o, label: o }))
						]}
						onChange={(v) => onPatchConfig(field.key, v)}
						aria-label={field.label}
					/>
				</label>
			);
		}
		return (
			<label key={field.key} className="full">
				{field.label}
				<input
					type={field.kind === 'number' ? 'number' : 'text'}
					value={mixed ? '' : str(value)}
					placeholder={ph}
					onInput={(e) =>
						onPatchConfig(
							field.key,
							field.kind === 'number' ? num(Number(e.currentTarget.value)) : e.currentTarget.value
						)
					}
				/>
			</label>
		);
	}

	return (
		<div className={cls.join(' ')}>
			<div className="fields">
				<span className="hd">{items.length} widgets selected</span>

				<div className="multi-list">
					{items.map((it) => (
						<button key={it.id} type="button" className="multi-item" onClick={() => onFocus(it.id)}>
							{it.label}
						</button>
					))}
				</div>

				{fields.length > 0 ? (
					<>
						<span className="hd">Common properties</span>
						{fields.map(renderField)}
					</>
				) : (
					<div className="multi-note">
						No shared editable properties — click an item to edit it.
					</div>
				)}

				{floatingIds.length >= 2 && (
					<>
						<span className="hd">Align floating widgets</span>
						<div className="multi-align" role="group" aria-label="Align">
							{ALIGN_BUTTONS.map((b) => (
								<button
									key={b.edge}
									type="button"
									title={b.label}
									aria-label={b.label}
									onClick={() => onOp?.({ op: 'alignSelected', ids: floatingIds, edge: b.edge })}
								>
									{b.glyph}
								</button>
							))}
						</div>
						{floatingIds.length >= 3 && (
							<div className="multi-align" role="group" aria-label="Distribute">
								{DISTRIBUTE_BUTTONS.map((b) => (
									<button
										key={b.axis}
										type="button"
										title={b.label}
										aria-label={b.label}
										onClick={() =>
											onOp?.({ op: 'distributeSelected', ids: floatingIds, axis: b.axis })
										}
									>
										{b.glyph} {b.axis}
									</button>
								))}
							</div>
						)}
					</>
				)}

				{basis && (
					<label className="full">
						size along the row / column
						<Select
							value={basis === 'mixed' ? '' : basis}
							options={[
								...(basis === 'mixed' ? [{ value: '', label: '— mixed —' }] : []),
								{ value: 'fixed', label: "fixed — use each one's w/h" },
								{ value: 'content', label: 'fit to content' },
								{ value: 'grow', label: 'grow — stretch to fill' }
							]}
							onChange={(v) => onSetBasis(v as 'fixed' | 'content' | 'grow')}
							aria-label="size along the row / column"
						/>
					</label>
				)}

				<button type="button" className="multi-delete" onClick={onDelete}>
					✕ Delete {items.length}
				</button>
			</div>
		</div>
	);
}
