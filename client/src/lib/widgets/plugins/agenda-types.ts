// TS mirror of the Agenda Rust status struct (widgetsack/src/agenda.rs). camelCase. The feed URL
// is a SECRET (a calendar's "private address" embeds an unguessable token that reads the whole
// calendar), so it is held write-only on the Rust side: the status carries only its host.

/** Non-secret agenda config from `agenda_config_status` — never the URL itself. */
export type AgendaStatus = {
	configured: boolean;
	/** The saved feed's hostname ('' when unconfigured) — enough for the UI to say what is saved. */
	host: string;
	title: string;
	pollSeconds: number;
};
