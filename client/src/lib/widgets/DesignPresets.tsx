import { useState, type CSSProperties } from 'react';
import {
	DESIGN_STYLES,
	DESIGN_DENSITIES,
	applyDesignPreset,
	type DesignStyle,
	type DesignDensity
} from '../core/designPresets';
import type { Tokens } from '../core/tokens';
import Select from './Select';

export default function DesignPresets({
	values,
	onApply
}: {
	values: Tokens;
	onApply: (tokens: Tokens) => void;
}) {
	const [style, setStyle] = useState<DesignStyle>('transparent');
	const [density, setDensity] = useState<DesignDensity>('large');
	const [replace, setReplace] = useState(false);
	const tokens = applyDesignPreset(values, style, density, replace);
	return (
		<fieldset className="design-presets">
			<legend>Widget design preset</legend>
			<label>
				Style
				<Select
					aria-label="Design style"
					value={style}
					options={DESIGN_STYLES.map((p) => ({ value: p.id, label: p.name }))}
					onChange={(v) => setStyle(v as DesignStyle)}
				/>
			</label>
			<p className="hint">{DESIGN_STYLES.find((p) => p.id === style)!.description}</p>
			<label>
				Density
				<Select
					aria-label="Design density"
					value={density}
					options={DESIGN_DENSITIES.map((p) => ({ value: p.id, label: p.name }))}
					onChange={(v) => setDensity(v as DesignDensity)}
				/>
			</label>
			<p className="hint">
				{DESIGN_DENSITIES.find((p) => p.id === density)!.description}. Explicit widget CSS keeps its
				own sizes.
			</p>
			<div
				aria-label="Design preset preview"
				style={
					{
						...tokens,
						padding: '8px',
						background: 'var(--np-widget-bg)',
						boxShadow: 'var(--np-widget-shadow)',
						borderRadius: 'var(--np-radius)',
						fontFamily: 'var(--np-font)',
						fontSize: 'var(--np-text-body)',
						lineHeight: 'var(--np-line-body)'
					} as CSSProperties
				}
			>
				<span
					style={{
						fontSize: 'var(--np-text-caption)',
						color: 'var(--np-muted)',
						marginRight: 'var(--np-gap)'
					}}
				>
					CPU
				</span>
				<b>37%</b>
				<span aria-hidden="true" style={{ marginLeft: 'var(--np-gap)', color: 'var(--np-accent)' }}>
					▁▂▅▃▆▅
				</span>
			</div>
			<label>
				<input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
				Replace matching token overrides
			</label>
			<p className="hint">
				Manual overrides are kept by default. Applying changes this token scope in one undoable
				edit.
			</p>
			<button type="button" onClick={() => onApply(tokens)}>
				Apply design preset
			</button>
		</fieldset>
	);
}
