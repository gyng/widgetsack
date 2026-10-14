# Dashboard widgets

Open **Layout** in Studio. Select **Add** to insert a widget.
Select the widget on the canvas to change its settings in the Inspector.
See the [widget reference](widgets.md) for all settings.

## Status / Alerts

Alerts appear when a numeric sensor reaches a configured threshold.
Missing readings do not trigger alerts.
Enter rules separated by semicolons:

```text
cpu.total|above|90|CPU busy;disk.c.used.pct|above|90|Disk C nearly full
```

Both `above` and `below` include the threshold value.
For an offline alert, add a Ping widget for the host.
Use its `net.ping.<host>.up` sensor with `below|0|Host offline`.

Select **Snooze** to hide an alert for the configured duration.
Snoozes end when the window session ends.

A configured Agenda feed can also provide meeting reminders.
Set **meeting reminder** to zero to disable them.
All-day and past events do not trigger reminders.
Calendar parse warnings remain visible so a missing reminder does not appear as “All clear”.
The overlay shows nothing when there are no alerts or calendar warnings.
The designer preview shows “All clear”.

## Service Health

Enter an HTTP or HTTPS endpoint in the widget settings.
The widget shows its status and response time.
It can also show certificate expiry when this information is available.

- Failed connections, HTTP errors, and invalid certificates show as down.
- Slow responses and certificates near expiry show a warning.
- Redirects show a warning. The widget does not follow them.
- Plain HTTP has no certificate expiry reading.

## App Audio / Microphone

Use a slider to adjust an application's output volume.
Select its mute button to mute that application.
The microphone button controls the default communications input device.
“Live” means unmuted. It does not mean an application is recording.

If a volume change fails, the slider returns to its last confirmed value.
An application that closes is removed from the list.

## Task Checklist

Enter a task to add it to the list.
Select its checkbox to mark it complete.
Use the remove control to delete it.

Each checklist keeps its own tasks across restarts.
Studio and the overlay share the same list for that widget.
Controls are disabled while you arrange the widget.
The widget shows an error if it cannot save tasks.

## Sensor History

Enter up to eight numeric sensor IDs, separated by commas.
All lines use the same scale.
Compare sensors with matching units, such as CPU and GPU percentages.

- Set a fixed scale or use automatic scaling.
- Set a threshold to shade values above it.
- Use the legend to read the minimum, average, and maximum values.
- Set history length in samples. One system-sensor sample usually represents one second.

Enable **Smooth charts** to animate chart changes.
This setting changes the display only. It does not change recorded values.
The app disables animation when reduced motion is enabled.

## Dashboard presets

Open **Share** to import a built-in preset.
The imported dashboard appears in **My widgets**.
Insert it into the layout, then select **Save**.

| Preset  | Contents                                          |
| ------- | ------------------------------------------------- |
| Work    | Clock, agenda, checklist, timer, and alerts       |
| Gaming  | Sensor history, GPU, ping, and now playing        |
| Home    | Clock, weather, agenda, service health, and tasks |
| Minimal | Clock, network rate, CPU history, and alerts      |

Configure Agenda and Weather in **Plugins**.
Enter your own endpoint for Service Health.
Use **Undo** to reverse an import.
