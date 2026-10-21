import type { Template } from './templates';
import { leaf } from './layoutTree';
import { defaultUsageProviders } from './aiUsage';

// Live sidebar grouping, with typography inherited from the selected design density.
const compactCss = `.np-ai-usage { padding: 4px 0; --usage-provider-icon-size: var(--np-text-caption, 18px); --usage-column-gap: var(--np-gap, 8px); }
.np-ai-usage .usage-provider.usage-compact-row { min-height: var(--np-line-body, 32px); column-gap: var(--np-gap, 8px); row-gap: 4px; align-content: flex-start; }
.np-ai-usage .usage-inline-metric { gap: 3px; }
.np-ai-usage .usage-inline-metric > b { font-weight: 600; }
.np-ai-usage .usage-inline-resets { gap: 4px; }
.np-ai-usage .usage-reset-short { margin-left: 0; }
.np-ai-usage .usage-provider.usage-compact-row + .usage-provider.usage-compact-row { margin-top: var(--np-row-gap, 8px); }`;

const variants = [
	{
		id: 'minimal',
		name: 'Minimal quotas',
		w: 180,
		h: 44,
		css: '',
		config: {
			layout: 'minimal',
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
		w: 380,
		h: 112,
		css: compactCss,
		config: {
			layout: 'compact',
			providers: defaultUsageProviders().map((p) => ({
				...p,
				session: p.source === 'codex',
				tokens: false,
				credits: false,
				other: false,
				eta: true,
				resets: true,
				order:
					p.source === 'codex'
						? ['session', 'week', 'other', 'tokens', 'credits', 'eta', 'graph', 'resets', 'banked']
						: p.order
			})),
			resetDisplay: 'countdown'
		}
	},
	{
		id: 'detailed',
		name: 'Detailed activity',
		w: 350,
		h: 700,
		css: '',
		config: {
			layout: 'detailed',
			showResets: true,
			providers: defaultUsageProviders().map((p) => ({ ...p, graph: true })),
			resetDisplay: 'both'
		}
	}
];
export const aiUsageTemplates: Template[] = variants.map((v) => ({
	id: `ai-usage-${v.id}`,
	name: `AI Usage · ${v.name}`,
	description: `Claude and Codex: ${v.name.toLowerCase()}.`,
	size: { w: v.w, h: v.h },
	tree: () =>
		leaf({
			id: `ai-usage-${v.id}`,
			type: 'aiusage',
			rect: { x: 0, y: 0, w: v.w, h: v.h },
			config: structuredClone({
				label: v.name,
				showHeader: false,
				providerIcons: true,
				remaining: true,
				...v.config
			}),
			...(v.css ? { css: v.css } : {})
		})
}));
