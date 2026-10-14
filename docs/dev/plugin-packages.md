# Plugin packages

A package adds templates, an optional theme, and an optional sensor source.
Store each package in `%APPDATA%\io.github.gyng\plugins\<id>`.
The folder contains `plugin.json` and its declared assets.
Connection configuration files in `plugins/` are separate from package folders.

See [Plugins](../plugins.md) for installation and approval steps.
The [sample package](../../examples/packages/sample-pack) provides a working manifest, source, and theme.

## Manifest

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

The manifest has these constraints:

- `manifestVersion` must be `1`.
- The package ID must match the folder name. IDs contain 1–64 letters, digits, spaces, underscores, or hyphens.
- Template IDs use the same characters. Registry IDs use `pkg:<id>:<templateId>`.
- Template trees use the [layout format](layout-format.md). Invalid templates are dropped with a warning.
- Widget types must be registered. See the [widget reference](../widgets.md).
- Parameters use `key`, optional `label` and `default`, and `target` or `targets` paths into the tree.
- Parameter paths cannot include `__proto__`, `constructor`, or `prototype`.
- Theme and source assets use plain filenames inside the package folder. Subdirectories are not accepted.
- `theme.file` ends in `.css`. `source.file` ends in `.js`.
- `source.pollSeconds` defaults to 60 and is clamped to 15–3600 seconds.
- `source.hosts` lists exact lowercase hostnames. Schemes, ports, paths, wildcards, and IP literals are not accepted.
- `sensors` declares the IDs that the source can emit. Labels and units are optional.

Invalid source or sensor declarations disable the source and show a warning.
Valid templates and themes can still load.
Package theme CSS applies globally while enabled. See [Theming implementation](theming.md).

## Sensor source

Assign synchronous `requests` and `transform` functions to `module.exports`.
The sandbox has no network, DOM, Tauri, or filesystem bindings.
The host fetches data between these calls:

1. Call `requests()` to obtain up to eight HTTPS URLs.
2. Fetch each URL through the backend proxy.
3. Call `transform(responses)` to obtain up to 64 samples.

```js
// source.js: compute requests and samples in the sandbox.
module.exports = {
  requests: function () {
    return [
      "https://api.open-meteo.com/v1/forecast?latitude=1.35&longitude=103.82" +
        "&current=temperature_2m,relative_humidity_2m",
    ];
  },
  transform: function (responses) {
    var r = responses[0]; // { url, status, body } — a failed fetch arrives as status 0
    if (!r || r.status !== 200) return [];
    var data = JSON.parse(r.body);
    return [
      { sensor: "temp", value: data.current.temperature_2m },
      { sensor: "humidity", value: data.current.relative_humidity_2m },
    ];
  },
};
```

Responses preserve request order and contain `url`, `status`, and `body`.
Status `0` means the request failed or was refused.
Samples contain a declared `sensor` ID and a finite number or string value.
Strings can contain up to 1,024 characters.
Invalid samples are dropped with a warning.

Each call has an approximately 100 ms execution budget and a 16 MiB memory limit.
Source files are limited to 64 KiB.
A declared sensor `temp` in package `my-pack` becomes `pkg.my-pack.temp`.
The source also publishes `pkg.<id>.status` with `ok` or an error message.
Sources poll into each window's telemetry hub.
Choose a polling interval that meets the API's rate limits.

## Validation and network access

Packages start disabled. Approval is required before their features run.
Template scanning reports embedded pages, remote images, button actions, and styles.
Package frames stay sandboxed after parameter overrides.
The runtime uses import metadata on parameter bindings to preserve this policy.
Approval also names native PowerShell widgets and parameters that can change widget content, actions, or styles.
Unbalanced widget CSS is dropped.
Theme scanning reports remote resources and rules that can cover the window.
Changed features or flagged styles require new approval.

The Rust proxy re-reads the manifest and checks the enabled marker on disk.
It accepts HTTPS GET requests to approved hosts only.
Redirects, explicit ports, credentials, IP literals, and local hostnames are rejected.
Requests have a 10-second timeout and a 256 KiB response limit.
Native download and proxy errors omit request URLs, including credentials and query values.
A changed hosts list stops network access until the user approves it.
Package sensor names cannot replace built-in sensors or another package's sensors.

## Installation and updates

The installer downloads the manifest and declared assets from the same directory.
Package files have a 256 KiB limit for local reads and downloads.
Downloads have a 10-second timeout.
An unreadable or oversized local manifest remains visible as a package error, with removal available.
Downloads use HTTPS without redirects.
A staged package replaces the installed directory only after the download succeeds.
A failed install preserves the prior package.
The backend checks required manifest fields before staging files.
Asset filenames cannot replace `plugin.json` or `.install.json`.
Filenames must be unique. The check ignores letter case.
Invalid optional features produce frontend warnings instead of rejecting the package.

URL installations record provenance in `plugins/<id>/.install.json`.
Public package rows show the GitHub owner/repository or the direct URL's origin.
Credentials, paths, query values, and fragments stay out of the label.
Updates use the original source from the private install record.
Local copies have no update source.
Update checks compare version strings. Any difference can be offered as an update.
Updates must retain the installed package ID.
A new installation cannot overwrite an existing ID.

Removal stops the source and clears registration, enablement, and stored approvals.
If removal fails, the package and its approvals remain available.
