# AI Usage widget

The widget starts with Codex and Claude enabled in Compact mode, with the heading hidden and
quotas showing the allowance left. The left/used suffix is hidden by default; enable **Show left / used suffix** in a quota row’s settings when wanted. Refresh defaults to 15 minutes. Add **AI Usage** from the
Tools palette or choose a preset from the widget designer.

Each provider has a source, label and layout override. Its aligned reading rows combine a
visibility checkbox, label override, up/down controls and a settings button. Quota rows own
Used/Left and warning/critical thresholds. Graph owns its metric and history window; Rate / ETA
owns the rate window; Resets in owns date/countdown formatting. Refresh and timeout remain
widget-wide Behaviour settings.

## Sources

- **Codex:** the installed CLI's app-server, using its existing sign-in. Reads account
  rate limits, banked-reset count/expiry, and token activity. Window names come from duration;
  a missing short window is omitted. No reset credit is ever redeemed.
- **Claude:** the local Claude Code OAuth credential is read only by Rust, then used for the
  usage endpoint. Session and weekly quotas refresh separately from local token activity.
  Observed tokens count complete new assistant usage records in local CLI logs while this
  widgetsack process runs; tracking starts at EOF, includes cache reads/writes, and deduplicates
  streaming updates by message ID. It does not backfill old conversations or cover other devices.
  A separately labelled cached total includes the stats cache's computation date. Banked Claude
  resets are not fetched.
- **OpenRouter:** set the key in the environment variable named in provider settings
  (default `OPENROUTER_API_KEY`) before starting widgetsack. Reports API-key spend/allowance;
  account balance is separate and is queried only for a management key. Dollar spend is not a
  token allowance. Tokens need a custom activity source if the usage endpoint does not supply them.
- **OMP:** runs `omp usage --json --redact --no-extensions`; optionally filters by provider ID.
  Uses the CLI's active environment/profile. Empty reports are displayed as unavailable readings.
- **Custom command:** or a command override on any provider. Runs PowerShell without a visible
  terminal, with bounded output and timeout. **Test / activate** validates output and activates
  that exact command locally. Imported layouts do not activate commands. Overlays may execute
  only exact commands present in their saved layout; Studio can test unsaved edits.

## Custom JSON contract

Print one object to stdout, with diagnostics on stderr and exit status zero. Use environment
variables for secrets; commands and labels are exported with a layout. All timestamps are Unix
milliseconds. IDs must be unique and stable across refreshes.

```json
{
  "version": 1,
  "metrics": [
    {
      "id": "weekly",
      "label": "Weekly",
      "kind": "quota",
      "unit": "%",
      "period": "week",
      "scope": "account",
      "used": 42,
      "limit": 100,
      "resetsAt": 1792886400000
    },
    {
      "id": "tokens",
      "label": "Tokens",
      "kind": "tokens",
      "unit": "tokens",
      "period": "today",
      "scope": "local",
      "used": 1250000
    },
    {
      "id": "balance",
      "label": "Balance",
      "kind": "credits",
      "unit": "USD",
      "period": "balance",
      "scope": "account",
      "remaining": 24.8
    }
  ],
  "bankedResets": { "available": 2 },
  "note": "Optional source caveat"
}
```

Each metric needs `used` or `remaining`; `limit`, `resetsAt`, banked resets and their `expiresAt`
are optional. Numeric values must be finite and nonnegative. `session` and `week` are the
special quota periods; all other quota periods use the Other windows toggle. Tokens and
credits have independent visibility toggles. Use a different metric ID when the underlying
account or counter scope changes. Quota percentages are independent of token activity.

## History and estimates

Five-minute snapshots are retained in local webview storage for 30 days, bounded to 8,641
samples per source. Providers with identical source settings share history; renaming a provider
does not reset it. History is collected while a visible widget is mounted; no background daemon
is installed. Errors retain the last successful readings, mark them stale and suppress ETAs.

Graphs show the first visible metric of the selected kind as a cumulative sparkline. Gaps and
counter drops/top-ups break the line. No synthetic history is inserted. Rates need at least five
minutes of compatible observations and restart after missing readings, reset-window changes,
counter drops, top-ups, or gaps over two hours. Readings older than 30 minutes do not produce a
rate. ETAs divide remaining allowance or balance by observed consumption; an unknown allowance
produces a rate only. A reset earlier than estimated exhaustion is labelled "reset expected first".
These estimates assume recent consumption continues and do not predict future model prices.

## Verification

Pure and component tests cover parsing, counter transitions, estimates, command activation,
late refreshes and disposal. `client/e2e/aiUsage.spec.ts` covers palette insertion and provider
editing. To explicitly read the signed-in local accounts with the backend smoke test:

```powershell
cargo test live_usage_read_smoke -- --ignored --nocapture
```

## Density and placement

**Compact** defaults to 265 × 44: one 22px row per provider, short session/week captions, aligned
percentages and optional inline sparklines. **Minimal quotas** uses 180 × 44, hides item captions
and optionally shows provider icons. A custom item label overrides the hidden caption in Minimal.

Compact uses monochrome provider icons by default; turn off **provider icons** to show names.
Detailed shows icons beside names. Each provider has an **Icon** picker with Automatic, No icon,
and sixteen bundled marks, including Claude, Codex, OpenAI, DeepSeek, Gemini, Qwen, Grok,
Mistral, Meta, Ollama, OpenRouter, Perplexity, Cohere, Copilot, Anthropic and Moonshot/Kimi.
Automatic uses the built-in source or detects a known name in a custom command label / OMP account.
Unknown command providers use a terminal glyph. Icons follow the theme foreground and require no
network requests. Assets are from Lobe Icons under MIT; the license ships in `licenses/lobe-icons.txt`.
**Detailed activity** includes scopes, full graph captions and separate rate/reset sections.
All layouts use the widget theme's foreground, muted, accent and warning colours on a transparent
surface. The heading is optional and hidden initially.

Reading order applies across layouts. Disabled readings retain their place. Blank label overrides
restore default captions. Tokens use `Tok` and abbreviated values such as `1.25M` in Compact;
full source labels and scopes remain available on hover. Reset countdowns use minutes, hours,
days or weeks (`5m`, `13h`, `3d`, `1w`) and show `due` when the reset is pending refresh.

Rate cells have a fixed width and a reserved ETA cell, use `%/h` for quota consumption and show
`—` while collecting history. Unknown token allowances do not invent a balance: cumulative token
activity remains a consumed-token reading. Successful responses filtered to no visible readings
show “No selected readings”. Legacy widget-level display settings remain fallbacks for old layouts.

A 265px sidebar fits three 84px monitor-input buttons with two 6px gaps. A 70px switcher followed
by an 8px gap and 44px Compact usage widget leaves room below the sidebar's existing meters.

## Polling and errors

Presentation edits and visibility changes respect the current refresh deadline. Source changes
or explicit command activation may start a local request early; matching source demands share
the backend cache. HTTP 429 errors pause network retries for at least 15 minutes and honour a
longer numeric Retry-After header. Compact errors show “429 · paused” and keep their complete
reason on hover without expanding the widget.
