import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, within } from '@testing-library/react';
import '../core/controls.defaults'; // register the built-in inventory
import ControlsPanel from './ControlsPanel';

const noop = () => undefined;

afterEach(() => vi.restoreAllMocks());

describe('ControlsPanel', () => {
	it('lists controls with their formatted bindings + the read-only system shortcut', () => {
		const { getByText } = render(
			<ControlsPanel overrides={{}} onRebind={noop} onReset={noop} onResetAll={noop} />
		);
		expect(() => getByText('Save draft')).not.toThrow();
		expect(() => getByText('Ctrl+S')).not.toThrow();
		expect(() => getByText('Ctrl+Alt+E')).not.toThrow();
	});

	it('captures the next chord on Rebind and reports the new key trigger', () => {
		const onRebind = vi.fn();
		const { getByText } = render(
			<ControlsPanel overrides={{}} onRebind={onRebind} onReset={noop} onResetAll={noop} />
		);
		const row = getByText('Save draft').closest('.cp-row') as HTMLElement;
		fireEvent.click(within(row).getByText('Rebind'));
		act(() => {
			window.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: true })
			);
		});
		expect(onRebind).toHaveBeenCalledWith('studio.save', {
			type: 'key',
			key: 'k',
			ctrl: true,
			shift: true
		});
	});

	it('offers a per-row reset only for overridden controls', () => {
		const onReset = vi.fn();
		const { getByText } = render(
			<ControlsPanel
				overrides={{ 'studio.save': { triggers: [{ type: 'key', key: 'k', ctrl: true }] } }}
				onRebind={noop}
				onReset={onReset}
				onResetAll={noop}
			/>
		);
		const row = getByText('Save draft').closest('.cp-row') as HTMLElement;
		fireEvent.click(within(row).getByTitle('Reset to default'));
		expect(onReset).toHaveBeenCalledWith('studio.save');
	});

	// Regression: ControlsPanel renders inside the settings panel's `.pl-detail`. If its root were a
	// `.rail-panel` (position: fixed, left:nav-w → right:0) it would cover the settings tab list and
	// trap the user on the Controls tab. Keep the root a plain in-flow `.controls-panel` block.
	it('renders a plain in-flow root, not a fixed .rail-panel that would cover the settings tabs', () => {
		const { container } = render(
			<ControlsPanel overrides={{}} onRebind={noop} onReset={noop} onResetAll={noop} />
		);
		const root = container.firstElementChild as HTMLElement;
		expect(root.classList.contains('controls-panel')).toBe(true);
		expect(root.classList.contains('rail-panel')).toBe(false);
	});

	it('Reset all fires the bulk reset', () => {
		const onResetAll = vi.fn();
		const { getByText } = render(
			<ControlsPanel overrides={{}} onRebind={noop} onReset={noop} onResetAll={onResetAll} />
		);
		fireEvent.click(getByText(/Reset all/));
		expect(onResetAll).toHaveBeenCalledTimes(1);
	});

	it('Escape during capture cancels without rebinding', () => {
		const onRebind = vi.fn();
		const { getByText } = render(
			<ControlsPanel overrides={{}} onRebind={onRebind} onReset={noop} onResetAll={noop} />
		);
		const row = getByText('Save draft').closest('.cp-row') as HTMLElement;
		fireEvent.click(within(row).getByText('Rebind'));
		// While capturing, the prompt replaces the binding text.
		expect(() => within(row).getByText(/Press keys/)).not.toThrow();
		act(() => {
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }));
		});
		expect(onRebind).not.toHaveBeenCalled();
		// Capture ended → the original binding text is shown again, no prompt.
		expect(() => within(row).getByText('Ctrl+S')).not.toThrow();
	});

	it('ignores a lone modifier press while capturing and waits for a real key', () => {
		const onRebind = vi.fn();
		const { getByText } = render(
			<ControlsPanel overrides={{}} onRebind={onRebind} onReset={noop} onResetAll={noop} />
		);
		const row = getByText('Save draft').closest('.cp-row') as HTMLElement;
		fireEvent.click(within(row).getByText('Rebind'));
		// A bare modifier must not end capture (you'd never be able to bind Ctrl+anything otherwise).
		act(() => {
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', code: 'ControlLeft' }));
		});
		expect(onRebind).not.toHaveBeenCalled();
		expect(() => within(row).getByText(/Press keys/)).not.toThrow(); // still capturing
		// The next real key completes the rebind.
		act(() => {
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', code: 'KeyG', ctrlKey: true }));
		});
		expect(onRebind).toHaveBeenCalledWith('studio.save', { type: 'key', key: 'g', ctrl: true });
	});

	it('captures Alt + Meta modifiers into the new trigger', () => {
		const onRebind = vi.fn();
		const { getByText } = render(
			<ControlsPanel overrides={{}} onRebind={onRebind} onReset={noop} onResetAll={noop} />
		);
		const row = getByText('Save draft').closest('.cp-row') as HTMLElement;
		fireEvent.click(within(row).getByText('Rebind'));
		act(() => {
			window.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', altKey: true, metaKey: true })
			);
		});
		expect(onRebind).toHaveBeenCalledWith('studio.save', {
			type: 'key',
			key: 'm',
			alt: true,
			meta: true
		});
	});

	it('shows the em-dash placeholder for a control whose triggers were cleared to none', () => {
		// An override with an empty triggers array fully replaces the defaults → the row has no binding.
		const overrides = { 'studio.save': { triggers: [] } };
		const { getByText } = render(
			<ControlsPanel overrides={overrides} onRebind={noop} onReset={noop} onResetAll={noop} />
		);
		const keys = getByText('Save draft').closest('.cp-row')!.querySelector('.cp-keys')!;
		expect(keys.textContent).toContain('—');
	});

	it('flags a conflict on both colliding controls with a warning mark + aria-label', () => {
		// Rebind Save draft onto Ctrl+Z, which collides with Undo (same studio scope) → both rows warn.
		const overrides = {
			'studio.save': { triggers: [{ type: 'key' as const, key: 'z', ctrl: true }] }
		};
		const { getByText } = render(
			<ControlsPanel overrides={overrides} onRebind={noop} onReset={noop} onResetAll={noop} />
		);
		const saveKeys = getByText('Save draft').closest('.cp-row')!.querySelector('.cp-keys')!;
		const undoKeys = getByText('Undo').closest('.cp-row')!.querySelector('.cp-keys')!;
		// Both the remapped control and the one it shadows are marked.
		expect(saveKeys.classList.contains('cp-conflict')).toBe(true);
		expect(undoKeys.classList.contains('cp-conflict')).toBe(true);
		// The visible warning glyph + the accessible description are both present.
		expect(saveKeys.querySelector('.cp-conflict-mark')).not.toBeNull();
		expect(saveKeys.getAttribute('aria-label')).toMatch(/conflicts with another control/);
		expect(saveKeys.getAttribute('title')).toBe('Conflicts with another control');
	});
});
