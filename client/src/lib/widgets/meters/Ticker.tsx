// Stock/crypto ticker for the `stocks.<SYMBOL>.*` sensors fed by the Rust stocks poller
// (plugins/stocks.ts → widgetsack/src/stocks.rs). Props-only (AGENTS.md §6): the plugin meta's
// `sensors` map derives the five ids from the configured symbol, and WidgetHost subscribes and
// passes their live states in the `sensors` prop — the meter never touches the hub. Renders the
// symbol, last price, colour-coded change %, and an intraday sparkline (the real `.series`,
// falling back to the price history ring). Up/down colour flows from one `data-dir` on the root
// (the sparkline picks it up via currentColor), so the whole widget restyles from CSS.
import type { SensorState } from '../../core/telemetry';
import Sparkline from './Sparkline';
import {
	currencySymbol,
	direction,
	directionArrow,
	formatChangePct,
	formatPrice,
	marketLabel
} from './tickerFormat';
import './Ticker.css';

// The named states WidgetHost resolves from the meta's `sensors` map (plugins/stocks.ts).
type TickerSensors = {
	price?: SensorState;
	change?: SensorState;
	series?: SensorState;
	currency?: SensorState;
	state?: SensorState;
};

type Props = {
	symbol?: string;
	label?: string; // overrides the symbol shown in the header
	decimals?: number;
	showSparkline?: boolean;
	// Swap the up/down colours (red = up, green = down) — the East-Asian-market convention.
	invertColors?: boolean;
	sensors?: TickerSensors;
};

const numeric = (s: SensorState | undefined): number | null =>
	s?.value?.kind === 'scalar' ? s.value.value : null;
const textOf = (s: SensorState | undefined): string | null =>
	s?.value?.kind === 'text' ? s.value.value : null;

export default function Ticker({
	symbol = '',
	label = '',
	decimals = 2,
	showSparkline = true,
	invertColors = false,
	sensors = {}
}: Props) {
	const sym = symbol.trim().toUpperCase();

	if (!sym) {
		return (
			<div className="np-ticker" data-part="root" data-empty="true">
				<span className="np-ticker-msg" data-part="placeholder">
					Set a symbol
				</span>
			</div>
		);
	}

	const priceVal = numeric(sensors.price);
	const changeVal = numeric(sensors.change);
	const cur = textOf(sensors.currency);
	const market = marketLabel(textOf(sensors.state));
	const dir = direction(changeVal);
	const loading = priceVal === null;

	const seriesValue = sensors.series?.value;
	const series = seriesValue?.kind === 'series' ? seriesValue.value : [];
	const spark = series.length >= 2 ? series : (sensors.price?.history ?? []);

	return (
		<div
			className="np-ticker"
			data-part="root"
			data-dir={dir}
			data-invert={invertColors}
			data-loading={loading}
		>
			<div className="np-ticker-head">
				<span className="np-ticker-symbol" data-part="symbol">
					{label.trim() || sym}
				</span>
				{market && (
					<span className="np-ticker-state" data-part="state">
						{market}
					</span>
				)}
			</div>
			<div className="np-ticker-price" data-part="price">
				{loading ? '…' : `${currencySymbol(cur)}${formatPrice(priceVal, decimals)}`}
			</div>
			<div className="np-ticker-change" data-part="change">
				<span className="np-ticker-arrow" data-part="arrow">
					{directionArrow(dir)}
				</span>
				<span className="np-ticker-pct">{formatChangePct(changeVal)}</span>
			</div>
			{showSparkline && spark.length >= 2 && (
				<div className="np-ticker-spark" data-part="spark">
					<Sparkline history={spark} color="currentColor" seconds={spark.length} fill />
				</div>
			)}
		</div>
	);
}
