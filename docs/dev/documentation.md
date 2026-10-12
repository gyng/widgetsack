# Documentation

## Audience and location

Write the README and root `docs/` guides for users.
Explain what the app does, how to complete a task, and how to recover from a failure.
Keep source paths, build commands, schemas, and implementation constraints in `docs/dev/`.
Link to developer material when a user needs an advanced reference.

## Writing rules

Use ASD-STE100-inspired language. This does not claim controlled-dictionary compliance.

- Use short, complete sentences and active verbs.
- Give each numbered step one action.
- Match visible control names and use one term for each concept.
- Use bullets for parallel choices or conditions.
- State behavior directly. Remove slogans, conversational filler, and promotional claims.
- Explain necessary limits where they affect a task.
- Keep implementation history and recent changes out of general guides.
- Preserve exact identifiers, code, and legal text.

Aim for no more than 20 words in an instruction and 25 words in a description.
Split longer sentences when this improves clarity.

## Generated references

The widget, template, and theme references are generated.
Edit their generators or source metadata instead of editing the output.

| Reference                                  | Generator                                                        |
| ------------------------------------------ | ---------------------------------------------------------------- |
| [Widgets](../widgets.md)                   | [widgetDocs.ts](../../client/src/lib/core/widgetDocs.ts)         |
| [Templates and formulas](../templating.md) | [templatingDocs.ts](../../client/src/lib/core/templatingDocs.ts) |
| [Themes](../theming.md)                    | [themingDocs.ts](../../client/src/lib/core/themingDocs.ts)       |

Run `npm run gen:docs` from `client/` after changes.
Run `npm run check:docs` to check freshness.
The [development guide](development.md) lists screenshot commands.

## Review

Check the intended audience, instructions, links, headings, tables, and code examples.
Render the changed guides locally to check their structure.
Check configuration facts against current code. Remove obsolete plans instead of treating them as implemented behavior.
