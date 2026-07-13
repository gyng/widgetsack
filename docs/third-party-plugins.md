# Third-party plugin packages

A **plugin package** is a folder you drop into the app-config `plugins/` directory that adds
templates (ready-made widget clusters), optionally a theme, and optionally a **sandboxed sensor
source** — a small `source.js` that polls an HTTP API and feeds custom sensors. Packages show up
in the studio's **Plugins** section under *Packages*, where each one is enabled per-machine
(everything starts **disabled** — installing a folder runs nothing until you flip its toggle).

```
%APPDATA%\com.widgetsack.app\plugins\
  ha.json, llm.json, …            ← first-party plugin configs (files — not packages)
  my-pack\                        ← a package is a DIRECTORY
    plugin.json                   ← the manifest (required)
    sky.css                       ← assets the manifest declares (optional)
    source.js                     ← sandboxed sensor source (optional, Phase 2)
```

> Templates and themes are declarative data; a package cannot render its own components. The
> only code surface is `source.js`, and it runs in a QuickJS sandbox with **zero capabilities**
> (no network, no DOM, no Tauri — the host does the fetching against a consented allowlist; see
> *Sandboxed sensor sources* below). The other sharp edge is **theme CSS** — see Security.

## Try the sample

A complete reference package — a parameterized clock template, a weather card driven by a
sandboxed [open-meteo](https://open-meteo.com) source, and a small theme — lives in this repo at
[`examples/packages/sample-pack`](../examples/packages/sample-pack). CI parses it, scans its
theme, and runs its `source.js` in the real sandbox on every build, so it can't drift from the
schema. Two ways to install it:

- **Copy**: drop the `sample-pack` folder into the app-config `plugins/` directory and reopen
  the studio's Plugins section.
- **Remote** (exercises the URL installer): *Plugins → Packages → Install from URL…* with
  `https://raw.githubusercontent.com/gyng/widgetsack/main/examples/packages/sample-pack/plugin.json`

Either way it lands disabled; enabling asks for consent to poll `api.open-meteo.com`.

## plugin.json

```json
{
	"manifestVersion": 1,
	"id": "my-pack",
	"name": "My pack",
	"version": "1.0.0",
	"description": "A clock cluster and a sky theme.",
	"author": "you",
	"homepage": "https://github.com/you/my-pack",
	"templates": [
		{
			"id": "big-clock",
			"name": "Big clock",
			"description": "HH:mm over a date line.",
			"size": { "w": 200, "h": 96 },
			"params": [
				{
					"key": "hour",
					"label": "Hour format",
					"default": "HH:mm",
					"targets": ["children.0.unit.config.format"],
					"choices": [
						{ "value": "HH:mm", "label": "24-hour" },
						{ "value": "h:mm A", "label": "12-hour" }
					]
				}
			],
			"tree": {
				"id": "bc-root",
				"kind": "col",
				"align": "stretch",
				"gap": 2,
				"children": [
					{
						"id": "bc-time",
						"unit": {
							"id": "bc-time",
							"type": "clock",
							"rect": { "x": 0, "y": 0, "w": 200, "h": 60 },
							"config": { "format": "HH:mm" }
						}
					},
					{
						"id": "bc-date",
						"unit": {
							"id": "bc-date",
							"type": "clock",
							"rect": { "x": 0, "y": 0, "w": 200, "h": 24 },
							"config": { "format": "ddd D MMMM" }
						}
					}
				]
			}
		}
	],
	"theme": { "name": "Sky", "file": "sky.css" },
	"source": {
		"file": "source.js",
		"pollSeconds": 600,
		"hosts": ["api.open-meteo.com"]
	},
	"sensors": [
		{ "id": "temp", "label": "Temperature", "unit": "°C" },
		{ "id": "humidity", "label": "Humidity", "unit": "%" }
	]
}
```

Field rules:

- **`manifestVersion`** must be `1`.
- **`id`** must equal the folder name — 1–64 chars of `A–Z a–z 0–9 space _ -`. Template ids use
  the same alphabet; the registry namespaces them as `pkg:<id>:<templateId>` so packages can
  never collide with built-ins or each other.
- **`templates[].tree`** is a layout node in the same JSON grammar as `widgets.json` (a
  container with `children`, or a leaf wrapping a widget `unit`). It goes through the layout
  file's structural whitelist — unknown fields are stripped, a malformed template is **dropped
  with a warning** (shown on the package's row) while the rest of the package still loads.
  Widget `type`s must be registered types (see [the widget reference](widgets.md)); a leaf with
  an unknown type renders as missing.
- **`templates[].params`** are insert-time options using the same `ParamSpec` grammar as the
  built-in templates and the widget designer: `key`, optional `label`/`default`, `target` or
  `targets` (dotted index paths into the tree, e.g. `children.0.unit.config.format`), and
  optional `choices` (rendering a select). See [templating & formulas](templating.md) for what
  config fields accept.
- **`theme.file`** must be a plain `<name>.css` filename inside the package folder (no
  subdirectories). The CSS is injected globally while the package is enabled — set `--np-*` /
  `--ui-*` tokens or target the stable widget hooks, exactly like a user theme
  ([theming reference](theming.md)).
- **`source`** (optional) declares a sandboxed sensor source:
  - `file` must be a plain `<name>.js` filename inside the package folder.
  - `pollSeconds` is the tick cadence, clamped to **15–3600** (default 60).
  - `hosts` is a **non-empty** list of bare lowercase hostnames the source may fetch from —
    no scheme, port, path, or wildcard, and no IP literals. Exact match only: a subdomain must
    be listed explicitly (`api.example.com` does not cover `cdn.api.example.com`).
- **`sensors`** declares the sensor ids the source may emit (`id` uses the same token alphabet
  as package ids; `label`/`unit` are optional display metadata for the sensor picker). Samples
  for undeclared ids are dropped.
- A malformed `source` or `sensors` block is **dropped with a warning** (shown on the package's
  row) — templates and theme still load; the poll loop just never starts.

## Sandboxed sensor sources (`source.js`)

`source.js` is CommonJS-shaped: assign `module.exports` an object with two **pure, synchronous**
functions. There is no `fetch`, no `setTimeout`, no host API of any kind inside the sandbox — the
host performs the network I/O *between* your two calls:

1. each tick the host calls `requests()` → you return the full https URLs to fetch (max **8**);
2. the host fetches each through the backend proxy (which enforces `hosts`);
3. the host calls `transform(responses)` → you return samples to ingest (max **64**).

A complete worked weather source against [open-meteo](https://open-meteo.com) (pairs with the
manifest above):

```js
// source.js — runs sandboxed: no network/DOM/Tauri access; just compute.
module.exports = {
	requests: function () {
		return [
			'https://api.open-meteo.com/v1/forecast?latitude=1.35&longitude=103.82' +
				'&current=temperature_2m,relative_humidity_2m'
		];
	},
	transform: function (responses) {
		var r = responses[0]; // { url, status, body } — a failed fetch arrives as status 0
		if (!r || r.status !== 200) return [];
		var data = JSON.parse(r.body);
		return [
			{ sensor: 'temp', value: data.current.temperature_2m },
			{ sensor: 'humidity', value: data.current.relative_humidity_2m }
		];
	}
};
```

Contract details:

- `requests(): string[]` — https URLs only, capped at 8 per tick. Anything else is dropped with
  a console warning. The **host** allowlist is enforced in the Rust proxy, not here.
- `transform(responses): { sensor, value }[]` — `responses` mirrors the request list in order as
  `{ url, status, body }` (status `0` = the fetch failed or was refused). Each returned `sensor`
  must be a declared `sensors[].id`; `value` must be a **finite number** or a **string ≤ 1 KiB**.
  Undeclared ids, non-finite numbers, and oversized strings are dropped (warned), and the batch
  is capped at 64 samples.
- Each call runs under a ~100 ms CPU deadline and a 16 MiB memory cap; `source.js` itself is
  capped at 64 KiB. A runaway/oversized script degrades to an error status, never a hang.
- **Sensor namespace:** a declared id `temp` in package `my-pack` surfaces in the sensor picker
  and formulas as `pkg.my-pack.temp`. The source also implicitly publishes
  `pkg.<id>.status` — a text sensor set to `ok` or `error: …` every tick, handy for a Text
  widget or for debugging a package.
- Sources poll **per window** into that window's telemetry hub, so an overlay-only widget bound
  to a package sensor works without the studio open. Keep `pollSeconds` honest — 60 s+ for
  anything rate-limited.

## How templates surface

An enabled package's templates appear under the package's name in two places: the **Layouts →
Add palette** ("Templates · My pack" — inserts a standalone copy onto the canvas) and the
**widget designer's** template list (preview, or ⎘-clone into an editable library widget that
keeps your `params` as instance params).

## Security model

- **Opt-in:** discovered packages register nothing until enabled; the toggle is a per-machine
  allowlist.
- **Structural validation:** manifests are parsed fail-closed; trees go through the layout
  whitelist; param paths that walk `__proto__`/`constructor`/`prototype` are rejected.
- **Theme CSS is the trust boundary:** it runs with full access to the studio's DOM, so it is
  scanned (remote `url()`/`@import`, viewport overlays — the same scan sack imports get) and a
  flagged theme asks for explicit confirmation on first enable. Don't enable packages from
  sources you don't trust.
- **The sandbox has zero capabilities.** `source.js` runs in a QuickJS-in-WASM interpreter with
  no host bindings whatsoever — it cannot fetch, touch the DOM, call Tauri, read files, or keep
  time beyond `Date`. The worst a hostile script can do is burn its ~100 ms CPU budget per tick.
- **The host does the fetching, against a Rust-enforced allowlist.** Every URL the source asks
  for goes through the backend's `package_fetch`, which **re-reads the manifest on disk** and
  checks the URL's host against `source.hosts` server-side — a compromised webview can't widen
  the list. https only, GET only, **redirects disabled** (a listed host can't bounce the request
  somewhere else), 10 s timeout, 256 KiB response cap. IP literals, explicit ports, and embedded
  credentials are rejected.
- **Network access is consented per hosts-list.** The first-enable confirm names every host
  (e.g. *"This package polls the network every 60s: api.open-meteo.com."* — combined with the
  theme-CSS warning when both apply, one dialog). Consent is stored against the exact hosts
  fingerprint: if an update changes the list, the source stays stopped until you re-confirm by
  toggling the package off and on.
- **Sensors are namespaced.** A package can only ever write `pkg.<its-id>.*` — it cannot spoof
  `cpu.total`, `ha.*`, or another package's sensors, and only ids it declared up front.

## Installing from a link

**Plugins → Packages → Install from URL…** fetches a package straight from the web. Accepted
forms:

| You paste                                    | What is fetched                                                  |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `owner/repo`                                  | `https://raw.githubusercontent.com/owner/repo/main/plugin.json`  |
| `https://github.com/owner/repo`               | same — the repo's `main` branch                                   |
| `https://github.com/owner/repo/tree/<ref>`    | the manifest on that branch/tag (the ref is pinned for updates)   |
| any `https://…/plugin.json` URL               | that exact manifest (self-hosted packages)                        |

The backend downloads the manifest plus every asset it declares (`theme.file` and `source.file`
— fetched from the same directory), stages the complete package beside `plugins/<id>/`, then swaps
the directory into place. A failed download or disk write leaves the prior package untouched.
Provenance is recorded in a sidecar, `plugins/<id>/.install.json`:

```json
{ "source": "owner/repo", "ref": "main", "version": "1.0.0", "installedAt": 1750000000000 }
```

(`source` is the verbatim URL and `ref` is `"direct"` for plugin.json links.) Hand-dropped
folders have no sidecar — they are "local" packages with no update affordances.

**Update checking is manual.** A row with a sidecar shows *Check updates*, which re-fetches just
the manifest from the recorded source and compares version strings — any difference offers
*Update* (a re-install from the same source; want a downgrade? that's just an update to the older
manifest). Nothing is checked or fetched in the background, ever.

*Remove* deletes the package folder (it works for local packages too), unregisters its templates
and theme live, stops its source, and clears its enable flag **and** any stored theme-CSS /
network consent — a re-installed package starts from zero trust. An *Update* that changes the
`source.hosts` list also drops the stored network consent: the new hosts stay unfetched until
you toggle the package off and on and confirm them. Theme-CSS consent is tied to the exact reviewed
stylesheet by a compact SHA-256 fingerprint (the CSS itself is not copied into local storage), so
changed threat-flagged CSS likewise remains uninjected until it is confirmed. If the filesystem
refuses a removal, the package stays enabled and its existing approvals remain intact.

Security of remote installs:

- **https only, no redirects** — `http://` sources are rejected; the GitHub shorthand forms always
  resolve to `raw.githubusercontent.com` over https, and manifest/asset redirects are rejected.
- **Size caps** — the manifest and each asset are capped at 256 KiB (10 s timeout); only
  `.css`/`.json`/`.js` filenames that pass the same allowlist as local packages are
  fetched/written.
- **Installs land disabled** — a fetched package goes through exactly the same opt-in toggle,
  structural validation, CSS threat scan, and first-enable consent (including the network-hosts
  confirm) as a hand-dropped folder. The link is a delivery mechanism, not a trust grant.
- **Package IDs cannot be overwritten by a fresh install** — remove the existing package first, or
  use its explicit *Update* action. Updates must return the same manifest ID as the installed row.

## Updating / removing

Packages installed from a link update from their row (see above). For a hand-dropped folder,
replace or delete the folder and reopen the Plugins section (it re-scans on open), or use the
row's *Remove* button. Disabling a package live-removes its palette group and theme; other
windows pick the change up on their next reload.
