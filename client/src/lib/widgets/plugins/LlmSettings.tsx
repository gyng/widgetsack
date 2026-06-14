// The AI Provider plugin's settings pane (studio → Plugins → AI Provider). A container (AGENTS.md §6):
// owns the provider-config form and drives the Tauri commands via llm-commands.ts; the api_key is
// write-only (a blank save keeps the saved one). Below the form sit two consumers that prove the
// provider is usable across the app:
//   - the natural-language LAYOUT ASSISTANT (builds a prompt from the widget/sensor catalog + the live
//     tree, asks the model for edit ops, applies them to the editor via the plugin's StudioApi slot,
//     llm-studio.ts), and
//   - a quick streaming CHAT tester (useLlmChat).
import { useEffect, useRef, useState } from 'react';
import { useTelemetryHub } from '../telemetryContext';
import {
	PROVIDERS,
	buildLayoutSystemPrompt,
	buildLayoutUserPrompt,
	parseAssistantReply,
	providerMeta,
	type ChatMessage
} from '../../core/llm';
import { listMetas } from '../../core/widget';
import { applyLlmStudioOps, llmStudioMonitor, llmStudioReady } from './llm-studio';
import { ingestLlmStatus } from './llm-status';
import { useLlmChat } from '../../llm/useLlmChat';
import { ttsAvailable } from '../../tts';
import { speakSmart } from './llm-tts';
import Select from '../Select';
import {
	controlStart,
	controlStop,
	llmComplete,
	llmConfigStatus,
	llmListModels,
	llmTestConnection,
	llmTranscribe,
	saveLlmConfig
} from './llm-commands';
import { sttAvailable, startRecording, type Recorder } from '../../stt';
import type { LlmModel, LlmStatus } from './llm-types';

type TestState = { kind: 'idle' } | { kind: 'ok'; msg: string } | { kind: 'err'; msg: string };
// The model-picker's own status, kept SEPARATE from `test` so refresh feedback shows next to the
// ↻ Models button (not buried under the Test/Save line at the bottom of the form).
type ModelsState = TestState | { kind: 'loading' };

export default function LlmSettings() {
	const hub = useTelemetryHub();

	// `status` holds EVERY configured provider's non-secret settings, so switching the active provider
	// reloads its saved entry (URL / model / audio) without losing the others — several stay authed.
	const [status, setStatus] = useState<LlmStatus | null>(null);
	const [provider, setProvider] = useState('openai');
	const [baseUrl, setBaseUrl] = useState('');
	const [apiKey, setApiKey] = useState(''); // write-only; blank = keep saved
	const [model, setModel] = useState('');
	const [insecure, setInsecure] = useState(false);
	const [sttModel, setSttModel] = useState('');
	const [ttsModel, setTtsModel] = useState('');
	const [ttsVoice, setTtsVoice] = useState('');
	const [temperature, setTemperature] = useState(0.7); // global
	const [maxTokens, setMaxTokens] = useState(1024); // global
	const [agentControl, setAgentControl] = useState(false); // global
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [dirty, setDirty] = useState(false); // form differs from the saved plugins/llm.json
	const [test, setTest] = useState<TestState>({ kind: 'idle' });
	const [models, setModels] = useState<LlmModel[]>([]);
	const [modelsState, setModelsState] = useState<ModelsState>({ kind: 'idle' });

	// Auto-dismiss the "Saved ✓" tick like a toast (it otherwise lingers until the next edit).
	useEffect(() => {
		if (!saved) return;
		const t = setTimeout(() => setSaved(false), 2500);
		return () => clearTimeout(t);
	}, [saved]);

	const meta = providerMeta(provider);
	const needsKey = meta.needsKey;
	const hasKey = !needsKey || !!status?.providers[provider]?.hasKey;

	// Populate the form from a provider's SAVED entry (or the catalog defaults when it has none yet) —
	// this is what makes the Base URL / model / audio fields follow the provider on switch. The api key
	// is write-only, so it always resets to blank ("leave blank to keep").
	const loadProvider = (id: string, st: LlmStatus | null) => {
		const m = providerMeta(id);
		const p = st?.providers[id];
		setBaseUrl(p?.baseUrl ?? m.defaultBaseUrl);
		setModel(p?.model ?? '');
		setInsecure(p?.insecure ?? false);
		setSttModel(p?.sttModel ?? '');
		setTtsModel(p?.ttsModel ?? '');
		setTtsVoice(p?.ttsVoice ?? '');
		setApiKey('');
		setModels([]);
		setModelsState({ kind: 'idle' });
	};

	useEffect(() => {
		let alive = true;
		llmConfigStatus()
			.then((s) => {
				if (!alive) return;
				setStatus(s);
				const active = s.active || 'openai';
				setProvider(active);
				setTemperature(s.temperature);
				setMaxTokens(s.maxTokens);
				setAgentControl(s.agentControl);
				loadProvider(active, s);
			})
			.catch(() => undefined);
		return () => {
			alive = false;
		};
	}, []);

	// Any field edit marks the form dirty (and clears the Saved tick) so an "Unsaved — click Save" cue can
	// nudge the user to persist — the #1 confusion was Test working while Chat/widgets need a saved config.
	const dirtied = () => {
		setSaved(false);
		setDirty(true);
	};
	const onPickProvider = (id: string) => {
		setProvider(id);
		loadProvider(id, status);
		dirtied();
	};

	const canSubmit = !saving && (!needsKey || hasKey || apiKey.trim().length > 0);
	// Listing models needs auth, so disable refresh until a key is usable (saved or just typed).
	const canListModels = !needsKey || hasKey || apiKey.trim().length > 0;
	// The Chat tester + assistant call the SAVED active provider (the backend reads plugins/llm.json), so
	// readiness tracks the saved file, NOT the in-progress form — surfacing this kills the "I added a key
	// but chat hangs" trap (Test works unsaved; Chat needs a Save).
	const activeReady = !!status?.configured;
	const activeLabel = status?.active ? providerMeta(status.active).label : undefined;

	// Build the typeahead options for a free-text Select: the live list (when loaded) else the samples.
	const modelOptions = models.length
		? models.map((m) => ({ value: m.id, label: m.label }))
		: meta.sampleModels.map((m) => ({ value: m, label: m }));
	const sampleOptions = (xs: string[]) => xs.map((x) => ({ value: x, label: x }));

	// One save body for both the Save button and the agent-control toggle (the active provider's entry +
	// the global params). A blank apiKey keeps the saved key.
	const configBody = (overrides: { apiKey?: string; agentControl?: boolean } = {}) => ({
		provider,
		baseUrl: baseUrl.trim(),
		apiKey: overrides.apiKey ?? apiKey,
		model: model.trim(),
		insecure,
		temperature,
		maxTokens,
		agentControl: overrides.agentControl ?? agentControl,
		sttModel: sttModel.trim(),
		ttsModel: ttsModel.trim(),
		ttsVoice: ttsVoice.trim()
	});

	const onSave = async () => {
		if (!canSubmit) return;
		setSaving(true);
		try {
			await saveLlmConfig(configBody());
			setApiKey(''); // back to write-only
			const next = await llmConfigStatus(); // refresh per-provider key badges + hasKey
			setStatus(next);
			ingestLlmStatus(hub, next); // keep the Plugins-list dot live without a restart
			setSaved(true);
			setDirty(false);
		} catch (err) {
			setTest({ kind: 'err', msg: `Save failed: ${String(err)}` });
		} finally {
			setSaving(false);
		}
	};

	// Agent control is INDEPENDENT of the LLM provider key (it actuates media/HA for an external MCP
	// agent, it doesn't call the provider), so the toggle applies + persists directly — NOT gated behind
	// the key-dependent Save button.
	const applyAgentControl = async (next: boolean) => {
		setAgentControl(next);
		try {
			await saveLlmConfig(configBody({ agentControl: next }));
			await (next ? controlStart() : controlStop());
			setDirty(false); // configBody persisted every field, so the form now matches disk
		} catch (err) {
			setTest({ kind: 'err', msg: `Agent control: ${String(err)}` });
		}
	};

	const onTest = async () => {
		setTest({ kind: 'idle' });
		try {
			const r = await llmTestConnection(provider, baseUrl.trim(), apiKey, model.trim(), insecure);
			setTest({ kind: 'ok', msg: `${r.model} replied: “${r.reply}”` });
		} catch (err) {
			setTest({ kind: 'err', msg: String(err) });
		}
	};

	// List the provider's models for the CURRENT form (provider/url/key/insecure), so refresh works for
	// a just-switched or not-yet-saved provider. Shows in-flight + result feedback next to the button —
	// the prior version gave none, so an empty list or a buried error read as "nothing happens".
	const onLoadModels = async () => {
		setModelsState({ kind: 'loading' });
		try {
			const list = await llmListModels({ provider, baseUrl: baseUrl.trim(), apiKey, insecure });
			setModels(list);
			setModelsState(
				list.length
					? { kind: 'ok', msg: `Loaded ${list.length} model${list.length === 1 ? '' : 's'}` }
					: { kind: 'err', msg: `${meta.label} returned no models (type the id manually)` }
			);
		} catch (err) {
			setModelsState({ kind: 'err', msg: `Could not list models: ${String(err)}` });
		}
	};

	return (
		<div className="has">
			<div className="has-statusline">
				<span className={`has-badge ${hasKey ? 'ok' : 'idle'}`}>
					● {hasKey ? 'configured' : 'not configured'}
				</span>
				<span className="has-state-dim">{meta.label}</span>
			</div>

			<div className="rp-hd">Provider</div>
			<div className="has-help">
				Pick the active AI provider — used across the app (the layout assistant, a briefing widget,
				any chat). Each provider keeps its own key + settings, so you can stay signed in to several
				and switch freely. Keys stay on this machine (<code>plugins/llm.json</code>) and never cross
				into the webview.
			</div>

			<label className="has-field">
				Provider
				<select value={provider} onChange={(e) => onPickProvider(e.currentTarget.value)}>
					{PROVIDERS.map((p) => (
						<option key={p.id} value={p.id}>
							{p.label}
						</option>
					))}
				</select>
			</label>
			{/* Per-provider auth at a glance (the active one outlined), so the multi-provider state is visible. */}
			<div className="has-authrow" aria-label="Provider authentication">
				{PROVIDERS.map((p) => {
					const keyed = !p.needsKey || !!status?.providers[p.id]?.hasKey;
					return (
						<span
							key={p.id}
							className={`has-chip${keyed ? ' ok' : ''}${p.id === provider ? ' active' : ''}`}
						>
							{p.label.split(' ')[0]} {keyed ? '✓' : '—'}
						</span>
					);
				})}
			</div>
			<div className="has-help">{meta.help}</div>

			<div className="rp-hd">Connection</div>
			<label className="has-field">
				Base URL
				<input
					type="text"
					autoComplete="off"
					placeholder={meta.defaultBaseUrl}
					value={baseUrl}
					onChange={(e) => {
						setBaseUrl(e.currentTarget.value);
						dirtied();
					}}
				/>
			</label>

			{needsKey && (
				<label className="has-field">
					API key
					<input
						type="password"
						autoComplete="off"
						placeholder={hasKey ? '•••••••• saved — leave blank to keep' : 'API key'}
						value={apiKey}
						onChange={(e) => {
							setApiKey(e.currentTarget.value);
							dirtied();
						}}
					/>
				</label>
			)}

			<div className="has-browser-bar">
				<label className="has-field" style={{ flex: 3 }}>
					Model
					<Select
						allowCustom
						value={model}
						options={modelOptions}
						placeholder={meta.sampleModels[0] ?? 'model id'}
						aria-label="Model"
						onChange={(v) => {
							setModel(v);
							dirtied();
						}}
					/>
				</label>
				<button
					type="button"
					onClick={onLoadModels}
					disabled={modelsState.kind === 'loading' || !canListModels}
					aria-busy={modelsState.kind === 'loading'}
					title={canListModels ? "List the provider's models" : 'Enter an API key first'}
				>
					{modelsState.kind === 'loading' ? 'Loading…' : '↻ Models'}
				</button>
			</div>
			{modelsState.kind === 'ok' && <div className="has-test ok">{modelsState.msg}</div>}
			{modelsState.kind === 'err' && <div className="has-test err">⚠ {modelsState.msg}</div>}
			<small className="has-help">
				Blank uses the provider default; ↻ Models lists what your key can access.
			</small>

			{meta.supportsAudio && (
				<>
					<div className="rp-hd">Speech</div>
					<div className="has-help">
						Voice models for the dictation (speech-to-text) and read-aloud (text-to-speech)
						features. Leave blank for the provider defaults (whisper-1 / tts-1).
					</div>
					<label className="has-field">
						Speech-to-text model
						<Select
							allowCustom
							value={sttModel}
							options={sampleOptions(meta.sampleSttModels)}
							placeholder="whisper-1"
							aria-label="Speech-to-text model"
							onChange={(v) => {
								setSttModel(v);
								dirtied();
							}}
						/>
					</label>
					<div className="has-browser-bar">
						<label className="has-field" style={{ flex: 1 }}>
							Text-to-speech model
							<Select
								allowCustom
								value={ttsModel}
								options={sampleOptions(meta.sampleTtsModels)}
								placeholder="tts-1"
								aria-label="Text-to-speech model"
								onChange={(v) => {
									setTtsModel(v);
									dirtied();
								}}
							/>
						</label>
						<label className="has-field" style={{ flex: 1 }}>
							Voice
							<Select
								allowCustom
								value={ttsVoice}
								options={sampleOptions(meta.sampleVoices)}
								placeholder="alloy"
								aria-label="Text-to-speech voice"
								onChange={(v) => {
									setTtsVoice(v);
									dirtied();
								}}
							/>
						</label>
					</div>
				</>
			)}

			<details className="has-advanced">
				<summary>Advanced</summary>
				<div className="has-browser-bar">
					<label className="has-field" style={{ flex: 1 }}>
						Temperature
						<input
							type="number"
							min={0}
							max={2}
							step={0.1}
							value={temperature}
							onChange={(e) => {
								setTemperature(Number(e.currentTarget.value));
								dirtied();
							}}
						/>
					</label>
					<label className="has-field" style={{ flex: 1 }}>
						Max tokens
						<input
							type="number"
							min={1}
							max={32000}
							value={maxTokens}
							onChange={(e) => {
								setMaxTokens(Number(e.currentTarget.value) || 1024);
								dirtied();
							}}
						/>
					</label>
				</div>
				<label className="has-check">
					<input
						type="checkbox"
						checked={insecure}
						onChange={(e) => {
							setInsecure(e.currentTarget.checked);
							dirtied();
						}}
					/>
					Allow self-signed / invalid TLS (a local endpoint behind a self-signed cert)
				</label>
				<label className="has-check">
					<input
						type="checkbox"
						checked={agentControl}
						onChange={(e) => void applyAgentControl(e.currentTarget.checked)}
					/>
					Enable agent control (local port for MCP media / Home Assistant actuation)
				</label>
				{agentControl && (
					<div className="has-warn">
						⚠ Opens a token-guarded server on 127.0.0.1 so an MCP agent can control media + Home
						Assistant. Off by default; only enable if you use the MCP integration.
					</div>
				)}
			</details>

			<div className="has-actions">
				<button
					type="button"
					className="has-primary"
					onClick={onSave}
					disabled={!canSubmit}
					aria-busy={saving}
				>
					{saving ? 'Saving…' : 'Save'}
				</button>
				<button type="button" onClick={onTest} disabled={saving}>
					Test
				</button>
				{saved && <span className="has-ok">Saved ✓</span>}
				{!saved && dirty && <span className="has-unsaved">● Unsaved — click Save</span>}
			</div>
			<small className="has-help">
				<strong>Test</strong> checks the key without saving. <strong>Save</strong> persists it so
				Chat, the assistant &amp; widgets can use the provider.
			</small>
			{test.kind === 'ok' && <div className="has-test ok">{test.msg}</div>}
			{test.kind === 'err' && <div className="has-test err">⚠ {test.msg}</div>}

			<LayoutAssistant sensorIds={() => hub.sensorIds()} />
			<ChatTester ready={activeReady} activeLabel={activeLabel} />
		</div>
	);
}

// --- the natural-language layout assistant ---------------------------------------------------

function LayoutAssistant({ sensorIds }: { sensorIds: () => string[] }) {
	const [prompt, setPrompt] = useState('');
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState('');
	const [recording, setRecording] = useState(false);
	const recorderRef = useRef<Recorder | null>(null);
	const startingRef = useRef(false);

	// Release the mic if the panel unmounts mid-recording (selecting another plugin closes it).
	useEffect(
		() => () => {
			recorderRef.current?.cancel();
			recorderRef.current = null;
		},
		[]
	);

	// Push-to-talk dictation: first click starts the mic; second stops + transcribes into the prompt.
	const onMic = async () => {
		if (recording) {
			const rec = recorderRef.current;
			recorderRef.current = null;
			setRecording(false);
			if (!rec) return;
			setMsg('Transcribing…');
			try {
				const { bytes, mime } = await rec.stop();
				const text = (await llmTranscribe(bytes, mime)).trim();
				setPrompt((p) => (p ? `${p} ${text}` : text).trim());
				setMsg('');
			} catch (err) {
				setMsg(`Voice failed: ${String(err)}`);
			}
			return;
		}
		if (startingRef.current) return; // a getUserMedia is already pending — ignore a rapid 2nd click
		startingRef.current = true;
		try {
			recorderRef.current = await startRecording();
			setRecording(true);
			setMsg('● Listening… click the mic again to stop.');
		} catch (err) {
			setMsg(`Mic unavailable: ${String(err)}`);
		} finally {
			startingRef.current = false;
		}
	};

	const onGenerate = async () => {
		const instruction = prompt.trim();
		if (!instruction) return;
		if (!llmStudioReady()) {
			setMsg('Open the studio canvas first — the assistant edits the live layout.');
			return;
		}
		const monitor = llmStudioMonitor();
		if (!monitor) {
			setMsg('No layout to edit yet.');
			return;
		}
		setBusy(true);
		setMsg('');
		try {
			const system = buildLayoutSystemPrompt(listMetas(), sensorIds());
			const user = buildLayoutUserPrompt(instruction, monitor);
			const messages: ChatMessage[] = [
				{ role: 'system', content: system },
				{ role: 'user', content: user }
			];
			const reply = await llmComplete(messages, { temperature: 0 });
			const parsed = parseAssistantReply(reply);
			if (!parsed) {
				setMsg('The model did not return valid layout ops. Try rephrasing.');
				return;
			}
			const res = applyLlmStudioOps(parsed.ops);
			const tail = res.errors.length ? ` (${res.errors.join('; ')})` : '';
			setMsg(
				`${parsed.summary || 'Done'} — ${res.applied} change${res.applied === 1 ? '' : 's'}${tail}`
			);
			setPrompt('');
		} catch (err) {
			setMsg(`Failed: ${String(err)}`);
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<div className="rp-hd">Layout assistant</div>
			<div className="has-help">
				Describe a change in plain language — e.g.{' '}
				<em>“add a CPU gauge and a GPU gauge in a row”</em> — and the model edits your canvas. One
				undo step; review and Ctrl+Z if you don’t like it.
			</div>
			<label className="has-field">
				<textarea
					className="has-search"
					rows={2}
					spellCheck={false}
					placeholder="add a clock top-left and a memory bar under it"
					value={prompt}
					onChange={(e) => setPrompt(e.currentTarget.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void onGenerate();
					}}
				/>
			</label>
			<div className="has-actions">
				<button
					type="button"
					className="has-primary"
					onClick={onGenerate}
					disabled={busy || prompt.trim().length === 0}
				>
					{busy ? 'Thinking…' : 'Generate (⌘/Ctrl+↵)'}
				</button>
				{sttAvailable() && (
					<button
						type="button"
						className={recording ? 'has-primary' : ''}
						onClick={onMic}
						title="Dictate the request (speech-to-text)"
					>
						{recording ? '■ Stop' : '🎤 Speak'}
					</button>
				)}
			</div>
			{msg && <div className="has-help">{msg}</div>}
		</>
	);
}

// --- a quick streaming chat tester -----------------------------------------------------------

function ChatTester({ ready, activeLabel }: { ready: boolean; activeLabel?: string }) {
	const { chat, send, reset } = useLlmChat();
	const [input, setInput] = useState('');
	const logRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
	}, [chat]);

	const onSend = () => {
		const text = input.trim();
		if (!text) return;
		void send(text);
		setInput('');
	};

	return (
		<>
			<div className="rp-hd">Chat</div>
			<div className="has-help">
				A quick streamed test of the saved provider{activeLabel ? ` (${activeLabel})` : ''}.
			</div>
			{!ready ? (
				// The chat calls the SAVED active provider — make the "you must Save first" requirement
				// explicit instead of letting a send fail with an error turn.
				<div className="has-warn">Save a configured provider above to start chatting.</div>
			) : (
				<>
					{chat.turns.length > 0 && (
						<div
							className="has-entities"
							ref={logRef}
							style={{ maxHeight: 180, overflowY: 'auto' }}
						>
							{chat.turns.map((t) => (
								<div key={t.id} className="has-entity" style={{ display: 'block' }}>
									<span className="has-state-dim">{t.role === 'user' ? 'you' : 'ai'}</span>{' '}
									<span>{t.error ? `⚠ ${t.error}` : t.content || (t.streaming ? '…' : '')}</span>
									{t.role === 'assistant' && t.content && !t.streaming && ttsAvailable() && (
										<button
											type="button"
											className="has-copy"
											title="Read aloud"
											aria-label="Read aloud"
											onClick={() => void speakSmart(t.content)}
										>
											🔊
										</button>
									)}
								</div>
							))}
						</div>
					)}
					<div className="has-browser-bar">
						<label className="has-field" style={{ flex: 3 }}>
							<input
								type="text"
								autoComplete="off"
								placeholder="Ask anything…"
								value={input}
								onChange={(e) => setInput(e.currentTarget.value)}
								onKeyDown={(e) => {
									if (e.key === 'Enter') onSend();
								}}
							/>
						</label>
						<button type="button" className="has-primary" onClick={onSend} disabled={!input.trim()}>
							Send
						</button>
						{chat.turns.length > 0 && (
							<button type="button" onClick={reset} title="Clear the transcript">
								Clear
							</button>
						)}
					</div>
				</>
			)}
		</>
	);
}
