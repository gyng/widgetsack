# MCP and external agents

Use your own agent to control Widgetsack. You do not need to open the built-in assistant sidebar.
The MCP server and stdio bridge run in the installed executable. They do not need Node or a separate package.

## Connect

1. Open Studio.
2. Open **Settings → MCP**.
3. Turn on **Enable MCP**.
4. Select **Copy MCP configuration**.
5. Add the configuration to your agent's MCP server settings.
6. Keep Widgetsack running and Studio open.

You can close the assistant sidebar.

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

Use this workflow:

1. Read the layout with `studio_read`.
2. Apply a batch with `studio_apply`.
3. Check the result with `studio_verify`.
4. Take a screenshot with `studio_screenshot`.
5. Review the screenshot before you accept the design.

Use the returned widget IDs for later edits. Use each revision once.
Read the layout again if the editor changes. Template previews are read-only.

Use `setConfig`, `setSensor`, or `setStyle` with the rendered namespaced ID to edit a widget
inside a group. The edited instance becomes a separate copy. Other instances keep their shared definition. Use `setLayout` with an `id` and `gap` to adjust container spacing.

Changes appear immediately. Use **Undo** to reverse a batch. Use **Save** in Studio to keep the result.

Verification checks widget sizes, clipping, and render errors. Review a screenshot to check appearance.
Scrollable content can produce a clipping warning. Check each warning before you change the layout.
The screenshot shows only Studio. It does not include other desktop windows.

## Optional browser access

Browser access is off by default. Layout edits, verification, and Studio screenshots work without it.

1. Turn on **Allow browser tools** in **Settings → MCP**.
2. Restart Widgetsack.
3. Copy the local browser endpoint from the MCP page.
4. Connect a browser tool or Playwright to this endpoint through CDP.
5. Open `/json/list` to find the Studio target.

Browser tools can inspect the DOM, operate controls, and take screenshots.
The port also exposes overlay webviews. Other programs on this machine can use it.
To close browser access, clear **Allow browser tools** and restart Widgetsack.

## Limits and recovery

- Layout tools need an open Studio window. They do not edit the layout file behind the editor.
- A changed monitor or editor target invalidates an old revision.
- Disabled MCP cancels pending requests. Expired requests cannot claim an edit.
- The HTTP server binds to `127.0.0.1`, checks a per-launch bearer token, and rejects browser Origin headers.
- If a model does not accept images, use `studio_verify` and review the screenshot yourself.
- The built-in assistant uses installed Pi, Codex, or Claude. Its model typeahead reads the installed
  Pi catalog and locally cached model IDs. Custom model IDs remain valid. Nothing is installed automatically.
