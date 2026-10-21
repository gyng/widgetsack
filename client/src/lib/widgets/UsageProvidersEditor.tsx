import { useState } from 'react';
import {
	usageProviders,
	usageItems,
	usageSourceKey,
	type UsageProvider,
	type UsageSnapshot,
	type UsageSource
} from '../core/aiUsage';
import { readAiUsage } from './plugins/ai-usage-commands';
import { approveUsageCommand } from './plugins/ai-usage-source';
import './UsageProvidersEditor.css';
import UsageItemSettingsEditor from './UsageItemSettingsEditor';
import { providerIcons, type ProviderIconChoice } from '../core/providerIcons';
import {
	readUsageSettings,
	resolveUsageSettings,
	type UsageSettings
} from '../core/aiUsageSettings';

export default function UsageProvidersEditor({
	value,
	defaults,
	onChange
}: {
	value: unknown;
	defaults?: unknown;
	onChange: (value: UsageProvider[]) => void;
}) {
	const providers = usageProviders(value);
	const legacy = readUsageSettings(defaults);
	const [expanded, setExpanded] = useState('');
	const editSettings = (
		index: number,
		key: (typeof usageItems)[number] | 'eta',
		changes: Partial<UsageSettings>
	) => {
		const p = providers[index];
		edit(index, { settings: { ...p.settings, [key]: { ...p.settings[key], ...changes } } });
	};
	const [source, setSource] = useState<UsageSource>('openrouter');
	const [test, setTest] = useState<{
		key: string;
		text: string;
		busy: boolean;
		snapshot?: UsageSnapshot;
	} | null>(null);
	const edit = (index: number, changes: Partial<UsageProvider>) =>
		onChange(providers.map((p, i) => (i === index ? { ...p, ...changes } : p)));
	const move = (index: number, direction: number) => {
		const next = [...providers];
		[next[index], next[index + direction]] = [next[index + direction], next[index]];
		onChange(next);
	};
	const moveItem = (index: number, key: (typeof usageItems)[number], direction: number) => {
		const p = providers[index];
		const selected = p.order.filter((item) => p[item]);
		const position = selected.indexOf(key);
		const order = [...p.order];
		const from = order.indexOf(key);
		const to = order.indexOf(selected[position + direction]);
		[order[from], order[to]] = [order[to], order[from]];
		edit(index, { order });
	};
	const runTest = async (p: UsageProvider) => {
		const key = usageSourceKey(p);
		setTest({ key, text: '', busy: true });
		try {
			const result = await readAiUsage(p);
			if (p.command || p.source === 'command') approveUsageCommand(p);
			setTest({
				key,
				text: `Valid response · ${result.metrics.length} readings${p.command ? ' · command activated locally' : ''}`,
				busy: false,
				snapshot: result
			});
		} catch (err) {
			setTest({ key, text: String(err), busy: false });
		}
	};
	return (
		<div className="usage-providers-editor">
			{providers.map((p, i) => (
				<fieldset key={p.id}>
					<legend>{p.label || p.source}</legend>
					<div className="usage-editor-actions">
						<label>
							<input
								type="checkbox"
								checked={p.enabled}
								onChange={(e) => edit(i, { enabled: e.target.checked })}
							/>
							Enabled
						</label>
						<button
							type="button"
							aria-label={`Move ${p.label} up`}
							disabled={i === 0}
							onClick={() => move(i, -1)}
						>
							↑
						</button>
						<button
							type="button"
							aria-label={`Move ${p.label} down`}
							disabled={i === providers.length - 1}
							onClick={() => move(i, 1)}
						>
							↓
						</button>
						<button
							type="button"
							aria-label={`Remove ${p.label}`}
							onClick={() => onChange(providers.filter((_, index) => index !== i))}
						>
							Remove
						</button>
					</div>
					<details
						className="usage-connection"
						open={p.source === 'command' || p.source === 'openrouter' || p.source === 'omp'}
					>
						<summary>Connection &amp; identity</summary>
						<label>
							Label
							<input value={p.label} onChange={(e) => edit(i, { label: e.target.value })} />
						</label>
						<label>
							Icon
							<select
								aria-label="Icon"
								value={p.icon}
								onChange={(e) => edit(i, { icon: e.target.value as ProviderIconChoice })}
							>
								<option value="auto">Automatic</option>
								<option value="none">No icon</option>
								{Object.entries(providerIcons).map(([id, label]) => (
									<option key={id} value={id}>
										{label}
									</option>
								))}
							</select>
						</label>
						<label>
							Source
							<select
								value={p.source}
								onChange={(e) => edit(i, { source: e.target.value as UsageSource })}
							>
								{['codex', 'claude', 'openrouter', 'omp', 'command'].map((s) => (
									<option key={s}>{s}</option>
								))}
							</select>
						</label>
						<label>
							Layout
							<select
								value={p.compact}
								onChange={(e) => edit(i, { compact: e.target.value as UsageProvider['compact'] })}
							>
								{['inherit', 'compact', 'detailed'].map((s) => (
									<option key={s}>{s}</option>
								))}
							</select>
						</label>
						{p.source === 'openrouter' && (
							<label>
								API key environment variable
								<input value={p.env} onChange={(e) => edit(i, { env: e.target.value })} />
							</label>
						)}
						{p.source === 'omp' && (
							<label>
								OMP provider id (blank = all)
								<input value={p.account} onChange={(e) => edit(i, { account: e.target.value })} />
							</label>
						)}
						<label>
							PowerShell command override
							<textarea
								aria-label={`${p.label} usage command`}
								value={p.command}
								placeholder={
									p.source === 'command'
										? 'Print version 1 usage JSON to stdout'
										: 'Blank uses the built-in reader'
								}
								onChange={(e) => edit(i, { command: e.target.value })}
							/>
						</label>
						<small>
							Commands run only after Test / activate on this computer. Use environment variables
							for secrets.
						</small>{' '}
					</details>

					<ol className="usage-reading-order" aria-label={`${p.label} reading order`}>
						{p.order.map((key) => {
							const selected = p.order.filter((item) => p[item]);
							const position = selected.indexOf(key);
							return (
								<li key={key}>
									<label>
										<input
											type="checkbox"
											checked={p[key]}
											onChange={(e) => edit(i, { [key]: e.target.checked })}
										/>
										{
											{
												session: 'Session',
												week: 'Week',
												other: 'Other windows',
												tokens: 'Tokens',
												credits: 'Credits',
												banked: 'Banked resets',
												graph: 'Graph',
												eta: 'Rate / ETA',
												resets: 'Resets in'
											}[key]
										}
									</label>
									<input
										className="usage-item-label"
										aria-label={`${p.label} ${key} label override`}
										placeholder="Default label"
										value={p.labels[key] ?? ''}
										onChange={(e) => edit(i, { labels: { ...p.labels, [key]: e.target.value } })}
									/>
									<button
										type="button"
										aria-label={`Move ${p.label} ${key} earlier`}
										disabled={!p[key] || position === 0}
										onClick={() => moveItem(i, key, -1)}
									>
										↑
									</button>
									<button
										type="button"
										aria-label={`Move ${p.label} ${key} later`}
										disabled={!p[key] || position === selected.length - 1}
										onClick={() => moveItem(i, key, 1)}
									>
										↓
									</button>
									{key !== 'banked' ? (
										<button
											type="button"
											className="usage-options-button"
											aria-label={`Settings for ${p.label} ${key}`}
											aria-expanded={expanded === `${p.id}:${key}`}
											onClick={() =>
												setExpanded(expanded === `${p.id}:${key}` ? '' : `${p.id}:${key}`)
											}
										>
											⚙
										</button>
									) : (
										<span />
									)}
									{expanded === `${p.id}:${key}` && (
										<div
											className="usage-row-options"
											role="group"
											aria-label={`${p.label} ${key} settings`}
										>
											<UsageItemSettingsEditor
												item={key}
												value={resolveUsageSettings(p.settings[key], legacy)}
												onChange={(next) => editSettings(i, key, next)}
											/>
										</div>
									)}
								</li>
							);
						})}
					</ol>

					<button
						type="button"
						disabled={test?.busy || (p.source === 'command' && !p.command.trim())}
						onClick={() => {
							void runTest(p);
						}}
					>
						Test / activate
					</button>
					{test?.key === usageSourceKey(p) && (
						<output aria-live="polite">{test.busy ? 'Testing…' : test.text}</output>
					)}
					{test?.key === usageSourceKey(p) && test.snapshot && (
						<details>
							<summary>Parsed readings</summary>
							<pre>{JSON.stringify(test.snapshot, null, 2)}</pre>
						</details>
					)}
				</fieldset>
			))}
			<div className="usage-editor-actions">
				<select
					aria-label="New usage provider"
					value={source}
					onChange={(e) => setSource(e.target.value as UsageSource)}
				>
					{['codex', 'claude', 'openrouter', 'omp', 'command'].map((s) => (
						<option key={s}>{s}</option>
					))}
				</select>
				<button
					type="button"
					onClick={() =>
						onChange([
							...providers,
							...usageProviders([
								{
									id: crypto.randomUUID(),
									source,
									label: source === 'command' ? 'Custom provider' : source
								}
							])
						])
					}
				>
					Add provider
				</button>
			</div>
		</div>
	);
}
