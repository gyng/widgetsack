# AI widgets

Configure your provider in **Plugins → AI Provider**, then choose either widget in
**Layout → Add widget**. The Templates tab also offers both starting layouts.

| Widget        | Use it for                                                             | Controls                                                                               |
| ------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **AI Prompt** | A saved prompt with live sensor readings; display its latest response. | Prompt, sensor selection, interval/cron/manual schedule, refresh, optional read aloud. |
| **AI Chat**   | An interactive conversation with your provider.                        | Send a message, stop a reply, clear the conversation, custom title.                    |

AI Prompt was previously called AI Briefing. AI Chat was previously called AI Assistant.
Their saved type IDs (`assistant` and `aichat`) remain unchanged, and existing custom titles
are preserved. AI Chat conversations are shared by chat widgets within the same window.
The separate Studio assistant edits layouts and configures integrations.

## Prompt schedules

| Schedule            | Behavior                                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `manual` or blank   | Generate only when you select **Generate now**.                                                                                                 |
| `5m`                | Generate shortly after the overlay opens, then every five minutes. Intervals also accept `s`, `h`, and `d`; the minimum interval is 15 seconds. |
| `0 9 * * *`         | Generate during the 09:00 minute in your computer's local time.                                                                                 |
| `*/15 9-17 * * 1-5` | Generate every fifteen minutes during hours 09–17 on weekdays.                                                                                  |

Cron uses five fields: **minute hour day-of-month month weekday**. Numeric lists, ranges,
and steps are supported. Sunday is `0` or `7`. If both day-of-month and weekday are
restricted, either may match, following standard cron behavior.

Automatic runs happen only while the overlay is open. Studio uses manual refresh so editing
does not start paid requests. Cron is checked every 30 seconds, runs at most once per matching
minute, and does not catch up missed runs after the app closes or sleeps. Provider calls from
one prompt widget do not overlap; ticks arriving during a request coalesce into one follow-up.
