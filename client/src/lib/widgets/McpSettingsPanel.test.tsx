import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import McpSettingsPanel from './McpSettingsPanel';
import { mcpStatus, mcpSetPreferences, type McpStatus } from '../bridge/mcp';
import { copyToClipboard } from '../overlay';
vi.mock('../bridge/mcp', () => ({ mcpStatus: vi.fn(), mcpSetPreferences: vi.fn() }));
vi.mock('../overlay', () => ({ copyToClipboard: vi.fn() }));
const off: McpStatus = {
	enabled: false,
	browserAccess: false,
	running: false,
	endpoint: null,
	browserUrl: null,
	config: { mcpServers: { widgetsack: { command: 'widgetsack.exe', args: ['--mcp'] } } }
};
beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(mcpStatus).mockResolvedValue(off);
});
it('keeps MCP and browser access off by default and copies native stdio configuration after enabling', async () => {
	const { unmount } = render(<McpSettingsPanel />);
	expect(screen.getByText('Checking MCP…')).toBeTruthy();
	const enabled = screen.getByRole('checkbox', { name: 'Enable MCP' });
	await waitFor(() => expect(enabled).toBeEnabled());
	expect(enabled).not.toBeChecked();
	vi.mocked(mcpSetPreferences).mockResolvedValue({
		...off,
		enabled: true,
		running: true,
		endpoint: 'http://127.0.0.1:1234/mcp'
	});
	fireEvent.click(enabled);
	await waitFor(() => expect(enabled).toBeChecked());
	expect(mcpSetPreferences).toHaveBeenCalledWith(true, false);
	vi.mocked(copyToClipboard).mockResolvedValue(true);
	fireEvent.click(screen.getByText('Copy MCP configuration'));
	await screen.findByText('MCP configuration copied.');
	expect(copyToClipboard).toHaveBeenCalledWith(JSON.stringify(off.config, null, 2));
	vi.mocked(copyToClipboard).mockResolvedValue(false);
	fireEvent.click(screen.getByText('Copy MCP configuration'));
	await screen.findByText('Could not copy the configuration.');
	vi.mocked(mcpSetPreferences).mockResolvedValue({
		...off,
		enabled: true,
		running: true,
		browserAccess: true,
		browserUrl: 'http://127.0.0.1:9222'
	});
	fireEvent.click(screen.getByRole('checkbox', { name: 'Allow browser tools' }));
	await screen.findByText('http://127.0.0.1:9222');
	expect(mcpSetPreferences).toHaveBeenLastCalledWith(true, true);
	unmount();
});
it('reports failed loads and failed toggles without displaying a false enabled state', async () => {
	vi.mocked(mcpStatus).mockRejectedValueOnce(new Error('Unavailable'));
	const { unmount } = render(<McpSettingsPanel />);
	await screen.findByText(/Unavailable/);
	unmount();
	render(<McpSettingsPanel />);
	const enabled = screen.getByRole('checkbox', { name: 'Enable MCP' });
	await waitFor(() => expect(enabled).toBeEnabled());
	vi.mocked(mcpSetPreferences).mockRejectedValueOnce(new Error('Could not bind'));
	fireEvent.click(enabled);
	await screen.findByText(/Could not bind/);
	expect(enabled).not.toBeChecked();
});
it('discards late loads and saves after unmount', async () => {
	let loaded!: (value: McpStatus) => void;
	vi.mocked(mcpStatus).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				loaded = resolve;
			})
	);
	const first = render(<McpSettingsPanel />);
	first.unmount();
	await act(async () => loaded(off));
	let saved!: (value: McpStatus) => void;
	vi.mocked(mcpSetPreferences).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				saved = resolve;
			})
	);
	const second = render(<McpSettingsPanel />);
	await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Enable MCP' })).toBeEnabled());
	fireEvent.click(screen.getByRole('checkbox', { name: 'Enable MCP' }));
	expect(screen.getByRole('checkbox', { name: 'Allow browser tools' })).toBeDisabled();
	second.unmount();
	await act(async () => saved(off));
});

it('ignores late error and clipboard feedback after unmount', async () => {
	let rejectLoad!: (error: Error) => void;
	vi.mocked(mcpStatus).mockImplementationOnce(
		() =>
			new Promise((_resolve, reject) => {
				rejectLoad = reject;
			})
	);
	const a = render(<McpSettingsPanel />);
	a.unmount();
	await act(async () => rejectLoad(new Error('Old load')));
	let rejectSave!: (error: Error) => void;
	vi.mocked(mcpSetPreferences).mockImplementationOnce(
		() =>
			new Promise((_resolve, reject) => {
				rejectSave = reject;
			})
	);
	const b = render(<McpSettingsPanel />);
	await waitFor(() => expect(screen.getByLabelText('Enable MCP')).toBeEnabled());
	fireEvent.click(screen.getByLabelText('Allow browser tools'));
	b.unmount();
	await act(async () => rejectSave(new Error('Old save')));
	vi.mocked(mcpStatus).mockResolvedValue({ ...off, enabled: true, running: true });
	let copied!: (value: boolean) => void;
	vi.mocked(copyToClipboard).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				copied = resolve;
			})
	);
	const c = render(<McpSettingsPanel />);
	await waitFor(() => expect(screen.getByText('Copy MCP configuration')).toBeEnabled());
	fireEvent.click(screen.getByText('Copy MCP configuration'));
	c.unmount();
	await act(async () => copied(true));
});
