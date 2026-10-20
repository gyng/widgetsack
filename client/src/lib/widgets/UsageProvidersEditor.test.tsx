import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UsageProvidersEditor from './UsageProvidersEditor';
import { defaultUsageProviders, type UsageProvider } from '../core/aiUsage';
import { readAiUsage } from './plugins/ai-usage-commands';
vi.mock('./plugins/ai-usage-commands', () => ({ readAiUsage: vi.fn() }));
function Editor({ initial = defaultUsageProviders() }: { initial?: UsageProvider[] }) {
	const [value, onChange] = useState(initial);
	return <UsageProvidersEditor value={value} onChange={onChange} />;
}
beforeEach(() => {
	localStorage.clear();
	vi.mocked(readAiUsage).mockReset().mockResolvedValue({ version: 1, metrics: [] });
});
afterEach(cleanup);
describe('usage provider configuration', () => {
	it('edits labels, visibility, ordering and per-provider layout', () => {
		render(<Editor />);
		const codex = screen.getByRole('group', { name: 'Codex' });
		const icon = within(codex).getByLabelText('Icon');
		fireEvent.change(icon, { target: { value: 'deepseek' } });
		expect(icon).toHaveValue('deepseek');
		expect(
			within(screen.getByRole('group', { name: 'Claude' })).getByLabelText('Icon')
		).toHaveValue('auto');
		fireEvent.change(within(codex).getByLabelText('Label'), { target: { value: 'Work' } });
		fireEvent.change(within(codex).getByLabelText('Layout'), { target: { value: 'detailed' } });
		fireEvent.click(within(codex).getByLabelText('Enabled'));
		for (const label of [
			'Session',
			'Week',
			'Other windows',
			'Tokens',
			'Credits',
			'Banked resets',
			'Rate / ETA',
			'Graph'
		])
			fireEvent.click(within(codex).getByLabelText(label));
		fireEvent.click(screen.getByRole('button', { name: 'Move Work down' }));
		expect(screen.getAllByRole('group')[1]).toHaveAccessibleName('Work');
		fireEvent.click(screen.getByRole('button', { name: 'Move Work up' }));
		fireEvent.click(screen.getByRole('button', { name: 'Remove Claude' }));
		expect(screen.getAllByRole('group')).toHaveLength(1);
	});
	it('adds credit, OMP and custom sources with their relevant settings', async () => {
		render(<Editor initial={[]} />);
		fireEvent.click(screen.getByText('Add provider'));
		fireEvent.change(screen.getByLabelText('API key environment variable'), {
			target: { value: 'ROUTER_KEY' }
		});
		fireEvent.change(screen.getByLabelText('New usage provider'), { target: { value: 'omp' } });
		fireEvent.click(screen.getByText('Add provider'));
		fireEvent.change(screen.getByLabelText('OMP provider id (blank = all)'), {
			target: { value: 'openrouter' }
		});
		fireEvent.change(screen.getByLabelText('New usage provider'), { target: { value: 'command' } });
		fireEvent.click(screen.getByText('Add provider'));
		const group = screen.getByRole('group', { name: 'Custom provider' });
		expect(within(group).getByRole('button', { name: 'Test / activate' })).toBeDisabled();
		fireEvent.change(within(group).getByLabelText('Custom provider usage command'), {
			target: { value: 'Get-Usage' }
		});
		await act(async () =>
			fireEvent.click(within(group).getByRole('button', { name: 'Test / activate' }))
		);
		expect(screen.getByText(/command activated locally/)).toBeVisible();
		fireEvent.change(within(group).getByLabelText('Source'), { target: { value: 'claude' } });
		fireEvent.change(within(group).getByLabelText('Label'), { target: { value: '' } });
		expect(group).toHaveAccessibleName('claude');
	});
	it('tests built-in providers and reports failures without enabling bad commands', async () => {
		render(<Editor />);
		await act(async () =>
			fireEvent.click(
				within(screen.getByRole('group', { name: 'Codex' })).getByText('Test / activate')
			)
		);
		expect(screen.getByText('Valid response · 0 readings')).toBeVisible();
		vi.mocked(readAiUsage).mockRejectedValueOnce(new Error('Invalid JSON'));
		await act(async () =>
			fireEvent.click(
				within(screen.getByRole('group', { name: 'Claude' })).getByText('Test / activate')
			)
		);
		expect(screen.getByText('Error: Invalid JSON')).toBeVisible();
	});
});
it('reorders selected readings independently for each provider and retains order while hidden', () => {
	render(<Editor />);
	const codex = screen.getByRole('group', { name: 'Codex' });
	const order = within(codex).getByRole('list', { name: 'Codex reading order' });
	fireEvent.click(within(codex).getByRole('button', { name: 'Move Codex week earlier' }));
	expect(within(order).getAllByRole('listitem')[0]).toHaveTextContent('Week');
	const claude = screen.getByRole('list', { name: 'Claude reading order' });
	expect(within(claude).getAllByRole('listitem')[0]).toHaveTextContent('Session');
	fireEvent.click(within(codex).getByRole('button', { name: 'Move Codex week later' }));
	expect(within(order).getAllByRole('listitem')[0]).toHaveTextContent('Session');
	fireEvent.click(within(codex).getByLabelText('Week'));
	expect(within(order).getByLabelText('Week')).not.toBeChecked();
	expect(within(order).getByRole('button', { name: 'Move Codex week earlier' })).toBeDisabled();
	fireEvent.click(within(codex).getByLabelText('Week'));
	expect(within(order).getAllByRole('listitem')[1]).toHaveTextContent('Week');
});
it('keeps row label overrides with readings and restores defaults when cleared', () => {
	render(<Editor />);
	const codex = screen.getByRole('group', { name: 'Codex' });
	const label = within(codex).getByLabelText('Codex week label override');
	fireEvent.change(label, { target: { value: 'Weekly budget' } });
	fireEvent.click(within(codex).getByRole('button', { name: 'Move Codex week earlier' }));
	expect(label).toHaveValue('Weekly budget');
	fireEvent.change(label, { target: { value: '' } });
	expect(label).toHaveValue('');
});

it('edits settings beside each selected row with independent provider overrides', () => {
	render(<Editor />);
	const codex = screen.getByRole('group', { name: 'Codex' });
	fireEvent.click(within(codex).getByRole('button', { name: 'Settings for Codex week' }));
	let options = screen.getByRole('group', { name: 'Codex week settings' });
	expect(within(options).getByLabelText('Display')).toHaveValue('left');
	fireEvent.change(within(options).getByLabelText('Display'), { target: { value: 'used' } });

	fireEvent.change(within(options).getByLabelText('Warning used %'), { target: { value: '70' } });
	fireEvent.change(within(options).getByLabelText('Critical used %'), { target: { value: '90' } });
	fireEvent.click(within(codex).getByRole('button', { name: 'Settings for Codex week' }));
	expect(screen.queryByRole('group', { name: 'Codex week settings' })).toBeNull();
	fireEvent.click(within(codex).getByLabelText('Resets in'));
	fireEvent.click(within(codex).getByRole('button', { name: 'Settings for Codex resets' }));
	options = screen.getByRole('group', { name: 'Codex resets settings' });
	fireEvent.change(within(options).getByLabelText('Reset format'), { target: { value: 'both' } });
	fireEvent.click(within(codex).getByRole('button', { name: 'Settings for Codex graph' }));
	options = screen.getByRole('group', { name: 'Codex graph settings' });
	fireEvent.change(within(options).getByLabelText('Graph metric'), { target: { value: 'quota' } });
	fireEvent.change(within(options).getByLabelText('History hours'), { target: { value: '48' } });
	fireEvent.click(within(codex).getByRole('button', { name: 'Settings for Codex eta' }));
	options = screen.getByRole('group', { name: 'Codex eta settings' });
	fireEvent.change(within(options).getByLabelText('Rate window hours'), { target: { value: '2' } });
	fireEvent.click(within(codex).getByRole('button', { name: 'Settings for Codex tokens' }));
	options = screen.getByRole('group', { name: 'Codex tokens settings' });
	expect(within(options).queryByLabelText('Warning used %')).toBeNull();
	fireEvent.click(within(codex).getByRole('button', { name: 'Settings for Codex week' }));
	options = screen.getByRole('group', { name: 'Codex week settings' });
	expect(within(options).getByLabelText('Display')).toHaveValue('used');
	expect(within(options).getByLabelText('Warning used %')).toHaveValue(70);
});
