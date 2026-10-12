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
import './StudioAssistantSidebar.css';

type Props = {
	read(): StudioSnapshot;
	apply(ops: StudioOp[], expected: StudioSnapshot): StudioApplyResult;
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
				apply: (ops, expected) => latest.current.apply(ops, expected)
			},
			setState,
			() => crypto.randomUUID()
		)
	);
	const [status, setStatus] = useState<AgentStatus | null>(null);
	const [statusError, setStatusError] = useState('');
	const [backend, setBackend] = useState('pi-bundled');
	const initialized = useRef(false);
	const [model, setModel] = useState('');
	const [input, setInput] = useState('');
	const [refresh, setRefresh] = useState(0);
	const transcript = useRef<HTMLDivElement>(null);
	useEffect(() => {
		let alive = true;
		setStatusError('');
		void studioAgentStatus()
			.then((result) => {
				if (alive) {
					setStatus(result);
					if (!initialized.current) {
						setBackend(result.defaultBackend);
						setModel(
							['pi', 'pi-bundled'].includes(result.defaultBackend) ? result.defaultModel : ''
						);
						initialized.current = true;
					}
				}
			})
			.catch((error) => {
				if (alive) setStatusError(String(error));
			});
		return () => {
			alive = false;
		};
	}, [refresh]);
	useEffect(() => () => session.dispose(), [session]);
	useEffect(() => {
		transcript.current?.scrollTo({ top: transcript.current.scrollHeight });
	}, [state.messages, state.actions]);
	const submit = () => {
		if (!input.trim() || state.busy) return;
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
						disabled={state.busy}
						onChange={(event) => {
							session.reset();
							setBackend(event.target.value);
							setModel('');
						}}
					>
						{(
							status?.backends ?? [{ id: 'pi-bundled', label: 'Pi (bundled SDK)', available: true }]
						).map((agent) => (
							<option key={agent.id} value={agent.id} disabled={!agent.available}>
								{agent.label}
								{agent.available ? '' : ' (not installed)'}
							</option>
						))}
					</select>
				</label>
				<label>
					Model
					{['pi', 'pi-bundled'].includes(backend) ? (
						<select
							aria-label="Agent model"
							value={model}
							disabled={state.busy}
							onChange={(event) => setModel(event.target.value)}
						>
							<option value="">Pi default</option>
							{status?.models.map((option) => (
								<option key={option.id} value={option.id}>
									{option.label}
								</option>
							))}
						</select>
					) : (
						<input
							aria-label="Agent model"
							value={model}
							placeholder="Installed agent default"
							disabled={state.busy}
							onChange={(event) => setModel(event.target.value)}
						/>
					)}
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
			{status?.modelError && <p role="alert">{status.modelError}</p>}
			{status && ['pi', 'pi-bundled'].includes(backend) && !status.models.length && (
				<p className="assistant-hint">
					{backend === 'pi'
						? 'Sign in with your installed Pi, then refresh agents.'
						: 'Configure AI Provider in Plugins, or use your Pi login. Then refresh agents.'}
				</p>
			)}
			<div
				className="assistant-transcript"
				ref={transcript}
				role="log"
				aria-label="Assistant conversation"
				aria-live="polite"
			>
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
			<form
				onSubmit={(event) => {
					event.preventDefault();
					submit();
				}}
			>
				<textarea
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
						<button type="submit" disabled={!input.trim() || !status}>
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
