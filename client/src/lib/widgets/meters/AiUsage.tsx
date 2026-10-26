import {
	usageSourceKey,
	usageMetricItem,
	usageTrend,
	visibleUsageMetrics,
	type UsageMetric,
	type UsagePoint,
	type UsageProvider,
	type UsageSnapshot
} from '../../core/aiUsage';
import './AiUsage.css';
import ProviderIcon from '../ProviderIcon';
import {
	resolveUsageSettings,
	resolveUsageLayout,
	usageResetText,
	type UsageLayout,
	type UsageSettings
} from '../../core/aiUsageSettings';
export type UsageReading = {
	snapshot?: UsageSnapshot;
	history?: UsagePoint[];
	at?: number;
	error: string;
	busy: boolean;
};
export type AiUsageOptions = {
	layout?: UsageLayout;
	label?: string;
	showHeader?: boolean;
	showResets?: boolean;
	minimal?: boolean;
	minimalIcons?: boolean;
	providerIcons?: boolean;
	compact?: boolean;
	remaining?: boolean;
	resetDisplay?: UsageSettings['resetDisplay'];
	rateHours?: number;
	graphHours?: number;
	graphMetric?: UsageSettings['graphMetric'];
	warning?: number;
	critical?: number;
};
const number = (v: number, maximumFractionDigits = 2) =>
	new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits }).format(v);
const duration = (hours: number) => usageResetText(Math.max(60000, hours * 3600000), 0);
function valueText(m: UsageMetric, remaining: boolean, dense = false): string {
	const value =
		remaining && m.kind === 'tokens' && m.limit === undefined && m.remaining === undefined
			? m.used
			: remaining
				? (m.remaining ??
					(m.limit === undefined || m.used === undefined
						? undefined
						: Math.max(0, m.limit - m.used)))
				: (m.used ?? m.remaining);
	if (value === undefined) return 'Unavailable';
	if (dense && m.kind === 'tokens') return number(value);
	if (m.unit === 'USD') return `$${value.toFixed(2)}`;
	return `${number(value)}${m.unit === '%' ? '%' : ` ${m.unit}`}`;
}
export default function AiUsage({
	providers,
	readings,
	now,
	label = 'AI Usage',
	showHeader = false,
	showResets = false,
	minimal: legacyMinimal = false,
	minimalIcons = false,
	providerIcons = true,
	compact: legacyCompact = true,
	layout,
	remaining = true,
	resetDisplay = 'countdown',
	rateHours = 1,
	graphHours = 24,
	graphMetric = 'tokens',
	warning = 80,
	critical = 95,
	interval = 900
}: AiUsageOptions & {
	providers: UsageProvider[];
	readings: Record<string, UsageReading>;
	now: number;
	interval?: number;
}) {
	const density = resolveUsageLayout({ layout, minimal: legacyMinimal, compact: legacyCompact });
	const minimal = density === 'minimal';
	const compact = density === 'compact';
	return (
		<div className="np-ai-usage">
			{showHeader && (
				<header>
					<strong>{label}</strong>
					<span>{remaining ? 'Left' : 'Used'}</span>
				</header>
			)}
			{providers
				.filter((p) => p.enabled)
				.map((p) => {
					const reading = readings[usageSourceKey(p)];
					const metrics = visibleUsageMetrics(reading?.snapshot?.metrics ?? [], p);
					const dense = minimal || (p.compact === 'inherit' ? compact : p.compact === 'compact');
					const stale =
						!!reading?.error ||
						(reading?.at !== undefined && now - reading.at > Math.max(120, interval * 2) * 1000);
					const { graphHours: providerGraphHours, graphMetric: providerGraphMetric } =
						resolveUsageSettings(p.settings.graph, { graphHours, graphMetric });
					const providerRateHours = resolveUsageSettings(p.settings.eta, { rateHours }).rateHours;
					const graph = metrics.find((m) => m.kind === providerGraphMetric);
					const history = reading?.history ?? [];
					const points = graph
						? history
								.filter((point) => point.at >= now - providerGraphHours * 3600000)
								.map((point) => ({
									at: point.at,
									value:
										point.metrics.find((m) => m.id === graph.id)?.used ??
										point.metrics.find((m) => m.id === graph.id)?.remaining
								}))
								.filter(
									(point): point is { at: number; value: number } => point.value !== undefined
								)
						: [];
					const max =
						graph?.unit === '%' ? 100 : Math.max(1, ...points.map((point) => point.value));
					const resetMetrics = metrics.filter((m) => m.resetsAt !== undefined);
					const resetOptions = resolveUsageSettings(p.settings.resets, { resetDisplay });
					const renderResets = (dense: boolean) => (
						<div
							className={dense ? 'usage-inline-resets' : 'usage-resets-row'}
							style={{ order: p.order.indexOf('resets') + 1 }}
						>
							{(!minimal || p.labels.resets) && (
								<span className="usage-item-caption">
									{p.labels.resets ?? (dense ? '\u21bb' : 'Resets in')}
								</span>
							)}
							{resetMetrics.map((m) => (
								<span
									className="usage-reset-short"
									key={m.id}
									title={`${m.label}: ${new Date(m.resetsAt!).toLocaleString()}`}
								>
									{m.resetsAt! <= now
										? 'due'
										: dense || resetOptions.resetDisplay === 'countdown'
											? usageResetText(m.resetsAt!, now)
											: resetOptions.resetDisplay === 'date'
												? new Date(m.resetsAt!).toLocaleString()
												: `${usageResetText(m.resetsAt!, now)} · ${new Date(m.resetsAt!).toLocaleString()}`}
								</span>
							))}
						</div>
					);
					const renderRate = (m: UsageMetric, dense = false) => {
						const trend = usageTrend(history, m, now, providerRateHours);
						if (dense && trend.state === 'active')
							return (
								<span className="usage-rate-values" title={`${m.label}: ${trend.rate} ${m.unit}/h`}>
									<span>
										{number(trend.rate!, 1)}
										{m.unit === '%' ? '%' : ''}/h
									</span>
									<span className="usage-eta">
										{trend.etaHours !== undefined
											? trend.resetFirst
												? '↻'
												: `~${usageResetText(now + trend.etaHours * 3600000, now)}`
											: ''}
									</span>
								</span>
							);

						return (
							<small
								className="usage-estimate"
								title="Rate requires at least five minutes of compatible observations"
							>
								{trend.state === 'collecting'
									? dense
										? '\u2014'
										: 'Rate: collecting history'
									: trend.state === 'idle'
										? dense
											? 'idle'
											: 'Rate: idle'
										: `${number(trend.rate!)} ${m.unit}/h${trend.etaHours !== undefined ? (trend.resetFirst ? ' · reset expected first' : ` · ~${usageResetText(now + trend.etaHours * 3600000, now)}`) : ''}`}
							</small>
						);
					};
					const graphPath = points
						.map((point, i) => {
							const previous = points[i - 1];
							const gap =
								!previous ||
								point.at - previous.at > Math.max(600000, interval * 2000) ||
								(graph?.used === undefined
									? point.value > previous.value
									: point.value < previous.value);
							return `${gap ? 'M' : 'L'}${Math.max(0, ((point.at - (now - providerGraphHours * 3600000)) / (providerGraphHours * 3600000)) * 300)},${43 - (point.value / max) * 40}`;
						})
						.join(' ');
					if (dense)
						return (
							<section
								key={p.id}
								className="usage-provider usage-compact-row"
								aria-label={`${p.label} usage`}
								title={reading?.error || (stale ? 'Stale' : p.label)}
							>
								{(minimal ? minimalIcons : providerIcons) ? (
									<ProviderIcon provider={p} />
								) : (
									!minimal && <strong>{p.label}</strong>
								)}

								{metrics.map((m) => {
									const item = resolveUsageSettings(p.settings[usageMetricItem(m)], {
										remaining,
										showResets,
										resetDisplay,
										warning,
										critical
									});
									return (
										<span
											className="usage-inline-metric"
											data-kind={m.kind}
											data-mode-label={item.showMode || undefined}

											style={{ order: p.order.indexOf(usageMetricItem(m)) + 1 }}
											key={m.id}
											title={`${m.label} · ${m.kind === 'tokens' ? 'tracked tokens' : item.remaining ? 'left' : 'used'} · ${m.scope}`}
										>
											{(!minimal || p.labels[usageMetricItem(m)]) && (
												<span className="usage-metric-label">
													{p.labels[usageMetricItem(m)] ??
														(m.kind === 'tokens'
															? 'Tok'
															: m.period === 'week'
																? 'W'
																: m.period === 'session'
																	? 'S'
																	: m.label)}{' '}
												</span>
											)}
											<b>
												<span>{valueText(m, item.remaining || m.period === 'balance', true)}</span>
											</b>
											{m.kind === 'quota' && item.showMode && (
												<span className="usage-value-mode">{item.remaining ? 'left' : 'used'}</span>
											)}
										</span>
									);
								})}
								{p.eta && !stale && metrics.length > 0 && (
									<span
										className="usage-inline-rate"
										aria-label="Rate / ETA"
										style={{ order: p.order.indexOf('eta') + 1 }}
										title={metrics[0].label}
									>
										{p.labels.eta && <span className="usage-item-caption">{p.labels.eta}</span>}
										{renderRate(metrics[0], true)}
									</span>
								)}
								{(p.resets || showResets) && resetMetrics.length > 0 && renderResets(true)}
								{p.banked && reading?.snapshot?.bankedResets && (
									<span style={{ order: p.order.indexOf('banked') + 1 }} title="Banked resets">
										{p.labels.banked ?? '↺'} {reading.snapshot.bankedResets.available}
									</span>
								)}
								{p.graph && (
									<svg
										style={{ order: p.order.indexOf('graph') + 1 }}
										className="usage-inline-graph"
										viewBox="0 0 300 45"
										preserveAspectRatio="none"
										role="img"
										aria-label={`${p.label} ${p.labels.graph ?? 'history'}`}
									>
										<path fill="none" stroke="currentColor" strokeWidth="2" d={graphPath} />
									</svg>
								)}
								{stale && <span>Stale</span>}
								{reading?.error ? (
									<span className="usage-inline-status" role="status" title={reading.error}>
										?
									</span>
								) : !metrics.length ? (
									<span>
										{reading?.busy
											? 'Refreshing…'
											: reading?.snapshot
												? 'No selected readings'
												: 'Waiting'}
									</span>
								) : null}
							</section>
						);
					return (
						<section key={p.id} className="usage-provider" aria-label={`${p.label} usage`}>
							<div className="usage-row">
								<strong className="usage-provider-heading">
									{providerIcons && <ProviderIcon provider={p} />}
									{p.label}
								</strong>
								<small>
									{reading?.busy
										? 'Refreshing…'
										: stale
											? 'Stale'
											: reading?.at === undefined
												? 'Waiting'
												: `Updated ${duration(Math.max(0, now - reading.at) / 3600000)} ago`}
								</small>
							</div>
							{metrics.map((m) => {
								const item = resolveUsageSettings(p.settings[usageMetricItem(m)], {
									remaining,
									showResets,
									resetDisplay,
									warning,
									critical
								});
								const pct =
									m.limit && m.used !== undefined
										? Math.min(100, (m.used / m.limit) * 100)
										: undefined;

								return (
									<div
										className="usage-metric"
										key={m.id}
										style={{ order: p.order.indexOf(usageMetricItem(m)) + 1 }}
									>
										<div className="usage-row">
											<span>
												{p.labels[usageMetricItem(m)] ?? (m.kind === 'tokens' ? 'Tokens' : m.label)}
												{m.kind !== 'quota' ? ` · ${m.period}` : ''}
											</span>
											<strong>
												{valueText(m, item.remaining || m.period === 'balance')}
												{m.kind === 'quota' && item.showMode
													? item.remaining
														? ' left'
														: ' used'
													: ''}
											</strong>
										</div>
										{pct !== undefined && (
											<div
												className={`usage-track ${pct >= item.critical ? 'critical' : pct >= item.warning ? 'warning' : ''}`}
												role="meter"
												aria-label={`${p.label} ${m.label} quota used`}
												aria-valuenow={pct}
												aria-valuemin={0}
												aria-valuemax={100}
											>
												<div style={{ width: `${item.remaining ? 100 - pct : pct}%` }} />
											</div>
										)}

										<small>
											{m.scope}
											{m.unit === '%' ? ' · quota' : ''}
										</small>
									</div>
								);
							})}
							{p.eta && !stale && (
								<div className="usage-rate-row" style={{ order: p.order.indexOf('eta') + 1 }}>
									<strong>{p.labels.eta ?? 'Rate / ETA'}</strong>
									{metrics.map((m) => (
										<div key={m.id} title={m.label}>
											{renderRate(m)}
										</div>
									))}
								</div>
							)}
							{(p.resets || showResets) && resetMetrics.length > 0 && renderResets(false)}
							{p.banked && reading?.snapshot?.bankedResets && (
								<div
									className="usage-row usage-bank"
									style={{ order: p.order.indexOf('banked') + 1 }}
								>
									<span>{p.labels.banked ?? 'Banked resets'}</span>
									<strong>{reading.snapshot.bankedResets.available}</strong>
									{reading.snapshot.bankedResets.expiresAt !== undefined && (
										<small>
											Next expiry{' '}
											{new Date(reading.snapshot.bankedResets.expiresAt).toLocaleDateString()}
										</small>
									)}
								</div>
							)}
							{p.graph && (
								<div className="usage-graph" style={{ order: p.order.indexOf('graph') + 1 }}>
									<small>
										{p.labels.graph ??
											(graph
												? `${graph.label} · ${graph.scope} · ${providerGraphHours}h history`
												: `No ${providerGraphMetric} readings available`)}
									</small>
									{points.length > 1 ? (
										<svg
											viewBox="0 0 300 45"
											preserveAspectRatio="none"
											role="img"
											aria-label={`${p.label} ${graph?.label} history, cumulative readings`}
										>
											<path fill="none" stroke="currentColor" strokeWidth="1.5" d={graphPath} />
										</svg>
									) : (
										graph && <small>Collecting graph history</small>
									)}
								</div>
							)}
							{reading?.error && (
								<div className="usage-error" role="status" title={reading.error}>
									?
								</div>
							)}
							{reading?.snapshot && !metrics.length && (
								<small>No selected usage readings available.</small>
							)}
							{reading?.snapshot?.note && <small>{reading.snapshot.note}</small>}
						</section>
					);
				})}
			{!providers.some((p) => p.enabled) && <small>Add or enable a provider in Studio.</small>}
		</div>
	);
}
