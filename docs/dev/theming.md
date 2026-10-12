# Theming implementation

The [user theme reference](../theming.md) lists tokens and built-in themes.
This guide covers style assembly and selectors.

## Sources

- [tokens.ts](../../client/src/lib/core/tokens.ts) defines widget token defaults.
- [styles.css](../../client/src/styles.css) defines Studio tokens and global styles.
- [style.ts](../../client/src/lib/core/style.ts) handles scoped widget CSS.
- [StyleLayer.tsx](../../client/src/lib/widgets/StyleLayer.tsx) assembles rendered style layers.

Preserve existing token names when changing defaults.
Themes can override widget tokens and Studio tokens independently.
RGB channel tokens support solid and translucent color expressions.

## Cascade

Styles apply in this order:

1. Built-in defaults.
2. Selected theme.
3. Token overrides.
4. Custom widget styles.
5. Instance and group styles.

Token overrides remain active across theme changes.
Scoped widget rules use `&` to select the widget root.
Group token overrides apply within the group's scope.
Put global `@font-face` and `@keyframes` rules in theme CSS.

The style assembler uses these selectors:

| Selector                       | Scope                                  |
| ------------------------------ | -------------------------------------- |
| `[data-def="<id>"]`            | Every instance of a library definition |
| `[data-w="<id>"]`              | One rendered widget instance           |
| `[data-group][data-id="<id>"]` | One rendered group instance            |

Nested groups use namespaced IDs. Use the rendered ID when targeting an instance.
Use the existing widget root hooks rather than internal child markup where possible.
Check selectors against the rendered DOM before documenting them as stable.
Do not use theme CSS to hide required controls or cover the application window.

## Import review

Theme scanning reports remote resources and full-window rules.
Package approval is tied to the reviewed stylesheet fingerprint.
Changed flagged CSS requires new approval.
Sack imports use the same style review principles.
CSS scanning is a review aid. It does not make an untrusted stylesheet safe.

## Changes

Update semantic tokens instead of adding repeated font and spacing literals.
Preserve widget-specific fonts and instance overrides.
Check dark and light themes, long labels, focus rings, and narrow Studio widths.
See [Design system](design-system.md) for sizing rules.
Regenerate the public reference when token definitions or catalog entries change.
