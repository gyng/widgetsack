// TS mirror of the RSS Rust status struct that crosses the bridge (widgetsack/src/rss.rs). camelCase
// (the struct is `#[serde(rename_all = "camelCase")]`). Public feeds — nothing is secret.

/** Non-secret RSS config from `rss_config_status`. */
export type RssStatus = {
	configured: boolean;
	url: string;
	count: number;
	title: string;
	pollSeconds: number;
};
