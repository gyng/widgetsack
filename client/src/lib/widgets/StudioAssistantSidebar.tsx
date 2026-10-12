import { useEffect, useRef, useState } from 'react';
import {
	createStudioAgentSession,
	emptyAgentState,
	type StudioSnapshot
} from '../llm/studioAgentSession';
import type { StudioOp } from '../core/studioAssistant';
import type { StudioApplyResult } from './plugin';
import {
	studioAgentPorts,
	studioAgentStatus,
	type AgentStatus
} from './plugins/studio-agent-commands';
import Select from './Select';
import './StudioAssistantSidebar.css';

type Props = {
	read(): StudioSnapshot;
	apply(ops: StudioOp[], expected: StudioSnapshot): StudioApplyResult;
	verify?(
		expected: StudioSnapshot
	): Promise<import('../core/studioVerification').StudioVerification>;
	onClose(): void;
};
export default function StudioAssistantSidebar(props: Props) {
	const latest = useRef(props);
	useEffect(() => {
		latest.current = props;
	});
	const [state, setState] = useState(emptyAgentState);
	const [session] = useState(() =>
		createStudioAgentSession(
			studioAgentPorts,
			{
				read: () => latest.current.read(),
				apply: (ops, expected) => latest.current.apply(ops, expected),
				verify: (expected) =>
					latest.current.verify
						? latest.current.verify(expected)
						: Promise.reject(new Error('Rendered verification is unavailable.'))
			},
			setState,
			() => crypto.randomUUID()
		)
	);
	const [status, setStatus] = useState<AgentStatus | null>(null);
	const [statusError, setStatusError] = useState('');
	const [backend, setBackend] = useState('');
	const selectedBackend = useRef('');
	const [model, setModel] = useState('');
	const [input, setInput] = useState('');
	const [refresh, setRefresh] = useState(0);
	const transcript = useRef<HTMLDivElement>(null);
	const composer = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		let alive = true;
		setStatusError('');
		setStatus(null);
		void studioAgentStatus()
			.then((result) => {
				if (alive) {
					setStatus(result);
					if (
						!result.backends.some(
							(agent) => agent.id === selectedBackend.current && agent.available
						)
					) {
						session.reset();
						selectedBackend.current = result.defaultBackend;
						setBackend(result.defaultBackend);
						setModel('');
					}
				}
			})
			.catch((error) => {
				if (alive) {
					setStatus(null);
					setStatusError(String(error));
				}
			});
		return () => {
			alive = false;
		};
	}, [refresh, session]);
	useEffect(() => () => session.dispose(), [session]);
	useEffect(() => {
		transcript.current?.scrollTo({ top: transcript.current.scrollHeight });
	}, [state.messages, state.actions]);
	const available = !!status?.backends.some((agent) => agent.id === backend && agent.available);
	const submit = () => {
		if (!input.trim() || state.busy || !available) return;
		void session.send(input, backend, model);
		setInput('');
	};
	return (
		<aside className="studio-assistant" aria-label="Studio AI assistant">
			<header>
				<strong>Studio assistant</strong>
				<button type="button" aria-label="Close assistant" onClick={props.onClose}>
					×
				</button>
			</header>
			<div className="assistant-options">
				<label>
					Agent
					<select
						aria-label="Agent backend"
						value={backend}
						disabled={state.busy || !status}
						onChange={(event) => {
							session.reset();
							selectedBackend.current = event.target.value;
							setBackend(event.target.value);
							setModel('');
						}}
					>
						<option value="" disabled>
							Select an installed agent
						</option>
						{(status?.backends ?? []).map((agent) => (
							<option key={agent.id} value={agent.id} disabled={!agent.available}>
								{agent.label}
								{agent.available ? '' : ' (not installed)'}
							</option>
						))}
					</select>
				</label>
				<label>
					Model (optional)
					<Select
						searchable
						allowCustom
						options={[
							{ value: '', label: 'Installed agent default' },
							...(status?.models?.[backend] ?? []).map((value) => ({ value, label: value }))
						]}
						aria-label="Agent model"
						value={model}
						placeholder="Installed agent default"
						disabled={state.busy || !available}
						onChange={setModel}
					/>
				</label>
				<button
					type="button"
					disabled={state.busy}
					onClick={() => setRefresh((value) => value + 1)}
				>
					Refresh agents
				</button>
			</div>
			<p className="assistant-hint">
				Ask to add, arrange, or style widgets. Changes are live and undoable. Save keeps them.
			</p>
			{!status && !statusError && <p role="status">Checking agents…</p>}
			{statusError && <p role="alert">{statusError}</p>}
			{status && !status.backends.some((agent) => agent.available) ? (
				<p className="assistant-setup" role="status">
					No installed agent found. Install and sign in with Pi, Codex, or Claude, then select
					Refresh agents. Nothing is downloaded automatically.
				</p>
			) : (
				status && (
					<p className="assistant-hint">
						Uses your agent&apos;s existing login and settings. Leave Model blank to use its
						default.
					</p>
				)
			)}
			<div
				className="assistant-transcript"
				ref={transcript}
				role="log"
				aria-label="Assistant conversation"
				aria-live="polite"
			>
				{!state.messages.length && (
					<div className="assistant-empty">
						<strong>Make room for an idea.</strong>
						<p>Describe the change you want, or start here.</p>
						{['Add a clock', 'Arrange my widgets neatly'].map((prompt) => (
							<button
								key={prompt}
								type="button"
								disabled={!available}
								onClick={() => {
									setInput(prompt);
									composer.current?.focus();
								}}
							>
								{prompt}
							</button>
						))}
					</div>
				)}
				{state.messages.map((message, i) => (
					<article key={i} data-role={message.role}>
						<strong>{message.role === 'user' ? 'You' : 'Assistant'}</strong>
						<div>{message.text}</div>
					</article>
				))}
				{state.actions.map((action, i) => (
					<p className="assistant-action" key={i}>
						{action}
					</p>
				))}
			</div>
			{state.error && <p role="alert">{state.error}</p>}
			{state.busy && (
				<p className="assistant-hint" role="status">
					{status?.backends.find((agent) => agent.id === backend)?.label} is working…
				</p>
			)}
			<form
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
			>
				<textarea
					ref={composer}
					aria-label="Message to studio assistant"
					value={input}
					placeholder="Add a clock and a smooth CPU chart…"
					disabled={state.busy}
					onChange={(event) => setInput(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							submit();
						}
					}}
				/>
				<div className="assistant-actions">
					{state.busy ? (
						<button type="button" onClick={session.stop}>
							Stop
						</button>
					) : (
						<button type="submit" disabled={!input.trim() || !available}>
							Send
						</button>
					)}
					<button type="button" onClick={session.reset}>
						New chat
					</button>
				</div>
			</form>
		</aside>
	);
}
