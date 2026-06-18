import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

// The only module call the panel makes itself is the stateless open-folder helper — mock the Tauri
// adapter so a click is observable without a backend.
vi.mock('../overlay', () => ({ openWallpapersDir: vi.fn() }));

import BackgroundPanel from './BackgroundPanel';
import { openWallpapersDir } from '../overlay';
import type { BackgroundSpec } from '../core/layoutTree';
import type { AutoTheme } from './canvas/useAutoTheme';

type Handlers = {
	patchBg: ReturnType<typeof vi.fn>;
	setBgKind: ReturnType<typeof vi.fn>;
	clearBg: ReturnType<typeof vi.fn>;
	refreshWallpapers: ReturnType<typeof vi.fn>;
};

function handlers(): Handlers {
	return {
		patchBg: vi.fn(),
		setBgKind: vi.fn(),
		clearBg: vi.fn(),
		refreshWallpapers: vi.fn()
	};
}

function renderPanel(
	bg: BackgroundSpec | undefined,
	opts: {
		wallpaperFiles?: string[];
		autoTheme?: AutoTheme;
		onClearTokens?: () => void;
	} = {}
) {
	const h = handlers();
	const utils = render(
		<BackgroundPanel
			bg={bg}
			wallpaperFiles={opts.wallpaperFiles ?? []}
			refreshWallpapers={h.refreshWallpapers}
			patchBg={h.patchBg}
			setBgKind={h.setBgKind}
			clearBg={h.clearBg}
			autoTheme={opts.autoTheme}
			onClearTokens={opts.onClearTokens}
		/>
	);
	return { ...utils, h };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('BackgroundPanel — type picker', () => {
	it('renders the Type select defaulting to "none" with no background', () => {
		const { container } = renderPanel(undefined);
		const select = container.querySelector('.bg-field select') as HTMLSelectElement;
		expect(select.value).toBe('none');
		// All kinds (+ None) are offered as options.
		const opts = [...select.options].map((o) => o.value);
		expect(opts).toEqual(['none', 'color', 'image', 'video', 'web']);
	});

	it('picking a kind emits setBgKind, not clearBg', () => {
		const { container, h } = renderPanel(undefined);
		const select = container.querySelector('.bg-field select') as HTMLSelectElement;
		fireEvent.change(select, { target: { value: 'color' } });
		expect(h.setBgKind).toHaveBeenCalledWith('color');
		expect(h.clearBg).not.toHaveBeenCalled();
	});

	it('picking "none" emits clearBg', () => {
		const { container, h } = renderPanel({ kind: 'color', src: '#102030' });
		const select = container.querySelector('.bg-field select') as HTMLSelectElement;
		expect(select.value).toBe('color');
		fireEvent.change(select, { target: { value: 'none' } });
		expect(h.clearBg).toHaveBeenCalledTimes(1);
		expect(h.setBgKind).not.toHaveBeenCalled();
	});
});

describe('BackgroundPanel — colour kind', () => {
	it('shows a colour input seeded from a valid src and emits the new colour', () => {
		const { container, h } = renderPanel({ kind: 'color', src: '#abcdef' });
		const color = container.querySelector('input[type="color"]') as HTMLInputElement;
		expect(color.value).toBe('#abcdef');
		fireEvent.change(color, { target: { value: '#112233' } });
		expect(h.patchBg).toHaveBeenCalledWith({ src: '#112233' });
	});

	it('falls back to a default colour when src is not a valid hex', () => {
		const { container } = renderPanel({ kind: 'color', src: 'not-a-colour' });
		const color = container.querySelector('input[type="color"]') as HTMLInputElement;
		expect(color.value).toBe('#0b0b0e');
	});
});

describe('BackgroundPanel — web kind', () => {
	it('commits a trimmed URL on blur', () => {
		const { container, h } = renderPanel({ kind: 'web', src: 'https://a' });
		const url = container.querySelector('input[type="text"]') as HTMLInputElement;
		expect(url.value).toBe('https://a');
		fireEvent.change(url, { target: { value: '  https://b  ' } });
		fireEvent.blur(url);
		expect(h.patchBg).toHaveBeenCalledWith({ src: 'https://b' });
	});
});

describe('BackgroundPanel — media kinds (image/video)', () => {
	it('lists wallpaper files and selecting one emits patchBg({src})', () => {
		const { getByText, getByTitle, h } = renderPanel(
			{ kind: 'image', src: 'a.png' },
			{ wallpaperFiles: ['a.png', 'b.jpg'] }
		);
		expect(() => getByText('b.jpg')).not.toThrow();
		fireEvent.click(getByText('b.jpg'));
		expect(h.patchBg).toHaveBeenCalledWith({ src: 'b.jpg' });
		// The currently-selected file carries the .cur class.
		const cur = getByTitle('a.png');
		expect(cur.className).toContain('cur');
	});

	it('refresh button calls refreshWallpapers; Folder button opens the wallpapers dir', () => {
		const { getByTitle, h } = renderPanel(
			{ kind: 'image', src: 'a.png' },
			{ wallpaperFiles: ['a.png'] }
		);
		fireEvent.click(getByTitle('Refresh the list'));
		expect(h.refreshWallpapers).toHaveBeenCalledTimes(1);
		fireEvent.click(getByTitle(/Open the wallpapers folder/));
		expect(openWallpapersDir).toHaveBeenCalledTimes(1);
	});

	it('shows an empty-state hint when there are no wallpaper files', () => {
		const { getByText } = renderPanel({ kind: 'image', src: 'a.png' }, { wallpaperFiles: [] });
		expect(() => getByText(/No files yet/)).not.toThrow();
	});

	it('Fit select emits patchBg({fit})', () => {
		const { container, h } = renderPanel(
			{ kind: 'video', src: 'clip.mp4' },
			{ wallpaperFiles: ['clip.mp4'] }
		);
		// The Fit select is the only <select> inside a .bg-field besides Type — find it by its option set.
		const selects = [...container.querySelectorAll('.bg-field select')] as HTMLSelectElement[];
		const fit = selects.find((s) =>
			[...s.options].some((o) => o.value === 'cover')
		) as HTMLSelectElement;
		fireEvent.change(fit, { target: { value: 'contain' } });
		expect(h.patchBg).toHaveBeenCalledWith({ fit: 'contain' });
	});
});

describe('BackgroundPanel — video checkboxes', () => {
	it('muted/loop default to checked and toggling emits the patch', () => {
		const { getByText, h } = renderPanel({ kind: 'video', src: 'clip.mp4' });
		const muted = getByText('muted').querySelector('input') as HTMLInputElement;
		const loop = getByText('loop').querySelector('input') as HTMLInputElement;
		expect(muted.checked).toBe(true);
		expect(loop.checked).toBe(true);
		fireEvent.click(muted);
		expect(h.patchBg).toHaveBeenCalledWith({ mute: false });
		fireEvent.click(loop);
		expect(h.patchBg).toHaveBeenCalledWith({ loop: false });
	});
});

describe('BackgroundPanel — opacity/dim/remove (any background)', () => {
	it('labels show the rounded percentages and the sliders emit numeric patches', () => {
		const { getByText, container, h } = renderPanel({
			kind: 'color',
			src: '#102030',
			opacity: 0.6,
			dim: 0.25
		});
		expect(() => getByText('Opacity 60%')).not.toThrow();
		expect(() => getByText('Dim 25%')).not.toThrow();
		const ranges = [...container.querySelectorAll('input[type="range"]')] as HTMLInputElement[];
		fireEvent.change(ranges[0], { target: { value: '0.5' } });
		expect(h.patchBg).toHaveBeenCalledWith({ opacity: 0.5 });
		fireEvent.change(ranges[1], { target: { value: '0.4' } });
		expect(h.patchBg).toHaveBeenCalledWith({ dim: 0.4 });
	});

	it('Remove background emits clearBg', () => {
		const { getByText, h } = renderPanel({ kind: 'color', src: '#102030' });
		fireEvent.click(getByText('Remove background'));
		expect(h.clearBg).toHaveBeenCalledTimes(1);
	});

	it('renders no opacity/dim/remove controls when there is no background', () => {
		const { container, queryByText } = renderPanel(undefined);
		expect(container.querySelector('input[type="range"]')).toBeNull();
		expect(queryByText('Remove background')).toBeNull();
	});
});

describe('BackgroundPanel — auto theme (image only)', () => {
	const autoTheme = (over: Partial<AutoTheme> = {}): AutoTheme => ({
		canAuto: true,
		busy: false,
		status: 'idle',
		run: vi.fn(() => Promise.resolve()),
		resetStatus: vi.fn(),
		...over
	});

	it('runs the wallpaper sampler on click', () => {
		const at = autoTheme();
		const { getByText } = renderPanel(
			{ kind: 'image', src: 'a.png' },
			{ wallpaperFiles: ['a.png'], autoTheme: at }
		);
		fireEvent.click(getByText('🎨 From wallpaper'));
		expect(at.run).toHaveBeenCalledTimes(1);
	});

	it('shows a busy label and disables the button while sampling', () => {
		const at = autoTheme({ busy: true });
		const { getByText } = renderPanel(
			{ kind: 'image', src: 'a.png' },
			{ wallpaperFiles: ['a.png'], autoTheme: at }
		);
		const btn = getByText('Reading…') as HTMLButtonElement;
		expect(btn.disabled).toBe(true);
		expect(btn.getAttribute('aria-busy')).toBe('true');
	});

	it('Reset colours clears tokens and the status', () => {
		const at = autoTheme();
		const onClearTokens = vi.fn();
		const { getByText } = renderPanel(
			{ kind: 'image', src: 'a.png' },
			{ wallpaperFiles: ['a.png'], autoTheme: at, onClearTokens }
		);
		fireEvent.click(getByText('Reset colours'));
		expect(onClearTokens).toHaveBeenCalledTimes(1);
		expect(at.resetStatus).toHaveBeenCalledTimes(1);
	});

	it('reports the done / fail status', () => {
		const done = renderPanel(
			{ kind: 'image', src: 'a.png' },
			{ wallpaperFiles: ['a.png'], autoTheme: autoTheme({ status: 'done' }) }
		);
		expect(() => done.getByText(/Applied/)).not.toThrow();
		done.unmount();

		const fail = renderPanel(
			{ kind: 'image', src: 'a.png' },
			{ wallpaperFiles: ['a.png'], autoTheme: autoTheme({ status: 'fail' }) }
		);
		expect(() => fail.getByText(/Couldn’t read the image’s colours/)).not.toThrow();
	});

	it('hides the auto-theme block for a non-image background', () => {
		const { queryByText } = renderPanel(
			{ kind: 'video', src: 'clip.mp4' },
			{ wallpaperFiles: ['clip.mp4'], autoTheme: autoTheme() }
		);
		expect(queryByText('🎨 From wallpaper')).toBeNull();
	});
});
