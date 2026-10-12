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
				setMessage('Settings saved. Browser access changes take effect after restart.');
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
				<li>Apply edits as undoable batches. Save in Studio to keep them.</li>
				<li>Check rendered sizes and overflow. Capture a Studio screenshot for visual review.</li>
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
			<p className="set-help">
				Add this configuration to a client that supports MCP over stdio. Keep Widgetsack running and
				Studio open. The installed executable handles the connection; Node is not required.
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
			<p className="set-help">
				Off by default. Restart Widgetsack after changing this option. It exposes this app’s
				WebView2 debugging port on localhost. Other local processes can connect and control the
				app’s webviews.
			</p>
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
