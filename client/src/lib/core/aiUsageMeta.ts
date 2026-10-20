import type { WidgetMeta } from './widget';
import { defaultUsageProviders } from './aiUsage';
export const aiUsageMeta: WidgetMeta = {
	type: 'aiusage',
	label: 'AI Usage',
	category: 'Tools',
	binds: 'none',
	description:
		'Claude and Codex quotas, token activity, credit balances and banked resets, with optional local history graphs and consumption estimates. Add OpenRouter, OMP or custom JSON commands.',
	defaultSize: { w: 265, h: 44 },
	defaultConfig: {
		label: 'AI Usage',
		showHeader: false,
		providers: defaultUsageProviders().map((p) => ({
			...p,
			tokens: false,
			credits: false,
			other: false,
			eta: false
		})),
		compact: true,
		minimal: false,
		minimalIcons: false,
		providerIcons: true,
		interval: 900,
		timeout: 20
	},
	configFields: [
		{
			key: 'providerIcons',
			label: 'provider icons',
			kind: 'toggle',
			group: 'Appearance',
			help: 'Monochrome provider marks replace names in Compact and accompany names in Detailed. Choose each mark in the provider row.'
		},
		{
			key: 'minimal',
			label: 'minimal layout',
			kind: 'toggle',
			group: 'Appearance',
			help: 'Values only, one line per provider. Overrides provider density.'
		},
		{
			key: 'minimalIcons',
			label: 'provider icons in minimal',
			kind: 'toggle',
			group: 'Appearance',
			help: 'Optional provider icons instead of hiding labels entirely.'
		},
		{
			key: 'showHeader',
			label: 'show heading',
			kind: 'toggle',
			group: 'Appearance',
			help: 'Optional heading above the provider rows.'
		},
		{ key: 'label', label: 'heading', kind: 'text', group: 'Appearance', help: 'Widget heading.' },
		{
			key: 'providers',
			label: 'providers',
			kind: 'usageProviders',
			group: 'Data',
			help: 'Codex and Claude are enabled initially. Add providers, override commands and choose visible readings independently.'
		},
		{
			key: 'interval',
			label: 'refresh seconds',
			kind: 'number',
			min: 60,
			max: 3600,
			group: 'Behaviour',
			help: 'Backend requests are shared for 60 seconds across windows. Default: fifteen minutes.'
		},
		{
			key: 'timeout',
			label: 'timeout seconds',
			kind: 'number',
			min: 5,
			max: 60,
			group: 'Behaviour',
			help: 'Maximum duration of each provider refresh.'
		},
		{
			key: 'compact',
			label: 'compact layout',
			kind: 'toggle',
			group: 'Appearance',
			help: 'One line per provider with optional inline sparklines. Detailed layout includes estimates and full graph captions.'
		}
	]
};
