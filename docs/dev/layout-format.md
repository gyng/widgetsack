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

## Document fields

The saved document extends the version 2 layout with library and theme settings.
See [layoutPersistence.ts](../../client/src/lib/core/layoutPersistence.ts) for the complete `LayoutDocument` contract.

| Field       | Type             | Meaning                                                           |
| ----------- | ---------------- | ----------------------------------------------------------------- |
| `version`   | `2`              | Layout schema version                                             |
| `monitors`  | Object           | Monitor keys mapped to monitor layouts                            |
| `library`   | Optional object  | Reusable definitions as `{ version, defs }`                       |
| `theme`     | Optional string  | Global theme selection; absent or empty uses default tokens       |
| `themeLock` | Optional `false` | Allow per-monitor themes; absent means one theme for all monitors |
| `tokens`    | Optional object  | Global CSS token overrides with string values                     |

Theme selections use `builtin:<id>` for a built-in theme or a filename stem for a saved theme.
Each monitor contains `root` and `floating`.
Optional `background` settings define its wallpaper.
An optional monitor `theme` overrides the global selection when `themeLock` is false.
Missing token overrides decode as an empty map.

## Nodes

Containers use `kind: row`, `col`, or `grid` and contain `children`.
Leaves wrap a widget or group in `unit`.
A primitive widget requires `id`, `type`, `rect`, and `config`.
It can also contain `sensor`, `css`, `tokens`, or an interaction override.
Use registered widget types and the [widget reference](../widgets.md) for configuration keys.

A group uses `kind: group` and requires `id`, `size`, and `child`.
Its optional `def` refers to a reusable library definition.
The inline `child` is the fallback when the reference is absent or unresolved.
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
The backend merges touched monitors and global fields before atomic file replacement.
This preserves changes saved by another window to untouched parts of the document.

Legacy version 1 files pass through migration.
Malformed imports must not overwrite a valid saved layout.
The [example fixture](examples/README.md) provides a larger version 2 file.
