# MCP implementation

The native server exposes Studio tools through authenticated Streamable HTTP.
The installed executable provides a stdio bridge through `--mcp`.
The bridge reads the current endpoint and access token from `mcp/server.json` in the configuration directory.
A `--multi` instance uses its own directory and descriptor.
Do not share the descriptor. It contains credentials.

## Tools and editor state

- `studio_read` returns the active target, monitor, layout, widget catalog, sensors, work area, and revision.
- `studio_apply` accepts up to 32 edits against a revision. Each batch creates one undo step.
- `studio_verify` measures rendered nodes and reports missing nodes, invalid sizes, overflow, hidden content, unknown types, and render errors.
- `studio_screenshot` returns a PNG of Studio. It restores a minimized Studio window.

Read before applying. Use each revision once.
A changed monitor or editor target invalidates the revision.
Template previews are read-only.

Use `setConfig`, `setSensor`, or `setStyle` with a rendered namespaced ID to edit a child in a group.
The edited instance receives its own definition. Other instances keep the shared definition.
Use `setLayout` with `id` and `gap` to change container spacing.

Verification measures layout behavior. It cannot determine whether a design is visually clear.
Review screenshots for typography, alignment, contrast, and spacing.
Screenshots contain Studio only.

## Transport and cancellation

The HTTP server binds to `127.0.0.1`.
It checks a per-launch bearer token and rejects browser Origin headers.
Disabling MCP cancels pending requests.
Expired requests cannot claim an edit.

## Browser access

Browser access is optional and requires a restart.
The local CDP endpoint exposes Studio and overlay webviews.
Use `/json/list` to select the intended target.
Other local processes can access this port while it is enabled.

See [the user guide](../mcp.md) for connection steps.
