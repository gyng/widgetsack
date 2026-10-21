export default function InspectorViewTabs({
	values,
	active,
	onSelect,
	palette = false,
	panelId,
	idPrefix = 'inspector',
	label
}: {
	values: string[];
	active: string;
	onSelect: (value: string) => void;
	palette?: boolean;
	panelId?: string;
	idPrefix?: string;
	label?: string;
}) {
	return (
		<div
			className="detail-tabs"
			role="tablist"
			aria-label={label ?? (palette ? 'Catalog view' : 'Inspector view')}
			onKeyDown={(e) => {
				const index = values.indexOf(active);
				let next: number;
				if (e.key === 'ArrowRight') next = (index + 1) % values.length;
				else if (e.key === 'ArrowLeft') next = (index - 1 + values.length) % values.length;
				else if (e.key === 'Home') next = 0;
				else if (e.key === 'End') next = values.length - 1;
				else return;
				e.preventDefault();
				e.stopPropagation();
				onSelect(values[next]);
				e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next].focus();
			}}
		>
			{values.map((value) => (
				<button
					key={value}
					type="button"
					role="tab"
					id={`${idPrefix}-tab-${encodeURIComponent(value)}`}
					aria-controls={
						panelId ??
						(palette
							? undefined
							: value === 'JSON' || value === 'Advanced'
								? 'inspector-panel-data'
								: 'inspector-panel-form')
					}
					aria-selected={value === active}
					tabIndex={value === active ? 0 : -1}
					className={value === active ? 'active' : undefined}
					onClick={() => onSelect(value)}
				>
					{value}
				</button>
			))}
		</div>
	);
}
