import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';

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

// happy-dom exposes no real mic/speech APIs, so the mic + read-aloud controls never render unless we
// force the feature-detect adapters on. Mock them so the dictation / TTS branches are reachable.
vi.mock('../../stt', () => ({
	sttAvailable: vi.fn(() => true),
	startRecording: vi.fn()
}));
vi.mock('../../tts', () => ({
	ttsAvailable: vi.fn(() => true)
}));
vi.mock('./llm-tts', () => ({
	speakSmart: vi.fn(() => Promise.resolve())
}));

import LlmSettings from './LlmSettings';
import {
	controlStart,
	controlStop,
	llmComplete,
	llmConfigStatus,
	llmListModels,
	llmStream,
	llmTestConnection,
	llmTranscribe,
	saveLlmConfig
} from './llm-commands';
import type { LlmStatus } from './llm-types';
import { setLlmStudioApi } from './llm-studio';
import { speakSmart } from './llm-tts';
import { startRecording, type Recorder } from '../../stt';
import { handleDelta, resetChat } from '../../../stores/llmStore';
import { emptyMonitorLayout } from '../../core/layoutTree';
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

	it('reports an agent-control toggle failure in the test line', async () => {
		vi.mocked(saveLlmConfig).mockRejectedValueOnce('locked');
		const { container, findByText } = renderPanel();
		await waitFor(() => expect(baseUrlInput(container).value).toBe('https://my-proxy.test/v1'));
		const toggle = [...container.querySelectorAll('input[type="checkbox"]')].find((c) =>
			c.closest('label')?.textContent?.includes('agent control')
		) as HTMLInputElement;
		fireEvent.click(toggle);
		expect(await findByText(/Agent control: locked/)).toBeTruthy();
		// The save rejected before the control server boot, so neither start nor stop ran.
		expect(controlStart).not.toHaveBeenCalled();
		expect(controlStop).not.toHaveBeenCalled();
	});

	it('marks the form dirty when the model / TTS-voice combobox is edited', async () => {
		const { container } = renderPanel();
		await waitFor(() => expect(baseUrlInput(container).value).toBe('https://my-proxy.test/v1'));
		const model = container.querySelector('input[aria-label="Model"]') as HTMLInputElement;
		fireEvent.change(model, { target: { value: 'gpt-4o-mini' } });
		// Change every speech picker to a NON-default value so each Select's onChange actually fires
		// (Downshift skips onInputValueChange when the typed text equals the current value).
		const stt = container.querySelector(
			'input[aria-label="Speech-to-text model"]'
		) as HTMLInputElement;
		const ttsModel = container.querySelector(
			'input[aria-label="Text-to-speech model"]'
		) as HTMLInputElement;
		const voice = container.querySelector(
			'input[aria-label="Text-to-speech voice"]'
		) as HTMLInputElement;
		fireEvent.change(stt, { target: { value: 'gpt-4o-transcribe' } });
		fireEvent.change(ttsModel, { target: { value: 'tts-1-hd' } });
		fireEvent.change(voice, { target: { value: 'nova' } });
		fireEvent.change(apiKeyInput(container), { target: { value: 'sk-x' } });
		fireEvent.click(button(container, 'Save'));
		await waitFor(() =>
			expect(saveLlmConfig).toHaveBeenCalledWith(
				expect.objectContaining({
					model: 'gpt-4o-mini',
					sttModel: 'gpt-4o-transcribe',
					ttsModel: 'tts-1-hd',
					ttsVoice: 'nova'
				})
			)
		);
	});

	it('marks the form dirty when the self-signed-TLS checkbox is toggled', async () => {
		const { container } = renderPanel();
		await waitFor(() => expect(baseUrlInput(container).value).toBe('https://my-proxy.test/v1'));
		const insecure = [...container.querySelectorAll('input[type="checkbox"]')].find((c) =>
			c.closest('label')?.textContent?.includes('self-signed')
		) as HTMLInputElement;
		fireEvent.click(insecure);
		fireEvent.change(apiKeyInput(container), { target: { value: 'sk-tls' } });
		fireEvent.click(button(container, 'Save'));
		await waitFor(() =>
			expect(saveLlmConfig).toHaveBeenCalledWith(expect.objectContaining({ insecure: true }))
		);
	});

	// --- layout assistant: dictation + generate ---------------------------------------------

	it('dictates into the prompt: starts the mic, then stops + transcribes on the second click', async () => {
		const stop = vi.fn(() =>
			Promise.resolve({ bytes: new Uint8Array([1, 2]), mime: 'audio/webm' })
		);
		const cancel = vi.fn();
		const recorder: Recorder = { stop, cancel };
		vi.mocked(startRecording).mockResolvedValue(recorder);
		vi.mocked(llmTranscribe).mockResolvedValueOnce('hello world');

		const { container, findByText, getByText } = renderPanel();
		await waitFor(() => expect(baseUrlInput(container).value).toBe('https://my-proxy.test/v1'));
		// First click starts the mic.
		fireEvent.click(getByText('🎤 Speak'));
		await waitFor(() => expect(startRecording).toHaveBeenCalled());
		expect(await findByText(/Listening/)).toBeTruthy();
		// Second click stops + transcribes the captured bytes into the prompt textarea.
		fireEvent.click(getByText('■ Stop'));
		await waitFor(() => expect(stop).toHaveBeenCalled());
		await waitFor(() =>
			expect(llmTranscribe).toHaveBeenCalledWith(new Uint8Array([1, 2]), 'audio/webm')
		);
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
		await waitFor(() => expect(textarea.value).toBe('hello world'));
	});

	it('appends a 2nd dictation to existing prompt text and surfaces a transcription failure', async () => {
		const stop = vi.fn(() => Promise.resolve({ bytes: new Uint8Array([9]), mime: 'audio/webm' }));
		vi.mocked(startRecording).mockResolvedValue({ stop, cancel: vi.fn() });
		const { container, getByText, findByText } = renderPanel();
		await waitFor(() => expect(baseUrlInput(container).value).toBe('https://my-proxy.test/v1'));
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
		fireEvent.change(textarea, { target: { value: 'existing' } });
		vi.mocked(llmTranscribe).mockResolvedValueOnce('more');
		fireEvent.click(getByText('🎤 Speak'));
		await waitFor(() => expect(startRecording).toHaveBeenCalled());
		fireEvent.click(getByText('■ Stop'));
		await waitFor(() => expect(textarea.value).toBe('existing more'));
		// A subsequent recording whose transcription rejects shows the failure message.
		vi.mocked(llmTranscribe).mockRejectedValueOnce('whisper 500');
		fireEvent.click(getByText('🎤 Speak'));
		await waitFor(() => expect(startRecording).toHaveBeenCalledTimes(2));
		fireEvent.click(getByText('■ Stop'));
		expect(await findByText(/Voice failed: whisper 500/)).toBeTruthy();
	});

	it('falls back to the openai provider when the saved status reports no active provider', async () => {
		vi.mocked(llmConfigStatus).mockResolvedValue(configuredStatus({ active: '' }));
		const { container } = renderPanel();
		await waitFor(() => expect(providerSelect(container).value).toBe('openai'));
	});

	it('stops the agent-control server when the toggle is switched OFF', async () => {
		// Start from a status with agent control already ON so the toggle's first flip turns it off.
		vi.mocked(llmConfigStatus).mockResolvedValue(configuredStatus({ agentControl: true }));
		const { container } = renderPanel();
		await waitFor(() => expect(baseUrlInput(container).value).toBe('https://my-proxy.test/v1'));
		const toggle = [...container.querySelectorAll('input[type="checkbox"]')].find((c) =>
			c.closest('label')?.textContent?.includes('agent control')
		) as HTMLInputElement;
		expect(toggle.checked).toBe(true);
		fireEvent.click(toggle);
		await waitFor(() =>
			expect(saveLlmConfig).toHaveBeenCalledWith(expect.objectContaining({ agentControl: false }))
		);
		await waitFor(() => expect(controlStop).toHaveBeenCalled());
		expect(controlStart).not.toHaveBeenCalled();
	});

	it('reports a single loaded model with singular wording', async () => {
		const { getByText, findByText } = renderPanel();
		await waitFor(() => expect(llmListModels).toHaveBeenCalled());
		vi.mocked(llmListModels).mockResolvedValueOnce([{ id: 'gpt-4o', label: 'gpt-4o' }]);
		fireEvent.click(getByText('↻ Models'));
		expect(await findByText('Loaded 1 model')).toBeTruthy();
	});

	it('falls back to 1024 max-tokens when the field is cleared', async () => {
		const { container } = renderPanel();
		await waitFor(() => expect(baseUrlInput(container).value).toBe('https://my-proxy.test/v1'));
		const maxTok = container.querySelector('input[type="number"][max="32000"]') as HTMLInputElement;
		fireEvent.change(maxTok, { target: { value: '' } });
		fireEvent.change(apiKeyInput(container), { target: { value: 'sk-mt' } });
		fireEvent.click(button(container, 'Save'));
		await waitFor(() =>
			expect(saveLlmConfig).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 1024 }))
		);
	});

	it('shows a mic-unavailable message when starting the recorder rejects', async () => {
		vi.mocked(startRecording).mockRejectedValueOnce('NotAllowedError');
		const { container, getByText, findByText } = renderPanel();
		await waitFor(() => expect(baseUrlInput(container).value).toBe('https://my-proxy.test/v1'));
		fireEvent.click(getByText('🎤 Speak'));
		expect(await findByText(/Mic unavailable: NotAllowedError/)).toBeTruthy();
	});

	it('ignores a Ctrl+Enter on an empty prompt (no completion call)', async () => {
		setLlmStudioApi({ monitor: () => emptyMonitorLayout(), apply: vi.fn() });
		const { container } = renderPanel();
		await waitFor(() => expect(baseUrlInput(container).value).toBe('https://my-proxy.test/v1'));
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
		fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
		expect(llmComplete).not.toHaveBeenCalled();
	});

	it('warns when generating with no monitor layout available', async () => {
		setLlmStudioApi({
			monitor: () => null as never,
			apply: () => ({ applied: 0, addedIds: [], errors: [] })
		});
		const { container, getByText } = renderPanel();
		await waitFor(() => expect(baseUrlInput(container).value).toBe('https://my-proxy.test/v1'));
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
		fireEvent.change(textarea, { target: { value: 'add a clock' } });
		fireEvent.click(getByText(/Generate/));
		await waitFor(() => expect(getByText(/No layout to edit yet/)).toBeTruthy());
	});

	it('runs the layout assistant end-to-end via Ctrl+Enter when the studio is wired', async () => {
		const apply = vi.fn(() => ({ applied: 2, addedIds: ['a', 'b'], errors: [] }));
		const monitor = emptyMonitorLayout();
		setLlmStudioApi({ monitor: () => monitor, apply });
		const { container, findByText } = renderPanel();
		await waitFor(() => expect(baseUrlInput(container).value).toBe('https://my-proxy.test/v1'));
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
		fireEvent.change(textarea, { target: { value: 'add a clock and a gauge' } });
		// Ctrl+Enter submits (covers the textarea keydown handler).
		fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
		await waitFor(() => expect(llmComplete).toHaveBeenCalled());
		await waitFor(() => expect(apply).toHaveBeenCalledWith([]));
		// The summary + applied-count line renders, and the prompt clears.
		expect(await findByText(/ok — 2 changes/)).toBeTruthy();
		expect(textarea.value).toBe('');
	});

	it('reports applied errors and an invalid-reply / failed completion in the assistant', async () => {
		const apply = vi.fn(() => ({ applied: 1, addedIds: [], errors: ['bad op'] }));
		const monitor = emptyMonitorLayout();
		setLlmStudioApi({ monitor: () => monitor, apply });
		// First: a reply the parser rejects → "did not return valid layout ops".
		vi.mocked(llmComplete).mockResolvedValueOnce('not json at all');
		const { container, getByText, findByText } = renderPanel();
		await waitFor(() => expect(baseUrlInput(container).value).toBe('https://my-proxy.test/v1'));
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
		fireEvent.change(textarea, { target: { value: 'do a thing' } });
		fireEvent.click(getByText(/Generate/));
		expect(await findByText(/did not return valid layout ops/)).toBeTruthy();

		// Next: a valid reply whose apply yields errors → summary includes the error tail (1 change).
		fireEvent.change(textarea, { target: { value: 'again' } });
		fireEvent.click(getByText(/Generate/));
		expect(await findByText(/1 change \(bad op\)/)).toBeTruthy();

		// A reply with no summary string falls back to "Done" in the result line.
		vi.mocked(llmComplete).mockResolvedValueOnce('{"ops":[]}');
		fireEvent.change(textarea, { target: { value: 'no summary' } });
		fireEvent.click(getByText(/Generate/));
		expect(await findByText(/Done — 1 change/)).toBeTruthy();

		// Finally: llm_complete rejects → "Failed:" message.
		vi.mocked(llmComplete).mockRejectedValueOnce('timeout');
		fireEvent.change(textarea, { target: { value: 'boom' } });
		fireEvent.click(getByText(/Generate/));
		expect(await findByText(/Failed: timeout/)).toBeTruthy();
	});

	// --- chat tester: streamed assistant turn + read-aloud ----------------------------------

	it('renders a finished assistant turn with a working read-aloud button, and sends on Enter', async () => {
		const { container, findByPlaceholderText, findByText } = renderPanel();
		const input = (await findByPlaceholderText('Ask anything…')) as HTMLInputElement;
		fireEvent.change(input, { target: { value: 'hi' } });
		// Enter (no modifier) sends — covers the chat input keydown handler.
		fireEvent.keyDown(input, { key: 'Enter' });
		await waitFor(() => expect(llmStream).toHaveBeenCalled());
		const requestId = vi.mocked(llmStream).mock.calls[0][0] as string;
		// Stream a completed assistant turn into the shared store so the read-aloud button renders.
		act(() => {
			handleDelta({ requestId, token: 'a reply', done: false });
			handleDelta({ requestId, token: '', done: true });
		});
		const speak = (await findByText('🔊')) as HTMLButtonElement;
		fireEvent.click(speak);
		expect(speakSmart).toHaveBeenCalledWith('a reply');
		// Clearing the transcript removes the turns + the Clear button.
		fireEvent.click(button(container, 'Clear'));
		await waitFor(() => expect(container.querySelector('.has-entity')).toBeNull());
	});

	it('ignores Enter with an empty chat input and renders an errored assistant turn', async () => {
		const { findByPlaceholderText, findByText } = renderPanel();
		const input = (await findByPlaceholderText('Ask anything…')) as HTMLInputElement;
		// Enter on an empty input is a no-op (covers the onSend empty guard).
		fireEvent.keyDown(input, { key: 'Enter' });
		expect(llmStream).not.toHaveBeenCalled();
		// A real send whose stream ends in an error renders the ⚠ error turn (no read-aloud button).
		fireEvent.change(input, { target: { value: 'go' } });
		fireEvent.keyDown(input, { key: 'Enter' });
		await waitFor(() => expect(llmStream).toHaveBeenCalled());
		const requestId = vi.mocked(llmStream).mock.calls[0][0] as string;
		act(() => handleDelta({ requestId, token: '', done: true, error: 'rate limited' }));
		expect(await findByText(/⚠ rate limited/)).toBeTruthy();
	});
});
