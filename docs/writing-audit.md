# Writing audit — 12 October 2026

The audit covers the README, MCP instructions, and longer Studio help text.
It uses the [project writing rules](design-system.md#writing), which draw from ASD-STE100.

| Area                  | Issue                                                                          | Change                                                                                             |
| --------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| README                | Local desktop instructions were mixed with dashboard notes.                    | Give the complete layout its own section. Add steps for Smooth charts.                             |
| Sensors               | The README implied that every sensor waits for a visible widget.               | Separate baseline sampling from sampling on demand. State the Recycle Bin interval.                |
| Settings              | Theme, startup, diagnostics, and recovery help combined several actions.       | Use complete sentences with clear actions and results.                                             |
| MCP                   | Connection and browser setup used dense paragraphs.                            | Use numbered steps for setup and bullets for behavior. Keep the restart requirement visible.       |
| AI Provider           | The introduction implied that it configured the Studio assistant.              | Explain that AI widgets use provider settings. The Studio assistant uses installed agent settings. |
| Integrations          | Introductions used fragments, slash lists, and backend implementation details. | Explain what to enter and which widget to add. Keep sensor IDs exact.                              |
| Assistant and presets | Some help used shorthand instead of complete instructions.                     | Name Save, Undo, Model, and preset actions directly.                                               |

The review checks sentence length, action order, terminology, and factual accuracy.
Use factual headings and task prompts. Keep instructions direct.
Code, protocol identifiers, and license text retain their exact wording.

## README review — 13 October 2026

The README now focuses on installation, features, configuration, and troubleshooting.
The review removes slogans and gives recent changes the same weight as other features.

- Remove runtime details, sensor polling intervals, and upgrade cleanup notes.
- Remove individual widget dimensions and specialist controls from the feature summary.
- Combine agent setup into one short section. Link to the MCP guide for connection details.
- Move screenshot and reference generation commands to the development guide.
- Keep the preset images, setup steps, hardware support limits, and recovery shortcuts.
