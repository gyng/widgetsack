// TS mirror of the Agenda Rust status struct (widgetsack/src/agenda.rs). camelCase. A feed URL —
// nothing secret.

/** Non-secret agenda config from `agenda_config_status`. */
export type AgendaStatus = {
	configured: boolean;
	url: string;
	title: string;
	pollSeconds: number;
};
