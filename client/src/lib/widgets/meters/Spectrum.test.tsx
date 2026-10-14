import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Spectrum from './Spectrum';
import { SpectrumContext } from '../spectrumContext';
import type { SpectrumSource } from '../../audio/source';

afterEach(cleanup);

function fakeSource() {
	const release = vi.fn();
	const acquire = vi.fn((_device?: string, _scale?: string) => ({
		onFrame: () => () => undefined,
		latestFrame: () => null,
		release
	}));
	const src: SpectrumSource = { acquire };
	return { src, acquire, release };
}

describe('Spectrum', () => {
	it('acquires the source on mount and releases it on unmount', () => {
		const { src, acquire, release } = fakeSource();
		const { container, unmount } = render(
			<SpectrumContext.Provider value={src}>
				<Spectrum mode="bars" bars={32} />
			</SpectrumContext.Provider>
		);
		// Renders a canvas and takes exactly one stream subscription.
		expect(container.querySelector('canvas')).toBeTruthy();
		expect(acquire).toHaveBeenCalledTimes(1);
		expect(release).not.toHaveBeenCalled();

		unmount();
		expect(release).toHaveBeenCalledTimes(1);
	});

	it('subscribes each meter to the stream for its own device and scale', () => {
		const { src, acquire, release } = fakeSource();
		const { rerender } = render(
			<SpectrumContext.Provider value={src}>
				<Spectrum device="hdmi" scale="linear" />
				<Spectrum />
			</SpectrumContext.Provider>
		);
		expect(acquire.mock.calls).toEqual([
			['hdmi', 'linear'],
			['', 'log']
		]);

		// Changing one meter's scale re-subscribes just that meter, to the new config.
		rerender(
			<SpectrumContext.Provider value={src}>
				<Spectrum device="hdmi" scale="log" />
				<Spectrum />
			</SpectrumContext.Provider>
		);
		expect(release).toHaveBeenCalledTimes(1);
		expect(acquire).toHaveBeenLastCalledWith('hdmi', 'log');
	});

	it('still renders a canvas (and does not crash) when no source is provided', () => {
		const { container } = render(<Spectrum />);
		expect(container.querySelector('canvas')).toBeTruthy();
	});
});
