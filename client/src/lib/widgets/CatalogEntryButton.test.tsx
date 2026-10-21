import { fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import CatalogEntryButton from './CatalogEntryButton';

it('offers the same preview on pointer and focus, dismisses it, and keeps activation separate', () => {
	const showPreview = vi.fn(),
		hidePreview = vi.fn(),
		onActivate = vi.fn();
	const spec = { label: 'Network', desc: 'Download and upload', hint: 'Click to preview' };
	const view = render(
		<div className="catalog-entry">
			<CatalogEntryButton
				spec={spec}
				ariaLabel="Network"
				showPreview={showPreview}
				hidePreview={hidePreview}
				onActivate={onActivate}
			/>
		</div>
	);
	const button = view.getByRole('button', { name: 'Network' });
	expect(button).not.toHaveAttribute('title');
	fireEvent.mouseEnter(button);
	expect(showPreview).toHaveBeenCalledWith(spec, button.parentElement);
	fireEvent.mouseLeave(button);
	expect(hidePreview).toHaveBeenCalledOnce();
	fireEvent.focus(button);
	expect(showPreview).toHaveBeenCalledTimes(2);
	fireEvent.keyDown(button, { key: 'Enter' });
	expect(hidePreview).toHaveBeenCalledOnce();
	fireEvent.keyDown(button, { key: 'Escape' });
	expect(hidePreview).toHaveBeenCalledTimes(2);
	expect(onActivate).not.toHaveBeenCalled();
	fireEvent.blur(button);
	fireEvent.click(button);
	expect(onActivate).toHaveBeenCalledOnce();
	expect(hidePreview).toHaveBeenCalledTimes(4);
});
