# Layout format

The frontend owns layout schemas. Rust stores their JSON without solving the tree.
Use [layoutTree.ts](../../client/src/lib/core/layoutTree.ts) and [layout.ts](../../client/src/lib/core/layout.ts) as the type reference.
Decoding and recovery live in [layoutDocument.ts](../../client/src/lib/core/layoutDocument.ts).

## Version 2 example

```json
{
	"version": 2,
	"monitors": {
		"default": {
			"root": {
				"id": "root",
				"kind": "col",
				"gap": 8,
				"children": [
					{
						"id": "clock-slot",
						"unit": {
							"id": "clock",
							"type": "clock",
							"rect": { "x": 0, "y": 0, "w": 200, "h": 60 },
							"config": { "format": "HH:mm" }
						}
					}
				]
			},
			"floating": []
		}
	}
}
```

`default` identifies the primary monitor.
Other keys identify monitor-specific layouts.
A monitor has a docked root tree and a floating list.
Use the current decoder when accepting imported JSON.

## Nodes

Containers use `kind: row`, `col`, or `grid` and contain `children`.
Leaves wrap a widget or group in `unit`.
Widget instances contain an ID, registered type, rectangle, and optional configuration, sensor, CSS, or tokens.
Groups reference reusable library definitions or contain an inline child tree.
Group parameters and styles can override individual instances.

The solver handles gaps, padding, margins, alignment, fixed sizing, content sizing, and fractional sizing.
Grid nodes can define column and row weights.
Visibility conditions keep their space while hiding content on the overlay.
Studio keeps conditional content visible for editing.

## Editing and persistence

Use pure tree operations for insert, move, remove, and replacement.
Do not mutate editor snapshots in place.
The editor reducer owns undo, redo, selection, modes, and the saved baseline.
Save planning distinguishes layout changes from reusable definition changes.

Legacy version 1 files pass through migration.
Malformed imports must not overwrite a valid saved layout.
The [example fixture](examples/README.md) provides a larger version 2 file.
Use the [widget reference](../widgets.md) for valid configuration keys.
