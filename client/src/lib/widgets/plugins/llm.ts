// The AI Provider plugin: one LLM provider (Anthropic / OpenAI-compatible / local Ollama) configured
// server-side (widgetsack/src/llm.rs, plugins/llm.json) and used ACROSS THE APP — the settings panel's
// layout assistant + chat tester, and the `assistant` briefing widget. Calling `registerLlmPlugin()`
// (via plugins/index.ts) registers the settings panel + the status source + the Assistant widget.
import { registerPlugin } from '../plugin';
import type { SensorSource } from '../../core/plugin';
import LlmSettings from './LlmSettings';
import AssistantHost from '../AssistantHost';
import Transcribe from '../meters/Transcribe';
import { llmConfigStatus } from './llm-commands';
import { ingestLlmStatus, LLM_STATUS_SENSOR } from './llm-status';
import { setLlmStudioApi } from './llm-studio';
import { asMeter } from '../registry';

// Readiness-only source: one `llm.status` sample at startup (configured/unconfigured from the
// non-secret config command); LlmSettings re-ingests after a save so the dot stays live. Silent
// when the command is unavailable (no backend in tests/dev) — the dot just stays "Not connected".
const llmStatusSource: SensorSource = {
	id: 'ai-provider',
	start: async (hub) => {
		try {
			ingestLlmStatus(hub, await llmConfigStatus());
		} catch {
			// not configured / no backend — keep the default "Not connected" dot
		}
		return () => undefined;
	},
	catalog: () => [LLM_STATUS_SENSOR],
	catalogEntries: () => [{ id: LLM_STATUS_SENSOR, label: 'AI provider status' }]
};

export const registerLlmPlugin = (): void =>
	registerPlugin({
		id: 'ai-provider',
		name: 'AI Provider',
		description:
			'Configure one LLM provider (Anthropic, OpenAI-compatible, or local Ollama) used across the app — the natural-language layout assistant, the AI briefing widget, and a chat tester. The API key stays server-side.',
		settings: LlmSettings,
		sources: [llmStatusSource],
		statusSensor: LLM_STATUS_SENSOR,
		// Studio capability: stash the editor api so the settings panel's layout assistant can read the
		// live monitor + apply model-proposed ops as one undo step (see llm-studio.ts).
		studio: (api) => {
			setLlmStudioApi(api);
			return () => setLlmStudioApi(null);
		},
		widgets: [
			{
				meta: {
					// No bound sensor (binds:'none'): the AssistantHost container generates the text on a
					// schedule and feeds the pure meter. interactive so the refresh control catches clicks in
					// the passive overlay.
					type: 'assistant',
					binds: 'none',
					interactive: true,
					label: 'AI Briefing',
					description:
						'A self-updating, LLM-generated briefing from your live sensors. Configure the prompt and a schedule (interval like 5m, or a cron expression). Auto-refreshes on the overlay; manual refresh in the studio. Needs an AI provider configured.',
					defaultSize: { w: 280, h: 96 },
					defaultConfig: {
						prompt: 'Summarize my system status in one short, friendly sentence.',
						schedule: '10m',
						sensors: 'auto',
						speak: false,
						label: 'AI',
						color: ''
					},
					configFields: [
						{
							key: 'prompt',
							group: 'Data',
							label: 'prompt',
							kind: 'text',
							help: 'what to ask the AI (your live sensors are included automatically)'
						},
						{
							key: 'schedule',
							group: 'Behaviour',
							label: 'schedule',
							kind: 'text',
							help: 'how often to refresh: an interval (30s, 5m, 2h), a cron expr (e.g. 0 9 * * *), or "manual"'
						},
						{
							key: 'sensors',
							group: 'Data',
							label: 'sensors',
							kind: 'text',
							help: 'comma-separated sensor ids to feed the prompt, or "auto"'
						},
						{
							key: 'speak',
							label: 'read aloud',
							kind: 'toggle',
							group: 'Behaviour',
							help: 'speak each update (TTS)'
						},
						{ key: 'label', label: 'label', kind: 'text', group: 'Data', help: 'header text' },
						{
							key: 'color',
							label: 'colour',
							kind: 'color',
							group: 'Appearance',
							help: 'text colour (blank = theme)'
						}
					]
				},
				component: asMeter(AssistantHost)
			},
			{
				meta: {
					// Push-to-talk speech-to-text, optionally translated. Self-sourcing + interactive (the
					// mic must catch clicks in the passive overlay).
					type: 'transcribe',
					binds: 'none',
					interactive: true,
					label: 'Transcribe / Translate',
					description:
						'Push-to-talk speech-to-text, optionally translated to another language and read aloud, via the AI provider. Click the mic to record, click again to stop and transcribe. Needs an OpenAI-compatible provider (Whisper) configured.',
					defaultSize: { w: 320, h: 120 },
					defaultConfig: {
						mode: 'transcribe',
						targetLang: 'English',
						sourceLang: 'auto',
						model: '',
						audioSource: '',
						speak: false,
						label: '',
						color: ''
					},
					configFields: [
						{
							key: 'mode',
							group: 'Data',
							label: 'mode',
							kind: 'select',
							options: ['transcribe', 'translate'],
							help: 'transcribe speech, or transcribe then translate. Click the mic to talk (push-to-talk — never always-listening).'
						},
						{
							key: 'targetLang',
							group: 'Data',
							label: 'translate to',
							kind: 'text',
							help: 'target language for translate mode (e.g. English, Spanish, 日本語)'
						},
						{
							key: 'sourceLang',
							group: 'Data',
							label: 'spoken language',
							kind: 'text',
							help: 'a hint for accuracy, or "auto" to detect (e.g. auto, en, ja, es)'
						},
						{
							key: 'audioSource',
							group: 'Data',
							label: 'microphone',
							kind: 'select',
							options: [],
							catalog: 'microphones',
							help: 'which microphone to record from (blank = system default)'
						},
						{
							key: 'model',
							group: 'Data',
							label: 'transcription model',
							kind: 'text',
							help: 'blank = provider default (whisper-1); e.g. gpt-4o-transcribe, gpt-4o-mini-transcribe'
						},
						{
							key: 'speak',
							label: 'read aloud',
							kind: 'toggle',
							group: 'Behaviour',
							help: 'speak the result (TTS)'
						},
						{ key: 'label', label: 'label', kind: 'text', group: 'Data', help: 'header text' },
						{
							key: 'color',
							label: 'colour',
							kind: 'color',
							group: 'Appearance',
							help: 'text colour (blank = theme)'
						}
					]
				},
				component: asMeter(Transcribe)
			}
		]
	});
