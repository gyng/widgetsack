// A colour token input (atom, presentational): a native swatch for quick picking PLUS a text field
// that holds the exact value — so rgba() alpha and named colours (which the swatch can't represent)
// still round-trip. Editing the swatch writes `#rrggbb`; editing the text writes its raw value
// (committed on blur, so we don't churn an undo/save per keystroke). The swatch mirrors the current
// value (or the inherited placeholder when empty) via toHexColor. A ✕ clears the override.
import { useState } from 'react';
import { toHexColor } from './colorHex';
import { isValidColor } from './themeTokens';
import './ColorField.css';

type Props = {
	value: string; // the override ('' = none / inherit)
	placeholder?: string; // the inherited/default value, shown faint + reflected in the swatch
	ariaLabel?: string;
	onChange: (value: string) => void; // commit a new value ('' clears)
};

export default function ColorField({ value, placeholder, ariaLabel, onChange }: Props) {
	// Local text state so typing doesn't commit (and re-render the world) on every keystroke; resync
	// when the external value changes (Clear, theme switch, selecting another widget).
	const [text, setText] = useState(value);
	// Resync during render when the external value changes (Clear, theme switch, selecting another
	// widget) — the store-previous idiom, so typing (which only touches local `text`) isn't clobbered.
	const [prevValue, setPrevValue] = useState(value);
	if (value !== prevValue) {
		setPrevValue(value);
		setText(value);
	}

	const swatch = toHexColor(text || placeholder || '') ?? '#000000';
	const invalid = !isValidColor(text);

	return (
		<span className="color-field">
			<input
				type="color"
				className="cf-swatch"
				value={swatch}
				aria-label={ariaLabel ? `${ariaLabel} swatch` : 'colour swatch'}
				onChange={(e) => {
					setText(e.currentTarget.value);
					onChange(e.currentTarget.value);
				}}
			/>
			<input
				type="text"
				className="cf-text"
				value={text}
				placeholder={placeholder}
				aria-label={ariaLabel}
				aria-invalid={invalid}
				spellCheck={false}
				onChange={(e) => setText(e.currentTarget.value)}
				onBlur={() => {
					if (text !== value) onChange(text);
				}}
			/>
			{text ? (
				<button
					type="button"
					className="cf-clear"
					title="Clear this override"
					aria-label="clear"
					onClick={() => {
						setText('');
						onChange('');
					}}
				>
					×
				</button>
			) : null}
		</span>
	);
}
