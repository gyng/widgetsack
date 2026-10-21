# Studio workflow improvements

This tracks the complete user-approved set of usability suggestions. A checkbox requires implementation and verification; shared foundations alone do not complete a workflow.

- [x] Shared catalog in Layout and Build: identical search, categories, list/cards, previews, favourites; context-specific Add, Edit and Make a copy actions.
- [x] Edit a widget in place from Layout, retain desktop and selection, show monitor/widget/selection breadcrumbs, Done and Back to layout. Build remains a library-management shortcut.
- [x] Useful creation starts: templates, built-in widgets, duplicate saved widgets and Save selection as reusable widget. Blank canvas is an advanced choice.
- [x] Simple configuration with common source/content/appearance settings first, expressions/JSON/unusual layout controls under Advanced.
- [x] Predictable reuse: explain placement-only vs shared edits, accurately report usage across monitors/layouts, and offer an independent copy before shared changes.
- [x] Selection arrangement tools: vertical stack, horizontal row, equal spacing, fit to content; preview proposed geometry before applying with one undo step.
- [x] Visual Minimal / Compact / Detailed choices plus density/design-system previews, applicable to a widget, group or full layout.
- [x] Use Layout / Build / My widgets vocabulary consistently and update guides and screenshots.

## Validation

Require focused pure/component contracts, browser journeys for new workflows and geometry, the full client coverage/check/lint/build gates and Studio E2E. Preserve the Windows/backend gates after the frontend build. Review rendered Layout and Build at narrow and wide pane widths, keyboard navigation and a linked-widget edit across monitors.


Verified on 2026-10-21:

- Client type checking, formatting and zero-warning lint pass.
- 4,677 unit/component tests pass with 100% statements, branches, functions and lines.
- Widget/templating/theme generated documentation checks and production build pass.
- All 124 Studio browser tests pass. Browser journeys cover shared favourites and readable catalog colours, creation starts, in-place editing and return context, arrangement preview/apply/undo, content measurement, cross-monitor usage and independent copies, and scoped/layout presentation presets. Narrow saved rows retain separate clickable action areas; wide catalog cards keep fixed columns.
- Backend: 445 tests pass, five intentionally ignored; Clippy and rustfmt pass.
- User guide and Studio screenshot updated. The native multi-instance dev process remains responsive; live native integration behavior was not re-inspected visually in this pass.
