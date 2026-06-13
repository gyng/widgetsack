import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import ImageWidget from './ImageWidget';

afterEach(cleanup);

describe('ImageWidget', () => {
	it('renders the image with the chosen object-fit + alt', () => {
		const { container } = render(
			<ImageWidget url="https://ex.com/a.png" fit="cover" alt="A cat" />
		);
		const img = container.querySelector('img.img-el') as HTMLImageElement;
		expect(img.getAttribute('src')).toBe('https://ex.com/a.png');
		expect(img.style.objectFit).toBe('cover');
		expect(img.getAttribute('alt')).toBe('A cat');
	});

	it('shows an empty state with no url', () => {
		const { container } = render(<ImageWidget url="" />);
		expect(container.querySelector('.img-empty')?.textContent).toBe('no image');
		expect(container.querySelector('img')).toBeNull();
	});
});
