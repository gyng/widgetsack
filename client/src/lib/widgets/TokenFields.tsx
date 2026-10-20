// The friendly theme-token editor (molecule): renders the common TOKEN_FIELDS by `kind` — a colour
// swatch+text (ColorField), a font picker (text + datalist), or a plain text field (radius/gap) — and
// a "Clear N overrides" reset. ONE component, two call sites: the Themes section edits the GLOBAL
// overrides; the Inspector edits the SELECTED widget's own overrides. `onSet(key,'')` clears one key;
// `onClear` drops them all. `baseValues` (the last-saved values) drives the per-field dirty flag.
import { useId } from 'react';
import { TOKEN_FIELDS } from './themeTokens';
import ColorField from './ColorField';
import DesignPresets from './DesignPresets';

// Suggestions for the font fields (the value is still free text — any installed family works, and
// the studio @font-faces whatever it finds in the assembled CSS, see core/tokens.extractFontFamilies).
const COMMON_FONTS = [
	'Bahnschrift',
	'Segoe UI',
	'Segoe UI Variable',
	'Calibri',
	'Cascadia Code',
	'Consolas',
	'Arial',
	'Arial Narrow',
	'Tahoma',
	'Verdana',
	'Georgia',
	'Times New Roman',
	'Courier New',
	'Impact'
];

type Props = {
	values: Record<string, string>;
	baseValues?: Record<string, string> | null; // last-saved values → per-field dirty flag
	onSet: (key: string, value: string) => void;
	onClear: () => void;
	onApply?: (tokens: Record<string, string>) => void;
	labelClassName?: string; // 'tk-field' (Themes panel) | 'full' (Inspector)
	clearTitle?: string;
};

export default function TokenFields({
	values,
	baseValues,
	onSet,
	onClear,
	onApply,
	labelClassName = 'tk-field',
	clearTitle
}: Props) {
	const fontListId = useId();
	const count = Object.keys(values).length;
	// Commit a text/font field on blur only when it actually changed (no redundant undo/save entries).
	const commit = (key: string, next: string, cur: string) => {
		if (next !== cur) onSet(key, next);
	};

	return (
		<>
			{onApply && <DesignPresets values={values} onApply={onApply} />}
			{TOKEN_FIELDS.map((t) => {
				const v = values[t.key] ?? '';
				const dirty = baseValues ? (baseValues[t.key] ?? '') !== v : false;
				const cls = [labelClassName, dirty && 'dirty'].filter(Boolean).join(' ');
				return (
					<label key={t.key} className={cls}>
						{t.label}
						{t.kind === 'color' ? (
							<ColorField
								value={v}
								placeholder={t.ph}
								ariaLabel={t.label}
								onChange={(nv) => onSet(t.key, nv)}
							/>
						) : (
							<input
								type="text"
								key={`${t.key}:${v}`}
								defaultValue={v}
								placeholder={t.ph}
								aria-label={t.label}
								spellCheck={false}
								list={t.kind === 'font' ? fontListId : undefined}
								onBlur={(e) => commit(t.key, e.currentTarget.value, v)}
							/>
						)}
					</label>
				);
			})}
			<datalist id={fontListId}>
				{COMMON_FONTS.map((f) => (
					<option key={f} value={f} />
				))}
			</datalist>
			{count > 0 && (
				<button type="button" className="tk-clear" title={clearTitle} onClick={onClear}>
					Clear {count} override{count === 1 ? '' : 's'}
				</button>
			)}
		</>
	);
}
