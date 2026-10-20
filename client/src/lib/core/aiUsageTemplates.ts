import type { Template } from './templates';
import { container, leaf } from './layoutTree';
import { defaultUsageProviders } from './aiUsage';

const variants = [
	{
		id: 'minimal',
		name: 'Minimal quotas',
		w: 180,
		h: 44,
		config: {
			compact: true,
			minimal: true,
			minimalIcons: false,
			providers: defaultUsageProviders().map((p) => ({
				...p,
				tokens: false,
				credits: false,
				other: false,
				eta: false
			}))
		}
	},
	{
		id: 'compact',
		name: 'Compact quotas',
		w: 265,
		h: 44,
		config: {
			compact: true,
			providers: defaultUsageProviders().map((p) => ({
				...p,
				tokens: false,
				credits: false,
				eta: false
			})),
			resetDisplay: 'countdown'
		}
	},
	{
		id: 'detailed',
		name: 'Detailed activity',
		w: 350,
		h: 700,
		config: {
			compact: false,
			showResets: true,
			providers: defaultUsageProviders().map((p) => ({ ...p, graph: true })),
			resetDisplay: 'both'
		}
	},
	{
		id: 'remaining',
		name: 'Remaining allowance',
		w: 265,
		h: 44,
		config: {
			compact: true,
			remaining: true,
			providers: defaultUsageProviders().map((p) => ({
				...p,
				tokens: false,
				credits: false,
				eta: false
			})),
			resetDisplay: 'countdown'
		}
	}
];
export const aiUsageTemplates: Template[] = [
	...variants.map((v) => ({
		id: `ai-usage-${v.id}`,
		name: `AI Usage · ${v.name}`,
		description: `Claude and Codex: ${v.name.toLowerCase()}.`,
		size: { w: v.w, h: v.h },
		tree: () =>
			leaf({
				id: `ai-usage-${v.id}`,
				type: 'aiusage',
				rect: { x: 0, y: 0, w: v.w, h: v.h },
				config: { label: v.name, ...v.config }
			})
	})),
	{
		id: 'ai-usage-comparison',
		name: 'AI Usage · Compare layouts',
		description:
			'Live compact quotas, detailed activity with graphs, and remaining allowance side by side.',
		size: { w: 1132, h: 700 },
		tree: () =>
			container(
				'usage-comparison',
				'row',
				variants.map((v) =>
					leaf(
						{
							id: `compare-${v.id}`,
							type: 'aiusage',
							rect: { x: 0, y: 0, w: v.w, h: v.h },
							config: { label: v.name, ...v.config }
						},
						v.w
					)
				),
				{ gap: 24, align: 'start' }
			)
	}
];
