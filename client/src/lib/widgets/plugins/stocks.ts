// The Stocks plugin: a server-side Yahoo Finance quotes source (widgetsack/src/stocks.rs), a settings
// panel, and a bespoke Ticker widget. Calling `registerStocksPlugin()` (via plugins/index.ts)
// registers the source + the settings panel + the `ticker` widget type. Quotes also bind as
// `stocks.<SYMBOL>.*` sensors on the built-in Text / Gauge / Sparkline meters.

import { registerPlugin } from '../plugin';
import { stocksSource } from './stocks-source';
import StocksSettings from './StocksSettings';
import Ticker from '../meters/Ticker';
import { asMeter } from '../registry';

export const registerStocksPlugin = (): void =>
	registerPlugin({
		id: 'stocks',
		name: 'Stocks',
		description:
			'Live stock / crypto quotes via Yahoo Finance (keyless). Add tickers in this panel, then bind stocks.<SYMBOL>.* sensors or drop a Stock Ticker widget.',
		sources: [stocksSource],
		settings: StocksSettings,
		statusSensor: 'stocks.status',
		widgets: [
			{
				meta: {
					// Multi-sensor ticker: the `sensors` map below derives the stocks.<symbol>.* ids from the
					// config; WidgetHost subscribes and passes the meter a props-only `sensors` map (no single
					// bound sensor → binds:none).
					type: 'ticker',
					binds: 'none',
					sensors: (config): Record<string, string> => {
						const sym = String(config.symbol ?? '')
							.trim()
							.toUpperCase();
						if (!sym) return {};
						const base = `stocks.${sym}`;
						return {
							price: `${base}.price`,
							change: `${base}.change`,
							series: `${base}.series`,
							currency: `${base}.currency`,
							state: `${base}.state`
						};
					},
					label: 'Stock Ticker',
					defaultSize: { w: 180, h: 110 },
					defaultConfig: {
						// Ship a working symbol out of the box: a freshly-dropped ticker shows a live quote
						// immediately (the poller auto-fetches whatever symbol a ticker demands — see
						// widgetsack/src/stocks.rs), instead of the "Set a symbol" placeholder.
						symbol: 'NVDA',
						label: '',
						decimals: 2,
						showSparkline: true,
						invertColors: false
					},
					configFields: [
						{
							key: 'symbol',
							label: 'symbol',
							kind: 'text',
							group: 'Data',
							help: 'e.g. AAPL, SPY, BTC-USD — must be in the Stocks plugin’s symbol list'
						},
						{
							key: 'label',
							label: 'label',
							kind: 'text',
							group: 'Data',
							help: 'header text (defaults to the symbol)'
						},
						{
							key: 'decimals',
							label: 'decimals',
							kind: 'number',
							group: 'Appearance',
							help: 'price decimal places'
						},
						{
							key: 'showSparkline',
							label: 'sparkline',
							kind: 'toggle',
							group: 'Appearance',
							help: 'show the intraday mini-chart'
						},
						{
							key: 'invertColors',
							label: 'invert up/down colours',
							kind: 'toggle',
							group: 'Appearance',
							help: 'red = up, green = down (East-Asian-market convention)'
						}
					]
				},
				component: asMeter(Ticker)
			}
		]
	});
