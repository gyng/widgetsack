import type { Tokens } from './tokens';

export const DESIGN_STYLES = [
	{
		id: 'transparent',
		name: 'Transparent',
		description: 'Unframed readings for a desktop overlay. Keeps the active theme colours.',
		tokens: { '--np-widget-bg': 'transparent', '--np-widget-shadow': 'none', '--np-radius': '2px' }
	},
	{
		id: 'instrument',
		name: 'Instrument',
		description: 'A restrained instrument surface with a thin border and square corners.',
		tokens: {
			'--np-widget-bg': 'var(--np-bg)',
			'--np-widget-shadow': 'inset 0 0 0 1px color-mix(in srgb, var(--np-fg) 18%, transparent)',
			'--np-radius': '2px'
		}
	},
	{
		id: 'soft',
		name: 'Soft',
		description: 'Rounded surfaces for standalone cards, using the active theme palette.',
		tokens: {
			'--np-widget-bg': 'var(--np-bg)',
			'--np-widget-shadow':
				'inset 0 0 0 1px color-mix(in srgb, var(--np-fg) 10%, transparent), 0 4px 16px rgb(0 0 0 / 12%)',
			'--np-radius': '12px'
		}
	}
] as const;

export const DESIGN_DENSITIES = [
	{
		id: 'compact',
		name: 'Compact',
		description: '14px readings / 12px captions',
		tokens: {
			'--np-text-body': '14px',
			'--np-text-caption': '12px',
			'--np-text-heading': '16px',
			'--np-line-body': '20px',
			'--np-line-caption': '16px',
			'--np-line-heading': '22px',
			'--np-gap': '4px',
			'--np-row-gap': '4px',
			'--np-control-size': '28px'
		}
	},
	{
		id: 'comfortable',
		name: 'Comfortable',
		description: '16px readings / 14px captions',
		tokens: {
			'--np-text-body': '16px',
			'--np-text-caption': '14px',
			'--np-text-heading': '20px',
			'--np-line-body': '24px',
			'--np-line-caption': '20px',
			'--np-line-heading': '28px',
			'--np-gap': '6px',
			'--np-row-gap': '8px',
			'--np-control-size': '32px'
		}
	},
	{
		id: 'large',
		name: 'Large',
		description: '20px readings / 18px captions',
		tokens: {
			'--np-text-body': '20px',
			'--np-text-caption': '18px',
			'--np-text-heading': '24px',
			'--np-line-body': '32px',
			'--np-line-caption': '28px',
			'--np-line-heading': '36px',
			'--np-gap': '8px',
			'--np-row-gap': '8px',
			'--np-control-size': '44px'
		}
	}
] as const;

export type DesignStyle = (typeof DESIGN_STYLES)[number]['id'];
export type DesignDensity = (typeof DESIGN_DENSITIES)[number]['id'];

export function designPresetTokens(style: DesignStyle, density: DesignDensity): Tokens {
	return {
		...DESIGN_STYLES.find((p) => p.id === style)!.tokens,
		...DESIGN_DENSITIES.find((p) => p.id === density)!.tokens,
		'--np-design-style': style,
		'--np-design-density': density
	};
}

/** Change managed preset values together; preserve manual edits and unrelated palette tokens. */
export function applyDesignPreset(
	current: Tokens,
	style: DesignStyle,
	density: DesignDensity,
	replace = false
): Tokens {
	const next = designPresetTokens(style, density);
	const managed: Tokens = {
		...DESIGN_STYLES.find((p) => p.id === current['--np-design-style'])?.tokens,
		...DESIGN_DENSITIES.find((p) => p.id === current['--np-design-density'])?.tokens
	};
	const result = { ...current, ...next };
	if (!replace)
		for (const [key, value] of Object.entries(current))
			if (!key.startsWith('--np-design-') && value !== managed[key]) result[key] = value;
	return result;
}
