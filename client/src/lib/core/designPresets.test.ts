import { expect, it } from 'vitest';
import {
	DESIGN_STYLES,
	DESIGN_DENSITIES,
	designPresetTokens,
	applyDesignPreset
} from './designPresets';
import { safeTokenEntry } from './tokens';

it('provides three independent style and readable density choices using valid tokens', () => {
	for (const style of DESIGN_STYLES)
		for (const density of DESIGN_DENSITIES)
			for (const [key, value] of Object.entries(designPresetTokens(style.id, density.id)))
				expect(safeTokenEntry(key, value)).toBe(true);
	expect(designPresetTokens('transparent', 'large')).toMatchObject({
		'--np-widget-bg': 'transparent',
		'--np-text-body': '20px',
		'--np-text-caption': '18px'
	});
});

it('preserves manual overrides, updates previous preset values, and replaces only on request', () => {
	const current = { '--np-text-body': '22px', '--np-accent': 'orange' };
	const result = applyDesignPreset(current, 'transparent', 'compact');
	expect(result['--np-text-body']).toBe('22px');
	const next = applyDesignPreset(result, 'soft', 'large');
	expect(next).toMatchObject({
		'--np-radius': '12px',
		'--np-text-body': '22px',
		'--np-text-caption': '18px',
		'--np-accent': 'orange'
	});
	expect(applyDesignPreset(next, 'instrument', 'comfortable', true)).toMatchObject({
		'--np-text-body': '16px',
		'--np-accent': 'orange'
	});
	expect(current).toEqual({ '--np-text-body': '22px', '--np-accent': 'orange' });
});
