// A per-side box editor (margin / padding) for the Inspector: a lock toggle plus one (locked) or
// four (unlocked) numeric inputs for top/right/bottom/left. Locked is the DEFAULT — convenient for
// the common uniform case; unlock to set sides independently. Emits the compact `Pad` shape:
// `undefined` when every side is 0 (clears the field), a plain number when uniform, else {t,r,b,l}.
// Presentational + controlled (the parent owns the value); the only local state is the lock intent,
// and a non-uniform value always shows four inputs regardless (one field can't represent it).
import { useState } from 'react';
import type { Pad } from '../core/layoutTree';
import { clampSpacing } from './canvas/spacingGuard';
import './BoxField.css';

type Sides = { t: number; r: number; b: number; l: number };

const SIDES = ['t', 'r', 'b', 'l'] as const;
const SIDE_LABEL: Record<(typeof SIDES)[number], string> = {
	t: 'top',
	r: 'right',
	b: 'bottom',
	l: 'left'
};

const toSides = (v: Pad | undefined): Sides =>
	v === undefined
		? { t: 0, r: 0, b: 0, l: 0 }
		: typeof v === 'number'
			? { t: v, r: v, b: v, l: v }
			: v;

const uniform = (s: Sides): boolean => s.t === s.r && s.r === s.b && s.b === s.l;

// Compact storage: all-zero → undefined (clear), uniform → a number, else the per-side object.
const toPad = (s: Sides): Pad | undefined => {
	if (!s.t && !s.r && !s.b && !s.l) return undefined;
	if (uniform(s)) return s.t;
	return s;
};

type Props = {
	label: string;
	value?: Pad;
	max?: number; // per-side cap (undefined → only floor at 0)
	onChange: (next: Pad | undefined) => void;
	dirty?: boolean;
};

export default function BoxField({ label, value, max, onChange, dirty }: Props) {
	const [locked, setLocked] = useState(true);
	const sides = toSides(value);
	// A non-uniform value can't be shown in one field, so it forces the four-input view even when the
	// lock intent is on (e.g. after selecting a different widget). Lock the icon to what's shown.
	const showLocked = locked && uniform(sides);

	const clamp = (n: number): number => clampSpacing(n, max);
	const emit = (next: Sides): void => onChange(toPad(next));

	const toggleLock = (): void => {
		if (showLocked) {
			setLocked(false);
			return;
		}
		setLocked(true);
		// Collapse to uniform using the top value so the single field has a clear meaning.
		emit({ t: sides.t, r: sides.t, b: sides.t, l: sides.t });
	};

	return (
		<div className={['boxfield', dirty && 'dirty'].filter(Boolean).join(' ')}>
			<span className="boxfield-label">{label}</span>
			<button
				type="button"
				className="boxfield-lock"
				aria-pressed={showLocked}
				aria-label={`${label} ${showLocked ? 'locked' : 'per-side'}`}
				title={
					showLocked
						? `${label}: all sides locked — click to set each side`
						: `${label}: per-side — click to lock all sides together`
				}
				onClick={toggleLock}
			>
				{showLocked ? '🔒' : '🔓'}
			</button>
			{/* step=2 keeps the steppers on the canvas spacing scale (2/4/6/8/16); typed values are free. */}
			{showLocked ? (
				<input
					type="number"
					min="0"
					max={max}
					step="2"
					aria-label={`${label} all sides`}
					value={sides.t}
					onInput={(e) => {
						const n = clamp(Number(e.currentTarget.value));
						emit({ t: n, r: n, b: n, l: n });
					}}
				/>
			) : (
				SIDES.map((k) => (
					<input
						key={k}
						type="number"
						min="0"
						max={max}
						step="2"
						aria-label={`${label} ${SIDE_LABEL[k]}`}
						title={SIDE_LABEL[k]}
						value={sides[k]}
						onInput={(e) => emit({ ...sides, [k]: clamp(Number(e.currentTarget.value)) })}
					/>
				))
			)}
		</div>
	);
}
