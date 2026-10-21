import Icon from './Icon';
import './CatalogViewToggle.css';

export default function CatalogViewToggle({
	tiles,
	onChange
}: {
	tiles: boolean;
	onChange: (tiles: boolean) => void;
}) {
	return (
		<div className="catalog-view" role="group" aria-label="Widget catalog view">
			{[false, true].map((value) => (
				<button
					type="button"
					key={String(value)}
					aria-label={value ? 'Previews' : 'List'}
					aria-pressed={tiles === value}
					title={value ? 'Large tiles with sample previews' : 'Compact widget list'}
					onClick={() => onChange(value)}
				>
					<Icon name={value ? 'image' : 'menu'} size={14} />
					<span className="catalog-view-text">{value ? 'Previews' : 'List'}</span>
				</button>
			))}
		</div>
	);
}
