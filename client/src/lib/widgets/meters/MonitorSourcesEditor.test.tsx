import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor, fireEvent, cleanup } from '@testing-library/react';

// Stub the Tauri-backed DDC adapter: the editor must still scan the chosen monitor's inputs and round-
// trip include/rename edits through the same `code=label` spec the widget consumes.
const { listMonitorInputs } = vi.hoisted(() => ({ listMonitorInputs: vi.fn() }));
vi.mock('../../ddc/monitors', () => ({ listMonitorInputs }));

import MonitorSourcesEditor from './MonitorSourcesEditor';
import type { MonitorInputs } from '../../ddc/monitors';

const mon = (over: Partial<MonitorInputs> = {}): MonitorInputs => ({
	gdi: '\\\\.\\DISPLAY1',
	friendly: 'Dell',
	primary: true,
	current_input: 0x11,
	supported: [0x0f, 0x11], // DisplayPort 1, HDMI 1
	width: 0,
	height: 0,
	refresh_hz: 0,
	...over
});

beforeEach(() => {
	listMonitorInputs.mockReset();
	listMonitorInputs.mockResolvedValue([mon()]);
});

describe('MonitorSourcesEditor (config form)', () => {
	it('scans the primary monitor and renders one checklist row per detected input', async () => {
		const { container } = render(
			<MonitorSourcesEditor value="" monitor="" onChange={() => undefined} />
		);
		expect(listMonitorInputs).toHaveBeenCalledWith(undefined); // '' monitor → primary
		await waitFor(() => expect(container.querySelectorAll('.ms-src-row')).toHaveLength(2));
		expect(container.querySelector('.ms-src-status')?.textContent).toBe('2 inputs');
		// blank spec = auto: every detected input checked
		const checks = [...container.querySelectorAll<HTMLInputElement>('.ms-src-check input')];
		expect(checks.every((c) => c.checked)).toBe(true);
	});

	it('falls back to the first monitor when none reports primary', async () => {
		listMonitorInputs.mockResolvedValue([
			mon({ primary: false, supported: [0x0f] }),
			mon({ gdi: '\\\\.\\DISPLAY2', primary: false, supported: [0x12] })
		]);
		const { container } = render(
			<MonitorSourcesEditor value="" monitor="" onChange={() => undefined} />
		);
		// no primary → list[0], whose single input is DisplayPort 1
		await waitFor(() => expect(container.querySelectorAll('.ms-src-row')).toHaveLength(1));
		expect(container.querySelector('.ms-src-name')?.textContent).toBe('DisplayPort 1');
	});

	it('scans the configured monitor by GDI name', async () => {
		listMonitorInputs.mockResolvedValue([
			mon({ gdi: '\\\\.\\DISPLAY2', primary: false, supported: [0x12] })
		]);
		const { container } = render(
			<MonitorSourcesEditor value="" monitor={'\\\\.\\DISPLAY2'} onChange={() => undefined} />
		);
		await waitFor(() => expect(listMonitorInputs).toHaveBeenCalledWith('\\\\.\\DISPLAY2'));
		await waitFor(() => expect(container.querySelectorAll('.ms-src-row')).toHaveLength(1));
		expect(container.querySelector('.ms-src-name')?.textContent).toBe('HDMI 2');
	});

	it('singularises the count for one input', async () => {
		listMonitorInputs.mockResolvedValue([mon({ supported: [0x0f] })]);
		const { container } = render(
			<MonitorSourcesEditor value="" monitor="" onChange={() => undefined} />
		);
		await waitFor(() =>
			expect(container.querySelector('.ms-src-status')?.textContent).toBe('1 input')
		);
	});

	it('toggling an input off emits a spec listing only the remaining included inputs', async () => {
		const onChange = vi.fn();
		const { container } = render(<MonitorSourcesEditor value="" monitor="" onChange={onChange} />);
		await waitFor(() => expect(container.querySelectorAll('.ms-src-row')).toHaveLength(2));
		const firstCheck = container.querySelector<HTMLInputElement>('.ms-src-check input')!;
		fireEvent.click(firstCheck); // uncheck DisplayPort 1 (0x0f)
		// auto no longer holds → explicit spec of just the still-included HDMI 1 (0x11)
		expect(onChange).toHaveBeenCalledWith('0x11');
	});

	it('renaming an input emits `code=label` and strips the spec separator (comma)', async () => {
		const onChange = vi.fn();
		const { container } = render(<MonitorSourcesEditor value="" monitor="" onChange={onChange} />);
		await waitFor(() => expect(container.querySelectorAll('.ms-src-row')).toHaveLength(2));
		const firstLabel = container.querySelector<HTMLInputElement>('.ms-src-label')!;
		// (A text <input> strips newlines per the HTML spec, so the comma is what exercises the
		// component's own [,\n] → space replacement.)
		fireEvent.change(firstLabel, { target: { value: 'Work,PC' } });
		// comma collapsed to a space so the spec stays parseable; HDMI 1 (auto) tails along
		expect(onChange).toHaveBeenLastCalledWith('0xf=Work PC, 0x11');
	});

	it('reflects an existing spec: only listed inputs checked, custom label shown', async () => {
		const { container } = render(
			<MonitorSourcesEditor value="0x11=Switch" monitor="" onChange={() => undefined} />
		);
		await waitFor(() => expect(container.querySelectorAll('.ms-src-row')).toHaveLength(2));
		const checks = [...container.querySelectorAll<HTMLInputElement>('.ms-src-check input')];
		// DisplayPort 1 not in the spec → unchecked; HDMI 1 in the spec → checked
		expect(checks[0].checked).toBe(false);
		expect(checks[1].checked).toBe(true);
		const labels = [...container.querySelectorAll<HTMLInputElement>('.ms-src-label')];
		expect(labels[1].value).toBe('Switch');
		// the unchecked row's label field is disabled
		expect(labels[0].disabled).toBe(true);
	});

	it('falls back to a manual text field when nothing is detected and the spec is blank', async () => {
		// No detected inputs AND an empty spec → no rows synthesised → the manual entry fallback.
		// (A non-empty spec would synthesise manual rows and keep the checklist instead.)
		listMonitorInputs.mockResolvedValue([mon({ supported: [] })]);
		const onChange = vi.fn();
		const { container } = render(<MonitorSourcesEditor value="" monitor="" onChange={onChange} />);
		await waitFor(() => expect(container.querySelector('.ms-src-empty')).not.toBeNull());
		expect(container.querySelector('.ms-src-row')).toBeNull();
		const field = container.querySelector<HTMLInputElement>('.ms-src-empty input')!;
		expect(field.value).toBe('');
		fireEvent.change(field, { target: { value: '0x12=Switch' } });
		expect(onChange).toHaveBeenCalledWith('0x12=Switch'); // raw passthrough, no spec rebuild
	});

	it('shows the manual fallback when no monitors are listed at all', async () => {
		listMonitorInputs.mockResolvedValue([]); // no target → detected = []
		const { container } = render(
			<MonitorSourcesEditor value="" monitor="" onChange={() => undefined} />
		);
		await waitFor(() => expect(container.querySelector('.ms-src-empty')).not.toBeNull());
		expect(container.querySelector('.ms-src-row')).toBeNull();
	});

	it('rescans on demand', async () => {
		const { container } = render(
			<MonitorSourcesEditor value="" monitor="" onChange={() => undefined} />
		);
		await waitFor(() => expect(container.querySelector('.ms-src-scan')).not.toBeNull());
		expect(listMonitorInputs).toHaveBeenCalledTimes(1);
		fireEvent.click(container.querySelector('.ms-src-scan')!);
		await waitFor(() => expect(listMonitorInputs).toHaveBeenCalledTimes(2));
		cleanup();
	});
});
