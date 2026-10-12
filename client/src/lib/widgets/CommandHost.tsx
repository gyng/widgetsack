import { useEffect, useRef, useState } from 'react';
import { runWidgetCommand, type CommandResult } from './plugins/command-commands';
import Command from './meters/Command';
export default function CommandHost({
	command = '',
	label = 'CLI Command'
}: {
	command?: string;
	label?: string;
}) {
	const [result, setResult] = useState<CommandResult | null>(null);
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const [executed, setExecuted] = useState('');
	const running = useRef(false);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const run = async () => {
		if (running.current || !command.trim()) return;
		running.current = true;
		setBusy(true);
		setResult(null);
		setError('');
		setExecuted(command);
		try {
			const value = await runWidgetCommand(command);
			if (mounted.current) setResult(value);
		} catch (err) {
			if (mounted.current) setError(String(err));
		} finally {
			running.current = false;
			if (mounted.current) setBusy(false);
		}
	};
	return (
		<Command
			label={label}
			command={command}
			executed={executed}
			result={result}
			error={error}
			busy={busy}
			onRun={() => {
				void run();
			}}
		/>
	);
}
