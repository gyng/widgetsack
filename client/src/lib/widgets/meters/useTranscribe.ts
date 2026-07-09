// Per-instance logic for the Transcribe / Translate widget — a self-sourcing meter's stateful hook.
// Push-to-talk: click to start the mic, click again to stop → transcribe via the provider's Whisper
// endpoint (lib/stt.ts + llm_transcribe), optionally translate the transcript (llmComplete), optionally
// speak the result (lib/tts.ts). Pure prompt logic lives in core/llm.ts.
import { useCallback, useEffect, useRef, useState } from 'react';
import { buildTranslateMessages } from '../../core/llm';
import { startRecording, type Recorder } from '../../stt';
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
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [recording, setRecording] = useState(false);
	const recorderRef = useRef<Recorder | null>(null);
	const startingRef = useRef(false);
	const cfgRef = useRef(cfg);
	// Keep the latest config in a ref, written in a commit effect (not during render), so the async
	// `run` below reads the current cfg without re-creating the recorder on every config edit.
	useEffect(() => {
		cfgRef.current = cfg;
	});

	// Release the mic if the widget unmounts mid-recording.
	useEffect(
		() => () => {
			recorderRef.current?.cancel();
			recorderRef.current = null;
		},
		[]
	);

	const run = useCallback(async (): Promise<void> => {
		if (recording) {
			const rec = recorderRef.current;
			recorderRef.current = null;
			setRecording(false);
			if (!rec) return;
			setBusy(true);
			setError('');
			try {
				const { bytes, mime } = await rec.stop();
				const transcript = (
					await llmTranscribe(bytes, mime, {
						model: cfgRef.current.model,
						language: cfgRef.current.sourceLang
					})
				).trim();
				setSource(transcript);
				let result = transcript;
				if (cfgRef.current.mode === 'translate' && transcript) {
					result = (
						await llmComplete(buildTranslateMessages(transcript, cfgRef.current.targetLang), {
							temperature: 0
						})
					).trim();
				}
				setOutput(result);
				if (cfgRef.current.speak && result) void speakSmart(result);
			} catch (e) {
				setError(String(e));
			} finally {
				setBusy(false);
			}
			return;
		}
		if (startingRef.current) return; // a getUserMedia is pending — ignore a rapid 2nd click
		startingRef.current = true;
		try {
			recorderRef.current = await startRecording(cfgRef.current.audioSource || undefined);
			setRecording(true);
			setError('');
		} catch (e) {
			setError(String(e));
		} finally {
			startingRef.current = false;
		}
	}, [recording]);

	const toggle = useCallback(() => void run(), [run]);
	return { source, output, busy, error, recording, toggle };
}
