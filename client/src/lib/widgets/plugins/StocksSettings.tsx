// The stocks plugin's settings pane (studio → Plugins → Stocks). A container (AGENTS.md §6): owns the
// symbol/interval form and drives the Tauri commands via stocks-commands.ts. The live badge reads the
// `stocks.status` telemetry sample through the hub (reusing the HA status→badge mapping). Below the
// form, the configured symbols' bindable `stocks.<SYMBOL>.*` ids are listed with copy-id. Reuses the
// shared `has-*` settings styles (loaded by the HA plugin).
import { useEffect, useState } from 'react';
import { useTelemetryHub } from '../telemetryContext';
import { useSensor } from '../useSensor';
import { haStatusBadge } from '../../core/haStatus';
import { copyToClipboard } from '../../overlay';
import {
	saveStocksConfig,
	stocksConfigStatus,
	stocksConnect,
	stocksDisconnect
} from './stocks-commands';
import { refreshStocksCatalog, stocksSource } from './stocks-source';
import { parseSymbols } from './stocks-symbols';
import TokenListField from './TokenListField';

export default function StocksSettings() {
	const hub = useTelemetryHub();
	const status = useSensor(hub, 'stocks.status');
	const badge = haStatusBadge(status.value?.kind === 'text' ? status.value.value : null);

	const [symbols, setSymbols] = useState<string[]>([]);
	const [pollSeconds, setPollSeconds] = useState(60);
	const [configured, setConfigured] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

	// Auto-dismiss the "Saved ✓" tick like a toast (it otherwise lingers until the next edit).
	useEffect(() => {
		if (!saved) return;
		const t = setTimeout(() => setSaved(false), 2500);
		return () => clearTimeout(t);
	}, [saved]);

	useEffect(() => {
		let alive = true;
		stocksConnect().catch(() => undefined);
		stocksConfigStatus()
			.then((s) => {
				if (!alive) return;
				setSymbols(s.symbols);
				setPollSeconds(s.pollSeconds);
				setConfigured(s.configured);
			})
			.catch(() => undefined);
		return () => {
			alive = false;
		};
	}, []);

	const dirtied = () => setSaved(false);
	const canSubmit = !saving;

	const onSave = async () => {
		if (!canSubmit) return;
		setSaving(true);
		setSaveError(null);
		try {
			await saveStocksConfig({ provider: 'yahoo', symbols, pollSeconds });
			await stocksDisconnect();
			await stocksConnect();
			await refreshStocksCatalog();
			setConfigured(symbols.length > 0);
			setSaved(true);
		} catch (err) {
			// Surface the failure instead of swallowing it (was a silent try/finally → unhandled rejection).
			setSaved(false);
			setSaveError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	const ids = stocksSource.catalogEntries?.() ?? [];

	return (
		<div className="has">
			<div className="has-statusline">
				<span className={`has-badge ${badge.tone}`} aria-live="polite">
					● {badge.label}
				</span>
				<span className="has-state-dim">{configured ? 'configured' : 'not configured'}</span>
			</div>

			<div className="rp-hd">Symbols</div>
			<div className="has-help">
				Live quotes via Yahoo Finance (no API key). Add tickers, then bind their{' '}
				<code>stocks.&lt;SYMBOL&gt;.*</code> sensors to a Text / Gauge / Sparkline widget — or drop
				a <strong>Stock Ticker</strong> widget and set its symbol. Equities (<code>AAPL</code>,{' '}
				<code>SPY</code>), crypto (<code>BTC-USD</code>), indices (<code>^GSPC</code>).
			</div>

			<TokenListField
				label="Tickers"
				values={symbols}
				onChange={(next) => {
					setSymbols(next);
					dirtied();
				}}
				parse={parseSymbols}
				placeholder="AAPL — Enter to add, or paste a comma/newline list"
				listLabel="Tickers"
				emptyHint="No tickers yet — type one above and press Enter."
			/>

			<label className="has-field">
				Poll interval (seconds)
				<input
					type="number"
					min={15}
					max={3600}
					step={5}
					value={pollSeconds}
					onChange={(e) => {
						setPollSeconds(Number(e.currentTarget.value) || 60);
						dirtied();
					}}
				/>
			</label>

			<div className="has-warn">
				⚠ Yahoo&rsquo;s endpoint is unofficial and best-effort — it can rate-limit or change without
				notice. Polling is paused automatically while no ticker is shown.
			</div>

			<div className="has-actions">
				<button
					type="button"
					className="has-primary"
					onClick={onSave}
					disabled={!canSubmit}
					aria-busy={saving}
				>
					{saving ? 'Saving…' : 'Save & refresh'}
				</button>
				{saved && <span className="has-ok">Saved ✓</span>}
			</div>
			{saveError && <div className="has-test err">Couldn&rsquo;t save: {saveError}</div>}

			<div className="rp-hd">Sensors</div>
			<div className="has-help">
				Bindable ids for the configured symbols. Copy an id (⧉) onto a Text, Gauge or Sparkline
				widget.
			</div>
			{symbols.length ? (
				<ul className="has-entities" aria-label="Stock sensors">
					{ids.map((e) => (
						<li key={e.id} className="has-entity">
							<span className="has-entity-name" title={e.id}>
								{e.label ?? e.id}
							</span>
							<code className="has-entity-id" title={e.id}>
								{e.id}
							</code>
							<button
								type="button"
								className="has-copy"
								title="Copy sensor id"
								aria-label={`Copy sensor id ${e.id}`}
								onClick={() => void copyToClipboard(e.id)}
							>
								⧉
							</button>
						</li>
					))}
				</ul>
			) : (
				<div className="has-help">No symbols yet — add some above and save.</div>
			)}
		</div>
	);
}
