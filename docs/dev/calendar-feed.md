# Calendar feed

The Agenda backend fetches the configured ICS address with a 1 MiB response limit.
The address stays in the protected backend configuration.
Before emitting telemetry, `calendar_for_bridge` keeps the event and timezone properties used by the renderer.
It removes descriptions, attendee addresses, attachments, URLs, and alarms.
It rejects missing or mismatched component boundaries and excessive nesting.

`agenda.calendar` carries this internal JSON value:

```json
{ "version": 1, "calendar": "BEGIN:VCALENDAR\r\n..." }
```

`calendar/expansion.ts` publishes the expanded event array as `agenda.list`, preserving the public sensor format.
It publishes loading and parse warnings as `agenda.parse`. It runs only while `agenda.list` has consumers.

`agenda.count` retains the basic source event count. It does not count expanded occurrences.
`agenda.list` remains an array of event objects. Existing widget bindings and gallery fixtures keep this shape.
`calendarFeedContract.ts` defines the frontend wire format.
Expanded events include an `id` derived from the series and original occurrence.
Meeting snoozes use this ID, so equal titles and times remain separate.
Legacy arrays without IDs remain readable.

## Expansion

`calendarFeed.ts` uses ICAL.js for recurrence expansion.
It supports RRULE, RDATE (including periods), EXDATE, legacy EXRULE, and recurrence exceptions.
UID and recurrence ID keep exceptions within their series.
SEQUENCE and DTSTAMP select the latest revision.
Cancelled events and occurrences are omitted.

Feed VTIMEZONE definitions take priority.
The browser's IANA timezone data supplies missing definitions.
The adapter uses the first occurrence in a daylight-saving fold and the preceding offset in a gap.
Invalid dates and unknown timezones produce warnings. They do not silently become local dates.
A malformed record does not remove other valid records.

Repeating events use a 366-day horizon. Non-repeating future events can exceed it.
The output keeps the first 2,048 upcoming or recent events in time order.
Historical events cannot consume the output limit.
Each series has a 250,000-step expansion budget, including recurring exclusions.
The parser reports truncated work.
A small, bounded cache shares identical recurrence patterns within a feed.

## Worker lifetime

`calendar/worker.ts` runs the parser away from the UI thread.
`calendar/processor.ts` shares one pending job and one completed snapshot per window.
All consumers of `agenda.list`, including custom widgets and formulas, receive the same expanded array.
Agenda and meeting reminders also subscribe to `agenda.parse`.
The snapshot is refreshed at the minute boundary. Labels use the existing widget clock.

A changed source cancels pending old work.
The last consumer releasing a pending job terminates its worker.
Completed workers are also terminated; only the bounded result remains cached.
Late replies cannot replace newer results.
Construction, dispatch, execution, and five-second timeout failures produce visible warnings.
They do not cache a successful result or reject an unobserved promise.

## Validation and dependency

Pure tests cover dates, timezones, recurrence rules, exceptions, and output budgets.
Processor and hook tests control reply order, cancellation, refresh, and failures.
The Agenda browser test sends ICS telemetry through the real worker and checks both widgets.
Backend tests check the minimal wire snapshot and private-field removal.

ICAL.js is bundled into the worker. It has no runtime dependencies.
Its license is copied to `client/public/licenses/ical.js.txt` and included in the frontend build.
The upstream project is [ICAL.js](https://github.com/kewisch/ical.js).
