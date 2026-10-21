import WidgetIcon from './WidgetIcon';
import type { Ref } from 'react';
import type { PalettePreviewSpec } from './usePalettePreview';
import './CatalogEntry.css';

/** Shared primary row action; trailing edit/insert controls remain separate buttons. */
export default function CatalogEntryButton({
	spec,
	ariaLabel,
	className = '',
	buttonRef,
	hasPopup,
	onActivate,
	showPreview,
	hidePreview
}: {
	spec: PalettePreviewSpec;
	ariaLabel: string;
	className?: string;
	buttonRef?: Ref<HTMLButtonElement>;
	hasPopup?: 'dialog';
	onActivate: () => void;
	showPreview: (spec: PalettePreviewSpec, el: HTMLElement) => void;
	hidePreview: () => void;
}) {
	return (
		<button
			ref={buttonRef}
			type="button"
			aria-haspopup={hasPopup}
			className={`catalog-entry-label ${className}`}
			aria-label={ariaLabel}
			aria-description={[spec.desc, spec.hint].filter(Boolean).join(' — ')}
			onClick={() => {
				hidePreview();
				onActivate();
			}}
			onMouseEnter={(e) => showPreview(spec, e.currentTarget.parentElement!)}
			onMouseLeave={hidePreview}
			onFocus={(e) => showPreview(spec, e.currentTarget.parentElement!)}
			onBlur={hidePreview}
			onKeyDown={(e) => {
				if (e.key === 'Escape') {
					e.preventDefault();
					hidePreview();
				}
			}}
		>
			<span className="catalog-item-name">
				<WidgetIcon type="group" />
				<span>{spec.label}</span>
			</span>
		</button>
	);
}
