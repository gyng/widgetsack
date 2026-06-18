import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';

// Mock the LLM Tauri command adapter so the panel (the form + the model picker + the chat tester) can
// be exercised without a backend. Every fn is a spy so we can assert call args. The api_key is
// write-only over the bridge, so llmConfigStatus only ever reports `hasKey` (see llm-types.ts).
vi.mock('./llm-commands', () => ({
	controlStart: vi.fn(() => Promise.resolve()),
	controlStop: vi.fn(() => Promise.resolve()),
	llmConfigStatus: vi.fn(() =>
		Promise.resolve({
			configured: true,
			active: 'openai',
			providers: {
				openai: {
					baseUrl: 'https://my-proxy.test/v1',
					model: 'gpt-4o',
					hasKey: true,
					insecure: false,
					sttModel: '',
					ttsModel: '',
					ttsVoice: ''
				}
			},
			temperature: 0.7,
			maxTokens: 1024,
			agentControl: false
		})
	),
	saveLlmConfig: vi.fn(() => Promise.resolve()),
	llmTestConnection: vi.fn(() => Promise.resolve({ model: 'gpt-4o', reply: 'pong' })),
	llmComplete: vi.fn(() => Promise.resolve('{"ops":[],"summary":"ok"}')),
	llmListModels: vi.fn(() =>
		Promise.resolve([
			{ id: 'gpt-4o', label: 'gpt-4o' },
			{ id: 'gpt-4o-mini', label: 'gpt-4o-mini' }
		])
	),
	llmTranscribe: vi.fn(() => Promise.resolve('')),
	// Used by the chat tester (useLlmChat) + llm-tts; resolve so a Send doesn't hang.
	llmStream: vi.fn(() => Promise.resolve()),
	llmCancel: vi.fn(() => Promise.resolve()),
	llmSynthesize: vi.fn(() => Promise.reject(new Error('no tts')))
}));

import LlmSettings from './LlmSettings';
import {
	controlStart,
	llmConfigStatus,
	llmListModels,
	llmStream,
	llmTestConnection,
	saveLlmConfig
} from './llm-commands';
import type { LlmStatus } from './llm-types';
import { setLlmStudioApi } from './llm-studio';
import { resetChat } from '../../../stores/llmStore';
import { createTelemetryHub, type TelemetryHub } from '../../core/telemetry';
import { TelemetryHubContext } from '../telemetryContext';

let hub: TelemetryHub;

function renderPanel() {
	hub = createTelemetryHub();
	return render(
		<TelemetryHubContext.Provider value={hub}>
			<LlmSettings />
		</TelemetryHubContext.Provider>
	);
}

// A configured status with one OpenAI provider that has a saved key — the default the panel loads.
const configuredStatus = (over: Partial<LlmStatus> = {}): LlmStatus => ({
	configured: true,
	active: 'openai',
	providers: {
		openai: {
			baseUrl: 'https://my-proxy.test/v1',
			model: 'gpt-4o',
			hasKey: true,
			insecure: false,
			sttModel: '',
			ttsModel: '',
			ttsVoice: ''
		}
	},
	temperature: 0.7,
	maxTokens: 1024,
	agentControl: false,
	...over
});

// Field-locating helpers: the form has no test ids, so reach inputs by their wrapping <label> text.
const baseUrlInput = (c: HTMLElement) =>
	[...c.querySelectorAll('label')]
		.find((l) => l.textContent?.includes('Base URL'))!
		.querySelector('input') as HTMLInputElement;
const apiKeyInput = (c: HTMLElement) =>
	c.querySelector('input[type="password"]') as HTMLInputElement;
const providerSelect = (c: HTMLElement) =>
	[...c.querySelectorAll('label')]
		.find((l) => l.textContent?.startsWith('Provider'))!
		.querySelector('select') as HTMLSelectElement;
// "Save"/"Test" also appear as <strong> in the help line, so target the actual <button> by its text.
const button = (c: HTMLElement, text: string) =>
	[...c.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === text
	) as HTMLButtonElement;

beforeEach(() => {
	vi.clearAllMocks();
	resetChat(); // the chat tester shares the module-level llmStore — clear it between tests
	setLlmStudioApi(null); // the layout assistant reads a module-level studio slot — reset it
	vi.mocked(llmConfigStatus).mockResolvedValue(configuredStatus());
	vi.mocked(llmListModels).mockResolvedValue([
		{ id: 'gpt-4o', label: 'gpt-4o' },
		{ id: 'gpt-4o-mini', label: 'gpt-4o-mini' }
	]);
});

describe('LlmSettings', () => {
	it('prefills the active provider + base URL from llm_config_status, never showing the key', async () => {
		const { container } = renderPanel();
		await waitFor(() => expect(providerSelect(container).value).toBe('openai'));
		expect(baseUrlInput(container).value).toBe('https://my-proxy.test/v1');
		// The API key is write-only: the field stays empty even though OpenAI is configured.
		expect(apiKeyInput(container).value).toBe('');
		// The placeholder signals a saved key without revealing it.
		expect(apiKeyInput(container).placeholder).toMatch(/saved — leave blank to keep/);
	});

	it('shows the "configured" badge + the active provider label when the saved provider has a key', async () => {
		const { container } = renderPanel();
		// The status badge flips to ● configured once the saved key is loaded.
		await waitFor(() =>
			expect(container.querySelector('.has-badge')?.textContent).toMatch(/● configured/)
		);
		// The active provider's label sits in the dim status line next to the badge.
		expect(container.querySelector('.has-state-dim')?.textContent).toBe('OpenAI / compatible');
	});

	it('auto-loads the provider model list on mount', async () => {
		renderPanel();
		await waitFor(() =>
			expect(llmListModels).toHaveBeenCalledWith(
				expect.objectContaining({ provider: 'openai', baseUrl: 'https://my-proxy.test/v1' })
			)
		);
	});

	it('marks the form dirty after an edit (Unsaved cue)', async () => {
		const { container, findByText } = renderPanel();
		await waitFor(() => expect(baseUrlInput(container).value).toBe('https://my-proxy.test/v1'));
		fireEvent.change(baseUrlInput(container), { target: { value: 'https://other.test/v1' } });
		expect(baseUrlInput(container).value).toBe('https://other.test/v1');
		expect(await findByText(/Unsaved/)).toBeTruthy();
	});

	it('switches providers and reloads the picked provider defaults (key field hidden for keyless ollama)', async () => {
		const { container, queryByText } = renderPanel();
		await waitFor(() => expect(providerSelect(container).value).toBe('openai'));
		fireEvent.change(providerSelect(container), { target: { value: 'ollama' } });
		// Ollama has no saved entry → its catalog default base URL + first sample model populate the form.
		await waitFor(() => expect(baseUrlInput(container).value).toBe('http://localhost:11434'));
		// Ollama is keyless, so the API key field is not rendered at all.
		expect(apiKeyInput(container)).toBeNull();
		expect(queryByText(/saved — leave blank to keep/)).toBeNull();
	});

	it('saves the form body, clears the key, refreshes status and shows Saved ✓', async () => {
		const { container, findByText } = renderPanel();
		await waitFor(() => expect(baseUrlInput(container).value).toBe('https://my-proxy.test/v1'));
		fireEvent.change(apiKeyInput(container), { target: { value: 'sk-new-key' } });
		// A fresh status is returned after save (so the badges + hasKey refresh).
		vi.mocked(llmConfigStatus).mockResolvedValueOnce(configuredStatus());
		fireEvent.click(button(container, 'Save'));

		await waitFor(() =>
			expect(saveLlmConfig).toHaveBeenCalledWith(
				expect.objectContaining({
					provider: 'openai',
					baseUrl: 'https://my-proxy.test/v1',
					apiKey: 'sk-new-key',
					model: 'gpt-4o'
				})
			)
		);
		// Status is re-read after the save to refresh the per-provider key badges.
		await waitFor(() => expect(llmConfigStatus).toHaveBeenCalledTimes(2));
		// The key field is cleared back to write-only and the toast appears.
		await waitFor(() => expect(apiKeyInput(container).value).toBe(''));
		expect(await findByText('Saved ✓')).toBeTruthy();
	});

	it('surfaces a save failure in the test line', async () => {
		vi.mocked(saveLlmConfig).mockRejectedValueOnce('disk full');
		const { container, findByText } = renderPanel();
		await waitFor(() => expect(baseUrlInput(container).value).toBe('https://my-proxy.test/v1'));
		fireEvent.change(apiKeyInput(container), { target: { value: 'sk-x' } });
		fireEvent.click(button(container, 'Save'));
		expect(await findByText(/Save failed: disk full/)).toBeTruthy();
	});

	it('tests the connection without saving and reports the model + reply', async () => {
		const { container, findByText } = renderPanel();
		await waitFor(() => expect(baseUrlInput(container).value).toBe('https://my-proxy.test/v1'));
		fireEvent.click(button(container, 'Test'));
		await waitFor(() =>
			expect(llmTestConnection).toHaveBeenCalledWith(
				'openai',
				'https://my-proxy.test/v1',
				'',
				'gpt-4o',
				false
			)
		);
		// Test must NOT persist anything.
		expect(saveLlmConfig).not.toHaveBeenCalled();
		expect(await findByText(/gpt-4o replied/)).toBeTruthy();
		expect(await findByText(/pong/)).toBeTruthy();
	});

	it('shows the test error message when the connection test rejects', async () => {
		vi.mocked(llmTestConnection).mockRejectedValueOnce('401 invalid api key');
		const { container, findByText } = renderPanel();
		await waitFor(() => expect(baseUrlInput(container).value).toBe('https://my-proxy.test/v1'));
		fireEvent.click(button(container, 'Test'));
		expect(await findByText(/401 invalid api key/)).toBeTruthy();
	});

	it('refreshes the model list and reports the count next to the ↻ Models button', async () => {
		const { getByText, findByText } = renderPanel();
		await waitFor(() => expect(llmListModels).toHaveBeenCalled()); // the on-mount auto-load
		vi.mocked(llmListModels).mockClear();
		fireEvent.click(getByText('↻ Models'));
		await waitFor(() => expect(llmListModels).toHaveBeenCalledTimes(1));
		expect(await findByText('Loaded 2 models')).toBeTruthy();
	});

	it('reports an empty-list result as a typeable hint', async () => {
		const { getByText, findByText } = renderPanel();
		await waitFor(() => expect(llmListModels).toHaveBeenCalled());
		vi.mocked(llmListModels).mockResolvedValueOnce([]);
		fireEvent.click(getByText('↻ Models'));
		expect(await findByText(/returned no models/)).toBeTruthy();
	});

	it('reports a model-list failure rather than silently doing nothing', async () => {
		const { getByText, findByText } = renderPanel();
		await waitFor(() => expect(llmListModels).toHaveBeenCalled());
		vi.mocked(llmListModels).mockRejectedValueOnce('network down');
		fireEvent.click(getByText('↻ Models'));
		expect(await findByText(/Could not list models: network down/)).toBeTruthy();
	});

	it('gates the chat tester on a SAVED configured provider', async () => {
		// Active provider is configured → the chat input is reachable (no "save first" warning).
		const { findByPlaceholderText, queryByText } = renderPanel();
		expect(await findByPlaceholderText('Ask anything…')).toBeTruthy();
		expect(queryByText(/Save a configured provider/)).toBeNull();
	});

	it('shows the chat "save first" warning when no provider is configured', async () => {
		vi.mocked(llmConfigStatus).mockResolvedValue(
			configuredStatus({
				configured: false,
				providers: { openai: { ...configuredStatus().providers.openai, hasKey: false } }
			})
		);
		const { findByText, queryByPlaceholderText } = renderPanel();
		expect(await findByText(/Save a configured provider above to start chatting/)).toBeTruthy();
		expect(queryByPlaceholderText('Ask anything…')).toBeNull();
	});

	it('disables the layout assistant Generate button until a prompt is typed, then runs it', async () => {
		const { container, getByText } = renderPanel();
		await waitFor(() => expect(baseUrlInput(container).value).toBe('https://my-proxy.test/v1'));
		const gen = getByText(/Generate/).closest('button') as HTMLButtonElement;
		expect(gen.disabled).toBe(true);
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
		fireEvent.change(textarea, { target: { value: 'add a clock' } });
		expect(gen.disabled).toBe(false);
		// No studio api is wired (overlay/dev) → the assistant tells the user to open the canvas first.
		fireEvent.click(gen);
		await waitFor(() => expect(getByText(/Open the studio canvas first/)).toBeTruthy());
	});

	it('disables Save until a usable key exists (needs-key provider, none saved, blank input)', async () => {
		// An OpenAI provider that has NO saved key → Save must stay disabled until the user types one.
		vi.mocked(llmConfigStatus).mockResolvedValue(
			configuredStatus({
				configured: false,
				providers: { openai: { ...configuredStatus().providers.openai, hasKey: false } }
			})
		);
		const { container } = renderPanel();
		await waitFor(() => expect(baseUrlInput(container).value).toBe('https://my-proxy.test/v1'));
		expect(button(container, 'Save').disabled).toBe(true);
		// Typing a key makes the form submittable.
		fireEvent.change(apiKeyInput(container), { target: { value: 'sk-typed' } });
		expect(button(container, 'Save').disabled).toBe(false);
	});

	it('shows the speech model fields only for an audio-capable provider and folds edits into the save body', async () => {
		const { container } = renderPanel();
		await waitFor(() => expect(baseUrlInput(container).value).toBe('https://my-proxy.test/v1'));
		// OpenAI supports audio → the STT/TTS/voice combobox inputs render (Select sets an aria-label).
		const stt = await waitFor(() => {
			const el = container.querySelector('input[aria-label="Speech-to-text model"]');
			if (!el) throw new Error('no speech field yet');
			return el as HTMLInputElement;
		});
		fireEvent.change(stt, { target: { value: 'whisper-1' } });
		fireEvent.change(apiKeyInput(container), { target: { value: 'sk-aud' } });
		fireEvent.click(button(container, 'Save'));
		await waitFor(() =>
			expect(saveLlmConfig).toHaveBeenCalledWith(expect.objectContaining({ sttModel: 'whisper-1' }))
		);
		// Switching to keyless Ollama (no audio support) removes the speech pickers entirely.
		fireEvent.change(providerSelect(container), { target: { value: 'ollama' } });
		await waitFor(() =>
			expect(container.querySelector('input[aria-label="Speech-to-text model"]')).toBeNull()
		);
	});

	it('persists the advanced temperature / max-token params into the save body', async () => {
		const { container } = renderPanel();
		await waitFor(() => expect(baseUrlInput(container).value).toBe('https://my-proxy.test/v1'));
		const temp = container.querySelector('input[type="number"][max="2"]') as HTMLInputElement;
		const maxTok = container.querySelector('input[type="number"][max="32000"]') as HTMLInputElement;
		fireEvent.change(temp, { target: { value: '0.2' } });
		fireEvent.change(maxTok, { target: { value: '2048' } });
		fireEvent.change(apiKeyInput(container), { target: { value: 'sk-adv' } });
		fireEvent.click(button(container, 'Save'));
		await waitFor(() =>
			expect(saveLlmConfig).toHaveBeenCalledWith(
				expect.objectContaining({ temperature: 0.2, maxTokens: 2048 })
			)
		);
	});

	it('persists + starts the agent-control server when the toggle is enabled (independent of the key)', async () => {
		const { container } = renderPanel();
		await waitFor(() => expect(baseUrlInput(container).value).toBe('https://my-proxy.test/v1'));
		const toggle = [...container.querySelectorAll('input[type="checkbox"]')].find((c) =>
			c.closest('label')?.textContent?.includes('agent control')
		) as HTMLInputElement;
		fireEvent.click(toggle);
		// The toggle saves directly (not gated behind Save) and then boots the local control server.
		await waitFor(() =>
			expect(saveLlmConfig).toHaveBeenCalledWith(expect.objectContaining({ agentControl: true }))
		);
		await waitFor(() => expect(controlStart).toHaveBeenCalled());
	});

	it('sends a chat message: shows the user turn and streams via llm_stream', async () => {
		const { container, findByPlaceholderText, findByText } = renderPanel();
		const input = (await findByPlaceholderText('Ask anything…')) as HTMLInputElement;
		fireEvent.change(input, { target: { value: 'hello there' } });
		fireEvent.click(button(container, 'Send'));
		// The user's turn renders immediately and the stream is kicked off.
		expect(await findByText('hello there')).toBeTruthy();
		await waitFor(() =>
			expect(llmStream).toHaveBeenCalledWith(
				expect.stringMatching(/^chat-/),
				expect.arrayContaining([expect.objectContaining({ role: 'user', content: 'hello there' })])
			)
		);
		// The input clears after sending.
		expect(input.value).toBe('');
	});
});
