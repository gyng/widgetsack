import type { ReactNode } from 'react';

/** Keep the catalog docked: dragging must leave the canvas interactive. */
export default function AddPaletteFrame({
	open,
	destination,
	onToggle,
	children
}: {
	open: boolean;
	destination: string;
	onToggle: (open: boolean) => void;
	children: ReactNode;
}) {
	return (
		<details className="add-panel" open={open} onToggle={(e) => onToggle(e.currentTarget.open)}>
			<summary>
				<span className="add-panel-title">＋ Add widget · {destination}</span>
			</summary>
			{children}
		</details>
	);
}
