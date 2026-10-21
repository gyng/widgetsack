# Layout and Build

**Layout** arranges widgets on your monitors. **Build** creates and manages reusable widgets in **My widgets**. Both use the same widget catalog, search, categories, sample previews and List / Previews choices. The narrower Build pane uses a category dropdown.

## Find and add a widget

Open **Layout → Add**. Browse Widgets, Templates or My widgets, or search by name and description. Click a widget to add it, or drag it onto the canvas. Select it and open Configure to change its source, content, layout or appearance.

Star a widget or template to add it to **Favourites**. Favourites are shared by Layout and Build and survive restarts. Starring does not place a widget or change its settings.

Templates are working starting points. Clicking a template in Layout adds a separate copy; templates with options open a setup dialog first. Preview opens a read-only specimen. My widgets adds a copy linked to the saved widget.

## Make your own widget

Open **Build → New widget** and choose a starting point:

- **Start with a template:** preview a panel, then use its copy action to create an editable widget.
- **Start with a built-in widget:** start with a working clock, meter or control.
- **Copy from My widgets:** use the copy action beside a saved widget to keep the original intact.
- **Advanced → Create blank widget:** start from individual meters and containers.

Name the widget in Build. Done keeps it in My widgets. Add it to a monitor from Layout → Add → My widgets.

You can also select a widget, inline group or container in Layout and choose **Save as custom widget**. For multiple items, choose **Save selection as widget**. Floating widgets form one panel; flow items must share a parent container. The original pieces are replaced by one linked placement in the same undoable edit.

## Choose what an edit affects

The editing breadcrumb shows the monitor, reusable widget and current selection. Open a reusable widget from Layout to edit it in place. **Done** returns to the original workspace and placement; **Back to layout** returns directly to the monitor.

Placement parameters and appearance affect the selected placement. Shared name, dimensions, parameters and CSS are identified as shared settings.

Before opening a shared widget, Studio shows its known usage on monitors and in saved layouts. Choose **Edit all linked copies** to update the source. Choose **Edit only this placement** to give that placement an independent source first. From Build, **Make a copy** creates another entry in My widgets.

If a source cannot be read, usage is marked partly unavailable. The count shows known locations; it does not claim that unreadable layouts are unused. Refresh usage to check again.

## Arrange with a preview

Use Ctrl/Shift-click or a marquee to select several items, or select a container, then choose **Arrange…**. Review Before / After diagrams for a vertical stack, a row, equal horizontal or vertical spacing, or fitting content. Nothing changes until Apply arrangement; the result is one undo step.

Arrange floating widgets together, or choose siblings in the same container. Fit to content uses rendered text for intrinsic widgets such as Clock, and authored content sizes for panels. It does not change sensor bindings or provider setup.

## Choose a consistent look

In Appearance → Override theme, choose **Minimal**, **Compact** or **Detailed**, then a design style and density. The visual choices preview the amount of detail; style controls the surface and density controls readable text, spacing and control sizes.

Apply the preset to a widget or group from its Appearance controls. Use Themes → Tokens to apply it across the layout. Shared groups keep their source link: presentation choices are applied to that placement's resolved content. Sources, commands, provider credentials and the shared definition stay intact.

Registered display controls determine which extra labels, charts and readings each widget supports. Date-only clock formats and authored HTML keep their purpose; explicit widget CSS can override theme sizes. Presets do not automatically enlarge fixed boxes. See [Widget design presets](design-presets.md) for the supported styles, densities and widget limits.

Changes appear live on the desktop. Save keeps the layout; Undo reverses individual edits.
