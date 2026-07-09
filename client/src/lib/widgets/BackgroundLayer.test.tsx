import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import BackgroundLayer from './BackgroundLayer';

describe('BackgroundLayer', () => {
	it('renders nothing without a spec', () => {
		const { container } = render(<BackgroundLayer />);
		expect(container.querySelector('.bg-layer')).toBeNull();
	});

	it('renders a color fill', () => {
		const { container } = render(<BackgroundLayer spec={{ kind: 'color', src: '#102030' }} />);
		const fill = container.querySelector('.bg-fill') as HTMLElement;
		expect(fill).not.toBeNull();
		expect(fill.style.background).toBe('#102030');
	});

	it('resolves an image filename through resolveSrc into background-image', () => {
		const { container } = render(
			<BackgroundLayer
				spec={{ kind: 'image', src: 'wall.png', fit: 'tile' }}
				resolveSrc={(n) => `asset://x/${n}`}
			/>
		);
		const fill = container.querySelector('.bg-fill') as HTMLElement;
		expect(fill.style.backgroundImage).toContain('asset://x/wall.png');
		expect(fill.style.backgroundRepeat).toBe('repeat');
	});

	it('renders a muted looping video for the video kind', () => {
		const { container } = render(
			<BackgroundLayer
				spec={{ kind: 'video', src: 'loop.mp4' }}
				resolveSrc={(n) => `asset://x/${n}`}
			/>
		);
		const video = container.querySelector('video.bg-media') as HTMLVideoElement;
		expect(video).not.toBeNull();
		expect(video.muted).toBe(true);
		expect(video.getAttribute('src')).toBe('asset://x/loop.mp4');
	});

	it('renders a sandboxed iframe for the web kind and a dim scrim', () => {
		const { container } = render(
			<BackgroundLayer spec={{ kind: 'web', src: 'https://shader.example', dim: 0.4 }} />
		);
		const frame = container.querySelector('iframe.bg-media') as HTMLIFrameElement;
		expect(frame.getAttribute('src')).toBe('https://shader.example');
		expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
		const dim = container.querySelector('.bg-dim') as HTMLElement;
		expect(dim.style.background).toContain('rgba(0, 0, 0, 0.4)');
	});

	it('renders nothing for a media kind whose source has not resolved yet', () => {
		const { container } = render(
			<BackgroundLayer spec={{ kind: 'image', src: 'x.png' }} resolveSrc={() => ''} />
		);
		expect(container.querySelector('.bg-layer')).toBeNull();
	});

	it('uses the src verbatim when no resolveSrc is injected (identity default)', () => {
		const { container } = render(<BackgroundLayer spec={{ kind: 'image', src: 'x.png' }} />);
		const fill = container.querySelector('.bg-fill') as HTMLElement;
		expect(fill.style.backgroundImage).toContain('x.png');
	});

	it('renders nothing when the spec has no src at all', () => {
		const { container } = render(<BackgroundLayer spec={{ kind: 'image' }} />);
		expect(container.querySelector('.bg-layer')).toBeNull();
	});
});
