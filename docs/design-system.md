# Widgetsack design system

Widgetsack is a compact desktop control room. Keep its dark/teal character, clear readings,
and editable widget themes. Make the Studio easier to read and more consistent to operate.

## References and direction

Use [Fluent 2 typography](https://fluent2.microsoft.design/typography) and
[spacing](https://fluent2.microsoft.design/layout) as the structural reference. Borrow the quiet
surfaces, predictable actions, and reduced visual clutter from
[Linear's interface refresh](https://linear.app/now/behind-the-latest-design-refresh).

These references guide hierarchy and layout. Widgetsack owns its fonts, colors, and theme system.

- Studio uses locally bundled [IBM Plex Sans](https://github.com/IBM/plex), with system sans-serif fallbacks.
- Code, expressions, and identifiers use a separate monospace token.
- Widget readings retain Bahnschrift and the existing `--np-font` / `--np-font-display` overrides.
- Use teal for selection, focus, and useful emphasis. Reserve state colors for actual state.
- Prefer spacing and surface changes to repeated boxes and accent-colored borders.

## Typography

Define font size and line height together. Use weight 450 for Studio content and controls, and
600 for headings. The slightly firmer body weight improves small text on dark surfaces.
All sizes below are CSS pixels before the user's display scaling.

| Role | Size / line height | Use |
| --- | --- | --- |
| Caption | 12 / 16 | Helper text, units, timestamps, secondary metadata |
| Body | 14 / 20 | Controls, navigation, inspector fields, event names |
| Heading | 16 / 22 | Section and widget headings |
| Title | 20 / 26 | Panel titles and prominent values |
| Reading | 24 / 32 | Larger readings where the widget has room |

Do not use size alone to show importance. Combine placement, spacing, and weight. Avoid reducing
normal content to 10–11px to fit a fixed box. Allow controls to wrap or panels to scroll instead.
Use sentence case for Studio labels. Keep deliberate widget styling configurable.

Use tabular numerals for changing values, times, percentages, and aligned numeric columns. A
monospace font is useful for code and identifiers; it is not the default for every label and button.

## Spacing and controls

Use the existing small spacing steps, with larger steps for hierarchy. Measure gaps between boxes;
check text alignment separately.

| Gap | Intended use |
| --- | --- |
| 2px | Optical corrections and small details |
| 4px | A label and its supporting detail |
| 6px | Compact icon/text pairs |
| 8px | Related controls and rows |
| 12px | Compact panel padding and field groups |
| 16px | Normal panel padding and separation between groups |
| 24px | Major sections |
| 32px | Large structural separation |

Studio controls default to 32px minimum height. Use a 20px body line with space around it.
Compact secondary controls may use 28px when their labels and focus rings still fit. Checkbox and
radio glyphs keep their own size; their surrounding label is the click target. Preserve the
existing 44px widget touch-target option.

Use 4px control corners and 6px panel/menu corners. These are restrained defaults, not a reason to
wrap each row in a card. Keep the current theme colors and visible keyboard focus.

## Alignment and widget sizing

- Use a shared grid for repeated rows. Names, values, and actions keep the same columns.
- Give slider readouts and action buttons stable widths. Truncate long names with a full tooltip.
- Put secondary details below the primary label, in that label's column.
- Keep text on a common line-height. Align mixed-size text by its baseline when appropriate.
- Use equal calendar columns for weekday labels and dates. Center the today marker within its cell.
- Size preset slots for complete rows. Show a remaining count or allow scrolling; avoid half a row.

Widget typography has its own semantic `--np-*` defaults. These do not override explicit instance
CSS, theme fonts, or large meter readings. Migrate content widgets to shared defaults gradually;
do not globally replace every meter's font size with the Studio body size.

## Writing

Use [ASD-STE100](https://www.asd-ste100.org/STE_faq.html) as a writing reference for instructions and longer help text.
This is a product style guide, not a claim of full compliance with the controlled dictionary.

- Keep each instruction to one action. Put steps in a numbered list.
- Use short, complete sentences. Aim for at most 20 words in an instruction and 25 words in a description.
- Address the user directly. Prefer active verbs such as select, enter, open, save, and start.
- Use one term for one concept. Match the names of the visible controls.
- Explain the result and the next action. Put related choices in bullets.
- Replace shorthand, slash lists, and dense parenthetical text with complete sentences.
- Keep personality in headings and sample prompts. Keep operational instructions precise.
- Preserve API identifiers, code examples, product names, and legal text where exact words matter.

The sentence-length guidance comes from the [ASD-STE100 writing rules](https://www.asd-ste100.org/assets/files/ASD-STE100_ISSUE9.pdf).

## Implementation rules

The global token definitions live in `client/src/styles.css`. Widget theme defaults live in
`client/src/lib/core/tokens.ts`. Keep the existing `--text-*`, `--space-*`, and `--np-*` hooks usable.
Add semantic roles rather than scattering new font and spacing literals through components.

Bundle the font locally and retain its license. The app must not need a font CDN or a network
connection to render the Studio. Wait for fonts before taking documentation screenshots.
The packaged font license is `licenses/ibm-plex-sans.txt`.

## Validation

Review Layout, Inspector, Sensors, Plugins, Themes, Share, Settings, menus, and the assistant at
normal and narrow window widths. Check long labels, light and dark themes, keyboard focus, and
browser zoom. Widget previews must keep their own theme fonts.

Browser tests should prove readable type, usable controls, and real alignment. Avoid snapshots of
all CSS declarations. Run the repository gates and refresh affected documentation screenshots.
