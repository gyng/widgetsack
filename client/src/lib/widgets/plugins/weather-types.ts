// TS mirror of the weather Rust structs that cross the bridge (widgetsack/src/weather.rs). camelCase
// (the struct is `#[serde(rename_all = "camelCase")]`). Open-Meteo is keyless — nothing is secret.

/** Non-secret weather config from `weather_config_status`. */
export type WeatherStatus = {
	configured: boolean;
	latitude: number;
	longitude: number;
	unit: string;
	pollSeconds: number;
};
