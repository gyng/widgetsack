// The LLM Tauri command adapter (outer ring) — every `invoke` behind a typed function, so the
// settings panel, the layout assistant, the briefing source and the chat hook share the command-name
// strings, and tests mock THIS module. The api_key is passed INWARD only (save/test); it is never
// returned (see llm-types.ts). Arg keys are camelCase on the JS side → snake_case Rust params.

import { invoke } from '@tauri-apps/api/core';
import { COMMANDS } from '../../bridge/contract';
import type { ChatMessage } from '../../core/llm';
import type { LlmAudio, LlmModel, LlmStatus, LlmTestResult } from './llm-types';

export type LlmConfigInput = {
	provider: string; // the entry to save + make active
	baseUrl: string;
	apiKey: string; // blank = keep the saved one
	model: string;
	insecure: boolean;
	temperature: number; // global
	maxTokens: number; // global
	agentControl: boolean; // global
	sttModel: string; // speech-to-text model (whisper)
	ttsModel: string; // text-to-speech model
	ttsVoice: string; // text-to-speech voice
};

/** Start the opt-in local agent-control server (after enabling it). Idempotent. */
export const controlStart = (): Promise<void> => invoke(COMMANDS.controlStart);

/** Stop the agent-control server and remove its control.json. */
export const controlStop = (): Promise<void> => invoke(COMMANDS.controlStop);

/** Non-secret config status — never the api_key. */
export const llmConfigStatus = (): Promise<LlmStatus> =>
	invoke<LlmStatus>(COMMANDS.llmConfigStatus);

/** Persist `plugins/llm.json`. A blank `apiKey` keeps the previously-saved one. Studio-only. */
export const saveLlmConfig = (cfg: LlmConfigInput): Promise<void> =>
	invoke(COMMANDS.saveLlmConfig, { ...cfg });

/** Validate an UNSAVED provider/url/key/model by sending a tiny prompt. Studio-only. */
export const llmTestConnection = (
	provider: string,
	baseUrl: string,
	apiKey: string,
	model: string,
	insecure: boolean
): Promise<LlmTestResult> =>
	invoke<LlmTestResult>(COMMANDS.llmTestConnection, { provider, baseUrl, apiKey, model, insecure });

/** One-shot completion (the workhorse). Returns the assistant's text. */
export const llmComplete = (
	messages: ChatMessage[],
	opts?: { temperature?: number; maxTokens?: number }
): Promise<string> =>
	invoke<string>(COMMANDS.llmComplete, {
		messages,
		temperature: opts?.temperature ?? null,
		maxTokens: opts?.maxTokens ?? null
	});

/** The provider's available models (best-effort; may be empty). Pass the settings form's current
 * (possibly unsaved) provider/url/key/insecure so the picker can refresh before Save; with nothing
 * passed the backend uses the saved active config. A blank apiKey reuses the saved key. */
export const llmListModels = (params?: {
	provider?: string;
	baseUrl?: string;
	apiKey?: string;
	insecure?: boolean;
}): Promise<LlmModel[]> =>
	invoke<LlmModel[]>(COMMANDS.llmListModels, {
		provider: params?.provider ?? null,
		baseUrl: params?.baseUrl ?? null,
		apiKey: params?.apiKey ?? null,
		insecure: params?.insecure ?? null
	});

/** Synthesize speech for `text` via the active provider's TTS endpoint (OpenAI-compatible only). Returns
 * the audio bytes + mime; rejects when the provider has no TTS endpoint or no key (caller falls back to
 * the browser's Web Speech voice). */
export const llmSynthesize = (text: string): Promise<LlmAudio> =>
	invoke<LlmAudio>(COMMANDS.llmSynthesize, { text });

/** Start a streamed completion; tokens arrive over the `llm_delta` event keyed by `requestId`. */
export const llmStream = (requestId: string, messages: ChatMessage[]): Promise<void> =>
	invoke(COMMANDS.llmStream, { requestId, messages });

/** Abort an in-flight stream. */
export const llmCancel = (requestId: string): Promise<void> =>
	invoke(COMMANDS.llmCancel, { requestId });

/** Transcribe recorded audio (speech-to-text) via the provider's Whisper endpoint. Bytes go as a plain
 * number array over the bridge; the key stays server-side. OpenAI-compatible providers only. `model`
 * overrides the default (whisper-1); `language` is a spoken-language hint ("auto"/blank = auto-detect). */
export const llmTranscribe = (
	audio: Uint8Array,
	mime: string,
	opts?: { model?: string; language?: string }
): Promise<string> =>
	invoke<string>(COMMANDS.llmTranscribe, {
		audio: Array.from(audio),
		mime,
		model: opts?.model?.trim() || null,
		language: opts?.language?.trim() || null
	});
