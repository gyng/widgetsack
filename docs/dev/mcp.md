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
- `studio_screenshot` returns a PNG of Studio. Restore Studio before capture.

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
The stdio bridge does not follow HTTP redirects.
It limits each request line to 256,000 bytes and each response to 32 MiB.
The response limit includes PNG screenshot data and JSON metadata.
It checks a per-launch bearer token and rejects browser Origin headers.
Disabling MCP cancels pending requests.
Expired or cancelled requests cannot claim an edit.
Pending requests are removed when their owning task ends or is aborted.

Initialization returns `Mcp-Session-Id`. Include this header on later HTTP requests.
The stdio bridge manages the header and accepts up to four concurrent tool requests.
Send `notifications/cancelled` with the request ID to stop pending work in that session.
Cancellation does not undo an edit that has already applied.
Use a new request ID for each request. String IDs are limited to 256 UTF-8 bytes.
Sessions and cancellation records are bounded. A short cancellation record handles requests that arrive after their cancellation message.
See the [MCP cancellation contract](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation).

## Browser access

Browser access is optional and requires a restart.
The local CDP endpoint exposes Studio and overlay webviews.
Use `/json/list` to select the intended target.
Other local processes can access this port while it is enabled.

See [the user guide](../mcp.md) for connection steps.
