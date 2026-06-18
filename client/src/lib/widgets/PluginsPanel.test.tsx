import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import type { Plugin } from './plugin';
import type { PackageRow } from './plugins/packages';

// Keep the real package STORES (the panel subscribes to them via useStore) but spy the action
// functions — installPackage / togglePackage / removePackage / checkPackageUpdate / updatePackage —
// so a click's emitted call is observable without the Tauri command layer. importOriginal preserves
// `packagesStore` + `enabledPackages` (real createStore/createPersistedStore instances) so a test
// can drive the rendered rows with `.set(...)`.
vi.mock('./plugins/packages', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./plugins/packages')>();
	return {
		...actual,
		installPackage: vi.fn(() => Promise.resolve({ ok: true })),
		togglePackage: vi.fn(() => Promise.resolve()),
		removePackage: vi.fn(() => Promise.resolve({ ok: true })),
		checkPackageUpdate: vi.fn(() =>
			Promise.resolve({ ok: true, current: '1.0.0', latest: '2.0.0', updateAvailable: true })
		),
		updatePackage: vi.fn(() => Promise.resolve({ ok: true }))
	};
});
// The built-in plugin-load-error table (registerBuiltinPlugins records throws here). Mocked so a
// test can assert the "failed to load" rows render without actually breaking a plugin registration.
vi.mock('./plugins', () => ({ pluginLoadErrors: vi.fn(() => []) }));

import PluginsPanel from './PluginsPanel';
import {
	checkPackageUpdate,
	enabledPackages,
	installPackage,
	packagesStore,
	removePackage,
	togglePackage,
	updatePackage
} from './plugins/packages';
import { pluginLoadErrors } from './plugins';
import { createTelemetryHub, type TelemetryHub } from '../core/telemetry';

let hub: TelemetryHub;

function renderPanel(over: Partial<Parameters<typeof PluginsPanel>[0]> = {}) {
	hub = createTelemetryHub();
	const props = {
		hub,
		plugins: [] as Plugin[],
		selectedId: null as string | null,
		onSelect: vi.fn(),
		...over
	};
	return { ...render(<PluginsPanel {...props} />), props };
}

// A minimal package row; override the bits a test cares about.
function pkgRow(over: Partial<PackageRow> = {}): PackageRow {
	return {
		id: 'demo',
		name: 'Demo Pack',
		version: '1.2.0',
		error: null,
		warnings: [],
		templates: 0,
		themeName: null,
		sensors: 0,
		hosts: [],
		installedFrom: null,
		...over
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	packagesStore.set([]);
	enabledPackages.set([]);
	vi.mocked(pluginLoadErrors).mockReturnValue([]);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('PluginsPanel plugin list', () => {
	it('shows the empty stub when no plugins are registered', () => {
		const { getByText } = renderPanel();
		expect(getByText('No plugins registered.')).toBeTruthy();
	});

	it('lists each plugin and fires onSelect with its id on click', () => {
		const plugins: Plugin[] = [
			{ id: 'home-assistant', name: 'Home Assistant' },
			{ id: 'now-playing', name: 'Now Playing' }
		];
		const { getByText, props } = renderPanel({ plugins });
		expect(getByText('Home Assistant')).toBeTruthy();
		fireEvent.click(getByText('Now Playing'));
		expect(props.onSelect).toHaveBeenCalledWith('now-playing');
	});

	it('renders a plugin status dot that reflects the live status-sensor value', () => {
		const plugins: Plugin[] = [
			{ id: 'home-assistant', name: 'Home Assistant', statusSensor: 'ha.status' }
		];
		const { container } = renderPanel({ plugins });
		// Absent sample → "Not connected" (statusDotFrom default → 'off').
		expect(container.querySelector('.pl-dot--off')).toBeTruthy();
		act(() => {
			hub.ingest({ sensor: 'ha.status', ts_ms: 0, value: { kind: 'text', value: 'connected' } });
		});
		const dot = container.querySelector('.pl-dot') as HTMLElement;
		expect(dot.classList.contains('pl-dot--ok')).toBe(true);
		expect(dot.getAttribute('title')).toBe('Connected');
	});

	it('lists plugins whose registration threw as inert "failed to load" rows', () => {
		vi.mocked(pluginLoadErrors).mockReturnValue([
			{ id: 'mqtt', name: 'MQTT', error: 'boom while registering' }
		]);
		const { getByText, getByTitle } = renderPanel();
		expect(getByText('MQTT')).toBeTruthy();
		expect(getByText('failed to load')).toBeTruthy();
		expect(getByTitle('boom while registering')).toBeTruthy();
	});
});

describe('PluginsPanel detail pane', () => {
	it('prompts to select a plugin when none is selected', () => {
		const { getByText } = renderPanel({ plugins: [{ id: 'a', name: 'A' }] });
		expect(getByText('Select a plugin to view its settings.')).toBeTruthy();
	});

	it('renders the selected plugin name + description and its custom settings panel', () => {
		const Settings = () => <div data-testid="custom-settings">my settings UI</div>;
		const plugins: Plugin[] = [
			{ id: 'a', name: 'Alpha', description: 'the alpha plugin', settings: Settings }
		];
		const { getByText, getByTestId } = renderPanel({ plugins, selectedId: 'a' });
		// "Alpha" appears in both the list button and the detail title — scope to the detail title.
		expect(getByText('Alpha', { selector: '.pl-title' })).toBeTruthy();
		expect(getByText('the alpha plugin')).toBeTruthy();
		expect(getByTestId('custom-settings').textContent).toBe('my settings UI');
	});

	it('isolates a throwing settings panel behind the ErrorBoundary instead of blanking the rail', () => {
		const Boom = () => {
			throw new Error('settings exploded');
		};
		const plugins: Plugin[] = [{ id: 'a', name: 'Alpha', settings: Boom }];
		// Silence the boundary's componentDidCatch console.error for a clean run.
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { getByRole } = renderPanel({ plugins, selectedId: 'a' });
		const alert = getByRole('alert');
		expect(alert.textContent).toContain('Alpha settings failed to render');
		expect(alert.textContent).toContain('settings exploded');
	});

	it('falls back to a Sources + Widget types summary when the plugin ships no settings panel', () => {
		const plugins: Plugin[] = [
			{
				id: 'sys',
				name: 'System',
				sources: [
					{ id: 'system', start: async () => () => undefined, catalog: () => ['cpu.total'] }
				],
				widgets: [
					{
						meta: { type: 'gauge', label: 'Gauge', binds: 'scalar' },
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						component: (() => null) as any
					}
				]
			}
		];
		const { getByText } = renderPanel({ plugins, selectedId: 'sys' });
		expect(getByText('Sources')).toBeTruthy();
		expect(getByText('system')).toBeTruthy();
		expect(getByText('1 sensors')).toBeTruthy(); // the source's catalog count
		expect(getByText('cpu.total')).toBeTruthy(); // SensorList row
		expect(getByText('Widget types')).toBeTruthy();
		expect(getByText('Gauge')).toBeTruthy();
	});

	it('shows the "no configurable settings" stub for a plugin with no settings, sources, or widgets', () => {
		const plugins: Plugin[] = [{ id: 'bare', name: 'Bare' }];
		const { getByText } = renderPanel({ plugins, selectedId: 'bare' });
		expect(getByText('This plugin has no configurable settings.')).toBeTruthy();
	});

	it('renders only the Widget types section (no Sources, no stub) for a widgets-only plugin', () => {
		const plugins: Plugin[] = [
			{
				id: 'w',
				name: 'W',
				widgets: [
					{
						meta: { type: 'gauge', label: 'Gauge', binds: 'scalar' },
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						component: (() => null) as any
					}
				]
			}
		];
		const { getByText, queryByText } = renderPanel({ plugins, selectedId: 'w' });
		expect(getByText('Widget types')).toBeTruthy();
		expect(queryByText('Sources')).toBeNull();
		// Has widgets → the "no configurable settings" stub must NOT appear.
		expect(queryByText('This plugin has no configurable settings.')).toBeNull();
	});

	it('renders only the Sources section (no Widget types, no stub) for a sources-only plugin', () => {
		const plugins: Plugin[] = [
			{
				id: 'src',
				name: 'Src',
				sources: [
					{ id: 'system', start: async () => () => undefined, catalog: () => ['cpu.total'] }
				]
			}
		];
		const { getByText, queryByText } = renderPanel({ plugins, selectedId: 'src' });
		expect(getByText('Sources')).toBeTruthy();
		expect(queryByText('Widget types')).toBeNull();
		// Has sources → the "no configurable settings" stub must NOT appear.
		expect(queryByText('This plugin has no configurable settings.')).toBeNull();
	});

	it('renders "0 sensors" (no SensorList) for a source without a catalog, and a widget by type when it has no label', () => {
		const plugins: Plugin[] = [
			{
				id: 'p',
				name: 'P',
				// A source with no catalog() → 0 sensors, no SensorList rows.
				sources: [{ id: 'no-cat', start: async () => () => undefined }],
				widgets: [
					{
						// No `label` in the meta → the row falls back to the bare type string.
						meta: { type: 'spectrum', binds: 'none' },
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						component: (() => null) as any
					}
				]
			}
		];
		const { getByText, container } = renderPanel({ plugins, selectedId: 'p' });
		expect(getByText('0 sensors')).toBeTruthy();
		expect(container.querySelector('.rp-sensors')).toBeNull(); // SensorList suppressed at 0 ids
		// Label-less meta → the widget row uses the bare type for BOTH the name span and the dim type
		// span, so the type string appears twice under Widget types.
		const spectrumSpans = [...container.querySelectorAll('.rp-list .rp-row span')].filter(
			(s) => s.textContent === 'spectrum'
		);
		expect(spectrumSpans.length).toBe(2);
	});
});

describe('PluginsPanel packages list', () => {
	it('shows the no-packages stub and the install button when nothing is discovered', () => {
		const { getByText } = renderPanel();
		expect(getByText('Install from URL…')).toBeTruthy();
		expect(getByText(/No packages installed/)).toBeTruthy();
	});

	it('renders a package row with its name, version, and a singular contents subtext', () => {
		// One template + a theme + one sensor → both count ternaries take the singular ('') arm.
		act(() => packagesStore.set([pkgRow({ templates: 1, themeName: 'Midnight', sensors: 1 })]));
		const { getByText } = renderPanel();
		expect(getByText('Demo Pack')).toBeTruthy();
		expect(getByText('v1.2.0')).toBeTruthy();
		// packageSubtext joins the contents with " · ".
		expect(getByText('1 template · theme “Midnight” · 1 sensor')).toBeTruthy();
	});

	it('pluralizes the template and sensor counts when there is more than one', () => {
		act(() => packagesStore.set([pkgRow({ templates: 3, sensors: 2 })]));
		const { getByText } = renderPanel();
		expect(getByText('3 templates · 2 sensors')).toBeTruthy();
	});

	it('renders an "empty" subtext for a package that ships no templates, theme, or sensors', () => {
		act(() => packagesStore.set([pkgRow()]));
		const { getByText } = renderPanel();
		expect(getByText('empty')).toBeTruthy();
	});

	it('shows a warning dot (no error) for a package that parsed with drop warnings', () => {
		act(() => packagesStore.set([pkgRow({ warnings: ['dropped an unsupported template'] })]));
		const { container, getByLabelText } = renderPanel();
		// A warn dot with the joined warnings as its tooltip — but the toggle stays enabled.
		expect(getByLabelText('Package warning')).toBeTruthy();
		expect((getByLabelText('Enable Demo Pack') as HTMLInputElement).disabled).toBe(false);
		expect(container.querySelector('[title="dropped an unsupported template"]')).toBeTruthy();
	});

	it('shows a failed-to-load subtext + untoggleable disabled checkbox for a parse failure', () => {
		act(() => packagesStore.set([pkgRow({ error: 'bad manifest' })]));
		const { getByText, getByLabelText } = renderPanel();
		expect(getByText('failed to load')).toBeTruthy();
		const box = getByLabelText('Enable Demo Pack') as HTMLInputElement;
		expect(box.disabled).toBe(true);
	});

	it('reflects the enabled allowlist in the toggle and emits togglePackage on change', () => {
		act(() => packagesStore.set([pkgRow()]));
		act(() => enabledPackages.set(['demo']));
		const { getByLabelText } = renderPanel();
		const box = getByLabelText('Enable Demo Pack') as HTMLInputElement;
		expect(box.checked).toBe(true);
		fireEvent.click(box); // unchecking
		expect(togglePackage).toHaveBeenCalledWith('demo', false, expect.any(Function));
	});

	it('wires the consent confirm callback through to window.confirm', () => {
		act(() => packagesStore.set([pkgRow()]));
		const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
		// Drive the consent path: when the panel toggles, togglePackage invokes the confirm callback
		// it was handed (the first-enable consent dialog) — assert it routes to window.confirm.
		vi.mocked(togglePackage).mockImplementation((_id, _enabled, confirmEnable) => {
			confirmEnable?.('Enable Demo Pack and allow network?');
			return Promise.resolve();
		});
		const { getByLabelText } = renderPanel();
		fireEvent.click(getByLabelText('Enable Demo Pack')); // enabling
		expect(confirmSpy).toHaveBeenCalledWith('Enable Demo Pack and allow network?');
	});

	it('shows the declared network hosts as a dim line', () => {
		act(() => packagesStore.set([pkgRow({ hosts: ['api.example.com', 'cdn.example.com'] })]));
		const { getByText } = renderPanel();
		expect(getByText('network: api.example.com, cdn.example.com')).toBeTruthy();
	});

	it('removes a package after the confirm dialog is accepted', async () => {
		act(() => packagesStore.set([pkgRow()]));
		vi.spyOn(window, 'confirm').mockReturnValue(true);
		const { getByText } = renderPanel();
		fireEvent.click(getByText('Remove'));
		await waitFor(() => expect(removePackage).toHaveBeenCalledWith('demo'));
	});

	it('alerts the reason when removal fails', async () => {
		act(() => packagesStore.set([pkgRow()]));
		vi.spyOn(window, 'confirm').mockReturnValue(true);
		const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
		vi.mocked(removePackage).mockResolvedValue({ ok: false, error: 'folder locked' });
		const { getByText } = renderPanel();
		fireEvent.click(getByText('Remove'));
		await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Remove failed: folder locked'));
	});

	it('does NOT remove when the confirm dialog is declined', async () => {
		act(() => packagesStore.set([pkgRow()]));
		vi.spyOn(window, 'confirm').mockReturnValue(false);
		const { getByText } = renderPanel();
		fireEvent.click(getByText('Remove'));
		// Give the (declined) async handler a tick — it must short-circuit before removePackage.
		await act(async () => undefined);
		expect(removePackage).not.toHaveBeenCalled();
	});

	it('installs from the URL prompt, passing the trimmed source', async () => {
		vi.spyOn(window, 'prompt').mockReturnValue('  owner/repo  ');
		const { getByText } = renderPanel();
		fireEvent.click(getByText('Install from URL…'));
		await waitFor(() => expect(installPackage).toHaveBeenCalledWith('owner/repo'));
	});

	it('alerts the reason when the install fails', async () => {
		vi.spyOn(window, 'prompt').mockReturnValue('owner/repo');
		const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
		vi.mocked(installPackage).mockResolvedValue({ ok: false, error: 'not found' });
		const { getByText } = renderPanel();
		fireEvent.click(getByText('Install from URL…'));
		await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Install failed: not found'));
	});

	it('does not install when the install prompt is cancelled (empty)', async () => {
		vi.spyOn(window, 'prompt').mockReturnValue('');
		const { getByText } = renderPanel();
		fireEvent.click(getByText('Install from URL…'));
		await act(async () => undefined);
		expect(installPackage).not.toHaveBeenCalled();
	});

	it('offers a manual update check for a URL-installed row and surfaces an available update', async () => {
		act(() => packagesStore.set([pkgRow({ installedFrom: 'owner/repo' })]));
		const { getByText, findByText } = renderPanel();
		expect(getByText('from owner/repo')).toBeTruthy();
		fireEvent.click(getByText('Check updates'));
		expect(checkPackageUpdate).toHaveBeenCalledWith('demo');
		// The available-update state surfaces an Update button + a version line.
		expect(await findByText('Update')).toBeTruthy();
		fireEvent.click(getByText('Update'));
		await waitFor(() => expect(updatePackage).toHaveBeenCalledWith('demo'));
	});

	it('falls back to "update failed" when the update returns an error-less failure', async () => {
		act(() => packagesStore.set([pkgRow({ installedFrom: 'owner/repo' })]));
		vi.mocked(updatePackage).mockResolvedValue({ ok: false }); // no `error` → default message
		const { getByText, findByText } = renderPanel();
		fireEvent.click(getByText('Check updates'));
		fireEvent.click(await findByText('Update'));
		expect(await findByText('update failed')).toBeTruthy();
	});

	it('reports "up to date" when the manual check finds no newer version', async () => {
		act(() => packagesStore.set([pkgRow({ installedFrom: 'owner/repo' })]));
		vi.mocked(checkPackageUpdate).mockResolvedValue({
			ok: true,
			current: '1.2.0',
			latest: '1.2.0',
			updateAvailable: false
		});
		const { getByText, findByText } = renderPanel();
		fireEvent.click(getByText('Check updates'));
		expect(await findByText('up to date')).toBeTruthy();
	});

	it('surfaces the manual update-check error message when the check fails', async () => {
		act(() => packagesStore.set([pkgRow({ installedFrom: 'owner/repo' })]));
		vi.mocked(checkPackageUpdate).mockResolvedValue({ ok: false, error: 'network unreachable' });
		const { getByText, findByText } = renderPanel();
		fireEvent.click(getByText('Check updates'));
		expect(await findByText('network unreachable')).toBeTruthy();
	});
});
