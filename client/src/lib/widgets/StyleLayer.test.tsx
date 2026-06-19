import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import StyleLayer from './StyleLayer';

// StyleLayer is an atom: it drops the pre-assembled (core/style.ts) stylesheet string into a real
// <style> element via dangerouslySetInnerHTML. Verify the element renders and carries the CSS
// verbatim, and that the default empty-string prop renders an empty <style>.

describe('StyleLayer', () => {
	it('renders a <style> element carrying the supplied CSS verbatim', () => {
		const css = '.np { color: red; }\n.bar::after { content: "x"; }';
		const { container } = render(<StyleLayer css={css} />);
		const style = container.querySelector('style');
		expect(style).not.toBeNull();
		expect(style!.innerHTML).toBe(css);
	});

	it('renders an empty <style> when css is omitted (default empty string)', () => {
		const { container } = render(<StyleLayer />);
		const style = container.querySelector('style');
		expect(style).not.toBeNull();
		expect(style!.innerHTML).toBe('');
	});
});
