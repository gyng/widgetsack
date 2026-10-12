import { useEffect, useRef, useState } from 'react';
import { mcpSetPreferences, mcpStatus, type McpStatus } from '../bridge/mcp';
import { copyToClipboard } from '../overlay';
export default function McpSettingsPanel() {
	const [status, setStatus] = useState<McpStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState('');
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
				setMessage('Settings saved. Restart Widgetsack to apply changes to browser access.');
			}
		} catch (error) {
			if (alive.current) setMessage(String(error));
		} finally {
			if (alive.current) setBusy(false);
		}
	};
	return (
		<div className="mcp-settings">
			<div className="pl-title">MCP</div>
			<p className="set-help">
				Connect your own agent to Widgetsack. The assistant sidebar can stay closed.
			</p>
			<ul className="set-help-list">
				<li>Read the active layout and widget catalog.</li>
				<li>Edit widgets and layouts. Use Undo to reverse a batch. Use Save to keep it.</li>
				<li>Check widget sizes and clipping. Take a Studio screenshot to review the result.</li>
			</ul>
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
			{status && (
				<>
					<button
						type="button"
						disabled={!status.running}
						onClick={async () => {
							const ok = await copyToClipboard(JSON.stringify(status.config, null, 2));
							if (alive.current)
								setMessage(ok ? 'MCP configuration copied.' : 'Could not copy the configuration.');
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
			<ol className="set-help-list">
				<li>Enable MCP.</li>
				<li>Copy the configuration into your agent&apos;s MCP server settings.</li>
				<li>Keep Widgetsack running.</li>
				<li>Keep Studio open.</li>
			</ol>
			<p className="set-help">
				The connection uses the installed Widgetsack executable. Node is not required.
			</p>
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
					Browser tools can inspect and control the app&apos;s webviews through a local debugging
					port.
				</li>
				<li>Other programs on this machine can use this port.</li>
				<li>To close browser access, clear this option and restart Widgetsack.</li>
			</ul>
			{status?.browserUrl && (
				<p className="set-help">
					Browser endpoint: <code>{status.browserUrl}</code>
				</p>
			)}
			{message && (
				<p role="status" className="set-help">
					{message}
				</p>
			)}
		</div>
	);
}
