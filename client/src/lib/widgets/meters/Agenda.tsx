// Self-sourcing Agenda meter (binds:'none'): the upcoming events from an ICS feed. Like Connections it
// reads the hub from context and subscribes to the `agenda.list` JSON sensor (which demand-gates the
// backend poll AND carries the data); the fetch/parse happen server-side (widgetsack/src/agenda.rs).
// It rides the shared minute clock (useNow) so the relative "when" labels stay current. BARE DOM;
// styled via --np-*.
import { useContext, useEffect, useState, type CSSProperties } from 'react';
import { TelemetryHubContext } from '../telemetryContext';
import { useNow } from '../useNow';
import {
	parseAgendaList,
	upcomingEvents,
	formatEventWhen,
	type AgendaEvent
} from '../../core/agenda';
import './Agenda.css';

const LIST = 'agenda.list';

type Props = { title?: string; maxRows?: number; color?: string };

export default function Agenda({ title = '', maxRows = 6, color }: Props) {
	const hub = useContext(TelemetryHubContext);
	const [events, setEvents] = useState<AgendaEvent[]>([]);
	// Re-evaluate "upcoming" + relative labels each minute (the shared boundary-aligned clock).
	const now = useNow(60_000);

	useEffect(() => {
		if (!hub) return;
		let sig = '';
		const read = (): void => {
			const v = hub.sensor(LIST).getSnapshot().value;
			const next = parseAgendaList(v && v.kind === 'json' ? v.value : []);
			const ns = JSON.stringify(next);
			if (ns !== sig) {
				sig = ns;
				setEvents(next);
			}
		};
		const off = hub.sensor(LIST).subscribe(read); // demand-gate + change notification
		read();
		return off;
	}, [hub]);

	const vis = upcomingEvents(events, now, maxRows);
	const vars = color ? ({ '--ag-accent': color } as CSSProperties) : undefined;

	return (
		<div className="agenda np-agenda" style={vars}>
			{title && (
				<div className="ag-head">
					<span className="ag-title">{title}</span>
				</div>
			)}
			{vis.length === 0 ? (
				<div className="ag-empty" data-part="empty">
					No upcoming events
				</div>
			) : (
				<ol className="ag-list">
					{vis.map((e, i) => (
						<li className="ag-row" key={i}>
							<span className="ag-when">{formatEventWhen(e.start, e.allDay, now)}</span>
							<span className="ag-summary" title={e.location || e.summary}>
								{e.summary}
							</span>
						</li>
					))}
				</ol>
			)}
		</div>
	);
}
