import { useState, type ReactNode } from 'react';
import './PaletteSection.css';

const KEY = 'widgetsack.palette.collapsed';
function readCollapsed(): string[] {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
		return Array.isArray(value)
			? value.filter((entry): entry is string => typeof entry === 'string')
			: [];
	} catch {
		return [];
	}
}

/** Stable IDs preserve preferences across filtering, tabs and application restarts. */
export default function PaletteSection({
	id,
	label,
	count,
	searching = false,
	tiles = false,
	setup,
	children
}: {
	id: string;
	label: string;
	count: number;
	searching?: boolean;
	tiles?: boolean;
	setup?: ReactNode;
	children: ReactNode;
}) {
	const [collapsed, setCollapsed] = useState(() => readCollapsed().includes(id));
	return (
		<details
			className={tiles ? 'palette-section preview-tiles' : 'palette-section'}
			open={searching || !collapsed}
			onToggle={(event) => {
				if (searching) return;
				const next = !event.currentTarget.open;
				setCollapsed(next);
				try {
					const saved = readCollapsed().filter((entry) => entry !== id);
					if (next) saved.push(id);
					localStorage.setItem(KEY, JSON.stringify(saved));
				} catch {
					/* Preference storage must not block the catalog. */
				}
			}}
		>
			<summary>
				<span className="palette-section-name">
					{label} <span className="palette-count">({count})</span>
				</span>
				{setup && <span className="palette-heading">{setup}</span>}
			</summary>
			<div className="palette">{children}</div>
		</details>
	);
}
