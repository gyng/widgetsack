// Self-sourcing network-connections panel (binds:'none'): which processes are talking to the
// internet right now, and how many of those go to PUBLIC remotes — security peace-of-mind, at a
// glance. Like Disks/Cpu it reads the telemetry hub from context: it subscribes to the
// `net.conn.list` JSON sensor (which both demand-gates the backend snapshot AND carries the data) and
// reads the `net.conn.{established,public,listening}` scalar totals alongside. Observability, not an
// IDS. BARE DOM; styled in NetConnections.css via --np-* tokens.
import { useContext, useEffect, useState, type CSSProperties } from 'react';
import { TelemetryHubContext } from '../telemetryContext';
import { parseConnList, visibleConns, connLevel, type ProcConn } from '../../core/netconn';
import './NetConnections.css';

const LIST = 'net.conn.list'; // real sensor: subscribing gates the snapshot on AND delivers the rows

type Props = { showListening?: boolean; maxRows?: number; color?: string };
type Snap = { rows: ProcConn[]; established: number; public: number; listening: number };

const EMPTY: Snap = { rows: [], established: 0, public: 0, listening: 0 };

export default function NetConnections({ showListening = false, maxRows = 8, color }: Props) {
	const hub = useContext(TelemetryHubContext);
	const [snap, setSnap] = useState<Snap>(EMPTY);

	useEffect(() => {
		if (!hub) return;
		const sc = (id: string): number => {
			const v = hub.sensor(id).getSnapshot().value;
			return v && v.kind === 'scalar' ? v.value : 0;
		};
		// Re-read on each net.conn.list tick, but only re-render when something actually changed — a
		// quiet machine then costs one cheap snapshot read per second and zero React work.
		let sig = '';
		const read = (): void => {
			const lv = hub.sensor(LIST).getSnapshot().value;
			const rows = parseConnList(lv && lv.kind === 'json' ? lv.value : []);
			const next: Snap = {
				rows,
				established: sc('net.conn.established'),
				public: sc('net.conn.public'),
				listening: sc('net.conn.listening')
			};
			const ns = JSON.stringify(next);
			if (ns !== sig) {
				sig = ns;
				setSnap(next);
			}
		};
		const off = hub.sensor(LIST).subscribe(read); // demand-gate + change notification
		read();
		return off;
	}, [hub]);

	const vis = visibleConns(snap.rows, showListening, maxRows);
	const vars = color ? ({ '--nc-accent': color } as CSSProperties) : undefined;

	return (
		<div className="netconn np-netconn" style={vars}>
			<div className="nc-head">
				<span className="nc-title">Connections</span>
				<span className="nc-summary" data-part="summary">
					<b>{snap.established}</b> active · <b className="nc-pub-total">{snap.public}</b> public
					{snap.listening > 0 ? ` · ${snap.listening} listening` : ''}
				</span>
			</div>
			{vis.length === 0 ? (
				<div className="nc-empty" data-part="empty">
					—
				</div>
			) : (
				<div className="nc-list">
					{vis.map((r) => (
						<div className="nc-row" key={`${r.pid}:${r.proc}`} data-level={connLevel(r)}>
							<span className="nc-proc" title={`pid ${r.pid}`}>
								{r.proc}
							</span>
							<span className="nc-counts">
								{r.public > 0 && (
									<span
										className="nc-pub"
										title={r.remotes.length ? r.remotes.join('\n') : 'public Internet'}
									>
										🌐 {r.public}
									</span>
								)}
								{r.established > r.public && (
									<span className="nc-est" title="established connections (incl. local)">
										{r.established}
									</span>
								)}
								{r.listening > 0 && (
									<span className="nc-lis" title="listening ports (accepting inbound)">
										⊜ {r.listening}
									</span>
								)}
							</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
