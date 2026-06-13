// The Agenda plugin: a server-side ICS poller (widgetsack/src/agenda.rs), a settings panel (feed URL),
// and a self-sourcing Agenda widget. Calling `registerAgendaPlugin()` (via plugins/index.ts) registers
// the source + the settings panel + the `agenda` widget type.

import { registerPlugin } from '../plugin';
import { agendaSource } from './agenda-source';
import AgendaSettings from './AgendaSettings';
import Agenda from '../meters/Agenda';
import { asMeter } from '../registry';

export const registerAgendaPlugin = (): void =>
	registerPlugin({
		id: 'agenda',
		name: 'Agenda',
		description:
			'Upcoming events from any ICS (iCalendar) feed URL — Google / Outlook / Fastmail, etc. Set the URL in this panel, then drop an Agenda widget.',
		sources: [agendaSource],
		settings: AgendaSettings,
		statusSensor: 'agenda.status',
		widgets: [
			{
				meta: {
					// Self-sourcing (binds:'none'): reads the agenda.list JSON sensor from the hub (which
					// demand-gates the backend poll), like the Connections / RSS widgets.
					type: 'agenda',
					binds: 'none',
					label: 'Agenda',
					description: 'Your upcoming calendar events from a configured ICS feed.',
					defaultSize: { w: 240, h: 150 },
					defaultConfig: { title: '', maxRows: 6 },
					configFields: [
						{ key: 'title', label: 'header', kind: 'text', help: 'optional title above the list' },
						{
							key: 'maxRows',
							label: 'events',
							kind: 'number',
							min: 1,
							max: 20,
							step: 1,
							help: 'how many upcoming events to show'
						},
						{ key: 'color', label: 'accent', kind: 'color' }
					]
				},
				component: asMeter(Agenda)
			}
		]
	});
