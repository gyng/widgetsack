# Example layout

[rainmeter-port.widgets.json](rainmeter-port.widgets.json) is a version 2 layout fixture.
It contains 46 floating widgets on the primary monitor (`default`).
The layout includes clocks, system readings, network histograms, and now playing.
It uses 32 fixed per-core sensor IDs and Bahnschrift font tokens.

Use this file to inspect the JSON format or test migration.
For normal use, select built-in presets in Studio.
The built-in CPU widget discovers the available cores.
This fixture's fixed core grid can show missing readings on other machines.

## Load the fixture

Close Widgetsack before replacing its layout file.
Back up the current file, then copy the fixture:

```powershell
$layoutPath = "$env:APPDATA\io.github.gyng\widgets.json"
if (Test-Path -LiteralPath $layoutPath) {
    Copy-Item -LiteralPath $layoutPath -Destination "$layoutPath.bak"
}
Copy-Item -LiteralPath docs\dev\examples\rainmeter-port.widgets.json -Destination $layoutPath
```

Start Widgetsack and open Studio to inspect the layout.
See [Layout format](../layout-format.md) for the schema.
