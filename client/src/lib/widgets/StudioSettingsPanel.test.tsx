import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { Rect } from '../core/layout';
import type { OverlayPrefs } from './canvas/overlayPrefs';

// Stub the stateless overlay helpers the panel calls directly (devtools / rescue / clipboard /
// update check). They are the only module-level side effects in this panel — everything else is
// owned by Canvas and arrives as props.
const { checkAppUpdate, copyToClipboard, openDevtools, rescueWindows } = vi.hoisted(() => ({
	checkAppUpdate: vi.fn(),
	copyToClipboard: vi.fn(() => Promise.resolve(true)),
	openDevtools: vi.fn(() => Promise.resolve()),
	rescueWindows: vi.fn(() => Promise.resolve())
}));
vi.mock('../overlay', () => ({ checkAppUpdate, copyToClipboard, openDevtools, rescueWindows }));

// The two child panels are tested in isolation; stub them so this test exercises only the settings
// shell (tab switching + the sections it owns) and can assert they get the pass-through props.
vi.mock('./ControlsPanel', () => ({
	default: (p: Record<string, unknown>) => (
		<div data-testid="controls-panel" data-has-rebind={typeof p.onRebind === 'function'} />
	)
}));
vi.mock('./DiagnosticsPanel', () => ({
	default: () => <div data-testid="diagnostics-panel" />
}));
vi.mock('../../assets/mascot.png', () => ({ default: 'mascot.png' }));

import StudioSettingsPanel, { SETTINGS_TABS, type SettingsTab } from './StudioSettingsPanel';

const baseProps = (over: Partial<Parameters<typeof StudioSettingsPanel>[0]> = {}) => {
	const workArea: Rect = { x: 0, y: 0, w: 1920, h: 1040 };
	return {
		tab: 'display' as SettingsTab,
		onTab: vi.fn(),
		display: {
			monName: 'DELL U2720Q',
			monSize: { w: 3840, h: 2160 },
			workArea,
			multiMonitor: false,
			zoom: 0.5,
			fit: vi.fn()
		},
		theme: {
			options: [
				{ value: '', label: 'Default' },
				{ value: 'neon', label: 'Neon' }
			],
			selected: '',
			setTheme: vi.fn(),
			lock: true,
			setLock: vi.fn()
		},
		overlay: {
			prefs: {
				respectWorkArea: true,
				overlayLayer: 'bottom',
				debugWindowed: false
			} as OverlayPrefs,
			setPrefs: vi.fn(),
			layerStatus: 'always on top'
		},
		startup: { autostart: false, toggleAutostart: vi.fn() },
		controls: { overrides: {}, onRebind: vi.fn(), onReset: vi.fn(), onResetAll: vi.fn() },
		appVersion: '1.2.3',
		clearMonitor: vi.fn(),
		...over
	};
};

const flush = () => act(async () => undefined);

beforeEach(() => {
	checkAppUpdate.mockReset();
	copyToClipboard.mockReset().mockResolvedValue(true);
	openDevtools.mockReset().mockResolvedValue(undefined);
	rescueWindows.mockReset().mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('StudioSettingsPanel — tab list', () => {
	// Tab labels collide with the section titles ("Display", "Overlay", …), so scope queries to the
	// side list (.pl-list) to hit the buttons specifically.
	const tabBtn = (container: HTMLElement, label: string): HTMLButtonElement => {
		const list = within(container.querySelector('.pl-list') as HTMLElement);
		return list.getByText(label) as HTMLButtonElement;
	};

	it('renders every settings tab and marks the danger tab apart', () => {
		const { container } = render(<StudioSettingsPanel {...baseProps()} />);
		for (const t of SETTINGS_TABS) expect(() => tabBtn(container, t.label)).not.toThrow();
		expect(tabBtn(container, 'Danger zone').className).toContain('set-danger');
	});

	it('marks the active tab and calls onTab when a tab is clicked', () => {
		const onTab = vi.fn();
		const { container } = render(<StudioSettingsPanel {...baseProps({ onTab, tab: 'overlay' })} />);
		expect(tabBtn(container, 'Overlay').className).toContain('cur');
		fireEvent.click(tabBtn(container, 'Startup'));
		expect(onTab).toHaveBeenCalledWith('startup');
	});
});

describe('StudioSettingsPanel — Display section', () => {
	it('shows the monitor name/size + rounded work area, and a single-monitor view has no move hint', () => {
		const { getByText, queryByText, container } = render(<StudioSettingsPanel {...baseProps()} />);
		expect(() => getByText('DELL U2720Q · 3840×2160')).not.toThrow();
		// workArea rounded for display.
		expect(container.textContent).toContain('1920×1040');
		expect(queryByText(/Move a widget to another monitor/)).toBeNull();
		// Fit button shows the zoom percentage.
		expect(() => getByText('⤢ Fit to screen (50%)')).not.toThrow();
	});

	it('falls back to an em-dash for an unnamed monitor and shows the multi-monitor move hint', () => {
		const props = baseProps();
		props.display.monName = '';
		props.display.multiMonitor = true;
		const { getByText, queryByText } = render(<StudioSettingsPanel {...props} />);
		expect(() => getByText('— · 3840×2160')).not.toThrow();
		expect(queryByText(/Move a widget to another monitor/)).not.toBeNull();
	});

	it('Fit to screen calls the supplied fit handler', () => {
		const props = baseProps();
		const { getByText } = render(<StudioSettingsPanel {...props} />);
		fireEvent.click(getByText(/Fit to screen/));
		expect(props.display.fit).toHaveBeenCalledOnce();
	});

	it('locked theme: shows the all-monitors copy + the global picker, toggling lock + theme', () => {
		const props = baseProps();
		const { getByText, getByLabelText } = render(<StudioSettingsPanel {...props} />);
		expect(() => getByText(/One theme styles every monitor/)).not.toThrow();
		// Lock checkbox is on; unchecking it reports false. The <label> wraps the span + checkbox, so
		// reach the checkbox via the label that carries the copy.
		const lockLabel = getByText('apply theme to all monitors').closest('label') as HTMLElement;
		const lockBox = lockLabel.querySelector('input[type="checkbox"]') as HTMLInputElement;
		expect(lockBox.checked).toBe(true);
		fireEvent.click(lockBox);
		expect(props.theme.setLock).toHaveBeenCalledWith(false);
		// The picker is labelled for all monitors when locked.
		const select = getByLabelText('Theme for all monitors') as HTMLSelectElement;
		fireEvent.change(select, { target: { value: 'neon' } });
		expect(props.theme.setTheme).toHaveBeenCalledWith('neon');
	});

	it('unlocked theme: shows the per-monitor copy + a per-monitor-labelled picker', () => {
		const props = baseProps();
		props.theme.lock = false;
		const { getByText, getByLabelText } = render(<StudioSettingsPanel {...props} />);
		expect(() => getByText(/Each monitor keeps its own theme/)).not.toThrow();
		expect(() => getByText('theme · DELL U2720Q')).not.toThrow();
		expect(getByLabelText('Theme for this monitor')).toBeTruthy();
	});

	it('unlocked theme on an unnamed monitor falls back to "this monitor" in the picker label', () => {
		const props = baseProps();
		props.theme.lock = false;
		props.display.monName = '';
		const { getByText } = render(<StudioSettingsPanel {...props} />);
		expect(() => getByText('theme · this monitor')).not.toThrow();
	});
});

describe('StudioSettingsPanel — Overlay section', () => {
	const overlayProps = (over: Partial<OverlayPrefs> = {}) => {
		const props = baseProps({ tab: 'overlay' });
		props.overlay.prefs = { ...props.overlay.prefs, ...over };
		return props;
	};

	it('toggles respect-work-area, the layer select, and windowed mode through setPrefs', () => {
		const props = overlayProps();
		const { getByText, container } = render(<StudioSettingsPanel {...props} />);
		const [work, windowed] = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
		fireEvent.click(work);
		expect(props.overlay.setPrefs).toHaveBeenCalledWith({ respectWorkArea: false });

		const select = container.querySelector('select') as HTMLSelectElement;
		fireEvent.change(select, { target: { value: 'wallpaper' } });
		expect(props.overlay.setPrefs).toHaveBeenCalledWith({ overlayLayer: 'wallpaper' });

		fireEvent.click(windowed);
		expect(props.overlay.setPrefs).toHaveBeenCalledWith({ debugWindowed: true });

		// The layer status line is shown verbatim.
		expect(() => getByText('always on top')).not.toThrow();
	});

	it('shows the waiting placeholder when no layer status has been reported', () => {
		const props = overlayProps();
		props.overlay.layerStatus = '';
		const { getByText } = render(<StudioSettingsPanel {...props} />);
		expect(() => getByText(/waiting for the overlay to apply a layer/)).not.toThrow();
	});
});

describe('StudioSettingsPanel — Startup section', () => {
	it('reflects the autostart pref and toggles it', () => {
		const props = baseProps({ tab: 'startup' });
		const { container } = render(<StudioSettingsPanel {...props} />);
		const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
		expect(box.checked).toBe(false);
		fireEvent.click(box);
		expect(props.startup.toggleAutostart).toHaveBeenCalledWith(true);
	});
});

describe('StudioSettingsPanel — Controls section', () => {
	it('mounts ControlsPanel with the pass-through handlers', () => {
		const props = baseProps({ tab: 'controls' });
		const { getByTestId } = render(<StudioSettingsPanel {...props} />);
		const panel = getByTestId('controls-panel');
		expect(panel.getAttribute('data-has-rebind')).toBe('true');
	});
});

describe('StudioSettingsPanel — Diagnostics section', () => {
	it('mounts DiagnosticsPanel and wires the devtools + rescue buttons', () => {
		const props = baseProps({ tab: 'diagnostics' });
		const { getByText, getByTestId } = render(<StudioSettingsPanel {...props} />);
		expect(getByTestId('diagnostics-panel')).toBeTruthy();
		fireEvent.click(getByText(/Inspect this window/));
		expect(openDevtools).toHaveBeenCalledOnce();
		fireEvent.click(getByText(/Rescue all windows/));
		expect(rescueWindows).toHaveBeenCalledOnce();
	});
});

describe('StudioSettingsPanel — About section', () => {
	it('shows the version + license and copies the repo link', async () => {
		const props = baseProps({ tab: 'about' });
		const { getByText, container } = render(<StudioSettingsPanel {...props} />);
		expect(container.textContent).toContain('1.2.3');
		expect(() => getByText('MIT OR Apache-2.0')).not.toThrow();
		const repoRow = getByText('github.com/gyng/widgetsack').closest('.rp-row') as HTMLElement;
		fireEvent.click(within(repoRow).getByText('copy'));
		expect(copyToClipboard).toHaveBeenCalledWith('https://github.com/gyng/widgetsack');
		await flush();
	});

	it('shows an ellipsis placeholder when the app version is null', () => {
		const props = baseProps({ tab: 'about', appVersion: null });
		const { container } = render(<StudioSettingsPanel {...props} />);
		const versionRow = [...container.querySelectorAll('.rp-row')].find((r) =>
			r.textContent?.startsWith('version')
		) as HTMLElement;
		expect(versionRow.querySelector('.dim')?.textContent).toBe('…');
	});

	describe('AppUpdateCheck', () => {
		it('reports "up to date" when no update is available', async () => {
			checkAppUpdate.mockResolvedValue({
				updateAvailable: false,
				current: '1.2.3',
				latest: '1.2.3',
				url: 'https://x'
			});
			const props = baseProps({ tab: 'about' });
			const { getByText, findByText } = render(<StudioSettingsPanel {...props} />);
			fireEvent.click(getByText(/Check for updates/));
			// The button flips to a busy label while the check is in flight.
			expect(() => getByText('Checking…')).not.toThrow();
			expect(await findByText(/You’re up to date \(v1\.2\.3\)/)).toBeTruthy();
		});

		it('offers a copy-link row when an update is available', async () => {
			checkAppUpdate.mockResolvedValue({
				updateAvailable: true,
				current: '1.2.3',
				latest: '1.3.0',
				url: 'https://example/release'
			});
			const props = baseProps({ tab: 'about' });
			const { getByText, findByText } = render(<StudioSettingsPanel {...props} />);
			fireEvent.click(getByText(/Check for updates/));
			expect(await findByText('v1.3.0 available')).toBeTruthy();
			fireEvent.click(getByText('copy link'));
			await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith('https://example/release'));
		});

		it('surfaces an Error message inline when the check throws', async () => {
			checkAppUpdate.mockRejectedValue(new Error('offline'));
			const props = baseProps({ tab: 'about' });
			const { getByText, findByText } = render(<StudioSettingsPanel {...props} />);
			fireEvent.click(getByText(/Check for updates/));
			const msg = await findByText(/Update check failed: offline/);
			expect(msg.getAttribute('title')).toBe('offline');
		});

		it('stringifies a non-Error rejection in the failure message', async () => {
			checkAppUpdate.mockRejectedValue('nope');
			const props = baseProps({ tab: 'about' });
			const { getByText, findByText } = render(<StudioSettingsPanel {...props} />);
			fireEvent.click(getByText(/Check for updates/));
			expect(await findByText(/Update check failed: nope/)).toBeTruthy();
		});
	});
});

describe('StudioSettingsPanel — Danger section', () => {
	it('clears this monitor when the danger button is pressed', () => {
		const props = baseProps({ tab: 'danger' });
		const { getByText } = render(<StudioSettingsPanel {...props} />);
		fireEvent.click(getByText(/Clear this monitor/));
		expect(props.clearMonitor).toHaveBeenCalledOnce();
	});
});
