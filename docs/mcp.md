# MCP

Connect an external agent to Studio to edit and check layouts.

## Connect

1. Open Studio.
2. Open **Settings → MCP**.
3. Turn on **Enable MCP**.
4. Select **Copy MCP configuration**.
5. Add the configuration to your agent's MCP server settings.
6. Keep Widgetsack running and Studio open.

## Tools

| Tool                | Use                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `studio_read`       | Read the active editor target, layout, widget catalog, sensor IDs, work area, and revision.                                          |
| `studio_apply`      | Apply up to 32 edits against a revision returned by `studio_read`. Each batch is undoable.                                           |
| `studio_verify`     | Measure the rendered layout. Find missing nodes, zero-size boxes, overflow, hidden content, unknown widget types, and render errors. |
| `studio_screenshot` | Return a PNG of the current Studio webview for a vision-capable agent. Restore Studio if minimized.                                  |

Use this workflow:

1. Read the layout with `studio_read`.
2. Apply a batch with `studio_apply`.
3. Check the result with `studio_verify`.
4. Take a screenshot with `studio_screenshot`.
5. Review the screenshot before you accept the design.

Use the returned widget IDs for later edits. Use each revision once.
Read the layout again if the editor changes. Template previews are read-only.

Changes appear immediately. Use **Undo** to reverse a batch. Use **Save** in Studio to keep the result.
Cancel a request in your agent to stop pending work. Cancellation does not undo an applied batch.

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

## Troubleshooting

- Keep Studio open while the agent uses layout tools.
- Read the layout again after you change the monitor or editor target.
- Review screenshots yourself if the model cannot read images.

See [MCP implementation](dev/mcp.md) for transport and tool contracts.
