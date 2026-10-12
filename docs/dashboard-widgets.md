# Dashboard widgets

Add the new widgets from the studio palette or preview them in the Widget designer.

## Status / Alerts

Alerts appear when a configured numeric sensor reaches its threshold. Missing readings are ignored.
The default rules cover high CPU, memory, and disk C usage. Rules use this format, separated by
semicolons (newlines also work in JSON):

```text
cpu.total|above|90|CPU busy;disk.c.used.pct|above|90|Disk C nearly full
```

`above` and `below` include equality. For a reachability alert, add a Ping widget for your NAS and use
its `net.ping.<host>.up` sensor with `below|0|NAS offline`. Snooze hides an individual alert for the
configured number of minutes. Snoozes last for the current window session.

When Agenda has a configured ICS feed, timed events within the meeting reminder window appear too.
Set **meeting reminder** to zero to disable them. All-day and past events do not trigger reminders.
When nothing needs attention, the live widget renders no content; the designer shows “All clear”.

## Service Health

Set an HTTP or HTTPS endpoint in properties. The widget tries HEAD and falls back to GET when the
server returns 405 or 501, without consuming the response body. It reports the HTTP status and
response time, and shows certificate expiry when the TLS stack supplies a certificate.
HTTP errors, connection failures, and invalid certificates show as down; slow responses and
certificates nearing expiry show as warnings. Redirects show as warnings without being followed.

Checks have a 10-second timeout, run at least 15 seconds apart, and pause while the window is hidden.
The 10-second budget covers both requests if a fallback is needed. Plain HTTP has no certificate expiry reading.

## App Audio / Microphone

Each audio session on the default output gets its own volume slider and mute button. Slider writes
are serialized and rapid pending changes coalesce. A disappeared session reports an error rather
than targeting a different app. The microphone button controls the **default communications input**;
its “live” status means unmuted, not proof that an app is recording. Reads pause while hidden.
Failed slider writes restore the confirmed value. An output-device error does not disable an
available microphone, and audio sessions that disappear mid-read do not hide the other apps.

## Task Checklist

Add a task, tick it complete, or remove it. Tasks persist by widget ID and sync across the studio and
overlay using browser storage. Different checklist widgets, including copies of a dashboard, have
independent lists. Legacy shared content remains available until a copy saves its own list. Controls are
disabled while arranging the widget. A storage failure is shown in the widget.

## Sensor History

Enter up to eight comma-separated numeric sensor IDs. All lines share one automatic or fixed scale.
Compare matching units, such as CPU and GPU utilization; mixing bytes and percentages is misleading.
The optional threshold band shades values above the configured limit. The legend shows minimum,
average, and maximum for each visible window. The history length is measured in samples; at the
system sensors’ 1 Hz cadence it approximately equals seconds, up to the hub’s 600-sample buffer.

## Dashboard sacks

Open **Sacks** and import **Built-in: Work**, **Built-in: Gaming**, **Built-in: Home**, or
**Built-in: Minimal**. Each imports a styled reusable dashboard into **My widgets**, plus color tokens.
Insert the dashboard into your layout and save. Imports use the normal undoable library merge and
retain existing widget definitions. Undo the import to revert its library and token changes.

Work combines clock, agenda, checklist, timer, and alerts. Gaming combines history, GPU, ping,
app audio, and now playing. Home combines clock, weather, agenda, service health, and home tasks.
Minimal combines clock, network rate, CPU history, and alerts. Configure Agenda and Weather in
their existing plugin settings and enter your own Home Assistant health URL; no credentials or
guessed local addresses are bundled.
