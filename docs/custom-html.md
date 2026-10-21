# Custom HTML widgets

Add **Custom HTML** from the Studio palette to build a self-contained widget with HTML,
CSS and JavaScript. These source fields live in the widget config, so layouts and exported
sacks carry the widget without a separate installation. The default example displays CPU
usage. An agent can edit the same fields through the widget catalog and layout tools.
Import and package enable reviews identify Custom HTML as executable content. Package consent
is invalidated when its inline sources or selected sensor scope change.

Use body markup in **HTML**, styles in **CSS**, and module code in **JavaScript**. Prefer
responsive CSS (`flex`, `grid`, percentages) so the same widget works at different sizes.
**Interactive** enables clicks in the overlay; it is off by default.

## Live data and theme

**Sensor IDs** is a comma or newline separated allowlist (maximum 32 IDs). Only selected
sensor snapshots are passed into the frame. Read a sensor as `state.sensors[id]`; its
`value` has a `kind` (`scalar`, `text`, `series`, `json`) and a `value` property. Numeric
history is available in `history`, with sample times in `historyTs` when supplied.

```js
const unsubscribe = widgetsack.subscribe(({ sensors, size, tokens }) => {
  const sample = sensors["cpu.total"]?.value;
  document.querySelector("#value").textContent =
    sample?.kind === "scalar" ? `${Math.round(sample.value)}%` : "—";
  // size.width / size.height are the widget's available CSS pixels.
  // size.pixelRatio supports a sharp canvas backing store.
});
```

`subscribe` immediately calls the listener with current state and returns an unsubscribe
function. `widgetsack.getState()` returns the latest snapshot. The document also dispatches
`widgetsack:update` events with the state in `event.detail`.

Resolved theme tokens are applied to the frame's root and available as `state.tokens`:

```css
main {
  display: flex;
  align-items: baseline;
  gap: var(--np-row-gap);
  color: var(--np-fg);
  font: var(--np-text-body)/var(--np-line-body) var(--np-font);
}
.label {
  color: var(--np-label);
}
.muted {
  color: var(--np-muted);
}
.chart {
  color: var(--np-accent);
}
```

Available tokens include foreground, labels, muted text, accent/state colours, font families,
caption/body/heading sizes, line heights, gaps, radius and control sizes. Theme and widget
size changes update the frame automatically in both Studio and the desktop overlay.
The frame receives size information; it does not resize the saved layout itself.

## Isolation and portable assets

Each document runs in an opaque-origin iframe with scripts enabled. It cannot read the
parent document, local files or Tauri APIs. There is no command, native action or unrestricted
sensor subscription bridge. The main application's script policy is unchanged; native
documents are served from a dedicated in-memory URI handler with a separate restrictive CSP.

Keep assets self-contained: inline SVG, data-URL images/fonts and bundled JavaScript work.
External fetches, embedded frames, CDN scripts and network image/font resources are blocked.
Paste a small library's source into the module field when its licence permits. Filesystem
paths and relative asset imports are not packaged. The native document limit is 512 KiB.
Use **Web Frame** for an existing hosted dashboard instead.

This is document isolation rather than a general network firewall: an iframe can navigate
its own frame to another URL. Keep imported source trustworthy and review which sensors it
receives. Navigation does not grant access to the application or native APIs.

As with other animated widgets, keep scripts efficient: a busy script can consume CPU.
JavaScript errors appear in the webview developer console. Editing any source field starts
a fresh document session, releasing the previous native document; deleting the widget also
releases it.
