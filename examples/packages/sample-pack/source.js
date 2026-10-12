// Sample sandboxed source: current weather from open-meteo (no API key required).
//
// The contract (docs/dev/plugin-packages.md): assign `module.exports = { requests, transform }`.
// Both functions are PURE — this script runs in a QuickJS sandbox with no host access at all; the
// app fetches the URLs `requests()` returns (https-only, against the manifest's `hosts`
// allowlist) and hands the responses to `transform()`, which returns samples for the sensor ids
// declared in plugin.json. Edit the latitude/longitude for your location.
module.exports = {
	requests: function () {
		return [
			'https://api.open-meteo.com/v1/forecast?latitude=1.35&longitude=103.82&current=temperature_2m,wind_speed_10m'
		];
	},
	transform: function (responses) {
		var r = responses[0];
		if (!r || r.status !== 200) return [];
		var current = JSON.parse(r.body).current;
		if (!current) return [];
		return [
			{ sensor: 'temp', value: current.temperature_2m },
			{ sensor: 'wind', value: current.wind_speed_10m }
		];
	}
};
