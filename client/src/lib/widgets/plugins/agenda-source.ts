// Backend worker lifetime belongs to the app. Window cleanup releases only local subscriptions.
// The Agenda data source (peer to rss-source). A Rust proxy source: the ICS fetch + parse happen
// server-side (widgetsack/src/agenda.rs, plugins/agenda.json). A minimal ICS snapshot arrives over
// `telemetry` as an `agenda.calendar` JSON sample; a shared worker supplies the `agenda.list` event array. This source only ensures polling is running and provides
// the bindable-id catalog.

import type { SensorCatalogEntry, SensorSource } from '../../core/plugin';
import { installAgendaExpansion } from '../../calendar/sourceClient';
import { agendaConnect } from './agenda-commands';

const ENTRIES: SensorCatalogEntry[] = [
	{ id: 'agenda.status', label: 'Agenda status' },
	{ id: 'agenda.count', label: 'Agenda event count' }
];

export const agendaSource: SensorSource = {
	id: 'agenda',
	start: async (hub) => {
		const stop = installAgendaExpansion(hub);
		await agendaConnect().catch(() => undefined);
		return stop;
	},
	catalog: () => ENTRIES.map((e) => e.id),
	catalogEntries: () => ENTRIES
};
