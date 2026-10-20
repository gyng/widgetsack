import { resolveProviderIcon } from '../core/providerIcons';
import type { UsageProvider } from '../core/aiUsage';
const assets = import.meta.glob<string>('../assets/provider-icons/*.svg', {
	eager: true,
	query: '?url',
	import: 'default'
});
export default function ProviderIcon({ provider }: { provider: UsageProvider }) {
	if (provider.icon === 'none') return null;
	const icon = resolveProviderIcon(provider);
	const url = icon && assets[`../assets/provider-icons/${icon}.svg`];
	return (
		<span
			className="usage-provider-icon"
			data-provider-icon={icon ?? 'command'}
			title={provider.label}
			aria-hidden="true"
			style={url ? { maskImage: `url("${url}")`, WebkitMaskImage: `url("${url}")` } : undefined}
		>
			{!url && (
				<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
					<path d="M2 4l4 4-4 4M8 12h6" />
				</svg>
			)}
		</span>
	);
}
