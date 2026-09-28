// Per-instance logic for the Transcribe / Translate widget — a self-sourcing meter's stateful hook.
// Push-to-talk: click to start the mic, click again to stop → transcribe via the provider's Whisper
// endpoint (lib/stt.ts + llm_transcribe), optionally translate the transcript (llmComplete), optionally
// speak the result (lib/tts.ts). Pure prompt logic lives in core/llm.ts.
import { useState } from 'react';
import { buildTranslateMessages } from '../../core/llm';
import { useRecording } from '../../useRecording';
import { speakSmart } from '../plugins/llm-tts';
import { llmComplete, llmTranscribe } from '../plugins/llm-commands';

export type TranscribeConfig = {
	mode: 'transcribe' | 'translate';
	targetLang: string;
	/** Spoken-language hint for transcription ("auto" / blank = auto-detect). */
	sourceLang?: string;
	/** Override the transcription model (blank = provider default, e.g. whisper-1). */
	model?: string;
	/** Microphone device id (blank = system default). */
	audioSource?: string;
	speak?: boolean;
};

export type TranscribeState = {
	/** The raw transcript. */
	source: string;
	/** What to show: the translation in translate mode, else the transcript. */
	output: string;
	busy: boolean;
	error: string;
	recording: boolean;
	/** Toggle the mic: start recording, or stop + transcribe (+ translate/speak). */
	toggle: () => void;
};

export function useTranscribe(cfg: TranscribeConfig): TranscribeState {
	const [source, setSource] = useState('');
	const [output, setOutput] = useState('');

	const mic = useRecording(async ({ bytes, mime }, current) => {
		const transcript = (
			await llmTranscribe(bytes, mime, { model: cfg.model, language: cfg.sourceLang })
		).trim();
		if (!current()) return;
		setSource(transcript);
		let result = transcript;
		if (cfg.mode === 'translate' && transcript) {
			result = (
				await llmComplete(buildTranslateMessages(transcript, cfg.targetLang), { temperature: 0 })
			).trim();
			if (!current()) return;
		}
		setOutput(result);
		if (cfg.speak && result) void speakSmart(result);
	}, cfg.audioSource || undefined);
	return { source, output, ...mic };
}
