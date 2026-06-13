// Self-sourcing RSS / headlines meter (binds:'none'): a list of feed titles. Like NetConnections it
// reads the telemetry hub from context and subscribes to the `rss.list` JSON sensor (which both
// demand-gates the backend poll AND carries the data). The fetch/parse happen server-side
// (widgetsack/src/rss.rs); this just renders the titles. BARE DOM; styled via --np-* / --rss-* tokens.
import { useContext, useEffect, useState, type CSSProperties } from 'react';
import { TelemetryHubContext } from '../telemetryContext';
import { parseRssList, type FeedItem } from '../../core/rss';
import './Rss.css';

const LIST = 'rss.list'; // real sensor: subscribing gates the poll on AND delivers the items

type Props = { title?: string; maxRows?: number; color?: string };

export default function Rss({ title = '', maxRows = 8, color }: Props) {
	const hub = useContext(TelemetryHubContext);
	const [items, setItems] = useState<FeedItem[]>([]);

	useEffect(() => {
		if (!hub) return;
		// Feeds refresh slowly (~15 min); re-read on each rss.list tick but only re-render on a change.
		let sig = '';
		const read = (): void => {
			const v = hub.sensor(LIST).getSnapshot().value;
			const next = parseRssList(v && v.kind === 'json' ? v.value : []);
			const ns = JSON.stringify(next);
			if (ns !== sig) {
				sig = ns;
				setItems(next);
			}
		};
		const off = hub.sensor(LIST).subscribe(read); // demand-gate + change notification
		read();
		return off;
	}, [hub]);

	const vis = items.slice(0, Math.max(0, maxRows));
	const vars = color ? ({ '--rss-accent': color } as CSSProperties) : undefined;

	return (
		<div className="rss np-rss" style={vars}>
			{title && (
				<div className="rss-head">
					<span className="rss-title">{title}</span>
				</div>
			)}
			{vis.length === 0 ? (
				<div className="rss-empty" data-part="empty">
					No headlines yet
				</div>
			) : (
				<ol className="rss-list">
					{vis.map((it, i) => (
						<li className="rss-row" key={i}>
							<span className="rss-bullet" aria-hidden="true">
								›
							</span>
							<span className="rss-item" title={it.link || it.title}>
								{it.title}
							</span>
						</li>
					))}
				</ol>
			)}
		</div>
	);
}
