import type { CommandResult } from '../../core/commandResult';
import './ToolWidget.css';
type Props = {
	label: string;
	command: string;
	executed: string;
	result: CommandResult | null;
	error: string;
	busy: boolean;
	onRun: () => void;
};
export default function Command({ label, command, executed, result, error, busy, onRun }: Props) {
	return (
		<section className="np-tool-widget np-command" data-part="root">
			<header>
				<strong>{label}</strong>
				<button type="button" disabled={busy || !command.trim()} onClick={onRun}>
					{busy ? 'Running…' : 'Run'}
				</button>
			</header>
			<div className="tool-output">
				<code>{executed || command || 'Set a PowerShell command in the widget properties.'}</code>
				{error && <p role="alert">{error}</p>}
				{result && (
					<>
						<pre>{result.stdout}</pre>
						<pre className="tool-error">{result.stderr}</pre>
						<small>
							Exit {result.exitCode ?? 'unknown'}
							{result.truncated ? ' · Output truncated' : ''}
						</small>
					</>
				)}
				{!result && !error && (
					<p className="tool-hint">Runs only when you press Run. Stops after 30 seconds.</p>
				)}
			</div>
		</section>
	);
}
