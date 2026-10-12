# MCP and external agents

Use your own agent to control Widgetsack. You do not need to open the built-in assistant sidebar.
The MCP server and stdio bridge run in the installed executable. They do not need Node or a separate package.

## Connect

1. Open Studio, then **Settings → MCP**.
2. Turn on **Enable MCP**.
3. Select **Copy MCP configuration**. Add the configuration to your MCP client's server settings.
4. Keep Widgetsack running and Studio open. You can close the assistant sidebar.

The copied configuration uses a native stdio server:

```json
{
  "mcpServers": {
    "widgetsack": {
      "command": "C:\\path\\to\\widgetsack.exe",
      "args": ["--mcp"]
    }
  }
}
```

Use the command path from the MCP page. The bridge discovers the current local endpoint and its
per-launch access token. You do not need to copy a token or update an ephemeral port after each launch.
A `--multi` instance uses its own descriptor and data directory.

Clients can also use the authenticated Streamable HTTP endpoint in `mcp/server.json` below the app's
configuration directory. The descriptor contains the endpoint and bearer token. Do not share this file.
The transport follows the [MCP Streamable HTTP specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

## Tools

| Tool | Use |
| --- | --- |
| `studio_read` | Read the active editor target, layout, widget catalog, sensor IDs, work area, and revision. |
| `studio_apply` | Apply up to 32 edits against a revision returned by `studio_read`. Each batch is undoable. |
| `studio_verify` | Measure the rendered layout. Find missing nodes, zero-size boxes, overflow, hidden content, unknown widget types, and render errors. |
| `studio_screenshot` | Return a PNG of the current Studio webview for a vision-capable agent. Restore Studio if minimized. |

Ask the agent to **read → apply → verify → review a screenshot**. Use the returned widget IDs for
follow-up edits. A revision can be used once. If the editor changes, read it again before applying edits.
Read-only template previews cannot be edited.
Use `setConfig`, `setSensor`, or `setStyle` with the rendered namespaced ID to edit a widget
inside a group. A library instance becomes a standalone copy when its contents change; its
other instances stay unchanged. Use `setLayout` with an `id` and `gap` to adjust container spacing.

Changes appear live. Use **Undo** to reverse a batch. Use **Save** in Studio to keep the result.
Verification reports geometry and render health. It cannot establish that a design looks good.
Warnings can include intentional clipped or scrollable content; use the screenshot to check them.
The screenshot contains only the Studio webview, rather than your other desktop windows.

## Optional browser access

Turn on **Allow browser tools** in the MCP page, then restart Widgetsack. The page shows the
localhost WebView2 debugging endpoint. Connect a browser tool or Playwright through CDP to this endpoint.
Use its `/json/list` endpoint to find the Studio target; overlays use the same app-owned WebView2 process.
This option allows DOM inspection, interaction, and browser screenshots. Other local processes can use
this debugging port too. Turn it off and restart to close that access.

Browser access is off by default. MCP layout edits, structured verification, and native screenshots
work without it. No debugging port is added to an ordinary launch.

## Limits and recovery

- Layout tools need an open Studio window. They do not edit the layout file behind the editor.
- A changed monitor or editor target invalidates an old revision.
- Disabled MCP cancels pending requests. Expired requests cannot claim an edit.
- The HTTP server binds to `127.0.0.1`, checks a per-launch bearer token, and rejects browser Origin headers.
- If a model does not accept images, use `studio_verify` and review the screenshot yourself.
- The built-in assistant uses installed Pi, Codex, or Claude. Its model typeahead reads the installed
  Pi catalog and locally cached model IDs. Custom model IDs remain valid. Nothing is installed automatically.
