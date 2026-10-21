import { useEffect, useId, useRef, useState } from 'react';
import InspectorViewTabs from './InspectorViewTabs';
import { mcpSetPreferences, mcpStatus, type McpStatus } from '../bridge/mcp';
import { copyToClipboard } from '../overlay';
import './McpSettingsPanel.css';
export default function McpSettingsPanel({ connectionOnly = false }: { connectionOnly?: boolean }) {
	const [status, setStatus] = useState<McpStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState('');
	const [method, setMethod] = useState('Setup prompt');
	const setupId = useId();
	const setupPrompt = status
		? `Set up Widgetsack as an MCP server for this agent, using this standard input/output (stdio) configuration:

${JSON.stringify(status.config, null, 2)}

Add or update only the widgetsack server in the appropriate MCP settings for this client. Preserve all other servers and settings. Use the executable and arguments shown above; no Node.js wrapper is needed.

Ask me to enable MCP in Widgetsack under Assistant → Your agent if it is not enabled, and keep Widgetsack running with Studio open. Reconnect the server and call studio_read to verify the connection. If this client needs a restart or cannot update its own MCP settings, explain the exact remaining step. Do not edit my widgets or layout during setup.`
		: '';
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		void mcpStatus()
			.then((value) => {
				if (alive.current) setStatus(value);
			})
			.catch((error) => {
				if (alive.current) setMessage(String(error));
			});
		return () => {
			alive.current = false;
		};
	}, []);
	const change = async (enabled: boolean, browserAccess: boolean) => {
		/* v8 ignore next -- both controls are disabled while a save is active. */
		if (busy) return;
		setBusy(true);
		setMessage('');
		try {
			const result = await mcpSetPreferences(enabled, browserAccess);
			if (alive.current) {
				setStatus(result);
				setMessage(
					browserAccess !== status!.browserAccess
						? 'Settings saved. Restart Widgetsack to apply changes to browser access.'
						: 'MCP settings saved.'
				);
			}
		} catch (error) {
			if (alive.current) setMessage(String(error));
		} finally {
			if (alive.current) setBusy(false);
		}
	};
	return (
		<div className="mcp-settings">
			<h3 className="pl-title">{connectionOnly ? 'Use your existing agent' : 'MCP'}</h3>
			<p className="set-help">
				Connect Codex, Claude, or another agent to Studio using the Model Context Protocol (MCP).
				Your agent can then build widgets and edit your layout from its own chat.
			</p>
			<section className="mcp-connection-card" aria-label="MCP connection">
				<label className="set-row">
					<span className="set-label">Enable MCP</span>
					<input
						type="checkbox"
						aria-label="Enable MCP"
						checked={status?.enabled ?? false}
						disabled={busy || !status}
						onChange={(event) => void change(event.target.checked, status!.browserAccess)}
					/>
				</label>
				<p role="status" className="set-help">
					{status
						? status.running
							? `Listening: ${status.endpoint}`
							: 'MCP is off.'
						: 'Checking MCP…'}
				</p>
			</section>
			<InspectorViewTabs
				palette
				idPrefix={setupId}
				panelId={`${setupId}-setup-panel`}
				label="Connection setup"
				values={['Setup prompt', 'Manual setup']}
				active={method}
				onSelect={setMethod}
			/>
			<div
				id={`${setupId}-setup-panel`}
				role="tabpanel"
				aria-labelledby={`${setupId}-tab-${encodeURIComponent(method)}`}
			>
				<div className="mcp-method" hidden={method !== 'Manual setup'}>
					<ol className="set-help-list">
						<li>Copy this configuration into your agent&apos;s MCP server settings.</li>
						<li>Reconnect your agent, keeping Widgetsack running and Studio open.</li>
					</ol>
					{status && (
						<>
							<button
								type="button"
								disabled={!status.running}
								onClick={async () => {
									const ok = await copyToClipboard(JSON.stringify(status.config, null, 2));
									if (alive.current)
										setMessage(
											ok ? 'MCP configuration copied.' : 'Could not copy the configuration.'
										);
								}}
							>
								Copy MCP configuration
							</button>
							<textarea
								className="mcp-config"
								aria-label="MCP client configuration"
								readOnly
								rows={8}
								value={JSON.stringify(status.config, null, 2)}
							/>
						</>
					)}
					<p className="set-help">
						This uses the Widgetsack app on your computer. No Node.js installation is needed.
					</p>
				</div>
				<section className="mcp-setup" hidden={method !== 'Setup prompt'}>
					<h4>Let your agent set up the connection</h4>
					<p className="set-help">
						Copy a setup prompt with this app&apos;s MCP configuration and paste it into your
						agent&apos;s chat.
					</p>
					<button
						type="button"
						disabled={!status}
						onClick={async () => {
							const ok = await copyToClipboard(setupPrompt);
							if (alive.current)
								setMessage(ok ? 'Setup prompt copied.' : 'Could not copy the setup prompt.');
						}}
					>
						Copy setup prompt
					</button>
					<details>
						<summary>Preview prompt</summary>
						<p className="mcp-setup-text">{setupPrompt}</p>
					</details>
				</section>
			</div>
			<details className="assistant-capabilities">
				<summary>What your agent can do</summary>
				<ul className="set-help-list">
					<li>Read, add, arrange, and style widgets; check sizes and clipping.</li>
					<li>Build custom HTML widgets and reuse design presets.</li>
					<li>Configure Home Assistant, AI providers, and other integrations.</li>
				</ul>
				<p className="set-help">
					Layout edits support Undo and need Save. Integration settings save immediately; stored
					credentials are never returned to the agent.
				</p>
			</details>
			<details className="assistant-capabilities">
				<summary>Connection details</summary>
				<p className="set-help">
					The agent starts Widgetsack&apos;s MCP adapter over standard input/output (stdio). Keep
					Widgetsack running; Studio provides the active editing session.
				</p>
			</details>
			{!connectionOnly && (
				<>
					<div className="pl-title">Optional browser access</div>
					<label className="set-row">
						<span className="set-label">Allow browser tools</span>
						<input
							type="checkbox"
							aria-label="Allow browser tools"
							checked={status?.browserAccess ?? false}
							disabled={busy || !status}
							onChange={(event) => void change(status!.enabled, event.target.checked)}
						/>
					</label>
					<ul className="set-help-list">
						<li>Browser access is off by default.</li>
						<li>Restart Widgetsack after you change this option.</li>
						<li>
							Browser tools can inspect and control the app&apos;s webviews through a local
							debugging port.
						</li>
						<li>Other programs on this machine can use this port.</li>
						<li>To close browser access, clear this option and restart Widgetsack.</li>
					</ul>
					{status?.browserUrl && (
						<p className="set-help">
							Browser endpoint: <code>{status.browserUrl}</code>
						</p>
					)}
				</>
			)}
			{message && (
				<p role="status" className="set-help">
					{message}
				</p>
			)}
		</div>
	);
}
