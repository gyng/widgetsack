// The Agenda data source (peer to rss-source). A Rust proxy source: the ICS fetch + parse happen
// server-side (widgetsack/src/agenda.rs, plugins/agenda.json) and the events arrive over the EXISTING
// `telemetry` event as an `agenda.list` JSON sample. This source only flips polling on/off and provides
// the bindable-id catalog.

import type { SensorCatalogEntry, SensorSource } from '../../core/plugin';
import { agendaConnect, agendaDisconnect } from './agenda-commands';

const ENTRIES: SensorCatalogEntry[] = [
	{ id: 'agenda.status', label: 'Agenda status' },
	{ id: 'agenda.count', label: 'Agenda event count' }
];

export const agendaSource: SensorSource = {
	id: 'agenda',
	start: async () => {
		await agendaConnect().catch(() => undefined);
		return () => {
			agendaDisconnect().catch(() => undefined);
		};
	},
	catalog: () => ENTRIES.map((e) => e.id),
	catalogEntries: () => ENTRIES
};
