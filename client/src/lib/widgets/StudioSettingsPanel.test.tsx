import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { Rect } from '../core/layout';
import type { OverlayPrefs } from './canvas/overlayPrefs';

// Stub the stateless overlay helpers the panel calls directly (devtools / rescue / clipboard /
// update check / launch at login). They are the only module-level side effects in this panel —
// everything else is owned by Canvas and arrives as props.
const {
	checkAppUpdate,
	copyToClipboard,
	openDevtools,
	rescueWindows,
	getAppPrefs,
	setUpdateCheck,
	isAutostartEnabled,
	setAutostart
} = vi.hoisted(() => ({
	checkAppUpdate: vi.fn(),
	getAppPrefs: vi.fn(async () => ({ update_check: false })),
	setUpdateCheck: vi.fn(async (enabled: boolean) => ({ update_check: enabled })),
	copyToClipboard: vi.fn(() => Promise.resolve(true)),
	openDevtools: vi.fn(() => Promise.resolve()),
	rescueWindows: vi.fn(() => Promise.resolve()),
	isAutostartEnabled: vi.fn(async () => ({ enabled: false, error: null as string | null })),
	setAutostart: vi.fn(async (enabled: boolean) => ({ enabled, error: null as string | null }))
}));
vi.mock('../overlay', () => ({
	checkAppUpdate,
	copyToClipboard,
	openDevtools,
	rescueWindows,
	isAutostartEnabled,
	setAutostart
}));

// The background update-check mirror (lib/appUpdate.ts): a REAL external store (so the About tab
// re-renders when a result lands) with the Tauri watch + browser open stubbed out.
const { openReleasePage } = vi.hoisted(() => ({
	openReleasePage: vi.fn(() => Promise.resolve(true))
}));
vi.mock('../appUpdate', async () => {
	const { createStore, useStore } = await import('../../stores/createStore');
	const appUpdateStore = createStore<import('../core/updateNotice').AppUpdate | null>(null);
	return {
		appUpdateStore,
		useAppUpdate: () => useStore(appUpdateStore),
		openReleasePage,
		getAppPrefs,
		setUpdateCheck
	};
});

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
import { appUpdateStore } from '../appUpdate';

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
				debugWindowed: false,
				developerMode: false
			} as OverlayPrefs,
			setPrefs: vi.fn(),
			layerStatus: 'main: bottom — ok (applied)'
		},
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
	openReleasePage.mockReset().mockResolvedValue(true);
	isAutostartEnabled.mockReset().mockResolvedValue({ enabled: false, error: null });
	setAutostart.mockReset().mockImplementation(async (enabled: boolean) => ({
		enabled,
		error: null
	}));
	appUpdateStore.set(null);
});

afterEach(() => vi.restoreAllMocks());

describe('StudioSettingsPanel — tab list', () => {
	// Tab labels collide with the section titles ("Monitor", "Overlay", …), so scope queries to the
	// side list (.pl-list) to hit the buttons specifically.
	const tabBtn = (container: HTMLElement, label: string): HTMLButtonElement => {
		const list = within(container.querySelector('.pl-list') as HTMLElement);
		return list.getByText(label) as HTMLButtonElement;
	};

	it('renders every settings tab and marks the danger tab apart', () => {
		const { container } = render(<StudioSettingsPanel {...baseProps()} />);
		for (const t of SETTINGS_TABS) expect(() => tabBtn(container, t.label)).not.toThrow();
		expect(tabBtn(container, 'Danger zone').className).toContain('set-danger');
		// The remap tab is called "Shortcuts" (shared vocabulary) but keeps its stable 'controls' id.
		expect(SETTINGS_TABS.find((t) => t.id === 'controls')?.label).toBe('Shortcuts');
	});

	it('marks the active tab and calls onTab when a tab is clicked', () => {
		const onTab = vi.fn();
		const { container } = render(<StudioSettingsPanel {...baseProps({ onTab, tab: 'overlay' })} />);
		expect(tabBtn(container, 'Overlay').className).toContain('cur');
		fireEvent.click(tabBtn(container, 'Startup'));
		expect(onTab).toHaveBeenCalledWith('startup');
	});
});

describe('StudioSettingsPanel — Monitor section', () => {
	it('shows the monitor name/size + rounded work area, and a single-monitor view has no move hint', () => {
		const { getByText, queryByText, container } = render(<StudioSettingsPanel {...baseProps()} />);
		expect(() => getByText('DELL U2720Q · 3840×2160')).not.toThrow();
		// workArea rounded for display.
		expect(container.textContent).toContain('1920×1040');
		expect(queryByText(/Move a widget to another monitor/)).toBeNull();
		// Fit button shows the zoom percentage.
		expect(() => getByText('⤢ Fit to window (50%)')).not.toThrow();
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
		fireEvent.click(getByText(/Fit to window/));
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
		// The picker is the shared <Select> (a Downshift listbox), labelled for all monitors when locked:
		// open it, pick.
		fireEvent.click(getByLabelText('Theme for all monitors'));
		fireEvent.click(getByText('Neon'));
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

	it('toggles keep-clear-of-taskbar, the layer picker, and windowed mode through setPrefs', () => {
		const props = overlayProps();
		const { getByLabelText, getByText } = render(<StudioSettingsPanel {...props} />);
		fireEvent.click(getByLabelText(/keep clear of the taskbar/));
		expect(props.overlay.setPrefs).toHaveBeenCalledWith({ respectWorkArea: false });

		// The layer picker is the shared <Select>, in the shared vocabulary (never "WorkerW").
		fireEvent.click(getByLabelText('Window layer'));
		fireEvent.click(getByText('Behind desktop icons (experimental)'));
		expect(props.overlay.setPrefs).toHaveBeenCalledWith({ overlayLayer: 'wallpaper' });

		fireEvent.click(getByLabelText(/windowed mode/));
		expect(props.overlay.setPrefs).toHaveBeenCalledWith({ debugWindowed: true });
	});

	it('states the current layer from the pref, with the overlay’s last apply result as a dim tail', () => {
		const props = overlayProps({ overlayLayer: 'top' });
		const { container } = render(<StudioSettingsPanel {...props} />);
		const status = container.querySelector('.set-status') as HTMLElement;
		expect(status.textContent).toContain('Current layer: Always on top');
		expect(status.textContent).toContain('· main: bottom — ok (applied)');
		expect(status.querySelector('.set-error')).toBeNull();
	});

	it('shows just the current layer while no overlay has reported yet, and flags a FAILED apply', () => {
		const props = overlayProps();
		props.overlay.layerStatus = '';
		const { container, rerender } = render(<StudioSettingsPanel {...props} />);
		const status = container.querySelector('.set-status') as HTMLElement;
		expect(status.textContent).toBe('Current layer: Below windows');
		expect(status.textContent).not.toMatch(/waiting/);
		props.overlay.layerStatus = 'main: wallpaper — FAILED (no desktop host window)';
		rerender(<StudioSettingsPanel {...props} />);
		expect(status.querySelector('.set-error')?.textContent).toContain('FAILED');
	});

	it('never says WorkerW / wallpaper layer in the layer picker', () => {
		const { getByLabelText, container } = render(<StudioSettingsPanel {...overlayProps()} />);
		fireEvent.click(getByLabelText('Window layer'));
		expect(document.body.textContent).not.toMatch(/WorkerW|Wallpaper layer/);
		expect(container.textContent).toContain('Below windows');
	});
});

describe('StudioSettingsPanel — Startup section', () => {
	it('reads the launch-at-login state on mount and writes through the toggle', async () => {
		isAutostartEnabled.mockResolvedValue({ enabled: true, error: null });
		const { getByLabelText } = render(<StudioSettingsPanel {...baseProps({ tab: 'startup' })} />);
		const box = getByLabelText(/launch at login/) as HTMLInputElement;
		await waitFor(() => expect(box.disabled).toBe(false));
		expect(box.checked).toBe(true);
		fireEvent.click(box);
		await waitFor(() => expect(setAutostart).toHaveBeenCalledWith(false));
		await waitFor(() => expect(box.checked).toBe(false));
	});

	it('shows the reason and reflects the re-read state when the change fails', async () => {
		setAutostart.mockResolvedValue({ enabled: false, error: 'Access is denied (HKCU Run key)' });
		const { getByLabelText, findByRole } = render(
			<StudioSettingsPanel {...baseProps({ tab: 'startup' })} />
		);
		const box = getByLabelText(/launch at login/) as HTMLInputElement;
		await waitFor(() => expect(box.disabled).toBe(false));
		fireEvent.click(box); // optimistic tick…
		const alert = await findByRole('alert');
		expect(alert.textContent).toBe(
			'Couldn’t change launch at login: Access is denied (HKCU Run key)'
		);
		expect(box.checked).toBe(false); // …reverted to what the OS actually says
	});

	it('surfaces a failed initial read too, and ignores a read that lands after unmount', async () => {
		let resolveRead!: (r: { enabled: boolean; error: string | null }) => void;
		isAutostartEnabled.mockImplementationOnce(() => new Promise((r) => (resolveRead = r)));
		const { unmount } = render(<StudioSettingsPanel {...baseProps({ tab: 'startup' })} />);
		unmount();
		await act(async () => resolveRead({ enabled: true, error: null })); // no setState after unmount

		isAutostartEnabled.mockResolvedValueOnce({ enabled: false, error: 'plugin unavailable' });
		const { findByRole } = render(<StudioSettingsPanel {...baseProps({ tab: 'startup' })} />);
		expect((await findByRole('alert')).textContent).toContain('plugin unavailable');
	});

	it('explains the desktop edit and rescue chords', () => {
		const { container } = render(<StudioSettingsPanel {...baseProps({ tab: 'startup' })} />);
		expect(container.textContent).toContain('Ctrl+Alt+E');
		expect(container.textContent).toContain('Ctrl+Alt+Shift+E');
		expect(container.textContent).toMatch(/Rescue/);
	});
});

describe('StudioSettingsPanel — Shortcuts section', () => {
	it('mounts ControlsPanel with the pass-through handlers under the "Shortcuts" title', () => {
		const props = baseProps({ tab: 'controls' });
		const { getByTestId } = render(<StudioSettingsPanel {...props} />);
		const panel = getByTestId('controls-panel');
		expect(panel.getAttribute('data-has-rebind')).toBe('true');
	});
});

describe('StudioSettingsPanel — Diagnostics section', () => {
	it('mounts DiagnosticsPanel, wires the rescue button, and hides devtools until developer mode is on', () => {
		const props = baseProps({ tab: 'diagnostics' });
		const { getByText, getByTestId, queryByText, getByLabelText } = render(
			<StudioSettingsPanel {...props} />
		);
		expect(getByTestId('diagnostics-panel')).toBeTruthy();
		fireEvent.click(getByText(/Rescue all windows/));
		expect(rescueWindows).toHaveBeenCalledOnce();
		// Developer mode is off by default → no devtools item; the toggle writes the pref.
		expect(queryByText(/Inspect this window/)).toBeNull();
		fireEvent.click(getByLabelText(/Developer mode/));
		expect(props.overlay.setPrefs).toHaveBeenCalledWith({ developerMode: true });
	});

	it('shows the devtools item in developer mode', () => {
		const props = baseProps({ tab: 'diagnostics' });
		props.overlay.prefs = { ...props.overlay.prefs, developerMode: true };
		const { getByText } = render(<StudioSettingsPanel {...props} />);
		fireEvent.click(getByText(/Inspect this window/));
		expect(openDevtools).toHaveBeenCalledOnce();
	});
});

describe('StudioSettingsPanel — About section', () => {
	it('shows the version + license and copies the repo link', async () => {
		const props = baseProps({ tab: 'about' });
		const { getByText, container } = render(<StudioSettingsPanel {...props} />);
		expect(container.textContent).toContain('1.2.3');
		expect(() => getByText('MIT OR Apache-2.0')).not.toThrow();
		const repoRow = getByText('github.com/gyng/widgetsack').closest('.set-row') as HTMLElement;
		fireEvent.click(within(repoRow).getByText('copy'));
		expect(copyToClipboard).toHaveBeenCalledWith('https://github.com/gyng/widgetsack');
		await flush();
	});

	it('shows an ellipsis placeholder when the app version is null', () => {
		const props = baseProps({ tab: 'about', appVersion: null });
		const { container } = render(<StudioSettingsPanel {...props} />);
		const versionRow = [...container.querySelectorAll('.set-row')].find((r) =>
			r.textContent?.startsWith('version')
		) as HTMLElement;
		expect(versionRow.querySelector('.dim')?.textContent).toBe('…');
	});

	describe('AppUpdateCheck', () => {
		it('the automatic check is OFF by default and the toggle writes through', async () => {
			const props = baseProps({ tab: 'about' });
			const { getByLabelText } = render(<StudioSettingsPanel {...props} />);
			const box = getByLabelText(/check for updates automatically/) as HTMLInputElement;
			await waitFor(() => expect(box.disabled).toBe(false)); // prefs loaded
			expect(box.checked).toBe(false);
			fireEvent.click(box);
			await waitFor(() => expect(setUpdateCheck).toHaveBeenCalledWith(true));
			await waitFor(() => expect(box.checked).toBe(true));
		});

		it('reverts the toggle and shows the error when the pref cannot be saved', async () => {
			setUpdateCheck.mockRejectedValueOnce(new Error('disk full'));
			const props = baseProps({ tab: 'about' });
			const { getByLabelText, findByText } = render(<StudioSettingsPanel {...props} />);
			const box = getByLabelText(/check for updates automatically/) as HTMLInputElement;
			await waitFor(() => expect(box.disabled).toBe(false));
			fireEvent.click(box);
			expect(await findByText(/Update check failed: disk full/)).toBeTruthy();
			expect(box.checked).toBe(false);
		});

		it('ignores a prefs read that resolves after the panel unmounted, and stringifies a non-Error save failure', async () => {
			let resolvePrefs!: (p: { update_check: boolean }) => void;
			getAppPrefs.mockImplementationOnce(() => new Promise((r) => (resolvePrefs = r)));
			const props = baseProps({ tab: 'about' });
			const { unmount } = render(<StudioSettingsPanel {...props} />);
			unmount();
			await act(async () => resolvePrefs({ update_check: true })); // no setState after unmount

			setUpdateCheck.mockRejectedValueOnce('nope');
			const { getByLabelText, findByText } = render(<StudioSettingsPanel {...props} />);
			const box = getByLabelText(/check for updates automatically/) as HTMLInputElement;
			await waitFor(() => expect(box.disabled).toBe(false));
			fireEvent.click(box);
			expect(await findByText(/Update check failed: nope/)).toBeTruthy();
		});

		it('says no check has run yet, then "up to date" once a manual check finds nothing newer', async () => {
			checkAppUpdate.mockResolvedValue({
				updateAvailable: false,
				current: '1.2.3',
				latest: '1.2.3',
				url: 'https://x'
			});
			const props = baseProps({ tab: 'about' });
			const { getByText, findByText, queryByText } = render(<StudioSettingsPanel {...props} />);
			expect(() => getByText('No update check has run yet.')).not.toThrow();
			fireEvent.click(getByText(/Check for updates/));
			// The button flips to a busy label while the check is in flight.
			expect(() => getByText('Checking…')).not.toThrow();
			expect(await findByText(/You’re up to date \(v1\.2\.3\)/)).toBeTruthy();
			expect(queryByText(/Open release page/)).toBeNull();
		});

		it('shows the persisted background result on mount (no click) with Open + copy affordances', async () => {
			appUpdateStore.set({
				updateAvailable: true,
				current: '1.2.3',
				latest: '1.3.0',
				url: 'https://github.com/gyng/widgetsack/releases/tag/v1.3.0'
			});
			const props = baseProps({ tab: 'about' });
			const { getByText } = render(<StudioSettingsPanel {...props} />);
			expect(checkAppUpdate).not.toHaveBeenCalled();
			expect(() => getByText('v1.3.0 available (you have v1.2.3).')).not.toThrow();
			fireEvent.click(getByText(/Open release page/));
			expect(openReleasePage).toHaveBeenCalledWith(
				'https://github.com/gyng/widgetsack/releases/tag/v1.3.0'
			);
			fireEvent.click(getByText('copy link'));
			await waitFor(() =>
				expect(copyToClipboard).toHaveBeenCalledWith(
					'https://github.com/gyng/widgetsack/releases/tag/v1.3.0'
				)
			);
		});

		it('a manual check that finds an update feeds the shared store (badge / tray agree)', async () => {
			checkAppUpdate.mockResolvedValue({
				updateAvailable: true,
				current: '1.2.3',
				latest: '1.3.0',
				url: 'https://github.com/gyng/widgetsack/releases/tag/v1.3.0'
			});
			const props = baseProps({ tab: 'about' });
			const { getByText, findByText } = render(<StudioSettingsPanel {...props} />);
			fireEvent.click(getByText(/Check for updates/));
			expect(await findByText(/Open release page/)).toBeTruthy();
			expect(appUpdateStore.getSnapshot()?.latest).toBe('1.3.0');
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
	it('clears this monitor when the danger button is pressed, and says how to undo', () => {
		const props = baseProps({ tab: 'danger' });
		const { getByText, container } = render(<StudioSettingsPanel {...props} />);
		fireEvent.click(getByText(/Clear this monitor/));
		expect(props.clearMonitor).toHaveBeenCalledOnce();
		// Matches the clearMonitor confirm: history survives switching sections; it is reset only by a
		// def edit (widget designer) or a layout reload / revert.
		expect(container.textContent).toContain(
			'Undoable with Ctrl+Z until you open the widget designer or reload the layout'
		);
		expect(container.textContent).not.toContain('There is no undo');
	});
});
